import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DOC_INFO, type DocType } from '@shared/context';
import { AppError } from '@shared/errors';
import {
  MODEL_NAME,
  PROVIDER_IDS,
  PROVIDER_LABELS,
  PROVIDER_LOCATION,
  parseSuggestedSteps,
  type GeneratePurpose,
  type GenerateResult,
  type OllamaModel,
  type ProviderChoice,
  type ProviderId,
  type ProviderStatus,
  type PullProgress,
  type SuggestStepsResult,
} from '@shared/providers';
import type { ActivityLog, Logger, Redactor } from '../logging';
import type { ProjectRegistry } from '../projects';
import type { Db } from '../storage';
import type { UsageService } from '../usage';
import type { ProviderAdapter } from './types';

// The provider service (spec §9, §12): remembers what each provider last reported, runs one request at a time, and makes the
// destination of every cloud request explicit before anything is sent. It never sends a project file: requests carry only the
// text the person typed (and the project name), and the CLI programs run in an empty folder, read-only.

export type Confirm = (options: { title: string; message: string; detail?: string; confirmLabel: string }) => Promise<boolean>;

export interface ProviderService {
  list(): Promise<ProviderStatus[]>;
  check(provider: ProviderId): Promise<ProviderStatus>;
  models(provider: ProviderId): Promise<OllamaModel[]>;
  warmUp(model: string): Promise<{ loaded: true }>;
  /** Downloads an Ollama model after a confirmation that says its size is not known in advance. */
  pull(model: string): Promise<{ pulled: boolean }>;
  /** Stops the request in progress, if any. */
  cancel(): { cancelled: boolean };
  generate(choice: ProviderChoice, prompt: string, purpose: GeneratePurpose): Promise<GenerateResult>;
  suggestSteps(input: { projectId: string; choice: ProviderChoice; title: string; description: string }): Promise<SuggestStepsResult>;
  draftDocument(input: { projectId: string; choice: ProviderChoice; docType: DocType; instruction: string; currentText: string }): Promise<GenerateResult>;
  /** A read-only request that runs in the project folder. Hooks and MCP servers the project would start are confirmed first. */
  runInProject(input: { projectId: string; choice: ProviderChoice; prompt: string }): Promise<GenerateResult>;
  /** One queued agent run (Step 13): read-only, in the project folder for the coding agents, with the queue's note in the confirmation. */
  runAgent(input: AgentRequest): Promise<GenerateResult>;
  /** What is using a provider right now, if anything. */
  busy(provider: ProviderId): string | undefined;
  /** Asks Ollama to release a model from memory (keep_alive 0, its documented way). */
  unload(model: string): Promise<{ unloaded: true }>;
  /** Throws LIMIT_REACHED (and records it) when starting this run would pass a launch limit (Step 14). The queue calls it before a run waits to start. */
  checkLaunch(input: { provider: ProviderId; projectId: string; taskId: string | null; runId: string }): void;
}

export interface AgentRequest {
  projectId: string;
  choice: ProviderChoice;
  prompt: string;
  /** The route, its cost and any retry or escalation, shown before a cloud send. */
  note: string;
  signal: AbortSignal;
  /** Called after the person approved (or nothing needed approval), right before the provider is called. */
  onApproved: () => void;
  /** The run that owns the program, so the process runner refuses a second program for it. */
  ownerId: string;
  /** The run's task, for the usage log and the per-task limit. */
  taskId: string | null;
}

interface RequestExtra {
  cwd?: string;
  label: string;
  detail?: string;
  signal?: AbortSignal;
  onApproved?: () => void;
  ownerId?: string;
  /** What the usage log and the launch limits attribute the request to. */
  projectId?: string;
  taskId?: string | null;
}

export interface ProviderServiceOptions {
  db: Db;
  adapters: Record<ProviderId, ProviderAdapter>;
  projects: ProjectRegistry;
  activity: ActivityLog;
  usage: UsageService;
  logger: Logger;
  redactor: Redactor;
  confirm: Confirm;
  progress: (progress: PullProgress) => void;
  /** Where the Ollama endpoint points, for the destination text. */
  ollamaEndpoint: () => string;
  env: () => NodeJS.ProcessEnv;
  sandboxDir: () => string;
  now?: () => Date;
}

const MAX_PROMPT = 20_000;
const MAX_OUTPUT = 100_000;

interface Row {
  provider_id: string;
  checked_at: string;
  status: ProviderStatus['status'];
  version: string | null;
  message: string;
  hint: string;
  details_json: string;
  last_success_at: string | null;
}

export function createProviderService(options: ProviderServiceOptions): ProviderService {
  const { db, adapters, projects, activity, usage, logger, redactor, confirm } = options;
  const now = options.now ?? (() => new Date());
  const active = new Map<ProviderId, { controller: AbortController; label: string; queued: boolean }>();
  const checking = new Map<ProviderId, Promise<ProviderStatus>>(); // a second look at a provider joins the one already under way

  const stored = (id: ProviderId): ProviderStatus | undefined => {
    const row = db.get<Row>('SELECT * FROM provider_checks WHERE provider_id = ?', id);
    if (row === undefined) return undefined;
    const live = adapters[id];
    return {
      id,
      label: PROVIDER_LABELS[id],
      location: PROVIDER_LOCATION[id],
      status: row.status,
      version: row.version,
      message: row.message,
      hint: row.hint,
      capabilities: live.capabilities,
      quota: 'Unavailable from this provider',
      details: JSON.parse(row.details_json) as ProviderStatus['details'],
      checkedAt: row.checked_at,
      lastSuccessAt: row.last_success_at,
    };
  };

  const checkNow = async (id: ProviderId): Promise<ProviderStatus> => {
    const adapter = adapters[id];
    const before = stored(id);
    let detected;
    try {
      detected = await adapter.detect();
    } catch (error) {
      logger.error('provider check failed', { id, error });
      detected = { id, label: PROVIDER_LABELS[id], location: PROVIDER_LOCATION[id], capabilities: adapter.capabilities, quota: 'Unavailable from this provider', status: 'error' as const, version: null, message: error instanceof AppError ? error.message : 'The check failed unexpectedly.', hint: 'Details are in the log.', details: [] };
    }
    // A CLI provider that has answered a real request is "working"; detection alone can only say "installed".
    const lastSuccessAt = before?.lastSuccessAt ?? null;
    const status = detected.status === 'installed' && lastSuccessAt !== null ? ('working' as const) : detected.status;
    const result: ProviderStatus = { ...detected, status, checkedAt: now().toISOString(), lastSuccessAt };
    db.run(
      `INSERT INTO provider_checks (provider_id, checked_at, status, version, message, hint, details_json, last_success_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider_id) DO UPDATE SET checked_at = excluded.checked_at, status = excluded.status, version = excluded.version, message = excluded.message, hint = excluded.hint, details_json = excluded.details_json, last_success_at = excluded.last_success_at`,
      id, result.checkedAt, result.status, result.version, result.message, result.hint, JSON.stringify(result.details), lastSuccessAt,
    );
    // The first look is not news; a change from what was known is.
    if (before !== undefined && before.status !== result.status)
      activity.record({ kind: 'provider.status', severity: result.status === 'error' ? 'warning' : 'info', summary: `${result.label}: ${result.status.replace('-', ' ')}${result.version === null ? '' : ` (${result.version})`}.`, details: { provider: id, status: result.status } });
    return result;
  };

  const check = (id: ProviderId): Promise<ProviderStatus> => {
    const running = checking.get(id);
    if (running !== undefined) return running;
    const started = checkNow(id).finally(() => checking.delete(id));
    checking.set(id, started);
    return started;
  };

  const markSuccess = (id: ProviderId): void => {
    const stamp = now().toISOString();
    db.run('UPDATE provider_checks SET last_success_at = ?, status = CASE WHEN status = \'installed\' THEN \'working\' ELSE status END WHERE provider_id = ?', stamp, id);
  };

  /** One request per provider at a time: a second would compete for the same model or the same sign-in. A queue run brings its own signal. */
  async function exclusive<T>(id: ProviderId, label: string, work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const busy = active.get(id);
    if (busy !== undefined) throw new AppError('CONFLICT', `${busy.label} is still running.`, { hint: 'Wait for it to finish, or stop it.' });
    if (signal?.aborted === true) throw new AppError('CANCELLED', 'Stopped before it started.');
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    active.set(id, { controller, label, queued: signal !== undefined });
    try {
      return await work(controller.signal);
    } finally {
      active.delete(id);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  const destination = (id: ProviderId): string => {
    if (id === 'ollama') return `Ollama at ${options.ollamaEndpoint()}`;
    return id === 'claude-code' ? 'Claude Code (Anthropic, through your Claude Code sign-in)' : 'Codex CLI (OpenAI, through your Codex sign-in)';
  };
  const leavesThePc = (id: ProviderId): boolean => {
    if (PROVIDER_LOCATION[id] === 'cloud') return true;
    try {
      return !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(new URL(options.ollamaEndpoint()).hostname);
    } catch {
      return false;
    }
  };

  async function runRequest(choice: ProviderChoice, prompt: string, purpose: GeneratePurpose, extra: RequestExtra): Promise<GenerateResult> {
    if (!PROVIDER_IDS.includes(choice.provider)) throw new AppError('INVALID_INPUT', 'That provider does not exist.');
    if (choice.model !== '' && !MODEL_NAME.test(choice.model)) throw new AppError('INVALID_INPUT', 'That is not a valid model name.');
    const text = prompt.trim();
    if (text === '' || text.length > MAX_PROMPT) throw new AppError('INVALID_INPUT', `The request needs some text and at most ${MAX_PROMPT.toLocaleString('en-US')} characters.`);
    const id = choice.provider;
    const label = PROVIDER_LABELS[id];
    const known = stored(id) ?? (await check(id));
    if (known.status === 'not-installed') throw new AppError('TOOL_NOT_INSTALLED', `${label} is not installed.`, { hint: known.hint || 'Install it, then check again.' });
    if (id === 'ollama' && choice.model === '') throw new AppError('INVALID_INPUT', 'Choose an Ollama model first.', { hint: 'Pick one on the Integrations page.' });

    const launch = { provider: id, purpose, model: choice.model, location: leavesThePc(id) ? ('cloud' as const) : ('local' as const), projectId: extra.projectId, taskId: extra.taskId ?? undefined, runId: extra.ownerId };
    // Limits come before the confirmation: the person is never asked to approve something a limit will stop.
    usage.enforce(launch);
    if (launch.location === 'cloud') {
      const env = options.env();
      const billing = id === 'claude-code' && (env['ANTHROPIC_API_KEY'] ?? '') !== '' ? '\n\nWarning: ANTHROPIC_API_KEY is set on this PC, so Claude Code may bill your API account instead of your subscription.' : '';
      const ok = await confirm({
        title: `Send this to ${label}?`,
        message: `${extra.label} sends the text below to ${destination(id)}.`,
        detail: `${extra.detail ?? ''}${extra.detail === undefined ? '' : '\n\n'}What is sent (the first 1,200 characters):\n${redactor.redact(text).slice(0, 1200)}${text.length > 1200 ? '…' : ''}\n\nNo project file is sent unless it is in that text. Usage limits and any cost are decided by ${label}, which this app cannot see.${billing}`,
        confirmLabel: 'Send',
      });
      if (!ok) return { sent: false, text: '', provider: id, model: choice.model, elapsedMs: 0, truncated: false, usage: null };
    }

    const started = Date.now();
    return exclusive(id, `${label} request`, async (signal) => {
      extra.onApproved?.(); // the queue moves its run to running here; if that refuses, nothing is sent
      const usageId = usage.begin(launch);
      try {
        const output = await adapters[id].generate({ model: choice.model, prompt: text, signal, ...(extra.cwd === undefined ? {} : { cwd: extra.cwd }), ...(extra.ownerId === undefined ? {} : { ownerId: extra.ownerId }) });
        markSuccess(id);
        usage.finish(usageId, { status: 'completed', usage: output.usage });
        const truncated = output.text.length > MAX_OUTPUT;
        activity.record({ kind: 'provider.generated', severity: 'info', summary: `${label} answered a ${purpose.replace('-', ' ')} request (${output.text.length.toLocaleString('en-US')} characters).`, details: { provider: id, model: choice.model, purpose, promptChars: text.length, outputChars: output.text.length, usageReported: output.usage !== null } });
        return { sent: true, text: truncated ? output.text.slice(0, MAX_OUTPUT) : output.text, provider: id, model: choice.model, elapsedMs: Date.now() - started, truncated, usage: output.usage };
      } catch (error) {
        const e = error instanceof AppError ? error : new AppError('TOOL_FAILED', `${label} failed.`, { cause: error, hint: 'Details are in the log.' });
        logger.warn('provider request failed', { provider: id, code: e.code, message: e.message });
        usage.finish(usageId, { status: e.code === 'CANCELLED' ? 'cancelled' : 'failed', reason: redactor.redact(e.message) });
        activity.record({ kind: 'provider.failed', severity: e.code === 'CANCELLED' ? 'info' : 'warning', summary: `${label}: ${e.message}`, details: { provider: id, code: e.code, purpose } });
        throw e;
      }
    }, extra.signal);
  }

  /** What running in the project folder means, for the confirmation. Throws when the folder is gone. */
  const inProject = (rootPath: string, provider: ProviderId): string => {
    if (!existsSync(rootPath)) throw new AppError('NOT_FOUND', `The folder ${rootPath} could not be found.`, { hint: 'Reconnect the drive, then try again.' });
    // `claude -p` runs the hooks of .claude/settings.json and connects the servers of .mcp.json without asking (docs, headless mode).
    const runs = provider === 'claude-code' ? ['.claude/settings.json', '.mcp.json'].filter((file) => existsSync(join(rootPath, file))) : [];
    return `The program runs in ${rootPath} in read-only mode and can read files there, which then go to ${PROVIDER_LABELS[provider]}.${runs.length > 0 ? `\n\nThis project has ${runs.join(' and ')}. Claude Code runs the hooks and starts the servers they define without asking, which means running code from the project.` : ''}`;
  };

  const project = (id: string) => {
    const found = projects.get(id);
    if (found === undefined) throw new AppError('NOT_FOUND', 'That project is not in the registry.', { hint: 'It may have been removed. Reload the project list.' });
    return found;
  };

  return {
    async list() {
      return Promise.all(PROVIDER_IDS.map(async (id) => stored(id) ?? check(id)));
    },

    check,

    async models(provider) {
      const adapter = adapters[provider];
      return adapter.models === undefined ? [] : adapter.models();
    },

    async warmUp(model) {
      if (!MODEL_NAME.test(model)) throw new AppError('INVALID_INPUT', 'That is not a valid model name.');
      const adapter = adapters.ollama;
      await exclusive('ollama', 'Loading the model', (signal) => (adapter.warmUp === undefined ? Promise.reject(new AppError('UNSUPPORTED', 'Ollama cannot preload models here.')) : adapter.warmUp(model, signal)));
      activity.record({ kind: 'provider.warmed', severity: 'info', summary: `Loaded the Ollama model ${model} into memory.`, details: { model } });
      return { loaded: true };
    },

    async pull(model) {
      if (!MODEL_NAME.test(model)) throw new AppError('INVALID_INPUT', 'That is not a valid model name.', { hint: 'Use a name such as llama3.2:1b.' });
      const ok = await confirm({
        title: 'Download this model?',
        message: `Download "${model}" with Ollama?`,
        detail: `Ollama does not tell this app how big a model is before it starts, and models can be several gigabytes. The download comes from ${destination('ollama').replace('Ollama at', 'the Ollama library through Ollama at')} and uses your disk space and network. You can stop it at any time.`,
        confirmLabel: 'Download',
      });
      if (!ok) return { pulled: false };
      const adapter = adapters.ollama;
      if (adapter.pull === undefined) throw new AppError('UNSUPPORTED', 'Ollama cannot download models here.');
      await exclusive('ollama', `Downloading ${model}`, (signal) => adapter.pull?.(model, signal, options.progress) ?? Promise.resolve());
      activity.record({ kind: 'provider.model-downloaded', severity: 'info', summary: `Downloaded the Ollama model ${model}.`, details: { model } });
      await check('ollama');
      return { pulled: true };
    },

    cancel() {
      // Stops what a page started; runs from the queue are cancelled through the queue, which owns them.
      const own = [...active.values()].filter((a) => !a.queued);
      for (const a of own) a.controller.abort();
      return { cancelled: own.length > 0 };
    },

    busy: (id) => active.get(id)?.label,

    async unload(model) {
      if (!MODEL_NAME.test(model)) throw new AppError('INVALID_INPUT', 'That is not a valid model name.');
      const adapter = adapters.ollama;
      await exclusive('ollama', 'Unloading the model', (signal) => (adapter.unload === undefined ? Promise.reject(new AppError('UNSUPPORTED', 'Ollama cannot unload models here.')) : adapter.unload(model, signal)));
      activity.record({ kind: 'provider.unloaded', severity: 'info', summary: `Asked Ollama to unload the model ${model} from memory.`, details: { model } });
      return { unloaded: true };
    },

    checkLaunch: ({ provider, projectId, taskId, runId }) =>
      usage.enforce({ provider, purpose: 'agent-run', model: '', location: leavesThePc(provider) ? 'cloud' : 'local', projectId, taskId: taskId ?? undefined, runId }),

    generate: (choice, prompt, purpose) => runRequest(choice, prompt, purpose, { label: 'This request' }),

    async suggestSteps({ projectId, choice, title, description }) {
      const p = project(projectId);
      const prompt = [
        `You help plan work on a game project called "${p.name}".`,
        'Break the following feature into small, separate, implementable steps (between 3 and 8). Each step gets one or two acceptance criteria that can be checked.',
        'Answer with JSON only, in exactly this form and nothing else:',
        '{"steps":[{"title":"Short step name","acceptance":["A checkable statement"]}]}',
        'Do not add steps that were not asked for, and do not invent technical details.',
        `Feature: ${redactor.redact(title)}`,
        `Description: ${redactor.redact(description) || '(none given)'}`,
      ].join('\n\n');
      const result = await runRequest(choice, prompt, 'task-breakdown', { label: 'Suggesting steps', projectId });
      if (!result.sent) return { sent: false, steps: [], provider: result.provider, model: result.model };
      const steps = parseSuggestedSteps(result.text);
      if (steps === undefined)
        throw new AppError('TOOL_FAILED', `${PROVIDER_LABELS[choice.provider]} did not answer with steps in the expected form, so nothing was suggested.`, { hint: 'Try again, choose another model, or write the steps yourself.', details: { excerpt: result.text.slice(0, 300) } });
      return { sent: true, steps, provider: result.provider, model: result.model };
    },

    async draftDocument({ projectId, choice, docType, instruction, currentText }) {
      const p = project(projectId);
      const info = DOC_INFO[docType];
      const prompt = [
        `You write project documentation for a game project called "${p.name}".`,
        `Write the "${info.label}" document (${info.about}) in Markdown.`,
        'Use only what is in the text below. Where something is not stated, write "TODO: confirm" instead of guessing. Do not invent features, files or numbers.',
        `Instruction: ${redactor.redact(instruction) || '(none)'}`,
        `Existing text:\n${redactor.redact(currentText).slice(0, 8000) || '(none)'}`,
      ].join('\n\n');
      return runRequest(choice, prompt, 'document-draft', { label: 'Drafting a document', projectId });
    },

    async runInProject({ projectId, choice, prompt }) {
      const p = project(projectId);
      if (choice.provider === 'ollama') throw new AppError('UNSUPPORTED', 'Ollama answers prompts; it does not run in a project folder.', { hint: 'Use Claude Code or Codex for project sessions.' });
      return runRequest(choice, prompt, 'project-session', { cwd: p.rootPath, label: 'This project session', projectId, detail: inProject(p.rootPath, choice.provider) });
    },

    async runAgent({ projectId, choice, prompt, note, signal, onApproved, ownerId, taskId }) {
      const p = project(projectId);
      const extra = { label: 'This agent run', signal, onApproved, ownerId, projectId, taskId };
      // Ollama only answers the text it is given; the coding agents run read-only in the project folder.
      if (choice.provider === 'ollama') return runRequest(choice, prompt, 'agent-run', { ...extra, detail: note });
      return runRequest(choice, prompt, 'agent-run', { ...extra, cwd: p.rootPath, detail: `${note}\n\n${inProject(p.rootPath, choice.provider)}` });
    },
  };
}

export const sandboxPath = (userDataDir: string): string => join(userDataDir, 'provider-sandbox');
