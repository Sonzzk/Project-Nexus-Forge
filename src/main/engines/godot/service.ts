import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AppError } from '@shared/errors';
import { GODOT_OPEN_TARGETS, type GodotInstall, type GodotOpenTarget, type GodotProject, type GodotView } from '@shared/godot';
import type { ActivityLog, Logger } from '../../logging';
import { locateProgram } from '../../providers/locate';
import type { ProcessRunner, RunHandle } from '../../process';
import type { ProjectRegistry } from '../../projects';
import { resolveInside, type Confirm, type ExtraCommand, type PermissionService } from '../../security';
import type { Db } from '../../storage';
import { godotCapabilities, godotCommands, resolveGodot } from './commands';
import { discoverGodot, parseGodotVersion } from './installs';
import { describeGodotProject } from './project';

// The Godot service (spec §16 Godot): which Godot projects and downloads this PC has, what can be done with them, and the few actions
// that leave the app. Builds, exports and tests are commands the person approves and the command service runs (as for Unreal). The
// editor is the one long-lived program: this service starts it through the process runner after a confirmation, so the app owns it,
// can stop it, and ends it at quit. Starting the editor can import resources and re-save project files, which the window says.

const EDITOR_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export interface GodotServiceOptions {
  db: Db;
  projects: ProjectRegistry;
  runner: ProcessRunner;
  activity: ActivityLog;
  permissions: PermissionService;
  confirm: Confirm;
  logger: Logger;
  openPath: (fullPath: string) => Promise<string>;
  pickFolder: (title: string) => Promise<string | undefined>;
  env: () => NodeJS.ProcessEnv;
  now?: () => Date;
  cacheMs?: number;
  /** How long a started editor is watched for an immediate failure (a program that cannot run ends at once). */
  startupCheckMs?: number;
}

export interface GodotService {
  view(projectId: string): Promise<GodotView>;
  /** Commands for the command service. Reads the last look at the installs; call `ensure` first when freshness matters. */
  commandsFor(projectId: string): ExtraCommand[];
  ensure(): Promise<void>;
  open(projectId: string, target: GodotOpenTarget): Promise<{ opened: boolean }>;
  launchEditor(projectId: string): Promise<{ started: boolean }>;
  stopEditor(projectId: string): Promise<{ stopped: boolean }>;
  addPath(): Promise<{ added: boolean }>;
  removePath(index: number): { removed: true };
  paths(): string[];
}

export function createGodotService(options: GodotServiceOptions): GodotService {
  const { db, projects, runner, activity, permissions, logger } = options;
  const now = options.now ?? (() => new Date());
  let cache: { at: number; installs: GodotInstall[] } | undefined;
  let counter = 0;
  const editors = new Map<string, { handle: RunHandle; startedAt: string }>();

  const projectOf = (id: string) => {
    const found = projects.get(id);
    if (found === undefined) throw new AppError('NOT_FOUND', 'That project is not in the registry.', { hint: 'It may have been removed. Reload the project list.' });
    return found;
  };
  const paths = (): string[] => db.all<{ path: string }>("SELECT path FROM tool_paths WHERE tool = 'godot' ORDER BY added_at, path").map((r) => r.path);
  const list = (path: string): string[] => {
    try {
      return readdirSync(path);
    } catch {
      return [];
    }
  };

  async function versionOf(exe: string): Promise<string | null> {
    const result = await runner.start({ executable: exe, args: ['--version'], cwd: dirname(exe), timeoutMs: 30_000, maxOutputBytes: 16 * 1024, purpose: 'Read the Godot version', owner: { kind: 'detection', id: `godot-version-${++counter}` } }).result;
    return result.status === 'exited' && result.exitCode === 0 && parseGodotVersion(result.stdoutTail) !== null ? result.stdoutTail : null;
  }
  async function installs(): Promise<GodotInstall[]> {
    if (cache !== undefined && Date.now() - cache.at < (options.cacheMs ?? 60_000)) return cache.installs;
    const env = options.env();
    const found = await discoverGodot({
      configured: paths,
      defaultRoots: () => [
        join(env['ProgramFiles'] ?? 'C:\\Program Files', 'Godot'),
        ...(env['LOCALAPPDATA'] === undefined ? [] : [join(env['LOCALAPPDATA'], 'Programs', 'Godot')]),
        ...(env['USERPROFILE'] === undefined ? [] : [join(env['USERPROFILE'], 'scoop', 'apps', 'godot', 'current'), join(env['USERPROFILE'], 'Godot')]),
      ],
      onPath: () => locateProgram(['godot'], [], env),
      listDirectory: list,
      versionOf,
    });
    cache = { at: Date.now(), installs: found };
    return found;
  }

  const describe = (root: string): GodotProject | undefined => {
    try {
      return describeGodotProject(root);
    } catch (error) {
      logger.warn('could not describe a Godot project', { error });
      return undefined;
    }
  };
  const running = (projectId: string): { handle: RunHandle; startedAt: string } | undefined => editors.get(projectId);

  return {
    paths,
    async ensure() {
      await installs();
    },

    commandsFor(projectId) {
      const project = projects.get(projectId);
      if (project === undefined || cache === undefined) return [];
      const described = describe(project.rootPath);
      if (described === undefined) return [];
      return godotCommands(described, project.rootPath, resolveGodot(described, cache.installs).install);
    },

    async view(projectId) {
      const project = projectOf(projectId);
      const described = describe(project.rootPath);
      const found = await installs();
      const resolution = described === undefined ? undefined : resolveGodot(described, found);
      const resolved = resolution?.install;
      const resolveNote = resolution === undefined ? '' : 'why' in resolution ? resolution.why : '';
      const commands = described === undefined ? [] : godotCommands(described, project.rootPath, resolved);
      const editor = running(projectId);
      return {
        isGodot: described !== undefined,
        project: described ?? null,
        installs: found,
        configuredPaths: paths(),
        resolved: resolved === undefined || resolution === undefined || !('how' in resolution) ? null : { folder: resolved.folder, version: resolved.version, how: resolution.how },
        resolveNote,
        editor: { running: editor !== undefined, startedAt: editor?.startedAt ?? null },
        capabilities: godotCapabilities({ project: described, installs: found, resolved, resolveNote }),
        commands: commands.map((c) => ({ label: c.label, writes: c.writes })),
        checkedAt: now().toISOString(),
      };
    },

    async open(projectId, target) {
      if (!GODOT_OPEN_TARGETS.includes(target)) throw new AppError('INVALID_INPUT', 'That is not something this app can open.');
      const project = projectOf(projectId);
      if (describe(project.rootPath) === undefined) throw new AppError('NOT_FOUND', 'This project has no readable project.godot, so there is nothing Godot-specific to open.');
      const full = target === 'project' ? resolveInside(project.rootPath, '.') : resolveInside(project.rootPath, 'addons');
      if (!existsSync(full)) throw new AppError('NOT_FOUND', 'The addons folder does not exist in this project.');
      const error = await options.openPath(full);
      if (error !== '') throw new AppError('TOOL_FAILED', 'Windows could not open the folder.', { hint: error.slice(0, 200) });
      return { opened: true };
    },

    async launchEditor(projectId) {
      const project = projectOf(projectId);
      const described = describe(project.rootPath);
      if (described === undefined) throw new AppError('NOT_FOUND', 'This project has no readable project.godot.');
      if (running(projectId) !== undefined) throw new AppError('CONFLICT', 'The editor is already running for this project.', { hint: 'Stop it first, or switch to its window.' });
      const resolution = resolveGodot(described, await installs());
      if (resolution.install === undefined) throw new AppError('NOT_FOUND', 'No matching Godot editor was found.', { hint: resolution.why });
      const exe = resolution.install.exe ?? resolution.install.consoleExe;
      if (exe === null) throw new AppError('NOT_FOUND', 'The Godot install has no editor program.');
      const ok = await options.confirm({
        title: 'Start the Godot editor?',
        message: `Start Godot ${resolution.install.version ?? ''} on ${project.name}?`,
        detail: `${exe}\n--editor --path "${project.rootPath}"\n\nThe editor runs on your PC and this app owns it: you can stop it here, and it is closed when this app quits (unsaved editor changes would be lost, so save in the editor first). Opening a project can import resources and re-save project files, which changes files in it. ${resolution.how}.`,
        confirmLabel: 'Start the editor',
      });
      if (!ok) return { started: false };
      const startedAt = now().toISOString();
      const handle = runner.start({ executable: exe, args: ['--editor', '--path', project.rootPath], cwd: project.rootPath, timeoutMs: EDITOR_TIMEOUT_MS, maxOutputBytes: 1024 * 1024, purpose: `Godot editor for ${project.name}`, owner: { kind: 'engine', id: `godot-editor-${projectId}` }, projectId });
      editors.set(projectId, { handle, startedAt });
      // A program that cannot start (or quits at once) is reported now, not shown as running.
      const early = await Promise.race([handle.result, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), options.startupCheckMs ?? 1500))]);
      if (early !== undefined) {
        editors.delete(projectId);
        throw new AppError('TOOL_FAILED', `The Godot editor did not stay open (${early.status === 'exited' ? `it exited with code ${early.exitCode ?? '?'}` : early.status.replace('-', ' ')}).`, { hint: (early.errorMessage ?? early.stderrTail).slice(0, 200) });
      }
      void handle.result.then((result) => {
        editors.delete(projectId);
        activity.record({ kind: 'godot.editorEnded', severity: result.status === 'exited' && result.exitCode === 0 ? 'info' : 'warning', summary: `The Godot editor for "${project.name}" ${result.status === 'exited' ? `closed (exit code ${result.exitCode ?? '?'})` : result.status.replace('-', ' ')}.`, projectId });
      });
      permissions.record({ projectId, scope: 'commands', what: `Started the Godot editor on ${project.name}`, where: project.rootPath });
      activity.record({ kind: 'godot.editorStarted', severity: 'info', summary: `You started the Godot editor on "${project.name}".`, projectId });
      return { started: true };
    },

    async stopEditor(projectId) {
      projectOf(projectId);
      const editor = running(projectId);
      if (editor === undefined) return { stopped: false };
      await editor.handle.cancel('You stopped the Godot editor from the app');
      return { stopped: true };
    },

    async addPath() {
      const picked = await options.pickFolder('Choose the folder that holds the Godot download (the Godot_v….exe files)');
      if (picked === undefined) return { added: false };
      if (!list(picked).some((n) => /^godot.*\.exe$/i.test(n))) throw new AppError('INVALID_INPUT', 'That folder has no Godot program (a file like Godot_v4.3-stable_win64.exe), so it is not a Godot download.', { hint: 'Choose the folder where you unzipped Godot.' });
      if (db.run("INSERT OR IGNORE INTO tool_paths (tool, path, added_at) VALUES ('godot', ?, ?)", picked, now().toISOString()).changes === 0) return { added: false };
      cache = undefined;
      activity.record({ kind: 'godot.pathAdded', severity: 'info', summary: 'You added a Godot folder.', details: { folder: picked } });
      return { added: true };
    },

    removePath(index) {
      const path = paths()[index];
      if (path === undefined) throw new AppError('NOT_FOUND', 'That folder is not in the list.');
      db.run("DELETE FROM tool_paths WHERE tool = 'godot' AND path = ?", path); // only the list entry; the folder is not touched
      cache = undefined;
      return { removed: true };
    },
  };
}
