import { useCallback, useEffect, useState } from 'react';
import type { IpcResult, SerializedError } from '@shared/errors';
import type { ExportResult, ImportConflictMode, ImportPreview, ImportResult, StorageStatus } from '@shared/storage';

// Backups, export and import of the app's own data. Main chooses every file in a native dialog and confirms anything that
// overwrites data; this hook only asks.

export interface StorageApi {
  status: StorageStatus | undefined;
  error: SerializedError | undefined;
  busy: boolean;
  backupNow: () => Promise<void>;
  /** Resolves true when main staged the restore (the app is restarting). */
  restore: (backupId: string) => Promise<boolean>;
  exportData: () => Promise<ExportResult | undefined>;
  previewImport: () => Promise<ImportPreview | undefined>;
  applyImport: (conflict: ImportConflictMode) => Promise<ImportResult | undefined>;
}

export function useStorage(): StorageApi {
  const [status, setStatus] = useState<StorageStatus | undefined>();
  const [error, setError] = useState<SerializedError | undefined>();
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    const result = await window.api.invoke('storage:status', {});
    if (result.ok) setStatus(result.value);
    else setError(result.error);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void window.api.invoke('storage:status', {}).then((result) => {
      if (cancelled) return;
      if (result.ok) setStatus(result.value);
      else setError(result.error);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const run = useCallback(
    async <T,>(call: () => Promise<IpcResult<T>>, after?: () => Promise<void>): Promise<T | undefined> => {
      setBusy(true);
      setError(undefined);
      const result = await call();
      setBusy(false);
      if (!result.ok) {
        setError(result.error);
        return undefined;
      }
      if (after !== undefined) await after();
      return result.value;
    },
    [],
  );

  return {
    status,
    error,
    busy,
    backupNow: async () => {
      await run(() => window.api.invoke('storage:backupNow', {}), refresh);
    },
    restore: async (backupId) => (await run(() => window.api.invoke('storage:restore', { backupId }), refresh))?.staged === true,
    exportData: () => run(() => window.api.invoke('storage:exportData', {})),
    previewImport: () => run(() => window.api.invoke('storage:previewImport', {})),
    applyImport: (conflict) => run(() => window.api.invoke('storage:applyImport', { conflict }), refresh),
  };
}
