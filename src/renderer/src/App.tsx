import { AppShell } from './app/AppShell';
import { NavProvider } from './app/navigation';
import { ProjectsProvider } from './lib/projects';
import { SettingsProvider } from './lib/settings';

export function App() {
  return (
    <SettingsProvider>
      <ProjectsProvider>
        <NavProvider>
          <AppShell />
        </NavProvider>
      </ProjectsProvider>
    </SettingsProvider>
  );
}
