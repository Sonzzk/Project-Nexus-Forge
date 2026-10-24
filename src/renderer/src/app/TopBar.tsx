import { Check, ChevronDown, PanelLeft, PanelRight, Search } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { PROJECT_TYPE_LABELS } from '@shared/projects';
import { useProjects } from '../lib/projects';

interface TopBarProps {
  sidebarCollapsed: boolean;
  inspectorOpen: boolean;
  onToggleSidebar: () => void;
  onToggleInspector: () => void;
  onOpenPalette: () => void;
  onAddProject: () => void;
  onManageProjects: () => void;
}

export function TopBar({
  sidebarCollapsed,
  inspectorOpen,
  onToggleSidebar,
  onToggleInspector,
  onOpenPalette,
  onAddProject,
  onManageProjects,
}: TopBarProps) {
  const { projects, selected, select } = useProjects();
  return (
    <header className="topbar">
      <button
        type="button"
        className="btn btn--icon"
        aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        aria-pressed={sidebarCollapsed}
        onClick={onToggleSidebar}
      >
        <PanelLeft size={16} aria-hidden />
      </button>

      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button type="button" className="btn" aria-label="Project switcher">
            <span>{selected?.name ?? 'No project selected'}</span>
            <ChevronDown size={14} aria-hidden />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="menu" align="start" sideOffset={4}>
            {projects.length === 0 ? (
              <DropdownMenu.Label className="menu__item faint">No projects registered yet</DropdownMenu.Label>
            ) : (
              <DropdownMenu.RadioGroup value={selected?.id ?? ''} onValueChange={select}>
                {projects.map((project) => (
                  <DropdownMenu.RadioItem key={project.id} value={project.id} className="menu__item">
                    <span>
                      {project.name} <span className="faint">· {PROJECT_TYPE_LABELS[project.type]}</span>
                    </span>
                    <DropdownMenu.ItemIndicator>
                      <Check size={14} aria-hidden />
                    </DropdownMenu.ItemIndicator>
                  </DropdownMenu.RadioItem>
                ))}
              </DropdownMenu.RadioGroup>
            )}
            <DropdownMenu.Separator className="menu__separator" />
            <DropdownMenu.Item className="menu__item" onSelect={onAddProject}>
              Add a project…
            </DropdownMenu.Item>
            <DropdownMenu.Item className="menu__item" onSelect={onManageProjects}>
              Manage projects
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <div className="topbar__spacer" />

      <button
        type="button"
        className="btn topbar__search"
        onClick={onOpenPalette}
        aria-label="Open the command palette"
      >
        <span className="row-inline">
          <Search size={14} aria-hidden /> Search commands
        </span>
        <kbd>Ctrl K</kbd>
      </button>

      <button
        type="button"
        className="btn btn--icon"
        aria-label={inspectorOpen ? 'Hide inspector' : 'Show inspector'}
        aria-pressed={inspectorOpen}
        onClick={onToggleInspector}
      >
        <PanelRight size={16} aria-hidden />
      </button>
    </header>
  );
}
