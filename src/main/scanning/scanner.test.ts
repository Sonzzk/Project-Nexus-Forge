import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTempDir, removeTempDirs } from '../../../test/helpers/temp';
import { copyFixture, snapshotTree } from '../../../test/helpers/tree';
import { scanProject } from './scanner';

afterEach(removeTempDirs);

const write = (root: string, path: string, content = 'x'): void => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
};

describe('scanProject', () => {
  it('lists names, sizes and extensions with forward slashes, and changes nothing', async () => {
    const root = copyFixture('audit-godot');
    const before = snapshotTree(root);
    const { files, stats } = await scanProject(root);
    expect(files.map((f) => f.path)).toContain('scripts/player.gd');
    expect(files.find((f) => f.path === 'project.godot')).toMatchObject({ ext: '.godot' });
    expect(stats.files).toBe(files.length);
    expect(stats.truncated).toEqual([]);
    expect(snapshotTree(root)).toEqual(before);
  });

  it('skips heavy and generated folders and reports them', async () => {
    const root = makeTempDir();
    write(root, 'src/main.ts');
    for (const heavy of [
      'node_modules/x/index.js',
      '.git/HEAD',
      'Intermediate/a.obj',
      'Saved/log.txt',
      'DerivedDataCache/c.bin',
      'Binaries/Win64/g.exe',
      '.godot/imported/a.ctex',
      'Library/cache.bin',
    ])
      write(root, heavy);
    const { files, stats } = await scanProject(root);
    expect(files.map((f) => f.path)).toEqual(['src/main.ts']);
    expect(stats.skippedHeavyDirs.sort()).toEqual([
      '.git',
      '.godot',
      'Binaries',
      'DerivedDataCache',
      'Intermediate',
      'Library',
      'Saved',
      'node_modules',
    ]);
  });

  it('skips sensitive files and folders without reading them and reports only their names', async () => {
    const root = makeTempDir();
    write(root, 'src/main.ts');
    write(root, '.env', 'API_KEY=sk-ant-api03-NeverRead0123456789');
    write(root, 'config/.env.local');
    write(root, 'keys/server.pem');
    write(root, '.ssh/id_rsa');
    write(root, 'notes/passwords.txt');
    const { files, sensitivePaths, stats } = await scanProject(root);
    expect(files.map((f) => f.path)).toEqual(['src/main.ts']);
    expect(stats.sensitiveFilesSkipped).toBe(5);
    expect(sensitivePaths.sort()).toEqual(['.env', '.ssh/', 'config/.env.local', 'keys/server.pem', 'notes/passwords.txt']);
    expect(JSON.stringify({ files, sensitivePaths })).not.toContain('sk-ant');
  });

  it('stops at the file budget and says so', async () => {
    const root = makeTempDir();
    for (let i = 0; i < 30; i++) write(root, `f${String(i).padStart(2, '0')}.txt`);
    const { files, stats } = await scanProject(root, { maxFiles: 10 });
    expect(files).toHaveLength(10);
    expect(stats.truncated).toContain('files');
  });

  it('stops at the depth budget and says so', async () => {
    const root = makeTempDir();
    write(root, 'a/b/c/d/deep.txt');
    write(root, 'a/top.txt');
    const { files, stats } = await scanProject(root, { maxDepth: 2 });
    expect(files.map((f) => f.path)).toEqual(['a/top.txt']);
    expect(stats.truncated).toContain('depth');
  });

  it('stops at the time budget and says so', async () => {
    const root = makeTempDir();
    write(root, 'a/one.txt');
    write(root, 'b/two.txt');
    let t = 0;
    const { stats } = await scanProject(root, { budgetMs: 5, now: () => (t += 10) });
    expect(stats.truncated).toContain('time');
  });

  it('does not follow links', async () => {
    const root = makeTempDir();
    const outside = makeTempDir();
    write(outside, 'secret.txt');
    write(root, 'real.txt');
    try {
      symlinkSync(outside, join(root, 'link'), 'junction');
    } catch {
      return; // links cannot be created here: nothing to prove
    }
    const { files, stats } = await scanProject(root);
    expect(files.map((f) => f.path)).toEqual(['real.txt']);
    expect(stats.linksSkipped).toBe(1);
  });
});
