import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openMigratedDb } from '../../../test/helpers/db';
import { memoryLogger } from '../../../test/helpers/logger';
import { makeTempDir, removeTempDirs } from '../../../test/helpers/temp';
import { createActivityLog, createRedactor } from '../logging';
import { createDiagnosticsService } from './service';

afterEach(removeTempDirs);

const KEY = 'sk-ant-api03-notreal0123456789abcdef';

async function env() {
  const { db } = await openMigratedDb();
  const logger = memoryLogger();
  const redactor = createRedactor({ homeDir: 'C:\\Users\\Amos Remahl' });
  let tick = 0;
  const activity = createActivityLog({ db, redactor, logger, now: () => new Date(Date.UTC(2026, 10, 2, 10, 0, tick++)) });
  const dir = makeTempDir();
  const logDir = join(dir, 'logs');
  mkdirSync(logDir);
  const line = (t: string, lvl: string, mod: string, msg: string, data?: unknown): string => JSON.stringify({ t, lvl, mod, msg, ...(data === undefined ? {} : { data }) });
  writeFileSync(join(logDir, 'main.1.log'), [line('2026-11-01T09:00:00.000Z', 'info', 'app.old', 'An older line'), 'not json at all'].join('\n') + '\n');
  writeFileSync(
    join(logDir, 'main.log'),
    [
      line('2026-11-02T09:00:00.000Z', 'info', 'app.start', 'Started'),
      line('2026-11-02T09:01:00.000Z', 'warn', 'app.providers', 'Slow answer', { ms: 9000 }),
      line('2026-11-02T09:02:00.000Z', 'error', 'app.queue', 'Run failed', { path: 'C:\\Users\\Amos Remahl\\Game', token: KEY }),
      '{"t":"2026-11-02T09:03:00.000Z","lvl":"info"', // a line cut off by a crash
      line('2026-11-02T09:04:00.000Z', 'debug', 'app.git', 'status'),
    ].join('\n') + '\n',
  );
  const answer: { path: string | undefined } = { path: undefined };
  const asked: { defaultName: string; kind: string }[] = [];
  const service = createDiagnosticsService({
    db,
    activity,
    redactor,
    logDir,
    appInfo: () => ({ name: 'GameDev Command Center', version: '0.1.0', dataDir: 'C:\\Users\\Amos Remahl\\AppData' }),
    settings: () => ({ theme: 'x' }) as never,
    providers: () => Promise.resolve([{ id: 'ollama', status: 'working', version: '0.34', message: 'ok', checkedAt: '2026-11-02T09:00:00.000Z' }] as never),
    resources: () => undefined,
    chooseFile: (o) => (asked.push(o), Promise.resolve(answer.path)),
    now: () => new Date('2026-11-02T10:30:00.000Z'),
  });
  return { db, activity, dir, service, answer, asked, logDir };
}

describe('the log viewer', () => {
  it('reads the newest lines first across rotated files, skips damaged lines, and never shows a secret or the user folder', async () => {
    const e = await env();
    const { entries, files } = e.service.logs({ lines: 50 });
    expect(entries.map((x) => x.message)).toEqual(['status', 'Run failed', 'Slow answer', 'Started', 'An older line']);
    expect(files.map((f) => f.name)).toEqual(['main.log', 'main.1.log']);
    const failed = entries.find((x) => x.message === 'Run failed');
    expect(failed?.data).not.toContain(KEY);
    expect(failed?.data).not.toContain('Amos Remahl');
    expect(failed?.data).toContain('~');
  });

  it('filters by level (that level and worse), by text, and by line count', async () => {
    const e = await env();
    expect(e.service.logs({ lines: 50, level: 'warn' }).entries.map((x) => x.level)).toEqual(['error', 'warn']);
    expect(e.service.logs({ lines: 50, level: 'error' }).entries).toHaveLength(1);
    expect(e.service.logs({ lines: 50, search: 'PROVIDERS' }).entries.map((x) => x.message)).toEqual(['Slow answer']);
    expect(e.service.logs({ lines: 2 }).entries).toHaveLength(2);
    expect(e.service.logs({ lines: 50, search: 'nothing like this' }).entries).toEqual([]);
  });

  it('says nothing is there when there is no log folder', async () => {
    const e = await env();
    writeFileSync(join(e.logDir, 'main.log'), '');
    writeFileSync(join(e.logDir, 'main.1.log'), '');
    expect(e.service.logs({ lines: 10 })).toMatchObject({ entries: [] });
  });
});

describe('exporting the activity history', () => {
  const seed = (e: Awaited<ReturnType<typeof env>>): void => {
    e.activity.record({ kind: 'project.added', severity: 'info', summary: 'Added "Alpha" in C:\\Users\\Amos Remahl\\Games' });
    e.activity.record({ kind: 'provider.failed', severity: 'warning', summary: `Claude Code: key ${KEY} was rejected, 100% sure` });
    e.activity.record({ kind: 'agent.run-failed', severity: 'error', summary: '=HYPERLINK("http://example.invalid","click")' });
    e.activity.record({ kind: 'agent.run-finished', severity: 'info', summary: 'Finished, with "quotes", and commas' });
  };

  it('writes a redacted JSON file where the person chose, and nothing when they cancel', async () => {
    const e = await env();
    seed(e);
    expect(await e.service.exportActivity({}, 'json')).toEqual({ saved: false, count: 0 });
    expect(e.asked[0]).toMatchObject({ kind: 'json', defaultName: 'activity-2026-11-02-10-30-00.json' });
    e.answer.path = join(e.dir, 'out.json');
    expect(await e.service.exportActivity({}, 'json')).toEqual({ saved: true, count: 4 });
    const text = readFileSync(e.answer.path, 'utf8');
    expect(text).not.toContain(KEY);
    expect(text).not.toContain('Amos Remahl');
    const file = JSON.parse(text) as { format: string; count: number; events: { kind: string }[] };
    expect(file).toMatchObject({ format: 'gdcc-activity', count: 4 });
    expect(file.events.map((x) => x.kind)).toEqual(['agent.run-finished', 'agent.run-failed', 'provider.failed', 'project.added']);
  });

  it('applies the same filters as the list: severity, text (with % and _ taken literally), kind and time', async () => {
    const e = await env();
    seed(e);
    e.answer.path = join(e.dir, 'filtered.json');
    const kinds = async (filter: Parameters<typeof e.service.exportActivity>[0]): Promise<string[]> => {
      await e.service.exportActivity(filter, 'json');
      return (JSON.parse(readFileSync(e.answer.path as string, 'utf8')) as { events: { kind: string }[] }).events.map((x) => x.kind);
    };
    expect(await kinds({ severities: ['warning', 'error'] })).toEqual(['agent.run-failed', 'provider.failed']);
    expect(await kinds({ search: '100%' })).toEqual(['provider.failed']);
    expect(await kinds({ search: '1_0' })).toEqual([]); // an underscore is not a wildcard
    expect(await kinds({ search: 'PROJECT.ADDED' })).toEqual(['project.added']);
    expect(await kinds({ kinds: ['agent.run-finished'] })).toEqual(['agent.run-finished']);
    expect(await kinds({ since: '2026-11-02T10:00:02.000Z' })).toEqual(['agent.run-finished', 'agent.run-failed']);
  });

  it('writes CSV with quoting, and defuses cells that a spreadsheet would run as formulas', async () => {
    const e = await env();
    seed(e);
    e.answer.path = join(e.dir, 'out.csv');
    await e.service.exportActivity({}, 'csv');
    const csv = readFileSync(e.answer.path, 'utf8');
    const rows = csv.split('\r\n');
    expect(rows[0]).toBe('time,severity,kind,summary,project,task,details');
    expect(csv).toContain('"Finished, with ""quotes"", and commas"');
    expect(csv).toContain("'=HYPERLINK"); // a leading apostrophe makes it plain text
    expect(csv).not.toContain(',=HYPERLINK');
    expect(csv).not.toContain(KEY);
  });

  it('pages through more than one batch of events', async () => {
    const e = await env();
    for (let i = 0; i < 1250; i++) e.db.run("INSERT INTO activity_events (id, occurred_at, kind, severity, summary) VALUES (?, ?, 'bulk.x', 'info', 'bulk')", `b${i}`, new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString());
    e.answer.path = join(e.dir, 'all.json');
    expect((await e.service.exportActivity({ kinds: ['bulk.x'] }, 'json')).count).toBe(1250);
  });
});

describe('the diagnostics bundle', () => {
  it('holds the app facts, settings, provider status, row counts, recent problems, processes and the log — redacted — and no project files or prompts', async () => {
    const e = await env();
    e.activity.record({ kind: 'provider.failed', severity: 'warning', summary: `Rejected key ${KEY}` });
    e.activity.record({ kind: 'project.added', severity: 'info', summary: 'not a problem' });
    e.db.run("INSERT INTO process_runs (id, owner_kind, owner_id, purpose, executable, args_json, cwd, started_at, status, exit_code) VALUES ('p', 'git', 'o', 'Read Git status', 'git.exe', '[\"--secret=abc\"]', 'D:\\Games', '2026-11-02T09:00:00.000Z', 'exited', 0)");
    e.answer.path = join(e.dir, 'bundle.json');
    expect(await e.service.bundle()).toMatchObject({ saved: true });
    const text = readFileSync(e.answer.path, 'utf8');
    expect(text).not.toContain(KEY);
    expect(text).not.toContain('Amos Remahl');
    const bundle = JSON.parse(text) as Record<string, unknown> & { recentProblems: { kind: string }[]; recentProcesses: Record<string, unknown>[]; recentLog: unknown[]; rowCounts: Record<string, number> };
    expect(bundle).toMatchObject({ format: 'gdcc-diagnostics', app: { name: 'GameDev Command Center' }, providers: [{ id: 'ollama', status: 'working' }], resources: null });
    expect(bundle.recentProblems.map((p) => p.kind)).toEqual(['provider.failed']);
    expect(bundle.recentProcesses[0]).toEqual({ owner_kind: 'git', purpose: 'Read Git status', status: 'exited', exit_code: 0, started_at: '2026-11-02T09:00:00.000Z', ended_at: null });
    expect(JSON.stringify(bundle.recentProcesses)).not.toContain('--secret'); // arguments are not included at all
    expect(bundle.recentLog.length).toBeGreaterThan(0);
    expect(bundle.rowCounts['activity_events']).toBeGreaterThanOrEqual(2);
    expect(Object.keys(bundle)).not.toContain('prompts');
  });

  it('saves nothing when the person cancels', async () => {
    const e = await env();
    expect(await e.service.bundle()).toEqual({ saved: false, count: 0 });
  });
});
