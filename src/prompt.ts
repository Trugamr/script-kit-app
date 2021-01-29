/* eslint-disable import/prefer-default-export */
import { BrowserWindow, screen, nativeTheme } from 'electron';
import log from 'electron-log';
import { getAssetPath } from './assets';

let promptWindow: BrowserWindow | null = null;

export const createPromptWindow = async () => {
  promptWindow = new BrowserWindow({
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    show: false,
    hasShadow: false,
    icon: getAssetPath('icon.png'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    alwaysOnTop: true,
    closable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    movable: false,
  });

  promptWindow.setAlwaysOnTop(true, 'floating', 1);
  promptWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  promptWindow.loadURL(`file://${__dirname}/index.html`);

  promptWindow.webContents.once('did-finish-load', () => {
    promptWindow?.webContents.closeDevTools();
  });

  promptWindow?.setMaxListeners(2);

  promptWindow?.webContents.on('before-input-event', (event: any, input) => {
    if (input.key === 'Escape') {
      promptWindow?.webContents.send('escape', {});
      // eslint-disable-next-line @typescript-eslint/no-use-before-define
      hidePromptWindow();
    }
  });
};

export const focusPrompt = () => {
  if (promptWindow && !promptWindow.isDestroyed()) {
    promptWindow?.focus();
  }
};

export const invokePromptWindow = (channel: string, data: any) => {
  if (promptWindow && !promptWindow.isDestroyed()) {
    promptWindow?.webContents.send(channel, data);
  }

  if (promptWindow && !promptWindow?.isVisible()) {
    // console.log(`>>> MOVING PROMPT <<<`);
    const cursor = screen.getCursorScreenPoint();
    // Get display with cursor
    const distScreen = screen.getDisplayNearestPoint({
      x: cursor.x,
      y: cursor.y,
    });

    const { scaleFactor } = distScreen;
    const {
      width: screenWidth,
      height: screenHeight,
    } = distScreen.workAreaSize;

    const ratio = screenWidth / screenHeight;
    const height = Math.floor(screenHeight / 3);
    const width = Math.floor(height * (4 / 3));
    const x = Math.floor(screenWidth); // * distScreen.scaleFactor
    const { y } = distScreen.workArea;
    console.log({ screenWidth, screenHeight, width, height, x, y });
    promptWindow?.setBounds({ x, y, width, height });

    promptWindow?.show();
    promptWindow?.focus();
  }

  return promptWindow;
};

export const hidePromptWindow = () => {
  if (promptWindow && promptWindow?.isVisible()) {
    log.info(`Hiding prompt`);

    promptWindow?.hide();
  }
};
