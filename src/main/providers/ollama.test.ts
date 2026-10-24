import { afterEach, describe, expect, it } from 'vitest';
import type { AppError } from '@shared/errors';
import type { PullProgress } from '@shared/providers';
import { fixture, sendJson, sendLines, startFixtureServer, type FixtureServer } from '../../../test/helpers/fixture-server';
import { memoryLogger } from '../../../test/helpers/logger';
import { createOllamaAdapter } from './ollama';

const servers: FixtureServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function setup(overrides: { endpoint?: string; allowRemote?: boolean; timeoutMs?: number; contextLength?: number; keepAliveMinutes?: number; program?: string | undefined } = {}) {
  const server = await startFixtureServer();
  servers.push(server);
  server.route('GET /api/version', (_req, res) => sendJson(res, fixture('ollama', 'version.json')));
  server.route('GET /api/tags', (_req, res) => sendJson(res, fixture('ollama', 'tags.json')));
  server.route('GET /api/ps', (_req, res) => sendJson(res, fixture('ollama', 'ps.json')));
  server.route('POST /api/show', (_req, res, body) => sendJson(res, fixture('ollama', (body as { model: string }).model.startsWith('qwen') ? 'show-qwen.json' : 'show-llama.json')));
  const adapter = createOllamaAdapter({
    endpoint: () => overrides.endpoint ?? server.origin,
    allowRemote: () => overrides.allowRemote ?? false,
    timeoutMs: () => overrides.timeoutMs ?? 5000,
    contextLength: () => overrides.contextLength ?? 0,
    keepAliveMinutes: () => overrides.keepAliveMinutes ?? 5,
    locateProgram: () => ('program' in overrides ? overrides.program : 'C:\\Ollama\\ollama.exe'),
    logger: memoryLogger(),
  });
  return { server, adapter };
}

const codeOf = async (promise: Promise<unknown>): Promise<AppError> => {
  try {
    await promise;
  } catch (error) {
    return error as AppError;
  }
  throw new Error('expected a failure');
};

describe('Ollama: detection', () => {
  it('is working when it answers and has models, and reports what it found', async () => {
    const { adapter, server } = await setup();
    const status = await adapter.detect();
    expect(status).toMatchObject({ id: 'ollama', status: 'working', version: '0.12.6', location: 'local', quota: 'Unavailable from this provider' });
    expect(status.details).toContainEqual({ label: 'Models', value: '2' });
    expect(status.details).toContainEqual({ label: 'Address', value: server.origin });
    expect(status.capabilities).toMatchObject({ models: true, streaming: true, cancellation: true, contextLength: true });
  });

  it('needs setup when it is running but has no models, and says what to do', async () => {
    const { adapter, server } = await setup();
    server.route('GET /api/tags', (_req, res) => sendJson(res, '{"models":[]}'));
    const status = await adapter.detect();
    expect(status.status).toBe('needs-setup');
    expect(status.hint).toContain('Download a model');
  });

  it('is installed but not running when nothing answers and the program exists; not installed when it does not', async () => {
    const closed = await setup();
    const address = closed.server.origin;
    await closed.server.close();
    servers.length = 0;
    const base = { endpoint: address, timeoutMs: 1000 };
    const installed = await createOllamaAdapter({ endpoint: () => base.endpoint, allowRemote: () => false, timeoutMs: () => 1000, contextLength: () => 0, keepAliveMinutes: () => 5, locateProgram: () => 'C:\\Ollama\\ollama.exe', logger: memoryLogger() }).detect();
    expect(installed).toMatchObject({ status: 'installed', message: 'Ollama is installed but not running.' });
    expect(installed.hint).toContain('Start Ollama');
    const missing = await createOllamaAdapter({ endpoint: () => base.endpoint, allowRemote: () => false, timeoutMs: () => 1000, contextLength: () => 0, keepAliveMinutes: () => 5, locateProgram: () => undefined, logger: memoryLogger() }).detect();
    expect(missing.status).toBe('not-installed');
    expect(missing.hint).toContain('never installs');
  });

  it('reports an error for a server that answers something else, without throwing', async () => {
    const { adapter, server } = await setup();
    server.route('GET /api/version', (_req, res) => sendJson(res, '{"unexpected":true}'));
    expect((await adapter.detect()).status).toBe('error');
    server.route('GET /api/version', (_req, res) => sendJson(res, '{"error":"boom"}', 500));
    const status = await adapter.detect();
    expect(status.status).toBe('error');
    expect(status.message).toContain('500');
  });

  it('refuses an address that is not this PC unless remote use is allowed, and an address that is not a web address', async () => {
    const remote = await setup({ endpoint: 'http://ollama.example.com:11434' });
    const refused = await remote.adapter.detect();
    expect(refused.status).toBe('error');
    expect(refused.message).toContain('is not this PC');
    expect(await codeOf(remote.adapter.generate({ model: 'm', prompt: 'p', signal: new AbortController().signal }))).toMatchObject({ code: 'PERMISSION_DENIED' });
    for (const bad of ['not a url', 'ftp://127.0.0.1:11434', 'file:///C:/x']) {
      const status = await (await setup({ endpoint: bad })).adapter.detect();
      expect(status.status, bad).toBe('error');
    }
    // Allowing a remote address is an explicit choice; the request is then attempted (and here fails because nothing is there).
    const allowed = await setup({ endpoint: 'http://127.0.0.2:9', allowRemote: true, timeoutMs: 500 });
    expect((await allowed.adapter.detect()).message).not.toContain('is not this PC');
  });
});

describe('Ollama: models', () => {
  it('lists local models with size, family, parameters, quantization, the context length from the model metadata, and which are loaded', async () => {
    const { adapter } = await setup();
    const models = await adapter.models?.();
    expect(models).toEqual([
      { name: 'llama3.2:1b', sizeBytes: 1321098329, modifiedAt: '2026-10-01T10:00:00Z', family: 'llama', parameterSize: '1.2B', quantization: 'Q8_0', contextLength: 131072, loaded: true },
      { name: 'qwen2.5-coder:7b', sizeBytes: 4683087332, modifiedAt: '2026-10-02T10:00:00Z', family: 'qwen2', parameterSize: '7.6B', quantization: 'Q4_K_M', contextLength: 32768, loaded: false },
    ]);
  });

  it('leaves the context length empty when the model does not say, and still lists the model', async () => {
    const { adapter, server } = await setup();
    server.route('POST /api/show', (_req, res) => sendJson(res, '{"model_info":{}}'));
    server.route('GET /api/ps', (_req, res) => sendJson(res, '{"error":"x"}', 500)); // the loaded list is a nicety
    const models = await adapter.models?.();
    expect(models?.map((m) => [m.name, m.contextLength, m.loaded])).toEqual([['llama3.2:1b', null, false], ['qwen2.5-coder:7b', null, false]]);
  });
});

describe('Ollama: generating', () => {
  it('streams the answer, reports usage as the provider returned it, and sends only the model, the prompt, the stream flag and the keep-alive setting', async () => {
    const { adapter, server } = await setup();
    server.route('POST /api/generate', (_req, res) => sendLines(res, fixture('ollama', 'generate-stream.ndjson')));
    const partial: string[] = [];
    const result = await adapter.generate({ model: 'llama3.2:1b', prompt: 'Say hello', signal: new AbortController().signal, onText: (t) => partial.push(t) });
    expect(result.text).toBe('Hello world');
    expect(partial).toEqual(['Hel', 'Hello ', 'Hello world']);
    expect(result.usage).toEqual({ inputCount: 12, outputCount: 3, costUsdEstimate: null });
    expect(server.seen.find((s) => s.path === '/api/generate')?.body).toEqual({ model: 'llama3.2:1b', prompt: 'Say hello', stream: true, keep_alive: '5m' });
  });

  it('asks for the configured context length, and only when one is configured', async () => {
    const { adapter, server } = await setup({ contextLength: 16384 });
    server.route('POST /api/generate', (_req, res) => sendLines(res, fixture('ollama', 'generate-stream.ndjson'), 0));
    await adapter.generate({ model: 'llama3.2:1b', prompt: 'p', signal: new AbortController().signal });
    expect(server.seen.find((s) => s.path === '/api/generate')?.body).toMatchObject({ options: { num_ctx: 16384 } });
  });

  it('a keep-alive of 0 minutes asks Ollama to unload the model right after the answer', async () => {
    const { adapter, server } = await setup({ keepAliveMinutes: 0 });
    server.route('POST /api/generate', (_req, res) => sendLines(res, fixture('ollama', 'generate-stream.ndjson'), 0));
    await adapter.generate({ model: 'llama3.2:1b', prompt: 'p', signal: new AbortController().signal });
    expect(server.seen.find((s) => s.path === '/api/generate')?.body).toMatchObject({ keep_alive: 0 });
  });

  it('says plainly when the model does not exist, when Ollama reports an error mid-stream, and when no model was chosen', async () => {
    const { adapter, server } = await setup();
    server.route('POST /api/generate', (_req, res) => sendJson(res, fixture('ollama', 'model-not-found.json'), 404));
    const missing = await codeOf(adapter.generate({ model: 'nope:1b', prompt: 'p', signal: new AbortController().signal }));
    expect(missing).toMatchObject({ code: 'NOT_FOUND' });
    expect(missing.hint).toContain('download');
    server.route('POST /api/generate', (_req, res) => sendLines(res, fixture('ollama', 'generate-error.ndjson'), 0));
    const memory = await codeOf(adapter.generate({ model: 'qwen2.5-coder:7b', prompt: 'p', signal: new AbortController().signal }));
    expect(memory).toMatchObject({ code: 'TOOL_FAILED' });
    expect(memory.message).toContain('more system memory');
    expect(await codeOf(adapter.generate({ model: '', prompt: 'p', signal: new AbortController().signal }))).toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('stops when cancelled, and the connection is closed so Ollama stops generating', async () => {
    const { adapter, server } = await setup();
    const many = Array.from({ length: 200 }, (_, i) => `{"model":"m","response":"w${i} ","done":false}`).join('\n');
    server.route('POST /api/generate', (_req, res) => sendLines(res, many, 10));
    const controller = new AbortController();
    const running = adapter.generate({ model: 'llama3.2:1b', prompt: 'p', signal: controller.signal, onText: (t) => t.length > 12 && controller.abort() });
    expect(await codeOf(running)).toMatchObject({ code: 'CANCELLED' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(server.closedEarly()).toBeGreaterThanOrEqual(1);
  });

  it('gives up after the time limit with a message that says what to do', async () => {
    const { adapter, server } = await setup({ timeoutMs: 150 });
    server.route('POST /api/generate', () => undefined); // never answers
    const error = await codeOf(adapter.generate({ model: 'llama3.2:1b', prompt: 'p', signal: new AbortController().signal }));
    expect(error).toMatchObject({ code: 'TIMEOUT', retryable: true });
    expect(error.hint).toContain('time limit');
  });

  it('rejects a line it cannot read instead of guessing', async () => {
    const { adapter, server } = await setup();
    server.route('POST /api/generate', (_req, res) => sendLines(res, 'this is not json', 0));
    expect(await codeOf(adapter.generate({ model: 'llama3.2:1b', prompt: 'p', signal: new AbortController().signal }))).toMatchObject({ code: 'TOOL_FAILED' });
  });
});

describe('Ollama: loading and downloading models', () => {
  it('warm-up loads the model and keeps it for five minutes, and nothing else', async () => {
    const { adapter, server } = await setup();
    server.route('POST /api/generate', (_req, res) => sendJson(res, '{"model":"llama3.2:1b","done":true}'));
    await adapter.warmUp?.('llama3.2:1b', new AbortController().signal);
    expect(server.seen.find((s) => s.path === '/api/generate')?.body).toEqual({ model: 'llama3.2:1b', keep_alive: '5m', stream: false });
  });

  it('unloading sends only the model with keep_alive 0, the documented way to release it', async () => {
    const { adapter, server } = await setup();
    server.route('POST /api/generate', (_req, res) => sendJson(res, '{"model":"llama3.2:1b","done":true,"done_reason":"unload"}'));
    await adapter.unload?.('llama3.2:1b', new AbortController().signal);
    expect(server.seen.find((s) => s.path === '/api/generate')?.body).toEqual({ model: 'llama3.2:1b', keep_alive: 0 });
  });

  it('a download reports progress as Ollama sends it and ends with success; it can be cancelled', async () => {
    const { adapter, server } = await setup();
    server.route('POST /api/pull', (_req, res) => sendLines(res, fixture('ollama', 'pull-stream.ndjson'), 0));
    const progress: PullProgress[] = [];
    await adapter.pull?.('llama3.2:1b', new AbortController().signal, (p) => progress.push(p));
    expect(progress.map((p) => [p.status, p.completed, p.total, p.done])).toEqual([
      ['pulling manifest', null, null, false],
      ['pulling abc', 250, 1000, false],
      ['pulling abc', 1000, 1000, false],
      ['verifying sha256 digest', null, null, false],
      ['success', null, null, true],
    ]);
    expect(server.seen.find((s) => s.path === '/api/pull')?.body).toEqual({ model: 'llama3.2:1b', stream: true });

    const slow = Array.from({ length: 100 }, (_, i) => `{"status":"pulling x","total":100,"completed":${i}}`).join('\n');
    server.route('POST /api/pull', (_req, res) => sendLines(res, slow, 10));
    const controller = new AbortController();
    const running = adapter.pull?.('big:70b', controller.signal, (p) => (p.completed ?? 0) > 3 && controller.abort());
    expect(await codeOf(running as Promise<void>)).toMatchObject({ code: 'CANCELLED' });
  });
});
