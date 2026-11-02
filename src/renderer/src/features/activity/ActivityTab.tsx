import { useCallback, useEffect, useState } from 'react';
import { ACTIVITY_SEVERITIES, type ActivityEvent, type ActivitySeverity } from '@shared/activity';
import type { SerializedError } from '@shared/errors';
import { useNav } from '../../app/navigation';
import { useProjects } from '../../lib/projects';
import { ActivityRows } from '../ActivityRows';

const RANGES = { all: 'All time', hour: 'Last hour', day: 'Last day', week: 'Last 7 days' } as const;
type Range = keyof typeof RANGES;
const SINCE_MS: Record<Exclude<Range, 'all'>, number> = { hour: 3600_000, day: 24 * 3600_000, week: 7 * 24 * 3600_000 };

/** The history of what the app did, with filters, search and a redacted export (spec §15, §27.8). */
export function ActivityTab() {
  const { selected: event, select } = useNav();
  const { selected: project } = useProjects();
  const [severities, setSeverities] = useState<ActivitySeverity[]>([]);
  const [search, setSearch] = useState('');
  const [range, setRange] = useState<Range>('all');
  const [onlyProject, setOnlyProject] = useState(false);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [error, setError] = useState<SerializedError | undefined>();
  const [message, setMessage] = useState('');
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((n) => n + 1), []);

  useEffect(() => window.api.on('activity:appended', reload), [reload]);

  const filter = {
    ...(severities.length > 0 ? { severities } : {}),
    ...(search.trim() === '' ? {} : { search: search.trim() }),
    ...(onlyProject && project !== undefined ? { projectId: project.id } : {}),
  };
  const filterKey = JSON.stringify(filter);

  useEffect(() => {
    let cancelled = false;
    const since = range === 'all' ? {} : { since: new Date(Date.now() - SINCE_MS[range]).toISOString() };
    void window.api.invoke('activity:list', { ...(JSON.parse(filterKey) as object), ...since, limit: 200 }).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setEvents(result.value);
        setError(undefined);
      } else setError(result.error);
    });
    return () => {
      cancelled = true;
    };
  }, [filterKey, range, version]);

  const exportAs = (format: 'json' | 'csv'): void => {
    const since = range === 'all' ? {} : { since: new Date(Date.now() - SINCE_MS[range]).toISOString() };
    void window.api.invoke('activity:export', { format, ...(JSON.parse(filterKey) as object), ...since }).then((result) => {
      if (!result.ok) setError(result.error);
      else setMessage(result.value.saved ? `Saved ${result.value.count.toLocaleString('en-US')} entries. Secrets and your user folder name were removed.` : 'Nothing was saved.');
    });
  };
  const toggle = (severity: ActivitySeverity): void => setSeverities((current) => (current.includes(severity) ? current.filter((s) => s !== severity) : [...current, severity]));

  return (
    <div className="stack">
      <div className="field" role="group" aria-label="Filters">
        {ACTIVITY_SEVERITIES.map((severity) => (
          <label key={severity}>
            <input type="checkbox" checked={severities.includes(severity)} onChange={() => toggle(severity)} /> {severity}
          </label>
        ))}
        <label htmlFor="activity-search">Search</label>
        <input id="activity-search" type="search" value={search} placeholder="text or kind, for example agent." onChange={(event_) => setSearch(event_.target.value)} />
        <label htmlFor="activity-range">When</label>
        <select id="activity-range" value={range} onChange={(event_) => setRange((Object.keys(RANGES) as Range[]).find((r) => r === event_.target.value) ?? 'all')}>
          {(Object.keys(RANGES) as Range[]).map((r) => (
            <option key={r} value={r}>
              {RANGES[r]}
            </option>
          ))}
        </select>
        {project !== undefined && (
          <label>
            <input type="checkbox" checked={onlyProject} onChange={(event_) => setOnlyProject(event_.target.checked)} /> Only {project.name}
          </label>
        )}
      </div>
      <div className="actions">
        <button type="button" className="btn" onClick={() => exportAs('json')}>
          Export as JSON…
        </button>
        <button type="button" className="btn" onClick={() => exportAs('csv')}>
          Export as CSV…
        </button>
        <span className="muted">{events.length} shown (newest first, at most 200). Exports use the same filters and are saved where you choose.</span>
      </div>
      {message !== '' && <p role="status">{message}</p>}
      {error !== undefined && (
        <p role="alert">
          {error.message} {error.hint}
        </p>
      )}
      {events.length === 0 && error === undefined && <p className="empty">{filterKey === '{}' && range === 'all' ? 'Nothing has happened yet.' : 'Nothing matches these filters.'}</p>}
      <ActivityRows events={events} selectedId={event?.id} onSelect={select} />
    </div>
  );
}
