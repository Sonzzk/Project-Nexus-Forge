import { formatTime } from '../lib/activity';
import { useNav } from './navigation';

/** Contextual details beside the page. For now it shows the activity event the user picked. */
export function Inspector() {
  const { selected } = useNav();
  return (
    <aside className="inspector" aria-label="Inspector">
      <h2>Details</h2>
      {selected === undefined ? (
        <p className="empty">Pick an item, such as an activity entry, to see its details here.</p>
      ) : (
        <dl className="facts">
          <dt>What</dt>
          <dd>{selected.summary}</dd>
          <dt>When</dt>
          <dd>{formatTime(selected.occurredAt)}</dd>
          <dt>Kind</dt>
          <dd className="mono">{selected.kind}</dd>
          <dt>Severity</dt>
          <dd>{selected.severity}</dd>
          {selected.details !== undefined && (
            <>
              <dt>Details</dt>
              <dd className="mono">{JSON.stringify(selected.details, null, 2)}</dd>
            </>
          )}
        </dl>
      )}
    </aside>
  );
}
