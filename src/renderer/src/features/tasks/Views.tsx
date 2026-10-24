import { useEffect, useState } from 'react';
import {
  BOARD_STATUSES,
  PRIORITY_LABELS,
  SCOPE_LABELS,
  SCOPE_TIERS,
  SIDE_STATUSES,
  STATUS_LABELS,
  MILESTONE_STATUSES,
  type Milestone,
  type Progress,
  type Snapshot,
  type Task,
  type TaskStatus,
} from '@shared/tasks';
import { formatTime } from '../../lib/activity';
import type { PlanningApi } from '../../lib/planning';

interface ViewProps {
  planning: PlanningApi;
  selectedId: string | undefined;
  onSelect: (id: string) => void;
}

export function Progress_({ progress }: { progress: Progress }) {
  if (progress.percent === null) return <span className="muted">No tasks yet</span>;
  return (
    <span className="progress" title={`${progress.done} of ${progress.total} tasks done`}>
      <progress value={progress.done} max={progress.total} aria-label="Progress" /> {progress.done} of {progress.total} done ({progress.percent}%)
      {progress.blocked > 0 && <span className="muted"> · {progress.blocked} blocked</span>}
    </span>
  );
}

function TaskCard({ task, selected, onSelect }: { task: Task; selected: boolean; onSelect: (id: string) => void }) {
  return (
    <button type="button" className="taskcard" aria-pressed={selected} onClick={() => onSelect(task.id)}>
      <strong>{task.title}</strong>
      <span className="taskcard__meta">
        <span className="badge" data-priority={task.priority}>
          {PRIORITY_LABELS[task.priority]}
        </span>
        {task.subsystem !== '' && <span className="muted">{task.subsystem}</span>}
        {task.children > 0 && <span className="muted">{task.children} subtasks</span>}
        {task.waitingOn.length > 0 && <span className="badge badge--warn">Waiting on {task.waitingOn.length}</span>}
        {task.planApprovedAt !== null && <span className="badge">Plan approved</span>}
      </span>
    </button>
  );
}

/** The Kanban board: one column per lifecycle step, and one group for blocked, failed and cancelled tasks. */
export function BoardView({ planning, selectedId, onSelect }: ViewProps) {
  const column = (status: TaskStatus) => planning.tasks.filter((t) => t.status === status);
  const columns: readonly TaskStatus[] = [...BOARD_STATUSES, ...SIDE_STATUSES];
  return (
    <div className="board" role="group" aria-label="Task board">
      {columns.map((status) => (
        <section key={status} className="board__column" aria-label={STATUS_LABELS[status]}>
          <h3>
            {STATUS_LABELS[status]} <span className="muted">{column(status).length}</span>
          </h3>
          {column(status).map((task) => (
            <TaskCard key={task.id} task={task} selected={task.id === selectedId} onSelect={onSelect} />
          ))}
        </section>
      ))}
    </div>
  );
}

export function ListView({ planning, selectedId, onSelect }: ViewProps) {
  const [status, setStatus] = useState<TaskStatus | 'open' | 'all'>('open');
  const [query, setQuery] = useState('');
  const shown = planning.tasks.filter((t) => (status === 'all' ? true : status === 'open' ? t.status !== 'done' && t.status !== 'cancelled' : t.status === status) && t.title.toLowerCase().includes(query.toLowerCase()));
  const milestoneName = (id: string | null): string => planning.milestones.find((m) => m.id === id)?.title ?? '';
  return (
    <div>
      <div className="field">
        <label htmlFor="list-status">Show</label>
        <select id="list-status" value={status} onChange={(event) => setStatus((event.target.value as TaskStatus | 'open' | 'all'))}>
          <option value="open">Open tasks</option>
          <option value="all">All tasks</option>
          {([...BOARD_STATUSES, ...SIDE_STATUSES] as TaskStatus[]).map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </select>
        <label htmlFor="list-search">Search</label>
        <input id="list-search" value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>
      {shown.length === 0 ? (
        <p className="empty">No tasks match.</p>
      ) : (
        <table className="table" aria-label="Task list">
          <thead>
            <tr>
              <th>Task</th>
              <th>Status</th>
              <th>Priority</th>
              <th>Milestone</th>
              <th>Subsystem</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((task) => (
              <tr key={task.id} aria-selected={task.id === selectedId}>
                <td>
                  <button type="button" className="link" onClick={() => onSelect(task.id)}>
                    {task.parentId !== null && '↳ '}
                    {task.title}
                  </button>
                </td>
                <td>{STATUS_LABELS[task.status]}</td>
                <td>{PRIORITY_LABELS[task.priority]}</td>
                <td>{milestoneName(task.milestoneId)}</td>
                <td>{task.subsystem}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function SnapshotList({ milestone }: { milestone: Milestone }) {
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  useEffect(() => {
    let cancelled = false;
    void window.api.invoke('milestones:snapshots', { id: milestone.id }).then((result) => {
      if (!cancelled && result.ok) setSnapshots(result.value);
    });
    return () => {
      cancelled = true;
    };
  }, [milestone.id, milestone.progress]);
  if (snapshots.length === 0) return null;
  return (
    <ul className="rows" aria-label={`Snapshots of ${milestone.title}`}>
      {snapshots.map((s) => (
        <li key={s.id} className="muted">
          {formatTime(s.takenAt)} · {s.label} · {s.progress.done} of {s.progress.total} done
        </li>
      ))}
    </ul>
  );
}

/** The milestone roadmap: milestones in order with their scope tier, progress, tasks and snapshots. */
export function RoadmapView({ planning, selectedId, onSelect, projectId }: ViewProps & { projectId: string }) {
  const [title, setTitle] = useState('');
  const [tier, setTier] = useState<(typeof SCOPE_TIERS)[number]>('prototype');
  const [target, setTarget] = useState('');
  const loose = planning.tasks.filter((t) => t.milestoneId === null);
  return (
    <div className="stack">
      <section className="card" aria-label="New milestone">
        <div className="card__head">
          <h2>New milestone</h2>
        </div>
        <div className="field">
          <label htmlFor="ms-title">Title</label>
          <input id="ms-title" value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} />
          <label htmlFor="ms-tier">Scope</label>
          <select id="ms-tier" value={tier} onChange={(event) => setTier(SCOPE_TIERS.find((t) => t === event.target.value) ?? 'prototype')}>
            {SCOPE_TIERS.map((t) => (
              <option key={t} value={t}>
                {SCOPE_LABELS[t]}
              </option>
            ))}
          </select>
          <label htmlFor="ms-date">Target date</label>
          <input id="ms-date" type="date" value={target} onChange={(event) => setTarget(event.target.value)} />
          <button
            type="button"
            className="btn btn--primary"
            disabled={title.trim() === ''}
            onClick={() =>
              void planning.call(() => window.api.invoke('milestones:create', { projectId, title, scopeTier: tier, targetDate: target === '' ? null : target })).then((m) => {
                if (m !== undefined) {
                  setTitle('');
                  setTarget('');
                }
              })
            }
          >
            Add milestone
          </button>
        </div>
      </section>

      {planning.milestones.length === 0 && <p className="empty">No milestones yet. A milestone groups tasks towards one goal, such as the first playable prototype.</p>}
      {planning.milestones.map((m) => (
        <section key={m.id} className="card" aria-label={`Milestone ${m.title}`}>
          <div className="card__head">
            <h2>{m.title}</h2>
            <span className="badge">{SCOPE_LABELS[m.scopeTier]}</span>
          </div>
          <div className="actions">
            <Progress_ progress={m.progress} />
            {m.targetDate !== null && <span className="muted">Target {m.targetDate}</span>}
            <label>
              <span className="muted">Status </span>
              <select
                aria-label={`Status of ${m.title}`}
                value={m.status}
                onChange={(event) => void planning.call(() => window.api.invoke('milestones:update', { id: m.id, status: MILESTONE_STATUSES.find((s) => s === event.target.value) ?? 'planned' }))}
              >
                {MILESTONE_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s[0]?.toUpperCase()}
                    {s.slice(1)}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="btn" onClick={() => void planning.call(() => window.api.invoke('milestones:snapshot', { id: m.id, label: '' }))}>
              Take a snapshot
            </button>
            <button type="button" className="btn btn--danger" onClick={() => void planning.call(() => window.api.invoke('milestones:remove', { id: m.id }))}>
              Delete milestone
            </button>
          </div>
          <ul className="rows" aria-label={`Tasks of ${m.title}`}>
            {planning.tasks
              .filter((t) => t.milestoneId === m.id)
              .map((t) => (
                <li key={t.id}>
                  <button type="button" className="link" aria-pressed={t.id === selectedId} onClick={() => onSelect(t.id)}>
                    {t.title}
                  </button>{' '}
                  <span className="muted">· {STATUS_LABELS[t.status]}</span>
                </li>
              ))}
          </ul>
          <SnapshotList milestone={m} />
        </section>
      ))}
      {loose.length > 0 && (
        <section className="card" aria-label="Tasks without a milestone">
          <div className="card__head">
            <h2>No milestone</h2>
          </div>
          <ul className="rows">
            {loose.map((t) => (
              <li key={t.id}>
                <button type="button" className="link" onClick={() => onSelect(t.id)}>
                  {t.title}
                </button>{' '}
                <span className="muted">· {STATUS_LABELS[t.status]}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
