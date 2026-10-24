import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow, session } from 'electron';
import { APP_ORIGIN, isAllowedUrl } from './navigation';

const ICON_PATH = join(app.getAppPath(), 'assets/icon/nexus-ai.ico');

/** Dev server URL set by electron-vite while developing; undefined in a built app. */
const devServerUrl = app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL'] || undefined;

/** Denies permission prompts, new windows, webviews and navigation away from our pages, for every window. */
export function installSecurityGuards(): void {
  const { defaultSession } = session;
  defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  defaultSession.setPermissionCheckHandler(() => false);

  app.on('web-contents-created', (_event, contents) => {
    const block = (event: { preventDefault(): void }, url: string): void => {
      if (!isAllowedUrl(url, devServerUrl)) event.preventDefault();
    };
    contents.on('will-navigate', (event, url) => block(event, url));
    contents.on('will-redirect', (event, url) => block(event, url));
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  });
}

export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1280,
    minHeight: 720,
    show: false,
    backgroundColor: '#0f1115',
    title: 'GameDev Command Center',
    ...(existsSync(ICON_PATH) ? { icon: ICON_PATH } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });

  window.once('ready-to-show', () => window.show());
  void window.loadURL(devServerUrl ?? `${APP_ORIGIN}/index.html`);
  return window;
}
