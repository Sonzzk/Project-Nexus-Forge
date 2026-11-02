import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, constants, createReadStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { AppError } from '@shared/errors';
import { INSPECT_MARKER, InspectResultSchema, type BlenderInstall, type BlenderRunDetail, type BlenderRunSummary, type BlenderView, type InspectResult } from '@shared/blender';
import type { ActivityLog, Logger, Redactor } from '../../logging';
import { locateProgram } from '../../providers/locate';
import type { ProcessResult, ProcessRunner } from '../../process';
import type { ProjectRegistry } from '../../projects';
import { resolveInside, type Confirm, type PermissionService } from '../../security';
import type { Db } from '../../storage';
import type { AssetService } from './assets';
import { readBlendHeader, scanBlendFiles, scanBlenderScripts, sha256Text, versionNewer } from './blendfile';
import { discoverBlender, parseBlenderVersion, BLENDER_EXE } from './installs';
import { INSPECT_SCRIPT } from './inspect-script';

// The Blender service (spec §16). The rules that keep the person's files safe:
//  - Blender is started only by this service, as an argument array through the process runner, in background mode, never with a window.
//  - It is started on a COPY of the .blend, in the app's own data folder. The original is fingerprinted before and after every run
//    (size, modification time and content hash) and the result says whether it changed. Nothing is written into the project.
//  - A script from the project runs only if the person approved that exact text (a hash), in a window that shows it. The inspect
//    script is the app's own, only reads, and needs no approval.
//  - Opening a scene in Blender's window is a hand-off to Windows after a confirmation, like double-clicking the file.

const MAX_COPY_BYTES = 2 * 1024 ** 3;
const HASH_LIMIT_BYTES = 1024 ** 3;
const INSPECT_TIMEOUT_MS = 5 * 60_000;
const SCRIPT_TIMEOUT_MS = 30 * 60_000;
const LOG_LIMIT = 200_000;

export interface BlenderServiceOptions {
  db: Db;
  projects: ProjectRegistry;
  runner: ProcessRunner;
  activity: ActivityLog;
  permissions: PermissionService;
  assets: AssetService;
  confirm: Confirm;
  logger: Logger;
  redactor: Redactor;
  openPath: (fullPath: string) => Promise<string>;
  pickFolder: (title: string) => Promise<string | undefined>;
  env: () => NodeJS.ProcessEnv;
  /** The app's folder for run copies and results (inside its data folder, never inside a project). */
  workRoot: string;
  now?: () => Date;
  cacheMs?: number;
}

export interface BlenderService {
  view(projectId: string): Promise<BlenderView>;
  addPath(): Promise<{ added: boolean }>;
  removePath(index: number): { removed: true };
  open(projectId: string, file: string): Promise<{ opened: boolean }>;
  inspect(projectId: string, file: string): Promise<BlenderRunDetail>;
  approveScript(projectId: string, script: string): Promise<{ approved: boolean }>;
  revokeScript(id: string): { revoked: true };
  runScript(projectId: string, script: string, file: string): Promise<BlenderRunDetail>;
  run(id: string): BlenderRunDetail;
  revealRun(id: string): Promise<{ opened: boolean }>;
  /** Removes run records and their folders that started before `cutoffIso`. */
  prune(cutoffIso: string): number;
}

interface RunRow {
  id: string;
  project_id: string;
  kind: 'inspect' | 'script';
  source_rel: string;
  script_rel: string | null;
  script_hash: string | null;
  blender_folder: string;
  blender_version: string | null;
  started_at: string;
  ended_at: string | null;
  status: string;
  exit_code: number | null;
  outcome: 'passed' | 'failed' | 'inconclusive';
  original_unchanged: number;
  work_dir: string;
  outputs_json: string;
  result_json: string | null;
  log: string;
  truncated: number;
  error_summary: string;
}

const summaryFrom = (r: RunRow): BlenderRunSummary => ({ id: r.id, kind: r.kind, source: r.source_rel, script: r.script_rel, blenderVersion: r.blender_version, startedAt: r.started_at, endedAt: r.ended_at, status: r.status, exitCode: r.exit_code, outcome: r.outcome, originalUnchanged: r.original_unchanged === 1, errorSummary: r.error_summary });
const detailFrom = (r: RunRow): BlenderRunDetail => ({ ...summaryFrom(r), log: r.log, truncated: r.truncated === 1, outputs: JSON.parse(r.outputs_json) as BlenderRunDetail['outputs'], result: r.result_json === null ? null : (JSON.parse(r.result_json) as InspectResult) });

/** What identifies a file's content: size, time and (up to 1 GiB) the SHA-256. */
async function fingerprint(path: string): Promise<string> {
  const stats = lstatSync(path);
  if (stats.size > HASH_LIMIT_BYTES) return `${stats.size}:${Math.floor(stats.mtimeMs)}:unhashed`;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return `${stats.size}:${Math.floor(stats.mtimeMs)}:${hash.digest('hex')}`;
}

/** The first lines that explain a failure: the end of the last Python traceback, or Blender's own "Error:" lines. */
export function errorSummaryOf(log: string): string {
  const lines = log.split(/\r?\n/);
  const trace = lines.lastIndexOf('Traceback (most recent call last):');
  if (trace >= 0) {
    const tail = lines.slice(trace + 1).filter((l) => l.trim() !== '' && !l.startsWith('Blender quit'));
    // Frame lines are indented; the first line that is not is the exception itself ("KeyError: ...").
    const exception = tail.find((l) => !/^\s/.test(l)) ?? tail.slice(-1)[0] ?? '';
    return exception.slice(0, 500);
  }
  return lines.filter((l) => /^(Error|ERROR)\b/.test(l)).slice(0, 3).join('\n').slice(0, 500);
}

export function createBlenderService(options: BlenderServiceOptions): BlenderService {
  const { db, projects, runner, activity, permissions, assets, logger, redactor, workRoot } = options;
  const now = options.now ?? (() => new Date());
  let cache: { at: number; installs: BlenderInstall[] } | undefined;
  let counter = 0;
  let busy = false;

  const projectOf = (id: string) => {
    const found = projects.get(id);
    if (found === undefined) throw new AppError('NOT_FOUND', 'That project is not in the registry.', { hint: 'It may have been removed. Reload the project list.' });
    return found;
  };
  const configured = (): string[] => db.all<{ path: string }>("SELECT path FROM tool_paths WHERE tool = 'blender' ORDER BY added_at, path").map((r) => r.path);

  async function versionOf(exe: string): Promise<string | null> {
    const result = await runner.start({ executable: exe, args: ['--version'], cwd: dirname(exe), timeoutMs: 30_000, maxOutputBytes: 16 * 1024, purpose: 'Read the Blender version', owner: { kind: 'detection', id: `blender-version-${++counter}` } }).result;
    return result.status === 'exited' && result.exitCode === 0 ? parseBlenderVersion(result.stdoutTail) : null;
  }
  async function installs(): Promise<BlenderInstall[]> {
    if (cache !== undefined && Date.now() - cache.at < (options.cacheMs ?? 60_000)) return cache.installs;
    const env = options.env();
    const found = await discoverBlender({
      configured,
      defaultRoots: () => [
        join(env['ProgramFiles'] ?? 'C:\\Program Files', 'Blender Foundation'),
        join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Blender Foundation'),
        ...(env['LOCALAPPDATA'] === undefined ? [] : [join(env['LOCALAPPDATA'], 'Programs', 'Blender Foundation')]),
      ],
      onPath: () => locateProgram([BLENDER_EXE.replace(/\.exe$/, '')], [], env),
      listDirectory: (path) => {
        try {
          return readdirSync(path);
        } catch {
          return [];
        }
      },
      exists: existsSync,
      versionOf,
    });
    cache = { at: Date.now(), installs: found };
    return found;
  }

  /** The project-relative path of a .blend (or another expected extension) chosen from a listing, resolved inside the project. */
  function fileIn(root: string, rel: string, extension: RegExp, what: string): string {
    if (!extension.test(rel)) throw new AppError('INVALID_INPUT', `That is not ${what}.`);
    const full = resolveInside(root, rel);
    let stats;
    try {
      stats = lstatSync(full);
    } catch {
      throw new AppError('NOT_FOUND', `That ${what.replace(/^an? /, '')} does not exist in the project.`, { hint: 'Reload the list; the file may have been moved.' });
    }
    if (!stats.isFile()) throw new AppError('INVALID_INPUT', `That is not ${what}.`);
    return full;
  }

  function capabilities(hasInstall: boolean, hasBlend: boolean): BlenderView['capabilities'] {
    const cap = (id: string, label: string, state: BlenderView['capabilities'][number]['state'], reason = '') => ({ id, label, state, reason });
    const needsInstall = hasInstall ? '' : 'No Blender installation was found. Install Blender, or add its folder.';
    return [
      cap('detect', 'Find .blend files and Blender installations', 'implemented', hasBlend ? '' : 'This project has no .blend file.'),
      cap('open', 'Open a scene in Blender', hasInstall && hasBlend ? 'implemented' : hasInstall ? 'unavailable' : 'awaiting-configuration', hasInstall ? 'Windows opens the file with the program it is associated with.' : needsInstall),
      cap('inspect', 'Describe a scene (objects, triangles, missing files) in a headless run on a copy', hasInstall ? 'implemented' : 'awaiting-configuration', needsInstall),
      cap('scripts', 'Run an approved script headless, on a copy', hasInstall ? 'implemented' : 'awaiting-configuration', needsInstall || 'The script runs with your account\'s rights; only the .blend is protected by the copy.'),
      cap('assets', 'Track asset files, asset briefs, naming conventions, import handoff notes', 'implemented'),
      cap('results', 'Record every run: output files, errors, and whether the original was left alone', 'implemented'),
      cap('live-bridge', 'Live control of a running Blender (add-on or MCP bridge)', 'unavailable', 'Not built. This app starts Blender itself in background mode; it does not connect to a running Blender window.'),
    ];
  }

  async function view(projectId: string): Promise<BlenderView> {
    const project = projectOf(projectId);
    const found = await installs();
    const newest = found.find((i) => i.version !== null)?.version ?? null;
    const scanned = scanBlendFiles(project.rootPath);
    const tracked = assets.list(projectId);
    const trackedPaths = new Set(tracked.map((a) => a.path));
    const scripts = scanBlenderScripts(project.rootPath).map((s) => {
      const row = db.get<{ id: string; hash: string }>('SELECT id, hash FROM approved_scripts WHERE project_id = ? AND rel_path = ? AND revoked_at IS NULL ORDER BY approved_at DESC LIMIT 1', projectId, s.path);
      const approved = row !== undefined && row.hash === s.hash;
      return { path: s.path, bytes: s.bytes, hash: s.hash.slice(0, 12), approved, changed: row !== undefined && !approved, approvalId: row?.id ?? null };
    });
    return {
      installs: found,
      configuredPaths: configured(),
      hasBlend: scanned.files.length > 0,
      files: scanned.files.map((f) => ({ path: f.path, bytes: f.bytes, modifiedAt: new Date(f.modifiedMs).toISOString(), format: f.header.format, version: f.header.version, backups: f.backups, tracked: trackedPaths.has(f.path), newerThanInstalled: f.header.version !== null && newest !== null && versionNewer(f.header.version, newest) })),
      scripts,
      runs: db.all<RunRow>('SELECT * FROM blender_runs WHERE project_id = ? ORDER BY started_at DESC LIMIT 30', projectId).map(summaryFrom),
      assets: tracked,
      capabilities: capabilities(found.length > 0, scanned.files.length > 0),
      truncated: scanned.truncated,
      checkedAt: now().toISOString(),
    };
  }

  async function execute(input: { projectId: string; kind: 'inspect' | 'script'; file: string; script?: { rel: string; text: Buffer; hash: string } }): Promise<BlenderRunDetail> {
    const project = projectOf(input.projectId);
    const source = fileIn(project.rootPath, input.file, /\.blend$/i, 'a Blender file');
    const found = await installs();
    const install = found.find((i) => i.version !== null) ?? found[0];
    if (install === undefined) throw new AppError('NOT_FOUND', 'No Blender installation was found.', { hint: 'Install Blender, or press "Add a Blender folder…" and choose the folder that contains blender.exe.' });
    const fileVersion = readBlendHeader(source).version;
    if (fileVersion !== null && install.version !== null && versionNewer(fileVersion, install.version)) throw new AppError('INVALID_INPUT', `This file was saved by Blender ${fileVersion}, which is newer than the newest installed (${install.version}).`, { hint: 'Install a newer Blender, or add its folder.' });
    const size = lstatSync(source).size;
    if (size > MAX_COPY_BYTES) throw new AppError('INVALID_INPUT', 'This file is over 2 GB, which is too large to copy for a safe run.', { hint: 'Open it in Blender yourself.' });
    if (busy) throw new AppError('CONFLICT', 'A Blender run is already in progress.', { hint: 'Wait for it to finish; Blender can use a lot of memory.' });
    busy = true;
    const id = randomUUID();
    const runDir = join(workRoot, id);
    try {
      mkdirSync(join(runDir, 'out'), { recursive: true });
      const copy = join(runDir, basename(source));
      const script = join(runDir, 'script.py');
      const before = await fingerprint(source);
      copyFileSync(source, copy, constants.COPYFILE_EXCL);
      const copyBefore = await fingerprint(copy);
      writeFileSync(script, input.script === undefined ? INSPECT_SCRIPT : input.script.text);
      if (input.script !== undefined && sha256Text(readFileSync(script)) !== input.script.hash) throw new AppError('CONFLICT', 'The script changed while it was being prepared, so it was not run.', { hint: 'Approve it again.' });

      const startedAt = now().toISOString();
      const args = ['-b', '--factory-startup', '-noaudio', '--disable-autoexec', copy, '--python-exit-code', '1', '--python', script, '--', '--out', join(runDir, 'out'), '--origin-dir', dirname(source)];
      const handle = runner.start({ executable: join(install.folder, BLENDER_EXE), args, cwd: runDir, timeoutMs: input.kind === 'inspect' ? INSPECT_TIMEOUT_MS : SCRIPT_TIMEOUT_MS, maxOutputBytes: 4 * 1024 * 1024, purpose: input.kind === 'inspect' ? 'Describe a Blender scene (on a copy)' : 'Run an approved Blender script (on a copy)', owner: { kind: 'engine', id: `blender-run-${id}` }, projectId: project.id });
      const result: ProcessResult = await handle.result;

      const after = await fingerprint(source);
      const unchanged = after === before;
      const raw = `${result.stdoutTail}${result.stderrTail === '' ? '' : `\n${result.stderrTail}`}`;
      const log = redactor.redact(raw).slice(-LOG_LIMIT);
      let parsed: InspectResult | null = null;
      if (input.kind === 'inspect') {
        const line = raw.split(/\r?\n/).find((l) => l.startsWith(INSPECT_MARKER));
        if (line !== undefined) {
          try {
            parsed = InspectResultSchema.parse(JSON.parse(line.slice(INSPECT_MARKER.length)));
          } catch {
            parsed = null;
          }
        }
      }
      const hasTrace = /Traceback \(most recent call last\)/.test(raw);
      const copyChanged = (await fingerprint(copy)) !== copyBefore;
      if (!copyChanged) rmSync(copy, { force: true });
      rmSync(script, { force: true });
      const outputs = listFiles(runDir);
      let outcome: BlenderRunSummary['outcome'] = result.status === 'exited' && result.exitCode === 0 && !hasTrace && (input.kind === 'script' || parsed !== null) ? 'passed' : result.status === 'exited' ? 'failed' : 'inconclusive';
      let error = outcome === 'passed' ? '' : errorSummaryOf(raw) || (result.status === 'exited' ? (parsed === null && input.kind === 'inspect' ? 'Blender finished but the scene description was not printed.' : `Blender exited with code ${result.exitCode ?? '?'}.`) : (result.errorMessage ?? `The run ended: ${result.status}.`));
      if (!unchanged) {
        outcome = 'failed';
        error = 'The original .blend file is different after the run. This should never happen: check the file and report it.';
        logger.error('a blender run changed the original file', { run: id });
      }
      db.run(
        `INSERT INTO blender_runs (id, project_id, kind, source_rel, script_rel, script_hash, blender_folder, blender_version, started_at, ended_at, status, exit_code, outcome, original_unchanged, work_dir, outputs_json, result_json, log, truncated, error_summary)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, project.id, input.kind, input.file.replace(/\\/g, '/'), input.script?.rel ?? null, input.script?.hash ?? null, install.folder, install.version, startedAt, result.endedAt, result.status, result.exitCode, outcome, unchanged ? 1 : 0, runDir, JSON.stringify(outputs.map((o) => (o.path === basename(source) ? { ...o, path: `${o.path} (modified copy)` } : o))), parsed === null ? null : JSON.stringify(parsed), log, result.truncated || raw.length > LOG_LIMIT ? 1 : 0, redactor.redact(error),
      );
      activity.record({ kind: 'blender.run', severity: outcome === 'passed' ? 'info' : 'warning', summary: `Blender ${input.kind === 'inspect' ? 'described' : 'ran a script on a copy of'} ${input.file}: ${outcome}.`, projectId: project.id, details: { runId: id, outcome, originalUnchanged: unchanged } });
      return detailFrom(db.get<RunRow>('SELECT * FROM blender_runs WHERE id = ?', id) as RunRow);
    } catch (error) {
      rmSync(runDir, { recursive: true, force: true });
      throw error;
    } finally {
      busy = false;
    }
  }

  return {
    view,

    async addPath() {
      const picked = await options.pickFolder('Choose the Blender folder (the one that contains blender.exe)');
      if (picked === undefined) return { added: false };
      if (!existsSync(join(picked, BLENDER_EXE))) throw new AppError('INVALID_INPUT', 'That folder does not contain blender.exe, so it is not a Blender install.', { hint: 'Choose the folder that has blender.exe inside it.' });
      if (db.run("INSERT OR IGNORE INTO tool_paths (tool, path, added_at) VALUES ('blender', ?, ?)", picked, now().toISOString()).changes === 0) return { added: false };
      cache = undefined;
      activity.record({ kind: 'blender.pathAdded', severity: 'info', summary: 'You added a Blender folder.', details: { folder: picked } });
      return { added: true };
    },

    removePath(index) {
      const path = configured()[index];
      if (path === undefined) throw new AppError('NOT_FOUND', 'That folder is not in the list.');
      db.run("DELETE FROM tool_paths WHERE tool = 'blender' AND path = ?", path); // only the list entry; the folder is not touched
      cache = undefined;
      return { removed: true };
    },

    async open(projectId, file) {
      const project = projectOf(projectId);
      const full = fileIn(project.rootPath, file, /\.blend$/i, 'a Blender file');
      const found = await installs();
      const ok = await options.confirm({
        title: 'Open this scene in Blender?',
        message: `Open ${file} the way Windows opens it when you double-click it?`,
        detail: `${full}\n\nWindows decides which program opens .blend files${found.length > 1 ? `; ${found.length} Blender installs were found, so it may not be the newest` : ''}. Blender then runs on its own: this app does not own it and will not close it. Anything you save from Blender replaces the file; this app does not save, copy or back it up when you open it.`,
        confirmLabel: 'Open',
      });
      if (!ok) return { opened: false };
      const error = await options.openPath(full);
      if (error !== '') throw new AppError('TOOL_FAILED', 'Windows could not open the file.', { hint: error.slice(0, 200) });
      permissions.record({ projectId, scope: 'commands', what: `Opened ${file} in Blender`, where: project.rootPath });
      activity.record({ kind: 'blender.opened', severity: 'info', summary: `You opened ${file} through Windows.`, projectId });
      return { opened: true };
    },

    inspect: (projectId, file) => execute({ projectId, kind: 'inspect', file }),

    async approveScript(projectId, script) {
      const project = projectOf(projectId);
      const full = fileIn(project.rootPath, script, /\.py$/i, 'a Python script');
      const text = readFileSync(full);
      if (text.length > 512 * 1024) throw new AppError('INVALID_INPUT', 'That script is over 512 KB.');
      if (!scanBlenderScripts(project.rootPath).some((s) => s.path === script.replace(/\\/g, '/'))) throw new AppError('INVALID_INPUT', 'That file is not a Blender script (it does not import bpy).');
      const hash = sha256Text(text);
      const shown = redactor.redact(text.toString('utf8'));
      const ok = await options.confirm({
        title: 'Allow this Blender script to run?',
        message: `Allow ${script} to run in Blender, on a copy of a .blend file you choose each time?`,
        detail: `The script text (SHA-256 ${hash.slice(0, 12)}):\n\n${shown.slice(0, 3500)}${shown.length > 3500 ? '\n[... cut here; the whole file is approved]' : ''}\n\nBlender runs in the background on a COPY, so the .blend you choose is not changed. The script itself is Python with the same rights as your Windows account: it can read and write other files, start programs and use the network, and the copy does not limit that. If you change the script later, it must be approved again. Agents cannot run it.`,
        confirmLabel: 'Allow',
      });
      if (!ok) return { approved: false };
      const id = randomUUID();
      db.transaction(() => {
        db.run('UPDATE approved_scripts SET revoked_at = ? WHERE project_id = ? AND rel_path = ? AND revoked_at IS NULL', now().toISOString(), projectId, script);
        db.run('INSERT INTO approved_scripts (id, project_id, rel_path, hash, approved_at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL)', id, projectId, script.replace(/\\/g, '/'), hash, now().toISOString());
      });
      permissions.record({ projectId, scope: 'commands', what: `Approved Blender script ${script}`, where: project.rootPath, detail: `sha256 ${hash}` });
      activity.record({ kind: 'blender.scriptApproved', severity: 'info', summary: `You approved the Blender script ${script}.`, projectId, details: { hash: hash.slice(0, 12) } });
      return { approved: true };
    },

    revokeScript(id) {
      const row = db.get<{ project_id: string; rel_path: string }>('SELECT project_id, rel_path FROM approved_scripts WHERE id = ?', id);
      if (row === undefined) throw new AppError('NOT_FOUND', 'That approval does not exist.');
      db.run('UPDATE approved_scripts SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', now().toISOString(), id);
      activity.record({ kind: 'blender.scriptRevoked', severity: 'info', summary: `You took back the approval of ${row.rel_path}.`, projectId: row.project_id });
      return { revoked: true };
    },

    async runScript(projectId, script, file) {
      const project = projectOf(projectId);
      const full = fileIn(project.rootPath, script, /\.py$/i, 'a Python script');
      const text = readFileSync(full);
      const hash = sha256Text(text);
      const row = db.get<{ hash: string }>('SELECT hash FROM approved_scripts WHERE project_id = ? AND rel_path = ? AND revoked_at IS NULL ORDER BY approved_at DESC LIMIT 1', projectId, script.replace(/\\/g, '/'));
      if (row === undefined) throw new AppError('PERMISSION_REQUIRED', 'This script has not been approved.', { hint: 'Approve it first; you will see its text.' });
      if (row.hash !== hash) throw new AppError('PERMISSION_REQUIRED', 'The script changed since you approved it, so it will not run.', { hint: 'Approve it again.' });
      return execute({ projectId, kind: 'script', file, script: { rel: script.replace(/\\/g, '/'), text, hash } });
    },

    run(id) {
      const row = db.get<RunRow>('SELECT * FROM blender_runs WHERE id = ?', id);
      if (row === undefined) throw new AppError('NOT_FOUND', 'That run does not exist.');
      return detailFrom(row);
    },

    async revealRun(id) {
      const row = db.get<RunRow>('SELECT work_dir FROM blender_runs WHERE id = ?', id);
      if (row === undefined) throw new AppError('NOT_FOUND', 'That run does not exist.');
      if (relative(workRoot, row.work_dir).startsWith('..') || !existsSync(row.work_dir)) throw new AppError('NOT_FOUND', 'The folder of this run is gone.', { hint: 'Old runs are removed under the retention limits.' });
      const error = await options.openPath(row.work_dir);
      if (error !== '') throw new AppError('TOOL_FAILED', 'Windows could not open the folder.', { hint: error.slice(0, 200) });
      return { opened: true };
    },

    prune(cutoffIso) {
      const old = db.all<{ id: string; work_dir: string }>('SELECT id, work_dir FROM blender_runs WHERE started_at < ?', cutoffIso);
      for (const run of old) {
        if (!relative(workRoot, run.work_dir).startsWith('..')) rmSync(run.work_dir, { recursive: true, force: true }); // only folders under the app's own work folder
        db.run('DELETE FROM blender_runs WHERE id = ?', run.id);
      }
      return old.length;
    },
  };
}

function listFiles(dir: string): { path: string; bytes: number }[] {
  const out: { path: string; bytes: number }[] = [];
  const go = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) go(full);
      else if (out.length < 500) out.push({ path: relative(dir, full).replace(/\\/g, '/'), bytes: lstatSync(full).size });
    }
  };
  go(dir);
  return out;
}
