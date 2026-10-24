import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppError } from '@shared/errors';
import { makeTempDir, removeTempDirs } from '../../../test/helpers/temp';
import { createProjectReader } from './reader';

afterEach(removeTempDirs);

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (error) {
    return (error as AppError).code;
  }
};

function setup() {
  const root = makeTempDir();
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(root, 'src', 'copy.ts'), 'export const a = 1;\n');
  writeFileSync(join(root, '.env'), 'KEY=value');
  writeFileSync(join(root, 'texture.png'), Buffer.from([137, 80, 78, 71, 0, 1, 2]));
  writeFileSync(join(root, 'weird.txt'), Buffer.from([65, 0, 66]));
  writeFileSync(join(root, 'big.txt'), 'x'.repeat(2000));
  return { root, reader: createProjectReader(root) };
}

describe('ProjectReader', () => {
  it('reads a text file and strips a byte-order mark', () => {
    const { root, reader } = setup();
    writeFileSync(join(root, 'bom.txt'), '\uFEFFhello');
    expect(reader.readText('src/a.ts')).toBe('export const a = 1;\n');
    expect(reader.readText('bom.txt')).toBe('hello');
  });

  it('refuses outside, sensitive, binary, oversized, missing and non-file paths with the right code', () => {
    const { reader } = setup();
    expect(codeOf(() => reader.readText('../x.txt'))).toBe('PATH_OUTSIDE_PROJECT');
    expect(codeOf(() => reader.readText('C:\\Windows\\win.ini'))).toBe('PATH_OUTSIDE_PROJECT');
    expect(codeOf(() => reader.readText('.env'))).toBe('PATH_SENSITIVE');
    expect(codeOf(() => reader.readText('texture.png'))).toBe('UNSUPPORTED');
    expect(codeOf(() => reader.readText('weird.txt'))).toBe('UNSUPPORTED');
    expect(codeOf(() => reader.readText('big.txt', 100))).toBe('LIMIT_REACHED');
    expect(codeOf(() => reader.readText('nope.txt'))).toBe('NOT_FOUND');
    expect(codeOf(() => reader.readText('src'))).toBe('UNSUPPORTED');
  });

  it('hashes identical content to the same digest, binary files included, and applies the same path rules', () => {
    const { reader } = setup();
    expect(reader.hash('src/a.ts', 1000)).toBe(reader.hash('src/copy.ts', 1000));
    expect(reader.hash('src/a.ts', 1000)).toMatch(/^[0-9a-f]{64}$/);
    expect(reader.hash('texture.png', 1000)).toMatch(/^[0-9a-f]{64}$/);
    expect(codeOf(() => reader.hash('.env', 1000))).toBe('PATH_SENSITIVE');
    expect(codeOf(() => reader.hash('../x', 1000))).toBe('PATH_OUTSIDE_PROJECT');
    expect(codeOf(() => reader.hash('big.txt', 100))).toBe('LIMIT_REACHED');
  });
});
