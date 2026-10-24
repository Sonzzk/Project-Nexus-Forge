import { describe, expect, it } from 'vitest';
import { FEATURES, isUsable, stateLabel, type NavSection } from './feature-status';
import { COMPLETED_THROUGH_STEP, ROADMAP_STEPS } from './roadmap-steps';

const SECTIONS: NavSection[] = [
  'dashboard',
  'projects',
  'workbench',
  'tasks',
  'context',
  'git',
  'testing',
  'assets',
  'integrations',
  'activity',
  'settings',
  'status',
];

describe('feature-status manifest', () => {
  it('has unique ids that start with their kind', () => {
    const ids = FEATURES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const feature of FEATURES)
      expect(
        feature.id.startsWith({ navigation: 'nav.', action: 'action.', card: 'card.' }[feature.kind]),
      ).toBe(true);
  });

  it('lists the eleven sections of spec §5 in order, plus Implementation Status', () => {
    const nav = FEATURES.filter((f) => f.kind === 'navigation');
    expect(nav.map((f) => f.section)).toEqual(SECTIONS);
    expect(nav.map((f) => f.label).slice(0, 11)).toEqual([
      'Dashboard',
      'Projects',
      'AI Workbench',
      'Tasks and Roadmap',
      'Project Context',
      'Git and Changes',
      'Testing',
      'Assets',
      'Integrations',
      'Activity and Logs',
      'Settings',
    ]);
  });

  it('only calls something available if its step is done, and only calls something upcoming if its step is not', () => {
    for (const feature of FEATURES) {
      expect(feature.step).toBeGreaterThanOrEqual(1);
      expect(feature.step).toBeLessThanOrEqual(ROADMAP_STEPS.length);
      if (feature.state === 'available')
        expect(feature.step, feature.id).toBeLessThanOrEqual(COMPLETED_THROUGH_STEP);
      if (feature.state === 'upcoming')
        expect(feature.step, feature.id).toBeGreaterThan(COMPLETED_THROUGH_STEP);
    }
  });

  it('labels everything that is not usable with its step', () => {
    for (const feature of FEATURES) {
      if (isUsable(feature))
        expect(stateLabel(feature) === undefined || feature.state === 'requires-setup').toBe(true);
      else expect(stateLabel(feature), feature.id).toBeDefined();
    }
    expect(
      stateLabel({
        id: 'nav.projects',
        kind: 'navigation',
        label: 'Projects',
        section: 'projects',
        state: 'upcoming',
        step: 6,
      }),
    ).toBe('Upcoming · Step 6');
  });
});
