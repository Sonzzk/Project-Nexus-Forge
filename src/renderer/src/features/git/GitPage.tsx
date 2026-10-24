import { useCallback, useEffect, useState } from 'react';
import type { GitSummary } from '@shared/audit';
import type { SerializedError } from '@shared/errors';
import { formatTime } from '../../lib/activity';
import { useProjects } from '../../lib/projects';

/** Read-only Git facts about one project: branch, uncommitted changes and recent commits (spec §7, §20). */
export function useGitSummary(projectId: string | undefined): {
  git: GitSummary | undefined;
  loading: boolean;
  error: SerializedError | undefined;
  refresh: () => void;
} {
  const [tick, setTick] = useState(0);
  const key = `${projectId ?? ''}:${tick}`;
  const [state, setState] = useState<{ key: string; git?: GitSummary; error?: SerializedError } | undefined>();

  useEffect(() => {
    if (projectId === undefined) return;
    let cancelled = false;
    void window.api.invoke('git:summary', { projectId }).then((result) => {
      if (!cancelled) setState(result.ok ? { key, git: result.value } : { key, error: result.error });
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, key]);

  const current = state?.key === key ? state : undefined;
  const git = current?.git;
  const error = current?.error;
  const loading = projectId !== undefined && current === undefined;

  return { git, loading, error, refresh: useCallback(() => setTick((n) => n + 1), []) };
}

export function GitFacts({ git }: { git: GitSummary }) {
  if (!git.isRepository)
    return <p className="empty">{git.message ?? 'Not a Git repository.'}</p>;
  const c = git.changes;
  const total = c === undefined ? 0 : c.staged + c.modified + c.untracked + c.conflicted;
  return (
    <>
      <dl className="facts">
        <dt>Branch</dt>
        <dd className="mono">
          {git.branch ?? 'unknown'}
          {git.upstream !== undefined && <span className="muted"> → {git.upstream}</span>}
        </dd>
        {git.ahead !== undefined && git.behind !== undefined && (
          <>
            <dt>Ahead / behind</dt>
            <dd>
              {git.ahead} ahead · {git.behind} behind
            </dd>
          </>
        )}
        <dt>Changes</dt>
        <dd>
          {c === undefined
            ? 'Unknown'
            : total === 0
              ? 'Working tree is clean'
              : `${c.staged} staged · ${c.modified} modified · ${c.untracked} untracked${c.conflicted > 0 ? ` · ${c.conflicted} in conflict` : ''}`}
        </dd>
      </dl>
      {git.recentCommits !== undefined && git.recentCommits.length === 0 && (
        <p className="empty">No commits yet.</p>
      )}
      {git.recentCommits !== undefined && git.recentCommits.length > 0 && (
        <ul className="rows" aria-label="Recent commits">
          {git.recentCommits.map((commit) => (
            <li key={commit.hash} className="commit">
              <span className="mono">{commit.hash.slice(0, 8)}</span> <strong>{commit.subject}</strong>
              <span className="muted">
                {' '}
                · {commit.author} · {formatTime(commit.date)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function GitPage() {
  const { selected } = useProjects();
  const { git, loading, error, refresh } = useGitSummary(selected?.id);
  return (
    <div className="page">
      <header className="page__head">
        <h1>Git and Changes</h1>
        <p className="muted">
          Read-only. Branch, uncommitted changes and recent commits of the selected project. Diff review and revert
          arrive in Step 16.
        </p>
      </header>
      {selected === undefined ? (
        <p className="empty">Select a project to see its Git status.</p>
      ) : (
        <section className="card" aria-label={`Git status of ${selected.name}`}>
          <div className="card__head">
            <h2>{selected.name}</h2>
            <button type="button" className="btn" disabled={loading} onClick={refresh}>
              {loading ? 'Reading…' : 'Refresh'}
            </button>
          </div>
          {error !== undefined && (
            <p role="alert">
              {error.message} {error.hint}
            </p>
          )}
          {git !== undefined && <GitFacts git={git} />}
          {git === undefined && error === undefined && <p className="empty">Reading…</p>}
        </section>
      )}
    </div>
  );
}
