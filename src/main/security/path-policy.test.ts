import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppError } from '@shared/errors';
import { makeTempDir, removeTempDirs } from '../../../test/helpers/temp';
import { resolveInside } from './path-policy';

afterEach(removeTempDirs);

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (error) {
    return (error as AppError).code;
  }
};

describe('resolveInside', () => {
  it('resolves files and missing files inside the root, with either slash', () => {
    const root = makeTempDir();
    mkdirSync(join(root, 'a'));
    writeFileSync(join(root, 'a', 'b.txt'), 'x');
    expect(resolveInside(root, 'a/b.txt').toLowerCase()).toContain(join('a', 'b.txt').toLowerCase());
    expect(resolveInside(root, 'a\\b.txt')).toBeTruthy();
    expect(resolveInside(root, 'a/not-there.txt')).toBeTruthy();
    expect(resolveInside(root, '.')).toBeTruthy();
  });

  it.each([
    '../x',
    'a/../../x',
    'C:\\Windows\\win.ini',
    'C:win.ini',
    '\\\\server\\share\\x',
    '\\\\?\\C:\\x',
    '\\\\.\\PhysicalDrive0',
    '/etc/passwd',
    'a\0b',
  ])('refuses %j', (bad) => {
    expect(codeOf(() => resolveInside(makeTempDir(), bad))).toBe('PATH_OUTSIDE_PROJECT');
  });

  it('refuses a link or junction that leaves the root', () => {
    const root = makeTempDir();
    const outside = makeTempDir();
    writeFileSync(join(outside, 'secret.txt'), 'x');
    try {
      symlinkSync(outside, join(root, 'out'), 'junction');
    } catch {
      return; // the platform does not allow creating the link: nothing to prove here
    }
    expect(codeOf(() => resolveInside(root, 'out/secret.txt'))).toBe('PATH_OUTSIDE_PROJECT');
  });
});
