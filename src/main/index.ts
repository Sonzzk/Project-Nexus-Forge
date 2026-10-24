import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';
import { registerAppScheme, rendererRootFor, serveRenderer } from './app/protocol';
import { createMainWindow, installSecurityGuards } from './app/window';

// All of this must happen before `ready`.
app.enableSandbox();
registerAppScheme();
// The data folder never depends on the display name (D-024). Dev and test runs may redirect it; packaged builds may not.
const dataDirOverride = app.isPackaged ? undefined : process.env['GDCC_USER_DATA_DIR'];
app.setPath('userData', dataDirOverride ?? join(app.getPath('appData'), 'GameDevCommandCenter'));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [window] = BrowserWindow.getAllWindows();
    if (window === undefined) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  void app.whenReady().then(() => {
    installSecurityGuards();
    serveRenderer(rendererRootFor(__dirname));
    createMainWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });

  app.on('window-all-closed', () => app.quit());
}
