import { useCallback, useEffect, useState } from 'react';
import type { GitOverview } from '@shared/changes';
import type { IpcResult, SerializedError } from '@shared/errors';
import { formatTime } from '../../lib/activity';

/** Branches, named checkpoints with what Git cannot protect, and separate working trees (spec §14, §11). */
export function GitTools({ projectId }: { projectId: string }) {
  const [view, setView] = useState<GitOverview | undefined>();
  const [problem, setProblem] = useState<SerializedError | undefined>();
  const [checkpoint, setCheckpoint] = useState('');
  const [tree, setTree] = useState('');
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((n) => n + 1), []);

  useEffect(() => window.api.on('activity:appended', (event) => (event.kind.startsWith('git.') || event.kind.startsWith('changes.')) && reload()), [reload]);

  useEffect(() => {
    let cancelled = false;
    void window.api.invoke('git:overview', { projectId }).then((result) => {
      if (cancelled) return;
      if (result.ok) setView(result.value);
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
    return result.value;
  };

  return (
    <section className="card" aria-label="Branches, checkpoints and working trees">
      <div className="card__head">
        <h2>Branches and checkpoints</h2>
      </div>
      {problem !== undefined && (
        <p role="alert">
          {problem.message} {problem.hint}
        </p>
      )}
      {view?.note !== undefined && view.note !== '' && <p className="empty">{view.note}</p>}
      {view !== undefined && view.branches.length > 0 && (
        <ul className="rows" aria-label="Branches">
          {view.branches.map((b) => (
            <li key={b.name}>
              <strong className="mono">{b.name}</strong>
              {b.current && <span className="badge"> current</span>} <span className="muted mono">{b.commit}</span>
              {b.upstream !== null && <span className="muted"> → {b.upstream}</span>}
            </li>
          ))}
        </ul>
      )}

      {view !== undefined && view.note === '' && (
        <>
          <h3>Checkpoints</h3>
          <div className="field">
            <label htmlFor="checkpoint-name">Save a checkpoint</label>
            <input id="checkpoint-name" value={checkpoint} placeholder="for example before-the-big-change" onChange={(event) => setCheckpoint(event.target.value)} />
            <button
              type="button"
              className="btn"
              disabled={checkpoint.trim() === ''}
              onClick={() =>
                void act(window.api.invoke('git:checkpoint', { projectId, name: checkpoint.trim() })).then((done) => {
                  if (done !== undefined) setCheckpoint('');
                })
              }
            >
              Save checkpoint
            </button>
          </div>
          {view.checkpoints.length === 0 ? (
            <p className="empty">No checkpoints yet. One is saved automatically before every run that may change files.</p>
          ) : (
            <ul className="rows" aria-label="Checkpoints">
              {view.checkpoints.map((c) => (
                <li key={c.ref}>
                  <strong className="mono">{c.name}</strong> <span className="muted">· {formatTime(c.at)} · {c.commit.slice(0, 8)}</span>
                </li>
              ))}
            </ul>
          )}
          <div role="note" aria-label="What Git protects">
            {view.protection.notes.map((note) => (
              <p key={note} className="muted">
                {note}
              </p>
            ))}
          </div>

          <h3>Working trees</h3>
          <p className="muted">A working tree is a second folder on its own branch, so independent work cannot touch your project folder. It can only be added or removed while no agent is writing to the project.</p>
          <div className="field">
            <label htmlFor="worktree-name">New working tree</label>
            <input id="worktree-name" value={tree} placeholder="for example dash-move" onChange={(event) => setTree(event.target.value)} />
            <button
              type="button"
              className="btn"
              disabled={tree.trim() === ''}
              onClick={() =>
                void act(window.api.invoke('worktrees:add', { projectId, name: tree.trim() })).then((done) => {
                  if (done?.created === true) setTree('');
                })
              }
            >
              Add working tree…
            </button>
          </div>
          {view.worktrees.length > 0 && (
            <ul className="rows" aria-label="Working trees">
              {view.worktrees.map((w) => (
                <li key={w.id}>
                  <strong>{w.name}</strong> <span className="muted mono">· {w.branch} · {w.path}</span>
                  {!w.present && <span className="badge" data-severity="warning"> folder missing</span>}{' '}
                  <button type="button" className="btn" aria-label={`Remove the working tree ${w.name}`} onClick={() => void act(window.api.invoke('worktrees:remove', { id: w.id }))}>
                    Remove…
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
