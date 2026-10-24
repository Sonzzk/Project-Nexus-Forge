import { describe, expect, it } from 'vitest';
import type { AppError } from '@shared/errors';
import { fixture } from '../../../test/helpers/fixture-server';
import { memoryLogger } from '../../../test/helpers/logger';
import { createFakeRunner, type Scripted } from '../../../test/helpers/fake-runner';
import { createClaudeCodeAdapter, createCodexAdapter } from './cli';

const CLAUDE = 'A:\\npm-global\\claude.cmd';
const CODEX = 'C:\\Tools\\codex.exe';

function claude(script: (args: string[]) => Scripted, options: { installed?: boolean; env?: NodeJS.ProcessEnv } = {}) {
  const runner = createFakeRunner((spec) => script(spec.args as string[]));
  const adapter = createClaudeCodeAdapter({ runner, locate: () => (options.installed === false ? undefined : CLAUDE), env: () => options.env ?? {}, timeoutMs: () => 60_000, sandboxDir: () => 'C:\\Data\\provider-sandbox', logger: memoryLogger() });
  return { runner, adapter };
}
function codex(script: (args: string[]) => Scripted, options: { installed?: boolean } = {}) {
  const runner = createFakeRunner((spec) => script(spec.args as string[]));
  const adapter = createCodexAdapter({ runner, locate: () => (options.installed === false ? undefined : CODEX), env: () => ({}), timeoutMs: () => 60_000, sandboxDir: () => 'C:\\Data\\provider-sandbox', logger: memoryLogger() });
  return { runner, adapter };
}
const request = (extra: Partial<Parameters<ReturnType<typeof claude>['adapter']['generate']>[0]> = {}) => ({ model: '', prompt: 'Break this feature into steps', signal: new AbortController().signal, ...extra });
const failure = async (promise: Promise<unknown>): Promise<AppError> => {
  try {
    await promise;
  } catch (error) {
    return error as AppError;
  }
  throw new Error('expected a failure');
};

/** Flags that would let a run change files, skip a permission check, or spend on a different plan. None may ever be passed. */
const FORBIDDEN = /workspace-write|danger-full-access|bypassPermissions|acceptEdits|dontAsk|--dangerously|--full-auto|--approve|--bare|--allowedTools|--allowed-tools/i;

describe('Claude Code: detection', () => {
  const detect = (opts: { help?: string; env?: NodeJS.ProcessEnv } = {}) =>
    claude((args) => (args[0] === '--version' ? { stdout: '2.1.197 (Claude Code)\n' } : { stdout: opts.help ?? fixture('claude', 'help.txt') }), { env: opts.env ?? {} }).adapter.detect();

  it('reports the version and the options this installed version really has, and does not claim to know the sign-in state', async () => {
    const status = await detect();
    expect(status).toMatchObject({ id: 'claude-code', status: 'installed', version: '2.1.197', location: 'cloud', quota: 'Unavailable from this provider' });
    expect(status.message).toContain('Whether you are signed in is not checked');
    expect(status.hint).toContain('never reads your credentials');
    expect(status.details).toEqual(expect.arrayContaining([{ label: 'Read-only (plan) mode', value: 'available' }, { label: 'Streaming output', value: 'available' }, { label: 'Non-interactive mode (-p)', value: 'available' }]));
  });

  it('is an error, with an honest reason, when this version lacks an option the app needs', async () => {
    const status = await detect({ help: fixture('claude', 'help-old.txt') });
    expect(status.status).toBe('error');
    expect(status.message).toContain('lacks an option');
    expect(status.details).toContainEqual({ label: 'Streaming output', value: 'missing' });
  });

  it('warns when ANTHROPIC_API_KEY is set, because that can bill the API account instead of the subscription', async () => {
    const status = await detect({ env: { ANTHROPIC_API_KEY: 'sk-ant-not-a-real-key' } });
    const warning = status.details.find((d) => d.label === 'Warning');
    expect(warning?.value).toContain('ANTHROPIC_API_KEY is set');
    expect(JSON.stringify(status)).not.toContain('sk-ant-not-a-real-key'); // the value itself is never shown
  });

  it('is not installed when the program is not found, and an error when it will not report a version', async () => {
    expect((await claude(() => ({}), { installed: false }).adapter.detect()).status).toBe('not-installed');
    const broken = await claude(() => ({ exitCode: 1, stderr: 'boom' })).adapter.detect();
    expect(broken.status).toBe('error');
    expect(broken.hint).toBe('boom');
  });
});

describe('Claude Code: running', () => {
  const ok = (args: string[]): Scripted => (args.includes('-p') ? { stdout: fixture('claude', 'stream-ok.jsonl') } : {});

  it('runs non-interactively in plan (read-only) mode with the prompt on stdin, in the empty sandbox folder by default', async () => {
    const { adapter, runner } = claude(ok);
    const result = await adapter.generate(request({ model: 'sonnet' }));
    expect(result).toEqual({ text: 'Here is the answer.', usage: { inputCount: 120, outputCount: 45, costUsdEstimate: 0.0123 } });
    const spec = runner.started[0];
    expect(spec?.executable).toBe(CLAUDE);
    expect(spec?.args).toEqual(['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'plan', '--model', 'sonnet']);
    expect(spec?.stdin).toBe('Break this feature into steps');
    expect(spec?.args.join(' ')).not.toContain('Break this feature'); // never on the command line
    expect(spec?.cwd).toBe('C:\\Data\\provider-sandbox');
    expect(spec?.owner.kind).toBe('agent-run');
  });

  it('runs in the given project folder when asked, still read-only', async () => {
    const { adapter, runner } = claude(ok);
    await adapter.generate(request({ cwd: 'D:\\Games\\Alpha' }));
    expect(runner.started[0]?.cwd).toBe('D:\\Games\\Alpha');
    expect(runner.started[0]?.args).toContain('plan');
  });

  it('can never be asked to write: no flag that allows edits, skips permission checks or pre-approves tools is passed', async () => {
    const { adapter, runner } = claude(ok);
    await adapter.generate(request());
    await adapter.generate(request({ model: 'opus', cwd: 'D:\\Games\\Alpha' }));
    for (const spec of runner.started) expect(spec.args.join(' '), spec.args.join(' ')).not.toMatch(FORBIDDEN);
  });

  it('streams assistant text while it arrives', async () => {
    const lines = fixture('claude', 'stream-ok.jsonl').split('\n');
    const { adapter } = claude(() => ({ stdout: lines.join('\n'), chunks: [`${lines[0]}\n${lines[1]}\n${lines[2]?.slice(0, 20)}`, `${lines[2]?.slice(20)}\n${lines[3]}\n`] }));
    const seen: string[] = [];
    await adapter.generate(request({ onText: (t) => seen.push(t) }));
    expect(seen).toEqual(['Here is ', 'Here is the answer.']);
  });

  it('says you are not signed in, with how to fix it, when Claude Code says so', async () => {
    const { adapter } = claude(() => ({ stdout: fixture('claude', 'stream-not-logged-in.jsonl'), exitCode: 1 }));
    const error = await failure(adapter.generate(request()));
    expect(error).toMatchObject({ code: 'PERMISSION_REQUIRED', message: 'Claude Code says you are not signed in.' });
    expect(error.hint).toContain('run claude');
  });

  it('reports an exit with no result, a timeout, a cancel, and a program that will not start, each as what it is', async () => {
    expect(await failure(claude(() => ({ exitCode: 2, stderr: 'unknown option' })).adapter.generate(request()))).toMatchObject({ code: 'TOOL_FAILED' });
    expect(await failure(claude(() => ({ status: 'timed-out', exitCode: null })).adapter.generate(request()))).toMatchObject({ code: 'TIMEOUT', retryable: true });
    expect(await failure(claude(() => ({ status: 'spawn-failed', exitCode: null, errorMessage: 'EACCES' })).adapter.generate(request()))).toMatchObject({ code: 'TOOL_NOT_INSTALLED' });
    expect(await failure(claude(() => ({ status: 'output-limit', exitCode: null })).adapter.generate(request()))).toMatchObject({ code: 'OUTPUT_LIMIT' });
    expect(await failure(claude(() => ({}), { installed: false }).adapter.generate(request()))).toMatchObject({ code: 'TOOL_NOT_INSTALLED' });
  });

  it('stops the process when cancelled', async () => {
    const { adapter, runner } = claude(() => ({ hold: true }));
    const controller = new AbortController();
    const running = adapter.generate(request({ signal: controller.signal }));
    setTimeout(() => controller.abort(), 10);
    expect(await failure(running)).toMatchObject({ code: 'CANCELLED' });
    expect(runner.cancelled).toEqual(['stopped by the user']);
  });
});

describe('detection runs', () => {
  it('use their own owner each time, so two looks at once cannot refuse each other', async () => {
    const { adapter, runner } = claude((args) => (args[0] === '--version' ? { stdout: '2.1.197 (Claude Code)\n' } : { stdout: fixture('claude', 'help.txt') }));
    await Promise.all([adapter.detect(), adapter.detect()]);
    const owners = runner.started.map((s) => s.owner.id);
    expect(new Set(owners).size).toBe(owners.length);
  });
});

describe('Codex CLI', () => {
  it('is optional: not installed is a normal answer; installed reports its version', async () => {
    expect((await codex(() => ({}), { installed: false }).adapter.detect()).status).toBe('not-installed');
    const status = await codex(() => ({ stdout: 'codex-cli 0.9.1\n' })).adapter.detect();
    expect(status).toMatchObject({ status: 'installed', version: '0.9.1' });
    expect(status.hint).toContain('codex login');
  });

  it('runs codex exec with JSON events in the read-only sandbox, prompt on stdin, skipping the repository check only for text-only requests', async () => {
    const { adapter, runner } = codex(() => ({ stdout: fixture('codex', 'exec-ok.jsonl') }));
    const result = await adapter.generate(request());
    expect(result).toEqual({ text: 'Step one. Step two.', usage: null });
    expect(runner.started[0]?.args).toEqual(['exec', '--json', '--sandbox', 'read-only', '--ephemeral', '--skip-git-repo-check', '-']);
    expect(runner.started[0]?.stdin).toBe('Break this feature into steps');
    await adapter.generate(request({ cwd: 'D:\\Games\\Alpha', model: 'gpt-test' }));
    expect(runner.started[1]?.args).toEqual(['exec', '--json', '--sandbox', 'read-only', '--ephemeral', '--model', 'gpt-test', '-']);
    expect(runner.started[1]?.cwd).toBe('D:\\Games\\Alpha');
    for (const spec of runner.started) expect(spec.args.join(' ')).not.toMatch(FORBIDDEN);
  });

  it('reports a failed turn in its own words, with the sign-in step for a login problem', async () => {
    const { adapter } = codex(() => ({ stdout: fixture('codex', 'exec-failed.jsonl'), exitCode: 1 }));
    const error = await failure(adapter.generate(request()));
    expect(error).toMatchObject({ code: 'PERMISSION_REQUIRED' });
    expect(error.hint).toContain('codex login');
    expect(await failure(codex(() => ({ stdout: '{"type":"turn.completed"}\n' })).adapter.generate(request()))).toMatchObject({ code: 'TOOL_FAILED' });
  });
});
