import { clipboard, shell } from 'electron';
import { HttpsProxyAgent } from 'hpagent';

import 'core-js/stable';
import 'regenerator-runtime/runtime';
import log from 'electron-log';

import path from 'path';
import tar from 'tar';
import StreamZip from 'node-stream-zip';
import {
  SpawnSyncOptions,
  ForkOptions,
  fork,
  spawn,
  SpawnSyncReturns,
} from 'child_process';
import os, { homedir } from 'os';
import { ensureDir } from 'fs-extra';
import { readFile } from 'fs/promises';

import { Channel } from '@johnlindquist/kit/cjs/enum';

import {
  kenvPath,
  kitPath,
  knodePath,
  KIT_FIRST_PATH,
} from '@johnlindquist/kit/cjs/utils';

import { destroyPromptWindow, sendToPrompt } from './prompt';
import { INSTALL_ERROR, show } from './show';
import { showError } from './main.dev.templates';
import { mainLogPath } from './logs';
import { kitState } from './state';

let isOhNo = false;
export const ohNo = async (error: Error) => {
  if (isOhNo) return;
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
    `.trim()
    );
    destroyPromptWindow();
    await show(INSTALL_ERROR, showError(error, mainLogContents));
  } catch (copyError) {
    shell.openExternal(mainLogPath);
  }

  throw new Error(error.message);
};

export const sendSplashBody = (message: string) => {
  if (message.includes('object')) return;
  if (message.toLowerCase().includes('warn')) return;
  sendToPrompt(Channel.SET_SPLASH_BODY, message);
};

export const sendSplashHeader = (message: string) => {
  sendToPrompt(Channel.SET_SPLASH_HEADER, message);
};

export const sendSplashProgress = (progress: number) => {
  sendToPrompt(Channel.SET_SPLASH_PROGRESS, progress);
};

export const setupDone = () => {
  sendSplashProgress(100);
  sendSplashHeader(`Kit SDK Install verified ✅`);
};

export const handleLogMessage = async (
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
    sendSplashBody(out.slice(0, 200));
  }

  if (error && required) {
    throw new Error(error.message);
  }

  if (stderr?.toString().length) {
    sendSplashBody(stderr.toString());
    console.log({ stderr: stderr.toString() });
    // throw new Error(stderr.toString());
  }

  return result;
};

export const installEsbuild = async () => {
  const KIT = kitPath();

  const options: SpawnSyncOptions = {
    cwd: KIT,
    encoding: 'utf-8',
    env: {
      KIT,
      KENV: kenvPath(),
      PATH: KIT_FIRST_PATH + path.delimiter + process?.env?.PATH,
    },
    stdio: 'pipe',
  };

  const npmResult = await new Promise((resolve, reject) => {
    const isWin = os.platform().startsWith('win');
    const npmPath = isWin
      ? knodePath('bin', 'npm.cmd')
      : knodePath('bin', 'npm');

    log.info({ npmPath });
    const child = spawn(npmPath, [`run`, `lazy-install`], options);

    let dots = 1;
    const installMessage = `Installing Kit Packages`;
    const id = setInterval(() => {
      if (dots >= 3) dots = 0;
      dots += 1;
      sendSplashBody(installMessage.padEnd(installMessage.length + dots, '.'));
    }, 250);

    const clearId = () => {
      try {
        if (id) clearInterval(id);
      } catch (error) {
        log.info(`Failed to clear id`);
      }
    };
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
      log.info(`Success: npm run lazy-install success`);
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

const getOptions = () => {
  const options: any = { insecure: true, rejectUnauthorized: false };
  const proxy =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;
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

  const fileName = `kenv.zip`;
  const file = osTmpPath(fileName);
  const url = `https://github.com/johnlindquist/kenv/releases/latest/download/${fileName}`;

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
  const pathToClean = kitPath();

  const keep = (file: string) =>
    file === 'db' || file === 'node_modules' || file === 'assets';

  // eslint-disable-next-line no-restricted-syntax
  for await (const file of await readdir(pathToClean)) {
    if (keep(file)) {
      log.info(`👍 Keeping ${file}`);
      // eslint-disable-next-line no-continue
      continue;
    }

    const filePath = path.resolve(pathToClean, file);
    const stat = await lstat(filePath);
    if (stat.isDirectory()) {
      await rm(filePath, { recursive: true, force: true });
      log.info(`🧹 Cleaning dir ${filePath}`);
    } else {
      await rm(filePath);
      log.info(`🧹 Cleaning file ${filePath}`);
    }
  }
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
  const uppercaseOSName =
    process.platform === 'win32'
      ? 'Windows'
      : process.platform === 'linux'
      ? 'Linux'
      : 'macOS';

  // Download Kit SDK based on the current platform and architecture
  // Examples:
  // Mac arm64: https://github.com/johnlindquist/kitapp/releases/download/v1.40.70/Kit-SDK-macOS-1.40.70-arm64.tar.gz
  // Linux x64: https://github.com/johnlindquist/kitapp/releases/download/v1.40.70/Kit-SDK-Linux-1.40.70-x64.tar.gz
  // Windows x64: https://github.com/johnlindquist/kitapp/releases/download/v1.40.70/Kit-SDK-macOS-1.40.70-x64.tar.gz

  const kitSDK = `Kit-SDK-${uppercaseOSName}-${version}-${process.arch}.${extension}`;
  const file = osTmpPath(kitSDK);
  const url = `https://github.com/johnlindquist/kitapp/releases/download/v${version}/${kitSDK}`;

  sendSplashBody(`Download Kit SDK from ${url}`);

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

  // download node v18.16.0 based on the current platform and architecture
  // Examples:
  // Mac arm64: https://nodejs.org/dist/v18.16.0/node-v18.16.0-darwin-arm64.tar.gz
  // Linux x64: https://nodejs.org/dist/v18.16.0/node-v18.16.0-linux-x64.tar.gz
  // Windows x64: https://nodejs.org/dist/v18.16.0/node-v18.16.0-win-x64.zip

  // Node dist url uses "win", not "win32"
  const nodeVersion = `v${process.versions.node}`;
  const nodePlatform = isWin ? 'win' : process.platform;
  const nodeArch = isWin ? 'x64' : process.arch;
  const node = `node-${nodeVersion}-${nodePlatform}-${nodeArch}.${extension}`;
  const file = osTmpPath(node);
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
      // node-18.16.0-win-x64
      const fileName = path.parse(file).name;
      console.log(`Extacting ${fileName} to ${knodePath('bin')}`);
      // node-18.16.0-win-x64
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
  log.transports.file.resolvePath = () => kitPath('logs', 'kit.log');
};

export const setupLog = async (message: string) => {
  sendSplashBody(message);
  log.info(message);
  if (process.env.KIT_SPLASH) {
    await new Promise((resolve, reject) =>
      setTimeout(() => {
        resolve(true);
      }, 500)
    );
  }
};

export const forkOptions: ForkOptions = {
  cwd: homedir(),
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
  return new Promise((resolve, reject) => {
    log.info(`Running optional setup script: ${args.join(' ')}`);
    const child = spawn(
      knodePath('bin', 'node'),
      [kitPath('run', 'terminal.js'), ...args],
      forkOptions
    );

    const id = setTimeout(() => {
      if (child && !child.killed) {
        child.kill();
        resolve('timeout');
        log.info(`⚠️ Setup script timed out: ${args.join(' ')}`);
      }
    }, 5000);

    if (child?.stdout) {
      child.stdout.on('data', (data) => {
        if (kitState.ready) return;
        log.info(data.toString());
      });
    }

    if (child?.stderr) {
      if (kitState.ready) return;
      child.stderr.on('data', (data) => {
        log.warn(data.toString());
      });
    }

    child.on('message', (data) => {
      const dataString = typeof data === 'string' ? data : data.toString();

      if (!dataString.includes(`[object`)) {
        log.info(args[0], dataString);
        // sendSplashBody(dataString.slice(0, 200));
      }
    });

    child.on('exit', (code) => {
      if (code === 0) {
        if (id) clearTimeout(id);
        log.info(`✅ Setup script completed: ${args.join(' ')}`);
        resolve('done');
      } else {
        log.info(`⚠️ Setup script exited with code ${code}: ${args.join(' ')}`);
        resolve('error');
      }
    });

    child.on('error', (error: Error) => {
      if (id) clearTimeout(id);
      log.error(`⚠️ Errored on setup script: ${args.join(' ')}`, error.message);
      resolve('error');
      // reject(error);
      // throw new Error(error.message);
    });
  });
};

export const optionalSetupScript = (...args: string[]) => {
  return new Promise((resolve, reject) => {
    log.info(`Running optional setup script: ${args.join(' ')}`);
    const child = fork(kitPath('run', 'terminal.js'), args, forkOptions);

    const id = setTimeout(() => {
      if (child && !child.killed) {
        child.kill();
        resolve('timeout');
        log.info(`⚠️ Setup script timed out: ${args.join(' ')}`);
      }
    }, 5000);

    if (child?.stdout) {
      child.stdout.on('data', (data) => {
        if (kitState.ready) return;
        setupLog(data.toString());
      });
    }

    if (child?.stderr) {
      if (kitState.ready) return;
      child.stderr.on('data', (data) => {
        setupLog(data.toString());
      });
    }

    child.on('message', (data) => {
      const dataString = typeof data === 'string' ? data : data.toString();

      if (!dataString.includes(`[object`)) {
        log.info(args[0], dataString);
        // sendSplashBody(dataString.slice(0, 200));
      }
    });

    child.on('exit', (code) => {
      if (code === 0) {
        if (id) clearTimeout(id);
        log.info(`✅ Setup script completed: ${args.join(' ')}`);
        resolve('done');
      } else {
        log.info(`⚠️ Setup script exited with code ${code}: ${args.join(' ')}`);
        resolve('error');
      }
    });

    child.on('error', (error: Error) => {
      if (id) clearTimeout(id);
      log.error(`⚠️ Errored on setup script: ${args.join(' ')}`, error.message);
      resolve('error');
      // reject(error);
      // throw new Error(error.message);
    });
  });
};

export const installKitInKenv = async () => {
  const KIT = kitPath();
  const KENV = kenvPath();

  const options: SpawnSyncOptions = {
    cwd: KENV,
    encoding: 'utf-8',
    env: {
      KIT,
      KENV,
      PATH: KIT_FIRST_PATH + path.delimiter + process?.env?.PATH,
    },
    stdio: 'pipe',
  };

  const npmResult = await new Promise((resolve, reject) => {
    const isWin = os.platform().startsWith('win');
    const npmPath = isWin
      ? knodePath('bin', 'npm.cmd')
      : knodePath('bin', 'npm');

    log.info({ npmPath });
    const child = spawn(npmPath, [`i`, KIT], options);

    let dots = 1;
    const installMessage = `Installing Kit Packages`;
    const id = setInterval(() => {
      if (dots >= 3) dots = 0;
      dots += 1;
      sendSplashBody(installMessage.padEnd(installMessage.length + dots, '.'));
    }, 250);

    const clearId = () => {
      try {
        if (id) clearInterval(id);
      } catch (error) {
        log.info(`Failed to clear id`);
      }
    };
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
      log.info(`Success: npm run lazy-install success`);
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
