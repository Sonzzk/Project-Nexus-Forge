import type { ChangeSession, GitOverview, Review } from '../../src/shared/changes';
import type { FakeApi } from './fake-api';

// Canned answers for the review and Git-tools channels, for component tests (the real rules are tested in src/main/changes).

export const sampleSession = (n: number, overrides: Partial<ChangeSession> = {}): ChangeSession => ({
  id: `session-${n}`,
  projectId: 'project-1',
  taskId: 'task-1',
  taskTitle: 'Add jumping',
  runId: `run-${n}`,
  roleLabel: 'Implementer',
  status: 'open',
  startedAt: '2026-10-24T08:00:00.000Z',
  finishedAt: null,
  commit: null,
  checkpointRef: 'refs/gdcc/checkpoints/before-run',
  runActive: false,
  ...overrides,
});

export const emptyOverview: GitOverview = {
  branches: [{ name: 'main', current: true, upstream: null, commit: 'abc1234' }],
  checkpoints: [],
  worktrees: [],
  protection: { lfs: false, binaryFiles: 0, largestBinaryMb: 0, notes: ['A checkpoint or commit holds tracked files only.'] },
  note: '',
};

export interface FakeChanges {
  sessions: ChangeSession[];
  reviews: Record<string, Review>;
  overview: GitOverview;
  /** What the native window answers for approve, reject, revert and working trees. */
  windowAnswer: boolean;
}

export function attachChanges(fake: FakeApi, seed: Partial<FakeChanges> = {}): FakeChanges {
  const state: FakeChanges = { sessions: [], reviews: {}, overview: emptyOverview, windowAnswer: true, ...seed };
  const setStatus = (id: string, status: ChangeSession['status'], commit: string | null): void => {
    state.sessions = state.sessions.map((s) => (s.id === id ? { ...s, status, commit } : s));
  };
  fake.handlers['changes:sessions'] = () => state.sessions;
  fake.handlers['changes:review'] = (input) => state.reviews[(input as { sessionId: string }).sessionId] ?? Object.assign(new Error('That review session does not exist.'), { code: 'NOT_FOUND' });
  fake.handlers['changes:approve'] = (input) => {
    if (!state.windowAnswer) return { committed: false };
    setStatus((input as { sessionId: string }).sessionId, 'approved', 'c0ffee0000000000000000000000000000000000');
    return { committed: true, commit: 'c0ffee0000000000000000000000000000000000' };
  };
  fake.handlers['changes:reject'] = (input) => {
    if (!state.windowAnswer) return { rejected: false };
    setStatus((input as { sessionId: string }).sessionId, 'rejected', null);
    return { rejected: true, savedTo: 'C:\\Data\\rejected-changes\\session-1' };
  };
  fake.handlers['changes:revert'] = () => (state.windowAnswer ? { reverted: true, commit: 'deadbeef00000000000000000000000000000000' } : { reverted: false });
  fake.handlers['git:overview'] = () => state.overview;
  fake.handlers['git:checkpoint'] = (input) => {
    const { name } = input as { name: string };
    state.overview = { ...state.overview, checkpoints: [{ name, ref: `refs/gdcc/checkpoints/${name}`, commit: '1234567890abcdef1234567890abcdef12345678', at: '2026-10-24T09:00:00.000Z', subject: 'WIP' }, ...state.overview.checkpoints] };
    return { name, ref: `refs/gdcc/checkpoints/${name}` };
  };
  fake.handlers['worktrees:add'] = (input) => {
    if (!state.windowAnswer) return { created: false };
    const { name } = input as { name: string };
    state.overview = { ...state.overview, worktrees: [...state.overview.worktrees, { id: `wt-${name}`, name, path: `C:\\Data\\worktrees\\${name}`, branch: `gdcc/${name}`, createdAt: '2026-10-24T09:00:00.000Z', present: true }] };
    return { created: true };
  };
  fake.handlers['worktrees:remove'] = (input) => {
    if (!state.windowAnswer) return { removed: false };
    state.overview = { ...state.overview, worktrees: state.overview.worktrees.filter((w) => w.id !== (input as { id: string }).id) };
    return { removed: true };
  };
  return state;
}
