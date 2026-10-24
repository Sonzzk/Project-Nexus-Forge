import { useEffect, useState } from 'react';
import { PROVIDER_LABELS, PROVIDER_LOCATION, STATUS_TEXT, type OllamaModel, type ProviderChoice, type ProviderId, type ProviderStatus } from '@shared/providers';

/**
 * Chooses a provider (and, for Ollama, a model) by hand. Nothing is preselected: a request goes to a provider only after the
 * person picked it, and a cloud provider says where the text goes. `onChange` gets undefined until the choice is complete.
 */
export function ProviderPicker({ onChange, idPrefix }: { onChange: (choice: ProviderChoice | undefined) => void; idPrefix: string }) {
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [models, setModels] = useState<OllamaModel[]>([]);
  const [provider, setProvider] = useState<ProviderId | ''>('');
  const [model, setModel] = useState('');

  useEffect(() => {
    let cancelled = false;
    void window.api.invoke('providers:list', {}).then((result) => {
      if (!cancelled && result.ok) setProviders(result.value);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (provider !== 'ollama') return;
    let cancelled = false;
    void window.api.invoke('providers:models', { provider: 'ollama' }).then((result) => {
      if (!cancelled && result.ok) setModels(result.value);
    });
    return () => {
      cancelled = true;
    };
  }, [provider]);

  const choose = (nextProvider: ProviderId | '', nextModel: string): void => {
    setProvider(nextProvider);
    setModel(nextModel);
    onChange(nextProvider === '' || (nextProvider === 'ollama' && nextModel === '') ? undefined : { provider: nextProvider, model: nextModel });
  };
  const usable = (p: ProviderStatus): boolean => p.status === 'working' || p.status === 'installed';
  const chosen = providers.find((p) => p.id === provider);

  return (
    <div className="field">
      <label htmlFor={`${idPrefix}-provider`}>Provider</label>
      <select id={`${idPrefix}-provider`} value={provider} onChange={(event) => choose(providers.find((p) => p.id === event.target.value)?.id ?? '', '')}>
        <option value="">Choose a provider…</option>
        {providers.map((p) => (
          <option key={p.id} value={p.id} disabled={!usable(p)}>
            {PROVIDER_LABELS[p.id]}
            {usable(p) ? '' : ` · ${STATUS_TEXT[p.status]}`}
          </option>
        ))}
      </select>
      {provider === 'ollama' && (
        <>
          <label htmlFor={`${idPrefix}-model`}>Model</label>
          <select id={`${idPrefix}-model`} value={model} onChange={(event) => choose('ollama', event.target.value)}>
            <option value="">Choose a model…</option>
            {models.map((m) => (
              <option key={m.name} value={m.name}>
                {m.name}
              </option>
            ))}
          </select>
        </>
      )}
      {chosen !== undefined && (
        <span className="muted" role="note">
          {PROVIDER_LOCATION[chosen.id] === 'local' ? 'Runs on this PC; the text stays here.' : `Sends your text to ${chosen.id === 'claude-code' ? 'Anthropic' : 'OpenAI'}. You confirm each time before it is sent.`}
        </span>
      )}
    </div>
  );
}
