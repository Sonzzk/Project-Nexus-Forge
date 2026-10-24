import { useState } from 'react';
import { FINAL_RUN_STATES, type AgentRun } from '@shared/agents';
import type { IpcResult, SerializedError } from '@shared/errors';
import { featureById, stateLabel } from '@shared/feature-status';
import { PROVIDER_IDS, PROVIDER_LABELS, type ProviderId } from '@shared/providers';
import { PROFILE_LABELS, type Route } from '@shared/routing';
import { ROLE_LABELS } from '@shared/tasks';

/** Where a run would go and what it costs, as main decided it. Shown before anything is started. */
export function RouteSummary({ route }: { route: Route }) {
  return (
    <div className="route" aria-label="Routing decision">
      <strong>{route.provider === null ? 'No provider can take this run' : `${PROVIDER_LABELS[route.provider]}${route.model === '' ? '' : ` · ${route.model}`}`}</strong>{' '}
      <span className="badge">{PROFILE_LABELS[route.profile]}</span> {route.location !== null && <span className="badge">{route.location === 'local' ? 'On this PC' : 'Cloud'}</span>}
      {route.fallback && <div role="note">This costs more than the routing profile wanted; you are asked before anything is sent.</div>}
      <ul className="muted">
        {route.reasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
      {route.billingNote !== '' && <div className="muted">Cost: {route.billingNote}</div>}
    </div>
  );
}

const isActive = (run: AgentRun): boolean => run.requestedAt !== null || run.hold !== '' || (run.state !== 'queued' && !FINAL_RUN_STATES.includes(run.state));

/**
 * Start, cancel or try again one run. Starting shows the routing decision first and lets the person pick another provider
 * for this run only; main asks again in a native window before anything goes to a cloud service.
 */
export function RunControls({ run, writesEnabled, maxAttempts, onChanged, onError }: { run: AgentRun; writesEnabled: boolean; maxAttempts: number; onChanged: () => void; onError: (error: SerializedError) => void }) {
  const [mode, setMode] = useState<'start' | 'retry' | undefined>();
  const [route, setRoute] = useState<Route | undefined>();
  const [choice, setChoice] = useState<ProviderId | ''>('');
  const label = ROLE_LABELS[run.role];
  const writes = featureById('action.write-run');

  const handle = async <T,>(result: Promise<IpcResult<T>>): Promise<T | undefined> => {
    const done = await result;
    if (!done.ok) {
      onError(done.error);
      return undefined;
    }
    return done.value;
  };
  const preview = async (provider: ProviderId | ''): Promise<void> => {
    setChoice(provider);
    const next = await handle(window.api.invoke('queue:route', { runId: run.id, ...(provider === '' ? {} : { choice: { provider, model: '' } }) }));
    setRoute(next);
  };
  const close = (): void => {
    setMode(undefined);
    setRoute(undefined);
    setChoice('');
  };
  const go = async (): Promise<void> => {
    const input = { runId: run.id, ...(choice === '' ? {} : { choice: { provider: choice, model: '' } }) };
    const done = await handle(mode === 'retry' ? window.api.invoke('queue:retry', input) : window.api.invoke('queue:start', input));
    close();
    if (done !== undefined) onChanged();
  };

  if (mode !== undefined)
    return (
      <div className="run-start" aria-label={`Start the ${label} run`}>
        {route === undefined ? <p className="muted">Working out the route…</p> : <RouteSummary route={route} />}
        <div className="field">
          <label htmlFor={`run-provider-${run.id}`}>Provider for this run</label>
          <select id={`run-provider-${run.id}`} value={choice} onChange={(event) => void preview(PROVIDER_IDS.find((id) => id === event.target.value) ?? '')}>
            <option value="">As routed</option>
            {PROVIDER_IDS.map((id) => (
              <option key={id} value={id}>
                {PROVIDER_LABELS[id]}
              </option>
            ))}
          </select>
        </div>
        <div className="actions">
          <button type="button" className="btn btn--primary" disabled={route?.provider == null} onClick={() => void go()}>
            {mode === 'retry' ? 'Queue the new attempt' : 'Start'}
          </button>
          <button type="button" className="btn" onClick={close}>
            Back
          </button>
        </div>
      </div>
    );

  if (isActive(run))
    return (
      <button type="button" className="btn" aria-label={`Cancel the ${label} run`} onClick={() => void handle(window.api.invoke('queue:cancel', { runId: run.id })).then((done) => done !== undefined && onChanged())}>
        Cancel run
      </button>
    );

  if (run.state === 'queued') {
    if (run.writeCapable && !writesEnabled)
      return (
        <button type="button" className="btn" disabled title="Runs that change project files need the permission gate of Step 15">
          Start · {writes === undefined ? 'Upcoming' : (stateLabel(writes) ?? 'Upcoming')}
        </button>
      );
    return (
      <button
        type="button"
        className="btn"
        aria-label={`Start the ${label} run…`}
        onClick={() => {
          setMode('start');
          void preview('');
        }}
      >
        Start…
      </button>
    );
  }

  if ((run.state === 'failed' || run.state === 'cancelled') && run.attempt < maxAttempts && !(run.writeCapable && !writesEnabled))
    return (
      <button
        type="button"
        className="btn"
        aria-label={`Try the ${label} run again…`}
        onClick={() => {
          setMode('retry');
          void preview('');
        }}
      >
        Try again…
      </button>
    );
  return null;
}
