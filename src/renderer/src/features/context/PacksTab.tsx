import { useEffect, useState } from 'react';
import type { ContextPack, PackSummary } from '@shared/context';
import type { SerializedError } from '@shared/errors';
import type { Project } from '@shared/projects';
import { formatTime } from '../../lib/activity';
import { useSettings } from '../../lib/settings';

const DESTINATIONS = [
  { value: 'Not sent anywhere yet', cloud: false },
  { value: 'Claude Code (cloud)', cloud: true },
  { value: 'Codex CLI (cloud)', cloud: true },
  { value: 'Ollama (local)', cloud: false },
] as const;

function PackView({ pack, onSave, onRefresh }: { pack: ContextPack; onSave?: (title: string) => void; onRefresh?: () => void }) {
  const [title, setTitle] = useState(pack.title);
  const [copied, setCopied] = useState(false);
  const cloud = DESTINATIONS.find((d) => d.value === pack.destination)?.cloud === true;
  return (
    <section className="card" aria-label="Context pack preview">
      <div className="card__head">
        <h2>{pack.saved ? pack.title : 'Preview'}</h2>
        <span className="badge" title="Characters divided by four; each provider counts tokens its own way">
          about {pack.estimate.toLocaleString('en-US')} of {pack.budget.toLocaleString('en-US')} tokens (estimate)
        </span>
      </div>
      <p>
        Destination: <strong>{pack.destination}</strong>
        {cloud && <span className="muted"> · nothing is sent until you do it; this is everything that would be sent</span>}
      </p>
      {pack.stale.length > 0 && (
        <p role="alert">
          This pack is out of date: {pack.stale.map((s) => `${s.path} (${s.change})`).join(', ')}. Rebuild it to include the current files.
        </p>
      )}
      <h3>Included ({pack.items.length})</h3>
      {pack.items.length === 0 && <p className="empty">Nothing was selected.</p>}
      <ul className="rows" aria-label="Included in the pack">
        {pack.items.map((item) => (
          <li key={item.path} className="backup-row">
            <span className="mono">{item.path}</span>
            <span className="muted">{item.reason}</span>
            <span className="badge">~{item.estimate.toLocaleString('en-US')}</span>
            <span />
          </li>
        ))}
      </ul>
      {pack.excluded.length > 0 && (
        <>
          <h3>Left out ({pack.excluded.length})</h3>
          <ul className="rows" aria-label="Left out of the pack">
            {pack.excluded.map((item) => (
              <li key={`${item.path}:${item.reason}`} className="backup-row">
                <span className="mono">{item.path}</span>
                <span className="muted">{item.reason}</span>
                <span />
                <span />
              </li>
            ))}
          </ul>
        </>
      )}
      <details>
        <summary>The full text that would be sent</summary>
        <pre className="diff" aria-label="Pack text">
          {pack.text}
        </pre>
      </details>
      <div className="actions">
        {!pack.saved && onSave !== undefined && (
          <>
            <label>
              <span className="muted">Name </span>
              <input value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} aria-label="Pack name" />
            </label>
            <button type="button" className="btn btn--primary" onClick={() => onSave(title)}>
              Save the pack
            </button>
          </>
        )}
        {pack.saved && onRefresh !== undefined && (
          <button type="button" className="btn" onClick={onRefresh}>
            Rebuild with the current files
          </button>
        )}
        <button
          type="button"
          className="btn"
          onClick={() =>
            void navigator.clipboard.writeText(pack.text).then(
              () => setCopied(true),
              () => setCopied(false),
            )
          }
        >
          Copy the text
        </button>
        {copied && <span role="status">Copied.</span>}
      </div>
    </section>
  );
}

/** Context packs (spec §7): build, preview in full, save, and see when a saved pack went out of date. */
export function PacksTab({ project }: { project: Project }) {
  const { settings } = useSettings();
  const [task, setTask] = useState('');
  const [budget, setBudget] = useState(settings['context.defaultBudget']);
  const [destination, setDestination] = useState<string>(DESTINATIONS[0].value);
  const [picked, setPicked] = useState('');
  const [pack, setPack] = useState<ContextPack | undefined>();
  const [saved, setSaved] = useState<PackSummary[]>([]);
  const [error, setError] = useState<SerializedError | undefined>();
  const [busy, setBusy] = useState(false);

  const [version, setVersion] = useState(0);
  const loadList = (): void => setVersion((n) => n + 1);

  useEffect(() => {
    let cancelled = false;
    void window.api.invoke('packs:list', { projectId: project.id }).then((result) => {
      if (!cancelled && result.ok) setSaved(result.value);
    });
    return () => {
      cancelled = true;
    };
  }, [project.id, version]);

  const run = async (call: () => Promise<{ ok: true; value: ContextPack } | { ok: false; error: SerializedError }>): Promise<void> => {
    setBusy(true);
    const result = await call();
    setBusy(false);
    if (result.ok) {
      setError(undefined);
      setPack(result.value);
      loadList();
    } else setError(result.error);
  };

  return (
    <div className="stack">
      <section className="card" aria-label="Build a context pack">
        <div className="card__head">
          <h2>Build a pack for a task</h2>
        </div>
        <p className="muted">
          Picks the files, notes and decisions that matter for one task. Sensitive files, binaries, generated folders and very large files are never included. You see
          everything before anything is sent.
        </p>
        <div className="form">
          <label>
            What is the task?
            <textarea value={task} rows={3} maxLength={4000} onChange={(event) => setTask(event.target.value)} placeholder="For example: make the player move faster and add a dash" />
          </label>
          <label>
            Files to include for sure <span className="muted">(one project-relative path per line, optional)</span>
            <textarea value={picked} rows={2} onChange={(event) => setPicked(event.target.value)} />
          </label>
          <div className="field">
            <label htmlFor="pack-budget">Size budget (tokens, estimated)</label>
            <input id="pack-budget" type="number" min={500} max={200000} value={budget} onChange={(event) => setBudget(Number(event.target.value))} />
            <label htmlFor="pack-destination">Destination</label>
            <select id="pack-destination" value={destination} onChange={(event) => setDestination(event.target.value)}>
              {DESTINATIONS.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.value}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="actions">
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy || task.trim() === '' || !Number.isInteger(budget) || budget < 500}
            onClick={() =>
              void run(() =>
                window.api.invoke('packs:build', {
                  projectId: project.id,
                  task,
                  budget,
                  extraFiles: picked.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
                  destination,
                }),
              )
            }
          >
            {busy ? 'Building…' : 'Build the pack'}
          </button>
        </div>
        {error !== undefined && (
          <p role="alert">
            {error.message} {error.hint}
          </p>
        )}
      </section>

      {pack !== undefined && (
        <PackView
          pack={pack}
          {...(pack.saved
            ? { onRefresh: () => void run(() => window.api.invoke('packs:refresh', { projectId: project.id, id: pack.id })) }
            : { onSave: (title: string) => void run(() => window.api.invoke('packs:save', { projectId: project.id, title })) })}
        />
      )}

      <section className="card" aria-label="Saved context packs">
        <div className="card__head">
          <h2>Saved packs</h2>
        </div>
        {saved.length === 0 && <p className="empty">No saved packs yet.</p>}
        <ul className="rows" aria-label="Saved packs">
          {saved.map((item) => (
            <li key={item.id} className="backup-row">
              <span>
                <strong>{item.title}</strong> <span className="muted">· {formatTime(item.createdAt)} · {item.files} items · about {item.estimate.toLocaleString('en-US')} tokens</span>
              </span>
              {item.stale > 0 ? <span className="badge badge--warn">Out of date ({item.stale})</span> : <span className="badge">Up to date</span>}
              <button type="button" className="btn" aria-label={`Open ${item.title}`} onClick={() => void run(() => window.api.invoke('packs:get', { projectId: project.id, id: item.id }))}>
                Open
              </button>
              <button
                type="button"
                className="btn btn--danger"
                aria-label={`Delete ${item.title}`}
                onClick={() =>
                  void window.api.invoke('packs:remove', { projectId: project.id, id: item.id }).then(() => {
                    if (pack?.id === item.id) setPack(undefined);
                    loadList();
                  })
                }
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
