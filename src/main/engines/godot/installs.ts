import { join } from 'node:path';
import type { GodotInstall } from '@shared/godot';

// Godot installations (spec §16). Godot has no installer: the download is a zip holding `Godot_v4.3-stable_win64.exe` (the editor) and
// `Godot_v4.3-stable_win64_console.exe` (a small wrapper that shows output in a terminal window). A folder counts when it holds one of
// them. Commands run the editor program itself: the process runner reads its output through pipes, which was checked on this PC with
// `--version` (the console wrapper there failed with Windows error 193, so it is only a fallback). The version is what `--version` prints, or the file name when that cannot be run. The docs say `--version` shows "the version
// string" without giving its form; the form read here (`4.7.2.stable.mono.official.ed1daf0bf` on this PC, with `mono` after the release for C#) was
// observed, so it is parsed tolerantly and the file name is the fallback.

export interface InstallProbe {
  configured: () => string[];
  /** Folders that may hold a Godot download or one folder per install. */
  defaultRoots: () => string[];
  /** A godot executable found on PATH, if any. */
  onPath: () => string | undefined;
  listDirectory: (path: string) => string[];
  /** Runs `<exe> --version`; null when it cannot be run. */
  versionOf: (exe: string) => Promise<string | null>;
}

const EXE = /^godot.*\.exe$/i;
const isConsole = (name: string): boolean => /console/i.test(name);

export interface ParsedVersion {
  version: string;
  release: string | null;
  mono: boolean;
}

export function parseGodotVersion(output: string): ParsedVersion | null {
  const match = /^(\d+\.\d+(?:\.\d+)?)\.([A-Za-z][A-Za-z0-9]*)(?:\.(mono))?/m.exec(output.trim());
  if (match === null || match[1] === undefined) return null;
  return { version: match[1], release: match[2] ?? null, mono: match[3] === 'mono' };
}

/** "Godot_v4.3-stable_mono_win64.exe" -> 4.3 stable mono. */
export function parseGodotFileName(name: string): ParsedVersion | null {
  const match = /v(\d+\.\d+(?:\.\d+)?)-([A-Za-z][A-Za-z0-9]*)/.exec(name);
  return match === null || match[1] === undefined ? null : { version: match[1], release: match[2] ?? null, mono: /mono/i.test(name) };
}

const rank = (i: GodotInstall): number => (i.version === null ? 0 : i.version.split('.').slice(0, 3).reduce((sum, part, k) => sum + Number(part) * (k === 0 ? 1_000_000 : k === 1 ? 1_000 : 1), 0));

export async function discoverGodot(probe: InstallProbe): Promise<GodotInstall[]> {
  const candidates: { folder: string; source: GodotInstall['source'] }[] = [];
  for (const folder of probe.configured()) candidates.push({ folder, source: 'configured' });
  for (const root of probe.defaultRoots()) {
    candidates.push({ folder: root, source: 'default-folder' });
    for (const name of probe.listDirectory(root)) if (/^godot/i.test(name) && !/\.(exe|zip|txt|md|lnk|pck|json)$/i.test(name)) candidates.push({ folder: join(root, name), source: 'default-folder' });
  }
  const onPath = probe.onPath();
  if (onPath !== undefined) candidates.push({ folder: join(onPath, '..'), source: 'path' });

  const seen = new Set<string>();
  const installs: GodotInstall[] = [];
  for (const { folder, source } of candidates) {
    const key = folder.toLowerCase().replace(/[\\/]+$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    const exes = probe.listDirectory(folder).filter((n) => EXE.test(n));
    // A folder with several downloads is several installs: one per editor/console pair.
    const editors = exes.filter((n) => !isConsole(n));
    const consoles = exes.filter(isConsole);
    const groups = editors.length > 0 ? editors : consoles;
    for (const editorName of groups.slice(0, 10)) {
      const stem = editorName.replace(/\.exe$/i, '').replace(/_console$/i, '');
      const consoleName = consoles.find((c) => c.replace(/\.exe$/i, '').replace(/_console$/i, '') === stem);
      const exe = isConsole(editorName) ? null : join(folder, editorName);
      const consoleExe = consoleName === undefined ? null : join(folder, consoleName);
      const runnable = exe ?? consoleExe; // the editor itself: it answers on a pipe (checked on this PC); the console wrapper did not start there
      if (runnable === null) continue;
      const read = await probe.versionOf(runnable);
      const parsed = (read === null ? null : parseGodotVersion(read)) ?? parseGodotFileName(editorName);
      installs.push({
        folder,
        exe,
        consoleExe,
        version: parsed?.version ?? null,
        release: parsed?.release ?? null,
        mono: parsed?.mono ?? false,
        source,
        note: read === null || parseGodotVersion(read) === null ? 'godot --version could not be read, so the version comes from the file name (if it has one).' : '',
      });
    }
  }
  return installs.sort((a, b) => rank(b) - rank(a) || a.folder.localeCompare(b.folder));
}
