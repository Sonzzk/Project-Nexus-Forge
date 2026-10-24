import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { fixture, sendJson, sendLines, startFixtureServer, type FixtureServer } from '../helpers/fixture-server';
import { copyFixture, snapshotTree } from '../helpers/tree';
import { removeTempDirs } from '../helpers/temp';
import { launchApp } from './launch';

// Step 13: the run queue in the real app. Local runs go to a stand-in Ollama on 127.0.0.1 with recorded answers; the one cloud
// run is declined in its confirmation window, so nothing leaves this PC and no subscription usage is spent. The resource
// monitor runs the real nvidia-smi and tasklist of this PC (read-only); the thresholds are set to 0 so the result does not
// depend on what else is running.

let userData: string;
let folder: string;
let server: FixtureServer;
test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'gdcc-e2e-queue-'));
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
  removeTempDirs();
});
test.describe.configure({ mode: 'serial' });

const invoke = (page: Page, channel: string, input: unknown): Promise<unknown> =>
  page.evaluate(async ([c, i]) => {
    const result = await window.api.invoke(c as 'settings:set', i as never);
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  }, [channel, input] as const);
/** Every native confirmation is answered with Cancel, and its text is kept so the test can read what was asked. */
const declineConfirmations = (app: ElectronApplication): Promise<void> =>
  app.evaluate(({ dialog }) => {
    const seen: string[] = [];
    (globalThis as unknown as { confirmations: string[] }).confirmations = seen;
    (dialog as unknown as Record<string, unknown>)['showMessageBox'] = (...args: unknown[]) => {
      const box = args.find((a) => typeof a === 'object' && a !== null && 'message' in a) as { message: string; detail?: string };
      seen.push(`${box.message}\n${box.detail ?? ''}`);
      return Promise.resolve({ response: 1, checkboxChecked: false });
    };
  });
const confirmations = (app: ElectronApplication): Promise<string[]> => app.evaluate(() => (globalThis as unknown as { confirmations: string[] }).confirmations);

test('a documentation run is routed to the local model, runs from the queue and keeps its answer; writers stay disabled', async () => {
  const before = snapshotTree(folder);
  const { app, page } = await launchApp(userData);
  try {
    await declineConfirmations(app);
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] });
    }, folder);
    const { project } = (await invoke(page, 'projects:pickAndAdd', {})) as { project: { id: string } };
    await invoke(page, 'settings:set', { key: 'projects.selectedId', value: project.id });
    for (const [key, value] of [
      ['providers.ollamaEndpoint', server.origin],
      ['routing.localModel', 'llama3.2:1b'],
      ['inference.minFreeVramMiB', 0],
      ['inference.minFreeRamMiB', 0],
      ['inference.holdForHeavyApps', false],
      ['inference.monitorIntervalSeconds', 5],
    ] as const)
      await invoke(page, 'settings:set', { key, value });
    await invoke(page, 'providers:check', { provider: 'ollama' });
    const docs = (await invoke(page, 'tasks:create', { projectId: project.id, title: 'Explain jumping' })) as { id: string };
    await invoke(page, 'agents:queue', { taskId: docs.id, workflow: 'documentation', includeReviewer: false, includeQa: false });
    const build = (await invoke(page, 'tasks:create', { projectId: project.id, title: 'Add jumping' })) as { id: string };
    await invoke(page, 'tasks:approvePlan', { id: build.id, approved: true });
    await invoke(page, 'agents:queue', { taskId: build.id, workflow: 'implement', includeReviewer: false, includeQa: false });

    await page.reload();
    await page.getByRole('navigation', { name: 'Main' }).waitFor();
    await page.getByRole('button', { name: /^AI Workbench/ }).click();
    const queue = page.getByRole('list', { name: 'Queued and running' });
    await expect(queue.getByRole('listitem')).toHaveCount(3);
    await expect(queue.getByRole('button', { name: /^Start · Upcoming · Step 15/ })).toBeDisabled();

    await queue.getByRole('button', { name: 'Start the Documentation run…' }).click();
    const route = page.getByLabel('Routing decision');
    await expect(route).toContainText('Ollama (local) · llama3.2:1b');
    await expect(route).toContainText('On this PC');
    await expect(route).toContainText('cannot read the project files');
    await page.getByRole('button', { name: 'Start', exact: true }).click();

    const finished = page.getByRole('list', { name: 'Recently finished' });
    await expect(finished).toContainText('Completed', { timeout: 15_000 });
    await finished.getByText(/^Answer/).click();
    await expect(finished).toContainText('Draft: how jumping works.');
    expect(await confirmations(app)).toEqual([]); // a local run needs no confirmation
    expect(server.seen.filter((s) => s.path === '/api/generate')).toHaveLength(1);
    expect(server.seen.find((s) => s.path === '/api/generate')?.body).toMatchObject({ model: 'llama3.2:1b', keep_alive: '5m' });

    await page.getByRole('button', { name: 'Dashboard' }).click();
    await expect(page.getByRole('region', { name: 'Active agent sessions' })).toContainText('No agent run is running or waiting.');
    expect(snapshotTree(folder)).toEqual(before);
  } finally {
    await app.close();
  }
});

test('the local-inference policy holds a local run with its reason, and the resource check reads this PC', async () => {
  const { app, page } = await launchApp(userData);
  try {
    await invoke(page, 'settings:set', { key: 'inference.mode', value: 'prioritize-game' });
    const projectId = ((await invoke(page, 'projects:list', {})) as { id: string }[])[0]?.id ?? '';
    const task = (await invoke(page, 'tasks:create', { projectId, title: 'More docs' })) as { id: string };
    await invoke(page, 'agents:queue', { taskId: task.id, workflow: 'documentation', includeReviewer: false, includeQa: false });
    await invoke(page, 'providers:check', { provider: 'ollama' });
    await page.getByRole('button', { name: /^AI Workbench/ }).click();
    const queue = page.getByRole('list', { name: 'Queued and running' });
    await queue.getByRole('button', { name: 'Start the Documentation run…' }).click();
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await expect(queue).toContainText('Held by the local-inference policy: Prioritize Game Performance is on', { timeout: 15_000 });
    expect(server.seen.filter((s) => s.path === '/api/generate')).toHaveLength(1); // still only the first run's request

    await page.getByRole('button', { name: 'Check resources now' }).click();
    const now = page.getByLabel('Resources now');
    await expect(now).toContainText('Local models wait', { timeout: 20_000 });
    await expect(now).toContainText('RAM:');
    await expect(now).toContainText(/NVIDIA|nvidia-smi/); // the GPU line, or the note that says why it is missing

    await queue.getByRole('button', { name: 'Cancel the Documentation run' }).click();
    await expect(page.getByRole('list', { name: 'Recently finished' })).toContainText('Cancelled');
    await expect(page.getByRole('region', { name: 'Run queue' })).not.toContainText('Held by the local-inference policy');
  } finally {
    await app.close();
  }
});

test('a cloud run shows its route and cost before anything is sent; declining it sends nothing', async () => {
  const { app, page } = await launchApp(userData);
  try {
    await declineConfirmations(app);
    const claude = ((await invoke(page, 'providers:list', {})) as { id: string; status: string }[]).find((p) => p.id === 'claude-code');
    test.skip(claude === undefined || !['installed', 'working'].includes(claude.status), 'Claude Code is not installed on this PC, so there is no cloud route to show.');
    await page.getByRole('button', { name: /^AI Workbench/ }).click();
    const queue = page.getByRole('list', { name: 'Queued and running' });
    await queue.getByRole('button', { name: 'Start the Planner / architect run…' }).click();
    const route = page.getByLabel('Routing decision');
    await expect(route).toContainText('Claude Code');
    await expect(route).toContainText('Cloud');
    await expect(route).toContainText(/not free|metered/);
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await expect(queue).toContainText('Not sent: you declined', { timeout: 15_000 });
    const asked = await confirmations(app);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('Routing (Balanced)');
    expect(asked[0]).toContain('Cost:');
    expect(asked[0]).toContain('read-only');
    await expect(queue.getByRole('button', { name: 'Start the Planner / architect run…' })).toBeEnabled(); // still queued, can be started again
  } finally {
    await app.close();
  }
});
