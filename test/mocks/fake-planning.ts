import { allowedNext, progressOf, type Milestone, type Note, type PortfolioEntry, type Recommendations, type Risk, type Snapshot, type Task, type TaskStatus } from '../../src/shared/tasks';
import type { FakeApi } from './fake-api';

// A small in-memory stand-in for the planning channels, so component tests can click through the Tasks page. It uses the real
// lifecycle rule (`allowedNext`) from src/shared but none of the main-process code; the real rules are tested in src/main/planning.

export const sampleTask = (n: number, overrides: Partial<Task> = {}): Task => ({
  id: `task-${n}`,
  projectId: 'project-1',
  milestoneId: null,
  parentId: null,
  title: `Task ${n}`,
  description: '',
  subsystem: '',
  priority: 'normal',
  complexity: '',
  category: '',
  acceptance: [],
  files: [],
  role: '',
  provider: '',
  usage: '',
  testRequirements: '',
  resultNotes: '',
  status: 'inbox',
  planApprovedAt: null,
  dependsOn: [],
  waitingOn: [],
  allowedNext: allowedNext('inbox', null),
  children: 0,
  order: n,
  createdAt: '2026-10-24T01:00:00.000Z',
  updatedAt: '2026-10-24T01:00:00.000Z',
  doneAt: null,
  ...overrides,
});

export interface FakePlanning {
  tasks: Task[];
  milestones: Milestone[];
  risks: Risk[];
  notes: Note[];
  snapshots: Snapshot[];
  recommendation: Recommendations;
}

export function attachPlanning(fake: FakeApi, seed: Partial<FakePlanning> = {}): FakePlanning {
  const state: FakePlanning = {
    tasks: [],
    milestones: [],
    risks: [],
    notes: [],
    snapshots: [],
    recommendation: { items: [], message: 'There are no tasks yet. Add one, or break a feature down into tasks.' },
    ...seed,
  };
  let counter = 100;
  const fail = (code: string, message: string, hint?: string): never => {
    throw Object.assign(new Error(message), { code, hint });
  };
  const find = (id: unknown): Task => state.tasks.find((t) => t.id === id) ?? fail('NOT_FOUND', 'That task does not exist.');
  const replace = (task: Task): Task => {
    state.tasks = state.tasks.map((t) => (t.id === task.id ? task : t));
    return task;
  };
  const refresh = (): void => {
    state.tasks = state.tasks.map((t) => ({
      ...t,
      waitingOn: t.dependsOn.flatMap((d) => {
        const dep = state.tasks.find((x) => x.id === d);
        return dep === undefined || dep.status === 'done' || dep.status === 'cancelled' ? [] : [{ id: dep.id, title: dep.title, status: dep.status }];
      }),
      children: state.tasks.filter((c) => c.parentId === t.id).length,
    }));
  };
  const progress = (milestoneId: string | null) => progressOf(state.tasks.filter((t) => t.children === 0 && (milestoneId === null || t.milestoneId === milestoneId)).map((t) => t.status));
  const withProgress = (m: Milestone): Milestone => ({ ...m, progress: progress(m.id) });

  fake.handlers['tasks:list'] = () => state.tasks;
  fake.handlers['tasks:create'] = (input) => {
    const { projectId, status, ...fields } = input as Partial<Task> & { projectId: string; status?: TaskStatus };
    const task = sampleTask(++counter, { ...fields, projectId, status: status ?? 'inbox', allowedNext: allowedNext(status ?? 'inbox', null) });
    state.tasks = [...state.tasks, task];
    return task;
  };
  fake.handlers['tasks:update'] = (input) => {
    const { id, ...fields } = input as Partial<Task> & { id: string };
    return replace({ ...find(id), ...fields });
  };
  fake.handlers['tasks:remove'] = (input) => {
    state.tasks = state.tasks.filter((t) => t.id !== (input as { id: string }).id);
    return { removed: true };
  };
  fake.handlers['tasks:setStatus'] = (input) => {
    const { id, status } = input as { id: string; status: TaskStatus };
    const task = find(id);
    if (!task.allowedNext.includes(status)) fail('INVALID_INPUT', 'A task cannot go there.', 'Choose another status.');
    if (status === 'in-progress' && task.waitingOn.length > 0) fail('CONFLICT', `This task is waiting on: "${task.waitingOn[0]?.title}".`, 'Finish those first.');
    const next = replace({ ...task, status, allowedNext: allowedNext(status, status === 'blocked' ? task.status : null), doneAt: status === 'done' ? '2026-10-24T02:00:00.000Z' : null });
    refresh();
    return next;
  };
  fake.handlers['tasks:approvePlan'] = (input) => {
    const { id, approved } = input as { id: string; approved: boolean };
    return replace({ ...find(id), planApprovedAt: approved ? '2026-10-24T02:00:00.000Z' : null });
  };
  fake.handlers['tasks:setDependencies'] = (input) => {
    const { id, dependsOn } = input as { id: string; dependsOn: string[] };
    const next = replace({ ...find(id), dependsOn });
    refresh();
    return state.tasks.find((t) => t.id === next.id);
  };
  fake.handlers['tasks:notes'] = (input) => state.notes.filter((n) => n.taskId === (input as { id: string }).id);
  fake.handlers['tasks:addNote'] = (input) => {
    const { id, text } = input as { id: string; text: string };
    const note: Note = { id: `note-${++counter}`, taskId: id, createdAt: '2026-10-24T03:00:00.000Z', text };
    state.notes = [...state.notes, note];
    return note;
  };
  fake.handlers['tasks:breakdown'] = (input) => {
    const { projectId, title, steps, chain } = input as { projectId: string; title: string; steps: { title: string; acceptance: string[] }[]; chain: boolean };
    const parent = sampleTask(++counter, { projectId, title, status: 'planned', allowedNext: allowedNext('planned', null) });
    const children = steps.map((step, i) => sampleTask(++counter, { projectId, title: step.title, acceptance: step.acceptance, parentId: parent.id, status: 'planned', allowedNext: allowedNext('planned', null), dependsOn: chain && i > 0 ? [`task-${counter - 1}`] : [] }));
    state.tasks = [...state.tasks, parent, ...children];
    refresh();
    return [parent, ...children];
  };
  fake.handlers['tasks:recommend'] = () => state.recommendation;
  fake.handlers['tasks:portfolio'] = (): PortfolioEntry[] =>
    fake.projects.map((p) => ({ projectId: p.id, name: p.name, projectStatus: p.status, currentMilestone: state.milestones[0]?.title ?? null, progress: progress(null), openBugs: state.risks.filter((r) => r.kind === 'bug' && r.status === 'open').length, openRisks: state.risks.filter((r) => r.kind === 'risk' && r.status === 'open').length }));
  fake.handlers['milestones:list'] = () => state.milestones.map(withProgress);
  fake.handlers['milestones:create'] = (input) => {
    const { projectId, title, scopeTier, targetDate } = input as { projectId: string; title: string; scopeTier: Milestone['scopeTier']; targetDate?: string | null };
    const m: Milestone = { id: `ms-${++counter}`, projectId, title, description: '', status: 'planned', scopeTier, targetDate: targetDate ?? null, order: state.milestones.length + 1, progress: progress(null), createdAt: '2026-10-24T01:00:00.000Z' };
    state.milestones = [...state.milestones, m];
    return withProgress(m);
  };
  fake.handlers['milestones:update'] = (input) => {
    const { id, ...fields } = input as Partial<Milestone> & { id: string };
    state.milestones = state.milestones.map((m) => (m.id === id ? { ...m, ...fields } : m));
    return withProgress(state.milestones.find((m) => m.id === id) as Milestone);
  };
  fake.handlers['milestones:remove'] = (input) => {
    state.milestones = state.milestones.filter((m) => m.id !== (input as { id: string }).id);
    return { removed: true };
  };
  fake.handlers['milestones:snapshot'] = (input) => {
    const { id, label } = input as { id: string; label: string };
    const snap: Snapshot = { id: `snap-${++counter}`, milestoneId: id, takenAt: '2026-10-24T04:00:00.000Z', label: label || 'Snapshot 2026-10-24', progress: progress(id), byStatus: {} };
    state.snapshots = [snap, ...state.snapshots];
    return snap;
  };
  fake.handlers['milestones:snapshots'] = (input) => state.snapshots.filter((s) => s.milestoneId === (input as { id: string }).id);
  fake.handlers['risks:list'] = () => state.risks;
  fake.handlers['risks:create'] = (input) => {
    const raw = input as Partial<Risk> & { projectId: string; kind: Risk['kind']; title: string };
    const risk: Risk = { id: `risk-${++counter}`, projectId: raw.projectId, kind: raw.kind, title: raw.title, description: raw.description ?? '', severity: raw.severity ?? 'medium', status: 'open', taskId: raw.taskId ?? null, createdAt: '2026-10-24T01:00:00.000Z', updatedAt: '2026-10-24T01:00:00.000Z' };
    state.risks = [...state.risks, risk];
    return risk;
  };
  fake.handlers['risks:update'] = (input) => {
    const { id, ...fields } = input as Partial<Risk> & { id: string };
    state.risks = state.risks.map((r) => (r.id === id ? { ...r, ...fields } : r));
    return state.risks.find((r) => r.id === id);
  };
  fake.handlers['risks:remove'] = (input) => {
    state.risks = state.risks.filter((r) => r.id !== (input as { id: string }).id);
    return { removed: true };
  };
  refresh();
  return state;
}
