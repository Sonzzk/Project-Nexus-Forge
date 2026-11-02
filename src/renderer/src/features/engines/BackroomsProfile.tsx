import { useCallback, useEffect, useState } from 'react';
import type { ProfileView } from '@shared/backrooms';
import type { SerializedError } from '@shared/errors';
import { SCOPE_LABELS } from '@shared/tasks';

/**
 * The optional Backrooms game profile (spec §19). It assumes nothing: it is off until you turn it on, and a system counts only after you
 * confirm it against the real design. What the project files suggest is shown as a hint to check.
 */
export function BackroomsProfile({ projectId, projectName }: { projectId: string; projectName: string }) {
  const [view, setView] = useState<ProfileView | undefined>();
  const [problem, setProblem] = useState<SerializedError | undefined>();
  const [message, setMessage] = useState('');
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    void window.api.invoke('profiles:get', { projectId }).then((result) => {
      if (cancelled) return;
      if (result.ok) setView(result.value);
      else setProblem(result.error);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, version]);

  const save = (patch: { enabled?: boolean; confirmedDomains?: ProfileView['domains'][number]['id'][]; checked?: ProfileView['checklist'][number]['id'][] }): void => {
    void window.api.invoke('profiles:set', { projectId, ...patch }).then((result) => {
      if (result.ok) {
        setView(result.value);
        setProblem(undefined);
      } else setProblem(result.error);
    });
  };
  const addRisk = (title: string, detail: string): void => {
    void window.api.invoke('risks:create', { projectId, kind: 'risk', title: `Backrooms: ${title}`.slice(0, 200), description: detail, severity: 'high' }).then((result) => {
      if (result.ok) {
        setMessage(`Added "${title}" to the risks register.`);
        reload();
      } else setProblem(result.error);
    });
  };

  if (view === undefined) return problem === undefined ? null : <p role="alert">{problem.message} {problem.hint}</p>;
  const confirmed = view.domains.filter((d) => d.confirmed).map((d) => d.id);
  const checked = view.checklist.filter((c) => c.checked).map((c) => c.id);

  return (
    <section className="card" aria-label="Backrooms game profile" data-feature="profile">
      <div className="card__head">
        <h3>Backrooms game profile · {projectName}</h3>
        <label>
          <input type="checkbox" checked={view.enabled} onChange={(event) => save({ enabled: event.target.checked })} /> Use this profile
        </label>
      </div>
      <p className="muted">
        For a large, multi-system horror game made by one person. It does not decide what your game contains: confirm each system against your real design, keep the dream, the first prototype, the vertical slice and the release apart, and
        finish a few high-impact features before adding more.
      </p>
      {problem !== undefined && (
        <p role="alert">
          {problem.message} {problem.hint}
        </p>
      )}
      {message !== '' && <p role="status">{message}</p>}
      {view.note !== '' && <p className="muted">{view.note}</p>}
      {view.enabled && (
        <>
          <h4>Systems in this game</h4>
          <ul className="rows" aria-label="Game systems">
            {view.domains.map((d) => (
              <li key={d.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={d.confirmed}
                    onChange={(event) => save({ confirmedDomains: event.target.checked ? [...confirmed, d.id] : confirmed.filter((id) => id !== d.id) })}
                  />{' '}
                  {d.label}
                </label>
                {d.hints.length > 0 && <div className="muted">The project files suggest it (check): {d.hints.join('; ')}</div>}
              </li>
            ))}
          </ul>

          <h4>Scope: dream, prototype, slice, release</h4>
          <ul className="rows" aria-label="Scope tiers">
            {view.tiers.map((t) => (
              <li key={t.tier}>
                {SCOPE_LABELS[t.tier]}: {t.milestones} milestone{t.milestones === 1 ? '' : 's'}
              </li>
            ))}
          </ul>
          <p className="muted">Milestones get their tier on the Tasks and Roadmap page.</p>

          <h4>Is the environment actually scary?</h4>
          <p className="muted">Think about these together; a higher polygon count or an expensive effect is not an improvement by itself.</p>
          <ul className="rows" aria-label="Horror quality checklist">
            {view.checklist.map((c) => (
              <li key={c.id}>
                <label>
                  <input type="checkbox" checked={c.checked} onChange={(event) => save({ checked: event.target.checked ? [...checked, c.id] : checked.filter((id) => id !== c.id) })} /> <strong>{c.label}</strong>
                </label>
                <div className="muted">{c.question}</div>
              </li>
            ))}
          </ul>

          <h4>Risks to the schedule</h4>
          {view.flags.length === 0 ? (
            <p className="muted">Nothing flagged from what you confirmed.</p>
          ) : (
            <ul className="rows" aria-label="Risk flags">
              {view.flags.map((f) => (
                <li key={f.id}>
                  <strong>{f.title}</strong>
                  <div>{f.detail}</div>
                  <button type="button" className="btn" aria-label={`Add "${f.title}" to the risks register`} onClick={() => addRisk(f.title, f.detail)}>
                    Add to the risks register
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
