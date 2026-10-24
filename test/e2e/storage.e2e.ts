import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { copyFixture, snapshotTree } from '../helpers/tree';
import { removeTempDirs } from '../helpers/temp';
import { launchApp } from './launch';

// Step 8: back up, restore and export/import in the real app. The native dialogs cannot be driven from a test, so main's
// dialog functions are answered by the test, which proves the page only asks and main decides.

let userData: string;
let work: string;
test.beforeAll(() => {
  userData = mkdtempSync(join(tmpdir(), 'gdcc-e2e-storage-'));
  work = mkdtempSync(join(tmpdir(), 'gdcc-e2e-files-'));
});
test.afterAll(() => {
  rmSync(userData, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
  removeTempDirs();
});
test.describe.configure({ mode: 'serial' });

const answer = (app: ElectronApplication, name: 'showMessageBox' | 'showSaveDialog' | 'showOpenDialog', value: unknown): Promise<void> =>
  app.evaluate(
    ({ dialog }, { method, result }) => {
      (dialog as unknown as Record<string, unknown>)[method] = () => Promise.resolve(result);
    },
    { method: name, result: value },
  );

test('a backup taken now can be restored later: the app asks, saves the current data first, and restarts with the old data', async () => {
  const first = await launchApp(userData);
  try {
    await first.page.getByRole('button', { name: /^Settings/ }).click();
    const section = first.page.getByRole('region', { name: 'Data and backups' });
    await first.page.getByLabel('Interface density').selectOption('compact');
    await section.getByRole('button', { name: 'Back up now' }).click();
    await expect(section.getByRole('list', { name: 'Backups' }).getByText('Manual')).toBeVisible();

    await first.page.getByLabel('Interface density').selectOption('comfortable'); // the change the restore will undo
    await answer(first.app, 'showMessageBox', { response: 0, checkboxChecked: false });
    const closed = first.app.waitForEvent('close');
    await section.getByRole('button', { name: /^Restore the backup from/ }).click();
    await closed; // main quit the app so the restore can be applied at the next start
  } catch (error) {
    await first.app.close().catch(() => undefined);
    throw error;
  }

  expect(existsSync(join(userData, 'data', 'pending-restore.json'))).toBe(true);
  const second = await launchApp(userData);
  try {
    await second.page.getByRole('button', { name: /^Settings/ }).click();
    await expect(second.page.getByLabel('Interface density')).toHaveValue('compact');
    expect(existsSync(join(userData, 'data', 'pending-restore.json'))).toBe(false);
    const files = readdirSync(join(userData, 'data'));
    expect(files.some((name) => name.startsWith('gdcc.replaced-'))).toBe(true);
    const section = second.page.getByRole('region', { name: 'Data and backups' });
    await expect(section.getByRole('list', { name: 'Backups' }).getByText('Before a restore')).toBeVisible();
    await second.page.getByRole('button', { name: /^Activity/ }).click();
    await expect(second.page.getByText(/Restored the app data from/)).toBeVisible();
  } finally {
    await second.app.close();
  }
});

test('export, remove, import: the project comes back after the preview and the native confirmation, and its folder is never touched', async () => {
  const folder = copyFixture('godot-game');
  const before = snapshotTree(folder);
  const exportFile = join(work, 'export.json');
  const { app, page } = await launchApp(userData);
  try {
    await answer(app, 'showOpenDialog', { canceled: false, filePaths: [folder] });
    await page.getByRole('button', { name: 'Project switcher' }).click();
    await page.getByRole('menuitem', { name: 'Add a project…' }).click();
    await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();

    await page.getByRole('button', { name: /^Settings/ }).click();
    const section = page.getByRole('region', { name: 'Data and backups' });
    await answer(app, 'showSaveDialog', { canceled: false, filePath: exportFile });
    await section.getByRole('button', { name: 'Export data…' }).click();
    await expect(section.getByText(/^Saved \d+ rows\.$/)).toBeVisible();
    const file = JSON.parse(readFileSync(exportFile, 'utf8')) as { format: string; tables: Record<string, unknown[]> };
    expect(file.format).toBe('gdcc-export');
    expect(file.tables['projects']).toHaveLength(1);

    // Remove the project, then bring it back from the file.
    await page.getByRole('button', { name: /^Projects/ }).click();
    await page.getByRole('button', { name: 'Remove from the registry' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click();
    await expect(page.getByText(/No projects yet/)).toBeVisible();

    await page.getByRole('button', { name: /^Settings/ }).click();
    await answer(app, 'showOpenDialog', { canceled: false, filePaths: [exportFile] });
    await section.getByRole('button', { name: 'Choose a file to import…' }).click();
    const preview = section.getByRole('region', { name: 'Import preview' });
    await expect(preview).toContainText('export.json');
    await expect(preview.getByRole('row', { name: /^Projects/ })).toContainText('1');
    await expect(preview.getByRole('listitem').filter({ hasText: folder })).toBeVisible();

    await answer(app, 'showMessageBox', { response: 0, checkboxChecked: false });
    await preview.getByRole('button', { name: 'Import' }).click();
    await expect(section.getByText(/^Imported:/)).toBeVisible();
    await section.getByRole('button', { name: 'Reload the app data' }).click();

    await page.getByRole('button', { name: /^Projects/ }).click();
    await expect(page.getByRole('region', { name: 'Details of godot-game' })).toBeVisible();
    expect(snapshotTree(folder)).toEqual(before);
  } finally {
    await app.close();
  }
});

test('a hostile file is refused with a message and nothing changes', async () => {
  const bad = join(work, 'bad.json');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(bad, JSON.stringify({ format: 'gdcc-export', formatVersion: 1, appVersion: '9', schemaVersion: 3, exportedAt: '2026-10-24T00:00:00.000Z', tables: { projects: [{ id: 'x', name: 'Evil', root_path: 'C:\\Windows' }] } }));
  const { app, page } = await launchApp(userData);
  try {
    await page.getByRole('button', { name: /^Settings/ }).click();
    const section = page.getByRole('region', { name: 'Data and backups' });
    await answer(app, 'showOpenDialog', { canceled: false, filePaths: [bad] });
    await section.getByRole('button', { name: 'Choose a file to import…' }).click();
    await expect(section.getByRole('alert')).toContainText('nothing can be imported');
    await expect(section.getByRole('region', { name: 'Import preview' })).toHaveCount(0);
  } finally {
    await app.close();
  }
});
