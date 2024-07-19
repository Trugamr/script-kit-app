/* eslint-disable no-nested-ternary */
/* eslint-disable import/prefer-default-export */
import log from 'electron-log';

import os from 'node:os';
import { pathToFileURL } from 'node:url';
import ContrastColor from 'contrast-color';
import { BrowserWindow, type IpcMainEvent, globalShortcut, ipcMain, nativeTheme, powerMonitor } from 'electron';
import { assign, debounce } from 'lodash-es';

import { type ChildProcess, fork, spawn } from 'node:child_process';
import { Channel, ProcessType, UI } from '@johnlindquist/kit/core/enum';
import type { ProcessInfo } from '@johnlindquist/kit/types/core';

import type { GenericSendData } from '@johnlindquist/kit/types/kitapp';

import { KIT_APP, KIT_APP_PROMPT, execPath, kitPath, resolveToScriptPath } from '@johnlindquist/kit/core/utils';

import { pathExistsSync, readJson } from './cjs-exports';
import { getLog, mainLog } from './logs';
import type { KitPrompt } from './prompt';
import { debounceSetScriptTimestamp, getThemes, kitState, kitStore } from './state';

import { widgetState } from '../shared/widget';

import { sendToAllPrompts } from './channel';

import { KitEvent, emitter } from '../shared/events';
import { showInspector } from './show';

import { toHex } from '../shared/color-utils';
import { AppChannel } from '../shared/enums';
import { stripAnsi } from './ansi';
import { createEnv } from './env.utils';
import { isKitScript, toRgb } from './helpers';
import { createMessageMap } from './messages';
import { prompts } from './prompts';
import shims from './shims';
import { TrackEvent, trackEvent } from './track';

import { createLogger } from '../shared/log-utils';

const { info, warn, err, silly, verbose } = createLogger('process.ts');

export type ProcessAndPrompt = ProcessInfo & {
  prompt: KitPrompt;
  promptId?: string;
  launchedFromMain: boolean;
  preventChannels?: Set<Channel>;
};

// TODO: Reimplement SET_PREVIEW
export const clearPreview = () => {
  // sendToSpecificPrompt(Channel.SET_PREVIEW, `<div></div>`);
};

// TODO: Reimplement SET_FLAGS
export const clearFlags = () => {
  // sendToSpecificPrompt(Channel.SET_FLAG_VALUE, '');
  // sendToSpecificPrompt(Channel.SET_FLAGS, {});
  // setFlags({});
};

export const maybeConvertColors = async (theme: any = {}) => {
  // info(`🎨 Convert Colors:`, theme);

  // eslint-disable-next-line prettier/prettier
  theme.foreground ||= theme?.['--color-text'];
  theme.background ||= theme?.['--color-background'];
  theme.accent ||= theme?.['--color-primary'];
  theme.ui ||= theme?.['--color-secondary'];

  const { scriptKitTheme, scriptKitLightTheme } = getThemes();
  theme.opacity ||= theme?.['--opacity'];
  nativeTheme.shouldUseDarkColors ? scriptKitTheme.opacity : scriptKitLightTheme.opacity;

  verbose(`🫥 Theme opacity: ${theme.opacity}`);
  const themeUIBgOpacity = theme?.['ui-bg-opacity'] || scriptKitLightTheme['ui-bg-opacity'];

  verbose(`🫥 Theme ui-bg-opacity: ${theme?.['ui-bg-opacity']}, ${themeUIBgOpacity}`);
  theme['--ui-bg-opacity'] = themeUIBgOpacity;
  verbose(`🫥 Theme ui-bg-opacity: ${theme['--ui-bg-opacity']}`);
  theme['--ui-border-opacity'] ||= theme?.['ui-border-opacity'] || scriptKitLightTheme['ui-border-opacity'];

  if (kitState.kenvEnv.KIT_DISABLE_BLUR === 'true') {
    theme.opacity = '1';
  }

  if (theme.foreground) {
    const foreground = toRgb(theme.foreground);
    theme['--color-text'] = foreground;
  }
  if (theme.accent) {
    const accent = toRgb(theme.accent);
    theme['--color-primary'] = accent;
  }

  if (theme.ui) {
    const ui = toRgb(theme.ui);
    theme['--color-secondary'] = toRgb(ui);
  }

  let result = '';
  if (theme.background) {
    const background = toRgb(theme.background);
    theme['--color-background'] = background;
    const bgColor = toHex(theme.background);

    const cc = new ContrastColor({
      bgColor,
    });
    result = cc.contrastColor();

    theme.appearance ||= result === '#FFFFFF' ? 'dark' : 'light';
    verbose(`💄 Setting appearance to ${theme.appearance}`);
  }

  theme['--opacity'] = `${theme.opacity}`;

  if (theme.ui) {
    theme.ui = undefined;
  }
  if (theme.background) {
    theme.background = undefined;
  }
  if (theme.foreground) {
    theme.foreground = undefined;
  }
  if (theme.accent) {
    theme.accent = undefined;
  }
  if (theme.opacity) {
    theme.opacity = undefined;
  }
  if (theme?.['ui-bg-opacity']) {
    theme['ui-bg-opacity'] = undefined;
  }
  if (theme?.['ui-border-opacity']) {
    theme['ui-border-opacity'] = undefined;
  }

  // if(value?.['--color-text']) delete value['--color-text']
  // if(value?.['--color-background']) delete value['--color-background']
  // if(value?.['--color-primary']) delete value['--color-primary']
  // if(value?.['--color-secondary']) delete value['--color-secondary']
  // if(value?.['--opacity']) delete value['--opacity']

  const validVibrancies = [
    'appearance-based',
    'light',
    'dark',
    'titlebar',
    'selection',
    'menu',
    'popover',
    'sidebar',
    'medium-light',
    'ultra-dark',
    'header',
    'sheet',
    'window',
    'hud',
    'fullscreen-ui',
    'tooltip',
    'content',
    'under-window',
    'under-page',
  ];

  const defaultVibrancy = 'hud';

  // setVibrancy(vibrancy);

  verbose('🎨 Theme:', theme);

  return theme;
};

export const setTheme = async (value: any = {}, reason = '') => {
  info(`🎨 Setting theme because ${reason}`);
  // verbose(`🎨 Setting theme:`, {
  //   hasCss: kitState.hasCss,
  //   value,
  // });
  // if (kitState.hasCss) return;
  // if (check) {
  //   await sponsorCheck('Custom Themes');
  //   if (!kitState.isSponsor) return;
  // }

  const newValue = await maybeConvertColors(value);
  assign(kitState.theme, newValue);

  // TODO: https://github.com/electron/electron/issues/37705
  // const promptWindow = getMainPrompt();
  // const backgroundColor = `rgba(${kitState.theme['--color-background']}, ${kitState.theme['--opacity']})`;
  // info(`🎨 Setting backgroundColor: ${backgroundColor}`);

  // promptWindow.setBackgroundColor(backgroundColor);

  sendToAllPrompts(Channel.SET_THEME, newValue);
};

export const updateTheme = async () => {
  kitState.isDark = nativeTheme.shouldUseDarkColors;
  // info({
  //   isDarkState: kitState.isDark ? 'true' : 'false',
  //   isDarkNative: nativeTheme.shouldUseDarkColors ? 'true' : 'false',
  // });

  const themePath = kitState.isDark ? kitState.kenvEnv?.KIT_THEME_DARK : kitState.kenvEnv?.KIT_THEME_LIGHT;

  if (themePath && pathExistsSync(themePath)) {
    info(`▓ ${kitState.isDark ? 'true' : 'false'} 👀 Theme path: ${themePath}`);
    try {
      const currentTheme = await readJson(themePath);
      setTheme(currentTheme, `updateTheme() with themePath: ${themePath}`);
    } catch (error) {
      warn(error);
    }
  } else {
    info('👀 No themes configured in .env. Using defaults');
    const { scriptKitLightTheme, scriptKitTheme } = getThemes();
    setTheme(kitState.isDark ? scriptKitTheme : scriptKitLightTheme, 'updateTheme() with no themePath');
  }
};
nativeTheme.addListener('updated', updateTheme);

type WidgetData = {
  widgetId: string;
  value?: any;
  width?: number;
  height?: number;
  filePath?: string;
  iconPath?: string;
};
type WidgetHandler = (event: IpcMainEvent, data: WidgetData) => void;

export const cachePreview = async () => {
  // verbose(`🎁 Caching preview for ${kitState.scriptPath}`);
  // preloadPreviewMap.set(scriptPath, preview);
  // if (
  //   kitState.scriptPath === getMainScriptPath() &&
  //   preview &&
  //   kitSearch.input === '' &&
  //   !kitSearch.inputRegex
  // ) {
  // TODO: Going to need to cache preview so the _next_ prompt has access
  // appToSpecificPrompt(AppChannel.SET_CACHED_MAIN_PREVIEW, preview);
  // }
};

export const childSend = (child: ChildProcess, data: any) => {
  try {
    if (child?.connected && child.pid) {
      const prompt = prompts.get(child.pid);
      if (prompt) {
        data.promptId = prompt.id;
      }
      // info(`✉️: ${data.channel}`);
      child.send(data, (error) => {
        if (error) {
          warn(`${child?.pid}: ${data?.channel} ignored. Already finished: ${data?.promptId}`);
        }
      });
    }
  } catch (error) {
    err('childSend error', error);
  }
};

export const sendToAllActiveChildren = (data: {
  channel: Channel;
  state?: any;
}) => {
  // info(`Sending ${data?.channel} to all active children`);
  for (const processInfo of processes.getActiveProcesses()) {
    const prevent = processInfo.preventChannels?.has(data.channel);
    if (prevent) {
      continue;
    }
    info({ pid: processInfo?.pid, prevent, channel: data.channel });
    childSend(processInfo.child, data);
  }
};

export const createMessageHandler = (processInfo: ProcessInfo) => {
  const { type } = processInfo;
  const kitMessageMap = createMessageMap(processInfo as ProcessAndPrompt);
  // info({ kitMessageMap });

  return (data: GenericSendData) => {
    if (
      !data.kitScript &&
      data?.channel !== Channel.HEARTBEAT &&
      ![Channel.KIT_LOADING, Channel.KIT_READY, Channel.MAIN_MENU_READY].includes(data.channel)
    ) {
      info(data);
    }
    const channelFn = kitMessageMap[data.channel as Channel];

    if (channelFn) {
      // type C = keyof ChannelMap;
      // const channelFn = kitMessageMap[data.channel as C] as (
      //   data: SendData<C>
      // ) => void;
      try {
        silly(`📬 ${data.channel}`);
        channelFn(data);
      } catch (error) {
        err(`Error in channel ${data.channel}`, error);
      }
    } else {
      warn(`Channel ${data?.channel} not found on ${type}.`);
    }
  };
};

interface CreateChildInfo {
  type: ProcessType;
  scriptPath?: string;
  runArgs?: string[];
  port?: number;
  resolve?: (data: any) => void;
  reject?: (error: any) => void;
}

const DEFAULT_TIMEOUT = 15000;
export const HANDLER_CHANNELS: Channel[] = [
  Channel.SYSTEM_CLICK,
  Channel.SYSTEM_MOUSEDOWN,
  Channel.SYSTEM_MOUSEUP,
  Channel.SYSTEM_MOUSEMOVE,
  Channel.SYSTEM_KEYDOWN,
  Channel.SYSTEM_KEYUP,
  Channel.SYSTEM_WHEEL,
  Channel.SCRIPT_ADDED,
  Channel.SCRIPT_REMOVED,
  Channel.SCRIPT_CHANGED,
];
const createChild = ({ type, scriptPath = 'kit', runArgs = [], port = 0 }: CreateChildInfo) => {
  let args: string[] = [];
  if (scriptPath) {
    const resolvePath = resolveToScriptPath(scriptPath);
    args = [resolvePath, ...runArgs];
  } else {
    args = [];
  }

  const isPrompt = type === ProcessType.Prompt;
  const entry = isPrompt ? KIT_APP_PROMPT : KIT_APP;

  const env = createEnv();
  // console.log({ env });
  const loaderFileUrl = pathToFileURL(kitPath('build', 'loader.js')).href;
  const beforeChildForkPerfMark = performance.now();
  const child = fork(entry, args, {
    silent: true,
    stdio: kitState?.kenvEnv?.KIT_STDIO || 'pipe',
    // TODO: Testing execPath on Windows????
    execPath,
    cwd: kitState?.kenvEnv?.KIT_CWD || os.homedir(),
    execArgv: ['--loader', loaderFileUrl],
    windowsHide: kitState?.kenvEnv?.KIT_WINDOWS_HIDE === 'true',
    detached: !port,
    env: {
      ...env,
      KIT_DEBUG: port ? '1' : '0',
    },
    ...(port
      ? {
          stdio: 'pipe',
          execArgv: ['--loader', loaderFileUrl, `--inspect=${port}`],
        }
      : {}),
  });

  const kitLoadingHandler = (data) => {
    if (data?.channel === Channel.KIT_LOADING || data?.channel === Channel.KIT_READY) {
      info(`${child.pid}: KIT_LOADING ${data?.value} in ${performance.now() - beforeChildForkPerfMark}ms`);
      // child.off('message', kitLoadingHandler);
    }
  };

  child.on('message', kitLoadingHandler);

  const kitReadyHandler = (data) => {
    if (data?.channel === Channel.KIT_READY) {
      info(`${child.pid}: KIT_READY in ${performance.now() - beforeChildForkPerfMark}ms`);
      child.off('message', kitReadyHandler);
    }
  };

  child.on('message', kitReadyHandler);

  const mainMenuReadyHandler = (data) => {
    if (data?.channel === Channel.MAIN_MENU_READY) {
      info(`${child.pid}: MAIN_MENU_READY in ${performance.now() - beforeChildForkPerfMark}ms`);
      child.off('message', mainMenuReadyHandler);
    }
  };

  child.on('spawn', () => {
    info(`${child?.pid}: SPAWN in ${performance.now() - beforeChildForkPerfMark}ms`);
  });

  info(`
  ${child.pid}: 🚀 Create child process: ${entry} ${args.join(' ')}`);

  let win: BrowserWindow | null = null;

  if (port && child && child.stdout && child.stderr) {
    const closeWindowIfNotDestroyed = () => {
      info(`${child?.pid}: 🚪 Close window if not destroyed`);
      if (child && !child.killed) {
        info(`${child.pid}: 🐞 Remove debugger process by pid`);
        child.kill();
      }

      if (win && !win.isDestroyed()) {
        win?.webContents?.closeDevTools();
        win?.webContents?.close();
        win?.close();
        win?.destroy();
      }
    };

    const parentPid = child.pid;
    emitter.once(KitEvent.ProcessGone, (pid) => {
      info(`Kill process: ${pid}, checking if it's the parent of ${child.pid}`);
      if (pid === parentPid) {
        closeWindowIfNotDestroyed();
      }
    });

    child.stderr.once('data', async (data) => {
      info(data?.toString());
      const [debugUrl] = data.toString().match(/(?<=ws:\/\/).*/g) || [''];

      if (debugUrl) {
        // TODO: I'm going to have to handle this outside of creatChild so it has access to the prompt created after it or something
        // setPromptAlwaysOnTop(true);
        info({ debugUrl, pid: child?.pid });
        const devToolsUrl = `devtools://devtools/bundled/inspector.html?experiments=true&v8only=true&ws=${debugUrl}`;
        info(`DevTools URL: ${devToolsUrl}`);

        win = showInspector(devToolsUrl);
      }
    });

    const scriptLog = getLog(scriptPath);

    const routeToScriptLog = (d: any) => {
      scriptinfo(`\n${stripAnsi(d.toString())}`);
    };

    child.stdout?.on('data', routeToScriptLog);
    child.stderr?.on('data', routeToScriptLog);
  }

  return child;
};

interface ProcessHandlers {
  onExit?: () => void;
  onError?: (error: Error) => void;
  resolve?: (values: any[]) => any;
  reject?: (value: any) => any;
}

const processesChanged = debounce(() => {
  if (kitState.allowQuit) {
    return;
  }
  const pinfos = processes.getAllProcessInfo().filter((p) => p.scriptPath);

  for (const pinfo of processes) {
    pinfo.prompt.sendToPrompt(AppChannel.PROCESSES, pinfos);
    info(`🏃‍♂️💨 Active process: ${pinfo.pid} - ${pinfo.scriptPath || 'Idle'}`);
  }
}, 10);

export const clearIdleProcesses = () => {
  // return;
  info('Reset all idle processes');
  processes.getAllProcessInfo().forEach((processInfo) => {
    if (processInfo.type === ProcessType.Prompt && processInfo.scriptPath === '') {
      processes.removeByPid(processInfo.pid);
    }
  });
};

export const getIdles = () => {
  return processes
    .getAllProcessInfo()
    .filter((processInfo) => processInfo.type === ProcessType.Prompt && processInfo?.scriptPath === '');
};

export const ensureIdleProcess = () => {
  if (!kitState.ready) {
    return;
  }
  info('Ensure idle process');
  setTimeout(() => {
    const idles = getIdles();
    const requiredIdleProcesses = kitState?.kenvEnv?.KIT_IDLE_PROCESSES
      ? Number.parseInt(kitState.kenvEnv.KIT_IDLE_PROCESSES)
      : 1;
    const missingProcesses = requiredIdleProcesses - idles.length;
    if (missingProcesses > 0) {
      info(`Adding ${missingProcesses} idle process(es)`);
      for (let i = 0; i < missingProcesses; i++) {
        processes.add(ProcessType.Prompt);
      }
    }
  }, 0);
};

const setTrayScriptError = (pid: number) => {
  try {
    const { scriptPath: errorScriptPath } = processes.getByPid(pid) || {
      scriptPath: '',
    };

    kitState.scriptErrorPath = errorScriptPath;
  } catch {
    kitState.scriptErrorPath = '';
  }
};

export const childShortcutMap = new Map<number, string[]>();

class Processes extends Array<ProcessAndPrompt> {
  public abandonnedProcesses: ProcessAndPrompt[] = [];

  public getAllProcessInfo() {
    return this.map(({ scriptPath, type, pid }) => ({
      type,
      scriptPath,
      pid,
    }));
  }

  public addExistingProcess(child: ChildProcess, scriptPath: string) {
    const promptInfo = {
      pid: child.pid,
      child,
      type: ProcessType.Prompt,
      scriptPath,
      values: [],
      date: Date.now(),
    } as Partial<ProcessAndPrompt>;

    this.push(promptInfo as ProcessAndPrompt);
    processesChanged();
  }

  public stampPid(pid: number) {
    info(`${pid}: 📅 Stamp PID`);
    const processInfo = this.getByPid(pid);
    if (!processInfo?.launchedFromMain) {
      return;
    }
    if (processInfo.type === ProcessType.Prompt && !processInfo.scriptPath.includes('.kit')) {
      const now = Date.now();
      const stamp = {
        filePath: processInfo?.scriptPath,
        runCount: 1,
        executionTime: now - processInfo.date,
        runStamp: processInfo.date,
        exitStamp: now,
      };

      info('>>>>>>>>>>>>>>>>>>>>>>>> STAMPING!!!!!', stamp);

      debounceSetScriptTimestamp({
        ...stamp,
        reason: 'stampPid',
      });
    }
  }

  private heartbeatInterval: NodeJS.Timeout | null = null;

  public startHeartbeat() {
    if (this.heartbeatInterval) {
      return;
    }
    this.heartbeat();

    this.heartbeatInterval = setInterval(() => {
      this.heartbeat();
    }, 10000);
  }

  public stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  public heartbeat() {
    for (const pInfo of this) {
      if (!pInfo?.prompt?.isVisible()) {
        return;
      }
      if (pInfo.child?.connected && !pInfo.child?.killed) {
        pInfo.child.send({
          channel: Channel.HEARTBEAT,
        });
      }
    }
  }

  public add(
    type: ProcessType = ProcessType.Prompt,
    scriptPath = '',
    args: string[] = [],
    port = 0,
    { resolve, reject }: ProcessHandlers = {},
  ): ProcessAndPrompt {
    const child = createChild({
      type,
      scriptPath,
      runArgs: args,
      port,
    });

    if (!child.pid) {
      err('Child process has no pid', child);
      throw new Error('Child process has no pid');
    }

    const prompt = prompts.attachIdlePromptToProcess(child.pid);

    info(`${child.pid}: 👶 Create child ${type} process: ${child.pid}`, scriptPath, args);

    const promptInfo = {
      pid: child.pid,
      child,
      type,
      scriptPath,
      values: [],
      date: Date.now(),
      prompt,
      launchedFromMain: false,
      preventChannels: new Set<Channel>(HANDLER_CHANNELS),
    } as ProcessAndPrompt;

    // prompt.window.on('closed', () => {
    //   info.prompt = null;
    // });

    this.push(promptInfo);

    processesChanged();

    if (scriptPath) {
      info(`${child.pid}: 🟢 start ${type} ${scriptPath}`);
    } else {
      info(`${child.pid}: 🟢 start idle ${type}`);
    }

    const id =
      ![ProcessType.Background, ProcessType.Prompt].includes(type) &&
      setTimeout(() => {
        info(`${child.pid}: ${type} process: ${scriptPath} took > ${DEFAULT_TIMEOUT} seconds. Ending...`);
        child?.kill();
      }, DEFAULT_TIMEOUT);

    const messageHandler = createMessageHandler(promptInfo);
    child?.on('message', messageHandler);

    const { pid } = child;

    child.once('close', () => {
      info(`${pid}: CLOSE`);
      processes.removeByPid(pid);
    });

    child.once('disconnect', () => {
      info(`${pid}: DISCONNECTED`);
      this.stampPid(pid);
      processes.removeByPid(pid);
    });

    child.once('exit', (code) => {
      info('EXIT', { pid, code });
      if (id) {
        clearTimeout(id);
      }

      prompt.sendToPrompt(Channel.EXIT, pid);
      emitter.emit(KitEvent.TERM_KILL, pid);

      const processInfo = processes.getByPid(pid) as ProcessInfo;

      if (!processInfo) {
        return;
      }

      if (resolve) {
        resolve(processInfo?.values);
      }

      if (code === 0) {
        info(`${child.pid}: 🟡 exit ${code}. ${processInfo.type} process: ${processInfo?.scriptPath}`);

        if (child.pid) {
          this.stampPid(child.pid);
        }
      } else if (typeof code === 'number') {
        err(`${child.pid}: 🟥 exit ${code}. ${processInfo.type} process: ${processInfo?.scriptPath}`);
        err('👋 Ask for help: https://github.com/johnlindquist/kit/discussions/categories/errors');

        setTrayScriptError(pid);
      }

      processes.removeByPid(pid);
    });

    child.on('error', (error) => {
      if (error?.message?.includes('EPIPE')) {
        return;
      }
      err('ERROR', { pid, error });
      err('👋 Ask for help: https://github.com/johnlindquist/kit/discussions/categories/errors');
      kitState.status = {
        status: 'warn',
        message: '',
      };

      setTrayScriptError(pid);
      processes.removeByPid(pid);

      trackEvent(TrackEvent.ChildError, {
        error: error?.message,
      });
      if (reject) {
        reject(error);
      }
    });

    return promptInfo;
  }

  public findIdlePromptProcess(): ProcessAndPrompt {
    info('>>>>>>>>>>>>>> FINDING IDLE PROCESS <<<<<<<<<<<<<<<<');
    const idles = this.filter(
      (processInfo) => processInfo.type === ProcessType.Prompt && processInfo?.scriptPath === '',
    );

    ensureIdleProcess();

    if (idles.length) {
      return idles[0];
    }

    info('>>>>>>>>>>>>>> NO IDLE PROCESS FOUND <<<<<<<<<<<<<<<<');

    return processes.add(ProcessType.Prompt);
  }

  public getActiveProcesses() {
    return this.filter((processInfo) => processInfo.scriptPath);
  }

  public getByPid(pid: number): ProcessAndPrompt {
    return [...this, ...this.abandonnedProcesses].find((processInfo) => processInfo.pid === pid) as ProcessAndPrompt;
  }

  public getChildByPid(pid: number): ChildProcess {
    return this.getByPid(pid)?.child;
  }

  public removeAllRunningProcesses() {
    const runningIds = this.filter(({ scriptPath }) => scriptPath).map(({ pid, scriptPath }) => ({ pid, scriptPath }));
    for (const { pid, scriptPath } of runningIds) {
      info(`🔥 Attempt removeAllRunningProcesses: ${pid} - ${scriptPath}`);
      this.removeByPid(pid);
    }
  }

  public removeByPid(pid: number) {
    info(`🛑 removeByPid: ${pid}`);
    if (pid === 0) {
      info(`Invalid pid: ${pid} 🤔`);
    }
    prompts.delete(pid);
    const index = this.findIndex((info) => info.pid === pid);
    if (index === -1) {
      info(`No process found for pid: ${pid}`);
      // Find a system process with the pid and kill it
      let systemProcess: ChildProcess | null = null;
      try {
        if (process.platform === 'win32') {
          systemProcess = spawn('taskkill', ['/PID', pid.toString(), '/F']);
        } else {
          systemProcess = spawn('kill', ['-9', pid.toString()]);
        }
        info(`${pid}: Killed system process using ${systemProcess.spawnargs}`);
      } catch (error) {
        err(`${pid}: Error killing system process: ${error}`);
      }

      return;
    }
    const { child, scriptPath } = this[index];

    if (!child?.killed) {
      emitter.emit(KitEvent.RemoveProcess, scriptPath);
      emitter.emit(KitEvent.ProcessGone, pid);
      info(`Emitting ${KitEvent.TERM_KILL} for ${pid}`);
      emitter.emit(KitEvent.TERM_KILL, pid);
      child?.removeAllListeners();
      child?.kill();

      if (child?.pid && childShortcutMap.has(child.pid)) {
        info(`${child.pid}: Unregistering shortcuts`);
        const shortcuts = childShortcutMap.get(child.pid) || [];
        shortcuts.forEach((shortcut) => {
          info(`${child.pid}: Unregistering shortcut: ${shortcut}`);

          try {
            globalShortcut.unregister(shortcut);
          } catch (error) {
            err(`${child.pid}: Error unregistering shortcut: ${shortcut}`, error);
          }
        });
        childShortcutMap.delete(child.pid);
      }

      info(`${pid}: 🛑 removed`);

      kitState.shortcutsPaused = false;
    }

    // TODO: Does this matter anymore?
    // if (kitState?.pid === pid) {
    //   kitState.scriptPath = '';
    //   kitState.promptId = '';
    //   kitState.promptCount = 0;
    // }

    if (this.find((i) => i.pid === pid)) {
      this.splice(index, 1);

      processesChanged();
    }
  }

  public removeCurrentProcess() {
    // TODO: Reimplement?
    // const info = this.find(
    //   (processInfo) =>
    //     processInfo.scriptPath === prompt.scriptPath &&
    //     processInfo.type === ProcessType.Prompt
    // );
    // if (info) {
    //   this.removeByPid(info.pid);
    // }
  }
}

export const processes = new Processes();
processes.startHeartbeat();
powerMonitor.addListener('resume', () => processes.startHeartbeat());
powerMonitor.addListener('unlock-screen', () => processes.startHeartbeat());
powerMonitor.addListener('suspend', () => processes.stopHeartbeat());
powerMonitor.addListener('lock-screen', () => processes.stopHeartbeat());

export const removeAbandonnedKit = () => {
  const kitProcess = processes.find((processInfo) => isKitScript(processInfo.scriptPath));

  if (kitProcess) {
    setTimeout(() => {
      info(`🛑 Cancel main menu process: ${kitProcess.scriptPath}`);
      processes.removeByPid(kitProcess.pid);
    }, 250);
  }
};

export const handleWidgetEvents = () => {
  const initHandler: WidgetHandler = (event, data) => {
    const { widgetId } = data;

    const w = widgetState.widgets.find(({ id }) => id === widgetId);
    if (!w) {
      return;
    }
    const { wid, moved, pid } = w;
    const widget = BrowserWindow.fromId(wid);
    const pInfo = processes.getByPid(pid) as ProcessInfo;
    if (!pInfo) {
      err(`No process found for widget ${widgetId}`);
      return;
    }
    if (!pInfo.child) {
      return;
    }

    if (moved) {
      w.moved = false;
      return;
    }

    info(`👋 ${widgetId} Initialized`);

    childSend(pInfo.child, {
      ...data,
      ...widget.getBounds(),
      pid: pInfo.child.pid,
      channel: Channel.WIDGET_INIT,
    });
  };

  const clickHandler: WidgetHandler = (event, data) => {
    const { widgetId } = data;

    const w = widgetState.widgets.find(({ id }) => id === widgetId);
    info(`🔎 click ${widgetId}`, {
      w,
      widgets: widgetState.widgets.map((w) => w.id),
    });
    if (!w) {
      return;
    }
    const { wid, moved, pid } = w;
    const widget = BrowserWindow.fromId(wid);
    const child = processes.getChildByPid(pid);
    if (!child) {
      return;
    }

    if (moved) {
      w.moved = false;
      return;
    }

    if (!widget) {
      return;
    }

    childSend(child, {
      ...data,
      ...widget.getBounds(),
      pid: child.pid,
      channel: Channel.WIDGET_CLICK,
    });
  };

  const dropHandler: WidgetHandler = (event, data) => {
    const { widgetId } = data;

    const w = widgetState.widgets.find(({ id }) => id === widgetId);
    if (!w) {
      return;
    }
    const { wid, pid } = w;
    const widget = BrowserWindow.fromId(wid);
    const child = processes.getChildByPid(pid);
    if (!child) {
      return;
    }

    info(`💧 drop ${widgetId}`);

    if (!widget) {
      return;
    }

    childSend(child, {
      ...data,
      ...widget.getBounds(),
      pid: child.pid,
      channel: Channel.WIDGET_DROP,
    });
  };

  const customHandler: WidgetHandler = (event, data) => {
    const { widgetId } = data;

    const w = widgetState.widgets.find(({ id }) => id === widgetId);
    if (!w) {
      return;
    }
    const { wid, pid } = w;
    const widget = BrowserWindow.fromId(wid);
    const child = processes.getChildByPid(pid);
    if (!child) {
      return;
    }

    info(`💧 custom ${widgetId}`);

    childSend(child, {
      ...data,
      ...widget.getBounds(),
      pid: child.pid,
      channel: Channel.WIDGET_CUSTOM,
    });
  };

  const mouseDownHandler: WidgetHandler = (event, data) => {
    const { widgetId } = data;

    const w = widgetState.widgets.find(({ id }) => id === widgetId);
    info(`🔽 mouseDown ${widgetId}`, { w });
    if (!w) {
      return;
    }
    const { wid, pid } = w;
    const widget = BrowserWindow.fromId(wid);
    if (!widget) {
      return;
    }
    const child = processes.getChildByPid(pid);
    if (!child) {
      return;
    }

    // if (moved) {
    //   w.moved = false;
    //   return;
    // }

    childSend(child, {
      ...data,
      ...widget.getBounds(),
      pid: child.pid,
      channel: Channel.WIDGET_MOUSE_DOWN,
    });
  };

  const mouseUpHandler: WidgetHandler = (event, data) => {
    const { widgetId } = data;
    info(`🔽 mouseUp ${widgetId}`);

    const w = widgetState.widgets.find(({ id }) => id === widgetId);
    if (!w) {
      return;
    }
    const { wid, pid } = w;
    const widget = BrowserWindow.fromId(wid);
    const child = processes.getChildByPid(pid);
    if (!child) {
      return;
    }

    // if (moved) {
    //   w.moved = false;
    //   return;
    // }

    if (!widget) {
      return;
    }

    childSend(child, {
      ...data,
      ...widget.getBounds(),
      pid: child.pid,
      channel: Channel.WIDGET_MOUSE_UP,
    });
  };

  const inputHandler: WidgetHandler = (event, data) => {
    const { widgetId } = data;
    const options = widgetState.widgets.find(({ id }) => id === widgetId);
    if (!options) {
      return;
    }
    const { pid, wid } = options;
    const widget = BrowserWindow.fromId(wid);
    const child = processes.getChildByPid(pid);
    if (!(child && widget)) {
      return;
    }

    childSend(child, {
      ...data,

      ...widget.getBounds(),
      widgetId,
      pid: child?.pid,
      channel: Channel.WIDGET_INPUT,
    });
  };

  const dragHandler: WidgetHandler = (event, data) => {
    const { widgetId } = data;
    info(`📦 ${data.widgetId} Widget: Dragging file`, data);
    const options = widgetState.widgets.find(({ id }) => id === widgetId);
    if (!options) {
      return;
    }
    const { pid, wid } = options;
    const widget = BrowserWindow.fromId(wid);
    const child = processes.getChildByPid(pid);
    if (!(child && widget)) {
      return;
    }

    try {
      event.sender.startDrag({
        file: data?.filePath as string,
        icon: data?.iconPath as string,
      });
    } catch (error) {
      err(error);
    }
  };

  const measureHandler: WidgetHandler = (event, data: any) => {
    const { widgetId } = data;
    info(`📏 ${widgetId} Widget: Fitting to inner child`);

    const options = (widgetState?.widgets || []).find(({ id }) => id === widgetId);
    if (!options) {
      return;
    }

    const { wid, ignoreMeasure, pid } = options;
    const widget = BrowserWindow.fromId(wid);
    const child = processes.getChildByPid(pid);
    if (!(child && widget) || ignoreMeasure) {
      return;
    }

    widget.setSize(data.width, data.height, true);
  };

  // These events are not being caught in the script...
  ipcMain.on(Channel.WIDGET_INIT, initHandler);
  ipcMain.on(Channel.WIDGET_CLICK, clickHandler);
  ipcMain.on(Channel.WIDGET_DROP, dropHandler);
  ipcMain.on(Channel.WIDGET_MOUSE_DOWN, mouseDownHandler);
  ipcMain.on(Channel.WIDGET_MOUSE_UP, mouseUpHandler);
  ipcMain.on(Channel.WIDGET_INPUT, inputHandler);
  ipcMain.on(Channel.WIDGET_DRAG_START, dragHandler);
  ipcMain.on(Channel.WIDGET_CUSTOM, customHandler);
  ipcMain.on(Channel.WIDGET_MEASURE, measureHandler);
};

emitter.on(KitEvent.KillProcess, (pid) => {
  info(`🛑 Kill Process: ${pid}`);
  processes.removeByPid(pid);
});

emitter.on(KitEvent.TermExited, (pid) => {
  info('🛑 Term Exited: SUBMITTING');
  const prompt = prompts.get(pid);
  if (prompt && prompt.ui === UI.term) {
    prompt.sendToPrompt(AppChannel.TERM_EXIT, '');
  }
});

export const destroyAllProcesses = () => {
  maininfo('Destroy all processes');
  processes.forEach((pinfo) => {
    if (!pinfo?.child.killed) {
      pinfo?.child?.removeAllListeners();
      pinfo?.child?.kill();
    }
  });
  processes.length = 0;
};

export const spawnShebang = async ({
  shebang,
  filePath,
}: {
  shebang: string;
  filePath: string;
}) => {
  const [command, ...args] = shebang.split(' ');
  const child = spawn(command, [...args, filePath]);
  processes.addExistingProcess(child, filePath);

  info(`🚀 Spawned process ${child.pid} for ${filePath} with command ${command}`);

  child.unref();

  if (child.stdout && child.stderr) {
    const scriptLog = getLog(filePath);
    child.stdout.removeAllListeners();
    child.stderr.removeAllListeners();

    const routeToScriptLog = (d: any) => {
      if (child?.killed) {
        return;
      }
      const result = d.toString();
      scriptinfo(`\n${stripAnsi(result)}`);
    };

    child.stdout?.on('data', routeToScriptLog);
    child.stdout?.on('error', routeToScriptLog);

    child.stderr?.on('data', routeToScriptLog);
    child.stderr?.on('error', routeToScriptLog);

    // Log out when the process exits
    child.on('exit', (code) => {
      scriptinfo(`\nProcess exited with code ${code}`);
      processes.removeByPid(child.pid);
    });
  }
};

emitter.on(KitEvent.RemoveMostRecent, processes.removeCurrentProcess.bind(processes));
// emitter.on(KitEvent.MainScript, () => {
//   sendToPrompt(Channel.SET_DESCRIPTION, 'Run Script');
//   const scripts = getScriptsSnapshot();
//   verbose({ scripts });
//   setChoices(formatScriptChoices(scripts));
// });

emitter.on(KitEvent.DID_FINISH_LOAD, async () => {
  try {
    if (kitState.isMac) {
      const authorized = shims['node-mac-permissions'].getAuthStatus('accessibility') === 'authorized';

      if (authorized) {
        kitStore.set('accessibilityAuthorized', authorized);
      }
    }

    // TODO: Why did I even do this? There has to be a simpler way now
    // togglePromptEnv('KIT_MAIN_SCRIPT');

    if (kitState.kenvEnv?.KIT_MEASURE) {
      // if (observer) observer.disconnect();
      // if (PerformanceObserver) {
      //   observer = new PerformanceObserver((list) => {
      //     const entries = list.getEntries();
      //     const entry = entries[0];
      //     info(`⌚️ [Perf] ${entry.name}: ${entry.duration}`);
      //   });
      //   observer.observe({ entryTypes: ['measure'] });
      // }
    }

    performance.mark('script');
  } catch (error) {
    warn('Error reading kenv env', error);
  }

  updateTheme();
});
