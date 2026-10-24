import { describe, expect, it } from 'vitest';
import { AGENT_ROLES, AGENT_ROLE_IDS, FINAL_RUN_STATES, RUN_STATES, RUN_TRANSITIONS, WORKFLOWS, renderPrompt, roleById } from './agents';
import { ROLES } from './tasks';

describe('agent roles (spec §11)', () => {
  it('are the six roles of the spec, matching the roles a task can suggest', () => {
    expect([...AGENT_ROLE_IDS].sort()).toEqual(ROLES.filter((r) => r !== '').sort());
    expect(AGENT_ROLES.map((r) => r.id)).toEqual([...AGENT_ROLE_IDS]);
    for (const role of AGENT_ROLES) {
      expect(role.purpose).not.toBe('');
      expect(role.expectedOutput).not.toBe('');
    }
  });

  it('only the implementer can write; every other role is read-only', () => {
    expect(AGENT_ROLES.filter((r) => r.writeCapable).map((r) => r.id)).toEqual(['implementer']);
    for (const role of AGENT_ROLES.filter((r) => !r.writeCapable)) expect(role.promptTemplate.toLowerCase()).toMatch(/do not (change|move)|propose text only|only; do not/);
  });

  it('renders each prompt from the task alone, leaving no placeholder, and marks missing fields', () => {
    const task = { title: 'Add jumping', description: '', acceptance: ['Jump is tunable', 'No double jump'], files: ['scripts/player.gd'], testRequirements: '' };
    for (const role of AGENT_ROLES) {
      const prompt = renderPrompt(role, task, 'Alpha');
      expect(prompt, role.id).not.toContain('{{');
      expect(prompt).toContain('Add jumping');
      expect(prompt).toContain('Alpha');
    }
    const implementer = renderPrompt(roleById('implementer') as (typeof AGENT_ROLES)[number], task, 'Alpha');
    expect(implementer).toContain('- Jump is tunable\n- No double jump');
    expect(implementer).toContain('- scripts/player.gd');
    expect(implementer).toContain('(no description)');
    expect(implementer).toContain('(none given)');
  });
});

describe('run states', () => {
  it('has the nine visible states of spec §11, and never a move to itself or to an unknown state', () => {
    expect([...RUN_STATES]).toEqual(['queued', 'planning', 'awaiting-approval', 'running', 'awaiting-review', 'testing', 'completed', 'failed', 'cancelled']);
    for (const [from, targets] of Object.entries(RUN_TRANSITIONS)) {
      for (const target of targets) {
        expect(RUN_STATES).toContain(target);
        expect(target).not.toBe(from);
      }
    }
  });

  it('completed, failed and cancelled are final; every other state can reach a final one', () => {
    for (const state of FINAL_RUN_STATES) expect(RUN_TRANSITIONS[state]).toEqual([]);
    const reaches = (from: (typeof RUN_STATES)[number], seen = new Set<string>()): boolean => {
      if (FINAL_RUN_STATES.includes(from)) return true;
      if (seen.has(from)) return false;
      seen.add(from);
      return RUN_TRANSITIONS[from].some((next) => reaches(next, seen));
    };
    for (const state of RUN_STATES) expect(reaches(state), state).toBe(true);
  });

  it('a queued run cannot jump to review or testing, and nothing leaves a final state', () => {
    expect(RUN_TRANSITIONS.queued).not.toContain('awaiting-review');
    expect(RUN_TRANSITIONS.queued).not.toContain('testing');
    expect(RUN_TRANSITIONS['awaiting-approval']).toContain('running');
  });
});

describe('workflow templates', () => {
  it('only the reviewer and QA steps are optional, and the approval step is never an agent', () => {
    for (const workflow of WORKFLOWS) {
      for (const step of workflow.steps) {
        if (step.optional) expect(['reviewer', 'qa']).toContain(step.role);
        if (step.kind === 'approval') expect(step.role).toBeUndefined();
      }
    }
  });

  it('the implementing workflow plans first, asks for approval, and only then implements', () => {
    const implement = WORKFLOWS.find((w) => w.id === 'implement');
    expect(implement?.steps.map((s) => s.role ?? s.kind)).toEqual(['planner', 'approval', 'implementer', 'reviewer', 'qa']);
  });

  it('no template other than the implementing one contains a write-capable role', () => {
    for (const workflow of WORKFLOWS.filter((w) => w.id !== 'implement'))
      for (const step of workflow.steps) expect(roleById(step.role ?? '')?.writeCapable ?? false, workflow.id).toBe(false);
  });
});
