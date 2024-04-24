/* eslint-disable no-restricted-syntax */
import log from 'electron-log';
import { debounce } from 'lodash-es';
import path from 'path';
import { existsSync, readFileSync } from 'fs';
import { snapshot } from 'valtio';
import { subscribeKey } from 'valtio/utils';
import dotenv from 'dotenv';
import { rm, readFile } from 'fs/promises';
import { getScripts, getUserJson } from '@johnlindquist/kit/core/db';
import { Script } from '@johnlindquist/kit/types';
import { Channel, Env } from '@johnlindquist/kit/core/enum';

import {
  parseScript,
  kitPath,
  kenvPath,
  resolveToScriptPath,
} from '@johnlindquist/kit/core/utils';

import { FSWatcher } from 'chokidar';
import { unlinkShortcuts, shortcutScriptChanged } from './shortcuts';

import { cancelSchedule, scheduleScriptChanged } from './schedule';
import { unlinkEvents, systemScriptChanged } from './system-events';
import { removeWatch, watchScriptChanged } from './watch';
import { backgroundScriptChanged, removeBackground } from './background';
import {
  debounceSetScriptTimestamp,
  kitState,
  sponsorCheck,
  workers,
} from '../shared/state';
import { kenvEnv } from '@johnlindquist/kit/types/env';
import { CREATE_BIN_WORKER } from '@johnlindquist/kit/workers';

import { addSnippet, addTextSnippet, removeSnippet } from './tick';
import {
  clearPromptCache,
  clearPromptCacheFor,
  setKitStateAtom,
} from './prompt';
import { startWatching, WatchEvent } from './chokidar';
import { emitter, KitEvent } from '../shared/events';
import { AppChannel, Trigger } from '../shared/enums';
import { runScript } from './kit';
import { processes, spawnShebang, updateTheme } from './process';
import { compareArrays } from './helpers';
import { getFileImports } from './npm';
import { sendToAllPrompts } from './channel';
import { readKitCss, setCSSVariable } from './theme';
import { prompts } from './prompts';
import { createEnv } from './env.utils';
import { Worker } from 'worker_threads';

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
    path
      .basename(filePath)
      .replace(new RegExp(`\\${path.extname(filePath)}$`), ''),
  );

  if (existsSync(binPath)) rm(binPath);
};

const logEvents: { event: WatchEvent; filePath: string }[] = [];

const logAllEvents = () => {
  const adds: string[] = [];
  const changes: string[] = [];
  const removes: string[] = [];

  logEvents.forEach(({ event, filePath }) => {
    if (event === 'add') adds.push(filePath);
    if (event === 'change') changes.push(filePath);
    if (event === 'unlink') removes.push(filePath);
  });

  if (adds.length) log.verbose('adds', adds);
  if (changes.length) log.verbose('changes', changes);
  if (removes.length) log.verbose('removes', removes);

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
  const binPath = path.resolve(
    path.dirname(path.dirname(filePath)),
    'bin',
    path.basename(filePath),
  );

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
    log.error(error);
    imports = [];
  }

  if (imports?.length) {
    log.info(`📦 ${script.filePath} missing imports`, imports);
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

let firstBatch = true;
let firstBatchTimeout: NodeJS.Timeout;
export const onScriptsChanged = async (
  event: WatchEvent,
  filePath: string,
  rebuilt = false,
) => {
  if (firstBatch) {
    if (firstBatchTimeout) clearTimeout(firstBatchTimeout);
    firstBatchTimeout = setTimeout(() => {
      firstBatch = false;
      log.info(`Finished parsing scripts ✅`);
    }, 1000);
  }

  log.verbose(`👀 ${event} ${filePath}`);
  if (event === 'unlink') {
    unlink(filePath);
    unlinkBin(filePath);
  }

  if (
    event === 'change' ||
    // event === 'ready' ||
    event === 'add'
  ) {
    logQueue(event, filePath);
    if (!existsSync(filePath)) {
      log.info(`🤔 Attempting to parse ${filePath}, but it doesn't exist...`);
      return;
    }
    const script = await parseScript(filePath);
    shortcutScriptChanged(script);
    scheduleScriptChanged(script);
    systemScriptChanged(script);
    watchScriptChanged(script);
    backgroundScriptChanged(script);
    addSnippet(script);

    if (kitState.ready && !rebuilt && !firstBatch) {
      debounceSetScriptTimestamp({
        filePath,
        changeStamp: Date.now(),
        reason: `${event} ${filePath}`,
      });
      if (event === 'change') {
        checkFileImports(script);
      }
    } else {
      log.verbose(
        `⌚️ ${filePath} changed, but main menu hasn't run yet. Skipping compiling TS and/or timestamping...`,
      );
    }

    clearPromptCacheFor(filePath);
  }

  if (event === 'add') {
    if (kitState.ready) {
      setTimeout(async () => {
        try {
          const binDirPath = path.resolve(
            path.dirname(path.dirname(filePath)),
            'bin',
          );
          const command = path.parse(filePath).name;
          const binFilePath = path.resolve(binDirPath, command);
          if (!existsSync(binFilePath)) {
            log.info(`🔗 Creating bin for ${command}`);
            // runScript(kitPath('cli', 'create-bin'), 'scripts', filePath);
            if (!workers.createBin) {
              workers.createBin = new Worker(CREATE_BIN_WORKER);
            }

            workers.createBin.removeAllListeners();

            workers.createBin.once('message', (message) => {
              log.info(`Bin created for ${command}`, message);
            });
            workers.createBin.once('error', (error) => {
              log.error(`Error creating bin for ${command}`, error);
            });

            log.info(`🔗 Post message for bin for ${command}`);
            workers.createBin.postMessage(filePath);
          } else {
            log.info(`🔗 Bin already exists for ${command}`);
          }
        } catch (error) {
          log.error(error);
        }
      }, 1000);
    }
  }
};

let watchers = [] as FSWatcher[];

export const teardownWatchers = async () => {
  if (watchers.length) {
    watchers.forEach((watcher) => {
      try {
        watcher.removeAllListeners();
        watcher.close();
      } catch (error) {
        log.error(error);
      }
    });
    watchers.length = 0;
  }
};

export const checkUserDb = async (eventName: string) => {
  log.info(`checkUserDb ${eventName}`);

  const currentUser = await getUserJson();

  kitState.user = currentUser;

  if (eventName === 'unlink') return;

  runScript(kitPath('config', 'set-login'), kitState.user.login || Env.REMOVE);

  if (kitState?.user?.login) {
    const isSponsor = await sponsorCheck('Login', false);
    kitState.isSponsor = isSponsor;
  } else {
    kitState.isSponsor = false;
  }

  const user = snapshot(kitState.user);
  log.info(`Send user.json to prompt`, user);

  // TODO: Reimplement this
  sendToAllPrompts(AppChannel.USER_CHANGED, user);
};

const triggerRunText = debounce(
  async (eventName: WatchEvent) => {
    const runPath = kitPath('run.txt');
    if (eventName === 'add' || eventName === 'change') {
      const runText = await readFile(runPath, 'utf8');
      const [filePath, ...args] = runText.trim().split(' ');
      log.info(`run.txt ${eventName}`, filePath, args);

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
        log.error(error);
      }
    } else {
      log.info(`run.txt removed`);
    }
  },
  1000,
  {
    leading: true,
  },
);

const refreshScripts = debounce(
  async () => {
    log.info(`🌈 Refreshing Scripts...`);
    const scripts = await getScripts();
    for (const script of scripts) {
      onScriptsChanged('change', script.filePath, true);
    }
  },
  500,
  { leading: true },
);

export const parseEnvFile = debounce(
  async (filePath: string, eventName: WatchEvent) => {
    log.info(`🌎 .env ${eventName}`);

    if (existsSync(filePath)) {
      try {
        const envData = dotenv.parse(readFileSync(filePath)) as kenvEnv;

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

        log.info({
          KIT_THEME_LIGHT: envData?.KIT_THEME_LIGHT,
          KIT_THEME_DARK: envData?.KIT_THEME_DARK,
        });

        if (envData?.KIT_TERM_FONT) {
          sendToAllPrompts(AppChannel.SET_TERM_FONT, envData?.KIT_TERM_FONT);
        }

        const defaultKitMono = `JetBrains Mono`;

        if (envData?.KIT_MONO_FONT) {
          setCSSVariable(
            '--mono-font',
            envData?.KIT_MONO_FONT || defaultKitMono,
          );
        } else if (kitState.kenvEnv.KIT_MONO_FONT) {
          delete kitState.kenvEnv.KIT_MONO_FONT;
          setCSSVariable('--mono-font', defaultKitMono);
        }

        const defaultKitSans = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol'`;
        if (envData?.KIT_SANS_FONT) {
          setCSSVariable(
            '--sans-font',
            envData?.KIT_SANS_FONT || defaultKitSans,
          );
        } else if (kitState.kenvEnv.KIT_SANS_FONT) {
          delete kitState.kenvEnv.KIT_SANS_FONT;
          setCSSVariable('--sans-font', defaultKitSans);
        }

        const defaultKitSerif = `'ui-serif', 'Georgia', 'Cambria', '"Times New Roman"', 'Times',
        'serif'`;
        if (envData?.KIT_SERIF_FONT) {
          setCSSVariable(
            '--serif-font',
            envData?.KIT_SERIF_FONT || defaultKitSerif,
          );
        } else if (kitState.kenvEnv.KIT_SERIF_FONT) {
          delete kitState.kenvEnv.KIT_SERIF_FONT;
          setCSSVariable('--serif-font', defaultKitSerif);
        }

        if (envData?.KIT_MIC) {
          log.info(`Setting mic`, envData?.KIT_MIC);
          sendToAllPrompts(AppChannel.SET_MIC_ID, envData?.KIT_MIC);
        }

        if (envData?.KIT_WEBCAM) {
          log.info(`Setting webcam`, envData?.KIT_WEBCAM);
          sendToAllPrompts(AppChannel.SET_WEBCAM_ID, envData?.KIT_WEBCAM);
        }

        if (envData?.KIT_TYPED_LIMIT) {
          kitState.typedLimit = parseInt(envData?.KIT_TYPED_LIMIT, 10);
        }

        const trustedKenvs = (envData?.[kitState.trustedKenvsKey] || '')
          .split(',')
          .filter(Boolean)
          .map((kenv) => kenv.trim());

        log.info(`👩‍⚖️ Trusted Kenvs`, trustedKenvs);

        const trustedKenvsChanged = !compareArrays(
          trustedKenvs,
          kitState.trustedKenvs,
        );

        kitState.trustedKenvs = trustedKenvs;

        if (trustedKenvsChanged) {
          await refreshScripts();
        }

        updateTheme();

        // TODO: Debug a single prompt? All of them?
        if (envData?.KIT_DEBUG_PROMPT) {
          prompts?.focused?.debugPrompt();
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
        //     log.info(`🔋 Low CPU Mode. KIT_LOW_CPU=true`);
        //     envData.KIT_SUSPEND_WATCHERS = 'true';
        //     kitState.kenvEnv.KIT_CLIPBOARD = 'false';
        //     kitState.kenvEnv.KIT_KEYBOARD = 'false';
        //   } else {
        //     log.info(`🔋 Normal CPU Mode. KIT_LOW_CPU=false`);
        //     envData.KIT_SUSPEND_WATCHERS = 'false';
        //     resetKeyboardAndClipboard();
        //   }
        //   startClipboardAndKeyboardWatchers();
        // } else if (kitState.kenvEnv.KIT_LOW_CPU) {
        //   delete kitState.kenvEnv.KIT_LOW_CPU;
        //   log.info(`🔋 Normal CPU Mode. KIT_LOW_CPU=empty string`);
        //   envData.KIT_SUSPEND_WATCHERS = 'false';
        //   resetKeyboardAndClipboard();
        //   startClipboardAndKeyboardWatchers();
        // }

        if (envData?.KIT_CACHE_PROMPT) {
          clearPromptCache();
        } else if (kitState.kenvEnv.KIT_CACHE_PROMPT) {
          delete kitState.kenvEnv.KIT_CACHE_PROMPT;
          clearPromptCache();
        }

        if (envData?.KIT_SUSPEND_WATCHERS) {
          const suspendWatchers = envData?.KIT_SUSPEND_WATCHERS === 'true';
          kitState.suspendWatchers = suspendWatchers;

          if (suspendWatchers) {
            log.info(`⌚️ Suspending Watchers`);
            teardownWatchers();
          } else {
            log.info(`⌚️ Resuming Watchers`);
            setupWatchers();
          }
        } else if (kitState.suspendWatchers) {
          kitState.suspendWatchers = false;
          log.info(`⌚️ Resuming Watchers`);
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

        // TODO: I don't think this is necessary any more
        // togglePromptEnv('KIT_MAIN_SCRIPT');
      } catch (error) {
        log.warn(error);
      }

      // if (envData?.KIT_SHELL) kitState.envShell = envData?.KIT_SHELL;
      // TODO: Would need to update the dark/light contrast
      // setCSSVariable('--color-text', envData?.KIT_COLOR_TEXT);
      // setCSSVariable('--color-background', envData?.KIT_COLOR_BACKGROUND);
      // setCSSVariable('--color-primary', envData?.KIT_COLOR_PRIMARY);
      // setCSSVariable('--color-secondary', envData?.KIT_COLOR_SECONDARY);
      // setCSSVariable('--opacity', envData?.KIT_OPACITY);
    }
  },
  1000,
  { leading: true },
);

export const setupWatchers = async () => {
  await teardownWatchers();
  if (kitState.ignoreInitial) {
    refreshScripts();
  }

  log.info('--- 👀 Watching Scripts ---');

  watchers = startWatching(async (eventName: WatchEvent, filePath: string) => {
    // if (!filePath.match(/\.(ts|js|json|txt|env)$/)) return;
    const { base, dir } = path.parse(filePath);

    if (base === 'run.txt') {
      log.info(`run.txt ${eventName}`);
      triggerRunText(eventName);
      return;
    }

    if (base === '.env') {
      parseEnvFile(filePath, eventName);
      return;
    }

    if (base === 'kit.css') {
      readKitCss(eventName);
      return;
    }

    if (base === 'package.json') {
      log.info(`package.json changed`);

      return;
    }

    if (base === 'scripts.json') {
      log.info(`scripts.json changed`);
      try {
        for (const info of processes) {
          info?.child?.send({
            channel: Channel.SCRIPTS_CHANGED,
          });
        }
      } catch (error) {
        log.warn(error);
      }

      return;
    }

    if (base === 'user.json') {
      checkUserDb(eventName);
      return;
    }

    if (dir.endsWith('lib') && eventName === 'change') {
      try {
        checkFileImports({
          filePath,
          kenv: '',
        } as Script);
      } catch (error) {
        log.warn(error);
      }

      return;
    }

    if (dir.endsWith('snippets')) {
      if (eventName === 'add' || eventName === 'change') {
        log.info(`Snippet added/changed`, filePath);
        addTextSnippet(filePath);
      } else {
        removeSnippet(filePath);
      }

      return;
    }

    onScriptsChanged(eventName, filePath);
  });
};

subscribeKey(kitState, 'suspendWatchers', async (suspendWatchers) => {
  if (suspendWatchers) {
    log.info(`⌚️ Suspending Watchers`);
    teardownWatchers();
  } else {
    log.info(`⌚️ Resuming Watchers`);
    setupWatchers();
  }
});

emitter.on(KitEvent.TeardownWatchers, teardownWatchers);

emitter.on(KitEvent.RestartWatcher, async () => {
  try {
    await setupWatchers();
  } catch (error) {
    log.error(error);
  }
});

emitter.on(KitEvent.Sync, async () => {
  checkUserDb('sync');
});
