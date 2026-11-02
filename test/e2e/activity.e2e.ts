import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { fixture, sendJson, sendLines, startFixtureServer, type FixtureServer } from '../helpers/fixture-server';
import { copyFixture } from '../helpers/tree';
import { removeTempDirs } from '../helpers/temp';
import { launchApp } from './launch';

// Step 17 in the real app: a local run through a stand-in Ollama leaves a session record that survives a restart; the history can be
// filtered and exported (redacted) to a file chosen in a native save window; the log and a diagnostics bundle can be read and saved.
// Nothing leaves this PC and no provider usage is spent.

let userData: string;
let out: string;
let folder: string;
let server: FixtureServer;
const SECRET = ['sk', 'ant', 'api03', 'notreal0123456789abcdef'].join('-'); // assembled at run time: the repository holds no key-shaped string

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'gdcc-e2e-activity-'));
  out = mkdtempSync(join(tmpdir(), 'gdcc-e2e-activity-out-'));
  folder = copyFixture('audit-godot');
  server = await startFixtureServer();
  server.route('GET /api/version', (_req, res) => sendJson(res, fixture('ollama', 'version.json')));
  server.route('GET /api/tags', (_req, res) => sendJson(res, fixture('ollama', 'tags.json')));
  server.route('GET /api/ps', (_req, res) => sendJson(res, fixture('ollama', 'ps.json')));
  server.route('POST /api/show', (_req, res) => sendJson(res, fixture('ollama', 'show-llama.json')));
  server.route('POST /api/generate', (_req, res) =>
    sendLines(res, `${JSON.stringify({ model: 'llama3.2:1b', response: 'Draft: how jumping works.', done: false })}\n${JSON.stringify({ model: 'llama3.2:1b', response: '', done: true })}`, 5),
  );
});
test.afterAll(async () => {
  await server.close();
  rmSync(userData, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
  removeTempDirs();
});
test.describe.configure({ mode: 'serial' });

const invoke = (page: Page, channel: string, input: unknown): Promise<unknown> =>
  page.evaluate(async ([c, i]) => {
    const result = await window.api.invoke(c as 'settings:set', i as never);
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  }, [channel, input] as const);

/** The next native save window answers with this path (or cancels with undefined). */
const saveTo = (app: ElectronApplication, path: string | undefined): Promise<void> =>
  app.evaluate(({ dialog }, target) => {
    (dialog as unknown as Record<string, unknown>)['showSaveDialog'] = () => Promise.resolve(target === undefined ? { canceled: true } : { canceled: false, filePath: target });
  }, path);

test('a local run leaves a session record with only what was observed', async () => {
  const { app, page } = await launchApp(userData);
  try {
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] });
    }, folder);
    const { project } = (await invoke(page, 'projects:pickAndAdd', {})) as { project: { id: string } };
    await invoke(page, 'settings:set', { key: 'projects.selectedId', value: project.id });
    for (const [key, value] of [['providers.ollamaEndpoint', server.origin], ['routing.localModel', 'llama3.2:1b'], ['inference.minFreeVramMiB', 0], ['inference.minFreeRamMiB', 0], ['inference.holdForHeavyApps', false]] as const)
      await invoke(page, 'settings:set', { key, value });
    await invoke(page, 'providers:check', { provider: 'ollama' });
    const task = (await invoke(page, 'tasks:create', { projectId: project.id, title: 'Explain jumping' })) as { id: string };
    const [run] = (await invoke(page, 'agents:queue', { taskId: task.id, workflow: 'documentation', includeReviewer: false, includeQa: false })) as { id: string }[];
    await invoke(page, 'queue:start', { runId: run?.id });
    await expect
      .poll(async () => ((await invoke(page, 'sessions:list', { projectId: project.id })) as { outcome: string }[])[0]?.outcome, { timeout: 15_000 })
      .toBe('completed');

    await page.reload();
    await page.getByRole('navigation', { name: 'Main' }).waitFor();
    await page.getByRole('button', { name: /^Activity and Logs/ }).click();
    await page.getByRole('tab', { name: 'Live sessions' }).click();
    await page.getByRole('button', { name: /^Open the session of the Documentation/ }).click();
    const detail = page.getByRole('region', { name: 'Session', exact: true });
    await expect(detail).toContainText('Ollama (local)');
    await expect(detail).toContainText('Draft: how jumping works.');
    await expect(detail).toContainText('None: a local model only receives the task text.');
    await expect(detail).toContainText('Not exposed by this provider'); // an Ollama run reports no tools, denials or exit code
    await expect(detail).toContainText('does not tell the app which commands or files');
    await expect(detail).toContainText('Test output: runs do not report test results yet');
    await expect(detail).toContainText('A local model keeps no session to resume.');
    await expect(page.getByRole('region', { name: 'Command queue' })).toContainText('Nothing is queued or running.');
  } finally {
    await app.close();
  }
});

test('the session record is still there after a restart', async () => {
  const { app, page } = await launchApp(userData);
  try {
    await page.getByRole('button', { name: /^Activity and Logs/ }).click();
    await page.getByRole('tab', { name: 'Live sessions' }).click();
    await expect(page.getByRole('list', { name: 'Session list' })).toContainText('Completed');
    await page.getByRole('button', { name: /^Open the session of the Documentation/ }).click();
    await expect(page.getByRole('region', { name: 'Session', exact: true })).toContainText('Draft: how jumping works.');
  } finally {
    await app.close();
  }
});

test('the history is filtered and exported without secrets, to a file chosen in a native window', async () => {
  const { app, page } = await launchApp(userData);
  try {
    await invoke(page, 'settings:set', { key: 'providers.ollamaEndpoint', value: server.origin });
    await page.getByRole('button', { name: /^Activity and Logs/ }).click();
    await expect(page.locator('ul.rows').first()).toContainText('Documentation');
    await page.getByLabel('Search').fill('agent.');
    await expect(page.locator('ul.rows').first()).not.toContainText('Added'); // project entries are filtered out
    await page.getByLabel('Search').fill('');

    const json = join(out, 'history.json');
    await saveTo(app, json);
    await page.getByRole('button', { name: 'Export as JSON…' }).click();
    await expect(page.getByRole('status')).toContainText(/Saved \d+ entries/);
    const file = JSON.parse(readFileSync(json, 'utf8')) as { format: string; count: number; events: { kind: string }[] };
    expect(file.format).toBe('gdcc-activity');
    expect(file.count).toBeGreaterThan(3);
    expect(file.events.some((e) => e.kind.startsWith('agent.'))).toBe(true);
    expect(readFileSync(json, 'utf8')).not.toContain(SECRET);

    const csv = join(out, 'history.csv');
    await saveTo(app, csv);
    await page.getByRole('button', { name: 'Export as CSV…' }).click();
    await expect.poll(() => existsSync(csv)).toBe(true);
    expect(readFileSync(csv, 'utf8').split('\r\n')[0]).toBe('time,severity,kind,summary,project,task,details');

    await saveTo(app, undefined);
    await page.getByRole('button', { name: 'Export as CSV…' }).click();
    await expect(page.getByRole('status')).toContainText('Nothing was saved.');
  } finally {
    await app.close();
  }
});

test('the log is readable, a diagnostics bundle is saved redacted, and the retention limits are editable', async () => {
  const { app, page } = await launchApp(userData);
  try {
    await page.getByRole('button', { name: /^Activity and Logs/ }).click();
    await page.getByRole('tab', { name: 'Logs and diagnostics' }).click();
    const table = page.getByRole('table', { name: 'Log lines' });
    await expect(table.getByRole('row').nth(1)).toBeVisible();
    await expect(page.getByText(/main\.log \(\d+ KB\)/)).toBeVisible();

    const bundle = join(out, 'diagnostics.json');
    await saveTo(app, bundle);
    await page.getByRole('button', { name: 'Save a diagnostics bundle…' }).click();
    await expect(page.getByText('The diagnostics bundle was saved.')).toBeVisible();
    const text = readFileSync(bundle, 'utf8');
    const parsed = JSON.parse(text) as { format: string; app: { name: string }; rowCounts: Record<string, number>; settings: Record<string, unknown> };
    expect(parsed).toMatchObject({ format: 'gdcc-diagnostics', app: { name: expect.any(String) as unknown } });
    expect(parsed.rowCounts['run_sessions' as never] ?? parsed.rowCounts['agent_runs']).toBeGreaterThanOrEqual(1);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(process.env['USERNAME'] ?? '\u0000no-user');

    await page.getByLabel('Activity history (days)').fill('90');
    await expect.poll(async () => ((await invoke(page, 'settings:get', {})) as Record<string, unknown>)['retention.activityDays']).toBe(90);
    await page.getByRole('button', { name: 'Clean up now' }).click();
    await expect(page.getByText(/^Removed \d+ activity entries/)).toBeVisible();
  } finally {
    await app.close();
  }
});
