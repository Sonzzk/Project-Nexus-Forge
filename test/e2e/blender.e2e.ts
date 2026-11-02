import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { launchApp } from './launch';

// Step 19 in the real app, on a throwaway project (never a real one). Part one needs no Blender: a stand-in blender.exe that cannot run
// shows the failure path, and the asset pages and the native windows are exercised. Part two runs a real headless Blender when
// GDCC_BLENDER_DIR points at a folder that contains blender.exe, and is skipped (and reported as skipped) otherwise.

let userData: string;
let project: string;
let fakeBlender: string;
const realBlender = process.env['GDCC_BLENDER_DIR'] !== undefined && existsSync(join(process.env['GDCC_BLENDER_DIR'], 'blender.exe')) ? process.env['GDCC_BLENDER_DIR'] : undefined;
const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

test.beforeAll(() => {
  userData = mkdtempSync(join(tmpdir(), 'gdcc-e2e-blender-'));
  project = mkdtempSync(join(tmpdir(), 'gdcc-e2e-blender-project-'));
  fakeBlender = mkdtempSync(join(tmpdir(), 'gdcc-e2e-blender-fake-'));
  mkdirSync(join(project, 'art'));
  mkdirSync(join(project, 'tools'));
  writeFileSync(join(fakeBlender, 'blender.exe'), 'this is not a program');
  writeFileSync(join(project, 'tools', 'export.py'), 'import bpy\nbpy.ops.wm.save_mainfile()\n');
  if (realBlender === undefined) writeFileSync(join(project, 'art', 'chair.blend'), Buffer.concat([Buffer.from('BLENDER-v403'), Buffer.alloc(64, 1)]));
  else {
    // a real scene, made by Blender itself in the throwaway project
    const made = spawnSync(join(realBlender, 'blender.exe'), ['-b', '--factory-startup', '-noaudio', '--python-expr', `import bpy; bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(join(project, 'art', 'chair.blend'))})`], { timeout: 120_000 });
    if (made.status !== 0) throw new Error('Blender could not make the test scene');
  }
});
test.afterAll(() => {
  for (const dir of [userData, project, fakeBlender]) rmSync(dir, { recursive: true, force: true });
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

async function openBlender(app: ElectronApplication, page: Page, firstTime: boolean): Promise<ReturnType<Page['getByRole']>> {
  if (firstTime) {
    await stubWindows(app);
    await answerFolder(app, project);
    const { project: added } = (await invoke(page, 'projects:pickAndAdd', {})) as { project: { id: string } };
    await invoke(page, 'settings:set', { key: 'projects.selectedId', value: added.id });
    await page.reload();
    await page.getByRole('navigation', { name: 'Main' }).waitFor();
  }
  await page.getByRole('button', { name: /^Integrations/ }).click();
  return page.getByRole('region', { name: 'Blender', exact: true });
}

test('with a Blender that cannot run: scenes are listed, a failed run is recorded and the original is untouched; assets and briefs persist', async () => {
  test.skip(realBlender !== undefined, 'a real Blender is available, so the real run below covers this');
  const before = sha(join(project, 'art', 'chair.blend'));
  const { app, page } = await launchApp(userData);
  try {
    const card = await openBlender(app, page, true);
    await expect(card.getByRole('table', { name: 'Blender scenes' })).toContainText('art/chair.blend');
    await expect(card.getByRole('list', { name: 'Blender scripts' })).toContainText('tools/export.py');

    await answerFolder(app, fakeBlender);
    await card.getByRole('button', { name: 'Add a Blender folder…' }).click();
    await expect(card.getByRole('table', { name: 'Blender installations' })).toContainText('Added by you');

    await card.getByRole('button', { name: 'Inspect art/chair.blend' }).click();
    const runs = card.getByRole('list', { name: 'Blender runs' });
    await expect(runs).toContainText(/Failed|Inconclusive/);
    await expect(card.getByLabel('Run details')).toContainText('Unchanged');
    expect(sha(join(project, 'art', 'chair.blend'))).toBe(before);
    expect(readdirSync(join(project, 'art'))).toEqual(['chair.blend']);

    await card.getByRole('button', { name: 'Approve tools/export.py' }).click();
    await expect.poll(async () => (await windows(app)).length).toBeGreaterThan(0);
    expect((await windows(app)).at(-1)).toContain('bpy.ops.wm.save_mainfile()');
    expect((await windows(app)).at(-1)).toContain('same rights as your Windows account');
    await expect(card.getByRole('button', { name: 'Run tools/export.py' })).toBeVisible();

    await card.getByRole('button', { name: 'Track art/chair.blend' }).click();
    await expect(card.getByRole('list', { name: 'Tracked assets' })).toContainText('art/chair.blend');
    const form = card.getByLabel('New asset brief');
    await form.getByLabel('Asset name').fill('wooden chair');
    await expect(form.getByLabel('Naming check')).toContainText('SM_WoodenChair');
    await form.getByLabel('Scale').fill('0.9 m high');
    await form.getByRole('button', { name: 'Save brief' }).click();
    await expect(card.getByRole('list', { name: 'Asset briefs' })).toContainText('wooden chair');
  } finally {
    await app.close();
  }
  const again = await launchApp(userData);
  try {
    const card = await openBlender(again.app, again.page, false);
    await expect(card.getByRole('list', { name: 'Tracked assets' })).toContainText('art/chair.blend');
    await expect(card.getByRole('list', { name: 'Asset briefs' })).toContainText('wooden chair');
    await expect(card.getByRole('list', { name: 'Blender runs' })).toContainText('art/chair.blend');
    await card.getByRole('button', { name: 'Write import notes for wooden chair' }).click();
    await expect(card.getByLabel('Handoff text')).toHaveValue(/Import handoff: wooden chair/);
    await expect(card.getByLabel('Handoff text')).toHaveValue(/Scale: 0\.9 m high/);
  } finally {
    await again.app.close();
  }
  expect(sha(join(project, 'art', 'chair.blend'))).toBe(before);
});

test('with a real Blender: a scene is described on a copy, an approved script that saves changes only the copy', async () => {
  test.skip(realBlender === undefined, 'GDCC_BLENDER_DIR is not set to a folder that contains blender.exe, so no real headless run was made');
  test.setTimeout(240_000);
  const before = sha(join(project, 'art', 'chair.blend'));
  const { app, page } = await launchApp(userData);
  try {
    const card = await openBlender(app, page, true);
    await answerFolder(app, realBlender as string);
    await card.getByRole('button', { name: 'Add a Blender folder…' }).click();
    await expect(card.getByRole('table', { name: 'Blender installations' })).toContainText('Added by you');

    await card.getByRole('button', { name: 'Inspect art/chair.blend' }).click();
    const details = card.getByLabel('Run details');
    await expect(details).toContainText('Passed', { timeout: 120_000 });
    await expect(details.getByLabel('Scene facts')).toContainText('12 triangles before modifiers');
    await expect(details).toContainText('Unchanged');

    await card.getByRole('button', { name: 'Approve tools/export.py' }).click();
    await card.getByRole('button', { name: 'Run tools/export.py' }).click();
    await expect(card.getByLabel('Run details')).toContainText('Script tools/export.py', { timeout: 120_000 });
    await expect(card.getByRole('list', { name: 'Run output files' })).toContainText('(modified copy)');
    await expect(card.getByLabel('Run details')).toContainText('Unchanged');
    expect(sha(join(project, 'art', 'chair.blend'))).toBe(before); // the script saved, the original did not change
    expect(readdirSync(join(project, 'art'))).toEqual(['chair.blend']);
    expect(readdirSync(join(project, 'tools'))).toEqual(['export.py']);
  } finally {
    await app.close();
  }
});
