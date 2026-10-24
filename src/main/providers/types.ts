import type { Capabilities, OllamaModel, PullProgress, ProviderId, ProviderStatus, Usage } from '@shared/providers';

// The provider contract (spec §9). Every adapter implements `detect`; the rest is offered only when the provider really has it,
// and `capabilities` says which. Nothing assumes two providers behave alike.

export interface GenerateRequest {
  /** Empty means the provider's own default. */
  model: string;
  prompt: string;
  /** Where the provider runs, for those that run as a program. A fresh empty folder for text-only requests. */
  cwd?: string;
  signal: AbortSignal;
  onText?: (text: string) => void;
}

export interface ProviderOutput {
  text: string;
  usage: Usage | null;
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  /** Looks at the tool as it is now and reports it. Never throws for "not installed" or "not running": those are answers. */
  detect(): Promise<Omit<ProviderStatus, 'checkedAt' | 'lastSuccessAt'>>;
  readonly capabilities: Capabilities;
  models?(): Promise<OllamaModel[]>;
  warmUp?(model: string, signal: AbortSignal): Promise<void>;
  pull?(model: string, signal: AbortSignal, onProgress: (progress: PullProgress) => void): Promise<void>;
  generate(request: GenerateRequest): Promise<ProviderOutput>;
}
