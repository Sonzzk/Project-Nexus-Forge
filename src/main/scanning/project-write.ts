import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { AppError } from '@shared/errors';
import { MAX_DOC_BYTES } from '@shared/context';
import { isSensitivePath, resolveInside } from '../security';

// The one place the app writes into a project folder (spec §8, §14): a single Markdown document, after the user saw the
// change and confirmed it. It refuses anything outside the project, sensitive names, links and non-Markdown files, will not
// replace a file that changed since the preview, writes exactly the previewed text, and reads it back to prove it.

export const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

export interface ProjectDocState {
  exists: boolean;
  /** Text as stored, with a byte-order mark removed. */
  text: string;
  hash: string | null;
  /** Line ending the file already uses, so an edit does not change every line. */
  eol: '\n' | '\r\n';
}

function checkedTarget(root: string, rel: string): string {
  const normalized = rel.replace(/\\/g, '/');
  if (!normalized.toLowerCase().endsWith('.md') || normalized.split('/').some((part) => part === '' || part === '.' || part === '..'))
    throw new AppError('INVALID_INPUT', 'Only Markdown documents inside the project can be written.', { details: { rel: normalized.slice(0, 200) } });
  if (isSensitivePath(normalized))
    throw new AppError('PATH_SENSITIVE', 'That name looks like it may hold credentials, so the app will not write it.', { details: { rel: normalized.slice(0, 200) } });
  return resolveInside(root, normalized);
}

export function readProjectDoc(root: string, rel: string): ProjectDocState {
  const full = checkedTarget(root, rel);
  if (!existsSync(full)) return { exists: false, text: '', hash: null, eol: '\n' };
  const stats = lstatSync(full);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new AppError('UNSUPPORTED', 'That path is not an ordinary file.', { details: { rel } });
  if (stats.size > MAX_DOC_BYTES * 2) throw new AppError('LIMIT_REACHED', 'That document is too large to edit here.', { hint: 'Edit it in your own editor.' });
  const buffer = readFileSync(full);
  if (buffer.subarray(0, 8192).includes(0)) throw new AppError('UNSUPPORTED', 'That file looks binary.', { details: { rel } });
  const raw = buffer.toString('utf8');
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  return { exists: true, text, hash: sha256(text), eol: text.includes('\r\n') ? '\r\n' : '\n' };
}

/** True when the folder that would hold the file does not exist yet. */
export function wouldCreateFolder(root: string, rel: string): boolean {
  return !existsSync(dirname(checkedTarget(root, rel)));
}

/**
 * Writes `content` to the document. `expectedHash` is the hash of the file when the user saw the preview (null if the file
 * did not exist); if the file changed since, nothing is written. Returns after reading the file back.
 */
export function writeProjectDoc(root: string, rel: string, content: string, expectedHash: string | null): void {
  const full = checkedTarget(root, rel);
  const current = readProjectDoc(root, rel);
  if (current.hash !== expectedHash)
    throw new AppError('CONFLICT', 'The file changed after you looked at the preview, so nothing was written.', { hint: 'Preview the change again.' });
  const normalized = content.replace(/\r\n/g, '\n');
  if (Buffer.byteLength(normalized, 'utf8') > MAX_DOC_BYTES) throw new AppError('LIMIT_REACHED', 'That document is too large.', { hint: 'Keep memory documents concise.' });
  const text = current.eol === '\r\n' ? normalized.replace(/\n/g, '\r\n') : normalized;

  mkdirSync(dirname(full), { recursive: true });
  const temporary = join(dirname(full), `.${basename(full)}.gdcc-tmp`);
  try {
    const fd = openSync(temporary, 'w');
    try {
      writeSync(fd, text, null, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, full);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw new AppError('INTERNAL', 'The document could not be written. The original was not changed.', { cause: error, hint: 'Check that the file is not open in a program that locks it.' });
  }
  const back = readFileSync(full, 'utf8');
  if ((back.charCodeAt(0) === 0xfeff ? back.slice(1) : back) !== text)
    throw new AppError('INTERNAL', 'The file on disk does not match what was previewed.', { hint: 'Check the document in your editor.' });
}
