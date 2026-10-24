import { AppError } from '../../src/shared/errors';
import { PROVIDER_LABELS, PROVIDER_LOCATION, QUOTA_UNAVAILABLE, type OllamaModel, type ProviderId, type ProviderStatus, type PullProgress, type Usage } from '../../src/shared/providers';
import type { GenerateRequest, ProviderAdapter, ProviderOutput } from '../../src/main/providers';

// A scripted provider for tests. It exists only under test/ (ARCHITECTURE.md section 14): the app never ships a mock provider
// and never shows one as real.

export interface MockProvider extends ProviderAdapter {
  requests: GenerateRequest[];
  pulled: string[];
  warmed: string[];
  unloaded: string[];
  status: Omit<ProviderStatus, 'checkedAt' | 'lastSuccessAt'>;
  /** What the next `generate` answers; a function can inspect the request. */
  answer: string | ((request: GenerateRequest) => string);
  /** Makes `generate` wait for an abort (to test cancelling and "one at a time"). */
  hold: boolean;
  failWith: AppError | undefined;
  /** What the next `generate` reports as usage; null means the provider returned none. */
  usage: Usage | null;
  modelList: OllamaModel[];
}

export function createMockProvider(id: ProviderId, overrides: Partial<Pick<MockProvider, 'status' | 'answer' | 'modelList'>> = {}): MockProvider {
  const mock: MockProvider = {
    id,
    capabilities: { models: id === 'ollama', streaming: true, cancellation: true, contextLength: id === 'ollama', structuredOutput: false, usageReporting: false, readOnlyMode: true },
    requests: [],
    pulled: [],
    warmed: [],
    unloaded: [],
    status: {
      id,
      label: PROVIDER_LABELS[id],
      location: PROVIDER_LOCATION[id],
      status: id === 'ollama' ? 'working' : 'installed',
      version: '1.0.0',
      message: `${PROVIDER_LABELS[id]} is available (mock).`,
      hint: '',
      capabilities: { models: id === 'ollama', streaming: true, cancellation: true, contextLength: id === 'ollama', structuredOutput: false, usageReporting: false, readOnlyMode: true },
      quota: QUOTA_UNAVAILABLE,
      details: [],
    },
    answer: 'OK',
    hold: false,
    failWith: undefined,
    usage: null,
    modelList: [],
    ...overrides,
    detect() {
      return Promise.resolve(mock.status);
    },
    models() {
      return Promise.resolve(mock.modelList);
    },
    warmUp(model) {
      mock.warmed.push(model);
      return Promise.resolve();
    },
    unload(model) {
      mock.unloaded.push(model);
      return Promise.resolve();
    },
    pull(model, _signal, onProgress: (progress: PullProgress) => void) {
      mock.pulled.push(model);
      onProgress({ model, status: 'pulling', completed: 1, total: 2, done: false });
      onProgress({ model, status: 'success', completed: null, total: null, done: true });
      return Promise.resolve();
    },
    async generate(request: GenerateRequest): Promise<ProviderOutput> {
      mock.requests.push(request);
      if (mock.failWith !== undefined) throw mock.failWith;
      if (mock.hold)
        await new Promise<void>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(new AppError('CANCELLED', 'Stopped.')), { once: true });
        });
      const text = typeof mock.answer === 'function' ? mock.answer(request) : mock.answer;
      request.onText?.(text);
      return { text, usage: mock.usage };
    },
  };
  return mock;
}
