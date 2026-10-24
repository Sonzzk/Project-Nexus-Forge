import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError, type AppError as AppErrorType } from '@shared/errors';
import type { ProviderId, PullProgress } from '@shared/providers';
import { openMigratedDb } from '../../../test/helpers/db';
import { memoryLogger } from '../../../test/helpers/logger';
import { removeTempDirs } from '../../../test/helpers/temp';
import { copyFixture } from '../../../test/helpers/tree';
import { createMockProvider, type MockProvider } from '../../../test/helpers/mock-provider';
import { createActivityLog, createRedactor } from '../logging';
import { createProjectRegistry } from '../projects';
import { createProviderService } from './service';

afterEach(removeTempDirs);

async function env(options: { envVars?: NodeJS.ProcessEnv; endpoint?: string; confirm?: boolean } = {}) {
  const { db } = await openMigratedDb();
  const logger = memoryLogger();
  const redactor = createRedactor();
  const activity = createActivityLog({ db, redactor, logger });
  const projects = createProjectRegistry({ db, activity, logger });
  const project = projects.add(copyFixture('audit-godot'));
  const adapters: Record<ProviderId, MockProvider> = { ollama: createMockProvider('ollama'), 'claude-code': createMockProvider('claude-code'), codex: createMockProvider('codex') };
  const confirms: { title: string; message: string; detail?: string | undefined }[] = [];
  const answers = { confirm: options.confirm ?? true };
  const progress: PullProgress[] = [];
  let tick = 0;
  const service = createProviderService({
    db, adapters, projects, activity, logger, redactor,
    confirm: (o) => {
      confirms.push({ title: o.title, message: o.message, detail: o.detail });
      return Promise.resolve(answers.confirm);
    },
    progress: (p) => progress.push(p),
    ollamaEndpoint: () => options.endpoint ?? 'http://127.0.0.1:11434',
    env: () => options.envVars ?? {},
    sandboxDir: () => 'C:\\Data\\provider-sandbox',
    now: () => new Date(Date.UTC(2026, 9, 24, 12, 0, tick++)),
  });
  return { db, project, projects, adapters, service, confirms, answers, progress, activity };
}

const failure = async (promise: Promise<unknown>): Promise<AppErrorType> => {
  try {
    await promise;
  } catch (error) {
    return error as AppErrorType;
  }
  throw new Error('expected a failure');
};
const local = { provider: 'ollama' as const, model: 'llama3.2:1b' };
const claude = { provider: 'claude-code' as const, model: '' };

describe('status', () => {
  it('checks every provider once, remembers the answer in the database, and records a change in the activity list', async () => {
    const e = await env();
    e.adapters.codex.status = { ...e.adapters.codex.status, status: 'not-installed', version: null, message: 'Codex CLI was not found.', hint: 'Install it.' };
    const list = await e.service.list();
    expect(list.map((s) => [s.id, s.status])).toEqual([['ollama', 'working'], ['claude-code', 'installed'], ['codex', 'not-installed']]);
    expect(list.every((s) => s.quota === 'Unavailable from this provider')).toBe(true);
    expect(e.db.get<{ n: number }>('SELECT count(*) AS n FROM provider_checks')?.n).toBe(3);
    expect((await e.service.list())[2]?.hint).toBe('Install it.'); // the hint survives being read back
    e.adapters.ollama.status = { ...e.adapters.ollama.status, status: 'installed', message: 'Ollama is installed but not running.' };
    const rechecked = await e.service.check('ollama');
    expect(rechecked.status).toBe('installed');
    expect(e.activity.list({ kinds: ['provider.status'], limit: 10 }).map((a) => a.summary)).toEqual(expect.arrayContaining(['Ollama (local): installed (1.0.0).']));
    // listing again does not look again
    e.adapters.ollama.status = { ...e.adapters.ollama.status, status: 'working' };
    expect((await e.service.list())[0]?.status).toBe('installed');
  });

  it('a command-line provider becomes "working" only after it answered a real request', async () => {
    const e = await env();
    expect((await e.service.check('claude-code')).status).toBe('installed');
    await e.service.generate(claude, 'Say OK', 'connection-test');
    expect((await e.service.check('claude-code'))).toMatchObject({ status: 'working' });
    expect((await e.service.check('claude-code')).lastSuccessAt).not.toBeNull();
  });

  it('a check that throws becomes an error status, not a crash', async () => {
    const e = await env();
    e.adapters.codex.detect = () => Promise.reject(new Error('boom'));
    expect(await e.service.check('codex')).toMatchObject({ status: 'error', message: 'The check failed unexpectedly.' });
  });
});

describe('looking at a provider while another look is under way', () => {
  it('joins the first look instead of starting a second one (two pages ask at the same time)', async () => {
    const e = await env();
    let calls = 0;
    e.adapters.codex.detect = async () => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return e.adapters.codex.status;
    };
    const [a, b] = await Promise.all([e.service.check('codex'), e.service.check('codex')]);
    expect(calls).toBe(1);
    expect(a).toEqual(b);
    await e.service.check('codex');
    expect(calls).toBe(2);
  });
});

describe('sending to a provider', () => {
  it('a local model needs no confirmation; the answer, model and timing come back', async () => {
    const e = await env();
    e.adapters.ollama.answer = 'Hello';
    const result = await e.service.generate(local, 'Say hello', 'connection-test');
    expect(result).toMatchObject({ sent: true, text: 'Hello', provider: 'ollama', model: 'llama3.2:1b', truncated: false });
    expect(e.confirms).toEqual([]);
    expect(e.adapters.ollama.requests[0]).toMatchObject({ model: 'llama3.2:1b', prompt: 'Say hello' });
    expect(e.activity.list({ kinds: ['provider.generated'], limit: 3 })[0]?.summary).toContain('answered a connection test request');
  });

  it('a cloud provider shows where the text goes and what is sent, and sends nothing when declined', async () => {
    const e = await env({ confirm: false });
    const declined = await e.service.generate(claude, 'Plan the dash move', 'task-breakdown');
    expect(declined).toMatchObject({ sent: false, text: '' });
    expect(e.adapters['claude-code'].requests).toEqual([]);
    expect(e.confirms[0]?.title).toBe('Send this to Claude Code?');
    expect(e.confirms[0]?.message).toContain('Anthropic');
    expect(e.confirms[0]?.detail).toContain('Plan the dash move');
    expect(e.confirms[0]?.detail).toContain('cannot see');
    e.answers.confirm = true;
    expect((await e.service.generate(claude, 'Plan the dash move', 'task-breakdown')).sent).toBe(true);
    expect(e.adapters['claude-code'].requests).toHaveLength(1);
  });

  it('warns when ANTHROPIC_API_KEY would make Claude Code bill the API account, without showing the key', async () => {
    const e = await env({ envVars: { ANTHROPIC_API_KEY: 'sk-ant-api03-notreal0123456789' } });
    await e.service.generate(claude, 'hi', 'connection-test');
    expect(e.confirms[0]?.detail).toContain('bill your API account instead of your subscription');
    expect(JSON.stringify(e.confirms)).not.toContain('notreal');
    const plain = await env();
    await plain.service.generate(claude, 'hi', 'connection-test');
    expect(plain.confirms[0]?.detail).not.toContain('bill your API account');
  });

  it('an Ollama address that is not this PC counts as leaving the PC and is confirmed', async () => {
    const e = await env({ endpoint: 'http://192.168.1.20:11434' });
    await e.service.generate(local, 'hi', 'connection-test');
    expect(e.confirms[0]?.message).toContain('http://192.168.1.20:11434');
  });

  it('secrets typed into the text are redacted in the preview of what is sent', async () => {
    const e = await env();
    await e.service.generate(claude, 'token is sk-ant-api03-Abcdefghijklmnop0123456789 ok', 'connection-test');
    expect(e.confirms[0]?.detail).not.toContain('Abcdefghijklmnop');
  });

  it('refuses a missing model, a bad model name, an empty or huge prompt, and a provider that is not installed', async () => {
    const e = await env();
    expect(await failure(e.service.generate({ provider: 'ollama', model: '' }, 'hi', 'connection-test'))).toMatchObject({ code: 'INVALID_INPUT' });
    expect(await failure(e.service.generate({ provider: 'ollama', model: 'bad name; rm -rf' }, 'hi', 'connection-test'))).toMatchObject({ code: 'INVALID_INPUT' });
    expect(await failure(e.service.generate(local, '   ', 'connection-test'))).toMatchObject({ code: 'INVALID_INPUT' });
    expect(await failure(e.service.generate(local, 'x'.repeat(20_001), 'connection-test'))).toMatchObject({ code: 'INVALID_INPUT' });
    e.adapters.codex.status = { ...e.adapters.codex.status, status: 'not-installed', hint: 'Install it.' };
    await e.service.check('codex');
    expect(await failure(e.service.generate({ provider: 'codex', model: '' }, 'hi', 'connection-test'))).toMatchObject({ code: 'TOOL_NOT_INSTALLED' });
    expect(e.adapters.codex.requests).toEqual([]);
  });

  it('runs one request at a time, and can stop it', async () => {
    const e = await env();
    e.adapters.ollama.hold = true;
    const first = e.service.generate(local, 'slow', 'connection-test');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await failure(e.service.generate(local, 'second', 'connection-test'))).toMatchObject({ code: 'CONFLICT' });
    expect(e.service.cancel()).toEqual({ cancelled: true });
    expect(await failure(first)).toMatchObject({ code: 'CANCELLED' });
    expect(e.service.cancel()).toEqual({ cancelled: false });
    e.adapters.ollama.hold = false;
    expect((await e.service.generate(local, 'again', 'connection-test')).sent).toBe(true);
  });

  it('records a failure in the activity list without the prompt, and passes the error on unchanged', async () => {
    const e = await env();
    e.adapters.ollama.failWith = new AppError('TOOL_NOT_RUNNING', 'Ollama is not answering.', { hint: 'Start it.' });
    expect(await failure(e.service.generate(local, 'a secret plan', 'connection-test'))).toMatchObject({ code: 'TOOL_NOT_RUNNING', hint: 'Start it.' });
    const failed = e.activity.list({ kinds: ['provider.failed'], limit: 3 })[0];
    expect(failed?.summary).toBe('Ollama (local): Ollama is not answering.');
    expect(JSON.stringify(failed)).not.toContain('a secret plan');
  });

  it('cuts an answer that is too long and says so', async () => {
    const e = await env();
    e.adapters.ollama.answer = 'x'.repeat(150_000);
    const result = await e.service.generate(local, 'hi', 'connection-test');
    expect(result.truncated).toBe(true);
    expect(result.text).toHaveLength(100_000);
  });
});

describe('models', () => {
  it('warm-up is a user action on a valid model name; a download asks first, says the size is not known, shows progress, and checks again', async () => {
    const e = await env();
    expect(await e.service.warmUp('llama3.2:1b')).toEqual({ loaded: true });
    expect(e.adapters.ollama.warmed).toEqual(['llama3.2:1b']);
    expect(await failure(e.service.warmUp('x y'))).toMatchObject({ code: 'INVALID_INPUT' });

    expect(await e.service.pull('llama3.2:1b')).toEqual({ pulled: true });
    expect(e.confirms[0]?.title).toBe('Download this model?');
    expect(e.confirms[0]?.detail).toContain('does not tell this app how big a model is');
    expect(e.progress.map((p) => p.status)).toEqual(['pulling', 'success']);
    expect(e.adapters.ollama.pulled).toEqual(['llama3.2:1b']);
  });

  it('nothing is downloaded when the person declines', async () => {
    const e = await env({ confirm: false });
    expect(await e.service.pull('llama3.2:1b')).toEqual({ pulled: false });
    expect(e.adapters.ollama.pulled).toEqual([]);
    expect(e.progress).toEqual([]);
  });

  it('only Ollama lists models', async () => {
    const e = await env();
    expect(await e.service.models('claude-code')).toEqual([]);
    expect(await e.service.models('ollama')).toEqual([]);
  });
});

describe('task breakdown and document drafting (the first uses of a provider)', () => {
  it('asks for steps, reads the JSON that comes back, and returns them for review; nothing is created', async () => {
    const e = await env();
    e.adapters.ollama.answer = '```json\n{"steps":[{"title":"Add the input","acceptance":["C toggles crouch"]},{"title":"Lower the camera","acceptance":[]}]}\n```';
    const result = await e.service.suggestSteps({ projectId: e.project.id, choice: local, title: 'Crouching', description: 'Let the player crouch.' });
    expect(result).toMatchObject({ sent: true, provider: 'ollama', steps: [{ title: 'Add the input', acceptance: ['C toggles crouch'] }, { title: 'Lower the camera', acceptance: [] }] });
    const prompt = e.adapters.ollama.requests[0]?.prompt ?? '';
    expect(prompt).toContain('"audit-godot"');
    expect(prompt).toContain('Feature: Crouching');
    expect(prompt).toContain('JSON only');
    expect(e.db.get<{ n: number }>('SELECT count(*) AS n FROM tasks')?.n).toBe(0);
  });

  it('refuses an answer that is not steps rather than guessing, and keeps a short excerpt for the log only', async () => {
    const e = await env();
    e.adapters.ollama.answer = 'Sure! First you should think about crouching.';
    const error = await failure(e.service.suggestSteps({ projectId: e.project.id, choice: local, title: 'Crouching', description: '' }));
    expect(error).toMatchObject({ code: 'TOOL_FAILED' });
    expect(error.message).toContain('did not answer with steps');
  });

  it('redacts secrets in what is sent for steps and for a document draft, and sends no file contents', async () => {
    const e = await env();
    e.adapters.ollama.answer = '[{"title":"Step one"}]';
    await e.service.suggestSteps({ projectId: e.project.id, choice: local, title: 'Use key sk-ant-api03-Abcdefghijklmnop0123456789', description: 'password=hunter2hunter2' });
    e.adapters.ollama.answer = '# Decisions';
    await e.service.draftDocument({ projectId: e.project.id, choice: local, docType: 'DECISIONS', instruction: 'Write it. token=abc12345678', currentText: 'api_key = "ZZZZZZZZZZZZZZZZZZ"' });
    const sent = e.adapters.ollama.requests.map((r) => r.prompt).join('\n');
    expect(sent).not.toMatch(/Abcdefghijklmnop|hunter2hunter2|abc12345678|ZZZZZZZZZZ/);
    expect(sent).toContain('"Decisions" document');
    expect(sent).not.toContain('Godot project file'); // nothing from the project folder
  });

  it('declined cloud requests return nothing and suggest nothing', async () => {
    const e = await env({ confirm: false });
    expect(await e.service.suggestSteps({ projectId: e.project.id, choice: claude, title: 'x', description: '' })).toMatchObject({ sent: false, steps: [] });
    expect(await e.service.draftDocument({ projectId: e.project.id, choice: claude, docType: 'TASKS', instruction: '', currentText: '' })).toMatchObject({ sent: false });
  });
});

describe('a session in the project folder', () => {
  it('runs read-only in the project folder only after saying so, and names the hooks and servers Claude Code would start there', async () => {
    const e = await env();
    mkdirSync(join(e.project.rootPath, '.claude'), { recursive: true });
    writeFileSync(join(e.project.rootPath, '.claude', 'settings.json'), '{"hooks":{}}');
    writeFileSync(join(e.project.rootPath, '.mcp.json'), '{"mcpServers":{}}');
    await e.service.runInProject({ projectId: e.project.id, choice: claude, prompt: 'Review the player script' });
    expect(e.confirms[0]?.detail).toContain('read-only mode');
    expect(e.confirms[0]?.detail).toContain('.claude/settings.json and .mcp.json');
    expect(e.confirms[0]?.detail).toContain('running code from the project');
    expect(e.adapters['claude-code'].requests[0]?.cwd).toBe(e.project.rootPath);
  });

  it('does not mention hooks when the project has none, never uses Ollama this way, and sends nothing when declined', async () => {
    const e = await env();
    await e.service.runInProject({ projectId: e.project.id, choice: claude, prompt: 'Review' });
    expect(e.confirms[0]?.detail).not.toContain('hooks');
    expect(await failure(e.service.runInProject({ projectId: e.project.id, choice: local, prompt: 'Review' }))).toMatchObject({ code: 'UNSUPPORTED' });
    const declined = await env({ confirm: false });
    expect((await declined.service.runInProject({ projectId: declined.project.id, choice: claude, prompt: 'Review' })).sent).toBe(false);
    expect(declined.adapters['claude-code'].requests).toEqual([]);
  });

  it('a text-only request has no folder at all, so the program uses its empty sandbox', async () => {
    const e = await env();
    await e.service.generate(claude, 'hi', 'connection-test');
    expect(e.adapters['claude-code'].requests[0]?.cwd).toBeUndefined();
  });
});
