import type { Logger } from '../../src/main/logging/logger';

export interface MemoryLogEntry {
  lvl: 'error' | 'warn' | 'info' | 'debug';
  mod: string;
  msg: string;
  data?: Record<string, unknown> | undefined;
}

/** A logger that keeps its entries in memory, for tests that check what was logged. */
export function memoryLogger(
  entries: MemoryLogEntry[] = [],
  module = 'test',
): Logger & { entries: MemoryLogEntry[] } {
  const add =
    (lvl: MemoryLogEntry['lvl']) =>
    (msg: string, data?: Record<string, unknown>): void => {
      entries.push({ lvl, mod: module, msg, data });
    };
  return {
    entries,
    error: add('error'),
    warn: add('warn'),
    info: add('info'),
    debug: add('debug'),
    child: (name) => memoryLogger(entries, `${module}.${name}`),
    flush: () => Promise.resolve(),
  };
}
