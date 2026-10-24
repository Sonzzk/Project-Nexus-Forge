import { useCallback, useEffect, useState } from 'react';
import type { QueueView } from '@shared/agents';
import type { IpcResult, SerializedError } from '@shared/errors';

// The run queue of one project, reloaded whenever main records something about a run (every start, hold, end and lock change
// is an `agent.*` activity event), so the page follows what really happened without polling.

export interface QueueApi {
  view: QueueView | undefined;
  error: SerializedError | undefined;
  /** Runs one call, shows its error if it fails, and reloads the queue if it works. */
  call: <T>(run: () => Promise<IpcResult<T>>) => Promise<T | undefined>;
  reload: () => void;
}

export function useQueue(projectId: string | undefined): QueueApi {
  const [view, setView] = useState<QueueView | undefined>();
  const [error, setError] = useState<SerializedError | undefined>();
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((n) => n + 1), []);

  useEffect(() => window.api.on('activity:appended', (event) => event.kind.startsWith('agent.') && reload()), [reload]);

  useEffect(() => {
    if (projectId === undefined) return;
    let cancelled = false;
    void window.api.invoke('queue:view', { projectId }).then((result) => {
      if (cancelled) return;
      if (result.ok) setView(result.value);
      else setError(result.error);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, version]);

  const call = useCallback(
    async <T,>(run: () => Promise<IpcResult<T>>): Promise<T | undefined> => {
      const result = await run();
      if (!result.ok) {
        setError(result.error);
        return undefined;
      }
      setError(undefined);
      reload();
      return result.value;
    },
    [reload],
  );

  return { view, error, call, reload };
}
