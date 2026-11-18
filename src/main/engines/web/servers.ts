import { randomUUID } from 'node:crypto';
import { AppError } from '@shared/errors';
import type { WebServer } from '@shared/web';
import type { ActivityLog, Redactor } from '../../logging';
import type { ProcessRunner, RunHandle } from '../../process';

// Dev servers and preview servers (spec §16 Vite): long-running programs the person approved and this app owns. They run through the
// process runner (so they are listed as owned processes, have a timeout, are stopped as a whole tree and are ended at quit); the
// registry remembers each one, keeps the end of its output, and reads the port from the server's own output ("Local: http://localhost:5173/").

/** One day, the longest the process runner allows; a server older than that is stopped. */
const SERVER_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const TAIL_CHARS = 20_000;
const SHOWN_CHARS = 6000;
const KEEP_ENDED = 5;
// A terminal colour sequence: ESC [ ... letter. Built from the character code, so the pattern has no raw control character.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g');
const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d{2,5})/;

/** The port a server printed for itself, or null. Only a loopback address counts, never a network address. */
export function detectPort(output: string): number | null {
  const match = LOCAL_URL.exec(output.replace(ANSI, ''));
  const port = match?.[1] === undefined ? NaN : Number(match[1]);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : null;
}

export interface StartInput {
  projectId: string;
  projectName: string;
  label: string;
  program: string;
  args: string[];
  cwd: string;
}

export interface ServerRegistryOptions {
  runner: ProcessRunner;
  activity: ActivityLog;
  redactor: Redactor;
  now?: () => Date;
  newId?: () => string;
}

export interface ServerRegistry {
  /** Starts the server; CONFLICT if the same script is already running in this project. Returns at once. */
  start(input: StartInput): { id: string };
  /** Stops a running server (the whole process tree) and waits for it. False when it was not running. */
  stop(id: string): Promise<{ stopped: boolean }>;
  list(projectId: string): WebServer[];
  /** Port of a running server, for opening it in the browser. */
  runningPort(id: string): number | null;
  running(): number;
}

interface Entry {
  id: string;
  projectId: string;
  label: string;
  startedAt: string;
  endedAt: string | null;
  status: WebServer['status'];
  port: number | null;
  exitCode: number | null;
  tail: string;
  stopRequested: boolean;
  handle: RunHandle;
}

export function createServerRegistry(options: ServerRegistryOptions): ServerRegistry {
  const { runner, activity, redactor } = options;
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? randomUUID;
  const entries = new Map<string, Entry>();

  const prune = (projectId: string): void => {
    const ended = [...entries.values()].filter((e) => e.projectId === projectId && e.status !== 'running');
    for (const old of ended.slice(0, Math.max(0, ended.length - KEEP_ENDED))) entries.delete(old.id);
  };

  return {
    start(input) {
      if ([...entries.values()].some((e) => e.projectId === input.projectId && e.label === input.label && e.status === 'running'))
        throw new AppError('CONFLICT', `"${input.label}" is already running for this project.`, { hint: 'Stop it first, or open the one that is running.' });
      const id = newId();
      const startedAt = now().toISOString();
      const handle = runner.start({
        executable: input.program,
        args: input.args,
        cwd: input.cwd,
        timeoutMs: SERVER_TIMEOUT_MS,
        maxOutputBytes: 2 * 1024 * 1024,
        purpose: `Server: ${input.label}`,
        owner: { kind: 'engine', id: `web-server-${id}` },
        projectId: input.projectId,
      });
      const entry: Entry = { id, projectId: input.projectId, label: input.label, startedAt, endedAt: null, status: 'running', port: null, exitCode: null, tail: '', stopRequested: false, handle };
      entries.set(id, entry);
      handle.onOutput((chunk) => {
        entry.tail = (entry.tail + chunk.text).slice(-TAIL_CHARS);
        if (entry.port === null) {
          const port = detectPort(entry.tail);
          if (port !== null) {
            entry.port = port;
            activity.record({ kind: 'web.serverReady', severity: 'info', summary: `"${input.label}" in "${input.projectName}" is listening on port ${port}.`, projectId: input.projectId, details: { port } });
          }
        }
      });
      void handle.result.then((result) => {
        entry.endedAt = result.endedAt;
        entry.exitCode = result.exitCode;
        if (entry.tail === '') entry.tail = `${result.stdoutTail}${result.stderrTail}`.slice(-TAIL_CHARS);
        entry.status = entry.stopRequested || (result.status === 'exited' && result.exitCode === 0) ? 'stopped' : 'failed';
        activity.record({
          kind: 'web.serverEnded',
          severity: entry.status === 'stopped' ? 'info' : 'warning',
          summary: `"${input.label}" in "${input.projectName}" ${entry.stopRequested ? 'was stopped' : result.status === 'exited' ? `exited with code ${result.exitCode ?? '?'}` : result.status.replace('-', ' ')}.`,
          projectId: input.projectId,
        });
        prune(input.projectId);
      });
      activity.record({ kind: 'web.serverStarted', severity: 'info', summary: `You started "${input.label}" in "${input.projectName}".`, projectId: input.projectId });
      return { id };
    },

    async stop(id) {
      const entry = entries.get(id);
      if (entry === undefined || entry.status !== 'running') return { stopped: false };
      entry.stopRequested = true;
      await entry.handle.cancel('You stopped the server');
      await entry.handle.result;
      return { stopped: true };
    },

    list(projectId) {
      return [...entries.values()]
        .filter((e) => e.projectId === projectId)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id))
        .map((e) => ({ id: e.id, label: e.label, startedAt: e.startedAt, endedAt: e.endedAt, status: e.status, port: e.port, url: e.port === null || e.status !== 'running' ? null : `http://localhost:${e.port}/`, exitCode: e.exitCode, output: redactor.redact(e.tail.replace(ANSI, '')).slice(-SHOWN_CHARS) }));
    },

    runningPort(id) {
      const entry = entries.get(id);
      return entry?.status === 'running' ? entry.port : null;
    },

    running: () => [...entries.values()].filter((e) => e.status === 'running').length,
  };
}
