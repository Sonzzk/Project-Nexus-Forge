import { describe, expect, it } from 'vitest';
import type { AgentRoleId } from './agents';
import { availabilityFrom, chooseRoute, escalationNotes, providerNamed, ROUTING_PROFILES, type Availability, type RouteInput } from './routing';
import type { Complexity } from './tasks';

const all: Availability = { ollama: { ok: true, why: '' }, 'claude-code': { ok: true, why: '' }, codex: { ok: true, why: '' } };
const off = (why: string) => ({ ok: false, why });

const input = (extra: Partial<RouteInput> & { role?: AgentRoleId; complexity?: Complexity; taskProvider?: string } = {}): RouteInput => ({
  profile: 'balanced',
  roleLabel: 'Role',
  localModel: 'qwen3:8b',
  available: all,
  apiKeySet: false,
  ...extra,
  role: extra.role ?? 'planner',
  task: { provider: extra.taskProvider ?? '', complexity: extra.complexity ?? '' },
});

describe('routing per profile', () => {
  it('Manual chooses nothing by itself, and uses the provider the task names', () => {
    expect(chooseRoute(input({ profile: 'manual' }))).toMatchObject({ provider: null, reasons: [expect.stringContaining('chooses nothing') as unknown] });
    expect(chooseRoute(input({ profile: 'manual', taskProvider: 'Claude Code' }))).toMatchObject({ provider: 'claude-code', location: 'cloud', model: '' });
    expect(chooseRoute(input({ profile: 'manual', taskProvider: 'ollama' }))).toMatchObject({ provider: 'ollama', model: 'qwen3:8b', location: 'local', billing: 'local' });
    expect(chooseRoute(input({ profile: 'manual', taskProvider: 'GPT-9 turbo' })).provider).toBeNull();
  });

  it('Local First uses Ollama for every role, including the implementer', () => {
    for (const role of ['planner', 'implementer', 'reviewer', 'qa', 'docs', 'assets'] as const)
      expect(chooseRoute(input({ profile: 'local-first', role }))).toMatchObject({ provider: 'ollama', model: 'qwen3:8b', fallback: false });
  });

  it('Local First falls back to the cloud only as a marked fallback that needs approval', () => {
    const route = chooseRoute(input({ profile: 'local-first', available: { ...all, ollama: off('Ollama is installed but not running.') } }));
    expect(route).toMatchObject({ provider: 'claude-code', fallback: true });
    expect(route.reasons.join(' ')).toMatch(/not running.*not free/s);
    expect(chooseRoute(input({ profile: 'local-first', localModel: '' }))).toMatchObject({ provider: 'claude-code', fallback: true });
  });

  it('Balanced sends low-risk text work to Ollama and coding work to the cloud agent', () => {
    expect(chooseRoute(input({ role: 'docs' })).provider).toBe('ollama');
    expect(chooseRoute(input({ role: 'assets' })).provider).toBe('ollama');
    expect(chooseRoute(input({ role: 'planner', complexity: 's' })).provider).toBe('ollama');
    expect(chooseRoute(input({ role: 'planner', complexity: 'l' })).provider).toBe('claude-code');
    expect(chooseRoute(input({ role: 'planner', complexity: '' })).provider).toBe('claude-code');
    for (const role of ['implementer', 'reviewer', 'qa'] as const) expect(chooseRoute(input({ role })).provider).toBe('claude-code');
  });

  it('Cloud First prefers Claude Code, then Codex, and uses Ollama only when no cloud agent can be used (not a fallback: it is cheaper)', () => {
    expect(chooseRoute(input({ profile: 'cloud-first', role: 'docs' })).provider).toBe('claude-code');
    expect(chooseRoute(input({ profile: 'cloud-first', available: { ...all, 'claude-code': off('not installed') } })).provider).toBe('codex');
    const local = chooseRoute(input({ profile: 'cloud-first', available: { ...all, 'claude-code': off('x'), codex: off('y') } }));
    expect(local).toMatchObject({ provider: 'ollama', fallback: false });
  });

  it('says why when nothing can be used, in every profile', () => {
    const none: Availability = { ollama: off('Ollama is not running.'), 'claude-code': off('Claude Code was not found.'), codex: off('Codex was not found.') };
    for (const profile of ROUTING_PROFILES) {
      const route = chooseRoute(input({ profile, available: none }));
      expect(route.provider, profile).toBeNull();
      expect(route.reasons.length, profile).toBeGreaterThan(0);
    }
  });

  it('a role setting or a choice for one run wins in every profile, and is never replaced when it cannot be used', () => {
    for (const profile of ROUTING_PROFILES) {
      expect(chooseRoute(input({ profile, role: 'implementer', override: { provider: 'codex', model: 'gpt-5-codex' } })), profile).toMatchObject({ provider: 'codex', model: 'gpt-5-codex' });
      expect(chooseRoute(input({ profile, role: 'docs', choice: { provider: 'claude-code', model: 'opus' } })), profile).toMatchObject({ provider: 'claude-code', model: 'opus' });
    }
    const unavailable = chooseRoute(input({ profile: 'balanced', override: { provider: 'codex', model: '' }, available: { ...all, codex: off('Codex was not found.') } }));
    expect(unavailable.provider).toBeNull();
    expect(unavailable.reasons.join(' ')).toContain('Codex was not found.');
    expect(chooseRoute(input({ choice: { provider: 'ollama', model: '' }, localModel: '' })).provider).toBeNull();
    expect(chooseRoute(input({ choice: { provider: 'ollama', model: 'llama3.2:1b' } }))).toMatchObject({ provider: 'ollama', model: 'llama3.2:1b' });
    expect(chooseRoute(input({ override: { provider: '', model: '' }, role: 'docs' })).provider).toBe('ollama'); // an empty setting is no setting
  });

  it('never calls a cloud agent free, and names metered billing when an API key is set', () => {
    expect(chooseRoute(input({ role: 'implementer' }))).toMatchObject({ billing: 'subscription', billingNote: expect.stringContaining('not free') as unknown });
    expect(chooseRoute(input({ role: 'implementer', apiKeySet: true }))).toMatchObject({ billing: 'api', billingNote: expect.stringContaining('metered') as unknown });
    expect(chooseRoute(input({ profile: 'cloud-first', available: { ...all, 'claude-code': off('x') } }))).toMatchObject({ billing: 'unknown' });
    expect(chooseRoute(input({ role: 'docs' })).reasons.join(' ')).toContain('cannot read the project files');
  });
});

describe('escalation and repeats', () => {
  const local = chooseRoute(input({ role: 'docs' }));
  const cloud = chooseRoute(input({ role: 'implementer' }));
  const metered = chooseRoute(input({ role: 'implementer', apiKeySet: true }));

  it('names an escalation from local to cloud, and from subscription to metered billing', () => {
    expect(escalationNotes(local, cloud, 2, 3).join(' ')).toMatch(/Escalation.*Ollama.*Claude Code/);
    expect(escalationNotes(cloud, metered, 2, 3).join(' ')).toContain('Escalation');
  });

  it('names a repeated cloud call with its attempt number, and a changed model', () => {
    expect(escalationNotes(cloud, cloud, 2, 3)).toEqual([expect.stringContaining('attempt 2 of at most 3')]);
    expect(escalationNotes(cloud, { ...cloud, model: 'opus' }, 3, 3).join(' ')).toMatch(/different model.*opus/);
  });

  it('has nothing to say for a first attempt or a cheaper retry', () => {
    expect(escalationNotes(null, cloud, 1, 3)).toEqual([]);
    expect(escalationNotes(local, local, 2, 3)).toEqual([]);
  });
});

describe('helpers', () => {
  it('reads provider names from task text', () => {
    expect(providerNamed('Claude Code')).toBe('claude-code');
    expect(providerNamed('codex cli')).toBe('codex');
    expect(providerNamed(' Ollama (local) ')).toBe('ollama');
    expect(providerNamed('')).toBeUndefined();
    expect(providerNamed('my brain')).toBeUndefined();
  });

  it('a CLI is usable once installed; Ollama only when running with models', () => {
    const a = availabilityFrom([
      { id: 'ollama', status: 'needs-setup', message: 'No models yet.' },
      { id: 'claude-code', status: 'installed', message: '' },
      { id: 'codex', status: 'not-installed', message: 'Not found.' },
    ]);
    expect(a).toEqual({ ollama: { ok: false, why: 'No models yet.' }, 'claude-code': { ok: true, why: '' }, codex: { ok: false, why: 'Not found.' } });
    expect(availabilityFrom([]).ollama.ok).toBe(false);
  });
});
