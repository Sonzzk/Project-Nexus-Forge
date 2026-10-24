import { closeSync, lstatSync, openSync, readdirSync, readSync } from 'node:fs';
import { join } from 'node:path';
import type { Detection, Evidence, ProjectType } from '@shared/projects';
import { isSensitivePath } from '../security';

// Read-only project type detection (spec §6). It lists the top of the folder and reads a few small files that define a
// project type; it never writes, never follows links, never reads sensitive files, and never looks at the folder's name.

const MAX_ENTRIES = 5000;
const MAX_READ_BYTES = 1024 * 1024;

const cut = (text: string, max = 60): string => text.slice(0, max);

/** Reads up to `maxBytes` of a regular file under `root`, or undefined if it is a link, missing, sensitive or too big. */
function readSmallText(root: string, relativePath: string, maxBytes = MAX_READ_BYTES): string | undefined {
  if (isSensitivePath(relativePath)) return undefined;
  const full = join(root, relativePath);
  try {
    const stats = lstatSync(full);
    if (!stats.isFile() || stats.size > maxBytes) return undefined;
    const fd = openSync(full, 'r');
    try {
      const buffer = Buffer.alloc(stats.size);
      readSync(fd, buffer, 0, stats.size, 0);
      return buffer.toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

function readJson(root: string, relativePath: string): Record<string, unknown> | undefined {
  const text = readSmallText(root, relativePath);
  if (text === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(text.replace(/^\uFEFF/, ''));
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

const VITE_CONFIG = /^vite\.config\.(?:ts|js|mjs|cjs|mts|cts)$/i;
const CODE_MARKERS = new Map<string, string>([
  ['cargo.toml', 'Rust project (Cargo.toml)'],
  ['pyproject.toml', 'Python project (pyproject.toml)'],
  ['setup.py', 'Python project (setup.py)'],
  ['requirements.txt', 'Python requirements (requirements.txt)'],
  ['go.mod', 'Go module (go.mod)'],
  ['cmakelists.txt', 'CMake project (CMakeLists.txt)'],
  ['pom.xml', 'Maven project (pom.xml)'],
  ['build.gradle', 'Gradle project (build.gradle)'],
  ['build.gradle.kts', 'Gradle project (build.gradle.kts)'],
]);

/** What the files in `root` say this project is. Throws only if the folder itself cannot be listed. */
export function detectProject(root: string): Detection {
  const files = new Map<string, string>(); // lowercase name -> real name
  const directories = new Set<string>();
  for (const entry of readdirSync(root, { withFileTypes: true }).slice(0, MAX_ENTRIES)) {
    if (entry.isSymbolicLink()) continue; // links are reported by later steps, never followed
    if (entry.isFile()) files.set(entry.name.toLowerCase(), entry.name);
    else if (entry.isDirectory()) directories.add(entry.name);
  }
  const named = (suffix: string): string[] =>
    [...files.values()].filter((name) => name.toLowerCase().endsWith(suffix)).sort();

  const evidence: Evidence[] = [];
  const found: {
    type: ProjectType;
    confidence: Detection['confidence'];
    engine?: string;
    engineVersion?: string;
  }[] = [];

  // Unreal Engine: *.uproject
  const uproject = named('.uproject')[0];
  if (uproject !== undefined) {
    const association = readJson(root, uproject)?.['EngineAssociation'];
    const version =
      typeof association === 'string' && /^\d+\.\d+(?:\.\d+)?$/.test(association) ? association : undefined;
    evidence.push({
      path: uproject,
      detail:
        version !== undefined
          ? `Unreal project file, engine ${version}`
          : 'Unreal project file (engine is a custom build or not stated)',
    });
    found.push({
      type: 'unreal',
      confidence: 'confirmed',
      engine: 'Unreal Engine',
      ...(version === undefined ? {} : { engineVersion: version }),
    });
  }

  // Unity: ProjectSettings/ProjectVersion.txt
  if (directories.has('ProjectSettings')) {
    const text = readSmallText(root, 'ProjectSettings/ProjectVersion.txt', 4096);
    if (text !== undefined) {
      const version = /m_EditorVersion:\s*(\S+)/.exec(text)?.[1];
      evidence.push({
        path: 'ProjectSettings/ProjectVersion.txt',
        detail: version === undefined ? 'Unity project version file' : `Unity editor ${cut(version)}`,
      });
      found.push({
        type: 'unity',
        confidence: 'confirmed',
        engine: 'Unity',
        ...(version === undefined ? {} : { engineVersion: cut(version) }),
      });
    }
  }

  // Godot: project.godot
  if (files.has('project.godot')) {
    const text = readSmallText(root, 'project.godot') ?? '';
    const features = /config\/features\s*=\s*PackedStringArray\(([^)]*)\)/.exec(text)?.[1] ?? '';
    const version = /"(\d+\.\d+(?:\.\d+)?)"/.exec(features)?.[1];
    evidence.push({
      path: 'project.godot',
      detail: version === undefined ? 'Godot project file' : `Godot project file, engine ${version}`,
    });
    found.push({
      type: 'godot',
      confidence: 'confirmed',
      engine: 'Godot',
      ...(version === undefined ? {} : { engineVersion: version }),
    });
  }

  // Web: package.json, with or without a Vite configuration
  if (files.has('package.json')) {
    const pkg = readJson(root, 'package.json');
    const viteConfig = [...files.values()].find((name) => VITE_CONFIG.test(name));
    const dependencies = { ...asRecord(pkg?.['dependencies']), ...asRecord(pkg?.['devDependencies']) };
    const viteRange = typeof dependencies['vite'] === 'string' ? dependencies['vite'] : undefined;
    if (viteConfig !== undefined || viteRange !== undefined) {
      if (viteConfig !== undefined) evidence.push({ path: viteConfig, detail: 'Vite configuration file' });
      evidence.push({
        path: 'package.json',
        detail:
          viteRange === undefined
            ? 'package.json (no vite dependency listed)'
            : `package.json depends on vite ${cut(viteRange)}`,
      });
      found.push({
        type: 'web-vite',
        confidence: 'confirmed',
        engine: 'Vite',
        ...(viteRange === undefined ? {} : { engineVersion: cut(viteRange) }),
      });
    } else {
      evidence.push({ path: 'package.json', detail: 'Node package, no Vite configuration or dependency' });
      found.push({ type: 'web', confidence: 'inferred' });
    }
  }

  // General code: .NET solutions and projects, and other build files
  const dotnet = [...named('.sln'), ...named('.csproj')][0];
  if (dotnet !== undefined) {
    evidence.push({ path: dotnet, detail: '.NET solution or project file' });
    found.push({ type: 'general-code', confidence: 'confirmed' });
  }
  for (const [lower, detail] of CODE_MARKERS) {
    const real = files.get(lower);
    if (real === undefined) continue;
    evidence.push({ path: real, detail });
    found.push({ type: 'general-code', confidence: 'confirmed' });
  }

  // Blender files alone do not make a code project, but they are worth showing.
  const blend = named('.blend')[0];
  if (blend !== undefined) {
    evidence.push({ path: blend, detail: 'Blender file' });
    found.push({ type: 'custom', confidence: 'inferred', engine: 'Blender' });
  }

  // Pick by priority, not by order of discovery. A Unity project also has a .sln; a game project may have web tooling.
  const priority: ProjectType[] = ['unreal', 'unity', 'godot', 'web-vite', 'general-code', 'web', 'custom'];
  const chosen = priority.map((type) => found.find((f) => f.type === type)).find((f) => f !== undefined);
  if (chosen === undefined) {
    return {
      type: 'custom',
      confidence: 'inferred',
      evidence: [{ path: '.', detail: 'No file that defines a known project type was found' }],
    };
  }
  return {
    type: chosen.type,
    ...(chosen.engine === undefined ? {} : { engine: chosen.engine }),
    ...(chosen.engineVersion === undefined ? {} : { engineVersion: chosen.engineVersion }),
    confidence: chosen.confidence,
    evidence: evidence.slice(0, 40),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
