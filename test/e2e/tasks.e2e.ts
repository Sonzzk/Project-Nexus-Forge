import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { copyFixture, snapshotTree } from '../helpers/tree';
import { removeTempDirs } from '../helpers/temp';
import { launchApp } from './launch';

// Step 10: plan work in the real app: a milestone, a task taken through its whole lifecycle, a feature broken down into
// chained steps, the bugs and risks register, and all of it still there after a restart. Nothing touches the project folder.

let userData: string;
let folder: string;
test.beforeAll(() => {
  userData = mkdtempSync(join(tmpdir(), 'gdcc-e2e-tasks-'));
  folder = copyFixture('audit-godot');
});
test.afterAll(() => {
  rmSync(userData, { recursive: true, force: true });
  removeTempDirs();
});
test.describe.configure({ mode: 'serial' });

const pickNext = (app: ElectronApplication, chosen: string): Promise<void> =>
  app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] });
  }, chosen);

const openTasks = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: /^Tasks and Roadmap/ }).click();
  await expect(page.getByRole('heading', { name: 'Tasks and Roadmap' })).toBeVisible();
};
const column = (page: Page, name: string): Locator => page.getByRole('region', { name, exact: true });

test('a milestone, a task through its whole lifecycle, and progress counted from the stored task', async () => {
  const before = snapshotTree(folder);
  const { app, page } = await launchApp(userData);
  try {
    await pickNext(app, folder);
    await page.getByRole('button', { name: 'Project switcher' }).click();
    await page.getByRole('menuitem', { name: 'Add a project…' }).click();
    await openTasks(page);

    await page.getByRole('tab', { name: 'Roadmap' }).click();
    await page.getByLabel('Title').fill('First playable');
    await page.getByLabel('Scope').selectOption('prototype');
    await page.getByRole('button', { name: 'Add milestone' }).click();
    const milestone = page.getByRole('region', { name: 'Milestone First playable' });
    await expect(milestone).toContainText('No tasks yet');
    await milestone.getByLabel('Status of First playable').selectOption('active');

    await page.getByRole('button', { name: 'New task…' }).click();
    const form = page.getByRole('region', { name: 'New task' });
    await form.getByLabel('Start from a template').selectOption('gameplay');
    await form.getByLabel('Title').fill('Add jumping');
    await form.getByLabel('Milestone').selectOption({ label: 'First playable' });
    await form.getByRole('button', { name: 'Add to the Inbox' }).click();

    const detail = page.getByRole('region', { name: 'Task Add jumping' });
    for (const step of ['Planned', 'Ready', 'In progress', 'Review', 'Testing', 'Done']) {
      await detail.getByRole('button', { name: `Move to ${step}` }).click();
      await expect(detail.locator('.badge').first()).toHaveText(step);
    }
    await expect(page.getByRole('region', { name: 'Milestone First playable' })).toContainText('1 of 1 done (100%)');

    await page.getByRole('button', { name: 'Dashboard' }).click();
    await expect(page.getByRole('region', { name: 'Current task and milestone' })).toContainText('First playable · 1 of 1 done (100%)');
    await expect(page.getByRole('region', { name: 'Portfolio' })).toContainText('1 of 1 done (100%)');
    expect(snapshotTree(folder)).toEqual(before);
  } finally {
    await app.close();
  }
});

test('after a restart the task is still done; a broken-down feature waits for its steps in order', async () => {
  const { app, page } = await launchApp(userData);
  try {
    await openTasks(page);
    await expect(page.getByRole('tab', { name: 'Roadmap' })).toHaveAttribute('aria-selected', 'true'); // the view you left is the view you get
    await page.getByRole('tab', { name: 'Board' }).click();
    await expect(column(page, 'Done').getByText('Add jumping')).toBeVisible();

    await page.getByRole('button', { name: 'Break a feature down…' }).click();
    const form = page.getByRole('region', { name: 'Break a feature down' });
    await form.getByLabel('Feature').fill('Crouching');
    await form.getByLabel(/^Steps/).fill('Add the crouch input :: C toggles crouch\nLower the camera');
    await form.getByRole('button', { name: 'Create 3 tasks' }).click();
    await expect(column(page, 'Planned').getByText('Lower the camera')).toBeVisible();

    // The second step waits for the first one.
    await column(page, 'Planned').getByRole('button', { name: /Lower the camera/ }).click();
    const detail = page.getByRole('region', { name: 'Task Lower the camera' });
    await expect(detail).toContainText('Waiting on: Add the crouch input (Planned)');
    await detail.getByRole('button', { name: 'Move to Ready' }).click();
    await detail.getByRole('button', { name: 'Move to In progress' }).click();
    await expect(page.getByRole('alert')).toContainText('waiting on: "Add the crouch input"');
    await expect(column(page, 'Ready').getByText('Lower the camera')).toBeVisible();
  } finally {
    await app.close();
  }
});

test('the bugs and risks register and the recommendation survive a restart', async () => {
  const first = await launchApp(userData);
  try {
    await openTasks(first.page);
    // Make the first crouch step ready: it is the only startable task, so it is the recommendation.
    await column(first.page, 'Planned').getByRole('button', { name: /Add the crouch input/ }).click();
    await first.page.getByRole('region', { name: 'Task Add the crouch input' }).getByRole('button', { name: 'Move to Ready' }).click();
    const next = first.page.getByRole('region', { name: 'Next recommended task' });
    await expect(next).toContainText('Add the crouch input');
    await expect(next).toContainText('unblocks 1 other task');

    await first.page.getByRole('tab', { name: 'Bugs and risks' }).click();
    const form = first.page.getByRole('region', { name: 'New bug or risk' });
    await form.getByLabel('Severity').selectOption('high');
    await form.getByLabel('Title').fill('Camera clips through walls');
    await form.getByRole('button', { name: 'Record it' }).click();
    await expect(first.page.getByRole('list', { name: 'Bugs and risks' })).toContainText('Camera clips through walls');
  } finally {
    await first.app.close();
  }

  const second = await launchApp(userData);
  try {
    await openTasks(second.page);
    await second.page.getByRole('tab', { name: 'Bugs and risks' }).click();
    await expect(second.page.getByRole('list', { name: 'Bugs and risks' })).toContainText('Camera clips through walls');
    await second.page.getByRole('button', { name: 'Dashboard' }).click();
    await expect(second.page.getByRole('region', { name: 'Current task and milestone' })).toContainText('1 bugs · 0 risks');
    await expect(second.page.getByRole('region', { name: 'Next recommended action' })).toContainText('Add the crouch input');
  } finally {
    await second.app.close();
  }
});
