import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { copyFixture, snapshotTree } from '../helpers/tree';
import { removeTempDirs } from '../helpers/temp';
import { launchApp } from './launch';

// Step 9: project memory, context packs and handoffs in the real app. A fixture project is the only folder ever written to,
// and only after a preview and a (stubbed) native confirmation.

let userData: string;
let folder: string;
test.beforeAll(() => {
  userData = mkdtempSync(join(tmpdir(), 'gdcc-e2e-context-'));
  folder = copyFixture('audit-godot');
  writeFileSync(join(folder, '.env'), 'API_KEY=sk-ant-api03-NeverInAPack0123456789');
});
test.afterAll(() => {
  rmSync(userData, { recursive: true, force: true });
  removeTempDirs();
});
test.describe.configure({ mode: 'serial' });

const answer = (app: ElectronApplication, name: 'showMessageBox' | 'showOpenDialog', value: unknown): Promise<void> =>
  app.evaluate(
    ({ dialog }, { method, result }) => {
      (dialog as unknown as Record<string, unknown>)[method] = () => Promise.resolve(result);
    },
    { method: name, result: value },
  );

const openContext = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: /^Project Context/ }).click();
  await expect(page.getByRole('heading', { name: 'Project Context' })).toBeVisible();
};

test('memory in the app database: create, preview, save; the project folder is untouched and the document survives a restart', async () => {
  const before = snapshotTree(folder);
  const first = await launchApp(userData);
  try {
    await answer(first.app, 'showOpenDialog', { canceled: false, filePaths: [folder] });
    await first.page.getByRole('button', { name: 'Project switcher' }).click();
    await first.page.getByRole('menuitem', { name: 'Add a project…' }).click();
    await openContext(first.page);

    await expect(first.page.getByRole('region', { name: 'Suggested documents' })).toContainText('Decisions');
    await first.page.getByRole('button', { name: 'Create Decisions' }).click();
    const editor = first.page.getByRole('region', { name: 'Editing Decisions' });
    await editor.getByLabel('Document text').fill('# Decisions\n\n- Use Godot 4.3 because the team knows it.\n');
    await expect(editor.getByRole('button', { name: 'Save' })).toBeDisabled();
    await editor.getByRole('button', { name: 'Preview changes' }).click();
    await expect(editor.getByLabel('Changes')).toContainText('+ - Use Godot 4.3 because the team knows it.');
    await editor.getByRole('button', { name: 'Save' }).click();
    await expect(editor.getByText('Saved to App database.')).toBeVisible();
    expect(snapshotTree(folder)).toEqual(before);
  } finally {
    await first.app.close();
  }

  const second = await launchApp(userData);
  try {
    await openContext(second.page);
    await second.page.getByRole('button', { name: 'Edit Decisions' }).click();
    await expect(second.page.getByLabel('Document text')).toHaveValue(/Use Godot 4\.3 because the team knows it/);
  } finally {
    await second.app.close();
  }
});

test('memory in the project folder: nothing is written until the preview is saved and the native confirmation is accepted', async () => {
  const { app, page } = await launchApp(userData);
  try {
    await openContext(page);
    const where = page.getByRole('region', { name: 'Where memory is stored' });
    await where.getByLabel('Store project memory').selectOption('project');
    await where.getByRole('button', { name: 'Use this' }).click();
    const before = snapshotTree(folder);

    await page.getByRole('button', { name: 'Create Project context' }).click();
    const editor = page.getByRole('region', { name: 'Editing Project context' });
    await editor.getByLabel('Document text').fill('# Project context\n\nA tiny Godot game used for tests.\n');
    await editor.getByRole('button', { name: 'Preview changes' }).click();
    await expect(editor.getByLabel('Changes')).toBeVisible();
    expect(existsSync(join(folder, 'PROJECT_CONTEXT.md'))).toBe(false);
    expect(snapshotTree(folder)).toEqual(before);

    // Declined: nothing is written.
    await answer(app, 'showMessageBox', { response: 1, checkboxChecked: false });
    await editor.getByRole('button', { name: 'Save into the project…' }).click();
    await expect(editor.getByText('Not saved: you declined the confirmation.')).toBeVisible();
    expect(snapshotTree(folder)).toEqual(before);

    // Accepted: exactly the previewed text, in exactly one new file.
    await answer(app, 'showMessageBox', { response: 0, checkboxChecked: false });
    await editor.getByLabel('Document text').fill('# Project context\n\nA tiny Godot game used for tests.\n');
    await editor.getByRole('button', { name: 'Preview changes' }).click();
    await editor.getByRole('button', { name: 'Save into the project…' }).click();
    await expect(editor.getByText('Saved to PROJECT_CONTEXT.md.')).toBeVisible();
    expect(readFileSync(join(folder, 'PROJECT_CONTEXT.md'), 'utf8')).toBe('# Project context\n\nA tiny Godot game used for tests.\n');
    const after = snapshotTree(folder);
    expect(Object.keys(after).filter((key) => !key.endsWith('/') && after[key] !== before[key])).toEqual(['PROJECT_CONTEXT.md']);
  } finally {
    await app.close();
  }
});

test('context packs: a focused preview without sensitive files, saved, then flagged out of date after a file changes', async () => {
  const first = await launchApp(userData);
  try {
    await openContext(first.page);
    await first.page.getByRole('tab', { name: 'Context packs' }).click();
    const form = first.page.getByRole('region', { name: 'Build a context pack' });
    await form.getByLabel('What is the task?').fill('Make the player move faster using the speed in util');
    await form.getByLabel(/Files to include for sure/).fill('.env\nscripts/util.gd');
    await form.getByLabel('Destination').selectOption('Claude Code (cloud)');
    await form.getByRole('button', { name: 'Build the pack' }).click();

    const preview = first.page.getByRole('region', { name: 'Context pack preview' });
    await expect(preview).toContainText('Destination: Claude Code (cloud)');
    await expect(preview.getByRole('list', { name: 'Included in the pack' })).toContainText('scripts/util.gd');
    await expect(preview.getByRole('list', { name: 'Left out of the pack' })).toContainText('.env');
    await expect(preview.getByRole('list', { name: 'Left out of the pack' })).toContainText('credentials');
    await preview.locator('summary').click();
    await expect(preview.getByLabel('Pack text')).toContainText('## File: scripts/util.gd');
    await expect(preview.getByLabel('Pack text')).not.toContainText('NeverInAPack');

    await preview.getByLabel('Pack name').fill('Speed work');
    await preview.getByRole('button', { name: 'Save the pack' }).click();
    await expect(first.page.getByRole('list', { name: 'Saved packs' })).toContainText('Up to date');
  } finally {
    await first.app.close();
  }

  appendFileSync(join(folder, 'scripts', 'util.gd'), '\n# tuned\n');
  const second = await launchApp(userData);
  try {
    await openContext(second.page);
    await second.page.getByRole('tab', { name: 'Context packs' }).click();
    const list = second.page.getByRole('list', { name: 'Saved packs' });
    await expect(list).toContainText('Out of date (1)');
    await list.getByRole('button', { name: 'Open Speed work' }).click();
    await expect(second.page.getByRole('alert')).toContainText('scripts/util.gd (changed)');
    await second.page.getByRole('button', { name: 'Rebuild with the current files' }).click();
    await expect(list).toContainText('Up to date');
  } finally {
    await second.app.close();
  }
});

test('handoffs: draft, save, and the latest one shows on the dashboard after a restart', async () => {
  const first = await launchApp(userData);
  try {
    await openContext(first.page);
    await first.page.getByRole('tab', { name: 'Session handoffs' }).click();
    const form = first.page.getByRole('region', { name: 'New session handoff' });
    await form.getByRole('button', { name: 'Draft from the project' }).click();
    await form.getByLabel('What was requested').fill('Add the dash move');
    await form.getByLabel('Next recommended task').fill('Tune the dash distance');
    await form.getByRole('button', { name: 'Save the handoff' }).click();
    await expect(first.page.getByRole('region', { name: 'Saved handoffs' })).toContainText('next: Tune the dash distance');
  } finally {
    await first.app.close();
  }

  const second = await launchApp(userData);
  try {
    const card = second.page.getByRole('region', { name: 'Latest session handoff' });
    await expect(card).toContainText('Tune the dash distance');
    await expect(card).toContainText('Add the dash move');
  } finally {
    await second.app.close();
  }
});
