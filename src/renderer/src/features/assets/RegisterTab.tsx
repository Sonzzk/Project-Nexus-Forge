import { useState } from 'react';
import type { MemoryPreview } from '@shared/context';
import type { SerializedError } from '@shared/errors';

/** ASSET_REGISTER.md (spec §8): built from the index and your notes, previewed, and saved where project memory keeps it. */
export function RegisterTab({ projectId }: { projectId: string }) {
  const [content, setContent] = useState<string | undefined>();
  const [preview, setPreview] = useState<MemoryPreview | undefined>();
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState<SerializedError | undefined>();

  const fail = (error: SerializedError): void => setProblem(error);
  const build = (): void => {
    setPreview(undefined);
    setMessage('');
    void window.api.invoke('assets:register', { projectId }).then((r) => {
      if (r.ok) {
        setContent(r.value.content);
        setProblem(undefined);
      } else fail(r.error);
    });
  };
  const showPreview = (): void => {
    if (content === undefined) return;
    void window.api.invoke('memory:preview', { projectId, docType: 'ASSET_REGISTER', content }).then((r) => {
      if (r.ok) {
        setPreview(r.value);
        setProblem(undefined);
      } else fail(r.error);
    });
  };
  const save = (): void => {
    void window.api.invoke('memory:save', { projectId, docType: 'ASSET_REGISTER' }).then((r) => {
      if (!r.ok) {
        fail(r.error);
        return;
      }
      setMessage(r.value.written ? `Saved to ${r.value.location}.` : 'Not saved: you declined the confirmation.');
      if (r.value.written) setPreview(undefined);
    });
  };

  return (
    <section className="card" aria-label="Asset register">
      <div className="card__head">
        <h3>Asset register</h3>
        <button type="button" className="btn btn--primary" onClick={build}>
          Build the register
        </button>
      </div>
      <p className="muted">
        The register lists the assets you annotated (source, use, tags, tasks) and a summary of the index. Nothing is written until you preview it and save it: by default into the app, or into the project after a diff and a confirmation (set that on Project Context).
      </p>
      {problem !== undefined && (
        <p role="alert">
          {problem.message} {problem.hint}
        </p>
      )}
      {content !== undefined && (
        <>
          <textarea readOnly rows={16} value={content} aria-label="Register text" />
          <div className="actions">
            <button type="button" className="btn" onClick={showPreview}>
              Preview what would be saved
            </button>
          </div>
        </>
      )}
      {preview !== undefined && (
        <div aria-label="Register preview" className="stack">
          <p role="status">
            {preview.unchanged ? 'No change: the stored ASSET_REGISTER is the same.' : preview.isNew ? 'A new document would be created' : 'The stored document would change'} at {preview.location} ({preview.bytes.toLocaleString('en-US')} bytes, was {preview.previousBytes.toLocaleString('en-US')}).
            {preview.createsFolder ? ' Its folder does not exist and would be created.' : ''}
          </p>
          {preview.diff !== undefined && preview.diff.some((line) => line.kind === 'add' || line.kind === 'remove') && (
            <pre className="diff" aria-label="Register changes">
              {preview.diff
                .flatMap((line) => (line.kind === 'add' ? [`+ ${line.text}`] : line.kind === 'remove' ? [`- ${line.text}`] : []))
                .slice(0, 80)
                .join('\n')}
            </pre>
          )}
          <button type="button" className="btn btn--primary" disabled={preview.unchanged} onClick={save}>
            Save the register…
          </button>
        </div>
      )}
      {message !== '' && <p role="status">{message}</p>}
    </section>
  );
}
