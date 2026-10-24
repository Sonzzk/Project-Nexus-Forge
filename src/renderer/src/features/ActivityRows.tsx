import type { ActivityEvent } from '@shared/activity';
import { formatTime } from '../lib/activity';

interface ActivityRowsProps {
  events: ActivityEvent[];
  selectedId: string | undefined;
  onSelect: (event: ActivityEvent) => void;
}

/** One line per event; picking one shows its details in the inspector. */
export function ActivityRows({ events, selectedId, onSelect }: ActivityRowsProps) {
  return (
    <ul className="rows">
      {events.map((event) => (
        <li key={event.id}>
          <button
            type="button"
            className="row"
            aria-pressed={event.id === selectedId}
            onClick={() => onSelect(event)}
          >
            <span className="dot" data-severity={event.severity} title={event.severity} />
            <span className="muted">{formatTime(event.occurredAt)}</span>
            <span className="row__summary">{event.summary}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
