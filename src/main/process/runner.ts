import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import { AppError } from '@shared/errors';
import type { Logger } from '../logging';
import type { Redactor } from '../logging';
import { prepareCommand } from './command';
import type { ProcessRunStore } from './store';

// The only code that spawns child processes (ARCHITECTURE.md section 12, spec §30). Argument arrays, never a shell string;
// every process has an owner, a timeout and an output cap; cancel ends the whole process tree; shutdown cleans up.

export type ProcessOwnerKind = 'agent-run' | 'test-run' | 'git' | 'detection' | 'engine' | 'resource-probe';

export interface ProcessSpec {
  /** Absolute path from detection or settings, never from the renderer. */
  executable: string;
  /** Never a shell string. */
  args: readonly string[];
  /** Validated by the caller (a project root or the app folder). */
  cwd: string;
  /** Prompts and other free text go here, not into `args`. */
  stdin?: string;
  /** `'close-stdin'`: keep stdin open and end it on cancel, then wait the grace period, before the tree is killed. */
  gracefulStop?: 'close-stdin';
  env?: Readonly<Record<string, string>>;
  timeoutMs: number;
  /** Per stream: the last `maxOutputBytes` are kept and the process is stopped at `OUTPUT_KILL_FACTOR` times that. */
  maxOutputBytes: number;
  /** Shown in activity and logs. */
  purpose: string;
  owner: { kind: ProcessOwnerKind; id: string };
  projectId?: string;
}

export type ProcessStatus = 'exited' | 'timed-out' | 'cancelled' | 'output-limit' | 'spawn-failed';

export interface ProcessResult {
  status: ProcessStatus;
  exitCode: number | null;
  /** Raw (not redacted): callers parse it, and redact before showing or logging it. */
  stdoutTail: string;
  stderrTail: string;
  /** True when more output arrived than `maxOutputBytes`, so the tails are not the whole output. */
  truncated: boolean;
  startedAt: string;
  endedAt: string;
  /** Why the process could not start, for `spawn-failed`. */
  errorMessage?: string;
}

export interface OutputChunk {
  stream: 'stdout' | 'stderr';
  text: string;
}

export interface RunHandle {
  readonly id: string;
  readonly pid: number | undefined;
  onOutput(listener: (chunk: OutputChunk) => void): () => void;
  readonly result: Promise<ProcessResult>;
  /** Graceful step if the spec asked for one, a grace period, then the process tree is killed. */
  cancel(reason: string): Promise<void>;
}

export interface ActiveProcess {
  id: string;
  pid: number | undefined;
  owner: ProcessSpec['owner'];
  purpose: string;
  startedAt: string;
}

export interface ProcessRunner {
  /** CONFLICT if the same owner already has a live process; SHUTTING_DOWN once `stopAccepting` ran. */
  start(spec: ProcessSpec): RunHandle;
  active(): readonly ActiveProcess[];
  cancelAll(reason: string): Promise<void>;
  /** Kills every owned tree at once, without a grace period (the shutdown ceiling). */
  forceKillAll(): Promise<void>;
  stopAccepting(): void;
}

export interface ProcessRunnerOptions {
  logger: Logger;
  redactor: Redactor;
  store?: ProcessRunStore;
  graceMs?: number;
  now?: () => Date;
  platform?: NodeJS.Platform;
}

export const OUTPUT_KILL_FACTOR = 10;
const DEFAULT_GRACE_MS = 5000;
const AFTER_KILL_WAIT_MS = 3000;

const SpecSchema = z.object({
  executable: z.string().min(1).max(1000),
  args: z.array(z.string().max(32_000)).max(500),
  cwd: z.string().min(1).max(1000),
  stdin: z
    .string()
    .max(10 * 1024 * 1024)
    .optional(),
  env: z.record(z.string(), z.string()).optional(),
  timeoutMs: z
    .number()
    .int()
    .min(1)
    .max(24 * 60 * 60 * 1000),
  maxOutputBytes: z
    .number()
    .int()
    .min(1)
    .max(64 * 1024 * 1024),
  purpose: z.string().min(1).max(200),
  owner: z.object({ kind: z.string().min(1), id: z.string().min(1).max(200) }),
});

/** Keeps the last `cap` bytes of a stream and counts the rest. */
class Tail {
  total = 0;
  private chunks: Buffer[] = [];
  private size = 0;
  constructor(private readonly cap: number) {}

  push(chunk: Buffer): void {
    this.total += chunk.length;
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.chunks.length > 1 && this.size - (this.chunks[0]?.length ?? 0) >= this.cap)
      this.size -= this.chunks.shift()?.length ?? 0;
  }

  get truncated(): boolean {
    return this.total > this.cap;
  }

  text(): string {
    const all = Buffer.concat(this.chunks);
    return (all.length > this.cap ? all.subarray(all.length - this.cap) : all).toString('utf8');
  }
}

export function createProcessRunner(options: ProcessRunnerOptions): ProcessRunner {
  const { redactor, store } = options;
  const logger = options.logger.child('process');
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const now = options.now ?? (() => new Date());
  const platform = options.platform ?? process.platform;
  const systemRoot = process.env['SystemRoot'] ?? 'C:\\Windows';
  const comspec = process.env['ComSpec'] ?? join(systemRoot, 'System32', 'cmd.exe');

  interface Entry extends ActiveProcess {
    handle: RunHandle;
    kill: () => Promise<void>;
  }
  const entries = new Map<string, Entry>();
  const liveOwners = new Set<string>();
  let accepting = true;

  /** Ends the process tree. On Windows `child.kill()` ends only the direct child, so use taskkill /T /F from System32. */
  const killTree = (pid: number): Promise<void> =>
    new Promise((resolve) => {
      if (platform !== 'win32') {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
        resolve();
        return;
      }
      const killer = spawn(join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.on('error', (error) => {
        logger.warn('taskkill could not start', { pid, error });
        resolve();
      });
      killer.on('close', () => resolve());
    });

  const start = (rawSpec: ProcessSpec): RunHandle => {
    if (!accepting)
      throw new AppError('SHUTTING_DOWN', 'The app is closing, so no new programs are started.', {
        retryable: true,
      });

    const parsed = SpecSchema.safeParse(rawSpec);
    if (!parsed.success)
      throw new AppError(
        'INVALID_INPUT',
        `The program could not be started: ${parsed.error.issues[0]?.message ?? 'invalid settings'}.`,
        {
          details: { issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) },
        },
      );
    const spec = rawSpec;
    if (!isAbsolute(spec.executable) || !isAbsolute(spec.cwd))
      throw new AppError(
        'INVALID_INPUT',
        'The program and its working folder must be absolute paths found by the app, not typed in.',
      );
    if (!existsSync(spec.executable) || !statSync(spec.executable).isFile())
      throw new AppError('TOOL_NOT_INSTALLED', `The program ${spec.executable} was not found.`, {
        hint: 'Install it, or choose its location in Settings, then try again.',
      });
    if (!existsSync(spec.cwd) || !statSync(spec.cwd).isDirectory())
      throw new AppError('NOT_FOUND', `The working folder ${spec.cwd} does not exist.`, {
        hint: 'Check that the project folder has not been moved or deleted.',
      });

    const ownerKey = `${spec.owner.kind}:${spec.owner.id}`;
    if (liveOwners.has(ownerKey))
      throw new AppError('CONFLICT', `${spec.owner.kind} ${spec.owner.id} already has a program running.`, {
        hint: 'Wait for it to finish, or cancel it first.',
      });

    const command = prepareCommand(spec, { platform, comspec });
    const id = randomUUID();
    const startedAt = now().toISOString();
    const stdout = new Tail(spec.maxOutputBytes);
    const stderr = new Tail(spec.maxOutputBytes);
    const outputListeners = new Set<(chunk: OutputChunk) => void>();

    let child: ChildProcess;
    try {
      child = spawn(command.file, command.args, {
        cwd: spec.cwd,
        env: { ...process.env, ...spec.env },
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: command.verbatim,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      // The system refused to start it (for example a file that is not a program): a result, like any other failed launch.
      const endedAt = now().toISOString();
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.warn('process could not be started', {
        id,
        purpose: spec.purpose,
        executable: redactor.redact(spec.executable),
        error,
      });
      try {
        store?.begin({
          id,
          owner: spec.owner,
          purpose: spec.purpose,
          executable: spec.executable,
          args: spec.args,
          cwd: spec.cwd,
          pid: undefined,
          startedAt,
        });
        store?.finish(id, 'spawn-failed', null, endedAt);
      } catch (storeError) {
        logger.warn('could not record the failed process run', { id, error: storeError });
      }
      return {
        id,
        pid: undefined,
        onOutput: () => () => undefined,
        cancel: () => Promise.resolve(),
        result: Promise.resolve({
          status: 'spawn-failed',
          exitCode: null,
          stdoutTail: '',
          stderrTail: '',
          truncated: false,
          startedAt,
          endedAt,
          errorMessage,
        }),
      };
    }
    const pid = child.pid;
    liveOwners.add(ownerKey);
    logger.info('process started', {
      id,
      pid,
      purpose: spec.purpose,
      owner: spec.owner,
      executable: redactor.redact(spec.executable),
      args: redactor.redactValue(spec.args),
    });
    try {
      store?.begin({
        id,
        owner: spec.owner,
        purpose: spec.purpose,
        executable: spec.executable,
        args: spec.args,
        cwd: spec.cwd,
        pid,
        startedAt,
      });
    } catch (error) {
      logger.warn('could not record the process run', { id, error });
    }

    let stopping: ProcessStatus | undefined;
    let markExited!: () => void;
    const exited = new Promise<void>((resolve) => {
      markExited = resolve;
    });
    // Only a process we started and that has not exited is ever signalled (its PID could be reused afterwards).
    const alive = (): boolean => pid !== undefined && child.exitCode === null && child.signalCode === null;
    // `stop` is defined below; the timer cannot fire before this synchronous setup has finished.
    const timer = setTimeout(
      () => void stop('timed-out', `no exit within ${spec.timeoutMs} ms`),
      spec.timeoutMs,
    );

    const waitForExit = (ms: number): Promise<boolean> =>
      new Promise((resolve) => {
        const wait = setTimeout(() => resolve(false), ms);
        void exited.then(() => {
          clearTimeout(wait);
          resolve(true);
        });
      });

    const stop = (
      status: Exclude<ProcessStatus, 'exited' | 'spawn-failed'>,
      reason: string,
    ): Promise<void> => {
      if (stopping !== undefined) return exited;
      stopping = status;
      clearTimeout(timer);
      logger.info('process stopping', { id, pid, status, reason });
      return (async () => {
        if (spec.gracefulStop === 'close-stdin') {
          child.stdin?.end();
          if (await waitForExit(graceMs)) return;
        }
        if (alive() && pid !== undefined) await killTree(pid);
        // A grandchild that kept the pipes open must not keep us waiting for ever.
        if (!(await waitForExit(AFTER_KILL_WAIT_MS))) markExited();
      })();
    };

    const result = new Promise<ProcessResult>((resolve) => {
      let finished = false;
      const finish = (status: ProcessStatus, exitCode: number | null, errorMessage?: string): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        entries.delete(id);
        liveOwners.delete(ownerKey);
        const endedAt = now().toISOString();
        try {
          store?.finish(id, status, exitCode, endedAt);
        } catch (error) {
          logger.warn('could not record the end of the process run', { id, error });
        }
        logger.info('process ended', { id, pid, status, exitCode, errorMessage });
        markExited();
        resolve({
          status,
          exitCode,
          stdoutTail: stdout.text(),
          stderrTail: stderr.text(),
          truncated: stdout.truncated || stderr.truncated,
          startedAt,
          endedAt,
          ...(errorMessage === undefined ? {} : { errorMessage }),
        });
      };

      child.on('error', (error) => {
        if (pid === undefined) finish('spawn-failed', null, error.message);
        else logger.warn('process error', { id, pid, error });
      });
      child.on('close', (code) => finish(stopping ?? 'exited', code));
      child.on('exit', () => markExited());
    });

    const attach = (stream: 'stdout' | 'stderr', source: NodeJS.ReadableStream | null, tail: Tail): void => {
      const decoder = new StringDecoder('utf8');
      source?.on('data', (chunk: Buffer) => {
        tail.push(chunk);
        if (outputListeners.size > 0) {
          const text = decoder.write(chunk);
          if (text !== '') for (const listener of outputListeners) listener({ stream, text });
        }
        if (tail.total > spec.maxOutputBytes * OUTPUT_KILL_FACTOR)
          void stop('output-limit', `${stream} exceeded ${spec.maxOutputBytes * OUTPUT_KILL_FACTOR} bytes`);
      });
    };
    attach('stdout', child.stdout, stdout);
    attach('stderr', child.stderr, stderr);

    child.stdin?.on('error', () => undefined); // EPIPE when the program exits before reading its input
    if (spec.stdin !== undefined) child.stdin?.write(spec.stdin);
    if (spec.gracefulStop !== 'close-stdin') child.stdin?.end();

    const handle: RunHandle = {
      id,
      pid,
      result,
      onOutput(listener) {
        outputListeners.add(listener);
        return () => outputListeners.delete(listener);
      },
      cancel: (reason) => stop('cancelled', reason).then(() => result.then(() => undefined)),
    };
    entries.set(id, {
      id,
      pid,
      owner: spec.owner,
      purpose: spec.purpose,
      startedAt,
      handle,
      kill: () => (alive() && pid !== undefined ? killTree(pid) : Promise.resolve()),
    });
    return handle;
  };

  return {
    start,
    active: () =>
      [...entries.values()].map(({ id, pid, owner, purpose, startedAt }) => ({
        id,
        pid,
        owner,
        purpose,
        startedAt,
      })),
    async cancelAll(reason) {
      await Promise.all([...entries.values()].map((entry) => entry.handle.cancel(reason)));
    },
    async forceKillAll() {
      await Promise.all([...entries.values()].map((entry) => entry.kill()));
    },
    stopAccepting() {
      accepting = false;
    },
  };
}
