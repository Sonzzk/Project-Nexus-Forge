// Names only, so the sandboxed preload stays tiny and imports no schema code (ARCHITECTURE.md section 6).
// Names are `<area>:<verb>`. Every step adds its own channels here and a schema for each in contract.ts.

export const CHANNELS = [
  'app:getInfo',
  'app:reportRendererError',
  'settings:get',
  'settings:set',
  'activity:list',
  'projects:list',
  'projects:pickAndAdd',
  'projects:update',
  'projects:redetect',
  'projects:remove',
  'audit:run',
  'audit:latest',
  'audit:list',
  'audit:get',
  'audit:reveal',
  'git:summary',
  'storage:status',
  'storage:backupNow',
  'storage:restore',
  'storage:exportData',
  'storage:previewImport',
  'storage:applyImport',
] as const;

export const EVENTS = ['activity:appended'] as const;

export type ChannelName = (typeof CHANNELS)[number];
export type EventName = (typeof EVENTS)[number];
