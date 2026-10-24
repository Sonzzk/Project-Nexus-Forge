import { useEffect, useState } from 'react';
import { HANDOFF_FIELDS, HANDOFF_LABELS, handoffMarkdown, type DocType, type Handoff, type HandoffFields } from '@shared/context';
import type { SerializedError } from '@shared/errors';
import type { Project } from '@shared/projects';
import { formatTime } from '../../lib/activity';

const EMPTY: HandoffFields = { requested: '', changed: '', verified: '', unfinished: '', risks: '', files: '', nextTask: '' };

/** Session handoffs (spec §8): the seven fields, drafted from Git and the latest audit, edited by the person, saved per project. */
export function HandoffsTab({ project, onUseAsDocument }: { project: Project; onUseAsDocument: (type: DocType, content: string) => void }) {
  const [fields, setFields] = useState<HandoffFields>(EMPTY);
  const [history, setHistory] = useState<Handoff[]>([]);
  const [error, setError] = useState<SerializedError | undefined>();
  const [message, setMessage] = useState('');

  const [version, setVersion] = useState(0);
  const load = (): void => setVersion((n) => n + 1);

  useEffect(() => {
    let cancelled = false;
    void window.api.invoke('handoffs:list', { projectId: project.id }).then((result) => {
      if (cancelled) return;
      if (result.ok) setHistory(result.value);
      else setError(result.error);
    });
    return () => {
      cancelled = true;
    };
  }, [project.id, version]);

  const markdown = (h: HandoffFields, at: string): string => handoffMarkdown(h, project.name, at);

  return (
    <div className="stack">
      <section className="card" aria-label="New session handoff">
        <div className="card__head">
          <h2>Write a handoff</h2>
        </div>
        <p className="muted">
          A short note for whoever resumes the work next, human or AI. &quot;Draft from the project&quot; fills in only what the app can know (Git state and the latest audit); the rest is
          yours.
        </p>
        {error !== undefined && (
          <p role="alert">
            {error.message} {error.hint}
          </p>
        )}
        <div className="actions">
          <button
            type="button"
            className="btn"
            onClick={() =>
              void window.api.invoke('handoffs:draft', { projectId: project.id }).then((result) => {
                if (result.ok) {
                  setFields(result.value);
                  setError(undefined);
                  setMessage('Drafted from Git and the latest audit. Review it and fill in the rest.');
                } else setError(result.error);
              })
            }
          >
            Draft from the project
          </button>
        </div>
        <div className="form">
          {HANDOFF_FIELDS.map((key) => (
            <label key={key}>
              {HANDOFF_LABELS[key]}
              <textarea value={fields[key]} rows={key === 'requested' || key === 'nextTask' ? 2 : 3} maxLength={8000} onChange={(event) => setFields({ ...fields, [key]: event.target.value })} />
            </label>
          ))}
        </div>
        <div className="actions">
          <button
            type="button"
            className="btn btn--primary"
            onClick={() =>
              void window.api.invoke('handoffs:save', { projectId: project.id, fields }).then((result) => {
                if (result.ok) {
                  setError(undefined);
                  setFields(EMPTY);
                  setMessage('Handoff saved.');
                  load();
                } else setError(result.error);
              })
            }
          >
            Save the handoff
          </button>
          <span role="status" className="muted">
            {message}
          </span>
        </div>
      </section>

      <section className="card" aria-label="Saved handoffs">
        <div className="card__head">
          <h2>Earlier handoffs</h2>
        </div>
        {history.length === 0 && <p className="empty">No handoffs saved for this project yet.</p>}
        {history.map((handoff, index) => (
          <details key={handoff.id} open={index === 0}>
            <summary>
              <strong>{formatTime(handoff.createdAt)}</strong>
              {handoff.nextTask.trim() !== '' && <span className="muted"> · next: {handoff.nextTask.split('\n')[0]}</span>}
              {index === 0 && <span className="badge"> latest</span>}
            </summary>
            <dl className="facts">
              {HANDOFF_FIELDS.map((key) => (
                <div key={key} className="fact">
                  <dt>{HANDOFF_LABELS[key]}</dt>
                  <dd className="pre">{handoff[key].trim() === '' ? 'Nothing recorded.' : handoff[key]}</dd>
                </div>
              ))}
            </dl>
            <div className="actions">
              <button type="button" className="btn" onClick={() => onUseAsDocument('SESSION_HANDOFF', markdown(handoff, formatTime(handoff.createdAt)))}>
                Use as the Session handoff document…
              </button>
              <button type="button" className="btn" onClick={() => void navigator.clipboard.writeText(markdown(handoff, formatTime(handoff.createdAt)))}>
                Copy as Markdown
              </button>
            </div>
          </details>
        ))}
      </section>
    </div>
  );
}
