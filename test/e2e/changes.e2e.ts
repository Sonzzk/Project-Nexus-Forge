import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { snapshotTree } from '../helpers/tree';
import { removeTempDirs } from '../helpers/temp';
import { launchApp } from './launch';

// Step 16 in the real app, on a throwaway Git project (never a real one): the Git page lists branches, saves a checkpoint without
// touching any file, and adds and removes a separate working tree only through native windows. Reviewing an agent's changes needs a
// writing run, which would need a provider, so that path is covered by the integration tests on real repositories instead.

let userData: string;
let project: string;
const git = (...args: string[]): string => execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: project, encoding: 'utf8' });

test.beforeAll(() => {
  userData = mkdtempSync(join(tmpdir(), 'gdcc-e2e-changes-'));
  project = mkdtempSync(join(tmpdir(), 'gdcc-e2e-changes-project-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 't@example.com');
  git('config', 'core.autocrlf', 'false');
  mkdirSync(join(project, 'src'));
  writeFileSync(join(project, 'src', 'index.js'), 'console.log(1);\n');
  writeFileSync(join(project, 'level.umap'), Buffer.alloc(2 * 1024 * 1024, 7));
  git('add', '.');
  git('commit', '-q', '-m', 'Start');
  git('branch', 'feature');
});
test.afterAll(() => {
  rmSync(userData, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
  removeTempDirs();
});
test.describe.configure({ mode: 'serial' });

const invoke = (page: Page, channel: string, input: unknown): Promise<unknown> =>
  page.evaluate(async ([c, i]) => {
    const result = await window.api.invoke(c as 'settings:set', i as never);
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  }, [channel, input] as const);

const answerWindows = (app: ElectronApplication, answer: boolean): Promise<void> =>
  app.evaluate(({ dialog }, yes) => {
    const seen: string[] = [];
    (globalThis as unknown as { windows: string[] }).windows = seen;
    (dialog as unknown as Record<string, unknown>)['showMessageBox'] = (...args: unknown[]) => {
      const box = args.find((a) => typeof a === 'object' && a !== null && 'message' in a) as { title: string; message: string; detail?: string };
      seen.push(`${box.title}\n${box.message}\n${box.detail ?? ''}`);
      return Promise.resolve({ response: yes ? 0 : 1, checkboxChecked: false });
    };
  }, answer);
const windows = (app: ElectronApplication): Promise<string[]> => app.evaluate(() => (globalThis as unknown as { windows: string[] }).windows);

test('the Git page lists branches, saves a checkpoint without changing any file, and warns about binary assets', async () => {
  const { app, page } = await launchApp(userData);
  try {
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] });
    }, project);
    const { project: added } = (await invoke(page, 'projects:pickAndAdd', {})) as { project: { id: string } };
    await invoke(page, 'settings:set', { key: 'projects.selectedId', value: added.id });
    await page.reload();
    await page.getByRole('navigation', { name: 'Main' }).waitFor();
    await page.getByRole('button', { name: /^Git and Changes/ }).click();

    await expect(page.getByRole('region', { name: 'Agent changes' })).toContainText('No agent has changed files in this project yet.');
    const tools = page.getByRole('region', { name: 'Branches, checkpoints and working trees' });
    const branches = tools.getByRole('list', { name: 'Branches' });
    await expect(branches).toContainText('main');
    await expect(branches).toContainText('feature');
    await expect(tools.getByLabel('What Git protects')).toContainText('tracked files only');
    await expect(tools.getByLabel('What Git protects')).toContainText('without Git LFS'); // the .umap asset

    const before = snapshotTree(project, { skip: ['.git'] });
    await tools.getByLabel('Save a checkpoint').fill('before-the-big-change');
    await tools.getByRole('button', { name: 'Save checkpoint' }).click();
    await expect(tools.getByRole('list', { name: 'Checkpoints' })).toContainText('before-the-big-change');
    expect(git('rev-parse', 'refs/gdcc/checkpoints/before-the-big-change').trim()).toMatch(/^[0-9a-f]{40}$/);
    expect(snapshotTree(project, { skip: ['.git'] })).toEqual(before);
    expect(git('status', '--porcelain')).toBe('');
  } finally {
    await app.close();
  }
});

test('a working tree is added and removed only through windows, outside the project folder, and the branch stays', async () => {
  const { app, page } = await launchApp(userData);
  try {
    await page.getByRole('button', { name: /^Git and Changes/ }).click();
    const tools = page.getByRole('region', { name: 'Branches, checkpoints and working trees' });
    await expect(tools.getByRole('list', { name: 'Checkpoints' })).toContainText('before-the-big-change'); // survived the restart

    await answerWindows(app, false);
    await tools.getByLabel('New working tree').fill('dash-move');
    await tools.getByRole('button', { name: 'Add working tree…' }).click();
    await expect.poll(async () => (await windows(app)).length).toBe(1);
    expect((await windows(app))[0]).toContain('cannot touch your project folder');
    await expect(tools.getByRole('list', { name: 'Working trees' })).toHaveCount(0);
    expect(existsSync(join(userData, 'worktrees'))).toBe(false);

    await answerWindows(app, true);
    await tools.getByRole('button', { name: 'Add working tree…' }).click();
    const trees = tools.getByRole('list', { name: 'Working trees' });
    await expect(trees).toContainText('dash-move');
    await expect(trees).toContainText('gdcc/dash-move');
    expect(readdirSync(join(userData, 'worktrees'))).toHaveLength(1);
    expect(git('status', '--porcelain')).toBe('');
    expect(existsSync(join(project, 'dash-move'))).toBe(false);

    await trees.getByRole('button', { name: 'Remove the working tree dash-move' }).click();
    await expect(tools.getByRole('list', { name: 'Working trees' })).toHaveCount(0);
    expect(readdirSync(join(userData, 'worktrees'))).toHaveLength(0);
    expect(git('branch', '--list', 'gdcc/dash-move')).toContain('gdcc/dash-move');
  } finally {
    await app.close();
  }
});
