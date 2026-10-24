import type { ActivityEvent } from '../activity';
import type { EventName } from './channels';

// Main sends events to its own window only; payloads are built from shared types.
export interface EventPayloads {
  'activity:appended': ActivityEvent;
}

export type EventPayloadOf<E extends EventName> = EventPayloads[E];
