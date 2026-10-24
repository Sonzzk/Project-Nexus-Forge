import type { ActivityEvent } from '../activity';
import type { PullProgress } from '../providers';
import type { EventName } from './channels';

// Main sends events to its own window only; payloads are built from shared types.
export interface EventPayloads {
  'activity:appended': ActivityEvent;
  'providers:progress': PullProgress;
}

export type EventPayloadOf<E extends EventName> = EventPayloads[E];
