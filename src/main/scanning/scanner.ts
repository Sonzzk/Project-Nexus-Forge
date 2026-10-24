import { readdirSync, lstatSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { ScanStats } from '@shared/audit';
import { isSensitivePath } from '../security';

// The bounded, read-only scanner (spec §7, §14). It stays inside the registered folder, skips heavy and generated
// folders, never follows links, never reads sensitive files, and never opens a file at all: it only lists names and sizes.
// File-count, depth and time budgets stop it early, and the report says so.

export interface ScanFile {
  /** Project-relative, with forward slashes. */
  path: string;
  /** Lower-case, with the dot, or an empty string. */
  ext: string;
  size: number;
  /** Last modification time in milliseconds, for telling when a saved selection of files is out of date. */
  mtimeMs: number;
}

export interface ScanResult {
  files: ScanFile[];
  /** Project-relative paths of sensitive files that were skipped (names only, capped). */
  sensitivePaths: string[];
  stats: ScanStats;
}

export interface ScanOptions {
  maxFiles?: number;
  maxDepth?: number;
  budgetMs?: number;
  now?: () => number;
}

/** Folders that hold generated, downloaded or engine-internal data. Their names are matched in lower case. */
export const HEAVY_DIRECTORIES = new Set([
  '.git', 'node_modules', 'intermediate', 'saved', 'deriveddatacache', 'binaries', '.godot', 'library', 'obj', 'build', 'dist', 'out',
  '.vs', '.idea', '.vscode', '__pycache__', '.venv', 'venv', 'target', '.gradle', 'coverage', '.next', '.cache', 'temp', 'tmp', 'logs',
]);

const DEFAULTS = { maxFiles: 20_000, maxDepth: 12, budgetMs: 8000 };
const YIELD_EVERY = 200;

export async function scanProject(root: string, options: ScanOptions = {}): Promise<ScanResult> {
  const maxFiles = options.maxFiles ?? DEFAULTS.maxFiles;
  const maxDepth = options.maxDepth ?? DEFAULTS.maxDepth;
  const budgetMs = options.budgetMs ?? DEFAULTS.budgetMs;
  const now = options.now ?? Date.now;
  const started = now();

  const files: ScanFile[] = [];
  const sensitivePaths: string[] = [];
  const skippedHeavy: string[] = [];
  const truncated = new Set<'files' | 'depth' | 'time'>();
  let sensitiveCount = 0;
  let links = 0;
  let directories = 0;
  let bytes = 0;
  let sinceYield = 0;

  const stack: { dir: string; relative: string; depth: number }[] = [{ dir: root, relative: '', depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    if (now() - started > budgetMs) {
      truncated.add('time');
      break;
    }
    let entries;
    try {
      entries = readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue; // an unreadable folder is skipped, not fatal
    }
    directories++;
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relative = current.relative === '' ? entry.name : `${current.relative}/${entry.name}`;
      if (++sinceYield >= YIELD_EVERY) {
        sinceYield = 0;
        await new Promise<void>((resolve) => setImmediate(resolve)); // keep the app responsive during a long scan
      }
      if (entry.isSymbolicLink()) {
        links++;
        continue;
      }
      if (entry.isDirectory()) {
        if (HEAVY_DIRECTORIES.has(entry.name.toLowerCase())) {
          skippedHeavy.push(relative);
        } else if (isSensitivePath(`${relative}/_`)) {
          sensitiveCount++; // a whole folder such as .ssh
          if (sensitivePaths.length < 50) sensitivePaths.push(`${relative}/`);
        } else if (current.depth + 1 > maxDepth) {
          truncated.add('depth');
        } else {
          stack.push({ dir: join(current.dir, entry.name), relative, depth: current.depth + 1 });
        }
        continue;
      }
      if (!entry.isFile()) continue;
      if (isSensitivePath(relative)) {
        sensitiveCount++;
        if (sensitivePaths.length < 50) sensitivePaths.push(relative);
        continue;
      }
      if (files.length >= maxFiles) {
        truncated.add('files');
        continue;
      }
      let size: number;
      let mtimeMs: number;
      try {
        ({ size, mtimeMs } = lstatSync(join(current.dir, entry.name)));
      } catch {
        continue;
      }
      files.push({ path: relative, ext: extname(entry.name).toLowerCase(), size, mtimeMs });
      bytes += size;
    }
  }

  return {
    files,
    sensitivePaths,
    stats: {
      files: files.length,
      directories,
      bytes,
      skippedHeavyDirs: skippedHeavy.slice(0, 200),
      sensitiveFilesSkipped: sensitiveCount,
      linksSkipped: links,
      truncated: [...truncated],
      elapsedMs: now() - started,
    },
  };
}
