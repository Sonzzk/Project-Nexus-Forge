import { randomUUID } from 'node:crypto';
import {
  AGENT_ROLES,
  FINAL_RUN_STATES,
  RUN_STATE_LABELS,
  RUN_TRANSITIONS,
  WorkflowRequestSchema,
  renderPrompt,
  roleById,
  workflowById,
  type AgentRole,
  type AgentRoleId,
  type AgentRun,
  type RunState,
  type WorkflowPreview,
  type WorkflowRequest,
} from '@shared/agents';
import type { PromptPreviewSchema } from '@shared/agents';
import { AppError } from '@shared/errors';
import type { z } from 'zod';
import type { ActivityLog } from '../logging';
import type { ProjectRegistry } from '../projects';
import type { Db } from '../storage';
import { parseInput } from './parse';
import type { TaskService } from './tasks';

// Agent roles and run records (spec §11). This module only keeps records: a workflow turns into queued run records, and a
// run's state follows the table in src/shared/agents.ts. It starts nothing, calls no provider and imports no process code
// (a test checks that); a person records the outcome of work done by hand, and the runner of Steps 12 and 13 will drive the rest.

export interface AgentService {
  roles(): Omit<AgentRole, 'promptTemplate'>[];
  /** What a workflow would do and with which provider, before anything is created. */
  preview(request: WorkflowRequest): WorkflowPreview;
  /** Saves the included steps as queued run records. Reviewer and QA steps are only included when asked for. */
  createWorkflow(request: WorkflowRequest): AgentRun[];
  runs(taskId: string): AgentRun[];
  /** The text a provider would receive for this role and task. Nothing is sent. */
  prompt(taskId: string, role: AgentRoleId): z.output<typeof PromptPreviewSchema>;
  /** The person records how a run ended (work done by hand, or abandoned). Not a launch. */
  recordOutcome(runId: string, outcome: 'completed' | 'failed' | 'cancelled', note: string): AgentRun;
  /** The runner's move along the state table (Step 13 uses it). Enforces the permission rules. */
  transition(runId: string, state: RunState, reason: string): AgentRun;
}

export interface AgentServiceOptions {
  db: Db;
  projects: ProjectRegistry;
  tasks: TaskService;
  activity: ActivityLog;
  now?: () => Date;
  newId?: () => string;
}

interface Row {
  id: string;
  project_id: string;
  task_id: string | null;
  workflow_id: string | null;
  step_index: number;
  role: AgentRoleId;
  provider_id: string;
  state: RunState;
  write_capable: number;
  optional: number;
  note: string;
  created_at: string;
  updated_at: string;
}

const toRun = (r: Row): AgentRun => ({
  id: r.id,
  projectId: r.project_id,
  taskId: r.task_id,
  workflowId: r.workflow_id,
  stepIndex: r.step_index,
  role: r.role,
  providerId: r.provider_id,
  state: r.state,
  writeCapable: r.write_capable === 1,
  optional: r.optional === 1,
  note: r.note,
  allowedNext: [...RUN_TRANSITIONS[r.state]],
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function createAgentService(options: AgentServiceOptions): AgentService {
  const { db, projects, tasks, activity } = options;
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? randomUUID;

  const row = (id: string): Row => {
    const found = db.get<Row>('SELECT * FROM agent_runs WHERE id = ?', id);
    if (found === undefined) throw new AppError('NOT_FOUND', 'That run does not exist.', { hint: 'It may have been deleted. Reload the list.' });
    return found;
  };
  const projectName = (id: string): string => projects.get(id)?.name ?? 'the project';

  const preview = (raw: WorkflowRequest): WorkflowPreview => {
    const request = parseInput(WorkflowRequestSchema, raw);
    const task = tasks.get(request.taskId);
    const template = workflowById(request.workflow);
    if (template === undefined) throw new AppError('INVALID_INPUT', 'That workflow does not exist.');
    const finished = task.status === 'done' || task.status === 'cancelled';
    return {
      workflow: template.id,
      label: template.label,
      description: template.description,
      launchUnavailable: true,
      steps: template.steps.map((step) => {
        const role = step.role === undefined ? undefined : roleById(step.role);
        const included = !step.optional || (step.role === 'reviewer' && request.includeReviewer) || (step.role === 'qa' && request.includeQa);
        let blockedBy = '';
        if (finished && step.kind === 'agent') blockedBy = `The task is ${task.status}.`;
        else if (role?.writeCapable === true && task.planApprovedAt === null) blockedBy = 'Needs an approved plan. Approve the plan on the task first.';
        else if (step.kind === 'approval' && task.planApprovedAt !== null) blockedBy = '';
        return {
          kind: step.kind,
          ...(step.role === undefined ? {} : { role: step.role, roleLabel: role?.label ?? step.role }),
          optional: step.optional,
          included,
          writeCapable: role?.writeCapable === true,
          action: step.action,
          provider: step.kind === 'agent' ? task.provider : '',
          usage: step.kind === 'agent' ? task.usage : '',
          blockedBy,
        };
      }),
    };
  };

  const record = (runId: string, from: string, to: RunState, reason: string, stamp: string): void => {
    db.run('INSERT INTO agent_run_transitions (id, run_id, from_state, to_state, at, reason) VALUES (?, ?, ?, ?, ?, ?)', newId(), runId, from, to, stamp, reason);
  };

  const move = (current: Row, state: RunState, reason: string): AgentRun => {
    const stamp = now().toISOString();
    db.transaction(() => {
      db.run('UPDATE agent_runs SET state = ?, note = CASE WHEN ? = \'\' THEN note ELSE ? END, updated_at = ? WHERE id = ?', state, reason, reason, stamp, current.id);
      record(current.id, current.state, state, reason, stamp);
    });
    activity.record({
      kind: 'agent.run-state',
      severity: state === 'failed' ? 'warning' : 'info',
      summary: `${roleById(current.role)?.label ?? current.role} run: ${RUN_STATE_LABELS[current.state]} to ${RUN_STATE_LABELS[state]}.`,
      projectId: current.project_id,
      ...(current.task_id === null ? {} : { taskId: current.task_id }),
      details: { runId: current.id, from: current.state, to: state },
    });
    return toRun(row(current.id));
  };

  return {
    roles: () => AGENT_ROLES.map((r) => ({ id: r.id, label: r.label, purpose: r.purpose, expectedOutput: r.expectedOutput, writeCapable: r.writeCapable })),
    preview,

    createWorkflow(raw) {
      const request = parseInput(WorkflowRequestSchema, raw);
      const task = tasks.get(request.taskId);
      const plan = preview(request);
      const steps = plan.steps.filter((s) => s.kind === 'agent' && s.included && s.role !== undefined);
      for (const step of steps) {
        const active = db.get('SELECT 1 FROM agent_runs WHERE task_id = ? AND role = ? AND state NOT IN (\'completed\', \'failed\', \'cancelled\')', task.id, step.role as AgentRoleId);
        if (active !== undefined) throw new AppError('CONFLICT', `There is already an unfinished ${step.roleLabel} run for this task.`, { hint: 'Finish or cancel it first.' });
      }
      const workflowId = newId();
      const stamp = now().toISOString();
      const ids = db.transaction(() =>
        steps.map((step, index) => {
          const id = newId();
          db.run(
            'INSERT INTO agent_runs (id, project_id, task_id, workflow_id, step_index, role, provider_id, state, write_capable, optional, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, \'queued\', ?, ?, \'\', ?, ?)',
            id, task.projectId, task.id, workflowId, index, step.role as AgentRoleId, step.provider, step.writeCapable ? 1 : 0, step.optional ? 1 : 0, stamp, stamp,
          );
          record(id, '', 'queued', 'Queued from the workflow plan', stamp);
          return id;
        }),
      );
      activity.record({
        kind: 'agent.workflow-queued',
        severity: 'info',
        summary: `Queued the "${plan.label}" workflow for "${task.title}" in "${projectName(task.projectId)}" (${ids.length} run${ids.length === 1 ? '' : 's'}). Nothing was started.`,
        projectId: task.projectId,
        taskId: task.id,
      });
      return ids.map((id) => toRun(row(id)));
    },

    runs(taskId) {
      tasks.get(taskId);
      return db.all<Row>('SELECT * FROM agent_runs WHERE task_id = ? ORDER BY created_at, step_index, id', taskId).map(toRun);
    },

    prompt(taskId, roleId) {
      const task = tasks.get(taskId);
      const role = roleById(roleId);
      if (role === undefined) throw new AppError('INVALID_INPUT', 'That role does not exist.');
      return {
        role: role.id,
        writeCapable: role.writeCapable,
        prompt: renderPrompt(role, task, projectName(task.projectId)),
        note: 'This is the text a provider would receive for this task. Nothing is sent: running agents arrives in Steps 12 and 13.',
      };
    },

    recordOutcome(runId, outcome, note) {
      const current = row(runId);
      if (FINAL_RUN_STATES.includes(current.state)) throw new AppError('INVALID_INPUT', `This run is already ${RUN_STATE_LABELS[current.state].toLowerCase()}.`, { hint: 'A finished run cannot change. Queue a new one if needed.' });
      return move(current, outcome, (note.trim() === '' ? 'Recorded by hand' : `Recorded by hand: ${note.trim()}`).slice(0, 1000));
    },

    transition(runId, state, reason) {
      const current = row(runId);
      if (!RUN_TRANSITIONS[current.state].includes(state))
        throw new AppError('INVALID_INPUT', `A run cannot go from ${RUN_STATE_LABELS[current.state]} to ${RUN_STATE_LABELS[state]}.`, {
          hint: `From ${RUN_STATE_LABELS[current.state]} it can go to: ${RUN_TRANSITIONS[current.state].map((s) => RUN_STATE_LABELS[s]).join(', ') || 'nowhere'}.`,
        });
      if (state === 'running' && current.write_capable === 1) {
        const task = current.task_id === null ? undefined : tasks.get(current.task_id);
        if (task === undefined || task.planApprovedAt === null)
          throw new AppError('PERMISSION_REQUIRED', 'The implementer needs an approved plan before it can run.', { hint: 'Review the plan and approve it on the task.' });
      }
      return move(current, state, reason);
    },
  };
}
