import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { SerializedError } from '@shared/errors';
import type { SettingKey, Settings } from '@shared/settings';

// Settings live in the main process; this keeps a copy for the UI and writes changes through `settings:set`.

interface SettingsApi {
  settings: Settings;
  /** Applies at once and saves; if main refuses the value, the old one comes back and `error` says why. */
  set: <K extends SettingKey>(key: K, value: Settings[K]) => void;
  error: SerializedError | undefined;
}

const SettingsContext = createContext<SettingsApi | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings | undefined>();
  const [error, setError] = useState<SerializedError | undefined>();

  useEffect(() => {
    let cancelled = false;
    void window.api.invoke('settings:get', {}).then((result) => {
      if (cancelled) return;
      if (result.ok) setSettings(result.value);
      else setError(result.error);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const set = useCallback<SettingsApi['set']>((key, value) => {
    setSettings((current) => (current === undefined ? current : { ...current, [key]: value }));
    void window.api.invoke('settings:set', { key, value }).then((result) => {
      if (result.ok) {
        setError(undefined);
        setSettings(result.value);
      } else {
        setError(result.error);
        void window.api.invoke('settings:get', {}).then((fresh) => fresh.ok && setSettings(fresh.value));
      }
    });
  }, []);

  const api = useMemo(
    () => (settings === undefined ? null : { settings, set, error }),
    [settings, set, error],
  );
  if (api === null) {
    return error === undefined ? null : (
      <p role="alert" className="page">
        {error.message} {error.hint}
      </p>
    );
  }
  return <SettingsContext.Provider value={api}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsApi {
  const value = useContext(SettingsContext);
  if (value === null) throw new Error('useSettings must be used inside SettingsProvider.');
  return value;
}
