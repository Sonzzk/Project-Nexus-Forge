// The feature-status manifest (ARCHITECTURE.md section 9). The UI never hard-codes availability: every navigation item,
// palette action and dashboard card reads its state from here. Each feature step updates its entries in the same commit.

export type NavSection =
  | 'dashboard'
  | 'projects'
  | 'workbench'
  | 'tasks'
  | 'context'
  | 'git'
  | 'testing'
  | 'assets'
  | 'integrations'
  | 'activity'
  | 'settings'
  | 'status';

/** `available`: works now. `requires-setup`: built, but a tool or permission is missing. `upcoming`: not built. `experimental-off`: built behind a flag that is off. */
export type FeatureState = 'available' | 'requires-setup' | 'upcoming' | 'experimental-off';

export interface FeatureStatus {
  /** `nav.*` for sidebar items, `action.*` for palette actions, `card.*` for dashboard cards. */
  id: string;
  kind: 'navigation' | 'action' | 'card';
  label: string;
  section: NavSection;
  state: FeatureState;
  /** The roadmap step that builds or finishes it. */
  step: number;
  note?: string;
}

const nav = (
  section: NavSection,
  label: string,
  state: FeatureState,
  step: number,
  note?: string,
): FeatureStatus => ({
  id: `nav.${section}`,
  kind: 'navigation',
  label,
  section,
  state,
  step,
  ...(note === undefined ? {} : { note }),
});

export const FEATURES: readonly FeatureStatus[] = [
  // Sidebar, in the order of spec §5.
  nav('dashboard', 'Dashboard', 'available', 5),
  nav('projects', 'Projects', 'available', 6),
  nav('workbench', 'AI Workbench', 'available', 13, 'Run queue, routing and the local-inference policy; read-only runs until Step 15, the live session view in Step 17.'),
  nav('tasks', 'Tasks and Roadmap', 'available', 10, 'Board, list and milestone roadmap, with agent runs queued from each task.'),
  nav('context', 'Project Context', 'available', 9, 'Project memory, context packs and session handoffs.'),
  nav('git', 'Git and Changes', 'available', 7, 'Read-only status and recent commits; diff review and revert arrive in Step 16.'),
  nav('testing', 'Testing', 'upcoming', 23),
  nav('assets', 'Assets', 'upcoming', 22),
  nav('integrations', 'Integrations', 'available', 12, 'Ollama, Claude Code and Codex CLI as detected now, with the usage log and launch limits.'),
  nav(
    'activity',
    'Activity and Logs',
    'available',
    5,
    'Shows the activity history; the log viewer and diagnostics bundle arrive in Step 17.',
  ),
  nav(
    'settings',
    'Settings',
    'available',
    5,
    'Density, log level, and data and backups now; the full settings arrive in Step 24.',
  ),
  nav('status', 'Implementation Status', 'available', 5),

  // Palette actions.
  {
    id: 'action.toggle-sidebar',
    kind: 'action',
    label: 'Collapse or expand the sidebar',
    section: 'dashboard',
    state: 'available',
    step: 5,
  },
  {
    id: 'action.toggle-inspector',
    kind: 'action',
    label: 'Show or hide the inspector',
    section: 'dashboard',
    state: 'available',
    step: 5,
  },
  {
    id: 'action.toggle-density',
    kind: 'action',
    label: 'Switch between comfortable and compact density',
    section: 'settings',
    state: 'available',
    step: 5,
  },
  {
    id: 'action.add-project',
    kind: 'action',
    label: 'Add a project',
    section: 'projects',
    state: 'available',
    step: 6,
  },
  {
    id: 'action.new-task',
    kind: 'action',
    label: 'Create a task',
    section: 'tasks',
    state: 'available',
    step: 10,
  },
  {
    id: 'action.run-agent',
    kind: 'action',
    label: 'Run an agent',
    section: 'workbench',
    state: 'available',
    step: 13,
    note: 'Opens the AI Workbench; runs are queued from a task.',
  },
  {
    id: 'action.write-run',
    kind: 'action',
    label: 'Run an agent that changes project files',
    section: 'workbench',
    state: 'upcoming',
    step: 15,
  },

  // Dashboard cards (spec §5 and §20). Later steps flip these to available as they land.
  {
    id: 'card.recent-activity',
    kind: 'card',
    label: 'Recent activity',
    section: 'dashboard',
    state: 'available',
    step: 5,
  },
  { id: 'card.projects', kind: 'card', label: 'Projects', section: 'projects', state: 'available', step: 6 },
  { id: 'card.providers', kind: 'card', label: 'Provider connectivity', section: 'integrations', state: 'available', step: 12 },
  { id: 'card.portfolio', kind: 'card', label: 'Portfolio', section: 'tasks', state: 'available', step: 10 },
  {
    id: 'card.current-task',
    kind: 'card',
    label: 'Current task and milestone',
    section: 'tasks',
    state: 'available',
    step: 10,
  },
  {
    id: 'card.agent-sessions',
    kind: 'card',
    label: 'Active agent sessions',
    section: 'workbench',
    state: 'available',
    step: 13,
    note: 'Running and waiting runs from the queue; the live session view arrives in Step 17.',
  },
  {
    id: 'card.usage',
    kind: 'card',
    label: 'Usage and limits',
    section: 'integrations',
    state: 'available',
    step: 14,
    note: 'What was sent today and against which launch limits; usage numbers only where a provider returned them.',
  },
  { id: 'card.git', kind: 'card', label: 'Recent changes', section: 'git', state: 'available', step: 7 },
  { id: 'card.tests', kind: 'card', label: 'Test status', section: 'testing', state: 'upcoming', step: 23 },
  {
    id: 'card.handoff',
    kind: 'card',
    label: 'Latest session handoff',
    section: 'context',
    state: 'available',
    step: 9,
  },
  {
    id: 'card.next-action',
    kind: 'card',
    label: 'Next recommended action',
    section: 'tasks',
    state: 'available',
    step: 10,
  },
];

export const featureById = (id: string): FeatureStatus | undefined =>
  FEATURES.find((feature) => feature.id === id);

export const isUsable = (feature: FeatureStatus): boolean =>
  feature.state === 'available' || feature.state === 'requires-setup';

/** "Upcoming · Step 6" and similar, for anything that is not usable yet. */
export const stateLabel = (feature: FeatureStatus): string | undefined => {
  if (feature.state === 'upcoming') return `Upcoming · Step ${feature.step}`;
  if (feature.state === 'experimental-off') return 'Experimental · off';
  if (feature.state === 'requires-setup') return 'Needs setup';
  return undefined;
};
