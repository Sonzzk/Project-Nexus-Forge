import { useCallback, useEffect, useState } from 'react';
import { FINAL_RUN_STATES, RUN_STATE_LABELS } from '@shared/agents';
import type { SerializedError } from '@shared/errors';
import { PROVIDER_LABELS } from '@shared/providers';
import { SESSION_OUTCOME_LABELS, type Session, type SessionSummary } from '@shared/sessions';
import { useNav } from '../../app/navigation';
import { formatTime } from '../../lib/activity';
import { useProjects } from '../../lib/projects';
import { useQueue } from '../../lib/queue';
import { QueueRow } from '../workbench/WorkbenchPage';

const duration = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
};
const NOT_EXPOSED = 'Not exposed by this provider';

/** One running or finished agent run: only what was observed, and a plain label for what the provider does not say (spec §15). */
function SessionDetail({ runId, onReview }: { runId: string; onReview: () => void }) {
  const [session, setSession] = useState<Session | undefined>();
  const [error, setError] = useState<SerializedError | undefined>();
  const [live, setLive] = useState<{ runId: string; text: string } | undefined>();
  const [now, setNow] = useState(() => Date.now());
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((n) => n + 1), []);

  useEffect(() => window.api.on('activity:appended', (event) => (event.kind.startsWith('agent.') || event.kind.startsWith('changes.') || event.kind.startsWith('usage.')) && reload()), [reload]);
  useEffect(() => window.api.on('sessions:output', (event) => event.runId === runId && setLive(event)), [runId]);
  useEffect(() => {
    let cancelled = false;
    void window.api.invoke('sessions:get', { runId }).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setSession(result.value);
        setError(undefined);
      } else setError(result.error);
    });
    return () => {
      cancelled = true;
    };
  }, [runId, version]);
  const running = session?.outcome === 'running';
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  if (error !== undefined)
    return (
      <p role="alert">
        {error.message} {error.hint}
      </p>
    );
  if (session === undefined) return <p className="empty">Loading…</p>;
  const output = running && live?.runId === runId ? live.text : session.output;
  const elapsed = running ? Math.max(0, now - new Date(session.startedAt).getTime()) : session.elapsedMs;

  return (
    <section className="card" aria-label="Session" data-outcome={session.outcome}>
      <div className="card__head">
        <h3>
          {session.roleLabel} · {session.taskTitle ?? 'no task'}
        </h3>
        <span className="badge" data-state={session.outcome}>
          {SESSION_OUTCOME_LABELS[session.outcome]}
        </span>
      </div>
      <dl className="facts">
        <dt>Provider</dt>
        <dd>
          {PROVIDER_LABELS[session.provider]}
          {session.model === '' ? '' : ` · ${session.model}`}
        </dd>
        <dt>Workflow state</dt>
        <dd>{RUN_STATE_LABELS[session.runState]}</dd>
        <dt>Working directory</dt>
        <dd className="mono">{session.workingDir}</dd>
        <dt>Started</dt>
        <dd>{formatTime(session.startedAt)}</dd>
        <dt>Elapsed</dt>
        <dd>{duration(elapsed)}{running ? ' so far' : ''}</dd>
        <dt>Exit status</dt>
        <dd>{session.exitCode !== null ? session.exitCode : running ? 'Not finished' : session.exposes.exitCode ? 'Not reported for this run' : NOT_EXPOSED}</dd>
        <dt>Provider session</dt>
        <dd className="mono">{session.providerSessionId ?? (session.exposes.sessionId ? (running ? 'Not printed yet' : 'None printed') : NOT_EXPOSED)}</dd>
      </dl>

      <h4>Permission requests</h4>
      {!session.exposes.denials ? (
        <p className="muted">{NOT_EXPOSED}. This provider does not report which requests were denied.</p>
      ) : session.denials.length === 0 ? (
        <p className="muted">{running ? 'None reported so far.' : 'None reported.'}</p>
      ) : (
        <ul className="rows" aria-label="Denied requests">
          {session.denials.map((d, i) => (
            <li key={i}>
              Denied: <strong>{d.tool}</strong> <span className="mono muted">{d.detail}</span>
            </li>
          ))}
        </ul>
      )}

      <h4>Commands and files the agent used</h4>
      {!session.exposes.toolEvents ? (
        <p className="muted">{NOT_EXPOSED}.</p>
      ) : session.tools.length === 0 ? (
        <p className="muted">{running ? 'Listed when the run ends.' : 'None reported.'}</p>
      ) : (
        <ul className="rows" aria-label="Tools used">
          {session.tools.map((t, i) => (
            <li key={i}>
              <strong>{t.tool}</strong> <span className="mono muted">{t.detail}</span>
            </li>
          ))}
        </ul>
      )}

      <h4>Changed files</h4>
      {session.reviewSessionId === null ? (
        <p className="muted">This run could not change files, so none are recorded.</p>
      ) : (
        <p>
          <button type="button" className="btn" onClick={onReview}>
            Review the changed files…
          </button>
        </p>
      )}

      <h4>Output</h4>
      {running && !session.streamed && <p className="muted">{session.exposes.streaming ? 'Nothing streamed yet.' : 'This provider returns its answer only when it finishes.'}</p>}
      {output === '' && !running && <p className="muted">No output was recorded.</p>}
      {output !== '' && <pre className="diff" aria-label="Output">{output}</pre>}
      {session.outputTruncated && <p className="muted">Only the end of the output is kept.</p>}
      {session.error !== '' && (
        <>
          <h4>Error output</h4>
          <pre className="diff" aria-label="Error output">{session.error}</pre>
        </>
      )}
      {session.summary !== '' && !running && (
        <>
          <h4>Summary</h4>
          <p>{session.summary}</p>
        </>
      )}

      <h4>Recent activity</h4>
      {session.recent.length === 0 ? (
        <p className="muted">Nothing recorded for this run.</p>
      ) : (
        <ul className="rows" aria-label="Recent activity of this run">
          {session.recent.map((r, i) => (
            <li key={i}>
              <span className="muted">{formatTime(r.at)}</span> {r.summary}
            </li>
          ))}
        </ul>
      )}
      {session.processes.length > 0 && (
        <ul className="rows muted" aria-label="Programs started">
          {session.processes.map((p, i) => (
            <li key={i}>
              {p.program}: {p.status}
              {p.exitCode !== null ? `, exit code ${p.exitCode}` : ''}
            </li>
          ))}
        </ul>
      )}
      <p className="muted">Resume: {session.resume.how}</p>
      {session.notes.map((note) => (
        <p key={note} className="muted">
          {note}
        </p>
      ))}
    </section>
  );
}

/** Live sessions of the selected project, and its command queue with priorities and cancel (spec §15). */
export function SessionsTab() {
  const { selected } = useProjects();
  const { go } = useNav();
  const { view, error, reload } = useQueue(selected?.id);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [open, setOpen] = useState<string | undefined>();
  const [problem, setProblem] = useState<SerializedError | undefined>();
  const [version, setVersion] = useState(0);
  const projectId = selected?.id;

  useEffect(() => window.api.on('activity:appended', (event) => event.kind.startsWith('agent.') && setVersion((n) => n + 1)), []);
  useEffect(() => {
    if (projectId === undefined) return;
    let cancelled = false;
    void window.api.invoke('sessions:list', { projectId }).then((result) => {
      if (cancelled) return;
      if (result.ok) setSessions(result.value);
      else setProblem(result.error);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, version]);

  if (selected === undefined) return <p className="empty">Select a project to see its sessions and queue.</p>;
  const queued = (view?.runs ?? []).filter((r) => !FINAL_RUN_STATES.includes(r.state));
  const shown = problem ?? error;

  return (
    <div className="stack">
      {shown !== undefined && (
        <p role="alert">
          {shown.message} {shown.hint}
        </p>
      )}
      <section aria-label="Command queue" className="stack">
        <h2>Command queue · {selected.name}</h2>
        {queued.length === 0 ? (
          <p className="empty">Nothing is queued or running.</p>
        ) : (
          <ul className="rows" aria-label="Queued and running runs">
            {queued.map((run) => (
              <QueueRow key={run.id} run={run} writesEnabled={view?.writesEnabled ?? false} maxAttempts={view?.maxAttempts ?? 1} onChanged={reload} onError={setProblem} />
            ))}
          </ul>
        )}
      </section>
      <section aria-label="Sessions" className="stack">
        <h2>Sessions</h2>
        {sessions.length === 0 ? (
          <p className="empty">No agent run has started in this project yet.</p>
        ) : (
          <ul className="rows" aria-label="Session list">
            {sessions.map((s) => (
              <li key={s.runId}>
                <button type="button" className="row" aria-pressed={s.runId === open} aria-label={`Open the session of the ${s.roleLabel} for ${s.taskTitle ?? 'no task'}`} onClick={() => setOpen(s.runId)}>
                  <span className="dot" data-severity={s.outcome === 'failed' ? 'error' : s.outcome === 'running' ? 'info' : 'info'} />
                  <span className="row__summary">
                    <strong>{s.roleLabel}</strong> <span className="muted">· {s.taskTitle ?? 'no task'} · {PROVIDER_LABELS[s.provider]} · {formatTime(s.startedAt)} · </span>
                    {SESSION_OUTCOME_LABELS[s.outcome]}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {open !== undefined && <SessionDetail key={open} runId={open} onReview={() => go('git')} />}
      </section>
    </div>
  );
}
