import { LOG_LEVELS } from '@shared/settings';
import { useSettings } from '../../lib/settings';
import { DataSection } from './DataSection';

export function SettingsPage() {
  const { settings, set, error } = useSettings();
  return (
    <div className="page">
      <header className="page__head">
        <h1>Settings</h1>
        <p className="muted">
          More settings arrive with the steps that need them; the full settings screen is Step 24.
        </p>
      </header>
      {error !== undefined && (
        <p role="alert">
          {error.message} {error.hint}
        </p>
      )}
      <div className="field">
        <label htmlFor="setting-density">
          Interface density
          <span className="muted"> · comfortable or compact rows and spacing</span>
        </label>
        <select
          id="setting-density"
          value={settings['ui.density']}
          onChange={(event) =>
            set('ui.density', event.target.value === 'compact' ? 'compact' : 'comfortable')
          }
        >
          <option value="comfortable">Comfortable</option>
          <option value="compact">Compact</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="setting-log-level">
          Log level
          <span className="muted"> · how much the app writes to its log file</span>
        </label>
        <select
          id="setting-log-level"
          value={settings['logging.level']}
          onChange={(event) => {
            const level = LOG_LEVELS.find((candidate) => candidate === event.target.value);
            if (level !== undefined) set('logging.level', level);
          }}
        >
          {LOG_LEVELS.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
      </div>
      <DataSection />
    </div>
  );
}
