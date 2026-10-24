import { z } from 'zod';

// AI providers (spec §9): one typed contract for tools that are very different from each other. A provider only offers what
// it really has; the page shows capabilities as detected, not as hoped. Nothing about a provider's quota or cost is shown
// unless the provider returned it.

export const PROVIDER_IDS = ['ollama', 'claude-code', 'codex'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const PROVIDER_LABELS: Record<ProviderId, string> = { ollama: 'Ollama (local)', 'claude-code': 'Claude Code', codex: 'Codex CLI' };
/** Where a prompt goes. Local providers keep text on this PC; cloud providers send it to the vendor. */
export const PROVIDER_LOCATION: Record<ProviderId, 'local' | 'cloud'> = { ollama: 'local', 'claude-code': 'cloud', codex: 'cloud' };

export const PROVIDER_STATUSES = ['not-installed', 'installed', 'needs-setup', 'working', 'error'] as const;
export type ProviderStatusName = (typeof PROVIDER_STATUSES)[number];
export const STATUS_TEXT: Record<ProviderStatusName, string> = {
  'not-installed': 'Not installed',
  installed: 'Installed',
  'needs-setup': 'Needs setup',
  working: 'Working',
  error: 'Error',
};

export const CapabilitiesSchema = z.object({
  /** Models can be listed. */
  models: z.boolean(),
  /** Output arrives while it is generated. */
  streaming: z.boolean(),
  /** A running request can be cancelled. */
  cancellation: z.boolean(),
  /** The context length can be set per request. */
  contextLength: z.boolean(),
  /** The provider returns machine-readable results (JSON). */
  structuredOutput: z.boolean(),
  /** The provider reports usage or cost with a result. */
  usageReporting: z.boolean(),
  /** Read-only or plan mode is available (the only mode used until Step 15). */
  readOnlyMode: z.boolean(),
});
export type Capabilities = z.output<typeof CapabilitiesSchema>;

export const ProviderStatusSchema = z.object({
  id: z.enum(PROVIDER_IDS),
  label: z.string().max(60),
  location: z.enum(['local', 'cloud']),
  status: z.enum(PROVIDER_STATUSES),
  version: z.string().max(60).nullable(),
  /** What is true right now, in plain words. */
  message: z.string().max(500),
  /** What to do about it. Empty when nothing is needed. */
  hint: z.string().max(500),
  capabilities: CapabilitiesSchema,
  /** Quotas and allowances are shown only if a documented source returned them. */
  quota: z.string().max(100),
  details: z.array(z.object({ label: z.string().max(60), value: z.string().max(300) })).max(12),
  checkedAt: z.iso.datetime(),
  lastSuccessAt: z.iso.datetime().nullable(),
});
export type ProviderStatus = z.output<typeof ProviderStatusSchema>;

export const QUOTA_UNAVAILABLE = 'Unavailable from this provider';

export const OllamaModelSchema = z.object({
  name: z.string().max(200),
  sizeBytes: z.number().nonnegative().nullable(),
  modifiedAt: z.string().max(40).nullable(),
  family: z.string().max(80).nullable(),
  parameterSize: z.string().max(40).nullable(),
  quantization: z.string().max(40).nullable(),
  /** The most the model supports, from the model's own metadata; null when it does not say. */
  contextLength: z.number().int().nonnegative().nullable(),
  /** Loaded in memory right now. */
  loaded: z.boolean(),
});
export type OllamaModel = z.output<typeof OllamaModelSchema>;

export const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/;

export const GENERATE_PURPOSES = ['connection-test', 'task-breakdown', 'document-draft', 'project-session'] as const;
export type GeneratePurpose = (typeof GENERATE_PURPOSES)[number];

export const ProviderChoiceSchema = z.strictObject({
  provider: z.enum(PROVIDER_IDS),
  /** Required for Ollama, optional for the others (they choose their own default). */
  model: z.string().regex(MODEL_NAME).or(z.literal('')),
});
export type ProviderChoice = z.input<typeof ProviderChoiceSchema>;

export const UsageSchema = z.object({
  inputCount: z.number().int().nonnegative().nullable(),
  outputCount: z.number().int().nonnegative().nullable(),
  /** A client-side estimate returned by the provider; never a charge. The counts are tokens as the provider counted them. */
  costUsdEstimate: z.number().nonnegative().nullable(),
});
export type Usage = z.output<typeof UsageSchema>;

export const GenerateResultSchema = z.object({
  /** False when the user declined the confirmation that names the destination; nothing was sent. */
  sent: z.boolean(),
  text: z.string().max(200_000),
  provider: z.enum(PROVIDER_IDS),
  model: z.string().max(200),
  elapsedMs: z.number().nonnegative(),
  /** The output was cut because it was longer than the limit. */
  truncated: z.boolean(),
  usage: UsageSchema.nullable(),
});
export type GenerateResult = z.output<typeof GenerateResultSchema>;

export const SuggestedStepSchema = z.object({ title: z.string().trim().min(1).max(200), acceptance: z.array(z.string().trim().min(1).max(500)).max(10).default([]) });
export const SuggestStepsResultSchema = z.object({
  sent: z.boolean(),
  steps: z.array(SuggestedStepSchema).max(30),
  provider: z.enum(PROVIDER_IDS),
  model: z.string().max(200),
});
export type SuggestStepsResult = z.output<typeof SuggestStepsResultSchema>;

export const PullProgressSchema = z.object({
  model: z.string().max(200),
  status: z.string().max(200),
  completed: z.number().nonnegative().nullable(),
  total: z.number().nonnegative().nullable(),
  done: z.boolean(),
});
export type PullProgress = z.output<typeof PullProgressSchema>;

/** Reads the steps a provider suggested. The provider is asked for JSON; anything else is refused rather than guessed at. */
export function parseSuggestedSteps(text: string): z.output<typeof SuggestedStepSchema>[] | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1];
  const candidates = [fenced, text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1), text.slice(text.indexOf('['), text.lastIndexOf(']') + 1)];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate.trim() === '') continue;
    try {
      const value: unknown = JSON.parse(candidate);
      const list = Array.isArray(value) ? value : (value as { steps?: unknown }).steps;
      const parsed = z.array(z.union([z.string().trim().min(1).max(200).transform((title) => ({ title, acceptance: [] as string[] })), SuggestedStepSchema])).min(1).max(30).safeParse(list);
      if (parsed.success) return parsed.data;
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}
