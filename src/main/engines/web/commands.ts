import type { CapabilityState } from '@shared/unreal';
import type { WebProject } from '@shared/web';
import type { ExtraCommand } from '../../security';
import { yarnIsBerry, type WebProjectFacts } from './project';

// What this app offers beyond a project's own scripts (spec §16 Vite): one command, installing the dependencies exactly as the lockfile
// says. It is offered only when the project has a lockfile that names its package manager, and never as `install`, `add` or
// `update`, which can pick new versions and rewrite package.json or the lockfile. Like every command, it is approved by the person in
// a native window and run by the app through the process runner; agents cannot run it.

/** The install command for the project's package manager, or undefined with the reason none is offered. */
export function installCommand(facts: WebProjectFacts, root: string): { command: ExtraCommand } | { reason: string } {
  const pm = facts.packageManager;
  if (pm.lockfile === null) return { reason: 'There is no lockfile, so no install command is offered: one without a lockfile would choose versions on its own.' };
  if (pm.ambiguous) return { reason: 'More than one package manager has a lockfile here and package.json does not name one, so it is not clear which install would be right.' };
  const berry = pm.name === 'yarn' && (Number((pm.version ?? '').split('.')[0]) >= 2 || yarnIsBerry(root));
  const argv = { npm: ['npm', 'ci'], pnpm: ['pnpm', 'install', '--frozen-lockfile'], yarn: berry ? ['yarn', 'install', '--immutable'] : ['yarn', 'install', '--frozen-lockfile'], bun: ['bun', 'install', '--frozen-lockfile'] }[pm.name];
  const line = argv.join(' ');
  const effect =
    pm.name === 'npm'
      ? 'npm ci deletes the node_modules folder first, then installs exactly the versions in the lockfile; it stops with an error if package.json and the lockfile disagree.'
      : `${pm.name} installs exactly the versions in ${pm.lockfile} and stops with an error if package.json and the lockfile disagree.`;
  return {
    command: {
      label: `${pm.name}: install exactly what ${pm.lockfile} says`,
      argv,
      body: `Installs the project's dependencies from its lockfile:\n${line}\n${effect} It does not change package.json or the lockfile. It downloads packages from the package registry (network) and runs the install scripts some packages have, which is code from those packages running with your account's rights.`,
      timeoutMs: 20 * 60_000,
      writes: true,
    },
  };
}

export interface WebCapabilityInputs {
  project: WebProjectFacts | undefined;
  scripts: Pick<WebProject['scripts'][number], 'kind' | 'longRunning'>[];
  install: { command: ExtraCommand } | { reason: string } | undefined;
}

/** What this integration can do for the project right now, and why not when it cannot. */
export function webCapabilities({ project, scripts, install }: WebCapabilityInputs): { id: string; label: string; state: CapabilityState; reason: string }[] {
  const cap = (id: string, label: string, state: CapabilityState, reason = ''): { id: string; label: string; state: CapabilityState; reason: string } => ({ id, label, state, reason });
  const found = project !== undefined;
  const none = 'There is no readable package.json at the top of this project folder.';
  const servers = scripts.filter((s) => s.longRunning).length;
  const tasks = scripts.length - servers;
  return [
    cap('detect', 'Read package.json, the lockfile and the Vite config', found ? 'implemented' : 'unavailable', found ? '' : none),
    cap('package-manager', 'Choose the package manager from package.json or the lockfile', found ? 'implemented' : 'unavailable', found ? `${project.packageManager.name} (${project.packageManager.source === 'packageManager-field' ? 'named in package.json' : project.packageManager.source === 'lockfile' ? `from ${project.packageManager.lockfile ?? 'the lockfile'}` : 'the default: no lockfile'}).` : none),
    cap('scripts', 'Run approved scripts to completion (lint, type-check, test, build)', !found ? 'unavailable' : tasks > 0 ? 'implemented' : 'unavailable', !found ? none : tasks > 0 ? `${tasks} script${tasks === 1 ? '' : 's'} found. Each is approved first (AI Workbench, Permissions) and its output is kept.` : 'package.json has no such script.'),
    cap('server', 'Start an approved dev or preview server that this app owns', !found ? 'unavailable' : servers > 0 ? 'implemented' : 'unavailable', !found ? none : servers > 0 ? `${servers} server script${servers === 1 ? '' : 's'} found.` : 'package.json has no dev, serve, start or preview script.'),
    cap('ports', 'Show the port the server prints for itself', 'implemented', 'Read from the server\'s own output (a localhost address). A server that prints none shows no port.'),
    cap('stop', 'Stop a server (its whole process tree) and end every server when this app quits', 'implemented'),
    cap('install', 'Install dependencies exactly as the lockfile says (approved)', install === undefined ? 'unavailable' : 'command' in install ? 'implemented' : 'unavailable', install === undefined ? none : 'command' in install ? install.command.argv.join(' ') : install.reason),
    cap('dependencies', 'Add, remove or upgrade packages', 'unavailable', 'Not offered: this app never changes versions or rewrites package.json or a lockfile on its own.'),
  ];
}
