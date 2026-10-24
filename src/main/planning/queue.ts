import { randomUUID } from 'node:crypto';
import { FINAL_RUN_STATES, RUN_STATE_LABELS, roleById, type AgentRoleId, type AgentRun, type QueueView, type RunState } from '@shared/agents';
import { AppError } from '@shared/errors';
import { PROVIDER_LABELS, type ProviderChoice, type ProviderId } from '@shared/providers';
import type { PolicyVerdict } from '@shared/resources';
import { PROFILE_LABELS, chooseRoute, escalationNotes, type Availability, type RoleOverride, type Route, type RoutingProfile } from '@shared/routing';
import { PRIORITIES, type Priority } from '@shared/tasks';
import type { ActivityLog, Logger } from '../logging';
import type { ProjectRegistry } from '../projects';
import type { Db } from '../storage';
import { runFromRow, type AgentService, type RunRow } from './agents';
import type { TaskService } from './tasks';

// The run queue (spec §11, §12, §15): the person asks for a queued run to start; the queue routes it, then starts waiting runs
// in priority order when their provider is free, the workflow's earlier steps are done, the project's writer lock allows it and,
// for a local model, the local-inference policy allows it. Everything that would make it wait is shown as a hold reason.
// - One run per provider at a time; read-only runs of other providers run alongside. Reviewer and QA wait for a writer to finish.
// - One writer per project (`writer_locks`). A writer the app saw end releases the lock; a lock left by an interrupted run is kept
//   across restarts until the person releases it, because the app could not see that writer stop.
// - Runs that change files are refused until Step 15. A failed or cancelled run is tried again only as a new attempt the person
//   asks for, at most `routing.maxAttempts` times; the confirmation before a cloud send says when it repeats or escalates.
// The queue calls no provider and starts no program itself: `execute` (ProviderService.runAgent in the app) does, and cancelling
// aborts that call, which stops only the program the app started for the run.

type Confirm = (options: { title: string; message: string; detail?: string; confirmLabel: string }) => Promise<boolean>;

export interface ExecuteRequest {
  runId: string;
  projectId: string;
  provider: ProviderId;
  model: string;
  prompt: string;
  /** The route, its cost and any retry or escalation, for the confirmation before a cloud send. */
  note: string;
  signal: AbortSignal;
  /** Call after the person approved (or nothing needed approval) and before the provider is called. */
  onApproved: () => void;
}

export interface RunQueueOptions {
  db: Db;
  agents: AgentService;
  tasks: TaskService;
  projects: ProjectRegistry;
  activity: ActivityLog;
  logger: Logger;
  /** Sends one run to its provider and resolves with its answer; `sent: false` when the person declined. */
  execute: (request: ExecuteRequest) => Promise<{ sent: boolean; text: string; truncated: boolean }>;
  availability: () => Promise<Availability>;
  /** What is using a provider outside the queue (a test prompt on the Integrations page), if anything. */
  providerBusy: (provider: ProviderId) => string | undefined;
  routing: () => { profile: RoutingProfile; overrides: Partial<Record<AgentRoleId, RoleOverride>>; localModel: string; maxAttempts: number; apiKeySet: boolean };
  /** The local-inference verdict now (from a fresh resource snapshot). */
  localPolicy: () => Promise<PolicyVerdict>;
  /** How long held runs wait before the queue looks again. */
  recheckMs: () => number;
  confirm: Confirm;
  /** False until Step 15: no run may change project files yet. */
  writesEnabled: boolean;
  now?: () => Date;
  newId?: () => string;
}

export interface RunQueue {
  view(projectId: string): QueueView;
  /** The route a start would use, shown before anything is sent. */
  route(runId: string, choice?: ProviderChoice): Promise<Route>;
  /** Asks for a queued run to start. It starts when nothing holds it; a cloud send is confirmed first. */
  start(runId: string, choice?: ProviderChoice): Promise<AgentRun>;
  cancel(runId: string): Promise<AgentRun>;
  setPriority(runId: string, priority: Priority): AgentRun;
  /** A new attempt of a failed or cancelled run, within the attempt limit. */
  retry(runId: string, choice?: ProviderChoice): Promise<AgentRun>;
  /** The person records how a run ended by hand. Refused for a run the queue is running. */
  record(runId: string, outcome: 'completed' | 'failed' | 'cancelled', note: string): AgentRun;
  acquireWriter(projectId: string, runId: string, workingDir: string): void;
  releaseWriter(projectId: string, runId: string): void;
  /** Releases a lock that no running writer holds, after a native confirmation. */
  releaseLock(projectId: string): Promise<{ released: boolean }>;
  /** At startup: runs that were active when the app stopped are failed, waiting requests are cleared, locks are kept. */
  recover(): void;
  shutdown(): Promise<void>;
}

interface LockRow {
  project_id: string;
  run_id: string;
  acquired_at: string;
  working_dir: string;
}

const FINAL_SQL = "('completed', 'failed', 'cancelled')";
const rank = (priority: Priority): number => PRIORITIES.indexOf(priority);
const POLICY_HOLD = 'Held by the local-inference policy:';
const MAX_RESULT = 200_000;

export function createRunQueue(options: RunQueueOptions): RunQueue {
  const { db, agents, tasks, projects, activity, logger } = options;
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? randomUUID;
  const active = new Map<string, { provider: ProviderId; controller: AbortController; approved: boolean; done: Promise<void> }>();
  const holds = new Map<string, string>();
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let pumping: Promise<void> | undefined;
  let again = false;

  const roleLabel = (role: AgentRoleId): string => roleById(role)?.label ?? role;
  const rowsWhere = (where: string, ...params: string[]): AgentRun[] => db.all<RunRow>(`SELECT * FROM agent_runs WHERE ${where}`, ...params).map(runFromRow);
  const lockOf = (projectId: string): LockRow | undefined => db.get<LockRow>('SELECT * FROM writer_locks WHERE project_id = ?', projectId);
  const projectOf = (id: string) => {
    const found = projects.get(id);
    if (found === undefined) throw new AppError('NOT_FOUND', 'That project is not in the registry.', { hint: 'It may have been removed. Reload the project list.' });
    return found;
  };
  const taskOf = (run: AgentRun) => {
    if (run.taskId === null) throw new AppError('NOT_FOUND', 'The task of this run was deleted, so there is nothing to send.', { hint: 'Cancel this run.' });
    return tasks.get(run.taskId);
  };
  const withHold = (run: AgentRun): AgentRun => ({
    ...run,
    hold: active.get(run.id)?.approved === false ? 'Starting: answer the confirmation window to send it, or decline to keep it queued.' : (holds.get(run.id) ?? ''),
  });
  const setNote = (id: string, note: string): void => void db.run('UPDATE agent_runs SET note = ?, updated_at = ? WHERE id = ?', note.slice(0, 1000), now().toISOString(), id);
  /** A move at the end of a run must not throw: the run may have been recorded by hand or removed in the meantime. */
  const finish = (id: string, state: RunState, reason: string): void => {
    try {
      agents.transition(id, state, reason.slice(0, 1000));
    } catch (error) {
      logger.warn('could not record the end of a run', { runId: id, state, error });
    }
  };

  async function routeFor(run: AgentRun, choice?: ProviderChoice): Promise<Route> {
    const task = taskOf(run);
    const r = options.routing();
    return chooseRoute({
      profile: r.profile,
      role: run.role,
      roleLabel: roleLabel(run.role),
      task: { provider: task.provider, complexity: task.complexity },
      override: r.overrides[run.role],
      ...(choice === undefined ? {} : { choice: { provider: choice.provider, model: choice.model } }),
      localModel: r.localModel,
      available: await options.availability(),
      apiKeySet: r.apiKeySet,
    });
  }

  const usable = (route: Route): ProviderId => {
    if (route.provider === null) throw new AppError('INVALID_INPUT', `No provider can take this run. ${route.reasons.join(' ')}`.slice(0, 900), { hint: 'Choose a provider for this run, or change the routing settings on the AI Workbench.' });
    return route.provider;
  };

  const checkWrites = (run: AgentRun): void => {
    if (!run.writeCapable) return;
    if (!options.writesEnabled)
      throw new AppError('PERMISSION_REQUIRED', 'Runs that change project files arrive with Step 15 (safe execution and permissions). Until then every agent run is read-only.', {
        hint: 'Run the planner, reviewer, QA, documentation or asset roles, or make the change by hand and record it.',
      });
    if (taskOf(run).planApprovedAt === null) throw new AppError('PERMISSION_REQUIRED', 'The implementer needs an approved plan before it can run.', { hint: 'Review the plan and approve it on the task.' });
  };

  async function request(run: AgentRun, route: Route): Promise<AgentRun> {
    const provider = usable(route);
    const stamp = now().toISOString();
    db.run(
      'UPDATE agent_runs SET requested_at = ?, route_json = ?, provider_id = ?, model = ?, note = ?, updated_at = ? WHERE id = ?',
      stamp, JSON.stringify(route), provider, route.model, `Waiting to start with ${PROVIDER_LABELS[provider]}.`, stamp, run.id,
    );
    activity.record({
      kind: 'agent.run-requested',
      severity: 'info',
      summary: `Asked to start the ${roleLabel(run.role)} run with ${PROVIDER_LABELS[provider]}${route.model === '' ? '' : ` (${route.model})`}${route.location === 'cloud' ? '; it is confirmed before anything is sent' : ', on this PC'}.`,
      projectId: run.projectId,
      ...(run.taskId === null ? {} : { taskId: run.taskId }),
      details: { runId: run.id, provider, model: route.model, profile: route.profile, billing: route.billing, fallback: route.fallback, attempt: run.attempt },
    });
    await pump();
    return withHold(agents.get(run.id));
  }

  async function waitReason(run: AgentRun, taken: ReadonlySet<ProviderId>, policy: () => Promise<PolicyVerdict>): Promise<string> {
    const route = run.route;
    if (route === null || route.provider === null) return 'This run has no usable route. Cancel it and start it again.';
    const label = PROVIDER_LABELS[route.provider];
    if (taken.has(route.provider)) return `Waiting for ${label}: another run is using it.`;
    const outside = options.providerBusy(route.provider);
    if (outside !== undefined) return `Waiting for ${label}: ${outside} is using it.`;
    if (run.workflowId !== null) {
      const earlier = db.get<{ role: AgentRoleId }>(`SELECT role FROM agent_runs WHERE workflow_id = ? AND step_index < ? AND state NOT IN ${FINAL_SQL} ORDER BY step_index LIMIT 1`, run.workflowId, run.stepIndex);
      if (earlier !== undefined) return `Waits for the ${roleLabel(earlier.role)} run of this workflow to finish first.`;
    }
    const lock = lockOf(run.projectId);
    if (lock !== undefined && lock.run_id !== run.id) {
      if (run.writeCapable) return 'Another run holds the writer lock on this project. Only one writer at a time.';
      if (run.role === 'reviewer' || run.role === 'qa') return 'Waits until the writer on this project is done, so it looks at a finished change.';
    }
    if (route.location === 'local') {
      const verdict = await policy();
      if (!verdict.allowed) return `${POLICY_HOLD} ${verdict.blocks.join(' ')}`;
    }
    return '';
  }

  const hold = (run: AgentRun, reason: string): void => {
    if (holds.get(run.id) === reason) return;
    holds.set(run.id, reason);
    activity.record({
      kind: 'agent.run-held',
      severity: reason.startsWith(POLICY_HOLD) ? 'warning' : 'info',
      summary: `The ${roleLabel(run.role)} run waits. ${reason}`.slice(0, 500),
      projectId: run.projectId,
      ...(run.taskId === null ? {} : { taskId: run.taskId }),
      details: { runId: run.id },
    });
  };

  function noteFor(run: AgentRun, route: Route, title: string): string {
    const { maxAttempts } = options.routing();
    const previous = run.retryOf === null ? null : (rowsWhere('id = ?', run.retryOf)[0]?.route ?? null);
    return [
      `Agent run: ${roleLabel(run.role)} for "${title}", read-only (attempt ${run.attempt} of at most ${maxAttempts}).`,
      `Routing (${PROFILE_LABELS[route.profile]}): ${route.reasons.join(' ')}`,
      `Cost: ${route.billingNote}`,
      ...(route.fallback ? ['This route costs more than the routing profile wanted, so it needs your approval.'] : []),
      ...escalationNotes(previous, route, run.attempt, maxAttempts),
    ].join('\n');
  }

  function launch(run: AgentRun, route: Route, provider: ProviderId): void {
    const label = PROVIDER_LABELS[provider];
    const controller = new AbortController();
    const entry = { provider, controller, approved: false, done: Promise.resolve() };
    active.set(run.id, entry);
    db.run('UPDATE agent_runs SET requested_at = NULL WHERE id = ?', run.id);
    entry.done = (async () => {
      let locked = false;
      try {
        // Synchronous up to the first await, so a second writer in the same pass already sees this lock.
        const task = taskOf(run);
        const project = projectOf(run.projectId);
        if (run.writeCapable) {
          acquireWriter(run.projectId, run.id, project.rootPath);
          locked = true;
        }
        let prompt = agents.prompt(task.id, run.role).prompt;
        if (route.location === 'local') prompt += '\n\nYou cannot open the project files; work only from the text above.';
        const result = await options.execute({
          runId: run.id,
          projectId: run.projectId,
          provider,
          model: route.model,
          prompt,
          note: noteFor(run, route, task.title),
          signal: controller.signal,
          onApproved: () => {
            agents.transition(run.id, run.role === 'planner' ? 'planning' : 'running', `Started with ${label}${route.model === '' ? '' : ` (${route.model})`}.`);
            entry.approved = true;
          },
        });
        if (!result.sent) {
          setNote(run.id, `Not sent: you declined sending it to ${label}. It stays queued; start it again when you want.`);
          activity.record({ kind: 'agent.run-declined', severity: 'info', summary: `The ${roleLabel(run.role)} run was not sent to ${label}: you declined.`, projectId: run.projectId, taskId: task.id, details: { runId: run.id } });
          return;
        }
        db.run('UPDATE agent_runs SET result = ? WHERE id = ?', result.text.slice(0, MAX_RESULT), run.id);
        finish(run.id, 'completed', `Finished with ${label}: ${result.text.length.toLocaleString('en-US')} characters${result.truncated ? ', cut at the limit' : ''}.`);
      } catch (error) {
        const e = error instanceof AppError ? error : new AppError('INTERNAL', 'The run stopped unexpectedly.', { cause: error, hint: 'Details are in the log.' });
        logger.warn('agent run ended with an error', { runId: run.id, code: e.code, message: e.message });
        const text = `${e.message}${e.hint === undefined ? '' : ` ${e.hint}`}`;
        if (!entry.approved) {
          setNote(run.id, `Could not start: ${text}`);
          activity.record({ kind: 'agent.run-not-started', severity: 'warning', summary: `The ${roleLabel(run.role)} run could not start: ${e.message}`.slice(0, 500), projectId: run.projectId, details: { runId: run.id, code: e.code } });
        } else finish(run.id, e.code === 'CANCELLED' ? 'cancelled' : 'failed', text);
      } finally {
        active.delete(run.id);
        if (locked) releaseWriter(run.projectId, run.id);
        void pump();
      }
    })();
  }

  async function pumpOnce(): Promise<void> {
    const waiting = rowsWhere("requested_at IS NOT NULL AND state = 'queued'")
      .filter((run) => !active.has(run.id))
      .sort((a, b) => rank(b.priority) - rank(a.priority) || (a.requestedAt ?? '').localeCompare(b.requestedAt ?? ''));
    for (const id of holds.keys()) if (!waiting.some((run) => run.id === id)) holds.delete(id);
    const taken = new Set([...active.values()].map((entry) => entry.provider));
    let verdict: Promise<PolicyVerdict> | undefined;
    const policy = (): Promise<PolicyVerdict> => (verdict ??= options.localPolicy());
    for (const run of waiting) {
      if (stopped) return;
      const reason = await waitReason(run, taken, policy);
      if (reason !== '') {
        hold(run, reason);
        continue;
      }
      holds.delete(run.id);
      const route = run.route as Route;
      const provider = route.provider as ProviderId;
      taken.add(provider);
      launch(run, route, provider);
    }
    clearTimeout(timer);
    timer = undefined;
    if (holds.size > 0 && !stopped) {
      timer = setTimeout(() => void pump(), options.recheckMs());
      timer.unref();
    }
  }

  /** One pass at a time; a request during a pass makes it run once more. */
  function pump(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (pumping !== undefined) {
      again = true;
      return pumping;
    }
    const repeat = (): boolean => again && !stopped; // set by calls that arrive while the pass runs
    pumping = (async () => {
      do {
        again = false;
        try {
          await pumpOnce();
        } catch (error) {
          logger.error('the run queue could not look at its waiting runs', { error });
        }
      } while (repeat());
    })().finally(() => {
      pumping = undefined;
    });
    return pumping;
  }

  function acquireWriter(projectId: string, runId: string, workingDir: string): void {
    const held = lockOf(projectId);
    if (held !== undefined && held.run_id !== runId)
      throw new AppError('CONFLICT', 'Another run is already writing to this project.', {
        hint: 'Only one agent may write to a project at a time. Wait for it to finish or cancel it; after a restart, check the files and release the lock on the AI Workbench.',
      });
    if (held !== undefined) return;
    db.run('INSERT INTO writer_locks (project_id, run_id, acquired_at, working_dir) VALUES (?, ?, ?, ?)', projectId, runId, now().toISOString(), workingDir);
    activity.record({ kind: 'agent.lock-acquired', severity: 'info', summary: `A run took the writer lock on "${projects.get(projectId)?.name ?? 'the project'}".`, projectId, details: { runId } });
  }

  function releaseWriter(projectId: string, runId: string): void {
    if (db.run('DELETE FROM writer_locks WHERE project_id = ? AND run_id = ?', projectId, runId).changes > 0)
      activity.record({ kind: 'agent.lock-released', severity: 'info', summary: `The writer lock on "${projects.get(projectId)?.name ?? 'the project'}" was released.`, projectId, details: { runId } });
  }

  return {
    view(projectId) {
      projectOf(projectId);
      const order = (run: AgentRun): number => (active.has(run.id) ? 0 : run.requestedAt !== null ? 1 : 2);
      const open = rowsWhere(`project_id = ? AND state NOT IN ${FINAL_SQL}`, projectId).sort(
        (a, b) => order(a) - order(b) || rank(b.priority) - rank(a.priority) || (a.requestedAt ?? a.createdAt).localeCompare(b.requestedAt ?? b.createdAt) || a.stepIndex - b.stepIndex,
      );
      const recent = db.all<RunRow>(`SELECT * FROM agent_runs WHERE project_id = ? AND state IN ${FINAL_SQL} ORDER BY updated_at DESC, id LIMIT 20`, projectId).map(runFromRow);
      const titles = new Map(tasks.list(projectId).map((task) => [task.id, task.title]));
      const lock = lockOf(projectId);
      const holder = lock === undefined ? undefined : rowsWhere('id = ?', lock.run_id)[0];
      return {
        runs: [...open, ...recent].map((run) => ({ ...withHold(run), taskTitle: (run.taskId === null ? undefined : titles.get(run.taskId)) ?? '(task deleted)' })),
        lock: lock === undefined ? null : { runId: lock.run_id, role: holder === undefined ? 'a run that no longer exists' : roleLabel(holder.role), acquiredAt: lock.acquired_at, active: active.has(lock.run_id) },
        writesEnabled: options.writesEnabled,
        maxAttempts: options.routing().maxAttempts,
      };
    },

    async route(runId, choice) {
      return routeFor(agents.get(runId), choice);
    },

    async start(runId, choice) {
      const run = agents.get(runId);
      if (active.has(runId) || run.requestedAt !== null) throw new AppError('CONFLICT', 'This run is already waiting to start or running.', { hint: 'Wait for it, or cancel it first.' });
      if (run.state !== 'queued')
        throw new AppError('INVALID_INPUT', `Only a queued run can be started; this one is ${RUN_STATE_LABELS[run.state].toLowerCase()}.`, run.state === 'failed' || run.state === 'cancelled' ? { hint: 'Use "Try again" to queue a new attempt.' } : {});
      checkWrites(run);
      return request(run, await routeFor(run, choice));
    },

    async cancel(runId) {
      const run = agents.get(runId);
      const entry = active.get(runId);
      if (entry !== undefined) {
        entry.controller.abort();
        await entry.done;
        const after = agents.get(runId);
        if (!FINAL_RUN_STATES.includes(after.state)) finish(runId, 'cancelled', 'Cancelled before anything was sent.'); // it was still at the confirmation
        return withHold(agents.get(runId));
      }
      if (FINAL_RUN_STATES.includes(run.state)) throw new AppError('INVALID_INPUT', `This run is already ${RUN_STATE_LABELS[run.state].toLowerCase()}.`);
      db.run('UPDATE agent_runs SET requested_at = NULL WHERE id = ?', runId);
      holds.delete(runId);
      const cancelled = agents.transition(runId, 'cancelled', 'Cancelled before it started.');
      void pump();
      return cancelled;
    },

    setPriority(runId, priority) {
      const run = agents.get(runId);
      if (FINAL_RUN_STATES.includes(run.state)) throw new AppError('INVALID_INPUT', 'A finished run has no place in the queue.');
      db.run('UPDATE agent_runs SET priority = ?, updated_at = ? WHERE id = ?', priority, now().toISOString(), runId);
      void pump();
      return withHold(agents.get(runId));
    },

    async retry(runId, choice) {
      const run = agents.get(runId);
      if (run.state !== 'failed' && run.state !== 'cancelled') throw new AppError('INVALID_INPUT', 'Only a failed or cancelled run can be tried again.');
      // Attempts form one chain, so going back to an older attempt cannot get around the limit.
      if (db.get('SELECT 1 AS found FROM agent_runs WHERE retry_of = ?', runId) !== undefined)
        throw new AppError('INVALID_INPUT', 'This attempt was already tried again.', { hint: 'Use the newest attempt of this run.' });
      const { maxAttempts } = options.routing();
      if (run.attempt >= maxAttempts)
        throw new AppError('LIMIT_REACHED', `This run was already tried ${run.attempt} time${run.attempt === 1 ? '' : 's'}, the most the routing settings allow.`, {
          hint: 'Change the task or the route first. If you really want another try, raise "Attempts per run" in the routing settings.',
        });
      if (run.taskId !== null && db.get(`SELECT 1 AS found FROM agent_runs WHERE task_id = ? AND role = ? AND state NOT IN ${FINAL_SQL}`, run.taskId, run.role) !== undefined)
        throw new AppError('CONFLICT', `There is already an unfinished ${roleLabel(run.role)} run for this task.`, { hint: 'Finish or cancel it first.' });
      checkWrites(run);
      const route = await routeFor(run, choice);
      usable(route);
      const id = newId();
      const stamp = now().toISOString();
      db.transaction(() => {
        db.run(
          `INSERT INTO agent_runs (id, project_id, task_id, workflow_id, step_index, role, provider_id, state, write_capable, optional, note, created_at, updated_at, priority, model, attempt, retry_of)
           SELECT ?, project_id, task_id, workflow_id, step_index, role, provider_id, 'queued', write_capable, optional, '', ?, ?, priority, model, attempt + 1, id FROM agent_runs WHERE id = ?`,
          id, stamp, stamp, runId,
        );
        db.run("INSERT INTO agent_run_transitions (id, run_id, from_state, to_state, at, reason) VALUES (?, ?, '', 'queued', ?, ?)", newId(), id, stamp, `Queued as attempt ${run.attempt + 1} of at most ${maxAttempts}.`);
      });
      activity.record({
        kind: 'agent.run-retried',
        severity: 'info',
        summary: `Queued attempt ${run.attempt + 1} of the ${roleLabel(run.role)} run.`,
        projectId: run.projectId,
        ...(run.taskId === null ? {} : { taskId: run.taskId }),
        details: { runId: id, retryOf: runId },
      });
      return request(agents.get(id), route);
    },

    record(runId, outcome, note) {
      if (active.has(runId)) throw new AppError('CONFLICT', 'This run is running from the queue.', { hint: 'Cancel it in the queue instead.' });
      const recorded = agents.recordOutcome(runId, outcome, note);
      db.run('UPDATE agent_runs SET requested_at = NULL WHERE id = ?', runId);
      holds.delete(runId);
      void pump();
      return recorded;
    },

    acquireWriter,
    releaseWriter,

    async releaseLock(projectId) {
      projectOf(projectId);
      const held = lockOf(projectId);
      if (held === undefined) return { released: false };
      if (active.has(held.run_id)) throw new AppError('CONFLICT', 'The writer that holds the lock is still running.', { hint: 'Cancel it in the queue; the lock is released when it stops.' });
      const ok = await options.confirm({
        title: 'Release the writer lock?',
        message: 'A run that could change this project’s files was interrupted, so the app could not see it finish.',
        detail: `It took the lock at ${held.acquired_at} in ${held.working_dir}.\n\nBefore another writer starts, check the project's files and Git status for half-finished changes, and check in Task Manager that no agent program from that run is still running.\n\nReleasing the lock does not change any file.`,
        confirmLabel: 'Release the lock',
      });
      if (!ok) return { released: false };
      db.run('DELETE FROM writer_locks WHERE project_id = ? AND run_id = ?', projectId, held.run_id);
      activity.record({ kind: 'agent.lock-released', severity: 'warning', summary: `You released the writer lock on "${projects.get(projectId)?.name ?? 'the project'}" after an interrupted run.`, projectId, details: { runId: held.run_id } });
      void pump();
      return { released: true };
    },

    recover() {
      for (const run of rowsWhere("state IN ('planning', 'running', 'awaiting-review', 'testing')"))
        finish(run.id, 'failed', 'The app closed while this run was active, so its program was stopped or lost. Try again if you still need it.');
      const cleared = db.run("UPDATE agent_runs SET requested_at = NULL, note = 'The app restarted before this run started. Start it again when you are ready.' WHERE requested_at IS NOT NULL AND state = 'queued'").changes;
      if (cleared > 0) logger.info('cleared waiting runs after a restart', { count: cleared });
      for (const lock of db.all<LockRow>('SELECT * FROM writer_locks'))
        activity.record({
          kind: 'agent.lock-kept',
          severity: 'warning',
          summary: `The writer lock on "${projects.get(lock.project_id)?.name ?? 'a project'}" is still held by a run that was interrupted. Check the project's files and Git status, then release it on the AI Workbench.`,
          projectId: lock.project_id,
          details: { runId: lock.run_id },
        });
    },

    async shutdown() {
      stopped = true;
      clearTimeout(timer);
      const entries = [...active.values()];
      for (const entry of entries) entry.controller.abort();
      await Promise.allSettled(entries.map((entry) => entry.done));
    },
  };
}
