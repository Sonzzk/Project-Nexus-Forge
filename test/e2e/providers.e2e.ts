import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { fixture, sendJson, sendLines, startFixtureServer, type FixtureServer } from '../helpers/fixture-server';
import { copyFixture, snapshotTree } from '../helpers/tree';
import { removeTempDirs } from '../helpers/temp';
import { launchApp } from './launch';

// Step 12: the Integrations page and the AI-assisted features against a stand-in Ollama server on 127.0.0.1 that answers with
// recorded responses. No real model is used and nothing leaves this PC.

let userData: string;
let folder: string;
let server: FixtureServer;
test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'gdcc-e2e-providers-'));
  folder = copyFixture('audit-godot');
  server = await startFixtureServer();
  server.route('GET /api/version', (_req, res) => sendJson(res, fixture('ollama', 'version.json')));
  server.route('GET /api/tags', (_req, res) => sendJson(res, fixture('ollama', 'tags.json')));
  server.route('GET /api/ps', (_req, res) => sendJson(res, fixture('ollama', 'ps.json')));
  server.route('POST /api/show', (_req, res) => sendJson(res, fixture('ollama', 'show-llama.json')));
  server.route('POST /api/pull', (_req, res) => sendLines(res, fixture('ollama', 'pull-stream.ndjson'), 5));
  server.route('POST /api/generate', (_req, res, body) => {
    const prompt = (body as { prompt?: string }).prompt ?? '';
    const answer = prompt.includes('JSON only')
      ? '{"steps":[{"title":"Add the crouch input","acceptance":["C toggles crouch"]},{"title":"Lower the camera","acceptance":[]}]}'
      : prompt.includes('project documentation')
        ? '# Decisions\n\n- TODO: confirm the engine version\n'
        : 'OK';
    sendLines(res, `${JSON.stringify({ model: 'llama3.2:1b', response: answer, done: false })}\n${JSON.stringify({ model: 'llama3.2:1b', response: '', done: true, prompt_eval_count: 5, eval_count: 2 })}`, 5);
  });
});
test.afterAll(async () => {
  await server.close();
  rmSync(userData, { recursive: true, force: true });
  removeTempDirs();
});
test.describe.configure({ mode: 'serial' });

const answer = (app: ElectronApplication, value: unknown): Promise<void> =>
  app.evaluate(
    ({ dialog }, result) => {
      (dialog as unknown as Record<string, unknown>)['showMessageBox'] = () => Promise.resolve(result);
    },
    value,
  );
const pick = (app: ElectronApplication, chosen: string): Promise<void> =>
  app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] });
  }, chosen);
const setSetting = (page: Page, key: string, value: unknown): Promise<unknown> =>
  page.evaluate(([k, v]) => window.api.invoke('settings:set', { key: k as 'providers.ollamaEndpoint', value: v }), [key, value]);

test('the Integrations page detects the stand-in Ollama, lists its models with the context length the model states, and tests one', async () => {
  const { app, page } = await launchApp(userData);
  try {
    await setSetting(page, 'providers.ollamaEndpoint', server.origin);
    await page.getByRole('button', { name: /^Integrations/ }).click();
    const card = page.getByRole('region', { name: 'Ollama (local)' });
    await card.getByRole('button', { name: 'Check Ollama (local) again' }).click();
    await expect(card).toContainText('Ollama 0.12.6 is running with 2 models.');
    await expect(card).toContainText('Unavailable from this provider');
    const table = card.getByRole('table', { name: 'Ollama models' });
    await expect(table).toContainText('llama3.2:1b');
    await expect(table).toContainText('up to 131,072');

    await card.getByLabel('Test a model').selectOption('llama3.2:1b');
    await card.getByRole('button', { name: 'Send a test prompt' }).click();
    await expect(card.getByRole('status')).toContainText('answered in');
    await expect(card.getByRole('status')).toContainText('OK');
    expect(server.seen.find((s) => s.path === '/api/generate')?.body).toMatchObject({ model: 'llama3.2:1b', stream: true });

    // Claude Code and Codex report what this PC really has; whichever it is, a status and a message are shown.
    for (const name of ['Claude Code', 'Codex CLI']) {
      const other = page.getByRole('region', { name, exact: true });
      await expect(other.locator('.badge').first()).toHaveText(/Installed|Not installed|Error|Working|Needs setup/);
      await expect(other).toContainText('Unavailable from this provider');
    }
  } finally {
    await app.close();
  }
});

test('a download asks first, and nothing is requested when the person says no', async () => {
  const { app, page } = await launchApp(userData);
  try {
    await setSetting(page, 'providers.ollamaEndpoint', server.origin);
    await page.getByRole('button', { name: /^Integrations/ }).click();
    const card = page.getByRole('region', { name: 'Ollama (local)' });
    await card.getByRole('button', { name: 'Check Ollama (local) again' }).click();
    await card.getByLabel('Download a model').fill('llama3.2:3b');
    const before = server.seen.filter((s) => s.path === '/api/pull').length;
    await answer(app, { response: 1, checkboxChecked: false });
    await card.getByRole('button', { name: 'Download…' }).click();
    await page.waitForTimeout(300);
    expect(server.seen.filter((s) => s.path === '/api/pull').length).toBe(before);

    await answer(app, { response: 0, checkboxChecked: false });
    await card.getByRole('button', { name: 'Download…' }).click();
    await expect(card).toContainText('llama3.2:3b was downloaded.');
    expect(server.seen.filter((s) => s.path === '/api/pull').at(-1)?.body).toEqual({ model: 'llama3.2:3b', stream: true });
  } finally {
    await app.close();
  }
});

test('AI-assisted steps and a document draft arrive in the form for review; nothing is created or saved on its own', async () => {
  const before = snapshotTree(folder);
  const { app, page } = await launchApp(userData);
  try {
    await setSetting(page, 'providers.ollamaEndpoint', server.origin);
    await pick(app, folder);
    await page.getByRole('button', { name: 'Project switcher' }).click();
    await page.getByRole('menuitem', { name: 'Add a project…' }).click();

    await page.getByRole('button', { name: /^Tasks and Roadmap/ }).click();
    await page.getByRole('button', { name: 'Break a feature down…' }).click();
    const form = page.getByRole('region', { name: 'Break a feature down' });
    await form.getByLabel('Feature').fill('Crouching');
    await form.getByText('Suggest steps with AI (optional)').click();
    await form.getByLabel('Provider').selectOption('ollama');
    await form.getByLabel('Model').selectOption('llama3.2:1b');
    await form.getByRole('button', { name: 'Suggest steps' }).click();
    await expect(form).toContainText('2 steps suggested.');
    await expect(form.getByLabel(/^Steps/)).toHaveValue('Add the crouch input :: C toggles crouch\nLower the camera');
    const prompt = (server.seen.filter((s) => s.path === '/api/generate').at(-1)?.body as { prompt: string }).prompt;
    expect(prompt).toContain('"audit-godot"');
    expect(prompt).toContain('Feature: Crouching');
    expect(prompt).not.toContain('Godot project file'); // no project file went along
    await expect(page.getByRole('region', { name: 'Planned' })).not.toContainText('Crouching'); // nothing was created
    await form.getByRole('button', { name: 'Cancel' }).click();

    await page.getByRole('button', { name: /^Project Context/ }).click();
    await page.getByRole('button', { name: 'Create Decisions' }).click();
    const editor = page.getByRole('region', { name: 'Editing Decisions' });
    await editor.getByText('Draft with AI (optional)').click();
    await editor.getByLabel('Provider').selectOption('ollama');
    await editor.getByLabel('Model').selectOption('llama3.2:1b');
    await editor.getByRole('button', { name: 'Draft' }).click();
    await expect(editor.getByLabel('Document text')).toHaveValue(/TODO: confirm the engine version/);
    await editor.getByRole('button', { name: 'Preview changes' }).click();
    await expect(editor.getByLabel('Changes')).toContainText('TODO: confirm the engine version');
    expect(snapshotTree(folder)).toEqual(before);
  } finally {
    await app.close();
  }
});

test('an Ollama address that is not this PC is refused until it is allowed on purpose', async () => {
  const { app, page } = await launchApp(userData);
  try {
    await setSetting(page, 'providers.ollamaEndpoint', 'http://ollama.example.test:11434');
    await page.getByRole('button', { name: /^Integrations/ }).click();
    const card = page.getByRole('region', { name: 'Ollama (local)' });
    await card.getByRole('button', { name: 'Check Ollama (local) again' }).click();
    await expect(card).toContainText('is not this PC');
    await expect(card.locator('.badge').first()).toHaveText('Error');
  } finally {
    await app.close();
  }
});
