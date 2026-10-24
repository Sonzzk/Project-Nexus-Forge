import type { IpcResult } from './errors';
import type { ChannelName, EventName } from './ipc/channels';
import type { RequestOf, ResponseOf } from './ipc/contract';
import type { EventPayloadOf } from './ipc/events';

/**
 * The object the preload script exposes as `window.api`: two functions and nothing else. Anything more
 * (a raw `ipcRenderer`, `send`, `sendSync`, Node values) needs an ADR (ARCHITECTURE.md section 6).
 */
export interface Api {
  /** Calls an allowlisted channel. Rejects only for an unknown channel; every other failure is `{ ok: false }`. */
  invoke<C extends ChannelName>(channel: C, input: RequestOf<C>): Promise<IpcResult<ResponseOf<C>>>;
  /** Subscribes to an allowlisted event from main and returns the unsubscribe function. */
  on<E extends EventName>(event: E, listener: (payload: EventPayloadOf<E>) => void): () => void;
}
