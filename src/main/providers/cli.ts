import { randomUUID } from 'node:crypto';
import { AppError } from '@shared/errors';
import { QUOTA_UNAVAILABLE, type Capabilities, type ProviderId, type ProviderStatus, type Usage } from '@shared/providers';
import type { Logger } from '../logging';
import type { ProcessResult, ProcessRunner } from '../process';
import type { GenerateRequest, ProviderAdapter, ProviderOutput } from './types';

// The two command-line providers share one shape: find the program, ask it for its version, run it non-interactively in a
// read-only mode with the prompt on stdin, and read its structured output. What differs is the arguments and the output format.
// Both follow their vendors' documentation (Claude Code: code.claude.com/docs/en/headless; Codex: learn.chatgpt.com/docs/non-interactive-mode,
// checked 2026-10-24). Neither adapter reads credentials, and neither passes a flag that would skip a permission check.

export interface CliOptions {
  runner: ProcessRunner;
  locate: () => string | undefined;
  env: () => NodeJS.ProcessEnv;
  timeoutMs: () => number;
  /** An empty folder the program runs in for text-only requests, so it cannot see any project file. */
  sandboxDir: () => string;
  logger: Logger;
}

const OUTPUT_LIMIT = 8 * 1024 * 1024;

const run = (options: CliOptions, executable: string, args: string[], purpose: string, ownerId: string, timeoutMs = 20_000, cwd = options.sandboxDir()): Promise<ProcessResult> =>
  options.runner.start({ executable, args, cwd, timeoutMs, maxOutputBytes: 256 * 1024, purpose, owner: { kind: 'detection', id: `${ownerId}-${randomUUID()}` } }).result;

const firstVersion = (text: string): string | null => /(\d+\.\d+\.\d+(?:[-+.][\w.]+)?)/.exec(text)?.[1] ?? null;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const parseLines = (text: string): Record<string, unknown>[] =>
  text
    .split(/\r?\n/)
    .flatMap((line) => {
      if (!line.trim().startsWith('{')) return [];
      try {
        const value: unknown = JSON.parse(line);
        return isRecord(value) ? [value] : [];
      } catch {
        return [];
      }
    });
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** What went wrong, from the program's own words, with a way out for the common case of not being signed in. */
function failure(provider: string, message: string, code: number | null, signInHint: string): AppError {
  const clean = message.trim().slice(0, 400);
  if (/not logged in|log ?in|sign ?in|authenticat|unauthori[sz]ed|api key/i.test(clean))
    return new AppError('PERMISSION_REQUIRED', `${provider} says you are not signed in.`, { hint: signInHint, details: { message: clean } });
  return new AppError('TOOL_FAILED', `${provider} stopped with an error${code === null ? '' : ` (exit code ${code})`}${clean === '' ? '.' : `: ${clean}`}`, { hint: 'Details are in the log.', retryable: true, details: { exitCode: code } });
}

function ended(provider: string, result: ProcessResult, signal: AbortSignal): void {
  if (signal.aborted || result.status === 'cancelled') throw new AppError('CANCELLED', `${provider} was stopped.`);
  if (result.status === 'timed-out') throw new AppError('TIMEOUT', `${provider} did not finish in time.`, { hint: 'Try again, or raise the time limit in the settings.', retryable: true });
  if (result.status === 'output-limit') throw new AppError('OUTPUT_LIMIT', `${provider} produced more output than this app keeps.`);
  if (result.status === 'spawn-failed') throw new AppError('TOOL_NOT_INSTALLED', `${provider} could not be started.`, { hint: result.errorMessage ?? 'Check that it is installed.' });
}

// ------------------------------------------------------------------------------------------------------ Claude Code

const CLAUDE_CAPABILITIES: Capabilities = { models: false, streaming: true, cancellation: true, contextLength: false, structuredOutput: true, usageReporting: true, readOnlyMode: true };
const CLAUDE_SIGN_IN = 'Open a terminal, run claude, and follow the sign-in. This app never reads your credentials.';

export function createClaudeCodeAdapter(options: CliOptions): ProviderAdapter {
  return {
    id: 'claude-code',
    capabilities: CLAUDE_CAPABILITIES,

    async detect() {
      const base = { id: 'claude-code' as const, label: 'Claude Code', location: 'cloud' as const, capabilities: CLAUDE_CAPABILITIES, quota: QUOTA_UNAVAILABLE };
      const exe = options.locate();
      if (exe === undefined)
        return { ...base, status: 'not-installed', version: null, message: 'Claude Code was not found on this PC.', hint: 'Install Claude Code from its documentation (code.claude.com). The app never installs it for you.', details: [{ label: 'Program', value: 'not found' }] };
      const rows = [{ label: 'Program', value: exe }];
      const version = await run(options, exe, ['--version'], 'Check the Claude Code version', 'claude-code-version');
      if (version.status !== 'exited' || version.exitCode !== 0)
        return { ...base, status: 'error', version: null, message: 'Claude Code is installed but did not report its version.', hint: version.stderrTail.trim().slice(0, 200) || 'Try running claude --version in a terminal.', details: rows };
      const number = firstVersion(version.stdoutTail);
      const help = await run(options, exe, ['--help'], 'Read the Claude Code options', 'claude-code-help');
      const options_ = help.stdoutTail;
      // Capabilities come from what this installed version says it accepts, not from a version number (KI-008).
      const has = (flag: string): boolean => options_.includes(flag);
      const planMode = /--permission-mode[\s\S]{0,300}"plan"/.test(options_);
      rows.push({ label: 'Version', value: number ?? 'unknown' }, { label: 'Non-interactive mode (-p)', value: has('--print') ? 'available' : 'missing' }, { label: 'Streaming output', value: has('stream-json') ? 'available' : 'missing' }, { label: 'Read-only (plan) mode', value: planMode ? 'available' : 'missing' });
      const env = options.env();
      if (env['ANTHROPIC_API_KEY'] !== undefined && env['ANTHROPIC_API_KEY'] !== '') rows.push({ label: 'Warning', value: 'ANTHROPIC_API_KEY is set: Claude Code may bill your API account instead of your subscription' });
      if (!has('--print') || !has('stream-json') || !planMode)
        return { ...base, status: 'error', version: number, message: `This Claude Code${number === null ? '' : ` (${number})`} lacks an option this app needs.`, hint: 'Update Claude Code, or leave it unused. The app does not guess at options.', details: rows };
      return {
        ...base,
        status: 'installed',
        version: number,
        message: `Claude Code${number === null ? '' : ` ${number}`} is installed. Whether you are signed in is not checked, because Claude Code has no documented way to check without running a prompt.`,
        hint: CLAUDE_SIGN_IN,
        details: rows,
      };
    },

    async generate(request: GenerateRequest): Promise<ProviderOutput> {
      const exe = options.locate();
      if (exe === undefined) throw new AppError('TOOL_NOT_INSTALLED', 'Claude Code was not found on this PC.', { hint: 'Install it, then check again.' });
      // Read-only: plan mode, and no tool is pre-approved. The prompt travels on stdin, never on the command line.
      const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'plan', ...(request.model === '' ? [] : ['--model', request.model])];
      const handle = options.runner.start({ executable: exe, args, cwd: request.cwd ?? options.sandboxDir(), stdin: request.prompt, timeoutMs: options.timeoutMs(), maxOutputBytes: OUTPUT_LIMIT, purpose: 'Run Claude Code (read-only)', owner: { kind: 'agent-run', id: request.ownerId ?? `claude-code-${randomUUID()}` } });
      const onAbort = (): void => void handle.cancel('stopped by the user');
      request.signal.addEventListener('abort', onAbort, { once: true });
      let streamed = '';
      let pending = '';
      handle.onOutput((chunk) => {
        if (chunk.stream !== 'stdout' || request.onText === undefined) return;
        pending += chunk.text;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? '';
        for (const event of parseLines(lines.join('\n'))) {
          const content = (event['message'] as { content?: unknown } | undefined)?.content;
          if (event['type'] === 'assistant' && Array.isArray(content)) {
            for (const part of content as Record<string, unknown>[]) if (part['type'] === 'text') streamed += text(part['text']);
            request.onText(streamed);
          }
        }
      });
      const result = await handle.result;
      request.signal.removeEventListener('abort', onAbort);
      ended('Claude Code', result, request.signal);
      const events = parseLines(result.stdoutTail);
      const final = [...events].reverse().find((event) => event['type'] === 'result');
      if (final === undefined) throw failure('Claude Code', result.stderrTail || 'it gave no result', result.exitCode, CLAUDE_SIGN_IN);
      if (final['is_error'] === true || (result.exitCode !== 0 && result.exitCode !== null)) throw failure('Claude Code', text(final['result']) || result.stderrTail, result.exitCode, CLAUDE_SIGN_IN);
      const usage = final['usage'] as Record<string, unknown> | undefined;
      const parsed: Usage = { inputCount: num(usage?.['input_tokens']), outputCount: num(usage?.['output_tokens']), costUsdEstimate: num(final['total_cost_usd']) };
      return { text: text(final['result']), usage: parsed };
    },
  };
}

// ----------------------------------------------------------------------------------------------------------- Codex

const CODEX_CAPABILITIES: Capabilities = { models: false, streaming: false, cancellation: true, contextLength: false, structuredOutput: true, usageReporting: false, readOnlyMode: true };
const CODEX_SIGN_IN = 'Open a terminal and run codex login. This app never reads your credentials.';

export function createCodexAdapter(options: CliOptions): ProviderAdapter {
  return {
    id: 'codex',
    capabilities: CODEX_CAPABILITIES,

    async detect() {
      const base = { id: 'codex' as const, label: 'Codex CLI', location: 'cloud' as const, capabilities: CODEX_CAPABILITIES, quota: QUOTA_UNAVAILABLE };
      const exe = options.locate();
      if (exe === undefined)
        return { ...base, status: 'not-installed', version: null, message: 'Codex CLI was not found on this PC. It is optional.', hint: 'Install it from OpenAI if you want to use it. The app never installs it for you.', details: [{ label: 'Program', value: 'not found' }] };
      const version = await run(options, exe, ['--version'], 'Check the Codex version', 'codex-version');
      if (version.status !== 'exited' || version.exitCode !== 0)
        return { ...base, status: 'error', version: null, message: 'Codex is installed but did not report its version.', hint: version.stderrTail.trim().slice(0, 200) || 'Try running codex --version in a terminal.', details: [{ label: 'Program', value: exe }] };
      const number = firstVersion(version.stdoutTail);
      return { ...base, status: 'installed', version: number, message: `Codex CLI${number === null ? '' : ` ${number}`} is installed. Whether you are signed in is not checked.`, hint: CODEX_SIGN_IN, details: [{ label: 'Program', value: exe }, { label: 'Version', value: number ?? 'unknown' }, { label: 'Mode used', value: 'codex exec, read-only sandbox' }] };
    },

    async generate(request: GenerateRequest): Promise<ProviderOutput> {
      const exe = options.locate();
      if (exe === undefined) throw new AppError('TOOL_NOT_INSTALLED', 'Codex CLI was not found on this PC.', { hint: 'Install it, then check again.' });
      // Read-only sandbox (the documented default, passed explicitly). The empty folder is not a Git repository, so the repository
      // check is skipped for text-only requests; a run inside a project folder keeps the check.
      const textOnly = request.cwd === undefined;
      const args = ['exec', '--json', '--sandbox', 'read-only', '--ephemeral', ...(textOnly ? ['--skip-git-repo-check'] : []), ...(request.model === '' ? [] : ['--model', request.model]), '-'];
      const handle = options.runner.start({ executable: exe, args, cwd: request.cwd ?? options.sandboxDir(), stdin: request.prompt, timeoutMs: options.timeoutMs(), maxOutputBytes: OUTPUT_LIMIT, purpose: 'Run Codex (read-only)', owner: { kind: 'agent-run', id: request.ownerId ?? `codex-${randomUUID()}` } });
      const onAbort = (): void => void handle.cancel('stopped by the user');
      request.signal.addEventListener('abort', onAbort, { once: true });
      const result = await handle.result;
      request.signal.removeEventListener('abort', onAbort);
      ended('Codex', result, request.signal);
      const events = parseLines(result.stdoutTail);
      const failed = events.find((event) => event['type'] === 'turn.failed' || event['type'] === 'error');
      if (failed !== undefined) throw failure('Codex', text((failed['error'] as { message?: unknown } | undefined)?.message) || text(failed['message']), result.exitCode, CODEX_SIGN_IN);
      if (result.exitCode !== 0 && result.exitCode !== null) throw failure('Codex', result.stderrTail, result.exitCode, CODEX_SIGN_IN);
      const messages = events.flatMap((event) => {
        const item = event['item'] as { type?: unknown; text?: unknown } | undefined;
        return event['type'] === 'item.completed' && item?.type === 'agent_message' ? [text(item.text)] : [];
      });
      if (messages.length === 0) throw new AppError('TOOL_FAILED', 'Codex finished without an answer this app could read.', { hint: 'Details are in the log.' });
      request.onText?.(messages.join('\n'));
      return { text: messages.join('\n'), usage: null };
    },
  };
}

export type { ProviderId, ProviderStatus };
