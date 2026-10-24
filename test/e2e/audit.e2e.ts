import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { copyFixture, snapshotTree } from '../helpers/tree';
import { removeTempDirs } from '../helpers/temp';
import { launchApp } from './launch';

// Step 7: audit a registered fixture project in the real app, see Confirmed and Inferred findings and the Git state, and
// check the project folder is unchanged and the stored audit survives a restart.

let userData: string;
test.beforeAll(() => {
  userData = mkdtempSync(join(tmpdir(), 'gdcc-e2e-audit-'));
});
test.afterAll(() => {
  rmSync(userData, { recursive: true, force: true });
  removeTempDirs();
});
test.describe.configure({ mode: 'serial' });

const pickNext = (app: ElectronApplication, folder: string): Promise<void> =>
  app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [chosen] });
  }, folder);

let folder: string;
let before: Record<string, string>;

test('audits a project without Git: confirmed and inferred findings, "Not a Git repository.", folder untouched', async () => {
  folder = copyFixture('audit-godot');
  writeFileSync(join(folder, '.env'), 'API_KEY=sk-ant-api03-NeverShownAnywhere0123456789');
  before = snapshotTree(folder);
  const { app, page } = await launchApp(userData);
  try {
    await pickNext(app, folder);
    await page.getByRole('button', { name: 'Project switcher' }).click();
    await page.getByRole('menuitem', { name: 'Add a project…' }).click();
    const panel = page.getByRole('region', { name: 'Audit of audit-godot' });
    await expect(panel).toContainText('This project has not been audited yet.');
    await panel.getByRole('button', { name: 'Run an audit' }).click();
    await expect(panel.getByRole('status')).toContainText('Audited');
    await expect(panel.getByText('Confirmed').first()).toBeVisible();
    await expect(panel.getByText('Inferred').first()).toBeVisible();

    await panel.getByText(/Engine and version/).click();
    await expect(panel).toContainText('Godot project, engine 4.3');
    await panel.getByText(/Git/).first().click();
    await expect(panel).toContainText('Not a Git repository.');
    await panel.getByText(/Risks and missing information/).click();
    await expect(panel).toContainText('Files that may hold credentials');
    await expect(page.locator('body')).not.toContainText('NeverShownAnywhere');

    expect(snapshotTree(folder)).toEqual(before);
  } finally {
    await app.close();
  }
});

test('the stored audit is still there after a restart, and running again keeps the earlier one', async () => {
  const { app, page } = await launchApp(userData);
  try {
    await page.getByRole('button', { name: /^Projects/ }).click();
    const panel = page.getByRole('region', { name: 'Audit of audit-godot' });
    await expect(panel.getByRole('status')).toContainText('Audited');
    await panel.getByRole('button', { name: 'Run the audit again' }).click();
    await expect(panel.getByLabel('Earlier audits')).toBeVisible();
    expect(await panel.getByLabel('Earlier audits').locator('option').count()).toBe(2);
    expect(snapshotTree(folder)).toEqual(before);
  } finally {
    await app.close();
  }
});

test('the Git page and dashboard card read a real repository (branch, changes, commits) and change nothing in it', async () => {
  let hasGit = true;
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
  } catch {
    hasGit = false;
  }
  test.skip(!hasGit, 'Git is not installed on this machine');

  const git = (...args: string[]): void => {
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: folder, stdio: 'ignore' });
  };
  git('init', '-q', '-b', 'main');
  git('add', '-A', ':!.env');
  git('commit', '-q', '-m', 'Start the sample game');
  writeFileSync(join(folder, 'notes.txt'), 'a new file');
  const repoBefore = snapshotTree(folder);

  const { app, page } = await launchApp(userData);
  try {
    await page.getByRole('button', { name: /^Git and Changes/ }).click();
    const card = page.getByRole('region', { name: 'Git status of audit-godot' });
    await expect(card).toContainText('main');
    await expect(card).toContainText('2 untracked');
    await expect(card).toContainText('Start the sample game');

    await page.getByRole('button', { name: 'Dashboard' }).click();
    await expect(page.getByRole('region', { name: 'Recent changes' })).toContainText('Start the sample game');
    expect(snapshotTree(folder)).toEqual(repoBefore);
  } finally {
    await app.close();
  }
});
