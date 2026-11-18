import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { removeTempDirs } from '../helpers/temp';
import { copyFixture, snapshotTree } from '../helpers/tree';
import { launchApp } from './launch';

// Step 20 in the real app, on a copy of the fixture project (never a real project). No Godot is installed or started: the "download"
// is a folder of files that are not programs, so every launch fails at once. That is the point: the project is read from files, the
// commands are exactly the ones its presets and test folder allow, each needs an approval window that shows the arguments, a failing
// start is reported and its record is kept, and the project folder is unchanged. A live Godot run is not part of this test.

let userData: string;
let project: string;
let download: string;
let home: string;
const saved: Record<string, string | undefined> = {};

test.beforeAll(() => {
  userData = mkdtempSync(join(tmpdir(), 'gdcc-e2e-godot-'));
  download = mkdtempSync(join(tmpdir(), 'gdcc-e2e-godot-dl-'));
  project = copyFixture('godot-project');
  home = mkdtempSync(join(tmpdir(), 'gdcc-e2e-godot-home-'));
  // Discovery looks in the home folder, Program Files and LOCALAPPDATA; point them at empty folders so a Godot on this PC is never touched.
  for (const key of ['USERPROFILE', 'LOCALAPPDATA', 'ProgramFiles']) {
    saved[key] = process.env[key];
    process.env[key] = home;
  }
  writeFileSync(join(download, 'Godot_v4.3-stable_win64.exe'), 'this is not a program');
  writeFileSync(join(download, 'Godot_v4.3-stable_win64_console.exe'), 'this is not a program');
});
test.afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
  for (const dir of [userData, download, home]) rmSync(dir, { recursive: true, force: true });
  removeTempDirs();
});
test.describe.configure({ mode: 'serial' });

const invoke = (page: Page, channel: string, input: unknown): Promise<unknown> =>
  page.evaluate(async ([c, i]) => {
    const result = await window.api.invoke(c as 'settings:set', i as never);
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  }, [channel, input] as const);

/** The folder window answers with whatever `next` holds; confirmation windows answer yes and keep their text. */
const stubWindows = (app: ElectronApplication): Promise<void> =>
  app.evaluate(({ dialog }) => {
    const g = globalThis as unknown as { next: string; windows: string[] };
    g.windows = [];
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [g.next] });
    (dialog as unknown as Record<string, unknown>)['showMessageBox'] = (...args: unknown[]) => {
      const box = args.find((a) => typeof a === 'object' && a !== null && 'message' in a) as { title: string; message: string; detail?: string };
      g.windows.push(`${box.title}\n${box.message}\n${box.detail ?? ''}`);
      return Promise.resolve({ response: 0, checkboxChecked: false });
    };
  });
const answerFolder = (app: ElectronApplication, path: string): Promise<void> => app.evaluate((_, p) => void ((globalThis as unknown as { next: string }).next = p), path);
const windows = (app: ElectronApplication): Promise<string[]> => app.evaluate(() => (globalThis as unknown as { windows: string[] }).windows);

test('reads the Godot project, offers only the commands its files allow, and reports a start that fails', async () => {
  const before = snapshotTree(project);
  const { app, page } = await launchApp(userData);
  try {
    await stubWindows(app);
    await answerFolder(app, project);
    const { project: added } = (await invoke(page, 'projects:pickAndAdd', {})) as { project: { id: string } };
    await invoke(page, 'settings:set', { key: 'projects.selectedId', value: added.id });
    await page.reload();
    await page.getByRole('navigation', { name: 'Main' }).waitFor();
    await page.getByRole('button', { name: /^Integrations/ }).click();
    const card = page.getByRole('region', { name: 'Godot', exact: true }).first();
    await expect(card.getByText(/No Godot download was found/)).toBeVisible();

    // the page can only name a project, never a path or a program
    const refused = await page.evaluate(async () => {
      const result = await window.api.invoke('godot:open' as 'settings:get', { projectId: 'x', target: 'project', path: 'C:\\Windows' } as never);
      return result.ok ? 'accepted' : result.error.code;
    });
    expect(refused).toBe('INVALID_INPUT');

    await answerFolder(app, download);
    await card.getByRole('button', { name: 'Add a Godot folder…' }).click();
    await expect(card.getByRole('table', { name: 'Godot downloads' })).toContainText('4.3');
    await expect(card.getByRole('table', { name: 'Godot downloads' })).toContainText('Added by you');
    const facts = card.getByLabel('Godot project Hall Runner');
    await expect(facts).toContainText('Godot 4.3, Forward Plus');
    await expect(facts).toContainText('Player');
    await expect(facts).toContainText('GUT in test');
    const presets = card.getByRole('table', { name: 'Export presets' });
    await expect(presets).toContainText('builds/game.exe');
    await expect(presets).toContainText('leaves the project folder');
    await expect(presets).toContainText('does not exist');
    const commands = card.getByRole('list', { name: 'Godot commands' });
    await expect(commands.getByRole('listitem')).toHaveText([/import resources/, /export Windows Desktop \(release\)/, /export Windows Desktop \(debug\)/, /run GUT tests/]);

    // an editor that cannot start is reported, and nothing is shown as running
    await card.getByRole('button', { name: 'Start the Godot editor…' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'did not stay open' })).toBeVisible({ timeout: 20_000 });
    await expect(card.getByRole('button', { name: 'Stop the Godot editor' })).toHaveCount(0);
    expect((await windows(app)).at(-1)).toContain('--editor --path');

    // approve and run the import command: it needs its own window, shows the exact arguments, and the failed start is kept
    await page.getByRole('button', { name: /^AI Workbench/ }).click();
    const row = page.getByRole('list', { name: 'Project commands' }).locator('li', { hasText: 'Godot: import resources (headless)' });
    await expect(row).toContainText('engine command');
    await row.getByRole('button', { name: 'Approve Godot: import resources (headless)' }).click();
    const asked = (await windows(app)).at(-1) ?? '';
    expect(asked).toContain('--headless --path');
    expect(asked).toContain('--import');
    await row.getByRole('button', { name: 'Run Godot: import resources (headless)' }).click();
    await page.getByRole('button', { name: /^Integrations/ }).click();
    const logs = page.getByRole('region', { name: 'Godot', exact: true }).first().getByRole('list', { name: 'Godot command logs' });
    await expect(logs).toContainText('Godot: import resources (headless)', { timeout: 30_000 });
    await expect(logs).toContainText('spawn-failed');
  } finally {
    await app.close();
  }
  expect(snapshotTree(project)).toEqual(before); // reading, describing and the failed launches changed nothing in the project
});
