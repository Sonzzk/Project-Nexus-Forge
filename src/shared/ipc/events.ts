import type { ActivityEvent } from '../activity';
import type { PullProgress } from '../providers';
import type { EventName } from './channels';

// Main sends events to its own window only; payloads are built from shared types.
export interface EventPayloads {
  'activity:appended': ActivityEvent;
  'providers:progress': PullProgress;
  /** The answer of a running agent so far, with secrets removed (Step 17). */
  'sessions:output': { runId: string; text: string };
}

export type EventPayloadOf<E extends EventName> = EventPayloads[E];
