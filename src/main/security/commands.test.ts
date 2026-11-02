import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppError } from '@shared/errors';
import { openMigratedDb } from '../../../test/helpers/db';
import { memoryLogger } from '../../../test/helpers/logger';
import { makeTempDir, removeTempDirs } from '../../../test/helpers/temp';
import { createActivityLog, createRedactor } from '../logging';
import { createProcessRunner } from '../process';
import { locateProgram } from '../providers';
import { createProjectRegistry } from '../projects';
import { classifyCommand, createCommandService } from './commands';
import { createPermissionService } from './permissions';
import type { ExtraCommand } from './commands';
import { copyFixture } from '../../../test/helpers/tree';

afterEach(removeTempDirs);

describe('classifyCommand', () => {
  const destructive: [string | string[], RegExp][] = [
    ['rm -rf node_modules', /deletes folders/],
    ['rm -fr build', /deletes folders/],
    ['rm -r dist', /deletes folders/],
    ['rm notes.txt', /deletes files/],
    [['rm', '-rf', '/'], /deletes folders/],
    ['rmdir /s /q build', /deletes folders/],
    ['rd /s /q build', /deletes folders/],
    ['del /s *.tmp', /deletes folders/],
    ['del file.txt', /deletes files/],
    ['Remove-Item -Recurse -Force .\\build', /deletes folders/],
    ['npx rimraf dist', /rimraf/],
    ['git reset --hard HEAD~1', /git reset/],
    ['git reset', /git reset/],
    ['git clean -fdx', /git clean/],
    ['git checkout -f main', /git checkout/],
    ['git checkout .', /git checkout/],
    ['git checkout -- src/a.js', /git checkout/],
    ['git switch --discard-changes main', /git switch/],
    ['git restore src/a.js', /git restore/],
    ['git push --force origin main', /git push/],
    ['git push -f', /git push/],
    ['git push origin +main', /git push/],
    ['git push origin :old-branch', /git push/],
    ['git push --force-with-lease', /git push/],
    ['git rebase -i HEAD~3', /git rebase/],
    ['git filter-branch --tree-filter x', /rewrites history/],
    ['git commit --amend -m x', /amend/],
    ['git branch -D old', /deletes a branch/],
    ['git stash drop', /stash/],
    ['git reflog expire --expire=now --all', /reflog/],
    ['git gc --prune=now', /prune/],
    ['format D:', /formats or wipes/],
    ['diskpart /s script.txt', /formats or wipes/],
    ['robocopy a b /MIR', /robocopy/],
    ['npm run build && rm -rf cache', /deletes folders/],
    ['echo done; git clean -fd', /git clean/],
    ['cmd /c rmdir /s /q build', /deletes folders/],
    ['powershell -NoProfile -Command "Remove-Item -Recurse x"', /deletes folders/],
    ['bash -c "rm -rf x"', /deletes folders/],
    ['sudo rm -rf /', /deletes folders/],
    ['env CI=1 rm -rf x', /deletes folders/],
  ];
  it.each(destructive)('flags %j', (command, reason) => {
    const reasons = classifyCommand(command);
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons.join(' | ')).toMatch(reason);
  });

  const harmless: (string | string[])[] = [
    'npm run test',
    ['npm', 'run', 'build'],
    'node scripts/make.js --clean-cache',
    'git status',
    'git diff --stat',
    'git log -n 5',
    'git checkout -b feature',
    'git checkout main',
    'git switch main',
    'git restore --staged a.js',
    'git push origin main',
    'git branch feature',
    'git stash',
    'echo "remove this later"',
    'vite build --mode production',
    'eslint . --fix',
    'tsc --noEmit',
    'godot --headless --quit',
  ];
  it.each(harmless)('leaves %j alone', (command) => {
    expect(classifyCommand(command)).toEqual([]);
  });

  it('lists each reason once', () => {
    expect(classifyCommand('rm -rf a && rm -rf b')).toHaveLength(1);
  });
});

const extraHolder: { commands: ExtraCommand[] } = { commands: [] };

async function env(scripts: Record<string, string> | null = { hello: "node -e \"console.log('hello from the script')\"", clean: 'rm -rf dist' }) {
  const { db } = await openMigratedDb();
  const logger = memoryLogger();
  const redactor = createRedactor();
  const activity = createActivityLog({ db, redactor, logger });
  const projects = createProjectRegistry({ db, activity, logger });
  const dir = makeTempDir();
  mkdirSync(join(dir, 'src'));
  if (scripts !== null) writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'throwaway', scripts }));
  writeFileSync(join(dir, 'src', 'a.js'), 'x');
  const project = projects.add(dir);
  const asked: { title: string; message: string; detail?: string | undefined }[] = [];
  const answer = { yes: true };
  const confirm = (o: { title: string; message: string; detail?: string }): Promise<boolean> => {
    asked.push(o);
    return Promise.resolve(answer.yes);
  };
  const permissions = createPermissionService({ db, projects, activity, confirm });
  const runner = createProcessRunner({ logger, redactor });
  const commands = createCommandService({ db, projects, permissions, activity, runner, redactor, confirm, locate: (name) => locateProgram([`${name}.cmd`, `${name}.exe`]), timeoutMs: () => 60_000, extra: () => extraHolder.commands });
  const rewrite = (next: Record<string, string>): void => writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'throwaway', scripts: next }));
  return { db, dir, project, commands, permissions, asked, answer, activity, rewrite };
}

const failure = async (promise: Promise<unknown>): Promise<AppError> => {
  try {
    await promise;
  } catch (error) {
    return error as AppError;
  }
  throw new Error('expected a failure');
};

describe('discovering project commands', () => {
  it('lists the package.json scripts as argument arrays, marks destructive ones, and approves nothing by itself', async () => {
    const e = await env();
    const { commands, note } = e.commands.discover(e.project.id);
    expect(note).toBe('');
    expect(commands.map((c) => c.label).sort()).toEqual(['npm run clean', 'npm run hello']);
    const hello = commands.find((c) => c.label === 'npm run hello');
    expect(hello).toMatchObject({ argv: ['npm', 'run', 'hello'], risks: [], approval: null });
    expect(commands.find((c) => c.label === 'npm run clean')?.risks[0]).toContain('deletes folders');
  });

  it('reads pre and post scripts as part of the command and does not list them on their own', async () => {
    const e = await env({ build: 'tsc', prebuild: 'rm -rf dist', postbuild: 'echo done', prelone: 'echo only a hook' });
    const { commands } = e.commands.discover(e.project.id);
    expect(commands.map((c) => c.label).sort()).toEqual(['npm run build', 'npm run prelone']);
    const build = commands.find((c) => c.label === 'npm run build');
    expect(build?.risks[0]).toContain('deletes folders'); // from prebuild
    expect(build?.body).toContain('tsc');
  });

  it('says why nothing is listed when there is no package.json, and redacts secrets in script text', async () => {
    const none = await env(null);
    expect(none.commands.discover(none.project.id)).toMatchObject({ commands: [], note: expect.stringContaining('No package.json') as unknown });
    const secret = await env({ deploy: 'node push.js --token sk-ant-api03-notreal0123456789' });
    const body = secret.commands.discover(secret.project.id).commands[0]?.body ?? '';
    expect(body).not.toContain('sk-ant-api03-notreal');
  });
});

describe('commands from an engine integration', () => {
  const build = (): ExtraCommand => {
    const engine = copyFixture('engines/UE_5.5');
    return {
      label: 'Unreal: build Backrooms (Win64, Development)',
      argv: [join(engine, 'Engine', 'Build', 'BatchFiles', 'Build.bat'), 'Backrooms', 'Win64', 'Development', '-Project=D:\\My Games\\Backrooms.uproject', '-WaitMutex'],
      body: 'Builds the C++ target Backrooms. It writes files in Binaries and Intermediate.',
      timeoutMs: 60_000,
      writes: true,
    };
  };

  it('are listed with the project scripts, marked as engine commands that write files', async () => {
    const e = await env();
    extraHolder.commands = [build()];
    const { commands } = e.commands.discover(e.project.id);
    expect(commands.map((c) => [c.label, c.source, c.writes])).toEqual(expect.arrayContaining([['Unreal: build Backrooms (Win64, Development)', 'engine', true], ['npm run hello', 'script', false]]));
    extraHolder.commands = [];
  });

  it('are approved in a window that says what they do, then run by the app through the process runner with a path that has spaces, and the output is saved as a log', async () => {
    const e = await env(null);
    extraHolder.commands = [build()];
    const approval = await e.commands.approve(e.project.id, 'Unreal: build Backrooms (Win64, Development)');
    expect(e.asked[0]?.detail).toContain('It writes files in Binaries and Intermediate.');
    expect(e.asked[0]?.detail).toContain("engine's own tool");
    const result = await e.commands.run(approval?.id ?? '');
    expect(result).toMatchObject({ ran: true, status: 'exited', exitCode: 0 });
    expect(result.output).toContain('FIXTURE-BUILD Backrooms Win64 Development');
    expect(result.output).toContain('-Project=D:\\My Games\\Backrooms.uproject'); // one argument, spaces intact
    expect(result.logId).not.toBeNull();
    const [entry] = e.commands.history(e.project.id);
    expect(entry).toMatchObject({ id: result.logId, label: 'Unreal: build Backrooms (Win64, Development)', status: 'exited', exitCode: 0 });
    expect(e.commands.log(result.logId ?? '')).toMatchObject({ output: expect.stringContaining('FIXTURE-BUILD') as unknown, truncated: false });
    extraHolder.commands = [];
  });

  it('stop running when the engine command changes after approval (a different engine or arguments), and are refused when the program is gone', async () => {
    const e = await env(null);
    extraHolder.commands = [build()];
    const approval = await e.commands.approve(e.project.id, 'Unreal: build Backrooms (Win64, Development)');
    extraHolder.commands = [{ ...build(), argv: [...build().argv, '-Clean'] }];
    expect(await failure(e.commands.run(approval?.id ?? ''))).toMatchObject({ code: 'PERMISSION_REQUIRED', message: expect.stringContaining('changed since you approved it') as unknown });
    const gone = { ...build(), argv: ['C:\\no\\such\\Build.bat', 'X'] };
    extraHolder.commands = [gone];
    const again = await e.commands.approve(e.project.id, gone.label);
    expect(await failure(e.commands.run(again?.id ?? ''))).toMatchObject({ code: 'TOOL_NOT_INSTALLED' });
    extraHolder.commands = [];
  });

  it('keep history per project and refuse an unknown log', async () => {
    const e = await env(null);
    expect(e.commands.history(e.project.id)).toEqual([]);
    expect(() => e.commands.log('nope')).toThrow();
  });
});

describe('approving and running commands', () => {
  it('runs nothing that was not approved, and an approval needs the window', async () => {
    const e = await env();
    e.answer.yes = false;
    expect(await e.commands.approve(e.project.id, 'npm run hello')).toBeNull();
    expect(e.commands.discover(e.project.id).commands.find((c) => c.label === 'npm run hello')?.approval).toBeNull();
    expect(await failure(e.commands.run('nope'))).toMatchObject({ code: 'PERMISSION_REQUIRED' });
    expect(await failure(e.commands.approve(e.project.id, 'npm run missing'))).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('runs an approved command through the process runner in the project folder and shows its redacted output', async () => {
    const e = await env();
    const approval = await e.commands.approve(e.project.id, 'npm run hello');
    expect(e.asked[0]?.detail).toContain('code from the project running on your PC');
    expect(e.asked[0]?.detail).toContain('Agents cannot run it');
    const result = await e.commands.run(approval?.id ?? '');
    expect(result).toMatchObject({ ran: true, status: 'exited', exitCode: 0 });
    expect(result.output).toContain('hello from the script');
    expect(e.permissions.approvals(e.project.id)[0]).toMatchObject({ scope: 'commands', what: 'Approved command: npm run hello', where: e.dir });
    expect(e.activity.list({ kinds: ['command.finished'], limit: 3 })).toHaveLength(1);
  });

  it('refuses a command whose script changed after it was approved, until it is approved again', async () => {
    const e = await env();
    const approval = await e.commands.approve(e.project.id, 'npm run hello');
    e.rewrite({ hello: "node -e \"console.log('changed')\"", clean: 'rm -rf dist' });
    expect(e.commands.discover(e.project.id).commands.find((c) => c.label === 'npm run hello')?.approval?.changed).toBe(true);
    const error = await failure(e.commands.run(approval?.id ?? ''));
    expect(error).toMatchObject({ code: 'PERMISSION_REQUIRED' });
    expect(error.message).toContain('changed since you approved it');
    const again = await e.commands.approve(e.project.id, 'npm run hello');
    expect((await e.commands.run(again?.id ?? '')).output).toContain('changed');
    await expect(failure(e.commands.run(approval?.id ?? ''))).resolves.toMatchObject({ code: 'PERMISSION_REQUIRED' }); // the old approval was replaced
  });

  it('a change to a pre or post script also invalidates the approval', async () => {
    const e = await env({ build: "node -e \"console.log('built')\"" });
    const approval = await e.commands.approve(e.project.id, 'npm run build');
    e.rewrite({ build: "node -e \"console.log('built')\"", prebuild: 'rm -rf everything' });
    expect(await failure(e.commands.run(approval?.id ?? ''))).toMatchObject({ code: 'PERMISSION_REQUIRED' });
  });

  it('a destructive-looking command needs a stronger approval and asks again every run; declining runs nothing', async () => {
    const e = await env({ clean: "node -e \"require('fs').writeFileSync('ran.txt','x')\" && rm -rf dist" });
    const approval = await e.commands.approve(e.project.id, 'npm run clean');
    expect(e.asked[0]?.title).toBe('Approve a command that looks destructive?');
    expect(e.asked[0]?.detail).toContain('You will be asked again every time it runs');
    expect(e.permissions.approvals(e.project.id)[0]?.scope).toBe('destructive');

    e.answer.yes = false;
    expect(await e.commands.run(approval?.id ?? '')).toMatchObject({ ran: false });
    expect(() => readFileSync(join(e.dir, 'ran.txt'))).toThrow(); // nothing ran
    expect(e.asked.at(-1)?.title).toBe('Run a command that looks destructive?');

    e.answer.yes = true;
    expect((await e.commands.run(approval?.id ?? '')).ran).toBe(true);
    expect(readFileSync(join(e.dir, 'ran.txt'), 'utf8')).toBe('x');
    expect(e.permissions.approvals(e.project.id).some((a) => a.scope === 'destructive' && a.what.startsWith('Ran destructive command'))).toBe(true);
  });

  it('taking back an approval stops the command', async () => {
    const e = await env();
    const approval = await e.commands.approve(e.project.id, 'npm run hello');
    e.commands.revoke(approval?.id ?? '');
    expect(await failure(e.commands.run(approval?.id ?? ''))).toMatchObject({ code: 'PERMISSION_REQUIRED' });
    expect(e.commands.discover(e.project.id).commands.find((c) => c.label === 'npm run hello')?.approval).toBeNull();
  });

  it('never builds a shell string: the arguments are a fixed array and the program is found by name', async () => {
    const e = await env({ 'x; calc': 'echo hi' });
    const approval = await e.commands.approve(e.project.id, 'npm run x; calc');
    // the odd script name cannot reach cmd.exe: the runner refuses an argument it would have to interpret
    expect(await failure(e.commands.run(approval?.id ?? ''))).toMatchObject({ code: 'INVALID_INPUT' });
  });
});
