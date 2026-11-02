import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { removeTempDirs } from '../helpers/temp';
import { launchApp } from './launch';

// Step 15 in the real app, on a throwaway project (never a real one): permissions are granted only through native windows, an
// approved command runs through the process runner, and a repository is created only after the window explains it. The native
// windows are answered by the test (the real ones block the main process), and their text is kept so it can be read.

let userData: string;
let project: string;
test.beforeAll(() => {
  userData = mkdtempSync(join(tmpdir(), 'gdcc-e2e-perm-'));
  project = mkdtempSync(join(tmpdir(), 'gdcc-e2e-perm-project-'));
  mkdirSync(join(project, 'src'));
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'throwaway', scripts: { hello: "node -e \"console.log('hello from the throwaway project')\"", clean: 'rm -rf dist' } }));
  writeFileSync(join(project, 'src', 'index.js'), 'console.log(1);\n');
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

/** Answers every native confirmation with `answer` (true = the confirm button) and keeps what it said. */
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

test('permissions start off, are granted only through the window, and survive a restart', async () => {
  const { app, page } = await launchApp(userData);
  try {
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] });
    }, project);
    const { project: added } = (await invoke(page, 'projects:pickAndAdd', {})) as { project: { id: string } };
    await invoke(page, 'settings:set', { key: 'projects.selectedId', value: added.id });
    await page.reload();
    await page.getByRole('navigation', { name: 'Main' }).waitFor();
    await page.getByRole('button', { name: /^AI Workbench/ }).click();
    const panel = page.getByRole('region', { name: 'Permissions' });
    await expect(panel).toContainText('Not allowed. Agents can only read this project.');

    await answerWindows(app, false);
    await panel.getByRole('button', { name: 'Allow for this project…' }).click();
    await expect.poll(async () => (await windows(app)).length).toBe(1);
    await expect(panel).toContainText('Not allowed. Agents can only read this project.'); // declined: nothing changed
    expect((await windows(app))[0]).toContain('cannot grant themselves');

    await answerWindows(app, true);
    await panel.getByRole('button', { name: 'Allow for this project…' }).click();
    await expect(panel.getByRole('list', { name: 'Active permissions' })).toContainText('Whole project');
    await expect(panel.getByRole('table', { name: 'Approvals' })).toContainText('Granted: Approved project writes');
  } finally {
    await app.close();
  }
});

test('the grant is still there after a restart, can be taken back, and the page cannot make one', async () => {
  const { app, page } = await launchApp(userData);
  try {
    await page.getByRole('button', { name: /^AI Workbench/ }).click();
    const panel = page.getByRole('region', { name: 'Permissions' });
    await expect(panel.getByRole('list', { name: 'Active permissions' })).toContainText('Whole project');
    // a request that carries its own answer is refused by the contract, and nothing is granted
    const refused = await page.evaluate(async () => {
      const result = await window.api.invoke('permissions:request' as 'settings:get', { projectId: 'x', scope: 'project-writes', granted: true } as never);
      return result.ok ? 'accepted' : result.error.code;
    });
    expect(refused).toBe('INVALID_INPUT');
    await panel.getByRole('button', { name: 'Take back the permission for the whole project' }).click();
    await expect(panel).toContainText('Not allowed. Agents can only read this project.');
  } finally {
    await app.close();
  }
});

test('an approved command runs through the process runner; a destructive-looking one is marked and asks again', async () => {
  const { app, page } = await launchApp(userData);
  try {
    await answerWindows(app, true);
    await page.getByRole('button', { name: /^AI Workbench/ }).click();
    const commands = page.getByRole('list', { name: 'Project commands' });
    await expect(commands).toContainText('npm run hello');
    await expect(commands.locator('li', { hasText: 'npm run clean' })).toContainText('looks destructive');
    await expect(commands.getByRole('button', { name: 'Run npm run hello' })).toHaveCount(0); // not approved yet

    await commands.getByRole('button', { name: 'Approve npm run hello' }).click();
    await commands.getByRole('button', { name: 'Run npm run hello' }).click();
    await expect(page.getByLabel('Command output')).toContainText('hello from the throwaway project', { timeout: 30_000 });
    const asked = await windows(app);
    expect(asked[0]).toContain('code from the project running on your PC');

    await commands.getByRole('button', { name: 'Approve npm run clean' }).click();
    await expect.poll(async () => (await windows(app)).length).toBe(2);
    expect((await windows(app))[1]).toContain('You will be asked again every time it runs');
    expect(existsSync(join(project, 'dist'))).toBe(false); // approving never runs it
  } finally {
    await app.close();
  }
});

test('creating a repository is explained first, declining creates nothing, accepting creates only .git', async () => {
  const { app, page } = await launchApp(userData);
  try {
    await answerWindows(app, false);
    await page.getByRole('button', { name: /^Git and Changes/ }).click();
    await expect(page.getByText('Not a Git repository.')).toBeVisible();
    await page.getByRole('button', { name: 'Create Git repository…' }).click();
    await expect.poll(async () => (await windows(app)).length).toBe(1);
    expect((await windows(app))[0]).toContain('does not add, commit or change any of your files');
    expect(existsSync(join(project, '.git'))).toBe(false);

    await answerWindows(app, true);
    await page.getByRole('button', { name: 'Create Git repository…' }).click();
    await expect(page.getByLabel(/Git status of/)).toContainText('Branch', { timeout: 20_000 });
    expect(existsSync(join(project, '.git'))).toBe(true);
    expect(existsSync(join(project, 'src', 'index.js'))).toBe(true);
  } finally {
    await app.close();
  }
});
