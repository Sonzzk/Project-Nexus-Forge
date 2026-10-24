import { useEffect, useState } from 'react';
import type { SerializedError } from '@shared/errors';
import { STATUS_TEXT, type OllamaModel, type ProviderStatus, type PullProgress } from '@shared/providers';
import { formatTime } from '../../lib/activity';
import { useSettings } from '../../lib/settings';

const CAPABILITY_LABELS: Record<keyof ProviderStatus['capabilities'], string> = {
  models: 'Lists models',
  streaming: 'Streams output',
  cancellation: 'Can be stopped',
  contextLength: 'Context length per request',
  structuredOutput: 'Structured (JSON) output',
  usageReporting: 'Reports usage',
  readOnlyMode: 'Read-only mode',
};

const sizeText = (bytes: number | null): string => (bytes === null ? 'unknown' : bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`);

function OllamaPanel({ status, onChanged }: { status: ProviderStatus; onChanged: () => void }) {
  const { settings, set } = useSettings();
  const [models, setModels] = useState<OllamaModel[]>([]);
  const [version, setVersion] = useState(0);
  const [model, setModel] = useState('');
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState<SerializedError | undefined>();
  const [progress, setProgress] = useState<PullProgress | undefined>();
  const [busy, setBusy] = useState(false);
  const reachable = status.status === 'working' || status.status === 'needs-setup';

  useEffect(() => {
    if (!reachable) return;
    let cancelled = false;
    void window.api.invoke('providers:models', { provider: 'ollama' }).then((result) => {
      if (!cancelled && result.ok) setModels(result.value);
    });
    return () => {
      cancelled = true;
    };
  }, [reachable, status.checkedAt, version]);

  useEffect(() => window.api.on('providers:progress', setProgress), []);

  const run = async <T,>(work: () => Promise<{ ok: true; value: T } | { ok: false; error: SerializedError }>): Promise<T | undefined> => {
    setBusy(true);
    setError(undefined);
    setMessage('');
    const result = await work();
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return undefined;
    }
    return result.value;
  };

  return (
    <div className="stack">
      <div className="field">
        <label htmlFor="ollama-endpoint">Address</label>
        <input id="ollama-endpoint" defaultValue={settings['providers.ollamaEndpoint']} onBlur={(event) => event.target.value !== settings['providers.ollamaEndpoint'] && set('providers.ollamaEndpoint', event.target.value.trim())} />
        <label>
          <input type="checkbox" checked={settings['providers.ollamaAllowRemote']} onChange={(event) => set('providers.ollamaAllowRemote', event.target.checked)} /> Allow an address that is not this PC
        </label>
        <label htmlFor="ollama-timeout">Time limit (seconds)</label>
        <input id="ollama-timeout" type="number" min={10} max={3600} value={settings['providers.timeoutSeconds']} onChange={(event) => Number.isInteger(Number(event.target.value)) && set('providers.timeoutSeconds', Number(event.target.value))} />
        <label htmlFor="ollama-context">Context length (0 = the model&apos;s own)</label>
        <input id="ollama-context" type="number" min={0} value={settings['providers.ollamaContextLength']} onChange={(event) => Number.isInteger(Number(event.target.value)) && set('providers.ollamaContextLength', Number(event.target.value))} />
      </div>
      {error !== undefined && (
        <p role="alert">
          {error.message} {error.hint}
        </p>
      )}
      {message !== '' && <p role="status">{message}</p>}

      {reachable && models.length === 0 && <p className="empty">No models are installed.</p>}
      {models.length > 0 && (
        <table className="table" aria-label="Ollama models">
          <thead>
            <tr>
              <th>Model</th>
              <th>Size</th>
              <th>Parameters</th>
              <th>Context</th>
              <th>Loaded</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {models.map((m) => (
              <tr key={m.name}>
                <td>{m.name}</td>
                <td>{sizeText(m.sizeBytes)}</td>
                <td>{[m.family, m.parameterSize, m.quantization].filter(Boolean).join(' · ') || 'unknown'}</td>
                <td>{m.contextLength === null ? 'not stated' : `up to ${m.contextLength.toLocaleString('en-US')}`}</td>
                <td>{m.loaded ? 'Yes' : 'No'}</td>
                <td>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    aria-label={`Load ${m.name} into memory`}
                    onClick={() =>
                      void run(() => window.api.invoke('providers:warmUp', { model: m.name })).then((value) => {
                        if (value !== undefined) {
                          setMessage(`${m.name} is loaded.`);
                          setVersion((n) => n + 1);
                        }
                      })
                    }
                  >
                    Load
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {reachable && (
        <>
          <div className="field">
            <label htmlFor="ollama-test-model">Test a model</label>
            <select id="ollama-test-model" value={model} onChange={(event) => setModel(event.target.value)}>
              <option value="">Choose a model…</option>
              {models.map((m) => (
                <option key={m.name} value={m.name}>
                  {m.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn"
              disabled={busy || model === ''}
              onClick={() =>
                void run(() => window.api.invoke('providers:generate', { choice: { provider: 'ollama', model }, prompt: 'Reply with the single word OK.', purpose: 'connection-test' })).then((value) => {
                  if (value?.sent === true) setMessage(`${model} answered in ${(value.elapsedMs / 1000).toFixed(1)} s: ${value.text.trim().slice(0, 120)}`);
                })
              }
            >
              Send a test prompt
            </button>
            {busy && (
              <button type="button" className="btn" onClick={() => void window.api.invoke('providers:cancel', {})}>
                Stop
              </button>
            )}
          </div>
          <div className="field">
            <label htmlFor="ollama-pull">Download a model</label>
            <input id="ollama-pull" value={name} placeholder="for example llama3.2:1b" onChange={(event) => setName(event.target.value)} />
            <button
              type="button"
              className="btn"
              disabled={busy || name.trim() === ''}
              onClick={() => {
                setProgress(undefined);
                void run(() => window.api.invoke('providers:pull', { model: name.trim() })).then((value) => {
                  if (value?.pulled === true) {
                    setMessage(`${name.trim()} was downloaded.`);
                    setName('');
                    setVersion((n) => n + 1);
                    onChanged();
                  }
                });
              }}
            >
              Download…
            </button>
          </div>
          <p className="muted">Ollama does not say how big a model is before it starts, and models can be several gigabytes. You are asked before anything is downloaded.</p>
          {progress !== undefined && busy && (
            <p role="status">
              {progress.status}
              {progress.total !== null && progress.completed !== null && ` · ${sizeText(progress.completed)} of ${sizeText(progress.total)}`}
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** Integrations (spec §9, §24): what each AI tool is, as detected now, with an actionable message and no invented numbers. */
export function IntegrationsPage() {
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [version, setVersion] = useState(0);
  const [checking, setChecking] = useState<string | undefined>();
  const [error, setError] = useState<SerializedError | undefined>();

  useEffect(() => {
    let cancelled = false;
    void window.api.invoke('providers:list', {}).then((result) => {
      if (cancelled) return;
      if (result.ok) setProviders(result.value);
      else setError(result.error);
    });
    return () => {
      cancelled = true;
    };
  }, [version]);

  return (
    <div className="page">
      <header className="page__head">
        <h1>Integrations</h1>
        <p className="muted">
          The AI tools this app can use. Each one is detected as it is now; nothing is assumed. Credentials stay with the tools: this app never reads them. Quotas are shown only if a tool
          reports them.
        </p>
      </header>
      {error !== undefined && (
        <p role="alert">
          {error.message} {error.hint}
        </p>
      )}
      <div className="stack">
        {providers.map((p) => (
          <section key={p.id} className="card" aria-label={p.label} data-provider={p.id}>
            <div className="card__head">
              <h2>{p.label}</h2>
              <span className="badge" data-status={p.status}>
                {STATUS_TEXT[p.status]}
              </span>
            </div>
            <p>{p.message}</p>
            {p.hint !== '' && <p className="muted">{p.hint}</p>}
            <dl className="facts">
              <dt>Where it runs</dt>
              <dd>{p.location === 'local' ? 'On this PC' : 'In the vendor’s cloud (your text is sent there)'}</dd>
              {p.details.map((d) => (
                <div key={d.label} className="fact">
                  <dt>{d.label}</dt>
                  <dd className="pre">{d.value}</dd>
                </div>
              ))}
              <dt>Usage and quota</dt>
              <dd>{p.quota}</dd>
              <dt>Last checked</dt>
              <dd>
                {formatTime(p.checkedAt)}
                {p.lastSuccessAt !== null && ` · last answered a request ${formatTime(p.lastSuccessAt)}`}
              </dd>
            </dl>
            <p className="muted">
              Capabilities: {(Object.keys(CAPABILITY_LABELS) as (keyof typeof CAPABILITY_LABELS)[]).filter((key) => p.capabilities[key]).map((key) => CAPABILITY_LABELS[key]).join(', ') || 'none'}.
            </p>
            <div className="actions">
              <button
                type="button"
                className="btn"
                disabled={checking === p.id}
                aria-label={`Check ${p.label} again`}
                onClick={() => {
                  setChecking(p.id);
                  void window.api.invoke('providers:check', { provider: p.id }).then((result) => {
                    setChecking(undefined);
                    if (result.ok) setProviders((current) => current.map((c) => (c.id === p.id ? result.value : c)));
                    else setError(result.error);
                  });
                }}
              >
                {checking === p.id ? 'Checking…' : 'Check again'}
              </button>
            </div>
            {p.id === 'ollama' && <OllamaPanel status={p} onChanged={() => setVersion((n) => n + 1)} />}
          </section>
        ))}
      </div>
    </div>
  );
}
