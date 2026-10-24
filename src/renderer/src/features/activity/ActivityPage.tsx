import { useNav } from '../../app/navigation';
import { useActivity } from '../../lib/activity';
import { ActivityRows } from '../ActivityRows';

export function ActivityPage() {
  const { events, loading, error } = useActivity(200);
  const { selected, select } = useNav();
  return (
    <div className="page">
      <header className="page__head">
        <h1>Activity and Logs</h1>
        <p className="muted">
          The history of what the app did, newest first. Pick an entry to see its details.
        </p>
      </header>
      {error !== undefined && (
        <p role="alert">
          {error.message} {error.hint}
        </p>
      )}
      {loading && error === undefined && <p className="empty">Loading…</p>}
      {!loading && events.length === 0 && error === undefined && (
        <p className="empty">Nothing has happened yet.</p>
      )}
      <ActivityRows events={events} selectedId={selected?.id} onSelect={select} />
    </div>
  );
}
