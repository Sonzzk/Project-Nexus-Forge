import { createHash } from 'node:crypto';
import { AppError } from '@shared/errors';

export interface Migration {
  version: number;
  name: string;
  sql: string;
  /** SHA-256 of the SQL with line endings normalized, so a Windows checkout hashes the same as a Linux one. */
  checksum: string;
}

// Vite inlines the numbered SQL files at build time, so the packaged app needs no loose files.
const bundled = import.meta.glob('./migrations/*.sql', { query: '?raw', import: 'default', eager: true });

export const checksumOf = (sql: string): string =>
  createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');

/** Builds the ordered migration list from `{ './migrations/0001_name.sql': sql }`. Versions must be 1, 2, 3 ... with no gaps. */
export function loadMigrations(files: Record<string, unknown> = bundled): Migration[] {
  const migrations = Object.entries(files).map(([path, sql]): Migration => {
    const match = /(\d{4})_([a-z0-9_]+)\.sql$/.exec(path);
    if (match?.[1] === undefined || match[2] === undefined || typeof sql !== 'string')
      throw new AppError('INTERNAL', `Migration file ${path} is not named like 0001_name.sql.`);
    return { version: Number(match[1]), name: match[2], sql, checksum: checksumOf(sql) };
  });
  migrations.sort((a, b) => a.version - b.version);
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1)
      throw new AppError(
        'INTERNAL',
        `Migration versions must run 1, 2, 3 ... without gaps or repeats (found ${migration.version} at position ${index + 1}).`,
      );
  });
  return migrations;
}
