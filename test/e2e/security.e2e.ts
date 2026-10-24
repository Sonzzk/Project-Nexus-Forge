import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

let userData: string;
let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'gdcc-e2e-'));
  app = await electron.launch({
    args: ['.'],
    env: { ...process.env, GDCC_USER_DATA_DIR: userData },
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app.close();
  rmSync(userData, { recursive: true, force: true });
});

test('window runs with the secure web preferences', async () => {
  const prefs = await app.evaluate(({ BrowserWindow }) => {
    const [window] = BrowserWindow.getAllWindows();
    // Present at runtime, missing from Electron's type definitions.
    const contents = window?.webContents as unknown as
      { getLastWebPreferences(): Record<string, unknown> } | undefined;
    return contents?.getLastWebPreferences();
  });
  expect(prefs).toMatchObject({
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
  });
});

test('renderer is served from app://renderer and has no Node access', async () => {
  expect(page.url()).toMatch(/^app:\/\/renderer\//);
  expect(await page.title()).toBe('GameDev Command Center');
  const globals = await page.evaluate(() => ({
    require: typeof (globalThis as { require?: unknown }).require,
    process: typeof (globalThis as { process?: unknown }).process,
    module: typeof (globalThis as { module?: unknown }).module,
    buffer: typeof (globalThis as { Buffer?: unknown }).Buffer,
  }));
  expect(globals).toEqual({
    require: 'undefined',
    process: 'undefined',
    module: 'undefined',
    buffer: 'undefined',
  });
});

test('preload exposes an empty frozen window.api', async () => {
  const api = await page.evaluate(() => ({
    keys: Object.keys(window.api),
    frozen: Object.isFrozen(window.api),
  }));
  expect(api.keys).toEqual([]);
  expect(api.frozen).toBe(true);
});

test('content security policy is set by header and by meta tag, and blocks inline scripts', async () => {
  const header = await page.evaluate(async () =>
    (await fetch(location.href)).headers.get('content-security-policy'),
  );
  expect(header).toContain("default-src 'none'");
  expect(header).toContain("script-src 'self'");
  expect(header).not.toContain('unsafe');

  const meta = await page.evaluate(
    () =>
      document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? null,
  );
  expect(meta).toContain("script-src 'self'");

  const injectedRan = await page.evaluate(() => {
    const script = document.createElement('script');
    script.textContent = 'window.__injected = true;';
    document.head.append(script);
    return (window as { __injected?: boolean }).__injected === true;
  });
  expect(injectedRan).toBe(false);
});

test('navigation away from the app and new windows are blocked', async () => {
  const before = page.url();
  await page.evaluate(() => {
    window.location.assign('https://example.com/');
  });
  await page.waitForTimeout(500);
  expect(page.url()).toBe(before);

  const opened = await page.evaluate(() => window.open('https://example.com/') !== null);
  expect(opened).toBe(false);
  await page.waitForTimeout(300);
  expect(app.windows()).toHaveLength(1);
});

test('path traversal and missing files under app://renderer answer 404', async () => {
  const answers = await page.evaluate(async () => {
    const urls = [
      'app://renderer/%2e%2e/%2e%2e/package.json',
      'app://renderer/%2e%2e%5cpackage.json',
      'app://renderer/nope.js',
    ];
    return Promise.all(
      urls.map(async (url) => {
        const response = await fetch(url);
        return { status: response.status, body: await response.text() };
      }),
    );
  });
  for (const answer of answers) {
    expect(answer.status).toBe(404);
    expect(answer.body).not.toContain('gamedev-command-center');
  }
});
