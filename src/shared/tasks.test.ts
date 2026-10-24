import { describe, expect, it } from 'vitest';
import {
  allowedNext,
  progressOf,
  satisfiesDependency,
  TASK_STATUSES,
  TASK_TEMPLATES,
  TEMPLATE_IDS,
  TRANSITIONS,
  wouldCycle,
  BOARD_STATUSES,
  SIDE_STATUSES,
  TaskCreateSchema,
} from './tasks';

describe('task lifecycle rules', () => {
  it('follows the spec: Inbox, Planned, Ready, In progress, Review, Testing, Done, plus blocked, cancelled and failed', () => {
    expect([...BOARD_STATUSES, ...SIDE_STATUSES].sort()).toEqual([...TASK_STATUSES].sort());
    expect(BOARD_STATUSES).toEqual(['inbox', 'planned', 'ready', 'in-progress', 'review', 'testing', 'done']);
  });

  it('only allows moves to real statuses, never to itself, and never straight from Inbox to Done', () => {
    for (const [from, targets] of Object.entries(TRANSITIONS)) {
      for (const target of targets) {
        expect(TASK_STATUSES).toContain(target);
        expect(target).not.toBe(from);
      }
    }
    expect(allowedNext('inbox', null)).not.toContain('done');
    expect(allowedNext('planned', null)).not.toContain('in-progress');
    expect(allowedNext('testing', null)).toContain('done');
    expect(allowedNext('done', null)).toEqual(['in-progress']);
  });

  it('a blocked task goes back to where it was, to Planned, or is cancelled', () => {
    expect(allowedNext('blocked', 'in-progress')).toEqual(['in-progress', 'planned', 'cancelled']);
    expect(allowedNext('blocked', null)).toEqual(['planned', 'cancelled']);
    expect(allowedNext('blocked', 'planned')).toEqual(['planned', 'cancelled']);
  });

  it('a finished or cancelled dependency no longer holds a task back; anything else does', () => {
    expect(TASK_STATUSES.filter(satisfiesDependency).sort()).toEqual(['cancelled', 'done']);
  });
});

describe('dependency loops', () => {
  const edges = new Map<string, string[]>([['b', ['a']], ['c', ['b']]]);
  it('detects a task depending on itself, directly and through others', () => {
    expect(wouldCycle(edges, 'x', 'x')).toBe(true);
    expect(wouldCycle(edges, 'a', 'c')).toBe(true); // a waits on c, c waits on b, b waits on a
    expect(wouldCycle(edges, 'a', 'b')).toBe(true);
  });
  it('allows a dependency that does not close a loop', () => {
    expect(wouldCycle(edges, 'c', 'a')).toBe(false);
    expect(wouldCycle(edges, 'x', 'c')).toBe(false);
  });
});

describe('progress', () => {
  it('is done over counted tasks, ignores cancelled ones, and has no percentage when there are no tasks', () => {
    expect(progressOf([])).toEqual({ total: 0, done: 0, inProgress: 0, blocked: 0, percent: null });
    expect(progressOf(['cancelled', 'cancelled']).percent).toBeNull();
    expect(progressOf(['done', 'done', 'ready', 'in-progress', 'blocked', 'cancelled'])).toEqual({ total: 5, done: 2, inProgress: 1, blocked: 1, percent: 40 });
    expect(progressOf(['done']).percent).toBe(100);
  });
});

describe('templates and input rules', () => {
  it('has the nine categories of spec §10, each with acceptance criteria and test requirements to start from', () => {
    expect(TASK_TEMPLATES.map((t) => t.id)).toEqual([...TEMPLATE_IDS]);
    expect(TEMPLATE_IDS).toHaveLength(9);
    for (const template of TASK_TEMPLATES) {
      expect(template.acceptance.length).toBeGreaterThan(0);
      expect(template.testRequirements).not.toBe('');
    }
  });

  it('refuses relevant files that are absolute or leave the project, and unknown fields', () => {
    const base = { projectId: 'p', title: 'T' };
    expect(TaskCreateSchema.safeParse({ ...base, files: ['Source/Player.cpp'] }).success).toBe(true);
    for (const bad of ['C:\\Windows\\win.ini', '/etc/passwd', '..\\x', 'a/../../b', '\\\\server\\share'])
      expect(TaskCreateSchema.safeParse({ ...base, files: [bad] }).success, bad).toBe(false);
    expect(TaskCreateSchema.safeParse({ ...base, cwd: 'C:\\' }).success).toBe(false);
    expect(TaskCreateSchema.safeParse({ ...base, title: '   ' }).success).toBe(false);
  });
});
