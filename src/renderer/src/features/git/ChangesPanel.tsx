import { useCallback, useEffect, useState } from 'react';
import { SESSION_STATUS_LABELS, type ChangedFile, type ChangeSession, type Review } from '@shared/changes';
import type { IpcResult, SerializedError } from '@shared/errors';
import { formatTime } from '../../lib/activity';

/** One line of a unified diff, classed so additions, removals and hunk headers read at a glance. */
function DiffText({ diff }: { diff: string }) {
  const lines = diff.split('\n');
  return (
    <pre className="diff" aria-label="Diff">
      {lines.map((line, i) => (
        <span key={i} className={line.startsWith('@@') ? 'diff__hunk' : line.startsWith('+') && !line.startsWith('+++') ? 'diff__add' : line.startsWith('-') && !line.startsWith('---') ? 'diff__del' : undefined}>
          {line}
          {'\n'}
        </span>
      ))}
    </pre>
  );
}

const size = (bytes: number | null): string => (bytes === null ? '—' : bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${bytes.toLocaleString('en-US')} B`);

function FileEntry({ file }: { file: ChangedFile }) {
  return (
    <li>
      <details>
        <summary>
          <strong className="mono">{file.path}</strong>{' '}
          <span className="muted">
            · {file.status === 'added' ? 'new' : file.status}
            {file.binary ? ` · binary · ${size(file.sizeBefore)} → ${size(file.sizeAfter)}` : file.status === 'deleted' || file.hidden ? '' : ` · +${file.additions} −${file.deletions}`}
          </span>
          {file.overlap && <span className="badge" data-severity="warning"> had your changes</span>}
          {file.hidden && <span className="badge" data-severity="warning"> may hold secrets</span>}
        </summary>
        {file.note !== '' && <p className="muted">{file.note}</p>}
        {file.diff !== '' && <DiffText diff={file.diff} />}
      </details>
    </li>
  );
}

/** What an agent changed, per run: the files against the state saved before it, with diffs, and approve, reject and revert (spec §14). */
export function ChangesPanel({ projectId, onChanged }: { projectId: string; onChanged: () => void }) {
  const [sessions, setSessions] = useState<ChangeSession[]>([]);
  const [open, setOpen] = useState<Review | undefined>();
  const [problem, setProblem] = useState<SerializedError | undefined>();
  const [message, setMessage] = useState('');
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((n) => n + 1), []);

  useEffect(() => window.api.on('activity:appended', (event) => (event.kind.startsWith('changes.') || event.kind.startsWith('agent.')) && reload()), [reload]);

  useEffect(() => {
    let cancelled = false;
    void window.api.invoke('changes:sessions', { projectId }).then((result) => {
      if (cancelled) return;
      if (result.ok) setSessions(result.value);
      else setProblem(result.error);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, version]);

  const act = async <T,>(work: Promise<IpcResult<T>>): Promise<T | undefined> => {
    const result = await work;
    if (!result.ok) {
      setProblem(result.error);
      return undefined;
    }
    setProblem(undefined);
    reload();
    onChanged();
    return result.value;
  };
  const show = async (id: string): Promise<void> => {
    const result = await window.api.invoke('changes:review', { sessionId: id });
    if (result.ok) {
      setOpen(result.value);
      setProblem(undefined);
    } else setProblem(result.error);
  };
  const finished = (id: string): void => {
    setOpen((current) => (current?.session.id === id ? undefined : current));
    reload();
  };

  return (
    <section className="card" aria-label="Agent changes" data-feature="changes">
      <div className="card__head">
        <h2>Agent changes</h2>
      </div>
      <p className="muted">
        Each run that may change files is recorded against the state saved just before it. Review shows only what that run changed, not your own earlier uncommitted work. Committing, rejecting and reverting each ask you
        first; nothing is reset, and rejecting keeps a copy.
      </p>
      {problem !== undefined && (
        <p role="alert">
          {problem.message} {problem.hint}
        </p>
      )}
      {message !== '' && <p role="status">{message}</p>}
      {sessions.length === 0 ? (
        <p className="empty">No agent has changed files in this project yet.</p>
      ) : (
        <ul className="rows" aria-label="Review sessions">
          {sessions.map((s) => (
            <li key={s.id}>
              <strong>{s.roleLabel}</strong> <span className="muted">· {s.taskTitle ?? 'no task'} · {formatTime(s.startedAt)} · </span>
              <span className="badge" data-status={s.status}>
                {SESSION_STATUS_LABELS[s.status]}
              </span>
              {s.runActive && <span className="muted"> · the run is still working</span>}
              {s.commit !== null && <span className="muted mono"> · {s.commit.slice(0, 8)}</span>}
              <div className="actions">
                <button type="button" className="btn" aria-label={`Review the changes of the ${s.roleLabel} for ${s.taskTitle ?? 'no task'}`} onClick={() => void show(s.id)}>
                  Review changes
                </button>
                {s.status === 'open' && (
                  <>
                    <button
                      type="button"
                      className="btn btn--primary"
                      disabled={s.runActive}
                      aria-label={`Commit the changes of the ${s.roleLabel}`}
                      onClick={() =>
                        void act(window.api.invoke('changes:approve', { sessionId: s.id })).then((done) => {
                          if (done?.committed === true) {
                            setMessage(`Committed as ${done.commit?.slice(0, 8) ?? 'a new commit'}.`);
                            finished(s.id);
                          }
                        })
                      }
                    >
                      Commit…
                    </button>
                    <button
                      type="button"
                      className="btn"
                      disabled={s.runActive}
                      aria-label={`Reject the changes of the ${s.roleLabel}`}
                      onClick={() =>
                        void act(window.api.invoke('changes:reject', { sessionId: s.id })).then((done) => {
                          if (done?.rejected === true) {
                            setMessage(done.savedTo === undefined ? 'Rejected.' : `Rejected. A copy of what was there is in ${done.savedTo}.`);
                            finished(s.id);
                          }
                        })
                      }
                    >
                      Reject…
                    </button>
                  </>
                )}
                {s.status === 'approved' && s.commit !== null && (
                  <button
                    type="button"
                    className="btn"
                    aria-label={`Revert the commit of the ${s.roleLabel}`}
                    onClick={() =>
                      void act(window.api.invoke('changes:revert', { projectId, commit: s.commit ?? '' })).then((done) => {
                        if (done?.reverted === true) setMessage(`Reverted with a new commit ${done.commit?.slice(0, 8) ?? ''}.`);
                      })
                    }
                  >
                    Revert…
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {open !== undefined && (
        <div aria-label="Review">
          <h3>
            {open.session.roleLabel} · {open.session.taskTitle ?? 'no task'} · {open.files.length} file{open.files.length === 1 ? '' : 's'}
          </h3>
          {open.notes.map((note) => (
            <p key={note} className="muted">
              {note}
            </p>
          ))}
          <ul className="rows" aria-label="Changed files">
            {open.files.map((file) => (
              <FileEntry key={file.path} file={file} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
