import { basename, dirname, posix } from 'node:path';
import type { AuditEvidence, AuditSection, Finding, GitSummary, SectionId } from '@shared/audit';
import type { ProjectType } from '@shared/projects';
import type { ProjectReader } from './reader';
import type { ScanFile, ScanResult } from './scanner';

// The analyzers (spec §7). Each one turns the scanner's file list, plus a few small text files read through the
// ProjectReader, into findings. A finding is Confirmed only when a file proves it (and names that file); anything that is a
// reasonable reading rather than a fact is Inferred. Nothing here writes, and nothing opens a sensitive or binary file.

export interface AnalyzeInput {
  scan: ScanResult;
  reader: ProjectReader;
  git: GitSummary;
  /** The type the project is registered as (detected or chosen by the user). */
  projectType: ProjectType;
  /** Applied to every piece of text taken from a file before it is stored (command lines, TODO comments). */
  redact?: (text: string) => string;
}

const READ_BUDGET = { files: 600, bytes: 24 * 1024 * 1024, fileBytes: 128 * 1024 };
const HASH_BUDGET = { files: 400, fileBytes: 64 * 1024 * 1024, totalBytes: 1024 * 1024 * 1024 };
const MAX_FINDINGS = 60;

const confirmed = (title: string, evidence: AuditEvidence[], detail?: string, severity?: 'info' | 'warning'): Finding => ({
  kind: 'confirmed',
  title,
  ...(detail === undefined ? {} : { detail }),
  ...(severity === undefined ? {} : { severity }),
  evidence: evidence.slice(0, 40),
});
const inferred = (title: string, evidence: AuditEvidence[], detail?: string, severity?: 'info' | 'warning'): Finding => ({
  kind: 'inferred',
  title,
  ...(detail === undefined ? {} : { detail }),
  ...(severity === undefined ? {} : { severity }),
  evidence: evidence.slice(0, 40),
});
const at = (path: string, detail?: string, line?: number): AuditEvidence => ({
  path,
  ...(line === undefined ? {} : { line }),
  ...(detail === undefined ? {} : { detail }),
});
/** For a finding about the folder as a whole (no single file proves it). */
const whole = (detail: string): AuditEvidence[] => [{ path: '.', detail }];

const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const sizeText = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
};

const LANGUAGES: Record<string, string> = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.mts': 'TypeScript', '.cts': 'TypeScript',
  '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.py': 'Python', '.cs': 'C#', '.c': 'C', '.h': 'C/C++ header', '.hpp': 'C/C++ header', '.cpp': 'C++', '.cc': 'C++', '.cxx': 'C++',
  '.gd': 'GDScript', '.gdshader': 'Godot shader', '.rs': 'Rust', '.go': 'Go', '.java': 'Java', '.kt': 'Kotlin', '.lua': 'Lua',
  '.hlsl': 'Shader (HLSL)', '.usf': 'Shader (Unreal)', '.ush': 'Shader (Unreal)', '.glsl': 'Shader (GLSL)', '.shader': 'Shader (Unity)', '.wgsl': 'Shader (WGSL)',
  '.html': 'HTML', '.css': 'CSS', '.ps1': 'PowerShell', '.bat': 'Batch', '.cmd': 'Batch', '.sh': 'Shell',
};

const ASSET_CATEGORIES: Record<string, string[]> = {
  Textures: ['.png', '.jpg', '.jpeg', '.tga', '.dds', '.exr', '.hdr', '.psd', '.tif', '.tiff', '.webp', '.bmp', '.ktx', '.ktx2', '.svg'],
  'Models and animation': ['.fbx', '.obj', '.glb', '.gltf', '.blend', '.dae', '.usd', '.usdz', '.abc', '.3ds'],
  Audio: ['.wav', '.mp3', '.ogg', '.flac', '.aif', '.aiff', '.wem', '.bnk'],
  Video: ['.mp4', '.mov', '.webm', '.avi', '.mkv'],
  Fonts: ['.ttf', '.otf', '.woff', '.woff2'],
  'Engine assets': ['.uasset', '.umap', '.prefab', '.unity', '.tscn', '.tres', '.scn', '.mat', '.anim', '.controller', '.asset'],
};
const CATEGORY_OF = new Map<string, string>(Object.entries(ASSET_CATEGORIES).flatMap(([category, exts]) => exts.map((ext): [string, string] => [ext, category])));

export const TEXT_EXTENSIONS = new Set([
  ...Object.keys(LANGUAGES), '.md', '.txt', '.rst', '.json', '.toml', '.yml', '.yaml', '.ini', '.cfg', '.xml', '.cmake', '.gradle',
  '.tscn', '.tres', '.godot', '.uproject', '.uplugin', '.sln', '.csproj', '.vue', '.svelte', '.scss',
]);

const topFolder = (path: string): string => {
  const slash = path.indexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
};

/** Reads small text files through the reader within a fixed budget; anything refused or missing is simply skipped. */
function budgetedReader(reader: ProjectReader): (path: string, maxBytes?: number) => string | undefined {
  let files = 0;
  let bytes = 0;
  return (path, maxBytes = READ_BUDGET.fileBytes) => {
    if (files >= READ_BUDGET.files || bytes >= READ_BUDGET.bytes) return undefined;
    try {
      const text = reader.readText(path, maxBytes);
      files++;
      bytes += text.length;
      return text;
    } catch {
      return undefined; // sensitive, binary, too large or gone: not an audit failure
    }
  };
}

function parseJson(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\n').length;

type Read = (path: string, maxBytes?: number) => string | undefined;
interface Context extends AnalyzeInput {
  files: ScanFile[];
  byPath: Map<string, ScanFile>;
  read: Read;
  named: (pattern: RegExp) => ScanFile[];
}

// ---------------------------------------------------------------------------------------------------------------- overview

function overview({ scan, git }: Context): Finding[] {
  const { stats } = scan;
  const findings: Finding[] = [
    confirmed(
      `${plural(stats.files, 'file')} in ${plural(stats.directories, 'folder')}, ${sizeText(stats.bytes)} in total`,
      whole('Counted by the scanner (names and sizes only)'),
      stats.skippedHeavyDirs.length > 0
        ? `${plural(stats.skippedHeavyDirs.length, 'generated or engine-internal folder')} were skipped: ${stats.skippedHeavyDirs.slice(0, 8).join(', ')}${stats.skippedHeavyDirs.length > 8 ? ', …' : ''}.`
        : undefined,
    ),
  ];
  if (stats.truncated.length > 0)
    findings.push(
      confirmed(
        'The scan stopped early, so this report is incomplete',
        whole(`Limit reached: ${stats.truncated.join(', ')}`),
        'A limit on files, folder depth or time was reached. Counts below cover only what was scanned.',
        'warning',
      ),
    );
  if (stats.sensitiveFilesSkipped > 0)
    findings.push(
      confirmed(
        `${plural(stats.sensitiveFilesSkipped, 'file')} that may hold credentials were left unread`,
        scan.sensitivePaths.map((path) => at(path, 'Name matches the sensitive-file list; contents never read')),
        'Their names are shown; their contents are never opened, counted or included anywhere.',
      ),
    );
  if (stats.linksSkipped > 0)
    findings.push(confirmed(`${plural(stats.linksSkipped, 'link')} (shortcuts or junctions) were not followed`, whole('Links are reported, never followed')));
  if (!git.isRepository) findings.push(inferred('The project is not under version control', whole(git.message ?? 'Git reported no repository'), undefined, 'warning'));
  return findings;
}

// ------------------------------------------------------------------------------------------------------------------ engine

function engine(ctx: Context): Finding[] {
  const findings: Finding[] = [];
  const { read, named, projectType } = ctx;

  for (const file of named(/\.uproject$/i).slice(0, 5)) {
    const json = parseJson(read(file.path));
    const association = json?.['EngineAssociation'];
    const modules = Array.isArray(json?.['Modules']) ? (json['Modules'] as unknown[]).map((m) => record(m)['Name']).filter((n): n is string => typeof n === 'string') : [];
    findings.push(
      confirmed(
        typeof association === 'string' && association !== ''
          ? `Unreal Engine project, engine association ${association}`
          : 'Unreal Engine project (engine association not stated)',
        [at(file.path, 'Unreal project file')],
        modules.length > 0 ? `Code modules: ${modules.join(', ')}.` : 'No C++ modules are listed, so this looks like a Blueprint-only project.',
      ),
    );
  }
  for (const file of named(/(^|\/)ProjectSettings\/ProjectVersion\.txt$/i).slice(0, 3)) {
    const version = /m_EditorVersion:\s*(\S+)/.exec(read(file.path, 4096) ?? '')?.[1];
    findings.push(confirmed(version === undefined ? 'Unity project' : `Unity project, editor ${version}`, [at(file.path, 'Unity project version file')]));
  }
  for (const file of named(/(^|\/)project\.godot$/i).slice(0, 3)) {
    const text = read(file.path) ?? '';
    const version = /config\/features\s*=\s*PackedStringArray\(([^)]*)\)/.exec(text)?.[1]?.match(/"(\d+\.\d+(?:\.\d+)?)"/)?.[1];
    const name = /config\/name\s*=\s*"([^"]*)"/.exec(text)?.[1];
    findings.push(
      confirmed(
        version === undefined ? 'Godot project' : `Godot project, engine ${version}`,
        [at(file.path, 'Godot project file')],
        name === undefined ? undefined : `Project name in the file: ${name}.`,
      ),
    );
  }
  for (const file of named(/(^|\/)package\.json$/i).slice(0, 8)) {
    const pkg = parseJson(read(file.path));
    if (pkg === undefined) continue;
    const deps = { ...record(pkg['dependencies']), ...record(pkg['devDependencies']) };
    const known = ['electron', 'react', 'vue', 'svelte', 'vite', 'webpack', 'typescript', 'three', 'phaser', 'pixi.js', '@babylonjs/core', 'playwright', 'vitest', 'jest'];
    const found = known.filter((name) => typeof deps[name] === 'string').map((name) => `${name} ${String(deps[name])}`);
    if (found.length > 0) findings.push(confirmed(`Node project using ${found.slice(0, 6).map((f) => f.split(' ')[0]).join(', ')}`, [at(file.path, found.join(', '))]));
  }
  if (findings.length === 0)
    findings.push(inferred('No engine or framework was identified from the files', whole('No .uproject, project.godot, ProjectVersion.txt or recognized package.json found'), undefined, 'warning'));

  // Registered type versus what the files say (the user may have chosen the type by hand).
  const evidenceText = findings.map((f) => f.title).join(' ');
  const mismatch =
    (projectType === 'unreal' && !/Unreal/.test(evidenceText)) ||
    (projectType === 'unity' && !/Unity/.test(evidenceText)) ||
    (projectType === 'godot' && !/Godot/.test(evidenceText));
  if (mismatch)
    findings.push(inferred('The registered project type is not backed by any file found in the scan', whole(`Registered as ${projectType}`), 'The type was set by hand or the defining file sits in a skipped folder.', 'warning'));
  return findings;
}

// --------------------------------------------------------------------------------------------------------------- languages

function languages({ files }: Context): Finding[] {
  const totals = new Map<string, { files: number; bytes: number; sample: string[] }>();
  for (const file of files) {
    const language = LANGUAGES[file.ext];
    if (language === undefined) continue;
    const entry = totals.get(language) ?? { files: 0, bytes: 0, sample: [] };
    entry.files++;
    entry.bytes += file.size;
    if (entry.sample.length < 3) entry.sample.push(file.path);
    totals.set(language, entry);
  }
  const sorted = [...totals.entries()].sort((a, b) => b[1].files - a[1].files);
  if (sorted.length === 0) return [inferred('No source code files were found', whole('No file with a known code extension'))];
  return sorted.map(([language, entry]) =>
    confirmed(`${language}: ${plural(entry.files, 'file')}, ${sizeText(entry.bytes)}`, entry.sample.map((path) => at(path, 'Example'))),
  );
}

// ------------------------------------------------------------------------------------------------------------------ structure

function structure({ files }: Context): Finding[] {
  const folders = new Map<string, { files: number; bytes: number }>();
  let rootFiles = 0;
  for (const file of files) {
    const top = topFolder(file.path);
    if (top === '') {
      rootFiles++;
      continue;
    }
    const entry = folders.get(top) ?? { files: 0, bytes: 0 };
    entry.files++;
    entry.bytes += file.size;
    folders.set(top, entry);
  }
  const findings = [...folders.entries()]
    .sort((a, b) => b[1].files - a[1].files)
    .slice(0, MAX_FINDINGS)
    .map(([folder, entry]) => confirmed(`${folder}/ holds ${plural(entry.files, 'file')} (${sizeText(entry.bytes)})`, [at(`${folder}/`, 'Top-level folder')]));
  if (rootFiles > 0) findings.unshift(confirmed(`${plural(rootFiles, 'file')} sit directly in the project folder`, whole('Counted by the scanner')));
  return findings;
}

// ------------------------------------------------------------------------------------------------------------- entry points

function entryPoints(ctx: Context): Finding[] {
  const { files, named, read } = ctx;
  const findings: Finding[] = [];

  for (const file of named(/(^|\/)package\.json$/i).slice(0, 6)) {
    const pkg = parseJson(read(file.path));
    for (const key of ['main', 'module', 'bin']) {
      const value = pkg?.[key];
      if (typeof value === 'string') findings.push(confirmed(`package.json "${key}" points to ${value}`, [at(file.path, `"${key}": "${value}"`)]));
    }
  }
  for (const file of named(/(^|\/)project\.godot$/i).slice(0, 2)) {
    const text = read(file.path) ?? '';
    const match = /run\/main_scene\s*=\s*"([^"]+)"/.exec(text);
    if (match?.[1] !== undefined) findings.push(confirmed(`Godot main scene: ${match[1]}`, [at(file.path, 'run/main_scene', lineOf(text, match.index))]));
  }
  for (const file of named(/\.uproject$/i).slice(0, 2)) {
    const modules = parseJson(read(file.path))?.['Modules'];
    if (Array.isArray(modules))
      for (const module of modules.slice(0, 10)) {
        const name = record(module)['Name'];
        if (typeof name === 'string') findings.push(confirmed(`Unreal module ${name}`, [at(file.path, 'Listed under Modules')]));
      }
  }
  for (const file of named(/\.Target\.cs$/i).slice(0, 6)) findings.push(confirmed(`Unreal build target ${basename(file.path, '.cs')}`, [at(file.path, 'Target file')]));
  for (const file of named(/(^|\/)Config\/DefaultEngine\.ini$/i).slice(0, 1)) {
    const text = read(file.path) ?? '';
    for (const key of ['GameDefaultMap', 'EditorStartupMap']) {
      const match = new RegExp(`^${key}\\s*=\\s*(\\S+)`, 'm').exec(text);
      if (match?.[1] !== undefined) findings.push(confirmed(`Unreal ${key}: ${match[1]}`, [at(file.path, key, lineOf(text, match.index))]));
    }
  }
  for (const file of named(/(^|\/)ProjectSettings\/EditorBuildSettings\.asset$/i).slice(0, 1)) {
    const text = read(file.path) ?? '';
    const scenes = [...text.matchAll(/path:\s*(\S+\.unity)/g)].map((m) => m[1]).filter((s): s is string => s !== undefined);
    if (scenes.length > 0) findings.push(confirmed(`Unity scenes in the build: ${scenes.slice(0, 6).join(', ')}`, [at(file.path, 'EditorBuildSettings')]));
  }

  // Guesses from names alone.
  const guess = /^(main|index|app|program|game|startup)\.[a-z]+$/i;
  const guessed = files.filter((f) => f.path.split('/').length <= 3 && guess.test(basename(f.path)) && LANGUAGES[f.ext] !== undefined).slice(0, 12);
  for (const file of guessed) findings.push(inferred(`${file.path} looks like an entry point`, [at(file.path, 'Named like an entry point')]));
  if (findings.length === 0) findings.push(inferred('No entry point was identified', whole('No file states a main scene, module or entry file')));
  return findings;
}

// -------------------------------------------------------------------------------------------------------------- documentation

function documentation({ files }: Context): Finding[] {
  const findings: Finding[] = [];
  const rootDoc = /^(readme|license|licence|changelog|contributing|claude|agents|gemini|notice|security|code_of_conduct)(\.[a-z]+)?$/i;
  const inDocs = /^(docs?|documentation|design|wiki)\//i;
  const named = /(design|gdd|roadmap|todo|notes|architecture|spec|plan)/i;
  const docs = files.filter((f) => {
    const isDocExt = ['.md', '.txt', '.rst', '.adoc'].includes(f.ext) || f.ext === '';
    if (!isDocExt) return false;
    if (!f.path.includes('/')) return rootDoc.test(basename(f.path)) || (f.ext === '.md' || f.ext === '.rst');
    return inDocs.test(f.path) || (['.md', '.rst'].includes(f.ext) && named.test(basename(f.path)));
  });
  for (const file of docs.slice(0, MAX_FINDINGS)) findings.push(confirmed(`${file.path} (${sizeText(file.size)})`, [at(file.path, 'Documentation file')]));
  if (docs.length > MAX_FINDINGS) findings.push(confirmed(`${plural(docs.length - MAX_FINDINGS, 'more documentation file')} not listed`, whole('Capped for readability')));
  if (docs.length === 0) findings.push(inferred('No documentation files were found', whole('No README, docs folder or design notes'), undefined, 'warning'));
  return findings;
}

// ---------------------------------------------------------------------------------------------------------------- commands

function commands(ctx: Context): Finding[] {
  const { files, named, read, redact = (t) => t } = ctx;
  const findings: Finding[] = [];

  for (const file of named(/(^|\/)package\.json$/i).slice(0, 6)) {
    const scripts = record(parseJson(read(file.path))?.['scripts']);
    for (const [name, command] of Object.entries(scripts).slice(0, 30))
      if (typeof command === 'string') findings.push(confirmed(`npm run ${name}`, [at(file.path, redact(command).slice(0, 200))], 'Defined in package.json scripts.'));
  }
  for (const file of named(/(^|\/)makefile$/i).slice(0, 2)) {
    const text = read(file.path) ?? '';
    for (const match of [...text.matchAll(/^([A-Za-z0-9_.-]+)\s*:(?!=)/gm)].slice(0, 20))
      findings.push(confirmed(`make ${match[1]}`, [at(file.path, 'Makefile target', lineOf(text, match.index))]));
  }
  const scriptFiles = files.filter((f) => ['.bat', '.cmd', '.ps1', '.sh'].includes(f.ext) && f.path.split('/').length <= 3).slice(0, 20);
  for (const file of scriptFiles) findings.push(confirmed(`Script file ${file.path}`, [at(file.path, 'Present in the folder; what it does is not analyzed')]));

  const marker = (re: RegExp, command: string, why: string): void => {
    const hit = files.find((f) => re.test(f.path) && !f.path.includes('/'));
    if (hit !== undefined) findings.push(inferred(command, [at(hit.path, why)], 'Usual command for this kind of project; nothing in the folder states it.'));
  };
  marker(/^cargo\.toml$/i, 'cargo build / cargo test', 'Cargo.toml');
  marker(/\.sln$/i, 'dotnet build', 'Solution file');
  marker(/^go\.mod$/i, 'go build / go test', 'go.mod');
  marker(/^pyproject\.toml$/i, 'python -m pytest (if tests exist)', 'pyproject.toml');

  const tests = files.filter((f) => /(^|\/)(tests?|__tests__|spec)\//i.test(f.path) || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(f.path) || /(^|\/)test_[^/]+\.py$/i.test(f.path));
  if (tests.length > 0) findings.push(confirmed(`${plural(tests.length, 'test file')} found`, tests.slice(0, 10).map((f) => at(f.path, 'Test file'))));
  if (findings.length === 0) findings.push(inferred('No build or test command was found in the folder', whole('No package.json scripts, Makefile or script files')));
  return findings;
}

// ------------------------------------------------------------------------------------------------------------------- assets

function assets({ files }: Context): Finding[] {
  const byCategory = new Map<string, { files: number; bytes: number; exts: Map<string, number> }>();
  const folders = new Map<string, { files: number; bytes: number }>();
  for (const file of files) {
    const category = CATEGORY_OF.get(file.ext);
    if (category === undefined) continue;
    const entry = byCategory.get(category) ?? { files: 0, bytes: 0, exts: new Map() };
    entry.files++;
    entry.bytes += file.size;
    entry.exts.set(file.ext, ((entry.exts.get(file.ext) as number | undefined) ?? 0) + 1);
    byCategory.set(category, entry);
    const folder = dirname(file.path).split(/[\\/]/).slice(0, 3).join('/');
    const f = folders.get(folder) ?? { files: 0, bytes: 0 };
    f.files++;
    f.bytes += file.size;
    folders.set(folder, f);
  }
  if (byCategory.size === 0) return [inferred('No asset files (textures, models, audio, video, fonts, engine assets) were found', whole('No file with a known asset extension'))];
  const findings = [...byCategory.entries()]
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .map(([category, entry]) =>
      confirmed(
        `${category}: ${plural(entry.files, 'file')}, ${sizeText(entry.bytes)}`,
        whole(`By extension: ${[...entry.exts.entries()].sort((a, b) => b[1] - a[1]).map(([ext, n]) => `${ext} ${n}`).join(', ')}`),
      ),
    );
  for (const [folder, entry] of [...folders.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 15))
    findings.push(confirmed(`Asset folder ${folder === '.' ? '(project root)' : folder}/: ${plural(entry.files, 'asset')}, ${sizeText(entry.bytes)}`, [at(folder === '.' ? '.' : `${folder}/`, 'Folder holding asset files')]));
  return findings;
}

// --------------------------------------------------------------------------------------------------------------------- git

function gitSection({ git }: Context): Finding[] {
  if (!git.available) return [confirmed('Git is not installed or could not be run', whole(git.message ?? 'Git not found'), undefined, 'warning')];
  if (!git.isRepository) return [confirmed(git.message ?? 'Not a Git repository.', whole('git rev-parse --is-inside-work-tree'), 'Version control history is not available for this folder.', 'warning')];
  const findings: Finding[] = [];
  const evidence = [at('.git', 'Read with read-only Git commands')];
  findings.push(confirmed(`Branch ${git.branch ?? '(unknown)'}${git.upstream === undefined ? ', no upstream set' : ` tracking ${git.upstream}`}`, evidence));
  if (git.ahead !== undefined && git.behind !== undefined && (git.ahead > 0 || git.behind > 0))
    findings.push(confirmed(`${git.ahead} commit(s) ahead and ${git.behind} behind ${git.upstream ?? 'upstream'}`, evidence));
  const c = git.changes;
  if (c !== undefined) {
    const total = c.staged + c.modified + c.untracked + c.conflicted;
    findings.push(
      confirmed(
        total === 0 ? 'The working tree is clean' : `${plural(total, 'uncommitted change')}: ${c.staged} staged, ${c.modified} modified, ${c.untracked} untracked${c.conflicted > 0 ? `, ${c.conflicted} in conflict` : ''}`,
        evidence,
        undefined,
        c.conflicted > 0 || total > 50 ? 'warning' : 'info',
      ),
    );
  }
  for (const commit of (git.recentCommits ?? []).slice(0, 10)) findings.push(confirmed(`${commit.hash.slice(0, 8)} ${commit.subject}`, evidence, `${commit.author}, ${commit.date}`));
  if ((git.recentCommits ?? []).length === 0) findings.push(confirmed('The repository has no commits yet', evidence, undefined, 'warning'));
  return findings;
}

// ------------------------------------------------------------------------------------------------------------ unfinished work

const MARKER = /\b(TODO|FIXME|HACK)\b[:\s(-]*(.{0,140})/;

function unfinished(ctx: Context): Finding[] {
  const { files, read, redact = (t) => t } = ctx;
  const findings: Finding[] = [];
  let total = 0;
  const candidates = files.filter((f) => TEXT_EXTENSIONS.has(f.ext) && f.size > 0 && f.size <= READ_BUDGET.fileBytes && !['.json', '.xml', '.sln', '.csproj'].includes(f.ext));
  for (const file of candidates) {
    const text = read(file.path);
    if (text === undefined) continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      const match = MARKER.exec(line);
      if (match?.[1] !== undefined) {
        total++;
        if (findings.length < MAX_FINDINGS) findings.push(confirmed(`${match[1]}: ${redact((match[2] ?? '').trim()) || '(no text)'}`, [at(file.path, undefined, i + 1)]));
      } else if (file.ext === '.md' && /^\s*[-*]\s+\[ \]\s+\S/.test(line)) {
        total++;
        if (findings.length < MAX_FINDINGS) findings.push(confirmed(`Open checklist item: ${redact(line.replace(/^\s*[-*]\s+\[ \]\s+/, '').trim()).slice(0, 140)}`, [at(file.path, undefined, i + 1)]));
      }
    }
  }
  if (total > findings.length) findings.push(confirmed(`${plural(total - findings.length, 'more marker')} not listed`, whole('Capped for readability')));
  if (total === 0) findings.push(inferred('No TODO, FIXME or open checklist items were found in the text files scanned', whole('Searched code and documentation files up to 128 KB')));
  return findings;
}

// -------------------------------------------------------------------------------------------------------------- relationships

const IMPORT_PATTERNS: { ext: RegExp; re: RegExp }[] = [
  { ext: /\.(?:[cm]?[jt]sx?|vue|svelte)$/i, re: /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"](\.{1,2}\/[^'"]+)['"]/g },
  { ext: /\.(?:c|cc|cpp|cxx|h|hpp)$/i, re: /^\s*#\s*include\s+"([^"]+)"/gm },
  { ext: /\.gd$/i, re: /\b(?:preload|load)\s*\(\s*"(res:\/\/[^"]+)"/g },
  { ext: /\.(?:tscn|tres)$/i, re: /\bpath="(res:\/\/[^"]+)"/g },
  { ext: /\.py$/i, re: /^\s*from\s+(\.[\w.]*)\s+import\b/gm },
];

function resolveTarget(from: string, target: string, byPath: Map<string, ScanFile>, byName: Map<string, string[]>): string | undefined {
  const candidates: string[] = [];
  if (target.startsWith('res://')) candidates.push(target.slice('res://'.length));
  else if (target.startsWith('.')) {
    if (/^\.+[\w.]*$/.test(target) && !target.includes('/')) {
      const dots = /^\.+/.exec(target)?.[0].length ?? 1; // Python relative import: from .pkg import x
      const base = posix.join(dirname(from), ...Array<string>(dots - 1).fill('..'), target.slice(dots).replace(/\./g, '/'));
      candidates.push(`${base}.py`, `${base}/__init__.py`);
    } else candidates.push(posix.join(dirname(from), target));
  } else {
    candidates.push(posix.join(dirname(from), target)); // C/C++ quoted include: relative to the including file first
    const hits = byName.get(basename(target).toLowerCase());
    if (hits?.length === 1 && hits[0] !== undefined) candidates.push(hits[0]);
  }
  for (const candidate of candidates) {
    for (const suffix of ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '/index.ts', '/index.tsx', '/index.js']) {
      if (byPath.has(candidate + suffix)) return candidate + suffix;
    }
  }
  return undefined;
}

function relationships(ctx: Context): Finding[] {
  const { files, byPath, read } = ctx;
  const byName = new Map<string, string[]>();
  for (const file of files) {
    const key = basename(file.path).toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), file.path]);
  }
  const incoming = new Map<string, Set<string>>();
  let edges = 0;
  for (const file of files) {
    const patterns = IMPORT_PATTERNS.filter((p) => p.ext.test(file.path));
    if (patterns.length === 0 || file.size > READ_BUDGET.fileBytes) continue;
    const text = read(file.path);
    if (text === undefined) continue;
    for (const { re } of patterns) {
      for (const match of text.matchAll(re)) {
        const target = match[1];
        if (target === undefined) continue;
        const resolved = resolveTarget(file.path, target, byPath, byName);
        if (resolved === undefined || resolved === file.path) continue;
        const set = incoming.get(resolved) ?? new Set<string>();
        if (!set.has(file.path)) edges++;
        set.add(file.path);
        incoming.set(resolved, set);
      }
    }
  }
  if (edges === 0) return [inferred('No import or include relationships between project files were found', whole('Checked JavaScript/TypeScript imports, C/C++ includes, GDScript loads, Godot scene references and Python relative imports'))];
  const top = [...incoming.entries()].sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0])).slice(0, 12);
  return [
    inferred(`${plural(edges, 'file-to-file reference')} found by reading import and include lines`, whole('Heuristic: dynamic and generated references are not seen'), `${plural(incoming.size, 'file')} are referenced by at least one other file.`),
    ...top.map(([path, users]) => inferred(`${path} is used by ${plural(users.size, 'other file')}`, [at(path, 'Most-referenced files are likely core modules'), ...[...users].slice(0, 5).map((u) => at(u, 'References it'))])),
  ];
}

// ------------------------------------------------------------------------------------------------------------------ duplicates

function duplicates(ctx: Context): Finding[] {
  const { files, reader } = ctx;
  const bySize = new Map<number, ScanFile[]>();
  for (const file of files) {
    if (file.size === 0 || file.size > HASH_BUDGET.fileBytes) continue;
    bySize.set(file.size, [...(bySize.get(file.size) ?? []), file]);
  }
  const candidates = [...bySize.values()].filter((group) => group.length > 1).flat().sort((a, b) => b.size - a.size);
  const groups = new Map<string, ScanFile[]>();
  let hashed = 0;
  let hashedBytes = 0;
  let capped = false;
  for (const file of candidates) {
    if (hashed >= HASH_BUDGET.files || hashedBytes + file.size > HASH_BUDGET.totalBytes) {
      capped = true;
      break;
    }
    try {
      const digest = reader.hash(file.path, HASH_BUDGET.fileBytes);
      hashed++;
      hashedBytes += file.size;
      groups.set(digest, [...(groups.get(digest) ?? []), file]);
    } catch {
      // vanished, sensitive or changed while scanning: not a duplicate we can prove
    }
  }
  const findings = [...groups.values()]
    .filter((group) => group.length > 1)
    .sort((a, b) => (b[0]?.size ?? 0) * (b.length - 1) - (a[0]?.size ?? 0) * (a.length - 1))
    .slice(0, MAX_FINDINGS)
    .map((group) =>
      confirmed(
        `${group.length} identical copies of a ${sizeText(group[0]?.size ?? 0)} file`,
        group.map((f) => at(f.path, 'Same content (SHA-256)')),
        `${sizeText((group[0]?.size ?? 0) * (group.length - 1))} could be saved.`,
      ),
    );
  if (capped) findings.push(confirmed('Only the largest candidates were compared', whole('A limit on files compared or bytes read was reached'), undefined, 'warning'));
  if (findings.length === 0) findings.push(inferred('No identical files were found among the files compared', whole(`${plural(hashed, 'file')} with a same-sized sibling were compared`)));
  return findings;
}

// --------------------------------------------------------------------------------------------------------------------- risks

function risks(ctx: Context, sections: AuditSection[]): Finding[] {
  const { files, scan, git, named } = ctx;
  const findings: Finding[] = [];
  const hasDoc = !sections.find((s) => s.id === 'documentation')?.findings.some((f) => f.title.startsWith('No documentation'));
  if (!hasDoc) findings.push(inferred('There is no README or design document, so a newcomer or an AI agent has little to go on', whole('No documentation files'), undefined, 'warning'));
  const hasTests = sections.find((s) => s.id === 'commands')?.findings.some((f) => f.title.endsWith('found') && f.title.includes('test file'));
  if (hasTests === false || hasTests === undefined) findings.push(inferred('No automated tests were found', whole('No test folders or *.test / *.spec files'), 'Changes made by AI agents cannot be checked automatically.', 'warning'));
  if (!git.isRepository) findings.push(inferred('No version control: a bad change could not be rolled back', whole(git.message ?? 'Not a Git repository'), 'Step 15 offers to run git init, with your approval.', 'warning'));
  else {
    const c = git.changes;
    if (c !== undefined && c.staged + c.modified > 0) findings.push(confirmed('There is uncommitted work', [at('.git', `${c.staged} staged, ${c.modified} modified`)], 'Commit or stash it before an agent edits files.', 'warning'));
    if (!files.some((f) => f.path === '.gitignore')) findings.push(confirmed('The repository has no .gitignore', [at('.git', 'Repository present, .gitignore absent')], 'Generated files may end up in version control.', 'warning'));
  }
  const big = files.filter((f) => f.size >= 100 * 1024 * 1024).sort((a, b) => b.size - a.size);
  if (big.length > 0) {
    const lfs = named(/(^|\/)\.gitattributes$/i).length > 0;
    findings.push(confirmed(`${plural(big.length, 'file')} over 100 MB`, big.slice(0, 10).map((f) => at(f.path, sizeText(f.size))), lfs ? 'A .gitattributes file exists; check that these are tracked with Git LFS.' : 'Git handles files this large badly, and there is no .gitattributes for Git LFS.', 'warning'));
  }
  if (scan.sensitivePaths.length > 0) findings.push(confirmed('Files that may hold credentials sit inside the project', scan.sensitivePaths.slice(0, 20).map((p) => at(p, 'Never read by this app')), 'Make sure they are listed in .gitignore and never pasted into prompts.', 'warning'));
  if (scan.stats.truncated.length > 0) findings.push(confirmed('The scan was cut short, so some risks may be missing', whole(`Limit reached: ${scan.stats.truncated.join(', ')}`), undefined, 'warning'));
  if (findings.length === 0) findings.push(inferred('No risks were found by these checks', whole('Checked documentation, tests, version control, large files and sensitive files')));
  return findings;
}

// ---------------------------------------------------------------------------------------------------------------------- run

const SECTIONS: readonly { id: SectionId; title: string; run: (ctx: Context) => Finding[]; summary: (findings: Finding[]) => string }[] = [
  { id: 'overview', title: 'Overview', run: overview, summary: (f) => `${f.length} fact${f.length === 1 ? '' : 's'} about the folder and the scan.` },
  { id: 'engine', title: 'Engine and version', run: engine, summary: (f) => f[0]?.title ?? '' },
  { id: 'languages', title: 'Languages', run: languages, summary: (f) => f[0]?.title ?? '' },
  { id: 'structure', title: 'Major folders', run: structure, summary: (f) => `${f.length} top-level entries.` },
  { id: 'entry-points', title: 'Entry points', run: entryPoints, summary: (f) => f[0]?.title ?? '' },
  { id: 'documentation', title: 'Existing documentation', run: documentation, summary: (f) => (f[0]?.kind === 'inferred' ? f[0].title : `${f.length} documentation file(s).`) },
  { id: 'commands', title: 'Build and test commands', run: commands, summary: (f) => `${f.length} command(s) or script(s) present.` },
  { id: 'assets', title: 'Assets', run: assets, summary: (f) => f[0]?.title ?? '' },
  { id: 'git', title: 'Git', run: gitSection, summary: (f) => f[0]?.title ?? '' },
  { id: 'unfinished', title: 'Documented unfinished work', run: unfinished, summary: (f) => f[0]?.title ?? '' },
  { id: 'relationships', title: 'File relationships (heuristic)', run: relationships, summary: (f) => f[0]?.title ?? '' },
  { id: 'duplicates', title: 'Identical files', run: duplicates, summary: (f) => f[0]?.title ?? '' },
];

/** Runs every analyzer. A failing analyzer yields one warning in its own section instead of losing the whole report. */
export function analyze(input: AnalyzeInput): AuditSection[] {
  const redact = input.redact ?? ((text: string) => text);
  const files = input.scan.files;
  const ctx: Context = {
    ...input,
    files,
    byPath: new Map(files.map((f) => [f.path, f])),
    read: budgetedReader(input.reader),
    named: (pattern) => files.filter((f) => pattern.test(f.path)),
  };
  const clean = (finding: Finding): Finding => ({
    ...finding,
    title: redact(finding.title).slice(0, 400),
    ...(finding.detail === undefined ? {} : { detail: redact(finding.detail).slice(0, 1500) }),
    evidence: finding.evidence.map((e) => ({ ...e, path: e.path.slice(0, 400), ...(e.detail === undefined ? {} : { detail: redact(e.detail).slice(0, 300) }) })),
  });

  const sections: AuditSection[] = [];
  for (const section of SECTIONS) {
    let findings: Finding[];
    try {
      findings = section.run(ctx);
    } catch (error) {
      findings = [inferred(`This check could not finish: ${error instanceof Error ? error.message : 'unknown error'}`, whole('Analyzer error'), undefined, 'warning')];
    }
    findings = findings.map(clean).slice(0, 300);
    sections.push({ id: section.id, title: section.title, summary: redact(section.summary(findings)).slice(0, 600), findings });
  }
  const riskFindings = risks(ctx, sections).map(clean);
  sections.push({ id: 'risks', title: 'Risks and missing information', summary: `${riskFindings.filter((f) => f.severity === 'warning').length} warning(s).`, findings: riskFindings });
  return sections;
}

