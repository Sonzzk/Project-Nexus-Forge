import type { Api } from './api';

declare global {
  interface Window {
    /** Exposed by the preload script; the only way the renderer talks to the main process. */
    api: Api;
  }
}
