import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import { AppError } from '@shared/errors';
import type { CommandResult, ProjectCommand } from '@shared/permissions';
import type { ActivityLog, Redactor } from '../logging';
import type { ProcessRunner } from '../process';
import type { ProjectRegistry } from '../projects';
import type { Db } from '../storage';
import { resolveInside } from './path-policy';
import type { Confirm, PermissionService } from './permissions';

// Approved commands (spec §14). A project's own commands (package.json scripts so far) are discovered, never invented. The
// person approves each one in a native window; only an approved command whose script is unchanged can be run, and it runs as
// an argument array through the process runner, never as a shell string. A command that looks destructive needs a stronger
// approval, and asks again every time it runs. Nothing here is available to an agent.

// ------------------------------------------------------------------------------------------------------ classification

const DELETE_PROGRAMS = new Set(['rm', 'rmdir', 'rd', 'del', 'erase', 'remove-item', 'ri', 'rimraf', 'del-cli', 'shred', 'unlink']);
const DISK_PROGRAMS = new Set(['format', 'format-volume', 'diskpart', 'mkfs', 'clear-disk', 'cipher']);
const WRAPPERS = new Set(['cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe', 'sh', 'bash', 'zsh']);

/** The shell's own leading options (`/d /s /c`, `-NoProfile -Command`); what follows them is the text that gets classified, flags included. */
const LEADING_WRAPPER_OPTIONS = /^(?:(?:\/[cdksq]|-c|-command|-noprofile|-nologo|-noninteractive|-executionpolicy|bypass|-file)\s+)+/i;
const unquote = (token: string): string => token.replace(/^["']+|["']+$/g, '');
const programOf = (token: string): string => basename(unquote(token).replace(/\\/g, '/')).toLowerCase().replace(/\.(exe|cmd|bat|com|ps1)$/, '');

/** Reasons one command (a program and its arguments) looks destructive; empty when nothing matched. */
function classifySegment(tokens: string[]): string[] {
  const reasons: string[] = [];
  const raw = tokens.map(unquote);
  // `npx rimraf`, `env X=1 rm`, `sudo rm`: look past a launcher
  let start = 0;
  while (start < raw.length - 1 && ['npx', 'pnpx', 'env', 'sudo', 'call', 'start', 'time', 'timeout', 'nice', 'nohup', 'command'].includes(programOf(raw[start] ?? ''))) start++;
  while (start < raw.length - 1 && /^[A-Za-z_]\w*=/.test(raw[start] ?? '')) start++;
  const [first = '', ...rest] = raw.slice(start);
  const program = programOf(first);
  const args = rest.map((a) => a.toLowerCase());
  if (program === '') return reasons;

  if (DELETE_PROGRAMS.has(program)) {
    const recursive = args.some((a) => /^-[a-z]*r[a-z]*$/.test(a) || a === '--recursive' || a === '/s' || a === '-recurse' || a === '-r');
    reasons.push(recursive ? `${program} deletes folders and everything in them` : `${program} deletes files`);
  }
  if (DISK_PROGRAMS.has(program)) reasons.push(`${program} formats or wipes a drive`);
  if (program === 'robocopy' && args.some((a) => a === '/mir' || a === '/purge')) reasons.push('robocopy /mir or /purge deletes files in the destination');
  if (program === 'git') {
    const sub = args.find((a) => !a.startsWith('-') && !a.includes('=')) ?? '';
    const has = (...flags: string[]): boolean => args.some((a) => flags.includes(a));
    if (sub === 'reset') reasons.push('git reset moves the branch and can discard changes');
    if (sub === 'clean') reasons.push('git clean deletes untracked files');
    if (sub === 'checkout' && has('-f', '--force', '.', '--')) reasons.push('git checkout can overwrite your working files');
    if (sub === 'switch' && has('-f', '--force', '--discard-changes')) reasons.push('git switch --force discards changes');
    if (sub === 'restore' && !has('--staged')) reasons.push('git restore overwrites working files');
    if (sub === 'push' && (has('-f', '--force', '--delete', '-d', '--mirror') || args.some((a) => a.startsWith('--force-with-lease') || a.startsWith('+') || a.startsWith(':')))) reasons.push('git push can overwrite or delete remote history');
    if (sub === 'rebase') reasons.push('git rebase rewrites history');
    if (sub === 'filter-branch' || sub === 'filter-repo') reasons.push(`git ${sub} rewrites history`);
    if (sub === 'commit' && has('--amend')) reasons.push('git commit --amend rewrites the last commit');
    if (sub === 'branch' && has('-d', '--delete')) reasons.push('git branch -d or -D deletes a branch');
    if (sub === 'tag' && has('-d', '--delete')) reasons.push('git tag -d deletes a tag');
    if (sub === 'stash' && args.some((a) => a === 'drop' || a === 'clear')) reasons.push('git stash drop discards saved work');
    if (sub === 'reflog' && args.includes('expire')) reasons.push('git reflog expire removes the way back');
    if (sub === 'gc' && args.some((a) => a.startsWith('--prune'))) reasons.push('git gc --prune removes unreachable commits');
    if (sub === 'update-ref' && has('-d')) reasons.push('git update-ref -d deletes a reference');
  }
  return reasons;
}

/** Splits a script or command line into the commands it chains, and looks inside `cmd /c`, `powershell -Command` and `sh -c`. */
function segments(text: string): string[][] {
  return text
    .split(/&&|\|\||[;|&\r\n]/)
    .map((part) => (part.match(/"[^"]*"|'[^']*'|\S+/g) ?? []) as string[])
    .filter((tokens) => tokens.length > 0);
}

/**
 * Why a command looks destructive, from a program and its arguments or from the text of a script. Empty means nothing matched,
 * which is not a promise that it is safe: the list is a net for the common cases (spec §14), and every approval is still a person's.
 */
export function classifyCommand(command: readonly string[] | string): string[] {
  const text = typeof command === 'string' ? command : command.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
  const reasons: string[] = [];
  const visit = (value: string, depth: number): void => {
    for (const tokens of segments(value)) {
      reasons.push(...classifySegment(tokens));
      const program = programOf(tokens[0] ?? '');
      if (depth < 3 && WRAPPERS.has(program) && tokens.length > 1) visit(tokens.slice(1).map(unquote).join(' ').replace(LEADING_WRAPPER_OPTIONS, ''), depth + 1);
    }
  };
  visit(text, 0);
  return [...new Set(reasons)];
}

// ------------------------------------------------------------------------------------------------------------ service

/** A command an engine integration discovered. It is approved and run exactly like a script, and bound to its argument array. */
export interface ExtraCommand {
  label: string;
  /** The program (an absolute path) and its arguments. */
  argv: string[];
  /** What it does, in plain words, shown in the approval window. */
  body: string;
  timeoutMs?: number;
  /** It writes files in the project. */
  writes: boolean;
}

export interface CommandServiceOptions {
  db: Db;
  projects: ProjectRegistry;
  permissions: PermissionService;
  activity: ActivityLog;
  runner: ProcessRunner;
  redactor: Redactor;
  confirm: Confirm;
  /** Finds `npm` and other programs by name; undefined when not installed. */
  locate: (name: string) => string | undefined;
  /** Commands that engine integrations found for a project (a build, say). Their program is an absolute path. */
  extra?: (projectId: string) => ExtraCommand[];
  timeoutMs: () => number;
  now?: () => Date;
  newId?: () => string;
}

export interface CommandService {
  /** The project's own commands, each with whether it was approved. */
  discover(projectId: string): { commands: ProjectCommand[]; note: string };
  /** Asks in a native window; destructive-looking commands get a stronger wording. Null if declined. */
  approve(projectId: string, label: string): Promise<{ id: string } | null>;
  revoke(id: string): void;
  /** Runs an approved command whose script is unchanged. A destructive one asks again each time. */
  run(id: string): Promise<CommandResult>;
  /** The saved logs of earlier runs in a project, newest first (without their text). */
  history(projectId: string, limit?: number): { id: string; label: string; startedAt: string; endedAt: string | null; status: string; exitCode: number | null }[];
  /** The saved, redacted output of one run. */
  log(id: string): { id: string; label: string; startedAt: string; status: string; exitCode: number | null; output: string; truncated: boolean };
}

interface ScriptInfo {
  label: string;
  argv: string[];
  body: string;
  hash: string;
  risks: string[];
  source: 'script' | 'engine';
  writes: boolean;
  timeoutMs?: number;
}
interface ApprovedRow {
  id: string;
  project_id: string;
  label: string;
  argv_json: string;
  body_hash: string;
  destructive: number;
  approved_at: string;
  revoked_at: string | null;
}

const MAX_PACKAGE_JSON = 1024 * 1024;
const OUTPUT_TAIL = 20_000;
/** The longest output kept in a saved log (a build can print a lot; the end is what matters). */
const MAX_LOG = 200_000;
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

export function createCommandService(options: CommandServiceOptions): CommandService {
  const { db, projects, permissions, activity, runner, redactor } = options;
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? randomUUID;

  const projectOf = (id: string) => {
    const found = projects.get(id);
    if (found === undefined) throw new AppError('NOT_FOUND', 'That project is not in the registry.', { hint: 'It may have been removed. Reload the project list.' });
    return found;
  };

  /** The scripts of the project's package.json. `npm run x` also runs `prex` and `postx`, so those are part of what is approved. */
  function scripts(rootPath: string): { scripts: ScriptInfo[]; note: string } {
    let file: string;
    try {
      file = resolveInside(rootPath, 'package.json');
      if (statSync(file).size > MAX_PACKAGE_JSON) return { scripts: [], note: 'package.json is too large to read here.' };
    } catch {
      return { scripts: [], note: 'No package.json was found in this project, so no commands are listed. Engine commands arrive with the engine steps.' };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      return { scripts: [], note: 'package.json could not be read as JSON.' };
    }
    const source = (parsed as { scripts?: unknown } | null)?.scripts;
    if (typeof source !== 'object' || source === null || Array.isArray(source)) return { scripts: [], note: 'package.json has no scripts.' };
    const table = source as Record<string, unknown>;
    const text = (name: string): string | undefined => (typeof table[name] === 'string' ? table[name] : undefined);
    // `prebuild` and `postbuild` are listed with `build`, not on their own, unless there is no `build`.
    const isHook = (name: string): boolean => {
      const base = /^(?:pre|post)(.+)$/.exec(name)?.[1];
      return base !== undefined && text(base) !== undefined;
    };
    const found = Object.keys(table)
      .filter((name) => typeof table[name] === 'string' && !isHook(name))
      .slice(0, 100)
      .map((name): ScriptInfo => {
        const parts = [text(`pre${name}`), text(name), text(`post${name}`)].filter((p): p is string => p !== undefined);
        const body = parts.join('\n');
        return { label: `npm run ${name}`, argv: ['npm', 'run', name], body: redactor.redact(body).slice(0, 500), hash: sha(JSON.stringify(parts)), risks: classifyCommand(body), source: 'script', writes: false };
      });
    return { scripts: found, note: found.length === 0 ? 'package.json has no scripts.' : '' };
  }

  /** The project's scripts and the commands its engine integration found. */
  function allCommands(projectId: string, rootPath: string): { scripts: ScriptInfo[]; note: string } {
    const own = scripts(rootPath);
    const extra = (options.extra?.(projectId) ?? []).map(
      (c): ScriptInfo => ({ label: c.label, argv: c.argv, body: redactor.redact(c.body).slice(0, 500), hash: sha(JSON.stringify([c.argv, c.body])), risks: classifyCommand(c.argv), source: 'engine', writes: c.writes, ...(c.timeoutMs === undefined ? {} : { timeoutMs: c.timeoutMs }) }),
    );
    return { scripts: [...own.scripts, ...extra], note: extra.length > 0 && own.scripts.length === 0 ? '' : own.note };
  }

  const approvedFor = (projectId: string): ApprovedRow[] => db.all<ApprovedRow>('SELECT * FROM approved_commands WHERE project_id = ? AND revoked_at IS NULL', projectId);

  return {
    discover(projectId) {
      const project = projectOf(projectId);
      const { scripts: found, note } = allCommands(projectId, project.rootPath);
      const approved = new Map(approvedFor(projectId).map((row) => [row.label, row]));
      return {
        note,
        commands: found.map((script) => {
          const row = approved.get(script.label);
          return {
            label: script.label,
            argv: script.argv,
            body: script.body,
            risks: script.risks,
            source: script.source,
            writes: script.writes,
            approval: row === undefined ? null : { id: row.id, approvedAt: row.approved_at, destructive: row.destructive === 1, changed: row.body_hash !== script.hash },
          };
        }),
      };
    },

    async approve(projectId, label) {
      const project = projectOf(projectId);
      const script = allCommands(projectId, project.rootPath).scripts.find((s) => s.label === label);
      if (script === undefined) throw new AppError('NOT_FOUND', 'That command is not in this project.', { hint: 'Only commands found in the project can be approved.' });
      const destructive = script.risks.length > 0;
      const ok = await options.confirm({
        title: destructive ? 'Approve a command that looks destructive?' : 'Approve this command?',
        message: `Allow this app to run "${script.label}" in ${project.rootPath}?`,
        detail: [
          `${script.source === 'engine' ? 'It runs' : "It runs the project's own script"}:\n${script.body === '' ? '(empty)' : script.body}`,
          destructive ? `This looks destructive:\n- ${script.risks.join('\n- ')}\n\nYou will be asked again every time it runs.` : script.source === 'engine' ? 'It starts the engine\'s own tool on your PC, as if you typed it in a terminal.' : 'That is code from the project running on your PC, as if you typed it in a terminal.',
          'If the script text changes later, it will not run until you approve it again. Agents cannot run it.',
        ].join('\n\n'),
        confirmLabel: destructive ? 'Approve anyway' : 'Approve',
      });
      if (!ok) return null;
      const id = newId();
      db.transaction(() => {
        db.run('UPDATE approved_commands SET revoked_at = ? WHERE project_id = ? AND label = ? AND revoked_at IS NULL', now().toISOString(), projectId, label);
        db.run('INSERT INTO approved_commands (id, project_id, label, argv_json, body_hash, destructive, approved_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, projectId, label, JSON.stringify(script.argv), script.hash, destructive ? 1 : 0, now().toISOString());
        permissions.record({ projectId, scope: destructive ? 'destructive' : 'commands', what: `Approved command: ${label}`, where: project.rootPath, detail: script.risks.join('; ') });
      });
      activity.record({ kind: 'command.approved', severity: destructive ? 'warning' : 'info', summary: `You approved the command "${label}" in "${project.name}".`, projectId, details: { destructive } });
      return { id };
    },

    revoke(id) {
      const row = db.get<ApprovedRow>('SELECT * FROM approved_commands WHERE id = ?', id);
      if (row === undefined) throw new AppError('NOT_FOUND', 'That approval does not exist.');
      if (row.revoked_at !== null) return;
      db.run('UPDATE approved_commands SET revoked_at = ? WHERE id = ?', now().toISOString(), id);
      activity.record({ kind: 'command.revoked', severity: 'info', summary: `You took back the approval of "${row.label}".`, projectId: row.project_id });
    },

    async run(id) {
      const row = db.get<ApprovedRow>('SELECT * FROM approved_commands WHERE id = ?', id);
      if (row === undefined || row.revoked_at !== null) throw new AppError('PERMISSION_REQUIRED', 'This command is not approved.', { hint: 'Approve it first.' });
      const project = projectOf(row.project_id);
      const script = allCommands(row.project_id, project.rootPath).scripts.find((s) => s.label === row.label);
      if (script === undefined) throw new AppError('NOT_FOUND', `"${row.label}" is no longer in the project.`);
      if (script.hash !== row.body_hash)
        throw new AppError('PERMISSION_REQUIRED', `The script behind "${row.label}" changed since you approved it, so it was not run.`, { hint: 'Read the new script and approve the command again.' });
      const argv = JSON.parse(row.argv_json) as string[];
      if (script.risks.length > 0 || row.destructive === 1) {
        const ok = await options.confirm({
          title: 'Run a command that looks destructive?',
          message: `Run "${row.label}" in ${project.rootPath} now?`,
          detail: `${script.body}\n\nThis looks destructive:\n- ${script.risks.join('\n- ')}\n\nThere is no undo for deleted files unless Git or a backup has them.`,
          confirmLabel: 'Run it',
        });
        if (!ok) return { ran: false, status: null, exitCode: null, output: '', truncated: false, logId: null };
        permissions.record({ projectId: row.project_id, scope: 'destructive', what: `Ran destructive command: ${row.label}`, where: project.rootPath, detail: script.risks.join('; ') });
      }
      const first = argv[0] ?? '';
      const program = isAbsolute(first) ? (existsSync(first) ? first : undefined) : options.locate(first);
      if (program === undefined) throw new AppError('TOOL_NOT_INSTALLED', `${argv[0] ?? 'The program'} was not found on this PC.`, { hint: 'Install Node.js, then try again.' });
      activity.record({ kind: 'command.run', severity: 'info', summary: `Running "${row.label}" in "${project.name}".`, projectId: row.project_id });
      const result = await runner.start({
        executable: program,
        args: argv.slice(1),
        cwd: project.rootPath,
        timeoutMs: script.timeoutMs ?? options.timeoutMs(),
        maxOutputBytes: 1024 * 1024,
        purpose: `Run ${row.label}`,
        owner: { kind: 'test-run', id: `command-${id}` },
        projectId: row.project_id,
      }).result;
      const combined = redactor.redact(`${result.stdoutTail}${result.stderrTail === '' ? '' : `\n${result.stderrTail}`}`.trim());
      activity.record({
        kind: 'command.finished',
        severity: result.status === 'exited' && result.exitCode === 0 ? 'info' : 'warning',
        summary: `"${row.label}" ${result.status === 'exited' ? `finished with exit code ${result.exitCode ?? '?'}` : result.status.replace('-', ' ')}.`,
        projectId: row.project_id,
        details: { exitCode: result.exitCode, status: result.status },
      });
      const logId = newId();
      db.run('INSERT INTO command_runs (id, project_id, label, started_at, ended_at, status, exit_code, output, truncated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', logId, row.project_id, row.label, result.startedAt, result.endedAt, result.status, result.exitCode, combined.slice(-MAX_LOG), result.truncated || combined.length > MAX_LOG ? 1 : 0);
      return { ran: true, status: result.status, exitCode: result.exitCode, output: combined.slice(-OUTPUT_TAIL), truncated: result.truncated || combined.length > OUTPUT_TAIL, logId };
    },

    history(projectId, limit = 30) {
      projectOf(projectId);
      return db
        .all<{ id: string; label: string; started_at: string; ended_at: string | null; status: string; exit_code: number | null }>('SELECT id, label, started_at, ended_at, status, exit_code FROM command_runs WHERE project_id = ? ORDER BY started_at DESC, id LIMIT ?', projectId, limit)
        .map((r) => ({ id: r.id, label: r.label, startedAt: r.started_at, endedAt: r.ended_at, status: r.status, exitCode: r.exit_code }));
    },

    log(id) {
      const r = db.get<{ id: string; label: string; started_at: string; status: string; exit_code: number | null; output: string; truncated: number }>('SELECT id, label, started_at, status, exit_code, output, truncated FROM command_runs WHERE id = ?', id);
      if (r === undefined) throw new AppError('NOT_FOUND', 'There is no saved log with that id.', { hint: 'Old logs are removed under the retention limits.' });
      return { id: r.id, label: r.label, startedAt: r.started_at, status: r.status, exitCode: r.exit_code, output: r.output, truncated: r.truncated === 1 };
    },
  };
}
