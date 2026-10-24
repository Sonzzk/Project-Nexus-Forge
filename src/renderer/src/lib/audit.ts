import { useCallback, useEffect, useState } from 'react';
import type { AuditReport, AuditSummary } from '@shared/audit';
import type { SerializedError } from '@shared/errors';

// The audit of one project: the newest stored report, the earlier ones, and running a new one. Reports are produced and
// stored by main; the page only asks.

export interface AuditApi {
  report: AuditReport | null | undefined;
  history: AuditSummary[];
  running: boolean;
  error: SerializedError | undefined;
  run: () => Promise<void>;
  open: (auditId: string) => Promise<void>;
  /** Shows a project file in Explorer; main checks the path is inside the project. */
  reveal: (relativePath: string) => Promise<void>;
}

export function useAudit(projectId: string): AuditApi {
  const [report, setReport] = useState<AuditReport | null | undefined>(undefined);
  const [history, setHistory] = useState<AuditSummary[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<SerializedError | undefined>();

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      window.api.invoke('audit:latest', { projectId }),
      window.api.invoke('audit:list', { projectId }),
    ]).then(([latest, list]) => {
      if (cancelled) return;
      if (latest.ok) setReport(latest.value);
      else {
        setReport(null);
        setError(latest.error);
      }
      if (list.ok) setHistory(list.value);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const run = useCallback(async (): Promise<void> => {
    setRunning(true);
    setError(undefined);
    const result = await window.api.invoke('audit:run', { projectId });
    setRunning(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setReport(result.value);
    const list = await window.api.invoke('audit:list', { projectId });
    if (list.ok) setHistory(list.value);
  }, [projectId]);

  const open = useCallback(
    async (auditId: string): Promise<void> => {
      const result = await window.api.invoke('audit:get', { projectId, auditId });
      if (result.ok) setReport(result.value);
      else setError(result.error);
    },
    [projectId],
  );

  const reveal = useCallback(
    async (relativePath: string): Promise<void> => {
      const result = await window.api.invoke('audit:reveal', { projectId, relativePath });
      setError(result.ok ? undefined : result.error);
    },
    [projectId],
  );

  return { report, history, running, error, run, open, reveal };
}
