import { join } from 'node:path';
import type { BlenderInstall } from '@shared/blender';

// Blender installations (spec §16): the folders the person added, the usual install folders, and PATH. A folder counts only if it has
// blender.exe. The version is what `blender --version` prints (a documented flag), or the folder name when that cannot be run.

export interface InstallProbe {
  configured: () => string[];
  /** Folders that hold one folder per install, such as C:\Program Files\Blender Foundation. */
  defaultRoots: () => string[];
  /** A blender.exe found on PATH, if any. */
  onPath: () => string | undefined;
  listDirectory: (path: string) => string[];
  exists: (path: string) => boolean;
  /** Runs `blender --version`; null when it cannot be run. */
  versionOf: (exe: string) => Promise<string | null>;
}

export const BLENDER_EXE = 'blender.exe';

export const parseBlenderVersion = (output: string): string | null => /^Blender\s+(\d+\.\d+(?:\.\d+)?)/m.exec(output)?.[1] ?? null;

const fromFolderName = (folder: string): string | null => /(\d+\.\d+)/.exec(folder.split(/[\\/]/).pop() ?? '')?.[1] ?? null;

const rank = (i: BlenderInstall): number => (i.version === null ? 0 : i.version.split('.').slice(0, 3).reduce((sum, part, k) => sum + Number(part) * (k === 0 ? 1_000_000 : k === 1 ? 1_000 : 1), 0));

export async function discoverBlender(probe: InstallProbe): Promise<BlenderInstall[]> {
  const candidates: { folder: string; source: BlenderInstall['source'] }[] = [];
  for (const folder of probe.configured()) candidates.push({ folder, source: 'configured' });
  for (const root of probe.defaultRoots())
    for (const name of probe.listDirectory(root)) if (/^Blender/i.test(name)) candidates.push({ folder: join(root, name), source: 'default-folder' });
  const path = probe.onPath();
  if (path !== undefined) candidates.push({ folder: join(path, '..'), source: 'path' });

  const seen = new Set<string>();
  const installs: BlenderInstall[] = [];
  for (const { folder, source } of candidates) {
    const key = folder.toLowerCase().replace(/[\\/]+$/, '');
    const exe = join(folder, BLENDER_EXE);
    if (seen.has(key) || !probe.exists(exe)) continue;
    seen.add(key);
    const version = await probe.versionOf(exe);
    installs.push({ folder, version: version ?? fromFolderName(folder), source, note: version === null ? 'blender --version could not be run, so the version comes from the folder name (if it has one).' : '' });
  }
  return installs.sort((a, b) => rank(b) - rank(a) || a.folder.localeCompare(b.folder));
}
