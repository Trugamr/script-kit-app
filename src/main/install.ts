import { app, clipboard, nativeTheme, shell } from 'electron';
import { HttpsProxyAgent } from 'hpagent';

import {
  type ExecOptions,
  type ForkOptions,
  type SpawnOptions,
  type SpawnSyncReturns,
  exec,
  fork,
  spawn,
} from 'node:child_process';
import os, { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import dotenv from 'dotenv';
import download from 'download';
import { debounce } from 'lodash-es';
import StreamZip from 'node-stream-zip';
import * as tar from 'tar';
import { lstat, readFile, rm, unlink } from 'node:fs/promises';
import { Channel, PROMPT, UI } from '@johnlindquist/kit/core/enum';
import {
  KIT_FIRST_PATH,
  createPathResolver,
  getMainScriptPath,
  isDir,
  isFile,
  kenvPath,
  kitPath,
  knodePath,
  processPlatformSpecificTheme,
} from '@johnlindquist/kit/core/utils';
import type { FlagsObject, Script, Scriptlet, Shortcut } from '@johnlindquist/kit/types';
import { CACHED_GROUPED_SCRIPTS_WORKER, CREATE_BIN_WORKER, KIT_WORKER } from '@johnlindquist/kit/workers';

import { KitPrompt, destroyPromptWindow, makeSplashWindow } from './prompt';

import { Worker } from 'node:worker_threads';
import type { Stamp } from '@johnlindquist/kit/core/db';
import { SPLASH_PATH } from '../shared/defaults';
import { AppChannel } from '../shared/enums';
import { KitEvent, emitter } from '../shared/events';
import { sendToAllPrompts } from './channel';
import { createScoredChoice, isInDirectory } from './helpers';
import { mainLogPath } from './logs';
import { showError } from './main.dev.templates';
import { prompts } from './prompts';
import { INSTALL_ERROR, show } from './show';
import { getThemes, kitCache, kitState, preloadChoicesMap, workers } from './state';
import { ensureDir, writeFile, readJson, writeJson, pathExists, readdir } from './cjs-exports';

import electronLog from 'electron-log';
import { createLogger } from '../shared/log-utils';
const log = createLogger('install.ts');

let isOhNo = false;
export const ohNo = async (error: Error) => {
  if (isOhNo) {
    return;
  }
  isOhNo = true;
  log.warn(error.message);
  log.warn(error.stack);
  const mainLogContents = await readFile(mainLogPath, {
    encoding: 'utf8',
  });

  try {
    clipboard.writeText(
      `
  ${error.message}
  ${error.stack}
  ${mainLogContents}
    `.trim(),
    );
    destroyPromptWindow();
    await show(INSTALL_ERROR, showError(error, mainLogContents));
  } catch (copyError) {
    shell.openExternal(mainLogPath);
  }

  throw new Error(error.message);
};

let splashPrompt: KitPrompt | null = null;
export const showSplash = async () => {
  kitState.isSplashShowing = true;
  log.info('🌊 Showing splash install screen...');
  splashPrompt = new KitPrompt();
  splashPrompt.ui = UI.splash;
  splashPrompt.scriptPath = SPLASH_PATH;
  splashPrompt.initMain = false;
  splashPrompt.bindToProcess(99999);

  emitter.once(KitEvent.CloseSplash, () => {
    try {
      kitState.isSplashShowing = false;
      makeSplashWindow(splashPrompt?.window);
      splashPrompt?.window?.hide();
      splashPrompt?.window?.close();
      splashPrompt?.window?.destroy();
      splashPrompt = null;
    } catch (error) {
      log.error(error);
    }
  });

  splashPrompt.readyEmitter.once('ready', async () => {
    const { scriptKitTheme, scriptKitLightTheme } = getThemes();
    const value = nativeTheme.shouldUseDarkColors ? scriptKitTheme : scriptKitLightTheme;
    const platformSpecificTheme = processPlatformSpecificTheme(value);
    kitState.theme = platformSpecificTheme;
    kitState.themeName = platformSpecificTheme.match(/--name:\s*"([^"]+)"/)?.[1] || '';

    splashPrompt?.sendToPrompt(Channel.SET_THEME, platformSpecificTheme);

    splashPrompt?.setPromptData({
      show: true,
      ui: UI.splash,
      scriptPath: SPLASH_PATH,
      width: PROMPT.WIDTH.BASE,
      height: PROMPT.HEIGHT.BASE,
    } as any);

    await new Promise((resolve, reject) => {
      setTimeout(() => {
        resolve(true);
      }, 200);
    });

    splashPrompt?.window.show();
  });

  sendSplashHeader('Installing Kit SDK and Kit Environment...');
};
export const sendSplashBody = (message: string) => {
  if (message.includes('object')) {
    return;
  }
  if (message.toLowerCase().includes('warn')) {
    return;
  }
  message = message.trim();
  if (!message) {
    return;
  }

  log.info(`🌊 body: ${message}`);
  if (splashPrompt && !splashPrompt.window?.isDestroyed()) {
    splashPrompt.sendToPrompt(Channel.SET_SPLASH_BODY, message);
  }
};

export const sendSplashHeader = (message: string) => {
  message = message.trim();
  if (!message) {
    return;
  }

  log.info(`🌊 header: ${message}`);
  splashPrompt?.sendToPrompt(Channel.SET_SPLASH_HEADER, message);
};

export const sendSplashProgress = (progress: number) => {
  log.info(`🌊 progress: ${progress}`);
  splashPrompt?.sendToPrompt(Channel.SET_SPLASH_PROGRESS, progress);
};

export const setupDone = () => {
  sendSplashProgress(100);
  sendSplashHeader('Kit SDK Install verified ✅');
};

export const handleLogMessage = (message: string, result: SpawnSyncReturns<any>, required = true) => {
  log.info('stdout:', result?.stdout?.toString());
  log.info('stderr:', result?.stderr?.toString());
  const { stdout, stderr, error } = result;

  if (stdout?.toString().length) {
    const out = stdout.toString();
    log.info(message, out);
    sendSplashBody(out.slice(0, 200));
  }

  if (error && required) {
    throw new Error(error.message);
  }

  if (stderr?.toString().length) {
    sendSplashBody(stderr.toString());
    log.info({ stderr: stderr.toString() });
    // throw new Error(stderr.toString());
  }

  return result;
};

/**
 * This function installs a package using npm. The installCommand parameter specifies
 * the command to execute for the package installation and the cwd parameter sets
 * the current working directory for the process.
 *
 * @param installCommand The command to execute for the package installation.
 * @param cwd The current working directory for the process.
 * @returns A promise that resolves with a success message or rejects with an error message.
 */
export const installPackage = async (installCommand: string, cwd: string) => {
  // Determine the kit and kenv paths
  const KIT = kitPath();
  const KENV = kenvPath();

  const PATH = KIT_FIRST_PATH + path.delimiter + process?.env?.PATH;
  log.info(`Installing ${installCommand} in ${cwd} with PATH: ${PATH}`);
  // Set up the options for the spawn command
  const options: SpawnOptions = {
    cwd,
    env: {
      KIT,
      KENV,
      PATH,
    },
    stdio: 'pipe',
    shell: true, // Use shell on all platforms for consistency
  };

  const isWin = os.platform().startsWith('win');
  // .knode\bin\node .knode\bin\node_modules\npm\bin\npm-cli.js
  const nodePath = isWin ? knodePath('bin', 'node.exe') : knodePath('bin', 'node');
  const npmCliPath = isWin
    ? knodePath('bin', 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : knodePath('lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const command = `${npmCliPath} ${installCommand}`;

  // Install pnpm

  log.info(`${cwd}: 👷 ${nodePath} ${command}`);

  return new Promise<string>((resolve, reject) => {
    const child = spawn(nodePath, [command], options);

    // Display a loading message with a spinner
    let dots = 1;
    const installMessage = 'Installing Kit Packages';
    const id = setInterval(() => {
      if (dots >= 3) {
        dots = 0;
      }
      dots += 1;
      sendSplashBody(installMessage.padEnd(installMessage.length + dots, '.'));
    }, 250);

    // Function to clear the interval id
    const clearId = () => {
      try {
        if (id) {
          clearInterval(id);
        }
      } catch (error) {
        log.info('Failed to clear id');
      }
    };

    // Handling the different events for the child process
    if (child.stdout) {
      child.stdout.on('data', (data) => {});
    }

    if (child.stderr) {
      child.stderr.on('data', (data) => {
        sendSplashBody(data.toString());
      });
      clearId();
    }

    child.on('message', (data) => {
      sendSplashBody(data.toString());
    });

    child.on('exit', () => {
      resolve('npm install success');
      clearId();
    });

    child.on('error', (error) => {
      log.warn(`Error: ${error?.message}`);
      resolve(`Deps install error ${error}`);
      clearId();
    });
  });
};

const installDependencies = async (dependencyNames: string[], installCommand: string, cwd: string) => {
  const normalizedCwd = path.normalize(cwd);
  const isKenvPath = normalizedCwd === path.normalize(kenvPath());
  const isKitPath = normalizedCwd === path.normalize(kitPath());

  log.info(`Installing ${dependencyNames.join(', ')} in ${cwd}...`);

  if (!(isKenvPath || isKitPath)) {
    log.info(`Did not recognize cwd as valid target: ${cwd}`);
    return null;
  }

  if (isKenvPath && !(await kenvPackageJsonExists())) {
    log.info(`No package.json found in ${cwd}. Skipping installation of ${dependencyNames.join(', ')}`);
    return null;
  }

  const missingDependencies: string[] = [];
  for (const dependencyName of dependencyNames) {
    if (isKenvPath && !(await isDependencyInstalled(dependencyName, cwd))) {
      log.info(`${dependencyName} not installed in ${cwd}.`);
      missingDependencies.push(dependencyName);
    }
  }

  if (isKenvPath && missingDependencies.length === 0) {
    log.info(`All dependencies already installed in ${cwd}`);
    return null;
  }

  try {
    const result = await installPackage(installCommand, cwd);
    for (const dependencyName of missingDependencies) {
      await verifyInstallation(dependencyName, cwd);
    }
    return result;
  } catch (error) {
    log.error(error);
    return null;
  }
};

const isDependencyInstalled = async (dependencyName: string, cwd: string) => {
  try {
    const nodeModulesPath = path.join(cwd, 'node_modules', dependencyName);
    log.info(`Checking if ${nodeModulesPath} exists`);
    const exists = await pathExists(nodeModulesPath);
    log.info(`${nodeModulesPath} exists: ${exists}`);
    return exists;
  } catch (error) {
    return false;
  }
};

const verifyInstallation = async (dependencyName: string, cwd: string) => {
  try {
    return await pathExists(path.join(cwd, 'node_modules', dependencyName));
  } catch (error) {
    log.error(`${dependencyName} not installed in ${cwd}`);
    // We can't log the contents of node_modules here as we're not reading the directory
    // If you still want to log something, you could log the error message
    log.info(`Error accessing ${dependencyName}: ${(error as Error).message}`);
    return false;
  }
};

let loaderToolsInstalled = false;
export const installLoaderTools = async () => {
  if (loaderToolsInstalled) {
    log.info('Loader tools already installed, skipping...');
    return;
  }

  async function readPackageJson() {
    const packageJsonPath = kitPath('package.json');
    try {
      const data = await readFile(packageJsonPath, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      log.error(`Error reading package.json: ${error}`);
      return null;
    }
  }

  const packageJson = await readPackageJson();
  if (packageJson) {
    const esbuildVersion = packageJson.devDependencies?.esbuild || '0.21.4';
    const tsxVersion = packageJson.devDependencies?.tsx || '4.15.7';
    log.info(`Using esbuild version: ${esbuildVersion}`);
    log.info(`Using tsx version: ${tsxVersion}`);

    const npmResult = await installDependencies(
      ['esbuild', 'tsx'],
      `i -D esbuild@${esbuildVersion} tsx@${tsxVersion} --save-exact --prefer-dedupe --loglevel=verbose`,
      kitPath(),
    );
    loaderToolsInstalled = true;
    return npmResult;
  }

  return null;
};

let kenvDepsInstalled = false;
export const installKenvDeps = async () => {
  if (kenvDepsInstalled) {
    log.info('Kenv dependencies already installed, skipping...');
    return;
  }

  const result = await installDependencies(
    ['@johnlindquist/kit', '@typescript/lib-dom'],
    `i -D ${kitPath()} @typescript/lib-dom@npm:@johnlindquist/no-dom --prefer-dedupe --loglevel=verbose`,
    kenvPath(),
  );
  if (result) {
    kenvDepsInstalled = true;
    log.info('Installed @johnlindquist/kit');
  } else {
    log.info('Failed to install @johnlindquist/kit');
  }
};

const getOptions = () => {
  const options: any = {
    insecure: true,
    rejectUnauthorized: false,
    followRedirect: true,
  };
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (proxy) {
    log.info(`Using proxy ${proxy}`);
    options.agent = new HttpsProxyAgent({
      keepAlive: true,
      keepAliveMsecs: 1000,
      maxSockets: 256,
      maxFreeSockets: 256,
      scheduling: 'lifo',
      proxy,
    });
  }

  return options;
};

export const extractKenv = async (file: string) => {
  // eslint-disable-next-line
  const zip = new StreamZip.async({ file });

  const fileName = path.parse(file).base;

  sendSplashBody(`Extacting ${fileName} to ${kenvPath()}`);

  await ensureDir(kenvPath());
  await zip.extract('kenv', kenvPath());
  await zip.close();
};

export const downloadKenv = async () => {
  if (await isDir(kenvPath())) {
    sendSplashBody(`${kenvPath()} already exists. Skipping download.`);
    return '';
  }
  const osTmpPath = createPathResolver(os.tmpdir());

  const fileName = 'kenv.zip';
  const file = osTmpPath(fileName);
  let url = `https://github.com/johnlindquist/kenv/releases/latest/download/${fileName}`;

  // Check if ~/.kitrc exists, if so, read it and use the KENV_ZIP_URL
  const kitrcPath = path.resolve(homedir(), '.kitrc');
  let stat;
  try {
    stat = await lstat(kitrcPath);
  } catch (error) {
    log.info('No ~/.kitrc found');
  }

  if (stat?.isFile()) {
    const kitRcContents = await readFile(kitrcPath, {
      encoding: 'utf8',
    });

    const kitRc = dotenv.parse(kitRcContents);
    if (kitRc.KENV_ZIP_URL) {
      log.info(`Using KENV_ZIP_URL from ${kitrcPath}`);
      url = kitRc.KENV_ZIP_URL;
    }
  }

  sendSplashBody(`Downloading Kit Environment from ${url}....`);
  try {
    const buffer = await download(url, undefined, getOptions());

    sendSplashBody(`Writing Kit Environment to ${file}`);
    await writeFile(file, buffer);

    return file;
  } catch (error) {
    log.error(error);
    ohNo(error as Error);
    return '';
  }
};

export const cleanKit = async () => {
  log.info(`🧹 Cleaning ${kitPath()}`);
  // Remove the entire kit directory
  try {
    await rm(kitPath(), {
      recursive: true,
      force: true,
    });
  } catch (error) {
    log.error(error);
  }

  // const pathToClean = kitPath();

  // const keep = (file: string) =>
  //   file === 'db' || file === 'node_modules' || file === 'assets';

  // // eslint-disable-next-line no-restricted-syntax
  // for await (const file of await readdir(pathToClean)) {
  //   if (keep(file)) {
  //     log.info(`👍 Keeping ${file}`);
  //     // eslint-disable-next-line no-continue
  //     continue;
  //   }

  //   const filePath = path.resolve(pathToClean, file);
  //   const stat = await lstat(filePath);
  //   if (stat.isDirectory()) {
  //     await rm(filePath, { recursive: true, force: true });
  //     log.info(`🧹 Cleaning dir ${filePath}`);
  //   } else {
  //     await rm(filePath);
  //     log.info(`🧹 Cleaning file ${filePath}`);
  //   }
  // }
};

export const extractKitTar = async (file: string) => {
  sendSplashBody(`Extracting Kit SDK from ${file} to ${kitPath()}...`);
  await ensureDir(kitPath());
  await tar.x({
    file,
    C: kitPath(),
    strip: 1,
  });
};

export const downloadKit = async () => {
  const osTmpPath = createPathResolver(os.tmpdir());

  const version = process.env.KIT_APP_VERSION;
  const extension = 'tar.gz';

  /* eslint-disable no-nested-ternary */
  const uppercaseOSName = process.platform === 'win32' ? 'Windows' : process.platform === 'linux' ? 'Linux' : 'macOS';

  // Download Kit SDK based on the current platform and architecture
  // Examples:
  // Mac arm64: https://github.com/johnlindquist/kitapp/releases/download/v1.40.70/Kit-SDK-macOS-1.40.70-arm64.tar.gz
  // Linux x64: https://github.com/johnlindquist/kitapp/releases/download/v1.40.70/Kit-SDK-Linux-1.40.70-x64.tar.gz
  // Windows x64: https://github.com/johnlindquist/kitapp/releases/download/v1.40.70/Kit-SDK-macOS-1.40.70-x64.tar.gz

  const kitSDK = `Kit-SDK-${uppercaseOSName}-${version}-${process.arch}.${extension}`;
  const file = osTmpPath(kitSDK);
  let url = `https://github.com/johnlindquist/kitapp/releases/download/v${version}/${kitSDK}`;
  if (process.env?.KIT_SDK_URL) {
    url = process.env.KIT_SDK_URL;
  }

  sendSplashBody(`Downloading Kit SDK from ${url}`);

  try {
    const buffer = await download(url, undefined, getOptions());

    sendSplashBody(`Writing Kit SDK to ${file}`);
    await writeFile(file, buffer);

    sendSplashBody(`Ensuring ${kitPath()} exists`);
    await ensureDir(kitPath());

    sendSplashBody(`Removing ${file}`);

    return file;
  } catch (error) {
    log.error(error);
    ohNo(error as Error);
    return '';
  }
};

export const downloadNode = async () => {
  // cleanup any existing knode directory
  if (await isDir(knodePath())) {
    await rm(knodePath(), {
      recursive: true,
      force: true,
    });
  }

  const osTmpPath = createPathResolver(os.tmpdir());

  const isWin = process.platform === 'win32';
  const extension = isWin ? 'zip' : 'tar.gz';

  // download node v18.18.2 based on the current platform and architecture
  // Examples:
  // Mac arm64: https://nodejs.org/dist/v18.18.2/node-v18.18.2-darwin-arm64.tar.gz
  // Linux x64: https://nodejs.org/dist/v18.18.2/node-v18.18.2-linux-x64.tar.gz
  // Windows x64: https://nodejs.org/dist/v18.18.2/node-v18.18.2-win-x64.zip

  // Node dist url uses "win", not "win32"
  const nodeVersion = `v${process.versions.node}`;
  const nodePlatform = isWin ? 'win' : process.platform;
  const nodeArch = isWin ? 'x64' : process.arch;
  const node = `node-${nodeVersion}-${nodePlatform}-${nodeArch}.${extension}`;
  const file = process.platform === 'linux' ? app.getPath('temp') : osTmpPath(node);
  const url = `https://nodejs.org/dist/${nodeVersion}/${node}`;

  const downloadingMessage = `Downloading node from ${url}`;
  log.info(downloadingMessage);
  sendSplashBody(downloadingMessage);

  try {
    const buffer = await download(url, undefined, getOptions());

    const writingNodeMessage = `Writing node to ${file}`;
    log.info(writingNodeMessage);
    sendSplashBody(writingNodeMessage);
    await writeFile(file, buffer);

    sendSplashBody(`Ensuring ${knodePath()} exists`);
    await ensureDir(knodePath());
    sendSplashBody(`Extracting node to ${knodePath()}`);

    return file;
  } catch (error) {
    log.error(error);
    ohNo(error as Error);

    return '';
  }
};

export const extractNode = async (file: string) => {
  log.info(`extractNode ${file}`);
  if (file.endsWith('.zip')) {
    try {
      // eslint-disable-next-line
      const zip = new StreamZip.async({ file });

      sendSplashBody(`Unzipping ${file} to ${knodePath()}`);
      // node-18.18.2-win-x64
      const fileName = path.parse(file).name;
      log.info(`Extacting ${fileName} to ${knodePath('bin')}`);
      // node-18.18.2-win-x64
      await zip.extract(fileName, knodePath('bin'));
      await zip.close();
    } catch (error) {
      log.error({ error });
      ohNo(error);
    }
  } else {
    sendSplashBody(`Untarring ${file} to ${knodePath()}`);
    try {
      await ensureDir(knodePath());
      await tar.x({
        file,
        C: knodePath(),
        strip: 1,
      });
    } catch (error) {
      log.error({ error });
      ohNo(error);
    }
  }
};

export const createLogs = () => {
  electronLog.transports.file.resolvePathFn = () => kitPath('logs', 'kit.log');
};

export const setupLog = async (message: string) => {
  sendSplashBody(message);
  log.info(message);
  if (process.env.KIT_SPLASH) {
    await new Promise((resolve, reject) =>
      setTimeout(() => {
        resolve(true);
      }, 500),
    );
  }
};

export const forkOptions: ForkOptions = {
  cwd: homedir(),
  windowsHide: true,
  env: {
    KIT: kitPath(),
    KENV: kenvPath(),
    KNODE: knodePath(),
    PATH: KIT_FIRST_PATH + path.delimiter + process?.env?.PATH,
    USER: process?.env?.USER,
    USERNAME: process?.env?.USERNAME,
    HOME: process?.env?.HOME,
  },
  stdio: 'pipe',
};

export const optionalSpawnSetup = (...args: string[]) => {
  if (process.env.MAIN_SKIP_SETUP) {
    log.info(`⏭️ Skipping setup script: ${args.join(' ')}`);
    return Promise.resolve('done');
  }
  return new Promise((resolve, reject) => {
    log.info(`Running optional setup script: ${args.join(' ')}`);
    const child = spawn(knodePath('bin', 'node'), [kitPath('run', 'terminal.js'), ...args], forkOptions);

    const id = setTimeout(() => {
      if (child && !child.killed) {
        child.kill();
        resolve('timeout');
        log.info(`⚠️ Setup script timed out: ${args.join(' ')}`);
      }
    }, 5000);

    if (child?.stdout) {
      child.stdout.on('data', (data) => {
        if (kitState.ready) {
          return;
        }
        log.info(data.toString());
      });
    }

    if (child?.stderr) {
      if (kitState.ready) {
        return;
      }
      child.stderr.on('data', (data) => {
        log.warn(data.toString());
      });
    }

    child.on('message', (data) => {
      const dataString = typeof data === 'string' ? data : data.toString();

      if (!dataString.includes('[object')) {
        log.info(args[0], dataString);
        // sendSplashBody(dataString.slice(0, 200));
      }
    });

    child.on('exit', (code) => {
      if (code === 0) {
        if (id) {
          clearTimeout(id);
        }
        log.info(`✅ Setup script completed: ${args.join(' ')}`);
        resolve('done');
      } else {
        log.info(`⚠️ Setup script exited with code ${code}: ${args.join(' ')}`);
        resolve('error');
      }
    });

    child.on('error', (error: Error) => {
      if (id) {
        clearTimeout(id);
      }
      log.error(`⚠️ Errored on setup script: ${args.join(' ')}`, error.message);
      resolve('error');
      // reject(error);
      // throw new Error(error.message);
    });
  });
};

export const optionalSetupScript = (scriptPath: string, argsParam?: string[], callback?: (object: any) => void) => {
  if (process.env.MAIN_SKIP_SETUP) {
    log.info(`⏭️ Skipping setup script: ${scriptPath}`);
    return Promise.resolve('done');
  }

  const args = argsParam || [];
  return new Promise((resolve, reject) => {
    log.info(`Running optional setup script: ${scriptPath} with ${args}`);
    const child = fork(kitPath('run', 'terminal.js'), [scriptPath, ...args], forkOptions);

    const id = setTimeout(() => {
      if (child && !child.killed) {
        child.kill();
        resolve('timeout');
        log.info(`⚠️ Setup script timed out: ${scriptPath}`);
      }
    }, 5000);

    if (child?.stdout) {
      child.stdout.on('data', (data) => {
        if (kitState.ready) {
          return;
        }
        setupLog(data.toString());
      });
    }

    if (child?.stderr) {
      if (kitState.ready) {
        return;
      }
      child.stderr.on('data', (data) => {
        setupLog(data.toString());
      });
    }

    child.on('message', (data) => {
      if (callback) {
        log.info(`📞 ${scriptPath}: callback firing...`);
        callback(data);
      }
    });

    child.on('exit', (code) => {
      if (code === 0) {
        if (id) {
          clearTimeout(id);
        }
        log.info(`✅ Setup script completed: ${scriptPath}`);
        resolve('done');
      } else {
        log.info(`⚠️ Setup script exited with code ${code}: ${scriptPath}`);
        resolve('error');
      }
    });

    child.on('error', (error: Error) => {
      if (id) {
        clearTimeout(id);
      }
      log.error(`⚠️ Errored on setup script: ${scriptPath.join(' ')}`, error.message);
      resolve('error');
      // reject(error);
      // throw new Error(error.message);
    });
  });
};

export const kenvPackageJsonExists = async () => {
  return await isFile(kenvPath('package.json'));
};

const cacheTriggers = (choices: Choice[]) => {
  for (const choice of choices) {
    const code = (choice?.shortcode || '').toLowerCase();

    if (code) {
      kitCache.shortcodes.set(code, choice);
    }

    if (choice?.keyword) {
      // log.info(`🗝 Found keyword ${choice.keyword}`);
      kitCache.keywords.set(choice.keyword.toLowerCase(), choice);
    }

    // TODO: Parse choice.trigger earlier during choice formatting?
    const trigger = (choice?.trigger || choice?.name?.match(/(?<=\[)\w+(?=\])/i)?.[0] || '').toLowerCase();

    if (trigger) {
      kitCache.triggers.set(trigger, choice);
    }

    const postfix =
      typeof choice?.pass === 'string' && choice?.pass !== 'true' && choice?.pass !== 'false' ? choice.pass : '';

    if (postfix) {
      // log.info(`🔚 Found postfix ${choice.pass}`);
      kitCache.postfixes.set(choice?.pass.trim(), choice);
    }
  }
};

const scoreAndCacheMainChoices = (scripts: Script[]) => {
  // TODO: Reimplement score and cache?
  const results = scripts
    .filter((c) => {
      if (c?.miss || c?.pass || c?.hideWithoutInput || c?.exclude) {
        return false;
      }
      return true;
    })
    .map(createScoredChoice);

  kitCache.scripts = scripts;
  kitCache.choices = results;
  cacheTriggers(results);

  for (const prompt of prompts) {
    log.info(`${prompt.pid}: initMainChoices`);
    // if (!prompt.isVisible()) {
    prompt.initMainChoices();
    if (!prompt.isVisible()) {
      // log.info(`${prompt.pid}: setShortcodes`, {
      //   triggers: scripts.filter((s) => s.trigger).map((s) => s.trigger),
      // });
    }
    // }
  }
};

const cacheMainPreview = (preview: string) => {
  kitCache.preview = preview;

  for (const prompt of prompts) {
    if (prompt.pid === 0) {
      prompt.initMainPreview();
    }
  }
};

const getBinWorker = () => {
  if (!workers.createBin) {
    workers.createBin = new Worker(CREATE_BIN_WORKER);
    const logQueue: { type: 'info' | 'error'; message: string }[] = [];
    let logTimeout: NodeJS.Timeout | null = null;

    const flushLogs = () => {
      if (logQueue.length > 0) {
        const infos = logQueue.filter((l) => l.type === 'info').map((l) => l.message);
        const errors = logQueue.filter((l) => l.type === 'error').map((l) => l.message);

        if (infos.length > 0) {
          log.info('🔗 Bin worker summary:', infos.join(', '));
        }
        if (errors.length > 0) {
          log.error('🔗 Bin worker errors:', errors.join(', '));
        }

        logQueue.length = 0;
      }
    };

    const queueLog = (type: 'info' | 'error', message: string) => {
      logQueue.push({ type, message });
      if (logTimeout) {
        clearTimeout(logTimeout);
      }
      logTimeout = setTimeout(flushLogs, 1000);
    };

    workers.createBin.on('exit', (exitCode) => {
      queueLog('info', `Bin worker exited (${exitCode})`);
    });
    workers.createBin.on('error', (error) => {
      queueLog('error', error.toString());
    });
    workers.createBin.on('message', (message: { command: string; filePath: string }) => {
      queueLog('info', `Created bin for ${path.basename(message?.filePath)} to ${message?.command}`);
    });
  }
  return workers.createBin;
};

export const syncBins = async () => {
  setTimeout(async () => {
    log.info('🔗 Syncing bins...');
    try {
      const binDirPath = kenvPath('bin');
      const binFiles = await readdir(binDirPath);
      const worker = getBinWorker();
      await Promise.all(
        binFiles.map(async (bin) => {
          const script = Array.from(kitState.scripts.values()).find((s) => s.command === bin);
          if (!script) {
            log.info(`🔗 Deleting bin ${bin}`);
            await unlink(path.resolve(binDirPath, bin));
          }
        }),
      );

      for (const script of kitState.scripts.values()) {
        if (binFiles.includes(script.command) && !(script as Scriptlet).scriptlet) {
          continue;
        }

        log.info(`🔗 Creating bin for ${script.filePath} -> ${script.command}`);
        worker.postMessage({
          command: script.command,
          filePath: script.filePath,
        });
      }
    } catch (error) {
      log.error(error);
    }
  }, 750);
};

export const cacheMainMenu = ({
  scripts,
  kenvScripts,
  preview,
  shortcuts,
  scriptFlags,
}: {
  scripts: Script[];
  kenvScripts?: Script[];
  preview?: string;
  shortcuts?: Shortcut[];
  scriptFlags?: FlagsObject;
}) => {
  log.info('Received scripts', {
    scripts: scripts?.length,
    kenvScripts: kenvScripts?.length,
    preview: preview?.length,
  });
  if (Array.isArray(scripts) && scripts.length > 0) {
    log.info('Caching scripts and preview...', {
      scripts: scripts?.length,
      kenvScripts: kenvScripts?.length,
      preview: preview?.length,
    });
    preloadChoicesMap.set(getMainScriptPath(), scripts);

    if (preview) {
      cacheMainPreview(preview);
    }
    if (scripts) {
      scoreAndCacheMainChoices(scripts);
    }
    if (shortcuts) {
      kitCache.shortcuts = shortcuts;
    }
    if (scriptFlags) {
      kitCache.scriptFlags = scriptFlags;
    }
    sendToAllPrompts(AppChannel.SET_CACHED_MAIN_PREVIEW, kitCache.preview);
    sendToAllPrompts(AppChannel.INIT_PROMPT, {});

    kitState.scriptlets.clear();
    kitState.scripts.clear();

    const isBinnableScript = (s: Script) =>
      s?.group !== 'Kit' && s?.kenv !== '.kit' && !s?.skip && s?.command && s.filePath;

    const logQueue: string[] = [];
    let logTimeout;

    const flushLogQueue = () => {
      if (logQueue.length > 0) {
        log.info(`📦 Added ${logQueue.length} items:`, logQueue);
        logQueue.length = 0;
      }
    };

    const queueLog = (message: string) => {
      logQueue.push(message);
      clearTimeout(logTimeout);
      logTimeout = setTimeout(flushLogQueue, 1000);
    };

    for (const script of scripts) {
      if ((script as Scriptlet).scriptlet) {
        queueLog(`Scriptlet ${script.filePath}`);
        kitState.scriptlets.set(script.filePath, script as Scriptlet);
      }

      if (isBinnableScript(script)) {
        queueLog(`Binnable ${script.filePath}`);
        kitState.scripts.set(script.filePath, script);
      }
    }

    // Ensure any remaining logs are flushed
    flushLogQueue();

    syncBins();
  }
};

let postMessage: (message: any) => void;
let currentResolve: (value: any) => void;
let currentReject: (reason?: any) => void;
export const cacheMainScripts = (
  {
    channel,
    value,
  }: {
    channel: Channel;
    value: any;
  } = {
    channel: Channel.CACHE_MAIN_SCRIPTS,
    value: null,
  },
) => {
  log.info('🏆 Caching main scripts...', {
    channel,
    value,
  });
  return new Promise<boolean>((resolve, reject) => {
    currentResolve = resolve;
    currentReject = reject;
    // Wrap the function body in a new Promise

    let stamp: Stamp | null = null;
    if (channel === Channel.CACHE_MAIN_SCRIPTS) {
      stamp = value;
    }

    try {
      if (!workers.cacheScripts) {
        log.info(`Creating worker: ${CACHED_GROUPED_SCRIPTS_WORKER}...`);
        workers.cacheScripts = new Worker(CACHED_GROUPED_SCRIPTS_WORKER);
        workers.cacheScripts.on('exit', (exitCode) => {
          log.error('Worker exited', {
            exitCode,
          });
        });

        const messageHandler = (message) => {
          log.green('Worker message:', message.channel);
          if (message.channel === Channel.CACHE_MAIN_SCRIPTS) {
            log.info('Caching main scripts...');
            cacheMainMenu(message);
            currentResolve(message);
          }
        };

        const errorHandler = (error) => {
          log.info('Received error for stamp', stamp);
          if (error instanceof Error) {
            log.error('Failed to cache main scripts', {
              message: error.message,
              stack: error.stack,
              name: error.name,
            });
          } else {
            log.error('Failed to cache main scripts', {
              error: error,
            });
          }
          currentReject(error); // Reject the promise on error
        };

        const messageErrorHandler = (error) => {
          log.info('Received message error for stamp', stamp);
          log.error('MessageError: Failed to cache main scripts', error);
          currentReject(error); // Reject the promise on message error
        };

        workers.cacheScripts.on('messageerror', messageErrorHandler);
        workers.cacheScripts.on('error', errorHandler);
        workers.cacheScripts.on('message', messageHandler);
      }

      if (stamp?.filePath && isInDirectory(stamp?.filePath, kitPath())) {
        log.info(`Ignore stamping .kit script: ${stamp.filePath}`);
      } else {
        log.info(`Stamping ${stamp?.filePath || 'cache only'} 💟`);
        if (!postMessage && workers.cacheScripts) {
          postMessage = debounce(
            (message) => {
              workers?.cacheScripts?.postMessage(message);
            },
            250,
            {
              leading: true,
            },
          );
        }

        log.info('Sending stamp to worker', stamp);
        postMessage({ channel, value });
      }
    } catch (error) {
      log.warn('Failed to cache main scripts at startup', error);
      currentReject(error); // Reject the promise on catch
    }
  });
};

export const matchPackageJsonEngines = async () => {
  const KIT = kitPath();
  const KENV = kenvPath();

  const options: ExecOptions = {
    cwd: kenvPath(), // Set the current working directory based on the provided parameter
    env: {
      KIT,
      KENV,
      PATH: KIT_FIRST_PATH + path.delimiter + process?.env?.PATH,
    },
  };
  const execP = promisify(exec);

  const getCommandOutput = async (command: string) => {
    // How do I pass the options to execP?
    const { stdout } = await execP(command, options);
    return stdout.trim();
  };
  const isWin = os.platform().startsWith('win');
  const npmPath = isWin ? knodePath('bin', 'npm.cmd') : knodePath('bin', 'npm');
  const nodePath = isWin ? knodePath('bin', 'node.exe') : knodePath('bin', 'node');

  const pkgJson = await readJson(kenvPath('package.json')).catch(() => ({
    engines: undefined,
  }));
  try {
    const npmVersion = await getCommandOutput(`${npmPath} --version`);
    const nodeVersion = await getCommandOutput(`${nodePath} --version`);
    log.info({
      npmVersion,
      nodeVersion,
    });

    pkgJson.engines = {
      node: nodeVersion.replace('v', ''),
      npm: npmVersion,
    };
  } catch (error) {
    pkgJson.engines = undefined;
  }

  await writeJson(kenvPath('package.json'), pkgJson, { spaces: 2 });
};
