import { FEATURES, type NavSection } from '@shared/feature-status';

export interface ActionContext {
  go: (section: NavSection) => void;
  toggleSidebar: () => void;
  toggleInspector: () => void;
  toggleDensity: () => void;
  addProject: () => void;
}

/**
 * What each manifest entry does when chosen. A test walks the manifest and fails if a usable navigation item or
 * action has no handler here, so nothing can be shown as working without being wired.
 */
export function createActionHandlers(context: ActionContext): Record<string, () => void> {
  const handlers: Record<string, () => void> = {
    'action.toggle-sidebar': context.toggleSidebar,
    'action.toggle-inspector': context.toggleInspector,
    'action.toggle-density': context.toggleDensity,
    'action.add-project': context.addProject,
    'action.new-task': () => context.go('tasks'),
    'action.run-agent': () => context.go('workbench'),
  };
  // Every sidebar item navigates, including upcoming ones, whose page says which step builds them.
  for (const feature of FEATURES)
    if (feature.kind === 'navigation') handlers[feature.id] = () => context.go(feature.section);
  return handlers;
}
