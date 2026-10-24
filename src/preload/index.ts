import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { Api } from '@shared/api';
import { CHANNELS, EVENTS } from '@shared/ipc/channels';

// The whole bridge (ARCHITECTURE.md section 6): `invoke` and `on`, each limited to the names in the shared registry.
// No raw ipcRenderer, no `send`, no Node values cross it. This file imports only `electron` and the channel names,
// so the sandboxed preload stays tiny.

const channels: ReadonlySet<string> = new Set(CHANNELS);
const events: ReadonlySet<string> = new Set(EVENTS);

const invoke = ((channel: string, input: unknown): Promise<unknown> => {
  if (!channels.has(channel)) return Promise.reject(new Error(`Unknown channel: ${channel}`));
  return ipcRenderer.invoke(channel, input);
}) as Api['invoke'];

const on: Api['on'] = (event, listener) => {
  if (!events.has(event)) throw new Error(`Unknown event: ${event}`);
  const wrapped = (_event: IpcRendererEvent, payload: Parameters<typeof listener>[0]): void =>
    listener(payload);
  ipcRenderer.on(event, wrapped);
  return () => void ipcRenderer.removeListener(event, wrapped);
};

contextBridge.exposeInMainWorld('api', Object.freeze({ invoke, on }));
