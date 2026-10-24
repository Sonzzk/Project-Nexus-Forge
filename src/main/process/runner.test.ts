import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppError } from '@shared/errors';
import { openMigratedDb } from '../../../test/helpers/db';
import { memoryLogger } from '../../../test/helpers/logger';
import { closeOnCleanup, makeTempDir, removeTempDirs } from '../../../test/helpers/temp';
import { createRedactor } from '../logging/redactor';
import { prepareCommand } from './command';
import { createProcessRunner, OUTPUT_KILL_FACTOR, type ProcessRunner, type ProcessSpec } from './runner';
import { createProcessRunStore } from './store';

afterEach(removeTempDirs);

const NODE = process.execPath;
const sleepForever = 'setInterval(() => {}, 1000)';
let counter = 0;

function makeRunner(extra: { store?: ReturnType<typeof createProcessRunStore> } = {}) {
  const logger = memoryLogger();
  const runner = createProcessRunner({ logger, redactor: createRedactor(), graceMs: 150, ...extra });
  closeOnCleanup(() => void runner.forceKillAll());
  return { runner, logger };
}

const spec = (script: string, overrides: Partial<ProcessSpec> = {}): ProcessSpec => ({
  executable: NODE,
  args: ['-e', script],
  cwd: makeTempDir(),
  timeoutMs: 20_000,
  maxOutputBytes: 64 * 1024,
  purpose: 'test',
  owner: { kind: 'test-run', id: `t${counter++}` },
  ...overrides,
});

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitUntilDead(pid: number, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isAlive(pid);
}

const firstLine = (
  runner: ProcessRunner,
  s: ProcessSpec,
): Promise<{
  line: string;
  pid: number | undefined;
  cancel: () => Promise<void>;
  done: Promise<{ status: string }>;
}> =>
  new Promise((resolve) => {
    const handle = runner.start(s);
    let text = '';
    const stop = handle.onOutput((chunk) => {
      text += chunk.text;
      if (text.includes('\n')) {
        stop();
        resolve({
          line: text.split('\n')[0] ?? '',
          pid: handle.pid,
          cancel: () => handle.cancel('test'),
          done: handle.result,
        });
      }
    });
  });

describe('running a program', () => {
  it('captures output, exit code and times; arguments are passed as an array, not parsed by a shell', async () => {
    const { runner } = makeRunner();
    const script = "console.log(process.argv.slice(1).join('|')); console.error('err'); process.exit(3)";
    const result = await runner.start(
      spec(script, { args: ['-e', script, 'a b', '&& calc', '$HOME', '"q"'] }),
    ).result;
    expect(result.status).toBe('exited');
    expect(result.exitCode).toBe(3);
    expect(result.stdoutTail.trim()).toBe('a b|&& calc|$HOME|"q"');
    expect(result.stderrTail.trim()).toBe('err');
    expect(result.truncated).toBe(false);
    expect(Date.parse(result.endedAt)).toBeGreaterThanOrEqual(Date.parse(result.startedAt));
  });

  it('sends free text through stdin and passes the environment', async () => {
    const { runner } = makeRunner();
    const result = await runner.start(
      spec(
        "let s=''; process.stdin.on('data', d => s += d); process.stdin.on('end', () => console.log(s.toUpperCase() + process.env.GDCC_TEST_VAR))",
        {
          stdin: 'hello ',
          env: { GDCC_TEST_VAR: 'env-ok' },
        },
      ),
    ).result;
    expect(result.stdoutTail.trim()).toBe('HELLO env-ok');
  });

  it('streams output to subscribers as it arrives, and stops when they unsubscribe', async () => {
    const { runner } = makeRunner();
    const handle = runner.start(spec("console.log('one'); setTimeout(() => console.log('two'), 150)"));
    const seen: string[] = [];
    handle.onOutput((chunk) => seen.push(chunk.text.trim()));
    const quiet: string[] = [];
    handle.onOutput((chunk) => quiet.push(chunk.text))();
    await handle.result;
    expect(seen.filter(Boolean)).toEqual(['one', 'two']);
    expect(quiet).toEqual([]);
  });

  it('reports a program that cannot start as spawn-failed, not as success', async () => {
    const { runner } = makeRunner();
    const notExecutable = join(makeTempDir(), 'notes.txt');
    writeFileSync(notExecutable, 'just text');
    const result = await runner.start(spec('', { executable: notExecutable, args: [] })).result;
    expect(result.status).toBe('spawn-failed');
    expect(result.exitCode).toBeNull();
    expect(result.errorMessage).toBeDefined();
    expect(runner.active()).toEqual([]);
  });
});

describe('refusing to start', () => {
  const thrown = (fn: () => unknown): AppError => {
    try {
      fn();
    } catch (error) {
      return error as AppError;
    }
    throw new Error('expected an error');
  };

  it('refuses a missing program with TOOL_NOT_INSTALLED and a hint', () => {
    const { runner } = makeRunner();
    const error = thrown(() => runner.start(spec('', { executable: join(makeTempDir(), 'nope.exe') })));
    expect(error.code).toBe('TOOL_NOT_INSTALLED');
    expect(error.hint).toBeDefined();
  });

  it('refuses a missing working folder', () => {
    const { runner } = makeRunner();
    expect(thrown(() => runner.start(spec('', { cwd: join(makeTempDir(), 'gone') }))).code).toBe('NOT_FOUND');
  });

  it.each([
    ['a relative executable', { executable: 'node' }],
    ['a relative working folder', { cwd: '.' }],
    ['a zero timeout', { timeoutMs: 0 }],
    ['no purpose', { purpose: '' }],
    ['a huge output cap', { maxOutputBytes: 10 ** 10 }],
    ['a non-string argument', { args: [1 as unknown as string] }],
  ])('refuses %s', (_name, overrides) => {
    const { runner } = makeRunner();
    expect(thrown(() => runner.start(spec('', overrides))).code).toBe('INVALID_INPUT');
  });

  it('refuses a second live program for the same owner, and allows it again after the first ends', async () => {
    const { runner } = makeRunner();
    const owner = { kind: 'agent-run' as const, id: 'run-1' };
    const first = runner.start(spec(sleepForever, { owner }));
    expect(thrown(() => runner.start(spec(sleepForever, { owner }))).code).toBe('CONFLICT');
    await first.cancel('test');
    const second = runner.start(spec('console.log(1)', { owner }));
    expect((await second.result).status).toBe('exited');
  });

  it('refuses new programs once shutdown has started', () => {
    const { runner } = makeRunner();
    runner.stopAccepting();
    expect(thrown(() => runner.start(spec('console.log(1)'))).code).toBe('SHUTTING_DOWN');
  });
});

describe('timeout, cancellation and output cap', () => {
  it('stops a program that runs too long and ends the process', async () => {
    const { runner } = makeRunner();
    const handle = runner.start(spec(sleepForever, { timeoutMs: 300 }));
    const pid = handle.pid ?? 0;
    const result = await handle.result;
    expect(result.status).toBe('timed-out');
    expect(await waitUntilDead(pid)).toBe(true);
    expect(runner.active()).toEqual([]);
  });

  it('cancel ends the whole process tree, including a grandchild', async () => {
    const { runner } = makeRunner();
    const grandchild =
      "const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); console.log(c.pid); setInterval(() => {}, 1000)";
    const started = await firstLine(runner, spec(grandchild));
    const parentPid = started.pid ?? 0;
    const grandchildPid = Number(started.line);
    expect(isAlive(parentPid) && isAlive(grandchildPid)).toBe(true);

    await started.cancel();
    expect((await started.done).status).toBe('cancelled');
    expect(await waitUntilDead(parentPid)).toBe(true);
    expect(await waitUntilDead(grandchildPid)).toBe(true);
  });

  it('a graceful stop lets a program that listens for the end of stdin exit by itself', async () => {
    const { runner } = makeRunner();
    const handle = runner.start(
      spec(
        "process.stdin.on('end', () => { console.log('clean exit'); process.exit(0); }); process.stdin.resume()",
        {
          gracefulStop: 'close-stdin',
        },
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    await handle.cancel('user pressed stop');
    const result = await handle.result;
    expect(result.status).toBe('cancelled');
    expect(result.exitCode).toBe(0); // it stopped itself; it was not killed
    expect(result.stdoutTail).toContain('clean exit');
  });

  it('a graceful stop that is ignored ends in a tree kill after the grace period', async () => {
    const { runner } = makeRunner();
    const handle = runner.start(
      spec('process.stdin.resume(); setInterval(() => {}, 1000)', { gracefulStop: 'close-stdin' }),
    );
    const pid = handle.pid ?? 0;
    await new Promise((resolve) => setTimeout(resolve, 300));
    await handle.cancel('stop');
    expect((await handle.result).status).toBe('cancelled');
    expect(await waitUntilDead(pid)).toBe(true);
  });

  it('keeps only the last bytes of a big output and says it was truncated', async () => {
    const { runner } = makeRunner();
    const result = await runner.start(
      spec("process.stdout.write('A'.repeat(5000) + 'END')", { maxOutputBytes: 1000 }),
    ).result;
    expect(result.status).toBe('exited');
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.stdoutTail)).toBe(1000);
    expect(result.stdoutTail.endsWith('END')).toBe(true);
  });

  it(`stops a program that writes more than ${OUTPUT_KILL_FACTOR} times its output cap`, async () => {
    const { runner } = makeRunner();
    const handle = runner.start(
      spec("setInterval(() => process.stdout.write('x'.repeat(1000)), 1)", { maxOutputBytes: 2000 }),
    );
    const pid = handle.pid ?? 0;
    const result = await handle.result;
    expect(result.status).toBe('output-limit');
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.stdoutTail)).toBeLessThanOrEqual(2000);
    expect(await waitUntilDead(pid)).toBe(true);
  });

  it('cancelAll stops every owned program and leaves none registered', async () => {
    const { runner } = makeRunner();
    const handles = [1, 2, 3].map((n) =>
      runner.start(spec(sleepForever, { owner: { kind: 'test-run', id: `all-${n}` } })),
    );
    const pids = handles.map((h) => h.pid ?? 0);
    expect(runner.active()).toHaveLength(3);
    await runner.cancelAll('app quitting');
    expect((await Promise.all(handles.map((h) => h.result))).map((r) => r.status)).toEqual([
      'cancelled',
      'cancelled',
      'cancelled',
    ]);
    expect(runner.active()).toEqual([]);
    for (const pid of pids) expect(await waitUntilDead(pid)).toBe(true);
  });

  it('forceKillAll ends running programs without a grace period', async () => {
    const { runner } = makeRunner();
    const handle = runner.start(spec(sleepForever, { gracefulStop: 'close-stdin' }));
    const pid = handle.pid ?? 0;
    await runner.forceKillAll();
    await handle.result;
    expect(await waitUntilDead(pid)).toBe(true);
  });

  it('cancel after the program already ended does nothing and signals nobody', async () => {
    const { runner } = makeRunner();
    const handle = runner.start(spec('console.log(1)'));
    const result = await handle.result;
    await handle.cancel('late');
    expect(result.status).toBe('exited');
  });
});

describe('.cmd programs on Windows', () => {
  const cmdSpec = (dir: string, args: string[]): ProcessSpec => {
    const executable = join(dir, 'echo shim.cmd'); // a space in the path, like C:\Program Files
    writeFileSync(executable, '@echo off\r\necho shim says %1 %2\r\n');
    return spec('', { executable, args, cwd: dir });
  };

  it.skipIf(process.platform !== 'win32')(
    'runs a .cmd shim through cmd.exe with safe arguments',
    async () => {
      const { runner } = makeRunner();
      const result = await runner.start(cmdSpec(makeTempDir(), ['hello', 'dir/file.txt'])).result;
      expect(result.status).toBe('exited');
      expect(result.stdoutTail.trim()).toBe('shim says hello dir/file.txt');
    },
  );

  it.each([['a&calc'], ['a b'], ['x|y'], ['%PATH%'], ['"q"'], ['^'], ['a>b'], ['']])(
    'refuses the argument %j for a .cmd program',
    (arg) => {
      expect(() =>
        prepareCommand(
          { executable: 'C:\\tools\\x.cmd', args: [arg] },
          { platform: 'win32', comspec: 'C:\\Windows\\System32\\cmd.exe' },
        ),
      ).toThrow('cmd.exe would interpret');
    },
  );

  it('refuses a .cmd path with characters cmd.exe interprets', () => {
    expect(() =>
      prepareCommand({ executable: 'C:\\a&b\\x.cmd', args: [] }, { platform: 'win32', comspec: 'cmd.exe' }),
    ).toThrow('cmd.exe would interpret');
    expect(() =>
      prepareCommand(
        { executable: '\\\\server\\share\\x.cmd', args: [] },
        { platform: 'win32', comspec: 'cmd.exe' },
      ),
    ).toThrow('cmd.exe would interpret');
  });

  it('builds the documented cmd.exe form, and leaves other programs and platforms alone', () => {
    const env = { platform: 'win32' as const, comspec: 'C:\\Windows\\System32\\cmd.exe' };
    expect(
      prepareCommand({ executable: 'C:\\Program Files\\x\\npm.cmd', args: ['run', 'dev'] }, env),
    ).toEqual({
      file: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', '""C:\\Program Files\\x\\npm.cmd" run dev"'],
      verbatim: true,
    });
    expect(prepareCommand({ executable: 'C:\\x\\tool.exe', args: ['a&b'] }, env)).toEqual({
      file: 'C:\\x\\tool.exe',
      args: ['a&b'],
      verbatim: false,
    });
    expect(
      prepareCommand({ executable: '/usr/bin/x.cmd', args: ['a&b'] }, { platform: 'linux', comspec: '' })
        .verbatim,
    ).toBe(false);
  });
});

describe('recording runs', () => {
  it('stores each run in process_runs with redacted arguments, and marks stale runs lost', async () => {
    const { db } = await openMigratedDb();
    const logger = memoryLogger();
    const store = createProcessRunStore(db, createRedactor(), logger);
    const { runner } = makeRunner({ store });
    await runner.start(
      spec('process.exit(2)', {
        args: ['-e', 'process.exit(2)', '--', '--token=abc123456789'],
        purpose: 'check',
        owner: { kind: 'git', id: 'g1' },
      }),
    ).result;
    const timedOut = runner.start(spec(sleepForever, { timeoutMs: 200, owner: { kind: 'git', id: 'g2' } }));
    await timedOut.result;

    const rows = db.all<{
      owner_kind: string;
      status: string;
      exit_code: number | null;
      args_json: string;
      ended_at: string | null;
    }>('SELECT owner_kind, status, exit_code, args_json, ended_at FROM process_runs ORDER BY started_at, id');
    expect(rows.map((r) => [r.owner_kind, r.status])).toEqual([
      ['git', 'exited'],
      ['git', 'timed-out'],
    ]);
    expect(rows[0]?.exit_code).toBe(2);
    expect(rows.every((r) => r.ended_at !== null)).toBe(true);
    expect(rows[0]?.args_json).not.toContain('abc123456789');

    db.run(
      "INSERT INTO process_runs (id, owner_kind, owner_id, purpose, executable, args_json, cwd, started_at, status) VALUES ('old', 'git', 'x', 'p', 'e', '[]', 'c', 't', 'running')",
    );
    expect(store.markStaleRunsLost()).toBe(1);
    expect(db.get<{ status: string }>("SELECT status FROM process_runs WHERE id = 'old'")?.status).toBe(
      'lost',
    );
  });
});
