import { useEffect, useMemo, useState, type ComponentType } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import type { NavSection } from '@shared/feature-status';
import { ActivityPage } from '../features/activity/ActivityPage';
import { Dashboard } from '../features/dashboard/Dashboard';
import { SettingsPage } from '../features/settings/SettingsPage';
import { StatusPage } from '../features/status/StatusPage';
import { UpcomingPage } from '../features/UpcomingPage';
import { useSettings } from '../lib/settings';
import { createActionHandlers } from './actions';
import { CommandPalette } from './CommandPalette';
import { Inspector } from './Inspector';
import { useNav } from './navigation';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';

const PAGES: Partial<Record<NavSection, ComponentType>> = {
  dashboard: Dashboard,
  activity: ActivityPage,
  settings: SettingsPage,
  status: StatusPage,
};

export function AppShell() {
  const { settings, set } = useSettings();
  const { section, go } = useNav();
  const [paletteOpen, setPaletteOpen] = useState(false);

  const collapsed = settings['ui.sidebarCollapsed'];
  const inspectorOpen = settings['ui.inspectorOpen'];
  const density = settings['ui.density'];

  useEffect(() => {
    document.documentElement.dataset['density'] = density;
  }, [density]);

  const handlers = useMemo(
    () =>
      createActionHandlers({
        go,
        toggleSidebar: () => set('ui.sidebarCollapsed', !collapsed),
        toggleInspector: () => set('ui.inspectorOpen', !inspectorOpen),
        toggleDensity: () => set('ui.density', density === 'compact' ? 'comfortable' : 'compact'),
      }),
    [go, set, collapsed, inspectorOpen, density],
  );

  // Ctrl+K opens the palette, Ctrl+B the sidebar, Ctrl+J the inspector (Cmd on macOS keyboards works too).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      const key = event.key.toLowerCase();
      if (key === 'k') setPaletteOpen((open) => !open);
      else if (key === 'b') handlers['action.toggle-sidebar']?.();
      else if (key === 'j') handlers['action.toggle-inspector']?.();
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handlers]);

  const Page = PAGES[section];
  const page = Page === undefined ? <UpcomingPage section={section} /> : <Page />;

  return (
    <div className="app" data-sidebar={collapsed ? 'collapsed' : 'expanded'}>
      <Sidebar collapsed={collapsed} current={section} onNavigate={go} />
      <TopBar
        sidebarCollapsed={collapsed}
        inspectorOpen={inspectorOpen}
        onToggleSidebar={() => handlers['action.toggle-sidebar']?.()}
        onToggleInspector={() => handlers['action.toggle-inspector']?.()}
        onOpenPalette={() => setPaletteOpen(true)}
      />
      <main className="workspace">
        {inspectorOpen ? (
          // Remounted when the inspector appears so the saved sizes apply; sizes are saved only after the user drags.
          <Group
            key="with-inspector"
            id="workspace"
            orientation="horizontal"
            defaultLayout={Object.keys(settings['ui.layout']).length > 0 ? settings['ui.layout'] : undefined}
            onLayoutChanged={(layout, meta) => {
              if (meta.isUserInteraction) set('ui.layout', layout);
            }}
          >
            <Panel id="main" defaultSize="72%" minSize="35%">
              {page}
            </Panel>
            <Separator className="resize-handle" aria-label="Resize inspector" />
            <Panel id="inspector" defaultSize="28%" minSize="16%" maxSize="55%">
              <Inspector />
            </Panel>
          </Group>
        ) : (
          page
        )}
      </main>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} handlers={handlers} />
    </div>
  );
}
