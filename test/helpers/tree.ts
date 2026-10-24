import { createHash } from 'node:crypto';
import { cpSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { makeTempDir } from './temp';

/** Copies a fixture project into a fresh temp folder, so a test can never touch the fixture itself. */
export function copyFixture(name: string): string {
  const target = join(makeTempDir(), name);
  cpSync(join('test', 'fixtures', 'projects', name), target, { recursive: true });
  return target;
}

/** Every file and folder under `dir` with its size, modification time and content hash, for "nothing changed" checks. */
export function snapshotTree(dir: string): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      const key = relative(dir, full).replace(/\\/g, '/');
      const stats = statSync(full);
      if (entry.isDirectory()) {
        result[`${key}/`] = `dir mtime=${stats.mtimeMs}`;
        visit(full);
      } else {
        result[key] =
          `${stats.size} mtime=${stats.mtimeMs} sha=${createHash('sha256').update(readFileSync(full)).digest('hex')}`;
      }
    }
  };
  visit(dir);
  return result;
}
