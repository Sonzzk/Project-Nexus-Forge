import type { GenerateResult, OllamaModel, ProviderStatus, SuggestStepsResult } from '../../src/shared/providers';
import type { ResourceReport } from '../../src/shared/resources';
import type { FakeApi } from './fake-api';

// Canned answers for the provider channels, for component tests (the real rules are tested in src/main/providers).

export const sampleProvider = (id: ProviderStatus['id'], overrides: Partial<ProviderStatus> = {}): ProviderStatus => ({
  id,
  label: id === 'ollama' ? 'Ollama (local)' : id === 'claude-code' ? 'Claude Code' : 'Codex CLI',
  location: id === 'ollama' ? 'local' : 'cloud',
  status: 'working',
  version: '1.0.0',
  message: `${id} is available.`,
  hint: '',
  capabilities: { models: id === 'ollama', streaming: true, cancellation: true, contextLength: id === 'ollama', structuredOutput: id !== 'ollama', usageReporting: id !== 'ollama', readOnlyMode: true },
  quota: 'Unavailable from this provider',
  details: [{ label: 'Version', value: '1.0.0' }],
  checkedAt: '2026-10-24T10:00:00.000Z',
  lastSuccessAt: null,
  ...overrides,
});

export const sampleModel = (name: string, overrides: Partial<OllamaModel> = {}): OllamaModel => ({
  name, sizeBytes: 1_321_098_329, modifiedAt: null, family: 'llama', parameterSize: '1.2B', quantization: 'Q8_0', contextLength: 131072, loaded: false, ...overrides,
});

export interface FakeProviders {
  providers: ProviderStatus[];
  models: OllamaModel[];
  /** What generate answers; sent:false imitates a declined confirmation. */
  generated: GenerateResult;
  suggestion: SuggestStepsResult;
  draft: GenerateResult;
  pulled: string[];
  warmed: string[];
  resources: ResourceReport;
}

export function attachProviders(fake: FakeApi, seed: Partial<FakeProviders> = {}): FakeProviders {
  const state: FakeProviders = {
    providers: [sampleProvider('ollama'), sampleProvider('claude-code', { status: 'installed', message: 'Claude Code 2.1.197 is installed.', hint: 'Open a terminal, run claude, and follow the sign-in.' }), sampleProvider('codex', { status: 'not-installed', version: null, message: 'Codex CLI was not found on this PC. It is optional.', details: [] })],
    models: [sampleModel('llama3.2:1b')],
    generated: { sent: true, text: 'OK', provider: 'ollama', model: 'llama3.2:1b', elapsedMs: 800, truncated: false, usage: null },
    suggestion: { sent: true, provider: 'ollama', model: 'llama3.2:1b', steps: [{ title: 'Add the crouch input', acceptance: ['C toggles crouch'] }, { title: 'Lower the camera', acceptance: [] }] },
    draft: { sent: true, text: '# Decisions: Alpha\n\n- TODO: confirm the engine version\n', provider: 'ollama', model: 'llama3.2:1b', elapsedMs: 900, truncated: false, usage: null },
    pulled: [],
    warmed: [],
    resources: {
      snapshot: { at: '2026-10-24T10:00:00.000Z', cpuPercent: 14, ramFreeMiB: 40_960, ramTotalMiB: 65_536, gpus: [{ name: 'NVIDIA GeForce RTX 3060', utilPercent: 20, vramUsedMiB: 3763, vramTotalMiB: 12288, vramFreeMiB: 8353 }], gpuNote: '', heavyApps: [], appsNote: '' },
      verdict: { allowed: true, blocks: [], warnings: [] },
    },
    ...seed,
  };
  fake.handlers['providers:list'] = () => state.providers;
  fake.handlers['providers:check'] = (input) => state.providers.find((p) => p.id === (input as { provider: string }).provider);
  fake.handlers['providers:models'] = (input) => ((input as { provider: string }).provider === 'ollama' ? state.models : []);
  fake.handlers['providers:warmUp'] = (input) => {
    state.warmed.push((input as { model: string }).model);
    return { loaded: true };
  };
  fake.handlers['providers:pull'] = (input) => {
    const { model } = input as { model: string };
    state.pulled.push(model);
    fake.emit('providers:progress', { model, status: 'pulling', completed: 500, total: 1000, done: false });
    return { pulled: true };
  };
  fake.handlers['providers:cancel'] = () => ({ cancelled: false });
  fake.handlers['providers:unload'] = (input) => {
    const { model } = input as { model: string };
    state.models = state.models.map((m) => (m.name === model ? { ...m, loaded: false } : m));
    return { unloaded: true };
  };
  fake.handlers['resources:check'] = () => state.resources;
  fake.handlers['providers:generate'] = () => state.generated;
  fake.handlers['providers:suggestSteps'] = () => state.suggestion;
  fake.handlers['providers:draftDocument'] = () => state.draft;
  return state;
}
