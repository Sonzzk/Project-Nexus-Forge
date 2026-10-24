import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync, readSync } from 'node:fs';
import { extname } from 'node:path';
import { AppError } from '@shared/errors';
import { isSensitivePath, resolveInside } from '../security';

// The only way project files are read (ARCHITECTURE.md section 4: "Project files are read only through ProjectReader").
// It refuses paths outside the project, sensitive files, links, binary files and anything over the size limit.

export interface ProjectReader {
  readonly root: string;
  /** Text of a project-relative file. Throws PATH_OUTSIDE_PROJECT, PATH_SENSITIVE, UNSUPPORTED (binary or not a file) or LIMIT_REACHED. */
  readText(relativePath: string, maxBytes?: number): string;
  /**
   * SHA-256 of a regular file, binary or not, for finding identical copies. The bytes go into the digest and nowhere else.
   * Throws the same errors as `readText` for outside, sensitive and non-regular paths, and LIMIT_REACHED over `maxBytes`.
   */
  hash(relativePath: string, maxBytes: number): string;
}

/** Extensions whose contents are never read: they are binary or generated, and are only counted. */
export const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tga', '.dds', '.exr', '.hdr', '.psd', '.tif', '.tiff', '.webp', '.ico', '.ktx', '.ktx2',
  '.fbx', '.obj', '.glb', '.blend', '.dae', '.3ds', '.usd', '.usdz', '.abc', '.mesh',
  '.wav', '.mp3', '.ogg', '.flac', '.aif', '.aiff', '.wem', '.bnk', '.mp4', '.mov', '.webm', '.avi', '.mkv',
  '.uasset', '.umap', '.uexp', '.ubulk', '.upk', '.pak', '.utoc', '.ucas', '.dll', '.exe', '.pdb', '.lib', '.so', '.dylib', '.a', '.o', '.obj_',
  '.zip', '.7z', '.rar', '.gz', '.tar', '.ttf', '.otf', '.woff', '.woff2', '.pdf', '.bin', '.dat', '.db', '.sqlite', '.res', '.import', '.ctex', '.pck',
]);

export const DEFAULT_READ_BYTES = 256 * 1024;

/** Resolves and checks a project-relative path for any read: inside the root, not sensitive, a regular file. */
function checkedFile(root: string, relativePath: string): { full: string; size: number; normalized: string } {
  const normalized = relativePath.replace(/\\/g, '/');
  if (isSensitivePath(normalized))
    throw new AppError('PATH_SENSITIVE', 'That file may hold credentials, so it is never read.', { details: { relativePath: normalized } });
  const full = resolveInside(root, normalized);
  let stats;
  try {
    stats = lstatSync(full);
  } catch (error) {
    throw new AppError('NOT_FOUND', 'That file does not exist.', { cause: error, details: { relativePath: normalized } });
  }
  if (!stats.isFile()) throw new AppError('UNSUPPORTED', 'Only regular files can be read.', { details: { relativePath: normalized } });
  return { full, size: stats.size, normalized };
}

export function createProjectReader(root: string): ProjectReader {
  return {
    root,
    hash(relativePath, maxBytes) {
      const { full, size, normalized } = checkedFile(root, relativePath);
      if (size > maxBytes) throw new AppError('LIMIT_REACHED', 'That file is too large to compare.', { details: { relativePath: normalized, size } });
      const digest = createHash('sha256');
      const chunk = Buffer.alloc(1024 * 1024);
      const fd = openSync(full, 'r');
      try {
        for (let read = readSync(fd, chunk, 0, chunk.length, null); read > 0; read = readSync(fd, chunk, 0, chunk.length, null))
          digest.update(chunk.subarray(0, read));
      } finally {
        closeSync(fd);
      }
      return digest.digest('hex');
    },
    readText(relativePath, maxBytes = DEFAULT_READ_BYTES) {
      const normalized = relativePath.replace(/\\/g, '/');
      if (BINARY_EXTENSIONS.has(extname(normalized).toLowerCase()))
        throw new AppError('UNSUPPORTED', 'Binary files are counted but never read.', { details: { relativePath: normalized } });
      const { full, size } = checkedFile(root, normalized);
      if (size > maxBytes) throw new AppError('LIMIT_REACHED', 'That file is too large to read.', { details: { relativePath: normalized, size } });
      const fd = openSync(full, 'r');
      try {
        const buffer = Buffer.alloc(size);
        readSync(fd, buffer, 0, size, 0);
        if (buffer.subarray(0, 8192).includes(0))
          throw new AppError('UNSUPPORTED', 'That file looks binary, so it is not read.', { details: { relativePath: normalized } });
        const text = buffer.toString('utf8');
        return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // drop a byte-order mark
      } finally {
        closeSync(fd);
      }
    },
  };
}
