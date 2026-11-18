import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import type { ExportPreset, GodotProject } from '@shared/godot';
import { isSensitivePath } from '../../security';
import { cfgBool, cfgGet, cfgInt, cfgString, cfgStrings, parseCfg, type Cfg } from './cfg';

// Reads a Godot project from its files (spec §16 Godot): project.godot, export_presets.cfg, addons' plugin.cfg and the GDScript files'
// class_name and extends lines. Nothing is run and nothing under `.godot` (the engine's cache) is read. Export options (keystores,
// passwords) live in export_presets.cfg too; only the name, platform, runnable flag and export path are taken from it.

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_ENTRIES = 20_000;
const MAX_DEPTH = 8;
const SKIP_DIRS = new Set(['.git', '.godot', '.import', 'node_modules', 'Intermediate', 'Binaries', 'Library', 'Temp', '__pycache__']);
const RENDERERS = ['Forward Plus', 'Mobile', 'GL Compatibility', 'Compatibility'];

function readSmall(path: string): string | undefined {
  try {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.size > MAX_FILE_BYTES) return undefined;
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** The preset's export path, kept only if it is a path inside the project whose folder exists (Godot does not create it). */
function presetExport(root: string, rawPath: string): { path: string; skipped: string } {
  if (rawPath === '') return { path: '', skipped: 'The preset has no export path, so there is nothing to export to.' };
  if (isAbsolute(rawPath) || /^[a-z]+:\/\//i.test(rawPath)) return { path: rawPath, skipped: 'The export path is absolute or outside the project; only paths inside the project are offered.' };
  const full = resolve(root, rawPath);
  const rel = relative(root, full);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return { path: rawPath, skipped: 'The export path leaves the project folder; only paths inside the project are offered.' };
  const folder = resolve(full, '..');
  if (!existsSync(folder)) return { path: rawPath, skipped: `The export folder ${relative(root, folder).replace(/\\/g, '/') || '.'} does not exist and Godot does not create it. Create it yourself, then reload.` };
  return { path: rawPath.replace(/\\/g, '/'), skipped: '' };
}

function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) < 32) return true;
  return false;
}

function readPresets(root: string, notes: string[]): ExportPreset[] {
  const text = readSmall(join(root, 'export_presets.cfg'));
  if (text === undefined) return [];
  const cfg = parseCfg(text);
  const presets: ExportPreset[] = [];
  for (const [section, values] of cfg) {
    if (!/^preset\.\d+$/.test(section)) continue;
    const name = cfgString(values.get('name'));
    if (name === undefined || name === '' || name.length > 100 || hasControlCharacter(name)) {
      notes.push(`A preset in export_presets.cfg (${section}) has no usable name and is ignored.`);
      continue;
    }
    const exportPath = cfgString(values.get('export_path')) ?? '';
    const { path, skipped } = presetExport(root, exportPath);
    presets.push({ name, platform: cfgString(values.get('platform')) ?? '', runnable: cfgBool(values.get('runnable')) ?? false, exportPath: path, skipped });
    if (presets.length >= 40) break;
  }
  return presets;
}

function readAddons(root: string): GodotProject['addons'] {
  const dir = join(root, 'addons');
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.isSymbolicLink()).map((e) => e.name).sort();
  } catch {
    return [];
  }
  return names.slice(0, 50).map((folder) => {
    const cfg = parseCfg(readSmall(join(dir, folder, 'plugin.cfg')) ?? '');
    return { folder, name: cfgString(cfgGet(cfg, 'plugin', 'name')) ?? folder, version: cfgString(cfgGet(cfg, 'plugin', 'version')) ?? '' };
  });
}

function scanSources(root: string): GodotProject['scripts'] {
  const out: GodotProject['scripts'] = { gdscript: 0, csharp: 0, scenes: 0, resources: 0, classes: [], truncated: false };
  let seen = 0;
  const go = (dir: string, depth: number, inAddons: boolean): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (++seen > MAX_ENTRIES) {
        out.truncated = true;
        return;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH && !SKIP_DIRS.has(entry.name)) go(full, depth + 1, inAddons || (depth === 0 && entry.name === 'addons'));
        continue;
      }
      if (inAddons || isSensitivePath(entry.name)) continue; // third-party add-on code is not the project's own
      if (/\.gd$/i.test(entry.name)) {
        out.gdscript++;
        if (out.classes.length < 200) {
          const head = readHead(full);
          const name = /^class_name\s+([A-Za-z_]\w*)/m.exec(head)?.[1];
          if (name !== undefined) out.classes.push({ name, path: relative(root, full).replace(/\\/g, '/'), extends: /^extends\s+([A-Za-z_][\w.]*)/m.exec(head)?.[1] ?? 'RefCounted' });
        }
      } else if (/\.cs$/i.test(entry.name)) out.csharp++;
      else if (/\.(tscn|scn)$/i.test(entry.name)) out.scenes++;
      else if (/\.(tres|res)$/i.test(entry.name)) out.resources++;
    }
  };
  go(root, 0, false);
  out.classes.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function readHead(path: string): string {
  try {
    return readFileSync(path, 'utf8').slice(0, 8192);
  } catch {
    return '';
  }
}

function findTests(root: string): GodotProject['tests'] {
  const hasGut = existsSync(join(root, 'addons', 'gut', 'gut_cmdln.gd'));
  const hasGdunit = existsSync(join(root, 'addons', 'gdUnit4'));
  const framework = hasGut ? 'gut' : hasGdunit ? 'gdunit4' : null;
  let directory: string | null = null;
  for (const candidate of ['test', 'tests']) {
    try {
      if (readdirSync(join(root, candidate)).some((n) => /^test_.*\.gd$/.test(n))) {
        directory = candidate;
        break;
      }
    } catch {
      // not there
    }
  }
  return { framework, directory, hasConfig: existsSync(join(root, '.gutconfig.json')) };
}

/** A Godot project's facts, or undefined when the folder has no readable project.godot. */
export function describeGodotProject(root: string): GodotProject | undefined {
  const text = readSmall(join(root, 'project.godot'));
  if (text === undefined) return undefined;
  const cfg: Cfg = parseCfg(text);
  const notes: string[] = [];
  const features = cfgStrings(cfgGet(cfg, 'application', 'config/features'));
  const autoloads = [...(cfg.get('autoload') ?? new Map<string, string>())].slice(0, 50).map(([name, raw]) => ({ name, path: (cfgString(raw) ?? '').replace(/^\*/, '') }));
  const configVersion = cfgInt(cfgGet(cfg, '', 'config_version')) ?? null;
  if (configVersion === null) notes.push('project.godot has no config_version line, so the Godot generation is unknown.');
  else if (configVersion < 5) notes.push(`config_version ${configVersion} is a Godot 3 project. This app offers commands only for Godot 4 (config_version 5) because the command-line options differ.`);
  const mainScene = cfgString(cfgGet(cfg, 'application', 'run/main_scene'));
  return {
    name: cfgString(cfgGet(cfg, 'application', 'config/name')) || basename(root),
    configVersion,
    engineVersion: features.find((f) => /^\d+\.\d+$/.test(f)) ?? null,
    features,
    renderer: features.find((f) => RENDERERS.includes(f)) ?? null,
    csharp: features.includes('C#') || cfg.has('dotnet'),
    mainScene: mainScene === undefined || mainScene === '' ? null : mainScene,
    autoloads,
    enabledPlugins: cfgStrings(cfgGet(cfg, 'editor_plugins', 'enabled')).slice(0, 50),
    addons: readAddons(root),
    presets: readPresets(root, notes),
    scripts: scanSources(root),
    tests: findTests(root),
    notes,
  };
}
