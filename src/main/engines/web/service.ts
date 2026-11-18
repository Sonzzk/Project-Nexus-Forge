import { AppError } from '@shared/errors';
import type { ProjectCommand } from '@shared/permissions';
import type { WebScript, WebView } from '@shared/web';
import type { ProjectRegistry } from '../../projects';
import type { CommandService, ExtraCommand } from '../../security';
import { installCommand, webCapabilities } from './commands';
import { describeWebProject } from './project';
import type { ServerRegistry } from './servers';

// The web service (spec §16 Vite): what a project's package.json, lockfile and Vite config say, the scripts it can run (approved one by
// one, through the same approved-commands pipeline as everything else), and the servers among them, which this app owns and can stop.
// Only a script listed in package.json can be started; a label that is not in the list is refused.

/** The commands this integration adds to a project's own scripts (the lockfile install), for the command service. */
export function webCommandsFor(rootPath: string): ExtraCommand[] {
  const facts = describeWebProject(rootPath);
  if (facts === undefined) return [];
  const install = installCommand(facts, rootPath);
  return 'command' in install ? [install.command] : [];
}

/** The package manager a project's scripts run with: from package.json or the lockfile, npm when neither says. */
export const packageManagerOf = (rootPath: string): string => describeWebProject(rootPath)?.packageManager.name ?? 'npm';

export interface WebServiceOptions {
  projects: ProjectRegistry;
  commands: CommandService;
  servers: ServerRegistry;
  /** Opens an http://localhost URL in the person's browser. */
  openExternal: (url: string) => Promise<void>;
  now?: () => Date;
}

export interface WebService {
  view(projectId: string): WebView;
  startServer(projectId: string, label: string): Promise<{ started: boolean; serverId: string | null }>;
  stopServer(serverId: string): Promise<{ stopped: boolean }>;
  openServer(serverId: string): Promise<{ opened: boolean }>;
}

const scriptName = (label: string): string => label.replace(/^\S+ run /, '');

export function createWebService(options: WebServiceOptions): WebService {
  const { projects, commands, servers } = options;
  const now = options.now ?? (() => new Date());

  const projectOf = (id: string) => {
    const found = projects.get(id);
    if (found === undefined) throw new AppError('NOT_FOUND', 'That project is not in the registry.', { hint: 'It may have been removed. Reload the project list.' });
    return found;
  };
  const approved = (c: ProjectCommand): boolean => c.approval !== null && !c.approval.changed;

  return {
    view(projectId) {
      const project = projectOf(projectId);
      const facts = describeWebProject(project.rootPath);
      const listed = facts === undefined ? [] : commands.discover(projectId).commands;
      const scripts: WebScript[] = listed
        .filter((c) => c.source === 'script')
        .map((c) => ({ name: scriptName(c.label), body: c.body, kind: c.kind, longRunning: c.longRunning, label: c.label, approved: approved(c), changed: c.approval?.changed === true }));
      const install = facts === undefined ? undefined : installCommand(facts, project.rootPath);
      const installLabel = install !== undefined && 'command' in install ? install.command.label : undefined;
      return {
        isWeb: facts !== undefined,
        project: facts === undefined ? null : { ...facts, scripts },
        servers: servers.list(projectId),
        capabilities: webCapabilities({ project: facts, scripts, install }),
        extraCommands: listed.filter((c) => c.source === 'engine' && c.label === installLabel).map((c) => ({ label: c.label, writes: c.writes, approved: approved(c) })),
        checkedAt: now().toISOString(),
      };
    },

    async startServer(projectId, label) {
      projectOf(projectId);
      const command = commands.discover(projectId).commands.find((c) => c.label === label && c.source === 'script');
      if (command === undefined) throw new AppError('NOT_FOUND', 'That script is not in this project\'s package.json.', { hint: 'Only scripts the project lists can be started.' });
      if (!command.longRunning) throw new AppError('INVALID_INPUT', `"${label}" runs to completion; it is not a server.`, { hint: 'Run it from Permissions on the AI Workbench.' });
      if (command.approval === null) throw new AppError('PERMISSION_REQUIRED', 'This script has not been approved.', { hint: 'Approve it first; you will see its text.' });
      const auth = await commands.authorize(command.approval.id, 'server');
      if (auth === null) return { started: false, serverId: null };
      const { id } = servers.start({ projectId, projectName: auth.projectName, label: auth.label, program: auth.program, args: auth.args, cwd: auth.cwd });
      return { started: true, serverId: id };
    },

    stopServer: (serverId) => servers.stop(serverId),

    async openServer(serverId) {
      const port = servers.runningPort(serverId);
      if (port === null) throw new AppError('NOT_FOUND', 'That server is not running or has not printed a port yet.', { hint: 'Wait for it to print its address, then try again.' });
      await options.openExternal(`http://localhost:${port}/`);
      return { opened: true };
    },
  };
}
