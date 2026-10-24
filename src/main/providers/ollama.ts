import { z } from 'zod';
import { AppError } from '@shared/errors';
import { QUOTA_UNAVAILABLE, type Capabilities, type OllamaModel, type PullProgress } from '@shared/providers';
import type { Logger } from '../logging';
import type { GenerateRequest, ProviderAdapter, ProviderOutput } from './types';

// Ollama over its documented local HTTP API (docs.ollama.com/api, checked 2026-10-24): GET /api/version, GET /api/tags,
// POST /api/show, GET /api/ps, POST /api/generate (NDJSON stream; closing the request stops generation; keep_alive 0 unloads a
// model, docs.ollama.com/faq checked 2026-10-24) and POST /api/pull.
// Only this module uses `fetch` (ARCHITECTURE.md section 4). The endpoint is configurable, but a non-loopback host needs an
// explicit setting, because a prompt sent there leaves this PC.

export interface OllamaOptions {
  endpoint: () => string;
  allowRemote: () => boolean;
  timeoutMs: () => number;
  /** 0 means the model's own default. */
  contextLength: () => number;
  /** Minutes a model stays loaded after a request (documented keep_alive); 0 unloads it right after the answer. */
  keepAliveMinutes: () => number;
  /** The Ollama program, if installed, to tell "installed but not running" from "not installed". */
  locateProgram: () => string | undefined;
  logger: Logger;
  fetch?: typeof fetch;
}

const CAPABILITIES: Capabilities = { models: true, streaming: true, cancellation: true, contextLength: true, structuredOutput: false, usageReporting: true, readOnlyMode: true };

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const DETECT_TIMEOUT_MS = 3000;
const SHORT_TIMEOUT_MS = 8000;

const VersionSchema = z.object({ version: z.string() });
const TagsSchema = z.object({
  models: z.array(
    z.object({
      name: z.string(),
      modified_at: z.string().optional(),
      size: z.number().optional(),
      details: z.object({ family: z.string().optional(), parameter_size: z.string().optional(), quantization_level: z.string().optional() }).partial().optional(),
    }),
  ),
});
const PsSchema = z.object({ models: z.array(z.object({ name: z.string() })) });
const ShowSchema = z.object({ model_info: z.record(z.string(), z.unknown()).optional() });

export function createOllamaAdapter(options: OllamaOptions): ProviderAdapter {
  const { logger } = options;
  const doFetch = options.fetch ?? fetch;

  const baseUrl = (): URL => {
    let url: URL;
    try {
      url = new URL(options.endpoint());
    } catch {
      throw new AppError('INVALID_INPUT', 'The Ollama address is not a valid web address.', { hint: 'Use something like http://127.0.0.1:11434.' });
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new AppError('INVALID_INPUT', 'The Ollama address must start with http:// or https://.');
    if (!LOOPBACK.has(url.hostname) && !options.allowRemote())
      throw new AppError('PERMISSION_DENIED', `Ollama is set to ${url.host}, which is not this PC.`, {
        hint: 'Prompts would leave this PC. Use 127.0.0.1, or allow a remote Ollama in the settings if you mean it.',
      });
    return url;
  };

  /** One request. Connection failures and timeouts become errors that say what to do. */
  async function call(path: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
    const url = new URL(path, baseUrl());
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    const started = Date.now();
    try {
      return await doFetch(url, { ...init, signal: combined });
    } catch (error) {
      if (signal?.aborted === true) throw new AppError('CANCELLED', 'Stopped.', { cause: error });
      if (timeout.aborted)
        throw new AppError('TIMEOUT', `Ollama did not answer within ${Math.round(timeoutMs / 1000)} seconds.`, {
          hint: 'The model may still be loading, or the request is too large. Try again, or raise the time limit in the settings.',
          retryable: true,
          details: { endpoint: url.origin, path, elapsedMs: Date.now() - started },
        });
      throw new AppError('TOOL_NOT_RUNNING', `Ollama is not answering at ${url.origin}.`, {
        hint: 'Start Ollama (from the Start menu), then check again.',
        retryable: true,
        cause: error,
        details: { endpoint: url.origin, path },
      });
    }
  }

  async function json<T>(path: string, schema: z.ZodType<T>, timeoutMs = SHORT_TIMEOUT_MS, init: RequestInit = {}): Promise<T> {
    const response = await call(path, init, timeoutMs);
    if (!response.ok) throw await httpError(response, path);
    const parsed = schema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) throw new AppError('TOOL_FAILED', `Ollama answered ${path} in a form this app does not understand.`, { hint: 'The Ollama version may be newer or older than expected.', details: { path } });
    return parsed.data;
  }

  async function httpError(response: Response, path: string): Promise<AppError> {
    const body = (await response.text().catch(() => '')).slice(0, 400);
    let message = body;
    try {
      const parsed = JSON.parse(body) as { error?: unknown };
      if (typeof parsed.error === 'string') message = parsed.error;
    } catch {
      // not JSON: use the text as it is
    }
    if (response.status === 404 && /model/i.test(message))
      return new AppError('NOT_FOUND', `Ollama does not have that model: ${message}`, { hint: 'Choose a model from the list, or download it first.', details: { path, status: 404 } });
    return new AppError('TOOL_FAILED', `Ollama answered ${response.status}${message === '' ? '' : `: ${message}`}`, { hint: 'Details are in the log.', details: { path, status: response.status } });
  }

  /** Reads newline-delimited JSON from a streaming response and hands each object to `onLine`. */
  async function readLines(response: Response, onLine: (value: Record<string, unknown>) => void): Promise<void> {
    if (response.body === null) return;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const flush = (line: string): void => {
      if (line.trim() === '') return;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw new AppError('TOOL_FAILED', 'Ollama sent a line this app could not read.', { hint: 'Details are in the log.', details: { line: line.slice(0, 200) } });
      }
      if (typeof value === 'object' && value !== null) {
        const record = value as Record<string, unknown>;
        if (typeof record['error'] === 'string') throw new AppError('TOOL_FAILED', `Ollama reported: ${record['error']}`, { details: { error: record['error'].slice(0, 300) } });
        onLine(record);
      }
    };
    for (;;) {
      const chunk = (await reader.read()) as { done: boolean; value?: Uint8Array };
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        flush(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
      }
    }
    flush(buffer + decoder.decode());
  }

  const details = (rows: [string, string][]): { label: string; value: string }[] => rows.map(([label, value]) => ({ label, value }));

  return {
    id: 'ollama',
    capabilities: CAPABILITIES,

    async detect() {
      const base = { id: 'ollama' as const, label: 'Ollama (local)', location: 'local' as const, capabilities: CAPABILITIES, quota: QUOTA_UNAVAILABLE };
      let endpoint: string;
      try {
        endpoint = baseUrl().origin;
      } catch (error) {
        const e = error as AppError;
        return { ...base, status: 'error', version: null, message: e.message, hint: e.hint ?? '', details: details([['Address', options.endpoint().slice(0, 200)]]) };
      }
      const program = options.locateProgram();
      const rows: [string, string][] = [['Address', endpoint], ['Program', program ?? 'not found']];
      try {
        const { version } = await json('/api/version', VersionSchema, DETECT_TIMEOUT_MS);
        rows.push(['Version', version]);
        let names: string[] = [];
        try {
          names = (await json('/api/tags', TagsSchema)).models.map((m) => m.name);
        } catch (error) {
          logger.warn('ollama model list failed during detection', { error });
        }
        rows.push(['Models', String(names.length)]);
        if (names.length === 0)
          return { ...base, status: 'needs-setup', version, message: 'Ollama is running but has no models yet.', hint: 'Download a model below. Ollama does not say how big it is before it starts, so choose a small one first.', details: details(rows) };
        return { ...base, status: 'working', version, message: `Ollama ${version} is running with ${names.length} model${names.length === 1 ? '' : 's'}.`, hint: '', details: details(rows) };
      } catch (error) {
        const e = error as AppError;
        if (e.code === 'TOOL_NOT_RUNNING' || e.code === 'TIMEOUT') {
          if (program === undefined)
            return { ...base, status: 'not-installed', version: null, message: 'Ollama was not found on this PC and nothing is answering at the address.', hint: 'Install Ollama from ollama.com if you want local models. The app never installs it for you.', details: details(rows) };
          return { ...base, status: 'installed', version: null, message: 'Ollama is installed but not running.', hint: 'Start Ollama from the Start menu, then press Check again.', details: details(rows) };
        }
        return { ...base, status: 'error', version: null, message: e.message, hint: e.hint ?? 'Details are in the log.', details: details(rows) };
      }
    },

    async models() {
      const [tags, loaded] = await Promise.all([json('/api/tags', TagsSchema), json('/api/ps', PsSchema).catch(() => ({ models: [] as { name: string }[] }))]);
      const running = new Set(loaded.models.map((m) => m.name));
      const contextOf = async (name: string): Promise<number | null> => {
        try {
          const show = await json('/api/show', ShowSchema, SHORT_TIMEOUT_MS, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: name }) });
          const info = show.model_info ?? {};
          const arch = info['general.architecture'];
          const value = typeof arch === 'string' ? info[`${arch}.context_length`] : undefined;
          return typeof value === 'number' ? value : null;
        } catch {
          return null;
        }
      };
      return Promise.all(
        tags.models.slice(0, 50).map(
          async (m): Promise<OllamaModel> => ({
            name: m.name,
            sizeBytes: m.size ?? null,
            modifiedAt: m.modified_at ?? null,
            family: m.details?.family ?? null,
            parameterSize: m.details?.parameter_size ?? null,
            quantization: m.details?.quantization_level ?? null,
            contextLength: await contextOf(m.name),
            loaded: running.has(m.name),
          }),
        ),
      );
    },

    async warmUp(model, signal) {
      const response = await call('/api/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, keep_alive: '5m', stream: false }) }, options.timeoutMs(), signal);
      if (!response.ok) throw await httpError(response, '/api/generate');
      await response.text();
    },

    // A request with only the model and keep_alive 0 unloads it (docs.ollama.com/faq).
    async unload(model, signal) {
      const response = await call('/api/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, keep_alive: 0 }) }, SHORT_TIMEOUT_MS, signal);
      if (!response.ok) throw await httpError(response, '/api/generate');
      await response.text();
    },

    async pull(model, signal, onProgress) {
      const response = await call('/api/pull', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, stream: true }) }, 6 * 60 * 60 * 1000, signal);
      if (!response.ok) throw await httpError(response, '/api/pull');
      await readLines(response, (line) => {
        const status = typeof line['status'] === 'string' ? line['status'] : '';
        onProgress({ model, status, completed: typeof line['completed'] === 'number' ? line['completed'] : null, total: typeof line['total'] === 'number' ? line['total'] : null, done: status === 'success' } satisfies PullProgress);
      }).catch((error: unknown) => {
        if (signal.aborted) throw new AppError('CANCELLED', 'The download was stopped. What was already downloaded is kept by Ollama.', { cause: error });
        throw error;
      });
    },

    async generate(request: GenerateRequest): Promise<ProviderOutput> {
      if (request.model === '') throw new AppError('INVALID_INPUT', 'Choose an Ollama model first.', { hint: 'Pick one from the list on the Integrations page.' });
      const num_ctx = options.contextLength();
      const keep = options.keepAliveMinutes();
      const body = { model: request.model, prompt: request.prompt, stream: true, keep_alive: keep === 0 ? 0 : `${keep}m`, ...(num_ctx > 0 ? { options: { num_ctx } } : {}) };
      const response = await call('/api/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, options.timeoutMs(), request.signal);
      if (!response.ok) throw await httpError(response, '/api/generate');
      let text = '';
      let input: number | null = null;
      let output: number | null = null;
      try {
        await readLines(response, (line) => {
          if (typeof line['response'] === 'string' && line['response'] !== '') {
            text += line['response'];
            request.onText?.(text);
          }
          if (line['done'] === true) {
            input = typeof line['prompt_eval_count'] === 'number' ? line['prompt_eval_count'] : null;
            output = typeof line['eval_count'] === 'number' ? line['eval_count'] : null;
          }
        });
      } catch (error) {
        if (request.signal.aborted) throw new AppError('CANCELLED', 'Stopped. The partial answer was discarded.', { cause: error });
        if (error instanceof AppError) throw error;
        throw new AppError('TIMEOUT', 'Ollama stopped answering.', { hint: 'Try again, or raise the time limit in the settings.', cause: error, retryable: true });
      }
      return { text, usage: { inputCount: input, outputCount: output, costUsdEstimate: null } };
    },
  };
}
