import { useEffect, useState } from 'react';
import { FEATURES, stateLabel } from '@shared/feature-status';
import type { AppInfo } from '@shared/ipc/contract';
import { COMPLETED_THROUGH_STEP, ROADMAP_STEPS } from '@shared/roadmap-steps';

/** Version, database schema and where the data and log live, from the main process. */
function ThisInstallation() {
  const [info, setInfo] = useState<AppInfo | undefined>();
  useEffect(() => {
    let cancelled = false;
    void window.api.invoke('app:getInfo', {}).then((result) => {
      if (!cancelled && result.ok) setInfo(result.value);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  if (info === undefined) return null;
  return (
    <section aria-label="This installation">
      <h2>This installation</h2>
      <dl className="facts">
        <dt>Version</dt>
        <dd>{info.version}</dd>
        <dt>Database</dt>
        <dd>schema v{info.schemaVersion}</dd>
        <dt>Data folder</dt>
        <dd>{info.dataDir}</dd>
        <dt>Log file</dt>
        <dd>{info.logFile}</dd>
      </dl>
    </section>
  );
}

type StepState = 'done' | 'next' | 'upcoming';
const stepState = (n: number): StepState =>
  n <= COMPLETED_THROUGH_STEP ? 'done' : n === COMPLETED_THROUGH_STEP + 1 ? 'next' : 'upcoming';
const STEP_TEXT: Record<StepState, string> = { done: 'Done', next: 'Next', upcoming: 'Upcoming' };

/** Spec §27.11: what exists, what does not, and what is only planned. */
export function StatusPage() {
  const features = FEATURES.filter((feature) => feature.kind !== 'card');
  return (
    <div className="page">
      <header className="page__head">
        <h1>Implementation Status</h1>
        <p className="muted">
          The app is built in 29 steps. {COMPLETED_THROUGH_STEP} are done; nothing marked Upcoming works yet.
        </p>
      </header>

      <ThisInstallation />

      <h2 className="section-gap">Build steps</h2>
      <ol className="steps" aria-label="Build steps">
        {ROADMAP_STEPS.map((step) => {
          const state = stepState(step.n);
          return (
            <li key={step.n} className="step" data-state={state}>
              <span className="muted">{step.n}</span>
              <span>{step.title}</span>
              <span className="step__state">{STEP_TEXT[state]}</span>
            </li>
          );
        })}
      </ol>

      <h2 className="section-gap">Features</h2>
      <ul className="steps" aria-label="Features">
        {features.map((feature) => (
          <li
            key={feature.id}
            className="step"
            data-state={feature.state === 'available' ? 'done' : 'upcoming'}
          >
            <span className="muted">{feature.step}</span>
            <span>{feature.label}</span>
            <span className="step__state">{stateLabel(feature) ?? 'Available'}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
