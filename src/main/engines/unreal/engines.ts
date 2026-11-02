import { existsSync, readFileSync } from 'node:fs';
import { basename, join, normalize } from 'node:path';
import type { EngineInstall } from '@shared/unreal';

// Finding installed Unreal Engine 5 versions on Windows (spec §16). Nothing is assumed: a folder counts as an engine only if it has
// Engine\Build\Build.version, and the install says what it lacks. Sources, in the order of trust:
//  - the Epic Games Launcher's list, C:\ProgramData\Epic\UnrealEngineLauncher\LauncherInstalled.dat (JSON with InstallLocation and
//    AppName such as UE_5.8; found on this PC, not described in Epic's documentation, so it is read tolerantly);
//  - source builds registered under HKCU\Software\Epic Games\Unreal Engine\Builds (the key named on the Unreal forums), and
//    HKCU\SOFTWARE\Epic Games\UnrealEngine\Builds (the spelling in Epic's installed-build guide), each value an id and a folder;
//  - folders the person configured, and the usual default folders.

export const REGISTRY_KEYS = ['HKCU\\Software\\Epic Games\\Unreal Engine\\Builds', 'HKCU\\SOFTWARE\\Epic Games\\UnrealEngine\\Builds'] as const;

/** Engines the launcher lists: UE_x.y entries of LauncherInstalled.dat. Other apps in the file (games) are ignored. */
export function parseLauncherInstalled(text: string): { id: string; path: string }[] {
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    return [];
  }
  const list = (value as { InstallationList?: unknown } | null)?.InstallationList;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const found: { id: string; path: string }[] = [];
  for (const item of list as Record<string, unknown>[]) {
    const name = typeof item['AppName'] === 'string' ? item['AppName'] : '';
    const path = typeof item['InstallLocation'] === 'string' ? item['InstallLocation'] : '';
    if (!/^UE_\d+\.\d+/.test(name) || path === '' || seen.has(`${name}|${path}`)) continue;
    seen.add(`${name}|${path}`);
    found.push({ id: name, path });
  }
  return found;
}

/** The values of `reg query` output: lines of name, REG_SZ and a folder. */
export function parseRegistryBuilds(text: string): { id: string; path: string }[] {
  const found: { id: string; path: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s+(.+?)\s+REG_SZ\s+(.+?)\s*$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) found.push({ id: match[1], path: match[2] });
  }
  return found;
}

interface BuildVersion {
  version: string;
  branch: string | null;
}
const readVersion = (root: string): BuildVersion | undefined => {
  try {
    const value = JSON.parse(readFileSync(join(root, 'Engine', 'Build', 'Build.version'), 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>;
    const major = value['MajorVersion'];
    const minor = value['MinorVersion'];
    if (typeof major !== 'number' || typeof minor !== 'number') return undefined;
    const patch = typeof value['PatchVersion'] === 'number' ? `.${value['PatchVersion']}` : '';
    return { version: `${major}.${minor}${patch}`, branch: typeof value['BranchName'] === 'string' ? value['BranchName'].slice(0, 80) : null };
  } catch {
    return undefined;
  }
};

/** Looks at one candidate folder and says what it is. Returns undefined if it is not a folder with an engine's version file or any engine part. */
export function inspectEngine(id: string, root: string, source: EngineInstall['source']): EngineInstall | undefined {
  if (!existsSync(root)) return undefined;
  const version = readVersion(root);
  const hasEditor = existsSync(join(root, 'Engine', 'Binaries', 'Win64', 'UnrealEditor.exe'));
  const hasEditorCmd = existsSync(join(root, 'Engine', 'Binaries', 'Win64', 'UnrealEditor-Cmd.exe'));
  const hasBuildBat = existsSync(join(root, 'Engine', 'Build', 'BatchFiles', 'Build.bat'));
  if (version === undefined && !hasEditor && !hasBuildBat) return undefined;
  const complete = version !== undefined && hasEditor && hasBuildBat;
  const missing = [version === undefined && 'Engine\\Build\\Build.version', !hasEditor && 'UnrealEditor.exe', !hasBuildBat && 'Build.bat'].filter(Boolean);
  return {
    id: id.slice(0, 200),
    version: version?.version ?? null,
    branch: version?.branch ?? null,
    path: root,
    source,
    hasEditor,
    hasEditorCmd,
    hasBuildBat,
    complete,
    note: complete ? '' : `Incomplete install: ${missing.join(', ')} not found. Finish or repair it in the Epic Games Launcher.`,
  };
}

export interface DiscoverEnginesOptions {
  /** The text of LauncherInstalled.dat, or undefined if the file is not there. */
  launcherFile: () => string | undefined;
  /** `reg query <key>` output for a key, or undefined if the key does not exist. */
  queryRegistry: (key: string) => Promise<string | undefined>;
  /** Folders the person added as engine roots. */
  configured: () => readonly string[];
  /** Folders to look for UE_* installs in (for example C:\Program Files\Epic Games). */
  defaultRoots: () => readonly string[];
  listDirectory: (path: string) => string[];
}

/** Every engine install found by any source, once each, newest version first. A failing source is skipped, not an error. */
export async function discoverEngines(options: DiscoverEnginesOptions): Promise<EngineInstall[]> {
  const candidates: { id: string; path: string; source: EngineInstall['source'] }[] = [];
  const launcher = options.launcherFile();
  if (launcher !== undefined) for (const e of parseLauncherInstalled(launcher)) candidates.push({ ...e, source: 'launcher' });
  for (const key of REGISTRY_KEYS) {
    const out = await options.queryRegistry(key).catch(() => undefined);
    if (out !== undefined) for (const e of parseRegistryBuilds(out)) candidates.push({ ...e, source: 'registry' });
  }
  for (const path of options.configured()) candidates.push({ id: basename(path), path, source: 'configured' });
  for (const root of options.defaultRoots()) for (const name of options.listDirectory(root)) if (/^UE_\d+\.\d+/.test(name)) candidates.push({ id: name, path: join(root, name), source: 'default-folder' });

  const seen = new Set<string>();
  const installs: EngineInstall[] = [];
  for (const candidate of candidates) {
    const key = normalize(candidate.path).toLowerCase().replace(/[\\/]+$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    const install = inspectEngine(candidate.id, normalize(candidate.path), candidate.source);
    if (install !== undefined) installs.push(install);
  }
  const rank = (e: EngineInstall): number => (e.version === null ? 0 : e.version.split('.').slice(0, 3).reduce((sum, part, i) => sum + Number(part) * (i === 0 ? 1_000_000 : i === 1 ? 1_000 : 1), 0));
  return installs.sort((a, b) => rank(b) - rank(a) || a.path.localeCompare(b.path));
}

/** Which install a project's EngineAssociation points at, and how that was decided. */
export function resolveEngine(association: string, installs: readonly EngineInstall[]): { install: EngineInstall; how: string } | { install: undefined; why: string } {
  const wanted = association.trim();
  if (wanted === '') return { install: undefined, why: 'The project does not name an engine (EngineAssociation is empty), so Unreal looks for one above the project folder; this app does not guess.' };
  if (/^\d+\.\d+$/.test(wanted)) {
    const match = installs.find((e) => e.version !== null && e.version.split('.').slice(0, 2).join('.') === wanted);
    return match === undefined
      ? { install: undefined, why: `The project asks for engine ${wanted}, which is not installed here${installs.length > 0 ? ` (found: ${installs.map((e) => e.version ?? e.id).join(', ')})` : ''}. Install it in the Epic Games Launcher or add its folder.` }
      : { install: match, how: `EngineAssociation ${wanted} matches ${match.id}${match.version === null ? '' : ` (${match.version})`}` };
  }
  const byId = installs.find((e) => e.id.toLowerCase() === wanted.toLowerCase());
  return byId === undefined
    ? { install: undefined, why: `The project asks for the engine "${wanted}" (a source build id), which is not registered on this PC.` }
    : { install: byId, how: `EngineAssociation ${wanted} is the registered source build ${byId.id}` };
}
