import { AppShell } from './app/AppShell';
import { NavProvider } from './app/navigation';
import { SettingsProvider } from './lib/settings';

export function App() {
  return (
    <SettingsProvider>
      <NavProvider>
        <AppShell />
      </NavProvider>
    </SettingsProvider>
  );
}
