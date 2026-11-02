import { closeSync, lstatSync, openSync, readdirSync, readSync, type Dirent } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { UnrealProject, UnrealTarget } from '@shared/unreal';
import { isSensitivePath } from '../../security';

// A read-only description of an Unreal Engine 5 project folder (spec §16): the .uproject, the usual folders, the C++ targets and
// modules, the config files and a few of their settings, the project's own plugins, and a count of the content. Binary assets
// (.uasset, .umap) are only counted and named, never opened, and nothing is ever written. Links are not followed.

const MAX_TEXT = 1024 * 1024;
const MAX_ENTRIES = 20_000;
const MAX_DEPTH = 8;

const readText = (path: string, max = MAX_TEXT): string | undefined => {
  try {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.size > max) return undefined;
    const fd = openSync(path, 'r');
    try {
      const buffer = Buffer.alloc(stats.size);
      readSync(fd, buffer, 0, stats.size, 0);
      return buffer.toString('utf8').replace(/^\uFEFF/, '');
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
};
const isDir = (path: string): boolean => {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
};
const list = (path: string): Dirent[] => {
  try {
    return readdirSync(path, { withFileTypes: true }).filter((entry) => !entry.isSymbolicLink());
  } catch {
    return [];
  }
};
const str = (value: unknown, max = 200): string => (typeof value === 'string' ? value.slice(0, max) : '');

export interface ParsedUproject {
  fileVersion: number | null;
  engineAssociation: string;
  description: string;
  category: string;
  modules: UnrealProject['modules'];
  plugins: UnrealProject['plugins'];
}

/** Reads the fields of a .uproject. Returns undefined for text that is not a JSON object. Unknown fields are ignored. */
export function parseUproject(text: string): ParsedUproject | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const o = value as Record<string, unknown>;
  const records = (key: string): Record<string, unknown>[] => (Array.isArray(o[key]) ? (o[key] as unknown[]).filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)) : []);
  return {
    fileVersion: typeof o['FileVersion'] === 'number' && Number.isInteger(o['FileVersion']) ? o['FileVersion'] : null,
    engineAssociation: str(o['EngineAssociation']),
    description: str(o['Description'], 500),
    category: str(o['Category'], 100),
    modules: records('Modules').slice(0, 100).map((m) => ({ name: str(m['Name'], 100), type: str(m['Type'], 40), loadingPhase: str(m['LoadingPhase'], 40) })).filter((m) => m.name !== ''),
    plugins: records('Plugins').slice(0, 300).map((p) => ({ name: str(p['Name'], 100), enabled: p['Enabled'] !== false })).filter((p) => p.name !== ''),
  };
}

/** The value of `key=` in the named section of an Unreal .ini file, or undefined. */
export function iniValue(text: string, section: string, key: string): string | undefined {
  let inSection = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) inSection = line.toLowerCase() === `[${section.toLowerCase()}]`;
    else if (inSection) {
      const equals = line.indexOf('=');
      if (equals > 0 && line.slice(0, equals).trim().toLowerCase() === key.toLowerCase()) return line.slice(equals + 1).trim().slice(0, 300);
    }
  }
  return undefined;
}

const targetType = (text: string | undefined): UnrealTarget['type'] => {
  const found = /Type\s*=\s*TargetType\.(\w+)/.exec(text ?? '')?.[1];
  return found === 'Game' || found === 'Editor' || found === 'Client' || found === 'Server' || found === 'Program' ? found : 'unknown';
};

/** Describes the Unreal project at `root`, or undefined when there is no readable .uproject at its top level. Notes say what was left out. */
export function describeUnrealProject(root: string): UnrealProject | undefined {
  const uprojects = list(root).filter((e) => e.isFile() && extname(e.name).toLowerCase() === '.uproject').map((e) => e.name).sort();
  const file = uprojects[0];
  if (file === undefined) return undefined;
  const parsed = parseUproject(readText(join(root, file)) ?? '');
  if (parsed === undefined) return undefined;
  const notes: string[] = [];
  if (uprojects.length > 1) notes.push(`There are ${uprojects.length} .uproject files at the top of the folder; ${file} is described.`);

  const folder = (name: string): boolean => isDir(join(root, name));
  const folders = { source: folder('Source'), config: folder('Config'), content: folder('Content'), plugins: folder('Plugins'), binaries: folder('Binaries'), intermediate: folder('Intermediate'), saved: folder('Saved'), derivedDataCache: folder('DerivedDataCache') };

  // C++ targets and modules: *.Target.cs and *.Build.cs under Source (a few levels deep)
  const targets: UnrealTarget[] = [];
  let buildCs = 0;
  const walkSource = (dir: string, rel: string, depth: number): void => {
    for (const entry of list(dir)) {
      if (entry.isDirectory()) {
        if (depth < 4) walkSource(join(dir, entry.name), `${rel}${entry.name}/`, depth + 1);
      } else if (/\.Target\.cs$/i.test(entry.name) && targets.length < 40) {
        targets.push({ name: entry.name.replace(/\.Target\.cs$/i, ''), type: targetType(readText(join(dir, entry.name), 256 * 1024)), file: `Source/${rel}${entry.name}` });
      } else if (/\.Build\.cs$/i.test(entry.name)) buildCs++;
    }
  };
  if (folders.source) walkSource(join(root, 'Source'), '', 0);
  targets.sort((a, b) => a.name.localeCompare(b.name));

  // config files and the settings worth knowing
  const configFiles = folders.config ? list(join(root, 'Config')).filter((e) => e.isFile() && /\.ini$/i.test(e.name) && !isSensitivePath(e.name)).map((e) => e.name).sort().slice(0, 60) : [];
  const engineIni = configFiles.includes('DefaultEngine.ini') ? readText(join(root, 'Config', 'DefaultEngine.ini'), 512 * 1024) : undefined;
  const gameIni = configFiles.includes('DefaultGame.ini') ? readText(join(root, 'Config', 'DefaultGame.ini'), 512 * 1024) : undefined;
  const defaultMap = engineIni === undefined ? null : (iniValue(engineIni, '/Script/EngineSettings.GameMapsSettings', 'GameDefaultMap') ?? null);
  const editorStartupMap = engineIni === undefined ? null : (iniValue(engineIni, '/Script/EngineSettings.GameMapsSettings', 'EditorStartupMap') ?? null);
  const projectVersion = gameIni === undefined ? null : (iniValue(gameIni, '/Script/EngineSettings.GeneralProjectSettings', 'ProjectVersion') ?? null);

  // the project's own plugins
  const projectPlugins: string[] = [];
  const walkPlugins = (dir: string, depth: number): void => {
    for (const entry of list(dir)) {
      if (entry.isDirectory() && depth < 3) walkPlugins(join(dir, entry.name), depth + 1);
      else if (entry.isFile() && /\.uplugin$/i.test(entry.name) && projectPlugins.length < 100) projectPlugins.push(basename(entry.name, extname(entry.name)));
    }
  };
  if (folders.plugins) walkPlugins(join(root, 'Plugins'), 0);

  // content: names, sizes and counts only
  let assets = 0;
  let bytes = 0;
  let seen = 0;
  let truncated = false as boolean; // set inside walkContent; the cast keeps the check below from being narrowed away
  const maps: string[] = [];
  const topFolders = new Map<string, number>();
  const walkContent = (dir: string, rel: string, depth: number): void => {
    for (const entry of list(dir)) {
      if (seen >= MAX_ENTRIES) {
        truncated = true;
        return;
      }
      seen++;
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH) walkContent(join(dir, entry.name), `${rel}${entry.name}/`, depth + 1);
        else truncated = true;
      } else if (/\.(uasset|umap)$/i.test(entry.name)) {
        assets++;
        try {
          bytes += lstatSync(join(dir, entry.name)).size;
        } catch {
          // an asset that disappeared while counting does not change the picture
        }
        const top = rel.split('/')[0] ?? '';
        topFolders.set(top === '' ? '(top level)' : top, (topFolders.get(top === '' ? '(top level)' : top) ?? 0) + 1);
        if (/\.umap$/i.test(entry.name) && maps.length < 100) maps.push(`/Game/${rel}${entry.name.replace(/\.umap$/i, '')}`);
      }
    }
  };
  if (folders.content) walkContent(join(root, 'Content'), '', 0);
  if (truncated) notes.push(`The content folder is large, so only the first ${MAX_ENTRIES.toLocaleString('en-US')} entries were counted.`);
  const hasSource = folders.source && (targets.length > 0 || buildCs > 0);
  if (!hasSource) notes.push('No C++ source was found, so this looks like a Blueprint-only project. It can be opened but not built from here.');

  return {
    uproject: file,
    name: basename(file, extname(file)),
    fileVersion: parsed.fileVersion,
    engineAssociation: parsed.engineAssociation,
    description: parsed.description,
    category: parsed.category,
    modules: parsed.modules,
    plugins: parsed.plugins,
    projectPlugins,
    targets,
    buildCsFiles: buildCs,
    folders,
    configFiles,
    defaultMap,
    editorStartupMap,
    projectVersion,
    content: { assets, bytes, maps: maps.sort(), topFolders: [...topFolders.entries()].map(([name, count]) => ({ name, assets: count })).sort((a, b) => b.assets - a.assets).slice(0, 40), truncated },
    hasSource,
    notes,
  };
}
