import { ChevronDown, PanelLeft, PanelRight, Search } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { featureById, stateLabel } from '@shared/feature-status';

interface TopBarProps {
  sidebarCollapsed: boolean;
  inspectorOpen: boolean;
  onToggleSidebar: () => void;
  onToggleInspector: () => void;
  onOpenPalette: () => void;
}

const addProject = featureById('action.add-project');

export function TopBar({
  sidebarCollapsed,
  inspectorOpen,
  onToggleSidebar,
  onToggleInspector,
  onOpenPalette,
}: TopBarProps) {
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

      {/* The project switcher is empty until Step 6 registers projects; it says so instead of pretending. */}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button type="button" className="btn" aria-label="Project switcher">
            <span>No project selected</span>
            <ChevronDown size={14} aria-hidden />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="menu" align="start" sideOffset={4}>
            <DropdownMenu.Label className="menu__item faint">No projects registered yet</DropdownMenu.Label>
            <DropdownMenu.Item className="menu__item" disabled>
              <span>{addProject?.label ?? 'Add a project'}</span>
              {addProject !== undefined && <span className="badge">{stateLabel(addProject)}</span>}
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
