import { useCallback, useEffect, useState } from 'react';
import { ASSET_CATEGORIES, CATEGORY_LABELS, previewUrl, type AssetCategory, type AssetItem, type AssetSearchResult, type OpsPreview } from '@shared/assets';
import type { IpcResult, SerializedError } from '@shared/errors';
import type { Task } from '@shared/tasks';
import { formatTime } from '../../lib/activity';

const PAGE = 24;
const size = (bytes: number): string => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(bytes === 0 ? 0 : 1, Math.round(bytes / 1024))} KB`);

/** The searchable list of the project's assets, with previews of common images and the notes you keep on each file (spec §17). */
export function InventoryTab({ projectId, refreshKey, scanned, onChanged }: { projectId: string; refreshKey: number; scanned: boolean; onChanged: () => void }) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<AssetCategory | null>(null);
  const [tag, setTag] = useState('');
  const [annotatedOnly, setAnnotatedOnly] = useState(false);
  const [offset, setOffset] = useState(0);
  const [result, setResult] = useState<AssetSearchResult | undefined>();
  const [selected, setSelected] = useState<string | undefined>();
  const [problem, setProblem] = useState<SerializedError | undefined>();
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let cancelled = false;
    void window.api.invoke('assets:search', { projectId, query, category, tag, taskId: null, annotatedOnly, limit: PAGE, offset }).then((r) => {
      if (cancelled) return;
      if (r.ok) {
        setResult(r.value);
        setProblem(undefined);
      } else setProblem(r.error);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, query, category, tag, annotatedOnly, offset, refreshKey]);

  const item = result?.items.find((i) => i.path === selected);
  const done = useCallback(
    (message: string) => {
      setNotice(message);
      setSelected(undefined);
      onChanged();
    },
    [onChanged],
  );
  const empty = result !== undefined && result.total === 0;

  return (
    <section className="card" aria-label="Asset inventory">
      <div className="form" role="search" aria-label="Search the assets">
        <label>
          Search
          <input
            type="search"
            value={query}
            placeholder="path, note, tag or source"
            onChange={(event) => {
              setQuery(event.target.value);
              setOffset(0);
            }}
          />
        </label>
        <div className="field">
          <label htmlFor="asset-category">Category</label>
          <select
            id="asset-category"
            value={category ?? ''}
            onChange={(event) => {
              setCategory(ASSET_CATEGORIES.find((c) => c === event.target.value) ?? null);
              setOffset(0);
            }}
          >
            <option value="">All ({result === undefined ? 0 : Object.values(result.counts).reduce((a, b) => a + b, 0)})</option>
            {ASSET_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABELS[c]} ({result?.counts[c] ?? 0})
              </option>
            ))}
          </select>
          <label htmlFor="asset-tag">Tag</label>
          <input
            id="asset-tag"
            value={tag}
            onChange={(event) => {
              setTag(event.target.value);
              setOffset(0);
            }}
          />
          <label>
            <input
              type="checkbox"
              checked={annotatedOnly}
              onChange={(event) => {
                setAnnotatedOnly(event.target.checked);
                setOffset(0);
              }}
            />{' '}
            Only files with my notes
          </label>
        </div>
      </div>
      {problem !== undefined && (
        <p role="alert">
          {problem.message} {problem.hint}
        </p>
      )}
      {notice !== '' && <p role="status">{notice}</p>}
      {!scanned && <p className="empty">Nothing is listed until the project has been scanned.</p>}
      {scanned && empty && <p className="empty">No asset matches.</p>}
      {result !== undefined && result.total > 0 && (
        <>
          <p className="muted" role="status">
            {result.total.toLocaleString('en-US')} match{result.total === 1 ? '' : 'es'}; showing {offset + 1} to {Math.min(offset + PAGE, result.total)}.
          </p>
          <ul className="rows" aria-label="Assets">
            {result.items.map((i) => (
              <li key={i.path} data-selected={i.path === selected ? 'true' : undefined}>
                {i.previewable && <img className="thumb" src={previewUrl(projectId, i.path)} alt={`Preview of ${i.path}`} width={48} height={48} loading="lazy" />}
                <strong className="mono">{i.path}</strong> <span className="muted">· {CATEGORY_LABELS[i.category]} · {size(i.bytes)} · {formatTime(i.modifiedAt)}</span>
                {i.annotation !== null && (
                  <span className="badge" data-status={i.annotation.status}>
                    {' '}
                    {i.annotation.status === 'changed' ? 'my notes · changed since' : 'my notes'}
                  </span>
                )}
                {i.annotation !== null && i.annotation.tags.length > 0 && <span className="muted"> · {i.annotation.tags.join(', ')}</span>}{' '}
                <button type="button" className="btn" aria-label={`Details of ${i.path}`} onClick={() => setSelected(i.path)}>
                  Details
                </button>
              </li>
            ))}
          </ul>
          <div className="actions">
            <button type="button" className="btn" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
              Previous
            </button>
            <button type="button" className="btn" disabled={offset + PAGE >= result.total} onClick={() => setOffset(offset + PAGE)}>
              Next
            </button>
          </div>
        </>
      )}
      {item !== undefined && <AssetDetail key={item.path} projectId={projectId} item={item} onChanged={onChanged} onDone={done} onClose={() => setSelected(undefined)} />}
    </section>
  );
}

function AssetDetail({ projectId, item, onChanged, onDone, onClose }: { projectId: string; item: AssetItem; onChanged: () => void; onDone: (message: string) => void; onClose: () => void }) {
  const [note, setNote] = useState(item.annotation?.note ?? '');
  const [tags, setTags] = useState((item.annotation?.tags ?? []).join(', '));
  const [source, setSource] = useState(item.annotation?.source ?? '');
  const [usage, setUsage] = useState(item.annotation?.usage ?? '');
  const [taskIds, setTaskIds] = useState<string[]>(item.annotation?.taskIds ?? []);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [target, setTarget] = useState(item.path);
  const [ops, setOps] = useState<OpsPreview | undefined>();
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState<SerializedError | undefined>();

  useEffect(() => {
    let cancelled = false;
    void window.api.invoke('tasks:list', { projectId }).then((r) => {
      if (!cancelled && r.ok) setTasks(r.value);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const fail = (error: SerializedError): void => {
    setProblem(error);
    setMessage('');
  };
  const save = (): void => {
    void window.api
      .invoke('assets:annotate', { projectId, relativePath: item.path, note, tags: tags.split(',').map((t) => t.trim()).filter(Boolean), source, usage, taskIds })
      .then((r) => {
        if (!r.ok) {
          fail(r.error);
          return;
        }
        setProblem(undefined);
        setMessage('Your notes were saved.');
        onChanged();
      });
  };
  const showPreview = (r: IpcResult<OpsPreview>): void => {
    if (r.ok) {
      setOps(r.value);
      setProblem(undefined);
    } else fail(r.error);
  };
  const previewMove = (): void => {
    void window.api.invoke('assets:previewMove', { projectId, moves: [{ from: item.path, to: target.trim() }] }).then(showPreview);
  };
  const previewTrash = (): void => {
    void window.api.invoke('assets:previewTrash', { projectId, relativePaths: [item.path] }).then(showPreview);
  };
  const apply = (): void => {
    if (ops === undefined) return;
    const work = ops.kind === 'move' ? window.api.invoke('assets:move', { projectId, moves: [{ from: item.path, to: target.trim() }] }) : window.api.invoke('assets:trash', { projectId, relativePaths: [item.path] });
    void work.then((r) => {
      if (!r.ok) {
        fail(r.error);
        return;
      }
      setProblem(undefined);
      setOps(undefined);
      if (r.value.done) onDone(ops.kind === 'move' ? `${item.path} was moved to ${target.trim()}.` : `${item.path} is in the Recycle Bin.`);
      else setMessage('Nothing changed: a window was declined.');
    });
  };

  return (
    <section aria-label={`Details of ${item.path}`} className="stack">
      <div className="card__head">
        <h4 className="mono">{item.path}</h4>
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="muted">
        {CATEGORY_LABELS[item.category]} · {item.extension} · {size(item.bytes)} · changed {formatTime(item.modifiedAt)}
      </p>
      {item.previewable ? (
        <img className="preview" src={previewUrl(projectId, item.path)} alt={`Preview of ${item.path}`} />
      ) : (
        <p className="muted">{item.category === 'engine' ? 'This is an engine format that only the engine can open, so only its details are shown.' : 'No preview is available for this type; only its details are shown.'}</p>
      )}
      {problem !== undefined && (
        <p role="alert">
          {problem.message} {problem.hint}
        </p>
      )}
      {message !== '' && <p role="status">{message}</p>}
      <div className="form" aria-label="Your notes on this file">
        <label>
          Note
          <textarea rows={2} maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} />
        </label>
        <label>
          Tags (separated by commas)
          <input value={tags} onChange={(event) => setTags(event.target.value)} />
        </label>
        <label>
          Source or owner
          <input value={source} maxLength={300} placeholder="where it came from, who made it, its license" onChange={(event) => setSource(event.target.value)} />
        </label>
        <label>
          Where it is used
          <input value={usage} maxLength={500} onChange={(event) => setUsage(event.target.value)} />
        </label>
        <fieldset>
          <legend>Tasks that need this file</legend>
          {tasks.length === 0 ? (
            <p className="muted">This project has no tasks yet.</p>
          ) : (
            tasks.slice(0, 40).map((t) => (
              <label key={t.id}>
                <input type="checkbox" checked={taskIds.includes(t.id)} onChange={(event) => setTaskIds(event.target.checked ? [...taskIds, t.id] : taskIds.filter((x) => x !== t.id))} /> {t.title}
              </label>
            ))
          )}
        </fieldset>
        <div className="actions">
          <button type="button" className="btn btn--primary" onClick={save}>
            Save my notes
          </button>
        </div>
      </div>

      <h5>Move, rename or remove</h5>
      <p className="muted">Nothing happens until you have seen a preview, allowed changes to this project and confirmed in a window. A move never overwrites a file and never changes the file type.</p>
      <div className="form">
        <label>
          New path in the project
          <input value={target} onChange={(event) => setTarget(event.target.value)} />
        </label>
        <div className="actions">
          <button type="button" className="btn" disabled={target.trim() === '' || target.trim() === item.path} onClick={previewMove}>
            Preview the move
          </button>
          <button type="button" className="btn" onClick={previewTrash}>
            Preview removal (Recycle Bin)
          </button>
        </div>
      </div>
      {ops !== undefined && (
        <div aria-label="Preview of the change" className="stack">
          {ops.problems.length > 0 && (
            <ul role="alert" className="rows">
              {ops.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          {ops.items.length > 0 && (
            <ul className="rows" aria-label="Files in the change">
              {ops.items.map((i) => (
                <li key={i.from} className="mono">
                  {i.from}
                  {i.to === null ? ' goes to the Recycle Bin' : ` -> ${i.to}`}
                </li>
              ))}
            </ul>
          )}
          <ul className="rows" aria-label="Warnings">
            {ops.warnings.map((w) => (
              <li key={w} className="muted">
                {w}
              </li>
            ))}
          </ul>
          <p className="muted">{ops.permitted ? 'This project already allows changes from this app.' : 'You will be asked to allow changes to this project first.'}</p>
          <button type="button" className="btn btn--primary" disabled={ops.problems.length > 0} onClick={apply}>
            {ops.kind === 'move' ? 'Move it…' : 'Move it to the Recycle Bin…'}
          </button>
        </div>
      )}
    </section>
  );
}
