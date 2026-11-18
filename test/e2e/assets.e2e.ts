import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { removeTempDirs } from '../helpers/temp';
import { copyFixture } from '../helpers/tree';
import { launchApp } from './launch';

// Step 22 in the real app, on a copy of the fixture project (never a real one): the project is scanned into the asset index, found by a
// search, an image is previewed through the gdcc-asset protocol (and requests outside the project or for other file types are refused),
// notes are kept, a move happens only after the project-writes window and the confirmation, and the Recycle Bin is stubbed so no file of
// this PC is ever really sent there.

let userData: string;
let project: string;

test.beforeAll(() => {
  userData = mkdtempSync(join(tmpdir(), 'gdcc-e2e-assets-'));
  project = copyFixture('assets-project');
  writeFileSync(join(project, '.env.png'), 'x'); // never indexed
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
  app.evaluate(({ dialog, shell }, path) => {
    const g = globalThis as unknown as { windows: string[]; trashed: string[] };
    g.windows = [];
    g.trashed = [];
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] });
    (dialog as unknown as Record<string, unknown>)['showMessageBox'] = (...args: unknown[]) => {
      const box = args.find((a) => typeof a === 'object' && a !== null && 'message' in a) as { title: string; message: string; detail?: string };
      g.windows.push(`${box.title}\n${box.message}\n${box.detail ?? ''}`);
      return Promise.resolve({ response: 0, checkboxChecked: false });
    };
    (shell as unknown as Record<string, unknown>)['trashItem'] = (file: string) => {
      g.trashed.push(file);
      return Promise.resolve();
    };
  }, folder);
const windows = (app: ElectronApplication): Promise<string[]> => app.evaluate(() => (globalThis as unknown as { windows: string[] }).windows);
const trashed = (app: ElectronApplication): Promise<string[]> => app.evaluate(() => (globalThis as unknown as { trashed: string[] }).trashed);

test('scans, searches, previews an image, keeps notes, and refuses previews outside the project', async () => {
  const { app, page } = await launchApp(userData);
  try {
    await stubWindows(app, project);
    const { project: added } = (await invoke(page, 'projects:pickAndAdd', {})) as { project: { id: string } };
    await invoke(page, 'settings:set', { key: 'projects.selectedId', value: added.id });
    await page.reload();
    await page.getByRole('navigation', { name: 'Main' }).waitFor();
    await page.getByRole('button', { name: /^Assets/ }).click();
    await expect(page.getByText('Nothing is listed until the project has been scanned.')).toBeVisible();
    await page.getByRole('button', { name: 'Scan the project' }).click();
    await expect(page.getByLabel('Last scan')).toContainText('17 asset files');
    await expect(page.getByRole('list', { name: 'Assets' }).getByRole('listitem').first()).toBeVisible();
    await page.getByLabel('Search', { exact: true }).fill('rock');
    const list = page.getByRole('list', { name: 'Assets' });
    await expect(list.getByRole('listitem')).toHaveCount(3);
    await expect(list).not.toContainText('secret_key');
    await expect(list).not.toContainText('.env');

    // a real preview through the protocol: the image decodes, so the scheme, the handler and the CSP all work
    const thumb = list.getByRole('img', { name: 'Preview of art/rock.png' });
    await expect(thumb).toBeVisible();
    await expect.poll(() => thumb.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBe(1);

    // requests the handler must refuse: outside the project, another file type, an unregistered project
    const outcome = (url: string): Promise<string> =>
      page.evaluate(
        (u) =>
          new Promise<string>((resolve) => {
            const img = new Image();
            img.onload = () => resolve('loaded');
            img.onerror = () => resolve('refused');
            img.src = u;
          }),
        url,
      );
    const base = `gdcc-asset://preview/${added.id}?p=`;
    expect(await outcome(`${base}art%2Frock.png`)).toBe('loaded');
    expect(await outcome(`${base}..%2F..%2Fpackage.png`)).toBe('refused');
    expect(await outcome(`${base}..%5C..%5Cwin.png`)).toBe('refused');
    expect(await outcome(`${base}C%3A%2FWindows%2Fweb%2Fwallpaper%2Fx.png`)).toBe('refused');
    expect(await outcome(`${base}project.godot`)).toBe('refused');
    expect(await outcome(`${base}art%2Fsecret_key.png`)).toBe('refused');
    expect(await outcome(`gdcc-asset://preview/not-a-project?p=art%2Frock.png`)).toBe('refused');
    const asFetch = await page.evaluate(async (u) => {
      try {
        const response = await fetch(u);
        return response.status;
      } catch {
        return 'blocked';
      }
    }, `${base}project.godot`);
    expect(['blocked', 404]).toContain(asFetch);

    // notes stay on the file
    await page.getByRole('button', { name: 'Details of art/rock.png' }).click();
    const detail = page.getByRole('region', { name: 'Details of art/rock.png' });
    await detail.getByLabel('Note', { exact: true }).fill('Terrain rock');
    await detail.getByLabel('Tags (separated by commas)').fill('terrain, stone');
    await detail.getByLabel('Source or owner').fill('CC0 pack');
    await detail.getByRole('button', { name: 'Save my notes' }).click();
    await expect(detail.getByText('Your notes were saved.')).toBeVisible();
    await page.getByLabel('Tag', { exact: true }).fill('stone');
    await expect(list.getByRole('listitem')).toHaveCount(1);
  } finally {
    await app.close();
  }
});

test('moves a file only after the permission and confirmation windows, sends another to the (stubbed) Recycle Bin, and saves the register', async () => {
  const { app, page } = await launchApp(userData);
  try {
    await stubWindows(app, project);
    await page.getByRole('button', { name: /^Assets/ }).click();
    await page.getByRole('button', { name: 'Scan again' }).click();
    await page.getByLabel('Search', { exact: true }).fill('rock.png');
    const list = page.getByRole('list', { name: 'Assets' });
    await list.getByRole('button', { name: 'Details of art/rock.png' }).click();
    const detail = page.getByRole('region', { name: 'Details of art/rock.png' });
    await detail.getByLabel('New path in the project').fill('art/stone/rock.png');
    await detail.getByRole('button', { name: 'Preview the move' }).click();
    const preview = detail.getByLabel('Preview of the change');
    await expect(preview).toContainText('art/rock.png -> art/stone/rock.png');
    expect(existsSync(join(project, 'art', 'rock.png'))).toBe(true); // a preview moves nothing
    expect(await windows(app)).toEqual([]);
    await preview.getByRole('button', { name: 'Move it…' }).click();
    await expect(page.getByText('art/rock.png was moved to art/stone/rock.png.')).toBeVisible();
    expect(existsSync(join(project, 'art', 'rock.png'))).toBe(false);
    expect(existsSync(join(project, 'art', 'stone', 'rock.png'))).toBe(true);
    const asked = await windows(app);
    expect(asked).toHaveLength(2); // the permission, then the list of files
    expect(asked[1]).toContain('art/rock.png\n    -> art/stone/rock.png');

    // overwriting is refused in the preview, and nothing is asked
    await page.getByLabel('Search', { exact: true }).fill('crate.fbx');
    await list.getByRole('button', { name: 'Details of art/crate.fbx' }).click();
    const crate = page.getByRole('region', { name: 'Details of art/crate.fbx' });
    await crate.getByLabel('New path in the project').fill('art/props/crate.fbx');
    await crate.getByRole('button', { name: 'Preview the move' }).click();
    await expect(crate.getByLabel('Preview of the change').getByRole('alert')).toContainText('already exists');
    await expect(crate.getByRole('button', { name: 'Move it…' })).toBeDisabled();

    // removal goes to the (stubbed) Recycle Bin, never a delete
    await crate.getByRole('button', { name: 'Preview removal (Recycle Bin)' }).click();
    await crate.getByRole('button', { name: 'Move it to the Recycle Bin…' }).click();
    await expect(page.getByText('art/crate.fbx is in the Recycle Bin.')).toBeVisible();
    expect(await trashed(app)).toHaveLength(1);
    expect((await trashed(app))[0]).toContain('crate.fbx');
    expect(existsSync(join(project, 'art', 'crate.fbx'))).toBe(true); // the stub did not delete it

    // the register
    await page.getByRole('tab', { name: 'Asset register' }).click();
    await page.getByRole('button', { name: 'Build the register' }).click();
    await expect(page.getByLabel('Register text')).toHaveValue(/Asset register: assets-project/);
    await expect(page.getByLabel('Register text')).toHaveValue(/art\/stone\/rock\.png/); // the note moved with the file
    await page.getByRole('button', { name: 'Preview what would be saved' }).click();
    await page.getByRole('button', { name: 'Save the register…' }).click();
    await expect(page.getByText(/Saved to App database/)).toBeVisible();
  } finally {
    await app.close();
  }
});
