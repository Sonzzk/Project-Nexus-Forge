import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { copyFixture, snapshotTree } from '../helpers/tree';
import { removeTempDirs } from '../helpers/temp';
import { launchApp } from './launch';

// Step 6: register a real folder through the (stubbed) native picker, see it detected, override and remove it, and
// check the folder itself is byte-for-byte unchanged and the registry survives a restart.

let userData: string;
test.beforeAll(() => {
  userData = mkdtempSync(join(tmpdir(), 'gdcc-e2e-projects-'));
});
test.afterAll(() => {
  rmSync(userData, { recursive: true, force: true });
  removeTempDirs();
});
test.describe.configure({ mode: 'serial' });

/** The native folder dialog cannot be driven from a test, so main's `dialog.showOpenDialog` answers with `folder`. */
const pickNext = (app: ElectronApplication, folder: string): Promise<void> =>
  app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [chosen] });
  }, folder);

let godotFolder: string;
let before: Record<string, string>;

test('adds a folder through the picker: type detected from its files, folder untouched', async () => {
  godotFolder = copyFixture('godot-game');
  before = snapshotTree(godotFolder);
  const { app, page } = await launchApp(userData);
  try {
    await pickNext(app, godotFolder);
    await page.getByRole('button', { name: 'Project switcher' }).click();
    await page.getByRole('menuitem', { name: 'Add a project…' }).click();
    await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
    const detail = page.getByRole('region', { name: 'Details of godot-game' });
    await expect(detail).toContainText('Godot 4.3');
    await expect(detail).toContainText('confirmed from files');
    await expect(page.getByRole('button', { name: 'Project switcher' })).toContainText('godot-game');

    // Adding the same folder again is refused with an explanation.
    await pickNext(app, godotFolder);
    await page.getByRole('button', { name: 'Add a project…' }).click();
    await expect(page.getByRole('alert')).toContainText('already registered as "godot-game"');
    expect(snapshotTree(godotFolder)).toEqual(before);
  } finally {
    await app.close();
  }
});

test('the project, its selection and an override survive a restart', async () => {
  const first = await launchApp(userData);
  try {
    await first.page.getByRole('button', { name: /^Projects/ }).click();
    const detail = first.page.getByRole('region', { name: 'Details of godot-game' });
    await detail.getByLabel('Project type').selectOption('custom');
    await detail.getByLabel(/Tags/).fill('prototype, horror');
    await detail.getByRole('button', { name: 'Save changes' }).click();
    await expect(detail.getByText('Saved.')).toBeVisible();
  } finally {
    await first.app.close();
  }

  const second = await launchApp(userData);
  try {
    await expect(second.page.getByRole('button', { name: 'Project switcher' })).toContainText('godot-game');
    await second.page.getByRole('button', { name: /^Projects/ }).click();
    const detail = second.page.getByRole('region', { name: 'Details of godot-game' });
    await expect(detail).toContainText('Custom or unidentified');
    await expect(detail).toContainText('set by you');
    await expect(detail.getByLabel(/Tags/)).toHaveValue('prototype, horror');
    // The detection result is still there to go back to.
    await detail.getByLabel('Project type').selectOption({ label: 'Detected from files (Godot)' });
    await detail.getByRole('button', { name: 'Save changes' }).click();
    await expect(detail).toContainText('Godot 4.3');
  } finally {
    await second.app.close();
  }
});

test('removing a project forgets it and leaves its folder exactly as it was', async () => {
  const { app, page } = await launchApp(userData);
  try {
    await page.getByRole('button', { name: /^Projects/ }).click();
    await page.getByRole('button', { name: 'Remove from the registry' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click();
    await expect(page.getByText(/No projects yet/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Project switcher' })).toContainText('No project selected');
    expect(snapshotTree(godotFolder)).toEqual(before);
  } finally {
    await app.close();
  }
});
