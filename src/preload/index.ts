import { contextBridge } from 'electron';
import type { Api } from '@shared/api';

// Empty on purpose until Step 4 adds the allowlisted `invoke` and `on` (ARCHITECTURE.md section 6).
const api: Api = Object.freeze({});

contextBridge.exposeInMainWorld('api', api);
