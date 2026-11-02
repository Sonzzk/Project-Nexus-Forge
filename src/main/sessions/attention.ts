import type { QueueView } from '@shared/agents';
import type { AttentionItem } from '@shared/sessions';
import type { ProjectRegistry } from '../projects';
import type { Db } from '../storage';

// What is waiting on the person (spec §20: outstanding approvals, resource warnings). Everything here is read from state the app
// already keeps: the queue's holds, the writer locks, the review sessions and the usage log. Nothing is measured or polled for it;
// the resource lines come from the last check, with its age.

export interface AttentionOptions {
  db: Db;
  projects: ProjectRegistry;
  /** The queue of one project (the real queue, or anything with its `view`). */
  queue: { view(projectId: string): QueueView };
  /** Warnings from the most recent resource check, if there was one, and when it was made. */
  resources: () => { at: string; warnings: string[] } | undefined;
  now?: () => Date;
}

const CONFIRMATION_HOLD = 'Starting: answer the confirmation window';

export function createAttention(options: AttentionOptions): { items(): AttentionItem[] } {
  const { db, projects } = options;
  const now = options.now ?? (() => new Date());

  return {
    items() {
      const items: AttentionItem[] = [];
      for (const project of projects.list()) {
        const view = options.queue.view(project.id);
        const confirming = view.runs.filter((r) => r.hold.startsWith(CONFIRMATION_HOLD));
        if (confirming.length > 0) items.push({ id: `confirm-${project.id}`, severity: 'warning', text: `${project.name}: ${confirming.length === 1 ? 'a run is' : `${confirming.length} runs are`} waiting for your answer in a confirmation window.`, section: 'workbench', projectId: project.id });
        const waiting = view.runs.filter((r) => r.hold !== '' && !r.hold.startsWith(CONFIRMATION_HOLD));
        if (waiting.length > 0) items.push({ id: `held-${project.id}`, severity: 'info', text: `${project.name}: ${waiting.length === 1 ? 'a run waits' : `${waiting.length} runs wait`}. ${waiting[0]?.hold ?? ''}`.slice(0, 380), section: 'workbench', projectId: project.id });
        if (view.lock !== null && !view.lock.active) items.push({ id: `lock-${project.id}`, severity: 'warning', text: `${project.name}: a writer lock from an interrupted run is still held. Check the project's files, then release it.`, section: 'workbench', projectId: project.id });
        const review = db.get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM change_sessions c LEFT JOIN agent_runs r ON r.id = c.run_id
            WHERE c.project_id = ? AND c.status = 'open' AND (r.state IS NULL OR r.state NOT IN ('planning', 'running', 'awaiting-review', 'testing'))`,
          project.id,
        )?.n ?? 0;
        if (review > 0) items.push({ id: `review-${project.id}`, severity: 'info', text: `${project.name}: ${review === 1 ? 'the changes of an agent run are' : `the changes of ${review} agent runs are`} waiting for your review.`, section: 'git', projectId: project.id });
      }
      const d = now();
      const blocked = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM usage_log WHERE status = 'blocked' AND started_at >= ?", new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString())?.n ?? 0;
      if (blocked > 0) items.push({ id: 'limits', severity: 'info', text: `${blocked} cloud launch${blocked === 1 ? ' was' : 'es were'} stopped by a limit today.`, section: 'integrations' });
      const resources = options.resources();
      if (resources !== undefined)
        for (const warning of resources.warnings.slice(0, 5)) items.push({ id: `resource-${warning.slice(0, 40)}`, severity: 'warning', text: `${warning} (resource check of ${resources.at.slice(11, 16)} UTC)`.slice(0, 400), section: 'workbench' });
      return items;
    },
  };
}
