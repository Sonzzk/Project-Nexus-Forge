import type { LogsResult } from '../../src/shared/diagnostics';
import type { ResourceReport } from '../../src/shared/resources';
import type { AttentionItem, Session, SessionSummary } from '../../src/shared/sessions';
import type { FakeApi } from './fake-api';

// Canned answers for the session, attention, log and export channels, for component tests (the real rules are tested in
// src/main/sessions and src/main/diagnostics).

export const sampleSession = (overrides: Partial<Session> = {}): Session => ({
  runId: 'run-1',
  projectId: 'project-1',
  roleLabel: 'Implementer',
  taskTitle: 'Add jumping',
  provider: 'claude-code',
  model: '',
  outcome: 'completed',
  startedAt: '2026-11-02T10:00:00.000Z',
  endedAt: '2026-11-02T10:01:30.000Z',
  elapsedMs: 90_000,
  taskId: 'task-1',
  runState: 'completed',
  workingDir: 'D:\\Games\\Alpha',
  exitCode: 0,
  providerSessionId: 'sess-42',
  denials: [{ tool: 'Bash', detail: 'npm test' }],
  tools: [{ tool: 'Edit', detail: 'src/player.js' }],
  error: '',
  output: 'Edited src/player.js.\nCould not run the tests.',
  outputTruncated: false,
  streamed: true,
  summary: 'Edited src/player.js. Could not run the tests.',
  recent: [{ at: '2026-11-02T10:00:01.000Z', summary: 'The Implementer run was asked to start.' }],
  processes: [{ purpose: 'Run Claude Code (can change files)', program: 'claude.exe', status: 'exited', exitCode: 0, startedAt: '2026-11-02T10:00:01.000Z', endedAt: '2026-11-02T10:01:30.000Z' }],
  reviewSessionId: 'review-1',
  exposes: { streaming: true, toolEvents: true, denials: true, exitCode: true, sessionId: true },
  resume: { documented: true, how: 'Claude Code documents resuming this session in a terminal: claude --resume sess-42. The app does not resume runs itself.' },
  notes: ['Test output: runs do not report test results yet (Step 23).'],
  ...overrides,
});

export const toSummary = (s: Session): SessionSummary => ({ runId: s.runId, projectId: s.projectId, roleLabel: s.roleLabel, taskTitle: s.taskTitle, provider: s.provider, model: s.model, outcome: s.outcome, startedAt: s.startedAt, endedAt: s.endedAt, elapsedMs: s.elapsedMs });

export interface FakeSessions {
  sessions: Session[];
  attention: AttentionItem[];
  resources: ResourceReport | null;
  logs: LogsResult;
  /** What the native save window answers for exports: false = cancelled. */
  saveAnswer: boolean;
  exported: { channel: string; input: unknown }[];
}

export function attachSessions(fake: FakeApi, seed: Partial<FakeSessions> = {}): FakeSessions {
  const state: FakeSessions = {
    sessions: [],
    attention: [],
    resources: null,
    logs: { entries: [], files: [{ name: 'main.log', bytes: 2048 }] },
    saveAnswer: true,
    exported: [],
    ...seed,
  };
  fake.handlers['activity:list'] = (input) => {
    const { severities, search, since } = input as { severities?: string[]; search?: string; since?: string };
    return fake.events.filter(
      (e) => (severities === undefined || severities.includes(e.severity)) && (search === undefined || `${e.summary} ${e.kind}`.toLowerCase().includes(search.toLowerCase())) && (since === undefined || e.occurredAt >= since),
    );
  };
  fake.handlers['sessions:list'] = () => state.sessions.map(toSummary);
  fake.handlers['sessions:get'] = (input) => state.sessions.find((s) => s.runId === (input as { runId: string }).runId) ?? Object.assign(new Error('There is no session for that run.'), { code: 'NOT_FOUND' });
  fake.handlers['attention:summary'] = () => state.attention;
  fake.handlers['resources:latest'] = () => state.resources;
  fake.handlers['logs:tail'] = (input) => {
    const { level, search } = input as { level?: string; search?: string };
    const rank: Record<string, number> = { error: 0, warn: 1, info: 2, debug: 3 };
    return { ...state.logs, entries: state.logs.entries.filter((e) => (level === undefined || (rank[e.level] ?? 3) <= (rank[level] ?? 3)) && (search === undefined || `${e.module} ${e.message}`.toLowerCase().includes(search.toLowerCase()))) };
  };
  fake.handlers['activity:export'] = (input) => {
    state.exported.push({ channel: 'activity:export', input });
    return { saved: state.saveAnswer, count: state.saveAnswer ? 3 : 0 };
  };
  fake.handlers['diagnostics:export'] = () => {
    state.exported.push({ channel: 'diagnostics:export', input: {} });
    return { saved: state.saveAnswer, count: state.saveAnswer ? 12 : 0 };
  };
  fake.handlers['retention:run'] = () => ({ activity: 4, processRuns: 2, sessions: 0, usage: 1, logFiles: 3 });
  return state;
}
