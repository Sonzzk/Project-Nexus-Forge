import { useState } from 'react';
import { RISK_KINDS, RISK_STATUSES, SEVERITIES } from '@shared/tasks';
import type { PlanningApi } from '../../lib/planning';

const cap = (word: string): string => `${word[0]?.toUpperCase() ?? ''}${word.slice(1)}`;

/** The per-project register of bugs and technical risks (spec §19, §20). */
export function RisksView({ projectId, planning }: { projectId: string; planning: PlanningApi }) {
  const [kind, setKind] = useState<(typeof RISK_KINDS)[number]>('bug');
  const [title, setTitle] = useState('');
  const [severity, setSeverity] = useState<(typeof SEVERITIES)[number]>('medium');
  const [description, setDescription] = useState('');
  const [taskId, setTaskId] = useState('');
  return (
    <div className="stack">
      <section className="card" aria-label="New bug or risk">
        <div className="card__head">
          <h2>Record a bug or risk</h2>
        </div>
        <div className="form">
          <div className="field">
            <label htmlFor="risk-kind">Kind</label>
            <select id="risk-kind" value={kind} onChange={(event) => setKind(RISK_KINDS.find((k) => k === event.target.value) ?? 'bug')}>
              {RISK_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k === 'bug' ? 'Bug' : 'Technical risk'}
                </option>
              ))}
            </select>
            <label htmlFor="risk-severity">Severity</label>
            <select id="risk-severity" value={severity} onChange={(event) => setSeverity(SEVERITIES.find((s) => s === event.target.value) ?? 'medium')}>
              {SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {cap(s)}
                </option>
              ))}
            </select>
            <label htmlFor="risk-task">Related task</label>
            <select id="risk-task" value={taskId} onChange={(event) => setTaskId(event.target.value)}>
              <option value="">None</option>
              {planning.tasks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </select>
          </div>
          <label>
            Title
            <input value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label>
            Details <span className="muted">(for a bug: how to reproduce it; for a risk: what threatens the budget or timeline)</span>
            <textarea value={description} rows={3} onChange={(event) => setDescription(event.target.value)} />
          </label>
        </div>
        <div className="actions">
          <button
            type="button"
            className="btn btn--primary"
            disabled={title.trim() === ''}
            onClick={() =>
              void planning.call(() => window.api.invoke('risks:create', { projectId, kind, title, severity, description, taskId: taskId === '' ? null : taskId })).then((created) => {
                if (created !== undefined) {
                  setTitle('');
                  setDescription('');
                }
              })
            }
          >
            Record it
          </button>
        </div>
      </section>

      {planning.risks.length === 0 && <p className="empty">Nothing recorded. Bugs and technical risks you want to keep an eye on go here.</p>}
      <ul className="rows" aria-label="Bugs and risks">
        {planning.risks.map((risk) => (
          <li key={risk.id} className="backup-row">
            <span>
              <span className="badge">{risk.kind === 'bug' ? 'Bug' : 'Risk'}</span> <strong>{risk.title}</strong>{' '}
              <span className="muted">
                · {cap(risk.severity)} severity{risk.description === '' ? '' : ` · ${risk.description.split('\n')[0]}`}
              </span>
            </span>
            <select
              aria-label={`Status of ${risk.title}`}
              value={risk.status}
              onChange={(event) => void planning.call(() => window.api.invoke('risks:update', { id: risk.id, status: RISK_STATUSES.find((s) => s === event.target.value) ?? 'open' }))}
            >
              {RISK_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {cap(s)}
                </option>
              ))}
            </select>
            <span />
            <button type="button" className="btn btn--danger" aria-label={`Delete ${risk.title}`} onClick={() => void planning.call(() => window.api.invoke('risks:remove', { id: risk.id }))}>
              Delete
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
