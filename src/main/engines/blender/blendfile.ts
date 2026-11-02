import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync, readdirSync, readFileSync, readSync, type Dirent } from 'node:fs';
import { join, relative } from 'node:path';
import { constants, gunzipSync, zstdDecompressSync } from 'node:zlib';
import type { BlendFormat } from '@shared/blender';
import { isSensitivePath } from '../../security';

// Read-only looks at a project's Blender files (spec §16). Nothing here opens a .blend as Blender would: only its first bytes are read,
// to learn the format and the version that saved it. The header forms were seen in real files on this PC (D-044): the older
// `BLENDER-v403` (4.3) and the newer `BLENDER17-01v0501` (5.1). Compressed files start with the gzip or zstd magic bytes.

export interface BlendHeader {
  format: BlendFormat;
  version: string | null;
}

export function parseBlendHeader(head: Buffer): BlendHeader {
  if ((head[0] === 0x1f && head[1] === 0x8b) || (head[0] === 0x28 && head[1] === 0xb5 && head[2] === 0x2f && head[3] === 0xfd)) return { format: 'compressed', version: null };
  const text = head.toString('latin1');
  if (!text.startsWith('BLENDER')) return { format: 'unknown', version: null };
  const large = /^BLENDER(\d{2})[-_](\d{2})[vV](\d{2})(\d{2})/.exec(text);
  if (large !== null) return { format: 'large-header', version: `${Number(large[3])}.${Number(large[4])}` };
  const legacy = /^BLENDER[-_][vV](\d)(\d{2})/.exec(text);
  if (legacy !== null) return { format: 'legacy', version: `${Number(legacy[1])}.${Number(legacy[2])}` };
  return { format: 'unknown', version: null };
}

/** The version of a compressed file: its first 64 KB is decompressed (partial output is enough) and the header read from that. */
function compressedVersion(head: Buffer): string | null {
  try {
    const gzip = head[0] === 0x1f;
    const text = gzip ? gunzipSync(head, { finishFlush: constants.Z_SYNC_FLUSH }) : zstdDecompressSync(head, { finishFlush: constants.ZSTD_e_flush });
    const inner = parseBlendHeader(text.subarray(0, 32));
    return inner.format === 'compressed' ? null : inner.version;
  } catch {
    return null;
  }
}

export function readBlendHeader(file: string): BlendHeader {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const buffer = Buffer.alloc(65_536);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    const header = parseBlendHeader(buffer.subarray(0, Math.min(read, 32)));
    return header.format === 'compressed' ? { format: 'compressed', version: compressedVersion(buffer.subarray(0, read)) } : header;
  } catch {
    return { format: 'unknown', version: null };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** True when `a` ("5.1") is a newer major.minor than `b`. */
export const versionNewer = (a: string, b: string): boolean => {
  const [am = 0, an = 0] = a.split('.').map(Number);
  const [bm = 0, bn = 0] = b.split('.').map(Number);
  return am !== bm ? am > bm : an > bn;
};

const SKIP_DIRS = new Set(['.git', 'node_modules', 'Intermediate', 'Binaries', 'Saved', 'DerivedDataCache', '__pycache__', '.godot', 'Library', 'Temp']);
const MAX_ENTRIES = 20_000;
const MAX_DEPTH = 6;

export interface FoundBlend {
  /** Project-relative, forward slashes. */
  path: string;
  bytes: number;
  modifiedMs: number;
  header: BlendHeader;
  backups: number;
}

const walk = (root: string, visit: (full: string, entry: Dirent, names: Set<string>) => void): boolean => {
  let seen = 0;
  let truncated = false;
  const go = (dir: string, depth: number): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const names = new Set(entries.map((e) => e.name.toLowerCase()));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (++seen > MAX_ENTRIES) {
        truncated = true;
        return;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH && !SKIP_DIRS.has(entry.name)) go(full, depth + 1);
      } else visit(full, entry, names);
    }
  };
  go(root, 0);
  return truncated;
};

/** Every .blend file under a project (at most 300), newest first, with its header and the number of .blend1/.blend2 backups beside it. */
export function scanBlendFiles(root: string): { files: FoundBlend[]; truncated: boolean } {
  const files: FoundBlend[] = [];
  const truncated = walk(root, (full, entry, names) => {
    if (!/\.blend$/i.test(entry.name) || files.length >= 300) return;
    let stats;
    try {
      stats = lstatSync(full);
    } catch {
      return;
    }
    let backups = 0;
    for (let n = 1; n <= 9; n++) if (names.has(`${entry.name.toLowerCase()}${n}`)) backups++;
    files.push({ path: relative(root, full).replace(/\\/g, '/'), bytes: stats.size, modifiedMs: stats.mtimeMs, header: readBlendHeader(full), backups });
  });
  return { files: files.sort((a, b) => b.modifiedMs - a.modifiedMs || a.path.localeCompare(b.path)), truncated };
}

const MAX_SCRIPT_BYTES = 512 * 1024;
export const sha256Text = (buffer: Buffer | string): string => createHash('sha256').update(buffer).digest('hex');

/** Python files in the project that import Blender's modules: the scripts this app may offer to run (at most 50). */
export function scanBlenderScripts(root: string): { path: string; bytes: number; hash: string }[] {
  const found: { path: string; bytes: number; hash: string }[] = [];
  walk(root, (full, entry) => {
    if (!/\.py$/i.test(entry.name) || found.length >= 50 || isSensitivePath(entry.name)) return;
    try {
      const stats = lstatSync(full);
      if (stats.size > MAX_SCRIPT_BYTES) return;
      const data = readFileSync(full);
      if (/^\s*(import|from)\s+(bpy|bmesh)\b/m.test(data.subarray(0, 65_536).toString('utf8'))) found.push({ path: relative(root, full).replace(/\\/g, '/'), bytes: stats.size, hash: sha256Text(data) });
    } catch {
      // an unreadable file is simply not offered
    }
  });
  return found.sort((a, b) => a.path.localeCompare(b.path));
}
