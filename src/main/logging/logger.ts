import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { LogLevel } from '@shared/settings';
import type { Redactor } from './redactor';

// One structured log: JSON lines, size-based rotation, everything redacted before it is written
// (ARCHITECTURE.md section 11). main.log becomes main.1.log at maxBytes; maxFiles rotated files are kept.

export interface Logger {
  error(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  debug(msg: string, data?: Record<string, unknown>): void;
  child(module: string): Logger;
  flush(): Promise<void>;
}

export interface LoggerOptions {
  dir: string;
  redactor: Redactor;
  /** Read on every write, so changing the setting takes effect at once. */
  level: () => LogLevel;
  fileName?: string;
  maxBytes?: number;
  maxFiles?: number;
  now?: () => Date;
}

const RANK: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };
export const DEFAULT_LOG_BYTES = 5 * 1024 * 1024;
export const DEFAULT_LOG_FILES = 5;

export function createLogger(options: LoggerOptions): Logger {
  const { dir, redactor, level } = options;
  const base = (options.fileName ?? 'main.log').replace(/\.log$/, '');
  const maxBytes = options.maxBytes ?? DEFAULT_LOG_BYTES;
  const maxFiles = options.maxFiles ?? DEFAULT_LOG_FILES;
  const now = options.now ?? (() => new Date());
  const current = join(dir, `${base}.log`);
  const rotated = (n: number): string => join(dir, `${base}.${n}.log`);

  mkdirSync(dir, { recursive: true });
  let size = existsSync(current) ? statSync(current).size : 0;
  let failureReported = false;

  const rotate = (): void => {
    rmSync(rotated(maxFiles), { force: true });
    for (let n = maxFiles - 1; n >= 1; n--)
      if (existsSync(rotated(n))) renameSync(rotated(n), rotated(n + 1));
    if (existsSync(current)) renameSync(current, rotated(1));
    size = 0;
  };

  const write = (module: string, lvl: LogLevel, msg: string, data?: Record<string, unknown>): void => {
    if (RANK[lvl] > RANK[level()]) return;
    try {
      const entry = {
        t: now().toISOString(),
        lvl,
        mod: module,
        msg: redactor.redact(msg),
        ...(data === undefined ? {} : { data: redactor.redactValue(data) }),
      };
      const line = `${JSON.stringify(entry)}\n`;
      const bytes = Buffer.byteLength(line);
      if (size > 0 && size + bytes > maxBytes) rotate();
      appendFileSync(current, line);
      size += bytes;
    } catch (error) {
      // Logging must never take the app down; say so once on stderr.
      if (!failureReported) {
        failureReported = true;
        console.error('GameDev Command Center could not write its log file:', error);
      }
    }
  };

  const make = (module: string): Logger => ({
    error: (msg, data) => write(module, 'error', msg, data),
    warn: (msg, data) => write(module, 'warn', msg, data),
    info: (msg, data) => write(module, 'info', msg, data),
    debug: (msg, data) => write(module, 'debug', msg, data),
    child: (name) => make(`${module}.${name}`),
    // Writes are synchronous, so there is nothing buffered to wait for.
    flush: () => Promise.resolve(),
  });
  return make('app');
}
