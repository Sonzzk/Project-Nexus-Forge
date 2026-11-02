import { roleById } from '@shared/agents';
import { AppError } from '@shared/errors';
import { PROVIDER_LOCATION, type Observed, type ProviderId } from '@shared/providers';
import type { Session, SessionOutcome, SessionSummary, ToolUse } from '@shared/sessions';
import type { Redactor } from '../logging';
import type { Db } from '../storage';

// Session records for agent runs (spec §15). The queue tells this service when a run really started, what the provider streamed, and
// how it ended; the service keeps the record after the run so the history survives a restart, and builds the live view from it.
// Nothing here guesses: a fact is shown only if an event produced it, and what a provider does not tell the app is said to be absent.

export interface SessionRecorder {
  begin(input: { runId: string; projectId: string; provider: ProviderId; model: string; workingDir: string }): void;
  /** The answer so far, while the provider streams it. */
  output(runId: string, text: string): void;
  finish(runId: string, end: { outcome: Exclude<SessionOutcome, 'running' | 'interrupted'>; text?: string; truncated?: boolean; observed?: Observed | undefined; error?: string }): void;
}

export interface SessionService extends SessionRecorder {
  list(projectId: string): SessionSummary[];
  get(runId: string): Session;
  /** At startup: sessions that were running when the app stopped are marked interrupted. */
  recover(): number;
}

export interface SessionServiceOptions {
  db: Db;
  redactor: Redactor;
  /** Tells the window about new streamed text (main wires it to the `sessions:output` event). */
  emit?: (runId: string, text: string) => void;
  /** The shortest time between two such events for one run. */
  emitEveryMs?: number;
  now?: () => Date;
}

interface Row {
  run_id: string;
  project_id: string;
  provider_id: ProviderId;
  model: string;
  working_dir: string;
  started_at: string;
  ended_at: string | null;
  outcome: SessionOutcome;
  exit_code: number | null;
  provider_session_id: string | null;
  denials_json: string;
  tools_json: string;
  error: string;
  output: string;
  output_truncated: number;
  streamed: number;
  role: string;
  run_state: Session['runState'];
  task_id: string | null;
  task_title: string | null;
  review_id: string | null;
}

const SELECT = `SELECT s.*, r.role, r.state AS run_state, r.task_id, t.title AS task_title,
  (SELECT id FROM change_sessions c WHERE c.run_id = s.run_id ORDER BY c.started_at DESC LIMIT 1) AS review_id
  FROM run_sessions s JOIN agent_runs r ON r.id = s.run_id LEFT JOIN tasks t ON t.id = r.task_id`;

const MAX_OUTPUT = 40_000;

/** What each provider tells the app about a run. Used to say "not exposed" instead of showing an empty field as if it meant something. */
const EXPOSES: Record<ProviderId, Session['exposes']> = {
  'claude-code': { streaming: true, toolEvents: true, denials: true, exitCode: true, sessionId: true },
  codex: { streaming: false, toolEvents: true, denials: false, exitCode: true, sessionId: true },
  ollama: { streaming: true, toolEvents: false, denials: false, exitCode: false, sessionId: false },
};

export function createSessionService(options: SessionServiceOptions): SessionService {
  const { db, redactor } = options;
  const now = options.now ?? (() => new Date());
  const live = new Map<string, { text: string; lastEmit: number; streamed: boolean }>();

  const elapsed = (r: Pick<Row, 'started_at' | 'ended_at'>): number => Math.max(0, (r.ended_at === null ? now().getTime() : new Date(r.ended_at).getTime()) - new Date(r.started_at).getTime());
  const summaryOf = (r: Row): SessionSummary => ({
    runId: r.run_id,
    projectId: r.project_id,
    roleLabel: roleById(r.role)?.label ?? r.role,
    taskTitle: r.task_title,
    provider: r.provider_id,
    model: r.model,
    outcome: r.outcome,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    elapsedMs: Math.round(elapsed(r)),
  });
  const clean = (tool: ToolUse): ToolUse => ({ tool: redactor.redact(tool.tool).slice(0, 80), detail: redactor.redact(tool.detail).slice(0, 300) });

  return {
    begin({ runId, projectId, provider, model, workingDir }) {
      db.run(
        `INSERT INTO run_sessions (run_id, project_id, provider_id, model, working_dir, started_at, outcome) VALUES (?, ?, ?, ?, ?, ?, 'running')
         ON CONFLICT(run_id) DO UPDATE SET provider_id = excluded.provider_id, model = excluded.model, working_dir = excluded.working_dir, started_at = excluded.started_at, outcome = 'running', ended_at = NULL, error = '', output = ''`,
        runId, projectId, provider, model, redactor.redact(workingDir), now().toISOString(),
      );
      live.set(runId, { text: '', lastEmit: 0, streamed: false });
    },

    output(runId, text) {
      const entry = live.get(runId);
      if (entry === undefined) return;
      entry.text = text;
      entry.streamed = true;
      const at = now().getTime();
      if (at - entry.lastEmit >= (options.emitEveryMs ?? 250)) {
        entry.lastEmit = at;
        options.emit?.(runId, redactor.redact(text).slice(-MAX_OUTPUT));
      }
    },

    finish(runId, end) {
      const entry = live.get(runId);
      live.delete(runId);
      const text = redactor.redact(end.text ?? entry?.text ?? '');
      const tools = (end.observed?.tools ?? []).map(clean);
      const denials = (end.observed?.denials ?? []).map(clean);
      db.run(
        'UPDATE run_sessions SET outcome = ?, ended_at = ?, exit_code = ?, provider_session_id = ?, denials_json = ?, tools_json = ?, error = ?, output = ?, output_truncated = ?, streamed = ? WHERE run_id = ?',
        end.outcome, now().toISOString(), end.observed?.exitCode ?? null, end.observed?.sessionId ?? null, JSON.stringify(denials), JSON.stringify(tools), redactor.redact(end.error ?? '').slice(0, 1500), text.slice(-MAX_OUTPUT), end.truncated === true || text.length > MAX_OUTPUT ? 1 : 0, entry?.streamed === true ? 1 : 0, runId,
      );
    },

    list(projectId) {
      return db.all<Row>(`${SELECT} WHERE s.project_id = ? ORDER BY s.started_at DESC LIMIT 50`, projectId).map(summaryOf);
    },

    get(runId) {
      const r = db.get<Row>(`${SELECT} WHERE s.run_id = ?`, runId);
      if (r === undefined) throw new AppError('NOT_FOUND', 'There is no session for that run.', { hint: 'A run has a session only once it has really started.' });
      const denials = JSON.parse(r.denials_json) as ToolUse[];
      const tools = JSON.parse(r.tools_json) as ToolUse[];
      const liveEntry = live.get(runId);
      const output = r.outcome === 'running' ? redactor.redact(liveEntry?.text ?? '').slice(-MAX_OUTPUT) : r.output;
      const exposes = EXPOSES[r.provider_id];
      const recent = db
        .all<{ occurred_at: string; summary: string }>("SELECT occurred_at, summary FROM activity_events WHERE json_extract(details_json, '$.runId') = ? ORDER BY occurred_at DESC, rowid DESC LIMIT 20", runId)
        .map((e) => ({ at: e.occurred_at, summary: e.summary }));
      const processes = db
        .all<{ purpose: string; executable: string; status: string; exit_code: number | null; started_at: string; ended_at: string | null }>(
          'SELECT purpose, executable, status, exit_code, started_at, ended_at FROM process_runs WHERE owner_id = ? ORDER BY started_at LIMIT 10', runId,
        )
        .map((p) => ({ purpose: p.purpose, program: p.executable.split(/[\\/]/).at(-1) ?? p.executable, status: p.status, exitCode: p.exit_code, startedAt: p.started_at, endedAt: p.ended_at }));
      const notes = [
        'Test output: runs do not report test results yet (Step 23).',
        'The agent’s reasoning is not shown: no provider exposes it, and this page does not guess at it.',
        ...(exposes.toolEvents ? [] : [`${PROVIDER_LOCATION[r.provider_id] === 'local' ? 'A local model' : 'This provider'} does not tell the app which commands or files it used, so none are listed.`]),
        ...(exposes.streaming ? [] : ['This provider returns its answer only when it finishes, so nothing streams while it runs.']),
      ];
      return {
        ...summaryOf(r),
        taskId: r.task_id,
        runState: r.run_state,
        workingDir: r.working_dir,
        exitCode: r.exit_code,
        providerSessionId: r.provider_session_id,
        denials,
        tools,
        error: r.error,
        output,
        outputTruncated: r.output_truncated === 1,
        streamed: r.outcome === 'running' ? (liveEntry?.streamed ?? false) : r.streamed === 1,
        summary: output.trim().split(/\r?\n/).filter(Boolean).slice(0, 2).join(' ').slice(0, 400),
        recent,
        processes,
        reviewSessionId: r.review_id,
        exposes,
        resume:
          r.provider_id === 'claude-code'
            ? { documented: true, how: r.provider_session_id === null ? 'Claude Code documents resuming a session with its session id, but it printed none for this run.' : `Claude Code documents resuming this session in a terminal: claude --resume ${r.provider_session_id}. The app does not resume runs itself.` }
            : { documented: false, how: r.provider_id === 'ollama' ? 'A local model keeps no session to resume.' : 'The app has not verified a documented way to resume a Codex run, so none is offered.' },
        notes,
      };
    },

    recover() {
      return db.run("UPDATE run_sessions SET outcome = 'interrupted', ended_at = ?, error = 'The app closed while this run was active, so how it ended is unknown.' WHERE outcome = 'running'", now().toISOString()).changes;
    },
  };
}

