import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { copyFixture, snapshotTree } from '../helpers/tree';
import { removeTempDirs } from '../helpers/temp';
import { launchApp } from './launch';

// Step 11: roles and workflows in the real app. Workflows become queued records; nothing is started, nothing is sent, and
// the project folder is untouched.

let userData: string;
let folder: string;
test.beforeAll(() => {
  userData = mkdtempSync(join(tmpdir(), 'gdcc-e2e-agents-'));
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

test('a workflow is shown with its providers and blockers, needs the plan approved for the implementer, and is saved as queued records only', async () => {
  const before = snapshotTree(folder);
  const { app, page } = await launchApp(userData);
  try {
    await pickNext(app, folder);
    await page.getByRole('button', { name: 'Project switcher' }).click();
    await page.getByRole('menuitem', { name: 'Add a project…' }).click();
    await page.getByRole('button', { name: /^Tasks and Roadmap/ }).click();
    await page.getByRole('button', { name: 'New task…' }).click();
    const form = page.getByRole('region', { name: 'New task' });
    await form.getByLabel('Title').fill('Add jumping');
    await form.getByLabel('Suggested provider').fill('Claude Code');
    await form.getByLabel(/Acceptance criteria/).fill('Jump height is tunable');
    await form.getByRole('button', { name: 'Add to the Inbox' }).click();

    const panel = page.getByRole('region', { name: 'Agent work for this task' });
    await panel.getByLabel('Role').selectOption('implementer');
    await expect(panel).toContainText('Can change project files');
    await panel.getByRole('button', { name: 'Preview the prompt' }).click();
    await expect(panel.getByLabel('Prompt preview')).toContainText('Jump height is tunable');

    await panel.getByRole('button', { name: 'Show the plan' }).click();
    const steps = panel.getByRole('list', { name: 'Workflow plan' });
    await expect(steps).toContainText('Provider: Claude Code');
    await expect(steps).toContainText('Blocked: Needs an approved plan');
    await expect(steps.locator('li', { hasText: 'Code reviewer' })).toContainText('Optional · off');

    // Approving the plan on the task clears the blocker.
    await page.getByRole('button', { name: 'Approve the plan' }).click();
    await expect(page.getByRole('button', { name: 'Withdraw approval' })).toBeVisible();
    await panel.getByRole('button', { name: 'Show the plan' }).click();
    await expect(panel.getByRole('list', { name: 'Workflow plan' })).not.toContainText('Blocked:');

    await panel.getByRole('button', { name: 'Save as queued runs' }).click();
    const runs = panel.getByRole('list', { name: 'Runs' });
    await expect(runs.getByRole('listitem')).toHaveCount(2);
    await expect(runs).toContainText('Queued');
    await expect(panel.getByRole('button', { name: /^Run the workflow/ })).toBeDisabled();
    await expect(panel.getByRole('button', { name: /^Run the workflow/ })).toContainText('Upcoming · Step 12');
    expect(snapshotTree(folder)).toEqual(before);
  } finally {
    await app.close();
  }
});

test('the queued runs survive a restart, and an outcome can be recorded by hand', async () => {
  const { app, page } = await launchApp(userData);
  try {
    await page.getByRole('button', { name: /^Tasks and Roadmap/ }).click();
    await page.getByRole('button', { name: /Add jumping/ }).first().click();
    const panel = page.getByRole('region', { name: 'Agent work for this task' });
    const runs = panel.getByRole('list', { name: 'Runs' });
    await expect(runs.getByRole('listitem')).toHaveCount(2);
    await panel.getByRole('button', { name: 'Record Planner / architect run as completed' }).click();
    await expect(runs).toContainText('Completed');
    await expect(runs).toContainText('Recorded by hand');
    await page.getByRole('button', { name: 'Dashboard' }).click();
    await expect(page.getByText(/Planner \/ architect run: Queued to Completed/).first()).toBeVisible();
  } finally {
    await app.close();
  }
});
