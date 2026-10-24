import { z } from 'zod';
import type { AgentRoleId } from './agents';
import { MODEL_NAME, PROVIDER_IDS, PROVIDER_LABELS, PROVIDER_LOCATION, type ProviderId, type ProviderStatus } from './providers';
import type { Complexity } from './tasks';

// Model routing (spec §12): which provider and model a run uses, and why, decided by a pure function so every profile can be
// tested and the same reasons are shown in the UI and in the confirmation before cloud work. Routing never makes a call by
// itself, never picks a second provider for the same run, and never replaces an explicit choice with something else.

export const ROUTING_PROFILES = ['manual', 'local-first', 'balanced', 'cloud-first'] as const;
export type RoutingProfile = (typeof ROUTING_PROFILES)[number];

export const PROFILE_LABELS: Record<RoutingProfile, string> = { manual: 'Manual', 'local-first': 'Local First', balanced: 'Balanced', 'cloud-first': 'Cloud First' };
export const PROFILE_DESCRIPTIONS: Record<RoutingProfile, string> = {
  manual: 'Nothing is chosen for you: each run uses the provider you pick, your setting for its role, or the provider the task names.',
  'local-first': 'Ollama on this PC for every role when it can be used; a cloud agent only when it cannot, and only after you approve.',
  balanced: 'Ollama for documentation, asset briefs and small plans; the cloud coding agent for implementation, review, QA and larger plans.',
  'cloud-first': 'The cloud coding agent (Claude Code, then Codex) for every role; Ollama only when no cloud agent is available.',
};

export const BILLINGS = ['local', 'subscription', 'api', 'unknown'] as const;
export type Billing = (typeof BILLINGS)[number];

export const RoleOverrideSchema = z.strictObject({
  provider: z.enum(PROVIDER_IDS).or(z.literal('')),
  model: z.string().regex(MODEL_NAME).or(z.literal('')),
});
export type RoleOverride = z.output<typeof RoleOverrideSchema>;

export const RouteSchema = z.object({
  profile: z.enum(ROUTING_PROFILES),
  /** Null when no provider can be used; `reasons` then says why and what to do. */
  provider: z.enum(PROVIDER_IDS).nullable(),
  /** Empty means the provider's own default (never for Ollama). */
  model: z.string().max(200),
  location: z.enum(['local', 'cloud']).nullable(),
  billing: z.enum(BILLINGS).nullable(),
  /** What the run costs, as far as the app can know. Never "free" for a cloud agent. */
  billingNote: z.string().max(400),
  reasons: z.array(z.string().max(400)).max(10),
  /** The profile wanted something cheaper that cannot be used now, so this route costs more than intended. */
  fallback: z.boolean(),
});
export type Route = z.output<typeof RouteSchema>;

export type Availability = Record<ProviderId, { ok: boolean; why: string }>;

export interface RouteInput {
  profile: RoutingProfile;
  role: AgentRoleId;
  roleLabel: string;
  task: { provider: string; complexity: Complexity };
  /** The routing setting for this role; an empty provider means none. */
  override?: RoleOverride | undefined;
  /** A provider picked by the person for this one run. */
  choice?: { provider: ProviderId; model: string } | undefined;
  /** The Ollama model used when routing picks Ollama and nothing names another. */
  localModel: string;
  available: Availability;
  /** ANTHROPIC_API_KEY is set, so Claude Code may bill the API account instead of the subscription. */
  apiKeySet: boolean;
}

const CLOUD_ORDER: readonly ProviderId[] = ['claude-code', 'codex'];
export const LOCAL_LIMIT = 'Ollama receives only the task text; it cannot read the project files.';

export function billingOf(provider: ProviderId, apiKeySet: boolean): { billing: Billing; billingNote: string } {
  if (provider === 'ollama') return { billing: 'local', billingNote: 'Runs on this PC with Ollama: no usage charge, but it uses your GPU or CPU and memory.' };
  if (provider === 'claude-code')
    return apiKeySet
      ? { billing: 'api', billingNote: 'ANTHROPIC_API_KEY is set, so Claude Code may bill your Anthropic API account per use (metered). The app cannot see the cost.' }
      : { billing: 'subscription', billingNote: 'Counts against your Claude Code subscription limits. It is not free, and the app cannot see how much is left.' };
  return { billing: 'unknown', billingNote: 'Uses your Codex sign-in: a ChatGPT plan, or an API key that is billed per use. The app cannot tell which, or see limits or cost.' };
}

/** "Claude Code", "claude-code" or "ollama" on a task become a provider id; anything else is not a provider. */
export function providerNamed(text: string): ProviderId | undefined {
  const t = text.trim().toLowerCase();
  if (t === '') return undefined;
  return PROVIDER_IDS.find((id) => t === id || t === PROVIDER_LABELS[id].toLowerCase() || t.startsWith(id.replace('-', ' ')) || t.startsWith(id));
}

/** Which providers can take a request now, from their last known status. Ollama also needs to be running with models. */
export function availabilityFrom(statuses: readonly Pick<ProviderStatus, 'id' | 'status' | 'message'>[]): Availability {
  const result = Object.fromEntries(PROVIDER_IDS.map((id) => [id, { ok: false, why: 'It has not been checked yet.' }])) as Availability;
  for (const s of statuses) result[s.id] = { ok: s.id === 'ollama' ? s.status === 'working' : s.status === 'installed' || s.status === 'working', why: s.message };
  return result;
}

export function chooseRoute(input: RouteInput): Route {
  const { profile, available } = input;
  const none = (reasons: string[]): Route => ({ profile, provider: null, model: '', location: null, billing: null, billingNote: '', reasons, fallback: false });
  const pick = (provider: ProviderId, model: string, reasons: string[], fallback = false): Route => ({
    profile,
    provider,
    model,
    location: PROVIDER_LOCATION[provider],
    ...billingOf(provider, input.apiKeySet),
    reasons: provider === 'ollama' ? [...reasons, LOCAL_LIMIT] : reasons,
    fallback,
  });
  // An explicit choice is used as it is, or not at all: it is never silently replaced by another provider.
  const explicit = (provider: ProviderId, model: string, source: string): Route => {
    const label = PROVIDER_LABELS[provider];
    if (!available[provider].ok) return none([source, `${label} cannot be used now: ${available[provider].why}`]);
    const chosen = model !== '' ? model : provider === 'ollama' ? input.localModel : '';
    if (provider === 'ollama' && chosen === '') return none([source, 'No Ollama model is chosen. Pick one in the routing settings on the AI Workbench.']);
    return pick(provider, chosen, [source]);
  };

  if (input.choice !== undefined) return explicit(input.choice.provider, input.choice.model, `You chose ${PROVIDER_LABELS[input.choice.provider]} for this run.`);
  if (input.override !== undefined && input.override.provider !== '')
    return explicit(input.override.provider, input.override.model, `Your routing setting for the ${input.roleLabel} role picks ${PROVIDER_LABELS[input.override.provider]}.`);
  if (profile === 'manual') {
    const named = providerNamed(input.task.provider);
    if (named !== undefined) return explicit(named, '', `Manual routing: the task names ${PROVIDER_LABELS[named]}.`);
    return none(['Manual routing chooses nothing for you. Pick a provider for this run, set one for this role in the routing settings, or name one on the task.']);
  }

  const lowRisk = input.role === 'docs' || input.role === 'assets' || (input.role === 'planner' && (input.task.complexity === 'xs' || input.task.complexity === 's'));
  const preferLocal = profile === 'local-first' || (profile === 'balanced' && lowRisk);
  const why =
    profile === 'balanced'
      ? lowRisk
        ? `Balanced: the ${input.roleLabel} role on this task is low-risk text work, which suits a local model.`
        : `Balanced: the ${input.roleLabel} role on this task needs a capable coding agent that can read the project.`
      : `${PROFILE_LABELS[profile]}: ${preferLocal ? 'a local model is preferred' : 'the cloud coding agent is preferred'} for every role.`;
  const localWhy = !available.ollama.ok ? `Ollama cannot be used now: ${available.ollama.why}` : input.localModel === '' ? 'No Ollama model is chosen in the routing settings.' : '';
  const cloud = CLOUD_ORDER.find((id) => available[id].ok);

  if (preferLocal) {
    if (localWhy === '') return pick('ollama', input.localModel, [why]);
    if (cloud === undefined) return none([why, localWhy, 'No cloud coding agent can be used either.']);
    return pick(cloud, '', [why, localWhy, `So ${PROVIDER_LABELS[cloud]} would be used instead, which is not free. You are asked before anything is sent.`], true);
  }
  if (cloud !== undefined) return pick(cloud, '', [why]);
  if (localWhy === '') return pick('ollama', input.localModel, [why, 'No cloud coding agent can be used now, so Ollama is used.']);
  return none([why, 'No cloud coding agent can be used now.', localWhy]);
}

const RANK: Record<Billing, number> = { local: 0, subscription: 1, unknown: 2, api: 3 };

/** What changes from the earlier attempt of a run, so the confirmation can ask before a repeat or a more expensive route. */
export function escalationNotes(previous: Route | null, next: Route, attempt: number, maxAttempts: number): string[] {
  if (previous === null || previous.provider === null || next.provider === null || next.billing === null) return [];
  const notes: string[] = [];
  const before = PROVIDER_LABELS[previous.provider];
  const after = PROVIDER_LABELS[next.provider];
  if (previous.billing !== null && RANK[next.billing] > RANK[previous.billing])
    notes.push(`Escalation: the earlier attempt used ${before}${previous.location === 'local' ? ' on this PC' : ''}; this attempt goes to ${after}, which costs more.`);
  if (previous.provider === next.provider && previous.model !== next.model && next.location === 'cloud')
    notes.push(`This attempt uses a different model (${next.model || 'the default'} instead of ${previous.model || 'the default'}), which may cost more.`);
  if (previous.location === 'cloud') notes.push(`This repeats an earlier ${before} call that did not finish (attempt ${attempt} of at most ${maxAttempts}).`);
  return notes;
}
