import { afterEach, describe, expect, it } from 'vitest';
import { BACKROOMS_DOMAINS, HORROR_CHECKLIST } from '@shared/backrooms';
import { openMigratedDb } from '../../../test/helpers/db';
import { memoryLogger } from '../../../test/helpers/logger';
import { removeTempDirs } from '../../../test/helpers/temp';
import { copyFixture } from '../../../test/helpers/tree';
import { createActivityLog, createRedactor } from '../logging';
import { createPlanningService } from '../planning';
import { createProjectRegistry } from '../projects';
import { createProfileService } from './profile';

afterEach(removeTempDirs);

async function env(fixture = 'unreal-cpp') {
  const { db } = await openMigratedDb();
  const logger = memoryLogger();
  const activity = createActivityLog({ db, redactor: createRedactor(), logger });
  const projects = createProjectRegistry({ db, activity, logger });
  const project = projects.add(copyFixture(fixture));
  const profiles = createProfileService({ db, projects, activity });
  const planning = createPlanningService({ db, projects, activity });
  return { db, project, profiles, planning, activity };
}

describe('the Backrooms profile', () => {
  it('is off by default, assumes nothing, and lists all seventeen domains and eight checks unconfirmed', async () => {
    const e = await env();
    const view = e.profiles.get(e.project.id);
    expect(view.enabled).toBe(false);
    expect(view.domains).toHaveLength(BACKROOMS_DOMAINS.length);
    expect(view.domains).toHaveLength(17);
    expect(view.domains.every((d) => !d.confirmed && d.hints.length === 0)).toBe(true); // no hints either while it is off
    expect(view.checklist.map((c) => c.id)).toEqual(HORROR_CHECKLIST.map((c) => c.id));
    expect(view.checklist.every((c) => !c.checked)).toBe(true);
    expect(view.flags).toEqual([]);
    expect(view.note).toContain('changes nothing in the project');
  });

  it('shows hints from the project files once on, as hints, and still confirms nothing for you', async () => {
    const e = await env();
    const view = e.profiles.set({ projectId: e.project.id, enabled: true });
    expect(view.enabled).toBe(true);
    expect(view.domains.find((d) => d.id === 'level')?.hints).toEqual(expect.arrayContaining(['Map /Game/Maps/Hall', 'Module Hall']));
    expect(view.domains.find((d) => d.id === 'multiplayer')?.hints).toEqual([]); // OnlineSubsystem is disabled in the fixture, so it is not a hint
    expect(view.domains.every((d) => !d.confirmed)).toBe(true);
    expect(view.note).toContain('No system is confirmed yet');
  });

  it('keeps what was confirmed and ticked across reads, ignores repeats, and says what it did in the activity list', async () => {
    const e = await env();
    e.profiles.set({ projectId: e.project.id, enabled: true, confirmedDomains: ['level', 'audio', 'level'], checked: ['lighting', 'sound'] });
    const view = e.profiles.get(e.project.id);
    expect(view.domains.filter((d) => d.confirmed).map((d) => d.id)).toEqual(['level', 'audio']);
    expect(view.checklist.filter((c) => c.checked).map((c) => c.id)).toEqual(['lighting', 'sound']);
    e.profiles.set({ projectId: e.project.id, checked: ['pacing'] }); // a partial update leaves the rest alone
    expect(e.profiles.get(e.project.id).domains.filter((d) => d.confirmed)).toHaveLength(2);
    expect(e.profiles.get(e.project.id).checklist.filter((c) => c.checked).map((c) => c.id)).toEqual(['pacing']);
    expect(e.activity.list({ kinds: ['profile.toggled', 'profile.domains'], limit: 5 })).toHaveLength(2);
    e.profiles.set({ projectId: e.project.id, enabled: false });
    expect(e.profiles.get(e.project.id).domains.filter((d) => d.confirmed)).toHaveLength(2); // turning it off forgets nothing
  });

  it('flags multiplayer, procedural generation and a large plan only when they were confirmed', async () => {
    const e = await env();
    e.profiles.set({ projectId: e.project.id, enabled: true, confirmedDomains: ['movement', 'camera'] });
    expect(e.profiles.get(e.project.id).flags).toEqual([]);
    const some = e.profiles.set({ projectId: e.project.id, confirmedDomains: ['multiplayer', 'procedural'] });
    expect(some.flags.map((f) => f.id)).toEqual(['multiplayer', 'procedural']);
    expect(some.flags[0]?.detail).toContain('release scope');
    const many = e.profiles.set({ projectId: e.project.id, confirmedDomains: BACKROOMS_DOMAINS.slice(0, 10).map((d) => d.id) });
    expect(many.flags.map((f) => f.id)).toContain('content');
    expect(e.profiles.set({ projectId: e.project.id, enabled: false }).flags).toEqual([]);
  });

  it('counts the milestones of each scope tier so the dream, prototype, slice and release stay apart', async () => {
    const e = await env();
    e.planning.createMilestone({ projectId: e.project.id, title: 'Walk the hall', scopeTier: 'prototype' });
    e.planning.createMilestone({ projectId: e.project.id, title: 'Release', scopeTier: 'release' });
    e.planning.createMilestone({ projectId: e.project.id, title: 'Another prototype', scopeTier: 'prototype' });
    expect(e.profiles.get(e.project.id).tiers).toEqual([{ tier: 'dream', milestones: 0 }, { tier: 'prototype', milestones: 2 }, { tier: 'slice', milestones: 0 }, { tier: 'release', milestones: 1 }]);
  });

  it('works for a project that is not Unreal (no hints, everything else the same) and refuses an unknown project', async () => {
    const e = await env('plain-web');
    expect(e.profiles.set({ projectId: e.project.id, enabled: true }).domains.every((d) => d.hints.length === 0)).toBe(true);
    expect(() => e.profiles.get('missing')).toThrow();
  });
});
