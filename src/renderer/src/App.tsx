import { useEffect, useState } from 'react';
import type { SerializedError } from '@shared/errors';
import type { AppInfo } from '@shared/ipc/contract';

type InfoState =
  { status: 'loading' } | { status: 'ready'; info: AppInfo } | { status: 'failed'; error: SerializedError };

export function App() {
  const [state, setState] = useState<InfoState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void window.api.invoke('app:getInfo', {}).then((result) => {
      if (!cancelled)
        setState(
          result.ok ? { status: 'ready', info: result.value } : { status: 'failed', error: result.error },
        );
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="shell">
      <h1>GameDev Command Center</h1>
      <p>
        The application shell is in place. Features arrive one roadmap step at a time; the dashboard, project
        list and the rest are not built yet.
      </p>
      {state.status === 'ready' && (
        <dl className="facts">
          <dt>Version</dt>
          <dd>{state.info.version}</dd>
          <dt>Database</dt>
          <dd>schema v{state.info.schemaVersion}</dd>
          <dt>Data folder</dt>
          <dd>{state.info.dataDir}</dd>
          <dt>Log file</dt>
          <dd>{state.info.logFile}</dd>
        </dl>
      )}
      {state.status === 'failed' && (
        <p role="alert">
          {state.error.message} {state.error.hint}
        </p>
      )}
    </main>
  );
}
