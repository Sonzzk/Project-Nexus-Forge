import { z } from 'zod';
import { CapabilitySchema } from './unreal';

// Vite and web games (spec §16 Vite). Everything is read from the project's package.json, its lockfile and its Vite config; the page
// names a project and a script label, and main runs only scripts it listed and the person approved.

export const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn', 'bun'] as const;
export type PackageManagerName = (typeof PACKAGE_MANAGERS)[number];

export const SCRIPT_KINDS = ['dev', 'preview', 'build', 'lint', 'typecheck', 'test', 'other'] as const;
export type ScriptKind = (typeof SCRIPT_KINDS)[number];

/**
 * What a package.json script is for, from its name and then its text. A script that starts a server (`dev`, `preview`, `serve`,
 * `start`, or a bare `vite`) keeps running until stopped; every other kind runs to completion. Only a guide: the person's approval
 * is bound to the script text, not to this label.
 */
export function classifyScript(name: string, body: string): ScriptKind {
  const text = body.toLowerCase();
  const lower = name.toLowerCase();
  const word = (w: string): boolean => new RegExp(String.raw`(?<![\w-])(?:${w})(?![\w-])`).test(text);
  const vite = (sub: string): boolean => new RegExp(String.raw`(?<![\w-])vite\s+(?:${sub})(?![\w-])`).test(text);
  if (/^build(\b|:)/.test(lower) || vite('build')) return 'build';
  if (/^preview(\b|:)/.test(lower) || vite('preview')) return 'preview';
  if (/^(dev|serve|start)(\b|:)/.test(lower) || vite('dev|serve') || (word('vite') && !vite('build|preview|optimize'))) return 'dev';
  if (/^(lint|format)(\b|:)/.test(lower) || word('eslint|prettier|biome|oxlint')) return 'lint';
  if (/^(typecheck|type-check|check-types|tsc)(\b|:)/.test(lower) || word('tsc|vue-tsc|svelte-check')) return 'typecheck';
  if (/^test(\b|:)/.test(lower) || word('vitest|jest|playwright|mocha|ava')) return 'test';
  return 'other';
}
export const isLongRunning = (kind: ScriptKind): boolean => kind === 'dev' || kind === 'preview';

export const PackageManagerInfoSchema = z.object({
  name: z.enum(PACKAGE_MANAGERS),
  /** Where the choice came from: the `packageManager` field, the lockfile, or the default because neither exists. */
  source: z.enum(['packageManager-field', 'lockfile', 'default']),
  lockfile: z.string().max(60).nullable(),
  /** Version named by the `packageManager` field ("10.9.9"), when present. */
  version: z.string().max(40).nullable(),
  /** More than one lockfile exists and nothing says which one is meant. */
  ambiguous: z.boolean(),
});
export type PackageManagerInfo = z.output<typeof PackageManagerInfoSchema>;

export const WebScriptSchema = z.object({
  name: z.string().max(100),
  body: z.string().max(500),
  kind: z.enum(SCRIPT_KINDS),
  longRunning: z.boolean(),
  /** The label the approved-commands window and the command list use, for example `npm run dev`. */
  label: z.string().max(200),
  approved: z.boolean(),
  /** An approval exists but the script is different now. */
  changed: z.boolean(),
});
export type WebScript = z.output<typeof WebScriptSchema>;

export const WebDependencySchema = z.object({
  name: z.string().max(214),
  range: z.string().max(200),
  dev: z.boolean(),
  /** The version found in node_modules, or null when it is not installed. */
  installed: z.string().max(60).nullable(),
});
export type WebDependency = z.output<typeof WebDependencySchema>;

export const WebProjectSchema = z.object({
  name: z.string().max(214),
  version: z.string().max(60).nullable(),
  private: z.boolean(),
  moduleType: z.enum(['module', 'commonjs']),
  packageManager: PackageManagerInfoSchema,
  viteConfig: z.string().max(100).nullable(),
  /** The range in package.json and what node_modules holds. */
  vite: z.object({ range: z.string().max(200).nullable(), installed: z.string().max(60).nullable() }),
  frameworks: z.array(z.string().max(60)).max(20),
  nodeEngine: z.string().max(100).nullable(),
  scripts: z.array(WebScriptSchema).max(100),
  dependencies: z.array(WebDependencySchema).max(300),
  dependencyCount: z.number().int().nonnegative(),
  nodeModules: z.boolean(),
  notes: z.array(z.string().max(300)).max(10),
});
export type WebProject = z.output<typeof WebProjectSchema>;

export const WEB_SERVER_STATUSES = ['running', 'stopped', 'failed'] as const;
export const WebServerSchema = z.object({
  id: z.string().max(64),
  label: z.string().max(200),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  status: z.enum(WEB_SERVER_STATUSES),
  /** From the server's own output ("Local: http://localhost:5173/"); null until it printed one. */
  port: z.number().int().min(1).max(65_535).nullable(),
  url: z.string().max(100).nullable(),
  exitCode: z.number().int().nullable(),
  /** The end of the redacted output. */
  output: z.string().max(6000),
});
export type WebServer = z.output<typeof WebServerSchema>;

export const WebViewSchema = z.object({
  /** False when the project has no readable package.json at its root. */
  isWeb: z.boolean(),
  project: WebProjectSchema.nullable(),
  servers: z.array(WebServerSchema).max(20),
  capabilities: z.array(CapabilitySchema).max(20),
  /** Commands found for this project beyond its scripts, such as the install from the lockfile. */
  extraCommands: z.array(z.object({ label: z.string().max(200), writes: z.boolean(), approved: z.boolean() })).max(10),
  checkedAt: z.iso.datetime(),
});
export type WebView = z.output<typeof WebViewSchema>;
