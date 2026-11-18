import { createConnection } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { removeTempDirs } from '../helpers/temp';
import { copyFixture, snapshotTree } from '../helpers/tree';
import { launchApp } from './launch';

// Step 21 in the real app, on a copy of a throwaway project (never a real one). The "dev server" is a small Node script that prints the
// same "Local:" line Vite prints, started through the real npm: the script is listed from package.json, approved in a native window,
// started as a process the app owns, its port is read from its own output, it answers on that port, and stopping it from the page
// closes the port. A script that package.json does not list is refused. No Vite is installed and nothing is installed or downloaded.

let userData: string;
let project: string;

test.beforeAll(() => {
  userData = mkdtempSync(join(tmpdir(), 'gdcc-e2e-web-'));
  project = copyFixture('vite-runnable');
});
test.afterAll(() => {
  rmSync(userData, { recursive: true, force: true });
  removeTempDirs();
});
test.describe.configure({ mode: 'serial' });

const invoke = (page: Page, channel: string, input: unknown): Promise<unknown> =>
  page.evaluate(async ([c, i]) => {
    const result = await window.api.invoke(c as 'settings:set', i as never);
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  }, [channel, input] as const);

const stubWindows = (app: ElectronApplication, folder: string): Promise<void> =>
  app.evaluate(({ dialog }, path) => {
    const g = globalThis as unknown as { windows: string[] };
    g.windows = [];
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] });
    (dialog as unknown as Record<string, unknown>)['showMessageBox'] = (...args: unknown[]) => {
      const box = args.find((a) => typeof a === 'object' && a !== null && 'message' in a) as { title: string; message: string; detail?: string };
      g.windows.push(`${box.title}\n${box.message}\n${box.detail ?? ''}`);
      return Promise.resolve({ response: 0, checkboxChecked: false });
    };
  }, folder);
const windows = (app: ElectronApplication): Promise<string[]> => app.evaluate(() => (globalThis as unknown as { windows: string[] }).windows);
const portOpen = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = createConnection({ port, host: '127.0.0.1' }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
  });

test('lists the scripts, starts an approved server the app owns, reads its port, and stops it so the port closes', async () => {
  const before = snapshotTree(project);
  const { app, page } = await launchApp(userData);
  try {
    await stubWindows(app, project);
    const { project: added } = (await invoke(page, 'projects:pickAndAdd', {})) as { project: { id: string } };
    await invoke(page, 'settings:set', { key: 'projects.selectedId', value: added.id });
    await page.reload();
    await page.getByRole('navigation', { name: 'Main' }).waitFor();
    await page.getByRole('button', { name: /^Integrations/ }).click();
    const card = page.getByRole('region', { name: 'Web and Vite' }).first();
    const facts = card.getByLabel('Web project vite-runnable');
    await expect(facts).toContainText('npm (from package-lock.json)');
    const scripts = card.getByRole('table', { name: 'Scripts' });
    await expect(scripts).toContainText('npm run dev');
    await expect(scripts).toContainText('npm run lint');
    await expect(scripts).toContainText('npm run crash');
    await expect(scripts.getByRole('button', { name: 'Start npm run dev' })).toHaveCount(0); // not approved yet

    // only a script that package.json lists can be started
    const refused = await page.evaluate(async (id) => {
      const result = await window.api.invoke('web:startServer', { projectId: id, label: 'npm run nope' });
      return result.ok ? 'accepted' : result.error.code;
    }, added.id);
    expect(refused).toBe('NOT_FOUND');
    const notApproved = await page.evaluate(async (id) => {
      const result = await window.api.invoke('web:startServer', { projectId: id, label: 'npm run dev' });
      return result.ok ? 'accepted' : result.error.code;
    }, added.id);
    expect(notApproved).toBe('PERMISSION_REQUIRED');

    await scripts.getByRole('button', { name: 'Approve npm run dev' }).click();
    expect((await windows(app)).at(-1)).toContain('dev-server.mjs');
    await scripts.getByRole('button', { name: 'Start npm run dev' }).click();
    const servers = card.getByRole('list', { name: 'Servers' });
    await expect(servers).toContainText('running');
    await expect(servers).toContainText(/port \d+/, { timeout: 30_000 });
    const port = Number(/port (\d+)/.exec((await servers.textContent()) ?? '')?.[1]);
    expect(port).toBeGreaterThan(0);
    expect(await portOpen(port)).toBe(true);

    // the page lists it as an owned process, and a second start of the same script is refused
    const again = await page.evaluate(async (id) => {
      const result = await window.api.invoke('web:startServer', { projectId: id, label: 'npm run dev' });
      return result.ok ? 'accepted' : result.error.code;
    }, added.id);
    expect(again).toBe('CONFLICT');

    await servers.getByRole('button', { name: 'Stop npm run dev' }).click();
    await expect(servers).toContainText('stopped');
    await expect.poll(() => portOpen(port), { timeout: 15_000 }).toBe(false);

    // a script that runs to completion cannot start as a server; it runs from Permissions with its output kept
    const notServer = await page.evaluate(async (id) => {
      const result = await window.api.invoke('web:startServer', { projectId: id, label: 'npm run lint' });
      return result.ok ? 'accepted' : result.error.code;
    }, added.id);
    expect(notServer).toBe('INVALID_INPUT');
  } finally {
    await app.close();
  }
  expect(snapshotTree(project)).toEqual(before); // listing, starting and stopping the server changed nothing in the project
});

test('a server that is still running when the app quits is ended with the app', async () => {
  const { app, page } = await launchApp(userData);
  let port = 0;
  try {
    await page.getByRole('button', { name: /^Integrations/ }).click();
    const card = page.getByRole('region', { name: 'Web and Vite' }).first();
    await card.getByRole('button', { name: 'Start npm run dev' }).click(); // approved in the first test and kept in the app's data
    const servers = card.getByRole('list', { name: 'Servers' });
    await expect(servers).toContainText(/port \d+/, { timeout: 30_000 });
    port = Number(/port (\d+)/.exec((await servers.textContent()) ?? '')?.[1]);
    expect(await portOpen(port)).toBe(true);
  } finally {
    await app.close();
  }
  await expect.poll(() => portOpen(port), { timeout: 20_000 }).toBe(false);
});
