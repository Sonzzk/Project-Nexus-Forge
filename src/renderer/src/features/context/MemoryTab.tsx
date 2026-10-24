import { useEffect, useState } from 'react';
import { DOC_INFO, MEMORY_STORAGES, docTemplate, type DocType, type MemoryOverview, type MemoryPreview, type MemoryStorage } from '@shared/context';
import type { SerializedError } from '@shared/errors';
import type { Project } from '@shared/projects';

const STORAGE_LABELS: Record<MemoryStorage, string> = {
  app: 'In the app (private database)',
  project: 'In the project folder',
  'docs-dir': 'In a documentation folder inside the project',
};

function Diff({ preview }: { preview: MemoryPreview }) {
  if (preview.unchanged) return <p className="muted">No change: the text is the same as what is stored.</p>;
  if (preview.diff === undefined) return <p className="muted">Too long to compare line by line ({preview.previousBytes} bytes before, {preview.bytes} after).</p>;
  if (preview.diff.length === 0) return <p className="muted">Only the end of the file changed (a final line break).</p>;
  return (
    <pre className="diff" aria-label="Changes">
      {preview.diff.map((line, index) =>
        line.kind === 'skip' ? (
          <div key={index} className="diff__skip">
            … {line.count} unchanged line{line.count === 1 ? '' : 's'} …
          </div>
        ) : (
          <div key={index} className={`diff__${line.kind}`}>
            {line.kind === 'add' ? '+ ' : line.kind === 'remove' ? '- ' : '  '}
            {line.text}
          </div>
        ),
      )}
    </pre>
  );
}

/** Project memory (spec §8): where the documents live, what exists, what is proposed, and an editor that previews every change. */
export function MemoryTab({ project, preload }: { project: Project; preload: { type: DocType; content: string } | undefined }) {
  const [overview, setOverview] = useState<MemoryOverview | undefined>();
  const [error, setError] = useState<SerializedError | undefined>();
  const [storage, setStorage] = useState<MemoryStorage>('app');
  const [docsDir, setDocsDir] = useState('docs');
  const [editing, setEditing] = useState<{ type: DocType; location: string; original: string; isNew: boolean } | undefined>();
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<MemoryPreview | undefined>();
  const [message, setMessage] = useState('');

  const [version, setVersion] = useState(0);
  const [request, setRequest] = useState<{ type: DocType; startingText?: string; n: number } | undefined>();
  const [seenPreload, setSeenPreload] = useState(preload);
  const load = (): void => setVersion((n) => n + 1);
  const open = (type: DocType, startingText?: string): void => setRequest((current) => ({ type, ...(startingText === undefined ? {} : { startingText }), n: (current?.n ?? 0) + 1 }));

  // A handoff sent here from the other tab opens its document. Adjusting state while rendering is the supported way to react to a changed prop.
  if (preload !== seenPreload) {
    setSeenPreload(preload);
    if (preload !== undefined) open(preload.type, preload.content);
  }

  useEffect(() => {
    let cancelled = false;
    void window.api.invoke('memory:overview', { projectId: project.id }).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setOverview(result.value);
        setStorage(result.value.storage);
        if (result.value.docsDir !== '') setDocsDir(result.value.docsDir);
        setError(undefined);
      } else setError(result.error);
    });
    return () => {
      cancelled = true;
    };
  }, [project.id, version]);

  useEffect(() => {
    if (request === undefined) return;
    let cancelled = false;
    void window.api.invoke('memory:read', { projectId: project.id, docType: request.type }).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setError(undefined);
      setMessage('');
      setPreview(undefined);
      setEditing({ type: request.type, location: result.value.location, original: result.value.content, isNew: !result.value.exists });
      setText(request.startingText ?? (result.value.exists ? result.value.content : docTemplate(request.type, project.name)));
    });
    return () => {
      cancelled = true;
    };
  }, [request, project.id, project.name]);

  const run = async <T,>(call: () => Promise<{ ok: true; value: T } | { ok: false; error: SerializedError }>): Promise<T | undefined> => {
    const result = await call();
    if (!result.ok) {
      setError(result.error);
      return undefined;
    }
    setError(undefined);
    return result.value;
  };

  return (
    <div className="stack">
      {error !== undefined && (
        <p role="alert">
          {error.message} {error.hint}
        </p>
      )}
      {overview !== undefined && (
        <section className="card" aria-label="Where memory is stored">
          <div className="card__head">
            <h2>Where the documents live</h2>
          </div>
          <div className="field">
            <label htmlFor="memory-storage">Store project memory</label>
            <select id="memory-storage" value={storage} onChange={(event) => setStorage(MEMORY_STORAGES.find((s) => s === event.target.value) ?? 'app')}>
              {MEMORY_STORAGES.map((value) => (
                <option key={value} value={value}>
                  {STORAGE_LABELS[value]}
                </option>
              ))}
            </select>
            {storage === 'docs-dir' && (
              <>
                <label htmlFor="memory-docs-dir">Folder</label>
                <input id="memory-docs-dir" value={docsDir} maxLength={200} onChange={(event) => setDocsDir(event.target.value)} />
              </>
            )}
            <button
              type="button"
              className="btn"
              disabled={storage === overview.storage && (storage !== 'docs-dir' || docsDir === overview.docsDir)}
              onClick={() =>
                void run(() => window.api.invoke('memory:setStorage', { projectId: project.id, storage, docsDir })).then((value) => {
                  if (value === undefined) return;
                  setOverview(value);
                  setEditing(undefined);
                })
              }
            >
              Use this
            </button>
          </div>
          <p className="muted">
            Nothing is written into the project unless you choose a file location, look at the change and confirm it. The app database is the safe default.
          </p>
        </section>
      )}

      {overview !== undefined && overview.proposal.length > 0 && (
        <section className="card" aria-label="Suggested documents">
          <div className="card__head">
            <h2>Suggested minimal set</h2>
          </div>
          <ul className="rows">
            {overview.proposal.map((item) => (
              <li key={item.type} className="backup-row">
                <span>
                  <strong>{DOC_INFO[item.type].label}</strong> <span className="muted">· {item.reason}</span>
                </span>
                <span />
                <span />
                <button type="button" className="btn" onClick={() => open(item.type)}>
                  Start it…
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {overview !== undefined && (
        <section className="card" aria-label="Memory documents">
          <div className="card__head">
            <h2>Documents</h2>
          </div>
          <ul className="rows" aria-label="Documents">
            {overview.docs.map((doc) => (
              <li key={doc.type} className="backup-row">
                <span>
                  <strong>{DOC_INFO[doc.type].label}</strong> <span className="muted">· {DOC_INFO[doc.type].about}</span>
                  {doc.foundInProject !== undefined && (
                    <span className="muted">
                      {' '}
                      · the project has <span className="mono">{doc.foundInProject}</span>
                    </span>
                  )}
                </span>
                <span className="mono muted">{doc.location}</span>
                <span className="badge">{doc.exists ? `${doc.bytes.toLocaleString('en-US')} B` : 'Not created'}</span>
                <button type="button" className="btn" aria-label={`${doc.exists ? 'Edit' : 'Create'} ${DOC_INFO[doc.type].label}`} onClick={() => open(doc.type)}>
                  {doc.exists ? 'Edit…' : 'Create…'}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {editing !== undefined && (
        <section className="card" aria-label={`Editing ${DOC_INFO[editing.type].label}`}>
          <div className="card__head">
            <h2>
              {DOC_INFO[editing.type].label} <span className="muted mono">· {editing.location}</span>
            </h2>
          </div>
          <textarea
            aria-label="Document text"
            value={text}
            rows={14}
            className="mono"
            onChange={(event) => {
              setText(event.target.value);
              setPreview(undefined);
              setMessage('');
            }}
          />
          <div className="actions">
            <button
              type="button"
              className="btn"
              onClick={() => void run(() => window.api.invoke('memory:preview', { projectId: project.id, docType: editing.type, content: text })).then(setPreview)}
            >
              Preview changes
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={preview === undefined || preview.unchanged}
              onClick={() =>
                void run(() => window.api.invoke('memory:save', { projectId: project.id, docType: editing.type })).then((result) => {
                  if (result === undefined) return;
                  setMessage(result.written ? `Saved to ${result.location}.` : 'Not saved: you declined the confirmation.');
                  if (result.written) {
                    setPreview(undefined);
                    setEditing({ ...editing, original: text, isNew: false });
                    load();
                  }
                })
              }
            >
              {storage === 'app' ? 'Save' : 'Save into the project…'}
            </button>
            <button type="button" className="btn" onClick={() => setEditing(undefined)}>
              Close
            </button>
            <span role="status" className="muted">
              {message}
            </span>
          </div>
          {preview !== undefined && (
            <>
              <p>
                {preview.isNew ? 'New document' : 'Changes to the stored document'} · {preview.location}
                {preview.createsFolder && ' · the folder will be created'}
              </p>
              <Diff preview={preview} />
            </>
          )}
        </section>
      )}
    </div>
  );
}
