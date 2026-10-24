import { useCallback, useEffect, useState } from 'react';
import type { SerializedError } from '@shared/errors';
import { USAGE_UNAVAILABLE, type UsageRow, type UsageSummary, type UsageWindow } from '@shared/usage';

// The usage summary and recent rows, reloaded whenever main records a request, a failure or a blocked launch.

export interface UsageApi {
  summary: UsageSummary | undefined;
  rows: UsageRow[];
  error: SerializedError | undefined;
}

export function useUsage(projectId: string | undefined, rowLimit = 0): UsageApi {
  const [state, setState] = useState<UsageApi>({ summary: undefined, rows: [], error: undefined });
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((n) => n + 1), []);

  useEffect(() => window.api.on('activity:appended', (event) => (event.kind.startsWith('provider.') || event.kind.startsWith('usage.')) && reload()), [reload]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      window.api.invoke('usage:summary', projectId === undefined ? {} : { projectId }),
      rowLimit > 0 ? window.api.invoke('usage:list', { limit: rowLimit }) : Promise.resolve({ ok: true as const, value: [] as UsageRow[] }),
    ]).then(([summary, rows]) => {
      if (cancelled) return;
      if (!summary.ok) setState((s) => ({ ...s, error: summary.error }));
      else if (!rows.ok) setState((s) => ({ ...s, error: rows.error }));
      else setState({ summary: summary.value, rows: rows.value, error: undefined });
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, rowLimit, version]);

  return state;
}

const count = (n: number): string => n.toLocaleString('en-US');

/** What a window of the log reports about usage. Missing numbers are said to be unavailable, never shown as zero. */
export function describeUsage(window: UsageWindow): string {
  if (window.launches === 0) return 'Nothing sent yet';
  const parts: string[] = [];
  if (window.inputCount !== null || window.outputCount !== null)
    parts.push(`${window.inputCount === null ? '?' : count(window.inputCount)} in, ${window.outputCount === null ? '?' : count(window.outputCount)} out (tokens, from the ${window.reported} that reported)`);
  if (window.costUsdEstimate !== null) parts.push(`provider estimate $${window.costUsdEstimate.toFixed(4)}`);
  if (parts.length === 0) return USAGE_UNAVAILABLE;
  if (window.unreported > 0) parts.push(`${window.unreported} sent without a report`);
  return parts.join(' · ');
}

/** The usage of one row, for the history table. */
export function describeRow(row: UsageRow): string {
  if (row.status === 'blocked' || row.status === 'running') return '—';
  const parts: string[] = [];
  if (row.inputCount !== null || row.outputCount !== null) parts.push(`${row.inputCount === null ? '?' : count(row.inputCount)} in / ${row.outputCount === null ? '?' : count(row.outputCount)} out`);
  if (row.costUsdEstimate !== null) parts.push(`$${row.costUsdEstimate.toFixed(4)} (estimate)`);
  return parts.length === 0 ? USAGE_UNAVAILABLE : parts.join(' · ');
}

export const limitText = (limit: { limit: number; used: number }): string => (limit.limit === 0 ? `${limit.used} used, no limit` : `${limit.used} of ${limit.limit} used`);
