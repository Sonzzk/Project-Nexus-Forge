import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { PACKAGE_MANAGERS, type PackageManagerInfo, type PackageManagerName, type WebProject } from '@shared/web';

// Reads a web project from its files (spec §16 Vite): package.json, the lockfile, the Vite config and the installed versions in
// node_modules. Nothing is run and nothing is installed; a package's own package.json is read only for its version.

export type WebProjectFacts = Omit<WebProject, 'scripts'>;

const MAX_JSON_BYTES = 1024 * 1024;
const MAX_DEPENDENCIES = 300;
const VITE_CONFIGS = ['vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.mts', 'vite.config.cjs', 'vite.config.cts'];
/** Lockfile name to package manager, in the order they are checked. bun.lockb is Bun's older binary lockfile. */
export const LOCKFILES: readonly { file: string; manager: PackageManagerName }[] = [
  { file: 'pnpm-lock.yaml', manager: 'pnpm' },
  { file: 'yarn.lock', manager: 'yarn' },
  { file: 'bun.lock', manager: 'bun' },
  { file: 'bun.lockb', manager: 'bun' },
  { file: 'package-lock.json', manager: 'npm' },
  { file: 'npm-shrinkwrap.json', manager: 'npm' },
];
const FRAMEWORKS: Record<string, string> = {
  react: 'React',
  vue: 'Vue',
  svelte: 'Svelte',
  'solid-js': 'Solid',
  preact: 'Preact',
  lit: 'Lit',
  phaser: 'Phaser',
  three: 'three.js',
  'pixi.js': 'PixiJS',
  '@babylonjs/core': 'Babylon.js',
  kaplay: 'Kaplay',
  excalibur: 'Excalibur',
  playcanvas: 'PlayCanvas',
  'matter-js': 'Matter.js',
};
/** A package name as npm allows it, so a name read from package.json can never point outside node_modules. */
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;

function readJson(path: string, maxBytes = MAX_JSON_BYTES): Record<string, unknown> | undefined {
  try {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.size > maxBytes) return undefined;
    const value: unknown = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const record = (value: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) for (const [k, v] of Object.entries(value)) if (typeof v === 'string') out[k] = v;
  return out;
};

/** The package manager the project uses: its `packageManager` field first, then its lockfile; never a guess when two lockfiles disagree. */
export function detectPackageManager(root: string, pkg: Record<string, unknown>): PackageManagerInfo {
  const field = /^(npm|pnpm|yarn|bun)@([^+\s]+)/.exec(text(pkg['packageManager']) ?? '');
  const present = LOCKFILES.filter((l) => existsSync(join(root, l.file)));
  const managers = new Set(present.map((l) => l.manager));
  if (field?.[1] !== undefined && (PACKAGE_MANAGERS as readonly string[]).includes(field[1])) {
    const name = field[1] as PackageManagerName;
    return { name, source: 'packageManager-field', lockfile: present.find((l) => l.manager === name)?.file ?? null, version: field[2] ?? null, ambiguous: false };
  }
  if (present.length === 0) return { name: 'npm', source: 'default', lockfile: null, version: null, ambiguous: false };
  const first = present[0];
  return { name: first?.manager ?? 'npm', source: 'lockfile', lockfile: first?.file ?? null, version: null, ambiguous: managers.size > 1 };
}

/** Whether yarn.lock was written by Yarn 2 or newer (its first lines carry a `__metadata` block). */
export function yarnIsBerry(root: string): boolean {
  try {
    return /^__metadata:/m.test(readFileSync(join(root, 'yarn.lock'), 'utf8').slice(0, 2048));
  } catch {
    return false;
  }
}

function installedVersion(root: string, name: string): string | null {
  if (!PACKAGE_NAME.test(name)) return null;
  const version = readJson(join(root, 'node_modules', name, 'package.json'), 256 * 1024)?.['version'];
  return typeof version === 'string' ? version.slice(0, 60) : null;
}

/** A web project's facts, or undefined when the folder has no readable package.json. */
export function describeWebProject(root: string): WebProjectFacts | undefined {
  const pkg = readJson(join(root, 'package.json'));
  if (pkg === undefined) return undefined;
  const notes: string[] = [];
  const dependencies = record(pkg['dependencies']);
  const devDependencies = record(pkg['devDependencies']);
  const names = [...new Set([...Object.keys(dependencies), ...Object.keys(devDependencies)])].sort();
  const hasModules = (() => {
    try {
      const stats = lstatSync(join(root, 'node_modules'));
      return stats.isDirectory() && !stats.isSymbolicLink();
    } catch {
      return false;
    }
  })();
  const manager = detectPackageManager(root, pkg);
  const viteRange = dependencies['vite'] ?? devDependencies['vite'] ?? null;
  const viteConfig = VITE_CONFIGS.find((f) => existsSync(join(root, f))) ?? null;
  if (!hasModules && names.length > 0) notes.push('Dependencies are not installed (there is no node_modules folder), so scripts that need them will fail until they are installed.');
  if (manager.lockfile === null) notes.push('There is no lockfile, so this app offers no install command: it never runs one that could pick new versions.');
  if (manager.ambiguous) notes.push('More than one lockfile exists and package.json does not name a package manager, so scripts run with npm and no install command is offered.');
  return {
    name: text(pkg['name']) ?? basename(root),
    version: text(pkg['version']),
    private: pkg['private'] === true,
    moduleType: pkg['type'] === 'module' ? 'module' : 'commonjs',
    packageManager: manager,
    viteConfig,
    vite: { range: viteRange, installed: hasModules ? installedVersion(root, 'vite') : null },
    frameworks: names.filter((n) => FRAMEWORKS[n] !== undefined).map((n) => FRAMEWORKS[n] ?? n),
    nodeEngine: text(record(pkg['engines'])['node']),
    dependencies: names.slice(0, MAX_DEPENDENCIES).map((name) => ({ name, range: (dependencies[name] ?? devDependencies[name] ?? '').slice(0, 200), dev: dependencies[name] === undefined, installed: hasModules ? installedVersion(root, name) : null })),
    dependencyCount: names.length,
    nodeModules: hasModules,
    notes,
  };
}
