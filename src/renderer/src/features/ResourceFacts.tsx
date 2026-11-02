import { useCallback, useEffect, useState } from 'react';
import type { SerializedError } from '@shared/errors';
import type { ResourceReport } from '@shared/resources';
import { formatTime } from '../lib/activity';

const gb = (mib: number | null): string => (mib === null ? 'unknown' : `${(mib / 1024).toFixed(1)} GB`);

/** The last resource check, if there was one, and a button that measures now. Nothing is measured until the person asks or a local run waits. */
export function useResources(): { report: ReportState; check: () => Promise<void>; busy: boolean; error: SerializedError | undefined } {
  const [report, setReport] = useState<ReportState>({ loaded: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<SerializedError | undefined>();
  useEffect(() => {
    let cancelled = false;
    void window.api.invoke('resources:latest', {}).then((result) => {
      if (cancelled) return;
      if (result.ok) setReport({ loaded: true, report: result.value ?? undefined });
      else setError(result.error);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const check = useCallback(async () => {
    setBusy(true);
    const result = await window.api.invoke('resources:check', {});
    setBusy(false);
    if (result.ok) {
      setReport({ loaded: true, report: result.value });
      setError(undefined);
    } else setError(result.error);
  }, []);
  return { report, check, busy, error };
}
type ReportState = { loaded: false } | { loaded: true; report: ResourceReport | undefined };

export function ResourceFacts({ report }: { report: ResourceReport }) {
  const { snapshot, verdict } = report;
  return (
    <div className="stack" aria-label="Resource check">
      <p>
        <span className={verdict.allowed ? 'badge' : 'badge badge--warn'}>{verdict.allowed ? 'A local model may start' : 'Local models wait'}</span> <span className="muted">Checked {formatTime(snapshot.at)}</span>
      </p>
      {[...verdict.blocks, ...verdict.warnings].map((text) => (
        <p key={text} role="note">
          {text}
        </p>
      ))}
      <ul className="muted">
        <li>CPU: {snapshot.cpuPercent === null ? 'unknown' : `${snapshot.cpuPercent}% busy`}</li>
        <li>
          RAM: {gb(snapshot.ramFreeMiB)} free of {gb(snapshot.ramTotalMiB)}
        </li>
        {snapshot.gpus.map((gpu) => (
          <li key={gpu.name}>
            {gpu.name}: {gb(gpu.vramFreeMiB)} VRAM free of {gb(gpu.vramTotalMiB)}
            {gpu.utilPercent === null ? '' : `, ${gpu.utilPercent}% busy`}
          </li>
        ))}
        {snapshot.gpuNote !== '' && <li>GPU: {snapshot.gpuNote}</li>}
        <li>Heavy programs: {snapshot.heavyApps.length === 0 ? (snapshot.appsNote === '' ? 'none running' : snapshot.appsNote) : snapshot.heavyApps.join(', ')}</li>
      </ul>
    </div>
  );
}
