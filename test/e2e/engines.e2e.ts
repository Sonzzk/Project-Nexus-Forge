import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { removeTempDirs } from '../helpers/temp';
import { copyFixture, snapshotTree } from '../helpers/tree';
import { launchApp } from './launch';

// Step 18 in the real app, on copies of the fixtures (never a real project and never a real engine): the Unreal project and the engine
// install are read from files, a build is approved in a native window and run through the process runner against the fixture
// engine's Build.bat, and the project folder is not changed by looking at it. The engine list is pointed at a throwaway
// "Epic launcher" file and an empty Program Files, so the result does not depend on what is installed on this PC.

let userData: string;
let programData: string;
let programFiles: string;
let project: string;
let engine: string;
const saved: Record<string, string | undefined> = {};

test.beforeAll(() => {
  userData = mkdtempSync(join(tmpdir(), 'gdcc-e2e-eng-'));
  programData = mkdtempSync(join(tmpdir(), 'gdcc-e2e-eng-pd-'));
  programFiles = mkdtempSync(join(tmpdir(), 'gdcc-e2e-eng-pf-'));
  project = copyFixture('unreal-cpp');
  engine = copyFixture('engines/UE_5.5');
  mkdirSync(join(programData, 'Epic', 'UnrealEngineLauncher'), { recursive: true });
  writeFileSync(join(programData, 'Epic', 'UnrealEngineLauncher', 'LauncherInstalled.dat'), JSON.stringify({ InstallationList: [{ InstallLocation: engine, AppName: 'UE_5.5' }] }));
  for (const key of ['ProgramData', 'ProgramFiles']) saved[key] = process.env[key];
  process.env['ProgramData'] = programData;
  process.env['ProgramFiles'] = programFiles;
});
test.afterAll(() => {
  // Assigning undefined would store the text "undefined", so a variable that was unset is put back with Reflect.deleteProperty.
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
  for (const dir of [userData, programData, programFiles]) rmSync(dir, { recursive: true, force: true });
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

test('shows the engine and the Unreal project from files, builds only after the window, and leaves the project untouched', async () => {
  const before = snapshotTree(project);
  const { app, page } = await launchApp(userData);
  try {
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] });
    }, project);
    const { project: added } = (await invoke(page, 'projects:pickAndAdd', {})) as { project: { id: string } };
    await invoke(page, 'settings:set', { key: 'projects.selectedId', value: added.id });
    await page.reload();
    await page.getByRole('navigation', { name: 'Main' }).waitFor();

    await page.getByRole('button', { name: /^Integrations/ }).click();
    const card = page.getByRole('region', { name: 'Unreal Engine' });
    const installed = card.getByRole('table', { name: 'Installed engines' });
    await expect(installed).toContainText('UE_5.5');
    await expect(installed).toContainText('Epic launcher');
    const facts = card.getByLabel('Unreal project Backrooms');
    await expect(facts).toContainText('Backrooms (Game), BackroomsEditor (Editor)');
    await expect(facts).toContainText('UE_5.5');
    await expect(facts).toContainText('/Game/Maps/Hall');
    await expect(card.getByRole('table', { name: 'Capability report' })).toContainText('Implemented');
    await expect(card.getByRole('list', { name: 'Unreal commands' })).toContainText('Unreal: build Backrooms (Win64, Development)');

    // the page can only name a kind of folder, never a path
    const refused = await page.evaluate(async () => {
      const result = await window.api.invoke('engines:open' as 'settings:get', { projectId: 'x', target: 'project', path: 'C:\\Windows' } as never);
      return result.ok ? 'accepted' : result.error.code;
    });
    expect(refused).toBe('INVALID_INPUT'); // a path is not part of the request

    await page.getByRole('button', { name: /^AI Workbench/ }).click();
    const commands = page.getByRole('list', { name: 'Project commands' });
    const build = commands.locator('li', { hasText: 'Unreal: build Backrooms (Win64, Development)' });
    await expect(build).toContainText('engine command');
    await expect(build).toContainText('writes files in the project');

    await answerWindows(app, true);
    await build.getByRole('button', { name: 'Approve Unreal: build Backrooms (Win64, Development)' }).click();
    await build.getByRole('button', { name: 'Run Unreal: build Backrooms (Win64, Development)' }).click();
    await expect(page.getByLabel('Command output')).toContainText('FIXTURE-BUILD Backrooms Win64 Development', { timeout: 60_000 });
    const asked = await windows(app);
    expect(asked[0]).toContain('Build.bat');

    // the output is kept: it is listed on the Integrations page afterwards
    await page.getByRole('button', { name: /^Integrations/ }).click();
    const logs = page.getByRole('region', { name: 'Unreal Engine' }).getByRole('list', { name: 'Command logs' });
    await expect(logs).toContainText('Unreal: build Backrooms');
    await logs.getByRole('button', { name: /^Show the log of Unreal: build Backrooms/ }).click();
    await expect(page.getByLabel('Command log', { exact: true })).toContainText('FIXTURE-BUILD Backrooms Win64 Development');
  } finally {
    await app.close();
  }
  expect(snapshotTree(project)).toEqual(before); // reading, describing and building with the fixture engine changed nothing in the project
});

test('the Backrooms profile starts off and keeps what you confirm across a restart', async () => {
  const { app, page } = await launchApp(userData);
  try {
    await page.getByRole('button', { name: /^Integrations/ }).click();
    const profile = page.getByRole('region', { name: 'Backrooms game profile' });
    await expect(profile).toContainText('The profile is off');
    await profile.getByRole('checkbox', { name: 'Use this profile' }).check();
    const systems = profile.getByRole('list', { name: 'Game systems' });
    await expect(systems.getByRole('checkbox', { checked: true })).toHaveCount(0);
    await systems.getByRole('checkbox', { name: 'Procedural generation' }).check();
    await expect(profile.getByRole('list', { name: 'Risk flags' })).toContainText('Procedural generation is in scope');
  } finally {
    await app.close();
  }
  const again = await launchApp(userData);
  try {
    await again.page.getByRole('button', { name: /^Integrations/ }).click();
    const profile = again.page.getByRole('region', { name: 'Backrooms game profile' });
    await expect(profile.getByRole('checkbox', { name: 'Use this profile' })).toBeChecked();
    await expect(profile.getByRole('list', { name: 'Game systems' }).getByRole('checkbox', { checked: true })).toHaveCount(1);
  } finally {
    await again.app.close();
  }
});
