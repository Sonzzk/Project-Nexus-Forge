import { existsSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/**
 * Finds a program by looking in `extraDirs` first and then on PATH, trying the usual Windows extensions. Returns the first
 * regular file, or undefined. Nothing is run and nothing is downloaded.
 */
export function locateProgram(names: readonly string[], extraDirs: readonly string[] = [], env: NodeJS.ProcessEnv = process.env): string | undefined {
  const extensions = (env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const dirs = [...extraDirs, ...(env['PATH'] ?? env['Path'] ?? '').split(delimiter)].filter((dir) => dir !== '');
  for (const dir of dirs)
    for (const name of names)
      for (const suffix of ['', ...extensions.map((e) => e.toLowerCase())]) {
        const candidate = join(dir, name + suffix);
        try {
          if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
        } catch {
          // unreadable entry: keep looking
        }
      }
  return undefined;
}
