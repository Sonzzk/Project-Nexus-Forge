import { useEffect, useState } from 'react';
import { AGENT_ROLE_IDS, FINAL_RUN_STATES, RUN_STATE_LABELS, type QueueEntry } from '@shared/agents';
import type { SerializedError } from '@shared/errors';
import { PROVIDER_IDS, PROVIDER_LABELS, type OllamaModel } from '@shared/providers';
import { INFERENCE_MODES, INFERENCE_MODE_LABELS, type ResourceReport } from '@shared/resources';
import { PROFILE_DESCRIPTIONS, PROFILE_LABELS, ROUTING_PROFILES } from '@shared/routing';
import { PRIORITIES, PRIORITY_LABELS, ROLE_LABELS } from '@shared/tasks';
import { formatTime } from '../../lib/activity';
import { useProjects } from '../../lib/projects';
import { useQueue } from '../../lib/queue';
import { useSettings } from '../../lib/settings';
import { RunControls } from './RunControls';

const gb = (mib: number | null): string => (mib === null ? 'unknown' : `${(mib / 1024).toFixed(1)} GB`);

function QueueRow({ run, writesEnabled, maxAttempts, onChanged, onError }: { run: QueueEntry; writesEnabled: boolean; maxAttempts: number; onChanged: () => void; onError: (e: SerializedError) => void }) {
  const finished = FINAL_RUN_STATES.includes(run.state);
  return (
    <li className="queue-row" data-state={run.state}>
      <div>
        <strong>{ROLE_LABELS[run.role]}</strong> <span className="muted">· {run.taskTitle}</span>{' '}
        <span className="badge" data-state={run.state}>
          {RUN_STATE_LABELS[run.state]}
        </span>{' '}
        <span className="badge">{run.writeCapable ? 'Writes files' : 'Read-only'}</span>
        {run.attempt > 1 && <span className="badge">Attempt {run.attempt}</span>}
        {run.route?.provider != null && (
          <div className="muted">
            {PROVIDER_LABELS[run.route.provider]}
            {run.model === '' ? '' : ` · ${run.model}`} · {run.route.location === 'local' ? 'on this PC' : 'cloud'} · {run.route.billingNote}
          </div>
        )}
        {run.hold !== '' && <div role="note">{run.hold}</div>}
        {run.note !== '' && <div className="muted">{run.note}</div>}
        {run.result !== '' && (
          <details>
            <summary>Answer ({run.result.length.toLocaleString('en-US')} characters)</summary>
            <pre className="diff">{run.result}</pre>
          </details>
        )}
        <div className="muted">Updated {formatTime(run.updatedAt)}</div>
      </div>
      <div className="actions">
        {!finished && (
          <select
            aria-label={`Priority of the ${ROLE_LABELS[run.role]} run for ${run.taskTitle}`}
            value={run.priority}
            onChange={(event) => {
              const priority = PRIORITIES.find((p) => p === event.target.value);
              if (priority !== undefined) void window.api.invoke('queue:setPriority', { runId: run.id, priority }).then((r) => (r.ok ? onChanged() : onError(r.error)));
            }}
          >
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABELS[p]}
              </option>
            ))}
          </select>
        )}
        <RunControls run={run} writesEnabled={writesEnabled} maxAttempts={maxAttempts} onChanged={onChanged} onError={onError} />
      </div>
    </li>
  );
}

function RoutingSection() {
  const { settings, set } = useSettings();
  const [models, setModels] = useState<OllamaModel[]>([]);
  useEffect(() => {
    let cancelled = false;
    void window.api.invoke('providers:models', { provider: 'ollama' }).then((r) => !cancelled && r.ok && setModels(r.value));
    return () => {
      cancelled = true;
    };
  }, []);
  const profile = settings['routing.profile'];
  const overrides = settings['routing.roleOverrides'];
  const localModel = settings['routing.localModel'];
  const modelNames = [...new Set([...models.map((m) => m.name), ...(localModel === '' ? [] : [localModel])])];

  return (
    <section aria-label="Routing" className="stack">
      <h2>Routing</h2>
      <div className="field">
        <label htmlFor="routing-profile">Profile</label>
        <select id="routing-profile" value={profile} onChange={(event) => set('routing.profile', ROUTING_PROFILES.find((p) => p === event.target.value) ?? 'balanced')}>
          {ROUTING_PROFILES.map((p) => (
            <option key={p} value={p}>
              {PROFILE_LABELS[p]}
            </option>
          ))}
        </select>
      </div>
      <p className="muted">{PROFILE_DESCRIPTIONS[profile]} No run ever makes a second call by itself.</p>
      <div className="field">
        <label htmlFor="routing-local-model">Local model (Ollama)</label>
        <select id="routing-local-model" value={localModel} onChange={(event) => set('routing.localModel', event.target.value)}>
          <option value="">None: routing never picks Ollama</option>
          {modelNames.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="routing-attempts">Attempts per run</label>
        <input id="routing-attempts" type="number" min={1} max={5} value={settings['routing.maxAttempts']} onChange={(event) => Number.isInteger(Number(event.target.value)) && set('routing.maxAttempts', Number(event.target.value))} />
      </div>
      <table className="table" aria-label="Provider for each role">
        <thead>
          <tr>
            <th>Role</th>
            <th>Provider</th>
            <th>Model (empty: the provider&apos;s default)</th>
          </tr>
        </thead>
        <tbody>
          {AGENT_ROLE_IDS.map((role) => {
            const current = overrides[role] ?? { provider: '' as const, model: '' };
            return (
              <tr key={role}>
                <td>{ROLE_LABELS[role]}</td>
                <td>
                  <select
                    aria-label={`Provider for the ${ROLE_LABELS[role]} role`}
                    value={current.provider}
                    onChange={(event) => set('routing.roleOverrides', { ...overrides, [role]: { provider: PROVIDER_IDS.find((id) => id === event.target.value) ?? '', model: '' } })}
                  >
                    <option value="">Use the profile</option>
                    {PROVIDER_IDS.map((id) => (
                      <option key={id} value={id}>
                        {PROVIDER_LABELS[id]}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    key={`${role}-${current.provider}-${current.model}`}
                    aria-label={`Model for the ${ROLE_LABELS[role]} role`}
                    defaultValue={current.model}
                    disabled={current.provider === ''}
                    onBlur={(event) => event.target.value.trim() !== current.model && set('routing.roleOverrides', { ...overrides, [role]: { ...current, model: event.target.value.trim() } })}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

function InferenceSection() {
  const { settings, set } = useSettings();
  const [report, setReport] = useState<ResourceReport | undefined>();
  const [loaded, setLoaded] = useState<OllamaModel[]>([]);
  const [error, setError] = useState<SerializedError | undefined>();
  const [busy, setBusy] = useState(false);
  const number = (key: 'inference.minFreeVramMiB' | 'inference.minFreeRamMiB' | 'inference.keepAliveMinutes' | 'inference.monitorIntervalSeconds', id: string, label: string, max: number) => (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type="number" min={0} max={max} value={settings[key]} onChange={(event) => Number.isInteger(Number(event.target.value)) && set(key, Number(event.target.value))} />
    </div>
  );
  const check = async (): Promise<void> => {
    setBusy(true);
    const [r, m] = await Promise.all([window.api.invoke('resources:check', {}), window.api.invoke('providers:models', { provider: 'ollama' })]);
    setBusy(false);
    if (r.ok) setReport(r.value);
    else setError(r.error);
    setLoaded(m.ok ? m.value.filter((model) => model.loaded) : []);
  };

  return (
    <section aria-label="Local inference" className="stack">
      <h2>Local inference</h2>
      <p className="muted">
        A local model starts only when this allows it. Otherwise the run waits and says why; nothing is ever stopped or closed for it. Ollama cannot pause a
        generation, so a running local run can only be cancelled.
      </p>
      <div className="field">
        <label htmlFor="inference-mode">Mode</label>
        <select id="inference-mode" value={settings['inference.mode']} onChange={(event) => set('inference.mode', INFERENCE_MODES.find((m) => m === event.target.value) ?? 'allow-local')}>
          {INFERENCE_MODES.map((m) => (
            <option key={m} value={m}>
              {INFERENCE_MODE_LABELS[m]}
            </option>
          ))}
        </select>
      </div>
      {number('inference.minFreeVramMiB', 'inference-vram', 'Minimum free VRAM (MiB)', 98_304)}
      {number('inference.minFreeRamMiB', 'inference-ram', 'Minimum free RAM (MiB)', 1_048_576)}
      <div className="field">
        <label>
          <input type="checkbox" checked={settings['inference.holdForHeavyApps']} onChange={(event) => set('inference.holdForHeavyApps', event.target.checked)} /> Wait while Unreal
          Editor or Blender is running
        </label>
      </div>
      {number('inference.keepAliveMinutes', 'inference-keep', 'Keep a model loaded after a request (minutes, 0 = unload at once)', 120)}
      {number('inference.monitorIntervalSeconds', 'inference-interval', 'Look again at waiting runs every (seconds)', 600)}
      <div className="actions">
        <button type="button" className="btn" disabled={busy} onClick={() => void check()}>
          {busy ? 'Checking…' : 'Check resources now'}
        </button>
      </div>
      {error !== undefined && (
        <p role="alert">
          {error.message} {error.hint}
        </p>
      )}
      {report !== undefined && (
        <div aria-label="Resources now" className="stack">
          <p>
            <span className={report.verdict.allowed ? 'badge' : 'badge badge--warn'}>
              {report.verdict.allowed ? 'A local model may start' : 'Local models wait'}
            </span>{' '}
            <span className="muted">Checked {formatTime(report.snapshot.at)}</span>
          </p>
          {[...report.verdict.blocks, ...report.verdict.warnings].map((text) => (
            <p key={text} role="note">
              {text}
            </p>
          ))}
          <ul className="muted">
            <li>CPU: {report.snapshot.cpuPercent === null ? 'unknown' : `${report.snapshot.cpuPercent}% busy`}</li>
            <li>
              RAM: {gb(report.snapshot.ramFreeMiB)} free of {gb(report.snapshot.ramTotalMiB)}
            </li>
            {report.snapshot.gpus.map((gpu) => (
              <li key={gpu.name}>
                {gpu.name}: {gb(gpu.vramFreeMiB)} VRAM free of {gb(gpu.vramTotalMiB)}
                {gpu.utilPercent === null ? '' : `, ${gpu.utilPercent}% busy`}
              </li>
            ))}
            {report.snapshot.gpuNote !== '' && <li>GPU: {report.snapshot.gpuNote}</li>}
            <li>Heavy programs: {report.snapshot.heavyApps.length === 0 ? (report.snapshot.appsNote === '' ? 'none running' : report.snapshot.appsNote) : report.snapshot.heavyApps.join(', ')}</li>
          </ul>
          {loaded.length > 0 && (
            <ul className="rows" aria-label="Loaded Ollama models">
              {loaded.map((model) => (
                <li key={model.name} className="backup-row">
                  <span>{model.name} is loaded in memory</span>
                  <button
                    type="button"
                    className="btn"
                    aria-label={`Unload ${model.name}`}
                    onClick={() => void window.api.invoke('providers:unload', { model: model.name }).then((r) => (r.ok ? void check() : setError(r.error)))}
                  >
                    Unload
                  </button>
                  <span />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * The AI Workbench (spec §11–§13, §15): the run queue of the selected project with its holds, priorities and the writer lock,
 * the routing settings, and the local-inference policy. Agent runs are read-only until Step 15.
 */
export function WorkbenchPage() {
  const { selected } = useProjects();
  const { view, error, call, reload } = useQueue(selected?.id);
  const [problem, setProblem] = useState<SerializedError | undefined>();
  const shown = problem ?? error;
  const open = view?.runs.filter((r) => !FINAL_RUN_STATES.includes(r.state)) ?? [];
  const done = view?.runs.filter((r) => FINAL_RUN_STATES.includes(r.state)) ?? [];
  const changed = (): void => {
    setProblem(undefined);
    reload();
  };

  return (
    <div className="page">
      <header className="page__head">
        <h1>AI Workbench</h1>
        <p className="muted">
          Start agent runs, see what waits and why, and choose how runs are routed. Every run is read-only until Step 15, and anything sent to a cloud service is
          confirmed first in a window that names the provider and what it costs. The live session view arrives in Step 17.
        </p>
      </header>
      {shown !== undefined && (
        <p role="alert">
          {shown.message} {shown.hint}
        </p>
      )}
      {selected === undefined ? (
        <p className="empty">Choose a project in the top bar to see its run queue. Runs are created from a task&apos;s Agent work section.</p>
      ) : (
        <section aria-label="Run queue" className="stack">
          <h2>Run queue · {selected.name}</h2>
          {view?.lock != null && (
            <div role="note" className="lock">
              Writer lock: held by {view.lock.role} since {formatTime(view.lock.acquiredAt)}.{' '}
              {view.lock.active ? (
                'It is running now; it gives the lock back when it ends.'
              ) : (
                <>
                  That run was interrupted, so the app could not see it finish.{' '}
                  <button type="button" className="btn" onClick={() => void call(() => window.api.invoke('queue:releaseLock', { projectId: selected.id }))}>
                    Release the lock…
                  </button>
                </>
              )}
            </div>
          )}
          {view !== undefined && open.length === 0 && <p className="empty">Nothing is queued. Queue runs from a task&apos;s Agent work section on the Tasks page.</p>}
          <ul className="rows" aria-label="Queued and running">
            {open.map((run) => (
              <QueueRow key={run.id} run={run} writesEnabled={view?.writesEnabled ?? false} maxAttempts={view?.maxAttempts ?? 1} onChanged={changed} onError={setProblem} />
            ))}
          </ul>
          {done.length > 0 && (
            <>
              <h3>Recently finished</h3>
              <ul className="rows" aria-label="Recently finished">
                {done.map((run) => (
                  <QueueRow key={run.id} run={run} writesEnabled={view?.writesEnabled ?? false} maxAttempts={view?.maxAttempts ?? 1} onChanged={changed} onError={setProblem} />
                ))}
              </ul>
            </>
          )}
        </section>
      )}
      <RoutingSection />
      <InferenceSection />
    </div>
  );
}
