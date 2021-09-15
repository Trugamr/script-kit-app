/* eslint-disable no-restricted-syntax */
/* eslint-disable no-continue */
/* eslint-disable import/first */
/* eslint-disable jest/no-identical-title */
/* eslint-disable jest/expect-expect */
/* eslint global-require: off, no-console: off */

/**
 * This module executes inside of electron's main process. You can start
 * electron renderer process from here and communicate with the other processes
 * through IPC.
 *
 * When running `yarn build` or `yarn build-main`, this file is compiled to
 * `./src/main.prod.js` using webpack. This gives us some performance wins.
 */

import {
  app,
  protocol,
  BrowserWindow,
  powerMonitor,
  session,
  Notification,
} from 'electron';

import tar from 'tar';
import queryString from 'query-string';
import clipboardy from 'clipboardy';

if (!app.requestSingleInstanceLock()) {
  app.exit();
}
import 'core-js/stable';
import 'regenerator-runtime/runtime';
import { autoUpdater } from 'electron-updater';
import log from 'electron-log';
import path from 'path';
import {
  spawnSync,
  exec,
  SpawnSyncOptions,
  SpawnSyncReturns,
  spawn,
} from 'child_process';
import { homedir } from 'os';
import { ensureDir } from 'fs-extra';
import { existsSync, readFileSync } from 'fs';
import { chmod, lstat, readdir, readFile, rm, rmdir } from 'fs/promises';
import { ProcessType } from '@johnlindquist/kit/cjs/enum';
import {
  kenvPath,
  kitPath,
  KIT_FIRST_PATH,
  tmpClipboardDir,
  tmpDownloadsDir,
} from '@johnlindquist/kit/cjs/util';
import { getPrefsDb, getShortcutsDb } from '@johnlindquist/kit/cjs/db';
import { createTray, destroyTray } from './tray';
import { cacheMenu, setupWatchers } from './watcher';
import { getAssetPath } from './assets';
import { tick } from './tick';
import { clearPromptCache, createPromptWindow } from './prompt';
import { APP_NAME, KIT_PROTOCOL } from './helpers';
import { getVersion } from './version';
import { show } from './show';
import { cacheKitScripts, getStoredVersion, storeVersion } from './state';
import { startSK } from './sk';
import { processes } from './process';
import { startIpc } from './ipc';
import { runPromptProcess } from './kit';
import { CONFIG_SPLASH, showError } from './main.dev.templates';

let configWindow: BrowserWindow;

app.setName(APP_NAME);

app.setAsDefaultProtocolClient(KIT_PROTOCOL);
app.dock.hide();
app.dock.setIcon(getAssetPath('icon.png'));

const releaseChannel = readFileSync(
  getAssetPath('release_channel.txt'),
  'utf-8'
);
const arch = readFileSync(getAssetPath('arch.txt'), 'utf-8').trim();
const platform = readFileSync(getAssetPath('platform.txt'), 'utf-8').trim();
const nodeVersion = readFileSync(getAssetPath('node.txt'), 'utf-8').trim();

log.info(`${releaseChannel} channel:`);

const KIT = kitPath();
const options: SpawnSyncOptions = {
  cwd: KIT,
  encoding: 'utf-8',
  env: {
    KIT,
    KENV: kenvPath(),
    PATH: KIT_FIRST_PATH,
  },
};

powerMonitor.on('resume', () => {
  autoUpdater.checkForUpdates();
});

if (process.env.NODE_ENV === 'production') {
  const sourceMapSupport = require('source-map-support');
  sourceMapSupport.install();
}

if (
  process.env.NODE_ENV === 'development' ||
  process.env.DEBUG_PROD === 'true'
) {
  require('electron-debug')({ showDevTools: false });
}

const callBeforeQuitAndInstall = () => {
  try {
    destroyTray();
    app.removeAllListeners('window-all-closed');
    const browserWindows = BrowserWindow.getAllWindows();
    browserWindows.forEach((browserWindow) => {
      browserWindow.removeAllListeners('close');
    });
  } catch (e) {
    console.log(e);
  }
};

// fmkadmapgofadopljbjfkapdkoienihi
const installExtensions = async () => {
  const reactDevToolsDir = path.join(
    homedir(),
    'Library/Application Support/Google/Chrome/Default/Extensions/fmkadmapgofadopljbjfkapdkoienihi/'
  );

  const [version] = await readdir(reactDevToolsDir);

  const reactDevToolsPath = path.resolve(reactDevToolsDir, version);

  await session.defaultSession.loadExtension(reactDevToolsPath, {
    allowFileAccess: true,
  });
};

autoUpdater.once('checking-for-update', () => {
  log.info('Checking for update...');

  autoUpdater.once('update-available', (info) => {
    const notification = new Notification({
      title: `Update found ${info.version}`,
      body: 'Kit.app automatically relaunching',
      silent: true,
    });

    notification.show();

    log.info('Update available.', info);
  });
  autoUpdater.once('update-not-available', (info) => {
    log.info('Update not available.', info);
  });
});

autoUpdater.on('download-progress', (progressObj) => {
  let logMessage = `Download speed: ${progressObj.bytesPerSecond}`;
  logMessage = `${logMessage} - Downloaded ${progressObj.percent}%`;
  logMessage = `${logMessage} (${progressObj.transferred}/${progressObj.total})`;
  log.info(logMessage);
});

let updateDownloaded = false;
autoUpdater.on('error', (message) => {
  console.error('There was a problem updating the application');
  console.error(message);
});

autoUpdater.on('update-downloaded', async (event) => {
  log.info(event);
  log.info('update downloaded');
  log.info('attempting quitAndInstall');
  updateDownloaded = true;
  try {
    await storeVersion(getVersion());
  } catch {
    log.warn(`Couldn't store previous version`);
  }
  callBeforeQuitAndInstall();
  autoUpdater.quitAndInstall();
  const allWindows = BrowserWindow.getAllWindows();
  allWindows.forEach((w) => {
    w?.destroy();
  });
  setTimeout(() => {
    log.info('quit and exit');
    app.quit();
    app.exit();
  }, 3000);

  spawn(`./script`, [`./cli/open-app.js`], {
    cwd: KIT,
    detached: true,
    env: {
      KIT,
      KENV: kenvPath(),
      PATH: KIT_FIRST_PATH,
    },
  });
});

app.on('window-all-closed', (e: Event) => {
  if (!updateDownloaded) e.preventDefault();
});

app.on('web-contents-created', (_, contents) => {
  contents.on('will-navigate', (event, navigationUrl) => {
    const parsedUrl = new URL(navigationUrl);

    if (parsedUrl.protocol.startsWith('http')) {
      event.preventDefault();
      exec(`open ${parsedUrl.href}`);
    }
  });
});

const prepareProtocols = async () => {
  const PROTOCOL_START = `${KIT_PROTOCOL}://`;

  app.on('open-url', async (e, url) => {
    log.info(`URL PROTOCOL`, url);
    e.preventDefault();
    const [name, params] = url.slice(PROTOCOL_START.length).split('?');
    const argObject = queryString.parse(params);

    const args = Object.entries(argObject)
      .map(([key, value]) => `--${key} ${value}`)
      .join(' ')
      .split(' ');

    runPromptProcess(kitPath('cli/new.js'), [name, ...args]);
  });

  protocol.registerFileProtocol(KIT_PROTOCOL, (request, callback) => {
    const url = request.url.substr(KIT_PROTOCOL.length + 2);
    const file = { path: url };

    log.info(`fileProtocol loading:`, file);

    callback(file);
  });
};

const createLogs = () => {
  log.transports.file.resolvePath = () => kitPath('logs', 'kit.log');
};

const configWindowDone = () => {
  if (configWindow?.isVisible()) {
    configWindow?.webContents.send('UPDATE', {
      header: `Script Kit ${getVersion()}`,
      spinner: false,
      message: `
  <div class="flex flex-col justify-center items-center px-8">
    <div><span class="font-bold"><kbd>cmd</kbd> <kbd>;</kbd></span> to launch main prompt (or click tray icon)</div>
    <div>Right-click tray icon for options</div>
  </div>
  `.trim(),
    });
    configWindow?.on('blur', () => {
      if (!configWindow?.webContents?.isDevToolsOpened()) {
        configWindow?.destroy();
      }
    });
  } else {
    configWindow?.destroy();
  }
};

const updateConfigWindow = (message: string) => {
  if (configWindow?.isVisible()) {
    configWindow?.webContents.send('UPDATE', { message });
  }
};

const setupLog = (message: string) => {
  updateConfigWindow(message);
  log.info(message);
};

const ensureKitDirs = async () => {
  await ensureDir(kitPath('logs'));
  await ensureDir(kitPath('db'));
  await ensureDir(tmpClipboardDir);
  await ensureDir(tmpDownloadsDir);
  await getPrefsDb();
  await getShortcutsDb();
};

const ensureKenvDirs = async () => {
  await ensureDir(kenvPath('kenvs'));
  await ensureDir(kenvPath('assets'));
};

const ready = async () => {
  try {
    if (process.env.NODE_ENV === 'development') {
      await installExtensions();
    }

    await ensureKitDirs();
    await ensureKenvDirs();
    createLogs();
    await prepareProtocols();
    setupLog(`Protocols Prepared`);
    await createTray();
    setupLog(`Tray created`);
    await setupWatchers();
    setupLog(`Shortcuts Assigned`);
    await createPromptWindow();
    setupLog(`Prompt window created`);

    await tick();
    setupLog(`Tick started`);

    setupLog(`Kit.app is ready...`);
    configWindowDone();

    startSK();
    await cacheKitScripts();
    await cacheMenu();

    startIpc();
    processes.add(ProcessType.Prompt);
    processes.add(ProcessType.Prompt);
    processes.add(ProcessType.Prompt);
  } catch (error) {
    log.warn(error);
  }
};

const handleSpawnReturns = async (
  message: string,
  result: SpawnSyncReturns<any>,
  required = true
) => {
  console.log(`stdout:`, result?.stdout?.toString());
  console.log(`stderr:`, result?.stderr?.toString());
  const { stdout, stderr, error } = result;

  if (stdout?.toString().length) {
    const out = stdout.toString();
    log.info(message, out);
    if (out.length < 200) updateConfigWindow(out);
  }

  if (error && required) {
    throw new Error(error.message);
  }

  if (stderr?.toString().length) {
    console.log({ stderr: stderr.toString() });
    // throw new Error(stderr.toString());
  }

  return result;
};

const kitExists = () => {
  setupLog(kitPath());
  const doesKitExist = existsSync(kitPath());

  setupLog(`kit${doesKitExist ? `` : ` not`} found`);

  return doesKitExist;
};
const kitIsGit = () => {
  const isGit = existsSync(kitPath('.kitignore'));
  setupLog(`kit is${isGit ? `` : ` not`} a .git repo`);
  return isGit;
};

const kitUserDataExists = () => {
  const userDataExists = existsSync(app.getPath('userData'));
  setupLog(`kit user data ${userDataExists ? `` : ` not`} found`);

  return userDataExists;
};

const isContributor = async () => {
  // eslint-disable-next-line no-return-await
  return kitExists() && kitIsGit();
};

const kenvExists = () => {
  const doesKenvExist = existsSync(kenvPath());
  setupLog(`kenv${doesKenvExist ? `` : ` not`} found`);

  return doesKenvExist;
};

const kenvsExists = () => {
  const doKenvsExists = existsSync(kenvPath('kenvs'));
  setupLog(`kenv/kenvs${doKenvsExists ? `` : ` not`} found`);

  return doKenvsExists;
};

const examplesExists = () => {
  const doExamplesExist = existsSync(kenvPath('kenvs', 'examples'));
  setupLog(`kenv/kenvs/examples${doExamplesExist ? `` : ` not`} found`);

  return doExamplesExist;
};

const kenvConfigured = () => {
  const isKenvConfigured = existsSync(kenvPath('.env'));
  setupLog(`kenv is${isKenvConfigured ? `` : ` not`} configured`);

  return isKenvConfigured;
};

const nodeExists = () => {
  const doesNodeExist = existsSync(kitPath('node', 'bin', 'node'));
  setupLog(`node${doesNodeExist ? `` : ` not`} found`);

  return doesNodeExist;
};

const nodeModulesExists = () => {
  const doesNodeModulesExist = existsSync(kitPath('node_modules'));
  setupLog(`node_modules${doesNodeModulesExist ? `` : ` not`} found`);

  return doesNodeModulesExist;
};

const verifyInstall = async () => {
  setupLog(`Verifying ~/.kit exists:`);
  const checkKit = kitExists();
  setupLog(`Verifying ~/.kenv exists:`);
  const checkKenv = kenvExists();

  const checkNode = nodeExists();
  setupLog(checkNode ? `node found` : `node missing`);

  const checkNodeModules = nodeModulesExists();
  setupLog(checkNodeModules ? `node_modules found` : `node_modules missing`);

  const isKenvConfigured = kenvConfigured();
  setupLog(isKenvConfigured ? `kenv .env found` : `kenv .env missinag`);

  if (
    checkKit &&
    checkKenv &&
    checkNode &&
    checkNodeModules &&
    isKenvConfigured
  ) {
    setupLog(`Install verified`);
    return true;
  }

  throw new Error(`Install not verified...`);
};

const ohNo = async (error: Error) => {
  log.warn(error.message);
  log.warn(error.stack);
  const mainLog = await readFile(
    path.join(homedir(), `Library/Logs/Kit/main.log`),
    {
      encoding: 'utf8',
    }
  );

  await clipboardy.write(
    `
${error.message}
${error.stack}
${mainLog}
  `.trim()
  );
  configWindow?.destroy();

  const showWindow = await show('install-error', showError(error, mainLog));

  showWindow?.on('close', () => {
    app.exit();
  });

  showWindow?.on('blur', () => {
    app.exit();
  });

  throw new Error(error.message);
};

const extractTar = async (tarFile: string, outDir: string) => {
  setupLog(`Extracting ${tarFile} to ${outDir}`);
  await ensureDir(outDir);

  await tar.x({
    file: tarFile,
    C: outDir,
    strip: 1,
  });
};

const versionMismatch = async () => {
  const currentVersion = getVersion();
  setupLog(`App version: ${currentVersion}`);

  const previousVersion = await getStoredVersion();
  setupLog(`Previous version: ${previousVersion}`);
  return currentVersion !== previousVersion;
};

const cleanKit = async () => {
  const pathToClean = kitPath();

  const keep = (file: string) =>
    file.startsWith('node') || file.startsWith('db');

  // eslint-disable-next-line no-restricted-syntax
  for await (const file of await readdir(pathToClean)) {
    if (keep(file)) continue;

    const filePath = path.join(pathToClean, file);
    const stat = await lstat(filePath);
    if (stat.isDirectory()) {
      await rmdir(filePath, { recursive: true });
    } else {
      await rm(filePath);
    }
  }
};

const cleanUserData = async () => {
  const pathToClean = app.getPath('userData');
  await rmdir(pathToClean, { recursive: true });
};

const KIT_NODE_TAR = process.env.KIT_NODE_TAR || getAssetPath('node.tar.gz');

const checkKit = async () => {
  setupLog(`\n\n---------------------------------`);
  setupLog(`Launching Script Kit  ${getVersion()}`);
  setupLog(`auto updater detected version: ${autoUpdater.currentVersion}`);
  autoUpdater.logger = log;
  autoUpdater.checkForUpdates();

  if (!kitExists() || (await versionMismatch())) {
    configWindow = await show(
      'splash-setup',
      CONFIG_SPLASH,
      { frame: false },
      false
    );

    if (await isContributor()) {
      setupLog(`Welcome fellow contributor! Thanks for all you do!!!`);
    } else {
      if ((await getStoredVersion()) === '0.0.0') {
        configWindow?.show();
      }

      if (kitExists()) {
        setupLog(`Cleaning previous .kit`);
        await cleanKit();
      }

      setupLog(`.kit doesn't exist or isn't on a contributor branch`);
      const kitTar = getAssetPath('kit.tar.gz');
      await extractTar(kitTar, kitPath());

      if (!nodeExists()) {
        setupLog(
          `Adding node ${nodeVersion} ${platform} ${arch} to ~/.kit/node ...`
        );

        await ensureDir(kitPath('node'));

        if (existsSync(KIT_NODE_TAR)) {
          log.info(`Found ${KIT_NODE_TAR}. Extracting...`);
          await tar.x({
            file: KIT_NODE_TAR,
            C: kitPath('node'),
            strip: 1,
          });
        } else {
          const installScript = `./build/install-node.sh`;
          await chmod(kitPath(installScript), 0o755);
          const nodeInstallResult = spawnSync(
            installScript,
            ` --prefix node --platform darwin`.split(' '),
            options
          );
          await handleSpawnReturns(`install-node.sh`, nodeInstallResult);
        }
      }

      setupLog(`updating ~/.kit packages...`);
      const npmResult = spawnSync(
        `npm`,
        [`i`, `--production`, `--no-progress`],
        options
      );
      await handleSpawnReturns(`npm`, npmResult);
    }

    await chmod(kitPath('script'), 0o755);
    const chmodResult = spawnSync(
      `./script`,
      [`./setup/chmod-helpers.js`],
      options
    );
    await handleSpawnReturns(`chmod helpers`, chmodResult);

    await clearPromptCache();
  }

  if (kenvsExists() && examplesExists()) {
    const updateExamplesResult = spawnSync(
      `./script`,
      [`./cli/kenv-pull.js`, kenvPath(`kenvs`, `examples`)],
      options
    );

    await handleSpawnReturns(`update-examples`, updateExamplesResult);
  }

  if (!kenvExists()) {
    // Step 4: Use kit wrapper to run setup.js script
    configWindow?.show();
    const kenvTar = getAssetPath('kenv.tar.gz');
    await extractTar(kenvTar, kenvPath());

    kenvExists();
    await ensureKenvDirs();

    const cloneExamplesResult = spawnSync(
      `./script`,
      [`./setup/clone-examples.js`],
      options
    );
    await handleSpawnReturns(`clone-examples`, cloneExamplesResult, false);
  }

  if (!kenvConfigured()) {
    setupLog(`Run .kenv setup script...`);
    await chmod(kitPath('script'), 0o755);

    const setupResult = spawnSync(`./script`, [`./setup/setup.js`], options);
    await handleSpawnReturns(`setup`, setupResult);

    kenvConfigured();
  }

  const createAllBins = spawnSync(
    `./script`,
    [`./cli/create-all-bins.js`],
    options
  );
  await handleSpawnReturns(`create-all-bins`, createAllBins);

  await verifyInstall();
  await storeVersion(getVersion());
  await ready();
};

app.whenReady().then(checkKit).catch(ohNo);
