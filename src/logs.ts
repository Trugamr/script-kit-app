/* eslint-disable @typescript-eslint/naming-convention */
/* eslint-disable no-underscore-dangle */
/* eslint-disable no-console */
/* eslint-disable import/prefer-default-export */
import log, { LevelOption } from 'electron-log';
import { subscribeKey } from 'valtio/utils';
import fs from 'fs';
import { kenvPath, getLogFromScriptPath } from '@johnlindquist/kit/cjs/utils';
import { Channel } from '@johnlindquist/kit/cjs/enum';
import { sendToPrompt } from './prompt';
import { stripAnsi } from './ansi';
import { kitState } from './state';

export const consoleLog = log.create('consoleLog');
consoleLog.transports.file.resolvePath = () => kenvPath('logs', 'console.log');

interface Logger {
  info: (...args: string[]) => void;
  warn: (...args: string[]) => void;
  clear: () => void;
}

const logMap = new Map<string, Logger>();

export const getLog = (scriptPath: string): Logger => {
  try {
    if (logMap.get(scriptPath)) return logMap.get(scriptPath) as Logger;

    const scriptLog = log.create(scriptPath);
    const logPath = getLogFromScriptPath(scriptPath);
    log.info(`Log path: ${logPath}`);
    scriptLog.transports.file.resolvePath = () => logPath;
    scriptLog.transports.file.level = kitState.logLevel;

    const _info = scriptLog.info.bind(scriptLog);
    const _warn = scriptLog.warn.bind(scriptLog);
    const logger = {
      info: (...args: string[]) => {
        _info(...args.map(stripAnsi));
      },
      warn: (...args: string[]) => {
        _warn(...args.map(stripAnsi));
      },
      clear: () => {
        fs.writeFileSync(logPath, ``);
      },
    };
    logMap.set(scriptPath, logger);

    return logger;
  } catch {
    return {
      info: (...args: any[]) => {
        console.log(...args.map(stripAnsi));
      },
      warn: (...args: any[]) => {
        console.warn(...args.map(stripAnsi));
      },
      clear: () => {},
    };
  }
};

export const warn = (message: string) => {
  sendToPrompt(Channel.CONSOLE_WARN, message);
  log.warn(message);
};

log.transports.console.level = 'info';
if (process.env.LOG_LEVEL) {
  log.info('🪵 Setting log level', process.env.LOG_LEVEL);
  log.transports.file.level = process.env.LOG_LEVEL as LevelOption;
} else if (process.env.NODE_ENV === 'production') {
  log.transports.file.level = 'info';
} else {
  if (log.transports.ipc) log.transports.ipc.level = 'error';
  log.transports.file.level = 'verbose';
}

subscribeKey(kitState, 'logLevel', (level) => {
  log.info(`📋 Log level set to: ${level}`);
  log.transports.file.level = level;
});
