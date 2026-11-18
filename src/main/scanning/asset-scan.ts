import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { categoryOfPath, extensionOf, type AssetCategory } from '@shared/assets';
import { isSensitivePath } from '../security';

// The walk behind the asset index (spec §17): names, sizes and times only, never file content. It skips the folders engines and tools
// fill with generated files, links, and anything that looks like a credential, and it stops at a file or time limit and says so.

/** Folders that hold generated or third-party files rather than the project's own content. */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'Intermediate', 'Binaries', 'Saved', 'DerivedDataCache', '.godot', '.import', 'Library', 'Temp', '__pycache__', '.vs', '.idea', '.gradle', 'obj']);
const MAX_DEPTH = 14;

export interface ScannedAsset {
  /** Project-relative, forward slashes. */
  path: string;
  category: AssetCategory;
  extension: string;
  bytes: number;
  mtimeMs: number;
}

export interface ScanOptions {
  maxEntries: number;
  budgetMs: number;
  now?: () => number;
}

export interface ScanOutcome {
  files: ScannedAsset[];
  entries: number;
  truncated: boolean;
  durationMs: number;
}

export function scanAssetFiles(root: string, options: ScanOptions): ScanOutcome {
  const now = options.now ?? Date.now;
  const started = now();
  const files: ScannedAsset[] = [];
  let entries = 0;
  let truncated = false;

  const go = (dir: string, relDir: string, depth: number): void => {
    let listing;
    try {
      listing = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // an unreadable folder is simply not listed
    }
    for (const entry of listing) {
      if (truncated) return;
      if (++entries > options.maxEntries || now() - started > options.budgetMs) {
        truncated = true;
        return;
      }
      if (entry.isSymbolicLink()) continue;
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH && !SKIP_DIRS.has(entry.name) && !isSensitivePath(rel)) go(join(dir, entry.name), rel, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const category = categoryOfPath(rel);
      if (category === null || isSensitivePath(rel)) continue;
      try {
        const stats = lstatSync(join(dir, entry.name));
        files.push({ path: rel, category, extension: extensionOf(rel), bytes: stats.size, mtimeMs: Math.floor(stats.mtimeMs) });
      } catch {
        // vanished between listing and stat
      }
    }
  };
  go(root, '', 0);
  return { files, entries, truncated, durationMs: Math.max(0, now() - started) };
}
