import log from 'electron-log';
import { debounce } from 'lodash-es';

import { existsSync, readFileSync } from 'node:fs';
import { lstat, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { getScripts, getUserJson } from '@johnlindquist/kit/core/db';
import { Channel, Env } from '@johnlindquist/kit/core/enum';
import type { Script } from '@johnlindquist/kit/types';
import dotenv from 'dotenv';
import { globby } from 'globby';
import madge, { type MadgeModuleDependencyGraph } from 'madge';
import { snapshot } from 'valtio';
import { subscribeKey } from 'valtio/utils';

import {
  kenvPath,
  kitPath,
  parseScript,
  parseScriptletsFromPath,
  resolveToScriptPath,
} from '@johnlindquist/kit/core/utils';

import chokidar, { type FSWatcher } from 'chokidar';
import { shortcutScriptChanged, unlinkShortcuts } from './shortcuts';

import type { kenvEnv } from '@johnlindquist/kit/types/env';
import { backgroundScriptChanged, removeBackground } from './background';
import { cancelSchedule, scheduleScriptChanged } from './schedule';
import { debounceSetScriptTimestamp, kitState, sponsorCheck } from './state';
import { systemScriptChanged, unlinkEvents } from './system-events';
import { removeWatch, watchScriptChanged } from './watch';

import { AppChannel, Trigger } from '../shared/enums';
import { KitEvent, emitter } from '../shared/events';
import { sendToAllPrompts } from './channel';
import { type WatchEvent, startWatching } from './chokidar';
import { createEnv } from './env.utils';
import { isInDirectory } from './helpers';
import { runScript } from './kit';
import { getFileImports } from './npm';
import { processes, sendToAllActiveChildren, spawnShebang, updateTheme } from './process';
import { clearPromptCache, clearPromptCacheFor, setKitStateAtom } from './prompt';
import { prompts } from './prompts';
import { readKitCss, setCSSVariable } from './theme';
import { addSnippet, addTextSnippet, removeSnippet } from './tick';
import { cacheMainScripts } from './install';
import { loadKenvEnvironment } from './env-utils';
import { pathExists } from './cjs-exports';
import { createLogger } from '../shared/log-utils';
import { compareArrays } from '../shared/utils';

const { info, err, warn, verbose } = createLogger('watcher.ts');

const unlink = (filePath: string) => {
  unlinkShortcuts(filePath);
  cancelSchedule(filePath);
  unlinkEvents(filePath);
  removeWatch(filePath);
  removeBackground(filePath);
  removeSnippet(filePath);

  const binPath = path.resolve(
    path.dirname(path.dirname(filePath)),
    'bin',
    path.basename(filePath).replace(new RegExp(`\\${path.extname(filePath)}$`), ''),
  );

  if (existsSync(binPath)) {
    rm(binPath);
  }
};

const logEvents: { event: WatchEvent; filePath: string }[] = [];

const logAllEvents = () => {
  const adds: string[] = [];
  const changes: string[] = [];
  const removes: string[] = [];

  logEvents.forEach(({ event, filePath }) => {
    if (event === 'add') {
      adds.push(filePath);
    }
    if (event === 'change') {
      changes.push(filePath);
    }
    if (event === 'unlink') {
      removes.push(filePath);
    }
  });

  if (adds.length) {
    verbose('adds', adds);
  }
  if (changes.length) {
    verbose('changes', changes);
  }
  if (removes.length) {
    verbose('removes', removes);
  }

  adds.length = 0;
  changes.length = 0;
  removes.length = 0;

  logEvents.length = 0;
};

const debouncedLogAllEvents = debounce(logAllEvents, 1000);

let prevFilePath = '';
const logQueue = (event: WatchEvent, filePath: string) => {
  if (prevFilePath !== filePath) {
    logEvents.push({ event, filePath });
    debouncedLogAllEvents();
  }
  prevFilePath = filePath;
};

const unlinkBin = (filePath: string) => {
  const binPath = path.resolve(path.dirname(path.dirname(filePath)), 'bin', path.basename(filePath));

  // if binPath exists, remove it
  if (existsSync(binPath)) {
    unlink(binPath);
  }
};

const checkFileImports = debounce(async (script: Script) => {
  let imports: string[] = [];
  try {
    imports = await getFileImports(
      script.filePath,
      kenvPath('package.json'),
      script.kenv ? kenvPath('kenvs', script.kenv, 'package.json') : undefined,
    );
  } catch (error) {
    err(error);
    imports = [];
  }

  info({ imports });

  if (imports?.length && kitState.kenvEnv?.KIT_DISABLE_AUTO_INSTALL !== 'true') {
    info(`📦 ${script.filePath} missing imports`, imports);
    emitter.emit(KitEvent.RunPromptProcess, {
      scriptPath: kitPath('cli', 'npm.js'),
      args: imports,
      options: {
        force: true,
        trigger: Trigger.Info,
      },
    });
  }
}, 25);

let depWatcher: FSWatcher;
let depGraph: MadgeModuleDependencyGraph = {};
const getDepWatcher = () => {
  if (depWatcher) {
    return depWatcher;
  }

  depWatcher = chokidar.watch(kenvPath('package.json'), {
    ignoreInitial: kitState.ignoreInitial,
  });

  depWatcher.on('all', async (eventName, filePath) => {
    info(
      `🔍 ${filePath} triggered a ${eventName} event. It's a known dependency of one of more scripts. Doing a reverse lookup...`,
    );

    // globby requires forward slashes
    const relativeFilePath = path.relative(kenvPath(), filePath).replace(/\\/g, '/');
    const affectedScripts = findEntryScripts(depGraph, relativeFilePath);

    info(`🔍 ${filePath} is a dependency of these scripts:`, Array.from(affectedScripts));
    info('Clearing their respective caches...');

    for await (const relativeScriptPath of affectedScripts) {
      const cachePath = path.join(
        path.dirname(kenvPath(relativeScriptPath)),
        '.cache',
        path.basename(relativeScriptPath) + '.js',
      );
      if (await lstat(cachePath).catch(() => false)) {
        info(`🔥 Clearing cache for ${relativeScriptPath} at ${cachePath}`);
        await rm(cachePath);
      } else {
        info(`🤔 Cache for ${relativeScriptPath} at ${cachePath} does not exist`);
      }

      const fullPath = kenvPath(relativeScriptPath);
      info(`Sending ${fullPath} to all active children`, {
        event: Channel.SCRIPT_CHANGED,
        state: fullPath,
      });
      sendToAllActiveChildren({
        channel: Channel.SCRIPT_CHANGED,
        state: fullPath,
      });
    }
  });

  return depWatcher;
};

function findEntryScripts(
  graph: MadgeModuleDependencyGraph,
  relativeDepPath: string,
  checkedScripts: Set<string> = new Set(),
): Set<string> {
  const entries = new Set<string>();
  for (const [script, deps] of Object.entries(graph)) {
    if (deps.length === 0) {
    } else if (deps.includes(relativeDepPath) && !checkedScripts.has(script)) {
      info(`🔍 Found ${relativeDepPath} as a dependency of`, script);
      checkedScripts.add(script);
      // Recursively find other scripts that depend on this script
      const more = findEntryScripts(graph, script, checkedScripts);
      if (more.size === 0) {
        entries.add(script);
      } else {
        // Merge results from deeper calls
        more.forEach((entry) => entries.add(entry));
      }
    }
  }

  return entries;
}

const madgeAllScripts = debounce(async () => {
  const kenvs = await readdir(kenvPath('kenvs'), {
    withFileTypes: true,
  });

  // globby requires forward slashes
  const allScriptPaths = await globby([
    kenvPath('scripts', '*').replace(/\\/g, '/'),
    ...kenvs
      .filter((k) => k.isDirectory())
      .map((kenv) => kenvPath('kenvs', kenv.name, 'scripts', '*').replace(/\\/g, '/')),
  ]);

  info(`🔍 ${allScriptPaths.length} scripts found`);

  const fileMadge = await madge(allScriptPaths, {
    baseDir: kenvPath(),
    dependencyFilter: (source) => {
      const isInKenvPath = isInDirectory(source, kenvPath());
      const notInKitSDK = !source.includes('.kit');
      const notAURL = !source.includes('://');
      return isInKenvPath && notInKitSDK && notAURL;
    },
  });
  depGraph = fileMadge.obj();

  const depWatcher = getDepWatcher();
  const watched = depWatcher.getWatched();
  for (const [dir, files] of Object.entries(watched)) {
    for (const file of files) {
      const filePath = path.join(dir, file);
      verbose(`Unwatching ${filePath}`);
      depWatcher.unwatch(filePath);
    }
  }
  for (const scriptKey of Object.keys(depGraph)) {
    const deps = depGraph[scriptKey];

    for (const dep of deps) {
      const depKenvPath = kenvPath(dep);
      verbose(`Watching ${depKenvPath}`);
      depWatcher.add(depKenvPath);
    }

    if (deps.length > 0) {
      verbose(`${scriptKey} has ${deps.length} dependencies`, deps);
    }
  }
}, 100);

let firstBatch = true;
let firstBatchTimeout: NodeJS.Timeout;
export const onScriptsChanged = async (event: WatchEvent, script: Script, rebuilt = false) => {
  if (firstBatch) {
    if (firstBatchTimeout) {
      clearTimeout(firstBatchTimeout);
    }
    firstBatchTimeout = setTimeout(() => {
      firstBatch = false;
      info('Finished parsing scripts ✅');
    }, 1000);
  }

  madgeAllScripts();

  info(`👀 ${event} ${script.filePath}`);
  if (event === 'unlink') {
    unlink(script.filePath);
    unlinkBin(script.filePath);
    sendToAllActiveChildren({
      channel: Channel.SCRIPT_REMOVED,
      state: script.filePath,
    });
  }

  if (
    event === 'change' ||
    // event === 'ready' ||
    event === 'add'
  ) {
    logQueue(event, script.filePath);

    if (kitState.ready && !rebuilt && !firstBatch) {
      debounceSetScriptTimestamp({
        filePath: script.filePath,
        changeStamp: Date.now(),
        reason: `${event} ${script.filePath}`,
      });
      if (event === 'change') {
        checkFileImports(script);
        sendToAllActiveChildren({
          channel: Channel.SCRIPT_CHANGED,
          state: script.filePath,
        });
      }
    } else {
      verbose(
        `⌚️ ${script.filePath} changed, but main menu hasn't run yet. Skipping compiling TS and/or timestamping...`,
      );
    }

    shortcutScriptChanged(script);
    scheduleScriptChanged(script);
    systemScriptChanged(script);
    watchScriptChanged(script);
    backgroundScriptChanged(script);
    addSnippet(script);

    sendToAllActiveChildren({
      channel: Channel.SCRIPT_ADDED,
      state: script.filePath,
    });

    clearPromptCacheFor(script.filePath);
  }
};

let watchers = [] as FSWatcher[];

export const teardownWatchers = () => {
  if (watchers.length) {
    for (const watcher of watchers) {
      try {
        watcher.removeAllListeners();
        watcher.close();
      } catch (error) {
        err('Error closing watcher:', error);
      }
    }
    info(`Cleared ${watchers.length} watchers`);
    watchers.length = 0;
  }
};

export const checkUserDb = async (eventName: string) => {
  info(`checkUserDb ${eventName}`);

  let currentUser;

  try {
    info('🔍 Getting user.json');
    currentUser = await getUserJson();
  } catch (error) {
    info('🔍 Error getting user.json', error);
    currentUser = {};
  }

  kitState.user = currentUser;

  info('🔍 Running set-login', kitState.user.login || Env.REMOVE);
  await runScript(kitPath('config', 'set-login'), kitState.user.login || Env.REMOVE);

  if (kitState?.user?.login) {
    const isSponsor = await sponsorCheck('Login', false);
    kitState.isSponsor = isSponsor;
  } else {
    kitState.isSponsor = false;
  }

  const user = snapshot(kitState.user);
  info('Send user.json to prompt', {
    login: user?.login,
    name: user?.name,
  });

  // TODO: Reimplement this
  sendToAllPrompts(AppChannel.USER_CHANGED, user);
};

const triggerRunText = debounce(
  async (eventName: WatchEvent) => {
    const runPath = kitPath('run.txt');
    if (eventName === 'add' || eventName === 'change') {
      const runText = await readFile(runPath, 'utf8');
      const [filePath, ...args] = runText.trim().split(' ');
      info(`run.txt ${eventName}`, filePath, args);

      try {
        const { shebang } = await parseScript(filePath);

        if (shebang) {
          spawnShebang({
            shebang,
            filePath,
          });
        } else {
          emitter.emit(KitEvent.RunPromptProcess, {
            scriptPath: resolveToScriptPath(filePath, kenvPath()),
            args: args || [],
            options: {
              force: true,
              trigger: Trigger.RunTxt,
            },
          });
        }
      } catch (error) {
        err(error);
      }
    } else {
      info('run.txt removed');
    }
  },
  1000,
  {
    leading: true,
  },
);

const refreshScripts = debounce(
  async () => {
    info('🌈 Refreshing Scripts...');
    const scripts = await getScripts();
    for (const script of scripts) {
      onScriptsChanged('change', script, true);
    }
  },
  500,
  { leading: true },
);

export const parseEnvFile = debounce(async () => {
  const envData = loadKenvEnvironment();

  // const envData = dotenv.parse(readFileSync(filePath)) as kenvEnv;

  // const resetKeyboardAndClipboard = () => {
  //   if (envData?.KIT_CLIPBOARD) {
  //     kitState.kenvEnv.KIT_CLIPBOARD = envData?.KIT_CLIPBOARD;
  //   } else if (!envData?.KIT_CLIPBOARD) {
  //     delete kitState.kenvEnv.KIT_CLIPBOARD;
  //   }

  //   if (envData?.KIT_KEYBOARD) {
  //     kitState.kenvEnv.KIT_KEYBOARD = envData?.KIT_KEYBOARD;
  //   } else if (!envData?.KIT_KEYBOARD) {
  //     delete kitState.kenvEnv.KIT_KEYBOARD;
  //   }
  // };

  // info({
  //   KIT_THEME_LIGHT: envData?.KIT_THEME_LIGHT,
  //   KIT_THEME_DARK: envData?.KIT_THEME_DARK,
  // });

  if (envData?.KIT_THEME_LIGHT) {
    info('Setting light theme', envData?.KIT_THEME_LIGHT);
    kitState.kenvEnv.KIT_THEME_LIGHT = envData?.KIT_THEME_LIGHT;
  } else if (kitState.kenvEnv.KIT_THEME_LIGHT) {
    kitState.kenvEnv.KIT_THEME_LIGHT = undefined;
    info('Removing light theme');
  }

  if (envData?.KIT_THEME_DARK) {
    info('Setting dark theme', envData?.KIT_THEME_DARK);
    kitState.kenvEnv.KIT_THEME_DARK = envData?.KIT_THEME_DARK;
  } else if (kitState.kenvEnv.KIT_THEME_DARK) {
    kitState.kenvEnv.KIT_THEME_DARK = undefined;
    info('Removing dark theme');
  }

  updateTheme();

  if (envData?.KIT_TERM_FONT) {
    sendToAllPrompts(AppChannel.SET_TERM_FONT, envData?.KIT_TERM_FONT);
  }

  const defaultKitMono = 'JetBrains Mono';

  if (envData?.KIT_MONO_FONT) {
    setCSSVariable('--mono-font', envData?.KIT_MONO_FONT || defaultKitMono);
  } else if (kitState.kenvEnv.KIT_MONO_FONT) {
    kitState.kenvEnv.KIT_MONO_FONT = undefined;
    setCSSVariable('--mono-font', defaultKitMono);
  }

  const defaultKitSans = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol'`;
  if (envData?.KIT_SANS_FONT) {
    setCSSVariable('--sans-font', envData?.KIT_SANS_FONT || defaultKitSans);
  } else if (kitState.kenvEnv.KIT_SANS_FONT) {
    kitState.kenvEnv.KIT_SANS_FONT = undefined;
    setCSSVariable('--sans-font', defaultKitSans);
  }

  const defaultKitSerif = `'ui-serif', 'Georgia', 'Cambria', '"Times New Roman"', 'Times',
        'serif'`;
  if (envData?.KIT_SERIF_FONT) {
    setCSSVariable('--serif-font', envData?.KIT_SERIF_FONT || defaultKitSerif);
  } else if (kitState.kenvEnv.KIT_SERIF_FONT) {
    kitState.kenvEnv.KIT_SERIF_FONT = undefined;
    setCSSVariable('--serif-font', defaultKitSerif);
  }

  if (envData?.KIT_MIC) {
    info('Setting mic', envData?.KIT_MIC);
    sendToAllPrompts(AppChannel.SET_MIC_ID, envData?.KIT_MIC);
  }

  if (envData?.KIT_WEBCAM) {
    info('Setting webcam', envData?.KIT_WEBCAM);
    sendToAllPrompts(AppChannel.SET_WEBCAM_ID, envData?.KIT_WEBCAM);
  }

  if (envData?.KIT_TYPED_LIMIT) {
    kitState.typedLimit = Number.parseInt(envData?.KIT_TYPED_LIMIT, 10);
  }

  const trustedKenvs = (envData?.[kitState.trustedKenvsKey] || '')
    .split(',')
    .filter(Boolean)
    .map((kenv) => kenv.trim());

  info('👩‍⚖️ Trusted Kenvs', trustedKenvs);

  const trustedKenvsChanged = !compareArrays(trustedKenvs, kitState.trustedKenvs);

  kitState.trustedKenvs = trustedKenvs;

  if (trustedKenvsChanged) {
    await refreshScripts();
  }

  // TODO: Debug a single prompt? All of them?
  if (envData?.KIT_DEBUG_PROMPT) {
    prompts?.prevFocused?.debugPrompt();
  }

  if (envData?.KIT_NO_PREVIEW) {
    setKitStateAtom({
      noPreview: envData?.KIT_NO_PREVIEW === 'true',
    });
  } else if (kitState.kenvEnv.KIT_NO_PREVIEW) {
    setKitStateAtom({
      noPreview: false,
    });
  }

  if (envData?.KIT_WIDTH) {
    kitState.kenvEnv.KIT_WIDTH = envData?.KIT_WIDTH;
  } else if (kitState.kenvEnv.KIT_WIDTH) {
    kitState.kenvEnv.KIT_WIDTH = undefined;
  }

  // if (envData?.KIT_LOW_CPU) {
  //   kitState.kenvEnv.KIT_LOW_CPU = envData?.KIT_LOW_CPU;
  //   if (envData?.KIT_LOW_CPU === 'true') {
  //     info(`🔋 Low CPU Mode. KIT_LOW_CPU=true`);
  //     envData.KIT_SUSPEND_WATCHERS = 'true';
  //     kitState.kenvEnv.KIT_CLIPBOARD = 'false';
  //     kitState.kenvEnv.KIT_KEYBOARD = 'false';
  //   } else {
  //     info(`🔋 Normal CPU Mode. KIT_LOW_CPU=false`);
  //     envData.KIT_SUSPEND_WATCHERS = 'false';
  //     resetKeyboardAndClipboard();
  //   }
  //   startClipboardAndKeyboardWatchers();
  // } else if (kitState.kenvEnv.KIT_LOW_CPU) {
  //   delete kitState.kenvEnv.KIT_LOW_CPU;
  //   info(`🔋 Normal CPU Mode. KIT_LOW_CPU=empty string`);
  //   envData.KIT_SUSPEND_WATCHERS = 'false';
  //   resetKeyboardAndClipboard();
  //   startClipboardAndKeyboardWatchers();
  // }

  if (envData?.KIT_CACHE_PROMPT) {
    clearPromptCache();
  } else if (kitState.kenvEnv.KIT_CACHE_PROMPT) {
    kitState.kenvEnv.KIT_CACHE_PROMPT = undefined;
    clearPromptCache();
  }

  if (envData?.KIT_SUSPEND_WATCHERS) {
    const suspendWatchers = envData?.KIT_SUSPEND_WATCHERS === 'true';
    kitState.suspendWatchers = suspendWatchers;

    if (suspendWatchers) {
      info('⌚️ Suspending Watchers');
      teardownWatchers();
    } else {
      info('⌚️ Resuming Watchers');
      setupWatchers();
    }
  } else if (kitState.suspendWatchers) {
    kitState.suspendWatchers = false;
    info('⌚️ Resuming Watchers');
    setupWatchers();
  }

  kitState.kenvEnv = envData;
  if (prompts.idle?.pid) {
    processes.getByPid(prompts.idle?.pid).child?.send({
      pid: prompts.idle?.pid,
      channel: Channel.ENV_CHANGED,
      env: createEnv(),
    });
  }

  // if (envData?.KIT_SHELL) kitState.envShell = envData?.KIT_SHELL;
  // TODO: Would need to update the dark/light contrast
  // setCSSVariable('--color-text', envData?.KIT_COLOR_TEXT);
  // setCSSVariable('--color-background', envData?.KIT_COLOR_BACKGROUND);
  // setCSSVariable('--color-primary', envData?.KIT_COLOR_PRIMARY);
  // setCSSVariable('--color-secondary', envData?.KIT_COLOR_SECONDARY);
  // setCSSVariable('--opacity', envData?.KIT_OPACITY);
}, 100);

export const restartWatchers = debounce(
  async () => {
    info(`🔄 Restarting watchers ----------------------------------------------------------------------`);
    await teardownWatchers();
    await setupWatchers();
  },
  500,
  { leading: false },
);

export const setupWatchers = async () => {
  await teardownWatchers();
  if (kitState.ignoreInitial) {
    refreshScripts();
  }

  info('--- 👀 Watching Scripts ---');

  watchers = startWatching(async (eventName: WatchEvent, filePath: string) => {
    // if (!filePath.match(/\.(ts|js|json|txt|env)$/)) return;
    const { base, dir, name } = path.parse(filePath);

    info({
      base,
      dir,
      name,
    });

    if (base === 'user.json') {
      checkUserDb(eventName);
      return;
    }

    if (base === name && (name === 'scriptlets' || name === 'scripts' || name === 'snippets')) {
      info(`${base} changed. Restarting all watchers`);
      await restartWatchers();
      return;
    }

    if (base === 'run.txt') {
      info(`run.txt ${eventName}`);
      triggerRunText(eventName);
      return;
    }

    if (base === '.env' || base.startsWith('.env.')) {
      info(`🌎 .env: ${filePath} -> ${eventName}`);
      parseEnvFile();
      return;
    }

    if (base === 'kit.css') {
      readKitCss(eventName);
      return;
    }

    if (base === 'package.json') {
      info('package.json changed');

      return;
    }

    if (base === 'scripts.json') {
      info('scripts.json changed');
      try {
        for (const info of processes) {
          info?.child?.send({
            channel: Channel.SCRIPTS_CHANGED,
          });
        }
      } catch (error) {
        warn(error);
      }

      return;
    }

    if (dir.endsWith('lib') && eventName !== 'ready') {
      // for (const scriptPath of allScriptPaths) {
      //   performance.mark('madge-start');
      //   const fileMadge = await madge(scriptPath, {
      //     baseDir: kenvPath(),
      //     dependencyFilter: (source) => {
      //       return !source.includes('.kit');
      //     },
      //   });
      //   const obj = fileMadge.obj();
      // Remove kenvPath() from filePath

      // info(`🔍 ${filePath}`, obj, { filePathWithoutKenv });
      // performance.mark('madge-end');
      // const madgeDuration = performance.measure(
      //   'madge',
      //   'madge-start',
      //   'madge-end',
      // );
      // info(
      //   `🔍 ${filePath} analysis duration: ${madgeDuration.duration}ms`,
      // );
      //   }
      // }

      // Remove the kenvPath("scripts/.cache") files
      // const scriptsDir = kenvPath('scripts', '.cache');
      // info(
      //   `Detected changes in ${kenvPath('lib')}. Clearing ${scriptsDir}...`,
      // );
      // const files = await readdir(scriptsDir);
      // for (const file of files) {
      //   const filePath = path.join(scriptsDir, file);
      //   try {
      //     await rm(filePath);
      //     info(`Removed cached file: ${filePath}`);
      //   } catch (error) {
      //     warn(`Failed to remove cached file: ${filePath}`, error);
      //   }
      // }
      try {
        await checkFileImports({
          filePath,
          kenv: '',
        } as Script);
      } catch (error) {
        warn(error);
      }

      return;
    }

    if (dir.endsWith('snippets')) {
      if (eventName === 'add' || eventName === 'change') {
        info('Snippet added/changed', filePath);
        addTextSnippet(filePath);
      } else {
        removeSnippet(filePath);
      }

      return;
    }

    if (dir.endsWith('scriptlets')) {
      // onScriptsChanged(eventName, filePath);
      info('🎬 Starting cacheMainScripts...');
      try {
        await cacheMainScripts();
      } catch (error) {
        err(error);
      }
      info('...cacheMainScripts done 🎬');

      const exists = await pathExists(filePath);
      if (!exists) {
        info(`Scriptlet file ${filePath} has been deleted.`);
        return;
      }
      const scriptlets = await parseScriptletsFromPath(filePath);
      for (const scriptlet of scriptlets) {
        info(`👀 -->>> ${eventName} ${scriptlet.filePath}`);
        await onScriptsChanged(eventName, scriptlet);
      }
      return;
    }

    if (dir.endsWith('scripts')) {
      let script;
      try {
        script = await parseScript(filePath);
      } catch (error) {
        warn(error);
        script = {
          filePath,
          name: path.basename(filePath),
        };
      }
      onScriptsChanged(eventName, script);
      return;
    }

    warn(`🔄 ${eventName} ${filePath}, but not handled... Is this a bug?`);
  });
};

subscribeKey(kitState, 'suspendWatchers', (suspendWatchers) => {
  if (suspendWatchers) {
    info('⌚️ Suspending Watchers');
    teardownWatchers();
  } else {
    info('⌚️ Resuming Watchers');
    setupWatchers();
  }
});

emitter.on(KitEvent.TeardownWatchers, teardownWatchers);

emitter.on(KitEvent.RestartWatcher, async () => {
  try {
    await setupWatchers();
  } catch (error) {
    err(error);
  }
});

emitter.on(KitEvent.Sync, () => {
  checkUserDb('sync');
});
