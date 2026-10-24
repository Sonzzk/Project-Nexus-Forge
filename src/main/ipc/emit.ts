import type { EventName } from '@shared/ipc/channels';
import type { EventPayloadOf } from '@shared/ipc/events';

export interface EventTarget {
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
}

/** Sends events from main to our own windows only; the renderer subscribes through `window.api.on`. */
export function createEmitter(targets: () => EventTarget[]) {
  return <E extends EventName>(event: E, payload: EventPayloadOf<E>): void => {
    for (const target of targets()) if (!target.isDestroyed()) target.send(event, payload);
  };
}
