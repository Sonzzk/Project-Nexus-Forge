import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from '@shared/errors';
import { OPEN_TARGETS, type EngineInstall, type OpenTarget, type UnrealProject, type UnrealView } from '@shared/unreal';
import type { ActivityLog, Logger } from '../logging';
import type { ProcessRunner } from '../process';
import type { ProjectRegistry } from '../projects';
import { resolveInside, type Confirm, type ExtraCommand, type PermissionService } from '../security';
import type { Db } from '../storage';
import { unrealBuildCommands, unrealCapabilities } from './unreal/commands';
import { discoverEngines, resolveEngine } from './unreal/engines';
import { describeUnrealProject } from './unreal/project';

// The engine integration service (spec §16): what Unreal projects and engines this PC has, what can be done with them, and the
// few actions that leave the app (open the project, open a folder). Nothing here edits an asset; builds are commands the person
// approves and the command service runs; opening the project hands it to Windows, like double-clicking it, so the app does not own
// (or stop) the editor.

export interface EngineServiceOptions {
  db: Db;
  projects: ProjectRegistry;
  runner: ProcessRunner;
  activity: ActivityLog;
  permissions: PermissionService;
  confirm: Confirm;
  logger: Logger;
  /** Hands a file or folder to Windows (shell.openPath). Returns an error text, or '' when it worked. */
  openPath: (fullPath: string) => Promise<string>;
  /** A native folder window; undefined when cancelled. */
  pickFolder: (title: string) => Promise<string | undefined>;
  /** %ProgramData% and %ProgramFiles%, %SystemRoot%. */
  env: () => NodeJS.ProcessEnv;
  now?: () => Date;
  /** How long a look at the installed engines is reused. */
  cacheMs?: number;
}

export interface EngineService {
  view(projectId: string): Promise<UnrealView>;
  /** Build commands for the command service. Reads the last look at the engines; call `refresh` first when freshness matters. */
  commandsFor(projectId: string): ExtraCommand[];
  refresh(): Promise<EngineInstall[]>;
  /** Looks at the engines unless a look is recent. */
  ensure(): Promise<void>;
  open(projectId: string, target: OpenTarget): Promise<{ opened: boolean }>;
  addEnginePath(): Promise<{ added: boolean }>;
  removeEnginePath(index: number): { removed: true };
  enginePaths(): string[];
}

export function createEngineService(options: EngineServiceOptions): EngineService {
  const { db, projects, runner, activity, permissions, logger } = options;
  const now = options.now ?? (() => new Date());
  let cache: { at: number; engines: EngineInstall[] } | undefined;
  let counter = 0;

  const projectOf = (id: string) => {
    const found = projects.get(id);
    if (found === undefined) throw new AppError('NOT_FOUND', 'That project is not in the registry.', { hint: 'It may have been removed. Reload the project list.' });
    return found;
  };
  const enginePaths = (): string[] => db.all<{ path: string }>('SELECT path FROM engine_paths ORDER BY added_at, path').map((r) => r.path);

  /** `reg query` through the process runner; undefined when the key is absent or the program fails. */
  async function queryRegistry(key: string): Promise<string | undefined> {
    const env = options.env();
    const reg = join(env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'reg.exe');
    if (!existsSync(reg)) return undefined;
    const result = await runner.start({ executable: reg, args: ['query', key], cwd: env['SystemRoot'] ?? 'C:\\Windows', timeoutMs: 10_000, maxOutputBytes: 64 * 1024, purpose: 'List registered Unreal Engine builds', owner: { kind: 'detection', id: `unreal-registry-${++counter}` } }).result;
    return result.status === 'exited' && result.exitCode === 0 ? result.stdoutTail : undefined;
  }

  async function refresh(): Promise<EngineInstall[]> {
    const env = options.env();
    const engines = await discoverEngines({
      launcherFile: () => {
        try {
          return readFileSync(join(env['ProgramData'] ?? 'C:\\ProgramData', 'Epic', 'UnrealEngineLauncher', 'LauncherInstalled.dat'), 'utf8');
        } catch {
          return undefined;
        }
      },
      queryRegistry,
      configured: enginePaths,
      defaultRoots: () => [join(env['ProgramFiles'] ?? 'C:\\Program Files', 'Epic Games')],
      listDirectory: (path) => {
        try {
          return readdirSync(path);
        } catch {
          return [];
        }
      },
    });
    cache = { at: Date.now(), engines };
    return engines;
  }
  const engines = async (): Promise<EngineInstall[]> => (cache !== undefined && Date.now() - cache.at < (options.cacheMs ?? 60_000) ? cache.engines : refresh());

  const describe = (root: string): UnrealProject | undefined => {
    try {
      return describeUnrealProject(root);
    } catch (error) {
      logger.warn('could not describe an Unreal project', { error });
      return undefined;
    }
  };

  return {
    enginePaths,
    refresh,
    async ensure() {
      await engines();
    },

    commandsFor(projectId) {
      const project = projects.get(projectId);
      if (project === undefined || cache === undefined) return [];
      const described = describe(project.rootPath);
      if (described === undefined) return [];
      const resolved = resolveEngine(described.engineAssociation, cache.engines);
      return unrealBuildCommands(described, project.rootPath, resolved.install);
    },

    async view(projectId) {
      const project = projectOf(projectId);
      const described = describe(project.rootPath);
      const installs = await engines();
      const resolution = described === undefined ? undefined : resolveEngine(described.engineAssociation, installs);
      const resolved = resolution?.install;
      const resolveNote = resolution === undefined ? '' : 'why' in resolution ? resolution.why : '';
      const commands = described === undefined ? [] : unrealBuildCommands(described, project.rootPath, resolved);
      return {
        isUnreal: described !== undefined,
        project: described ?? null,
        engines: installs,
        configuredPaths: enginePaths(),
        resolved: resolved === undefined || resolution === undefined || !('how' in resolution) ? null : { id: resolved.id, path: resolved.path, how: resolution.how },
        resolveNote,
        capabilities: unrealCapabilities({ project: described, engines: installs, resolved, resolveNote }),
        commands: commands.map((c) => ({ label: c.label, writes: c.writes })),
        checkedAt: now().toISOString(),
      };
    },

    async open(projectId, target) {
      if (!OPEN_TARGETS.includes(target)) throw new AppError('INVALID_INPUT', 'That is not something this app can open.');
      const project = projectOf(projectId);
      const described = describe(project.rootPath);
      if (target === 'engine') {
        const resolution = described === undefined ? undefined : resolveEngine(described.engineAssociation, await engines());
        if (resolution?.install === undefined) throw new AppError('NOT_FOUND', 'This project\'s engine was not found.', { hint: 'See the capability report for why.' });
        const error = await options.openPath(resolution.install.path);
        if (error !== '') throw new AppError('TOOL_FAILED', 'Windows could not open the folder.', { hint: error.slice(0, 200) });
        return { opened: true };
      }
      if (described === undefined) throw new AppError('NOT_FOUND', 'This project has no readable .uproject, so there is nothing Unreal-specific to open.');
      if (target === 'project') {
        const uproject = resolveInside(project.rootPath, described.uproject);
        const resolution = resolveEngine(described.engineAssociation, await engines());
        const ok = await options.confirm({
          title: 'Open this project in Unreal Editor?',
          message: `Open ${described.uproject} the way Windows opens it when you double-click it?`,
          detail: `${uproject}\n\n${resolution.install === undefined ? `Engine: ${resolution.why}` : `Engine it asks for: ${resolution.install.id} (${resolution.install.path})`}\n\nWindows decides which program opens the file. The editor then runs on its own: this app does not own it and will not close it. Opening can compile or upgrade the project, which changes files in it.`,
          confirmLabel: 'Open',
        });
        if (!ok) return { opened: false };
        const error = await options.openPath(uproject);
        if (error !== '') throw new AppError('TOOL_FAILED', 'Windows could not open the project.', { hint: error.slice(0, 200) });
        permissions.record({ projectId, scope: 'commands', what: `Opened ${described.uproject} in Unreal Editor`, where: project.rootPath });
        activity.record({ kind: 'engine.opened', severity: 'info', summary: `You opened ${described.uproject} through Windows.`, projectId });
        return { opened: true };
      }
      const folder = { source: 'Source', config: 'Config', content: 'Content', plugins: 'Plugins', logs: join('Saved', 'Logs') }[target];
      const full = resolveInside(project.rootPath, folder);
      if (!existsSync(full)) throw new AppError('NOT_FOUND', `The ${folder} folder does not exist in this project.`);
      const error = await options.openPath(full);
      if (error !== '') throw new AppError('TOOL_FAILED', 'Windows could not open the folder.', { hint: error.slice(0, 200) });
      return { opened: true };
    },

    async addEnginePath() {
      const picked = await options.pickFolder('Choose an Unreal Engine folder (the one that contains Engine)');
      if (picked === undefined) return { added: false };
      if (!existsSync(join(picked, 'Engine'))) throw new AppError('INVALID_INPUT', 'That folder does not contain an Engine folder, so it is not an Unreal Engine install.', { hint: 'Choose the folder that has Engine, Templates and Samples inside, for example UE_5.5.' });
      db.run('INSERT OR IGNORE INTO engine_paths (path, added_at) VALUES (?, ?)', picked, now().toISOString());
      cache = undefined;
      activity.record({ kind: 'engine.path-added', severity: 'info', summary: `You added the engine folder ${picked}.` });
      return { added: true };
    },

    removeEnginePath(index) {
      const path = enginePaths()[index];
      if (path === undefined) throw new AppError('NOT_FOUND', 'That engine folder is not in the list.');
      db.run('DELETE FROM engine_paths WHERE path = ?', path);
      cache = undefined;
      activity.record({ kind: 'engine.path-removed', severity: 'info', summary: `You removed the engine folder ${path} from the list. Nothing on disk was changed.` });
      return { removed: true };
    },
  };
}
