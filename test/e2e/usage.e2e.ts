import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { fixture, sendJson, sendLines, startFixtureServer, type FixtureServer } from '../helpers/fixture-server';
import { removeTempDirs } from '../helpers/temp';
import { launchApp } from './launch';

// Step 14: the usage log in the real app. Requests go to a stand-in Ollama on 127.0.0.1; nothing is sent to a cloud service, so
// no subscription usage is spent. The first answer carries token counts, the second does not, and the page must show the
// counts for the first and "Unavailable from this provider" (never zero) for the second.

let userData: string;
let server: FixtureServer;
let answers = 0;
test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'gdcc-e2e-usage-'));
  server = await startFixtureServer();
  server.route('GET /api/version', (_req, res) => sendJson(res, fixture('ollama', 'version.json')));
  server.route('GET /api/tags', (_req, res) => sendJson(res, fixture('ollama', 'tags.json')));
  server.route('GET /api/ps', (_req, res) => sendJson(res, fixture('ollama', 'ps.json')));
  server.route('POST /api/show', (_req, res) => sendJson(res, fixture('ollama', 'show-llama.json')));
  server.route('POST /api/generate', (_req, res) => {
    answers += 1;
    const done = answers === 1 ? { model: 'llama3.2:1b', response: '', done: true, prompt_eval_count: 12, eval_count: 4 } : { model: 'llama3.2:1b', response: '', done: true };
    sendLines(res, `${JSON.stringify({ model: 'llama3.2:1b', response: 'OK', done: false })}\n${JSON.stringify(done)}`, 5);
  });
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

test('requests are logged with the usage the provider returned, and a missing number is never shown as zero', async () => {
  const { app, page } = await launchApp(userData);
  try {
    await invoke(page, 'settings:set', { key: 'providers.ollamaEndpoint', value: server.origin });
    await invoke(page, 'providers:check', { provider: 'ollama' });
    await invoke(page, 'providers:generate', { choice: { provider: 'ollama', model: 'llama3.2:1b' }, prompt: 'Say OK', purpose: 'connection-test' });
    await invoke(page, 'providers:generate', { choice: { provider: 'ollama', model: 'llama3.2:1b' }, prompt: 'Say OK again', purpose: 'connection-test' });

    await page.getByRole('button', { name: /^Integrations/ }).click();
    const panel = page.getByRole('region', { name: 'Usage and limits' });
    const table = panel.getByRole('table', { name: 'Recent requests' });
    await expect(table.getByRole('row')).toHaveCount(3); // header and two requests
    await expect(table).toContainText('12 in / 4 out');
    await expect(table).toContainText('Unavailable from this provider');
    await expect(panel.getByLabel('Usage summary')).toContainText('2 sent (0 to the cloud)');
    await expect(panel.getByLabel('Usage summary')).toContainText('12 in, 4 out');
    expect(await page.evaluate(() => document.body.innerText.includes('0 in / 0 out'))).toBe(false);

    await page.getByRole('button', { name: 'Dashboard' }).click();
    await expect(page.getByRole('region', { name: 'Usage and limits' })).toContainText('Sent today');
  } finally {
    await app.close();
  }
});

test('the log and the limits are still there after a restart', async () => {
  const { app, page } = await launchApp(userData);
  try {
    await page.getByRole('button', { name: /^Integrations/ }).click();
    const panel = page.getByRole('region', { name: 'Usage and limits' });
    await expect(panel.getByRole('table', { name: 'Recent requests' }).getByRole('row')).toHaveCount(3);
    await panel.getByLabel('Cloud launches per day (0 = no limit)').fill('3');
    await expect.poll(async () => ((await invoke(page, 'settings:get', {})) as Record<string, unknown>)['limits.cloudPerDay']).toBe(3);
    const summary = (await invoke(page, 'usage:summary', {})) as { limits: { perDay: { limit: number } } };
    expect(summary.limits.perDay.limit).toBe(3);
  } finally {
    await app.close();
  }
});
