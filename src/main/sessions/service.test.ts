import { afterEach, describe, expect, it } from 'vitest';
import { openMigratedDb } from '../../../test/helpers/db';
import { memoryLogger } from '../../../test/helpers/logger';
import { removeTempDirs } from '../../../test/helpers/temp';
import { copyFixture } from '../../../test/helpers/tree';
import { createActivityLog, createRedactor } from '../logging';
import { createAgentService, createTaskService } from '../planning';
import { createProjectRegistry } from '../projects';
import { createAttention } from './attention';
import { createSessionService } from './service';

afterEach(removeTempDirs);

const KEY = 'sk-ant-api03-notreal0123456789abcdef';

async function env() {
  const { db } = await openMigratedDb();
  const logger = memoryLogger();
  const redactor = createRedactor();
  const activity = createActivityLog({ db, redactor, logger });
  const projects = createProjectRegistry({ db, activity, logger });
  const project = projects.add(copyFixture('audit-godot'));
  const tasks = createTaskService({ db, projects, activity, requirePlanApproval: () => false });
  const agents = createAgentService({ db, projects, tasks, activity });
  const task = tasks.create({ projectId: project.id, title: 'Raise the jump', description: '', provider: '', complexity: 'm', priority: 'normal' });
  const [runId] = agents.createWorkflow({ taskId: task.id, workflow: 'plan', includeReviewer: false, includeQa: false }).map((r) => r.id) as [string];
  const clock = { at: new Date('2026-11-02T10:00:00.000Z') };
  const emitted: { runId: string; text: string }[] = [];
  const sessions = createSessionService({ db, redactor, now: () => clock.at, emit: (id, text) => emitted.push({ runId: id, text }), emitEveryMs: 0 });
  return { db, activity, project, task, runId, agents, sessions, clock, emitted, projects };
}

const start = (e: Awaited<ReturnType<typeof env>>, provider: 'claude-code' | 'codex' | 'ollama' = 'claude-code'): void =>
  e.sessions.begin({ runId: e.runId, projectId: e.project.id, provider, model: provider === 'ollama' ? 'llama3.2:1b' : '', workingDir: e.project.rootPath });

describe('a running session', () => {
  it('shows only what was observed so far: who, where, when and the answer streamed up to now, redacted', async () => {
    const e = await env();
    e.agents.transition(e.runId, 'planning', 'started');
    start(e);
    e.sessions.output(e.runId, `Looking at the project. ${KEY}`);
    e.clock.at = new Date('2026-11-02T10:00:42.000Z');
    const s = e.sessions.get(e.runId);
    expect(s).toMatchObject({ outcome: 'running', runState: 'planning', roleLabel: 'Planner / architect', taskTitle: 'Raise the jump', provider: 'claude-code', workingDir: e.project.rootPath, elapsedMs: 42_000, streamed: true, exitCode: null, providerSessionId: null });
    expect(s.output).toContain('Looking at the project.');
    expect(s.output).not.toContain(KEY);
    expect(e.emitted.at(-1)?.text).not.toContain(KEY); // the window never receives the secret either
    expect(s.denials).toEqual([]);
    expect(s.tools).toEqual([]);
  });

  it('does not claim streaming when nothing streamed, and says what the provider does not expose', async () => {
    const e = await env();
    start(e, 'codex');
    const s = e.sessions.get(e.runId);
    expect(s.streamed).toBe(false);
    expect(s.exposes).toEqual({ streaming: false, toolEvents: true, denials: false, exitCode: true, sessionId: true });
    expect(s.notes.join(' ')).toContain('only when it finishes');
    expect(s.notes.join(' ')).toContain('reasoning is not shown');
    expect(s.notes.join(' ')).toContain('Test output');
    const local = await env();
    local.sessions.begin({ runId: local.runId, projectId: local.project.id, provider: 'ollama', model: 'llama3.2:1b', workingDir: 'None' });
    expect(local.sessions.get(local.runId).notes.join(' ')).toContain('does not tell the app which commands or files');
  });

  it('throws for a run that never started', async () => {
    const e = await env();
    expect(() => e.sessions.get(e.runId)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }) as Error);
    expect(e.sessions.list(e.project.id)).toEqual([]);
  });
});

describe('a finished session', () => {
  it('keeps the observed facts: exit code, provider session id, tools asked for, requests denied, the answer and its summary', async () => {
    const e = await env();
    start(e);
    e.sessions.finish(e.runId, {
      outcome: 'completed',
      text: `Edited src/player.js.\nCould not run the tests. ${KEY}`,
      observed: { sessionId: 'sess-42', exitCode: 0, tools: [{ tool: 'Edit', detail: 'src/player.js' }, { tool: 'Bash', detail: `curl -H "Authorization: Bearer ${KEY}" x` }], denials: [{ tool: 'Bash', detail: 'npm test' }] },
    });
    const s = e.sessions.get(e.runId);
    expect(s).toMatchObject({ outcome: 'completed', exitCode: 0, providerSessionId: 'sess-42', denials: [{ tool: 'Bash', detail: 'npm test' }], error: '' });
    expect(s.tools.map((t) => t.tool)).toEqual(['Edit', 'Bash']);
    expect(JSON.stringify(s)).not.toContain(KEY);
    expect(s.summary).toBe('Edited src/player.js. Could not run the tests. [redacted]');
    expect(s.endedAt).not.toBeNull();
  });

  it('survives a restart: the record is in the database, not in memory', async () => {
    const e = await env();
    start(e);
    e.sessions.output(e.runId, 'partial');
    e.sessions.finish(e.runId, { outcome: 'completed', text: 'The whole answer.', observed: { exitCode: 0 } });
    const again = createSessionService({ db: e.db, redactor: createRedactor() }); // a new service instance has no live buffers
    expect(again.get(e.runId)).toMatchObject({ outcome: 'completed', output: 'The whole answer.', streamed: true });
    expect(again.list(e.project.id)).toHaveLength(1);
  });

  it('records a failure or a cancel with the reason, and nothing it does not know', async () => {
    const e = await env();
    start(e);
    e.sessions.finish(e.runId, { outcome: 'failed', error: `Claude Code stopped with an error: ${KEY}` });
    const s = e.sessions.get(e.runId);
    expect(s).toMatchObject({ outcome: 'failed', exitCode: null, providerSessionId: null });
    expect(s.error).toContain('stopped with an error');
    expect(s.error).not.toContain(KEY);
  });

  it('marks a session that was running when the app stopped as interrupted, and says its end is unknown', async () => {
    const e = await env();
    start(e);
    expect(e.sessions.recover()).toBe(1);
    expect(e.sessions.get(e.runId)).toMatchObject({ outcome: 'interrupted', error: expect.stringContaining('how it ended is unknown') as unknown });
    expect(e.sessions.recover()).toBe(0);
  });

  it('lists the events and the programs recorded for the run, and links its review session', async () => {
    const e = await env();
    start(e);
    e.activity.record({ kind: 'agent.run-requested', severity: 'info', summary: 'Asked to start the run.', details: { runId: e.runId } });
    e.activity.record({ kind: 'agent.run-requested', severity: 'info', summary: 'Another run.', details: { runId: 'other' } });
    e.db.run("INSERT INTO process_runs (id, owner_kind, owner_id, purpose, executable, args_json, cwd, started_at, status, exit_code, ended_at) VALUES ('p1', 'agent-run', ?, 'Run Claude Code (read-only)', 'C:\\Users\\Test\\.local\\bin\\claude.exe', '[]', 'D:\\Games', '2026-11-02T10:00:00.000Z', 'exited', 0, '2026-11-02T10:00:09.000Z')", e.runId);
    e.db.run("INSERT INTO change_sessions (id, project_id, task_id, run_id, role_label, base_commit, state_commit, checkpoint_ref, untracked_json, dirty_json, untracked_truncated, started_at, status) VALUES ('review-1', ?, ?, ?, 'Implementer', 'a', 'b', 'refs/x', '[]', '[]', 0, '2026-11-02T10:00:00.000Z', 'open')", e.project.id, e.task.id, e.runId);
    const s = e.sessions.get(e.runId);
    expect(s.recent.map((r) => r.summary)).toEqual(['Asked to start the run.']);
    expect(s.processes).toEqual([{ purpose: 'Run Claude Code (read-only)', program: 'claude.exe', status: 'exited', exitCode: 0, startedAt: '2026-11-02T10:00:00.000Z', endedAt: '2026-11-02T10:00:09.000Z' }]);
    expect(s.reviewSessionId).toBe('review-1');
  });

  it('offers resume only where the provider documents it, and never resumes by itself', async () => {
    const e = await env();
    start(e);
    e.sessions.finish(e.runId, { outcome: 'completed', text: 'ok', observed: { sessionId: 'sess-42', exitCode: 0 } });
    expect(e.sessions.get(e.runId).resume).toEqual({ documented: true, how: expect.stringContaining('claude --resume sess-42') as unknown });
    expect(e.sessions.get(e.runId).resume.how).toContain('does not resume runs itself');
    const codex = await env();
    start(codex, 'codex');
    expect(codex.sessions.get(codex.runId).resume.documented).toBe(false);
    const local = await env();
    start(local, 'ollama');
    expect(local.sessions.get(local.runId).resume).toEqual({ documented: false, how: expect.stringContaining('keeps no session') as unknown });
    const noId = await env();
    start(noId);
    noId.sessions.finish(noId.runId, { outcome: 'completed', text: 'ok', observed: { exitCode: 0 } });
    expect(noId.sessions.get(noId.runId).resume.how).toContain('printed none');
  });
});

describe('what is waiting on the person', () => {
  it('lists unreviewed changes, an interrupted writer lock, runs waiting for an answer or for a hold, limits hit and resource warnings — and nothing when all is quiet', async () => {
    const e = await env();
    const queueView = { runs: [] as { hold: string }[], lock: null as { active: boolean } | null };
    const attention = createAttention({
      db: e.db,
      projects: e.projects,
      queue: { view: () => ({ runs: queueView.runs, lock: queueView.lock, writesEnabled: true, maxAttempts: 3 }) as never },
      resources: () => resources.value,
      now: () => e.clock.at,
    });
    const resources: { value: { at: string; warnings: string[] } | undefined } = { value: undefined };
    expect(attention.items()).toEqual([]);

    queueView.runs = [{ hold: 'Starting: answer the confirmation window to send it, or decline to keep it queued.' }, { hold: 'Waiting for Claude Code: another run is using it.' }];
    queueView.lock = { active: false };
    e.db.run("INSERT INTO change_sessions (id, project_id, task_id, run_id, role_label, base_commit, state_commit, checkpoint_ref, untracked_json, dirty_json, untracked_truncated, started_at, status) VALUES ('r1', ?, ?, 'gone', 'Implementer', 'a', 'b', 'refs/x', '[]', '[]', 0, '2026-11-02T10:00:00.000Z', 'open')", e.project.id, e.task.id);
    e.db.run("INSERT INTO usage_log (id, purpose, provider_id, location, status, started_at, reason) VALUES ('u1', 'agent-run', 'claude-code', 'cloud', 'blocked', ?, 'limit')", e.clock.at.toISOString());
    resources.value = { at: '2026-11-02T09:55:00.000Z', warnings: ['Free VRAM is below the minimum.'] };
    const items = attention.items();
    const byId = new Map(items.map((i) => [i.id.replace(/-.*$/, ''), i]));
    expect(byId.get('confirm')).toMatchObject({ severity: 'warning', section: 'workbench' });
    expect(byId.get('held')?.text).toContain('another run is using it');
    expect(byId.get('lock')).toMatchObject({ severity: 'warning' });
    expect(byId.get('review')).toMatchObject({ section: 'git', severity: 'info' });
    expect(byId.get('limits')?.text).toContain('1 cloud launch was stopped');
    expect(byId.get('resource')?.text).toContain('Free VRAM is below the minimum. (resource check of 09:55 UTC)');
  });
});
