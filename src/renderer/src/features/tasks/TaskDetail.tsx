import { useEffect, useState } from 'react';
import { AlertDialog } from 'radix-ui';
import { STATUS_LABELS, type Note, type Task } from '@shared/tasks';
import { formatTime } from '../../lib/activity';
import type { PlanningApi } from '../../lib/planning';
import { AgentsPanel } from './AgentsPanel';
import { draftOf, fieldsOf, TaskFieldsForm, type TaskDraft } from './TaskForms';

/** One task: edit every field, move it along its lifecycle, approve its plan, set what it waits on, keep notes. */
export function TaskDetail({ task, planning, onGone }: { task: Task; planning: PlanningApi; onGone: () => void }) {
  const [draft, setDraft] = useState<TaskDraft>(draftOf(task));
  const [notes, setNotes] = useState<Note[]>([]);
  const [noteText, setNoteText] = useState('');
  const [noteVersion, setNoteVersion] = useState(0);
  const [saved, setSaved] = useState(false);
  const others = planning.tasks.filter((t) => t.id !== task.id);

  useEffect(() => {
    let cancelled = false;
    void window.api.invoke('tasks:notes', { id: task.id }).then((result) => {
      if (!cancelled && result.ok) setNotes(result.value);
    });
    return () => {
      cancelled = true;
    };
  }, [task.id, noteVersion]);

  return (
    <section className="card" aria-label={`Task ${task.title}`}>
      <div className="card__head">
        <h2>{task.title}</h2>
        <span className="badge" data-status={task.status}>
          {STATUS_LABELS[task.status]}
        </span>
      </div>

      <div className="actions" role="group" aria-label="Move this task">
        {task.allowedNext.map((status) => (
          <button key={status} type="button" className="btn" onClick={() => void planning.call(() => window.api.invoke('tasks:setStatus', { id: task.id, status }))}>
            Move to {STATUS_LABELS[status]}
          </button>
        ))}
        {task.allowedNext.length === 0 && <span className="muted">No moves from here.</span>}
      </div>
      {task.waitingOn.length > 0 && (
        <p className="muted">
          Waiting on: {task.waitingOn.map((w) => `${w.title} (${STATUS_LABELS[w.status]})`).join(', ')}
        </p>
      )}
      <div className="actions">
        <span>{task.planApprovedAt === null ? 'Plan not approved yet.' : `Plan approved ${formatTime(task.planApprovedAt)}.`}</span>
        <button type="button" className="btn" onClick={() => void planning.call(() => window.api.invoke('tasks:approvePlan', { id: task.id, approved: task.planApprovedAt === null }))}>
          {task.planApprovedAt === null ? 'Approve the plan' : 'Withdraw approval'}
        </button>
      </div>

      <TaskFieldsForm
        draft={draft}
        onChange={(next) => {
          setDraft(next);
          setSaved(false);
        }}
        milestones={planning.milestones}
        withResult
      />
      <div className="actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={draft.title.trim() === ''}
          onClick={() => void planning.call(() => window.api.invoke('tasks:update', { id: task.id, ...fieldsOf(draft), parentId: task.parentId })).then((result) => setSaved(result !== undefined))}
        >
          Save changes
        </button>
        <span role="status" className="muted">
          {saved ? 'Saved.' : ''}
        </span>
      </div>

      <h3>Waits for</h3>
      {others.length === 0 ? (
        <p className="empty">No other tasks in this project.</p>
      ) : (
        <ul className="rows" aria-label="Dependencies">
          {others.map((other) => (
            <li key={other.id}>
              <label className="check">
                <input
                  type="checkbox"
                  checked={task.dependsOn.includes(other.id)}
                  onChange={(event) =>
                    void planning.call(() =>
                      window.api.invoke('tasks:setDependencies', {
                        id: task.id,
                        dependsOn: event.target.checked ? [...task.dependsOn, other.id] : task.dependsOn.filter((d) => d !== other.id),
                      }),
                    )
                  }
                />{' '}
                {other.title} <span className="muted">· {STATUS_LABELS[other.status]}</span>
              </label>
            </li>
          ))}
        </ul>
      )}

      <h3>Notes</h3>
      {notes.length === 0 && <p className="empty">No notes yet.</p>}
      <ul className="rows" aria-label="Notes">
        {notes.map((note) => (
          <li key={note.id}>
            <span className="muted">{formatTime(note.createdAt)}</span> {note.text}
          </li>
        ))}
      </ul>
      <div className="actions">
        <input aria-label="New note" value={noteText} maxLength={4000} onChange={(event) => setNoteText(event.target.value)} />
        <button
          type="button"
          className="btn"
          disabled={noteText.trim() === ''}
          onClick={() =>
            void window.api.invoke('tasks:addNote', { id: task.id, text: noteText }).then((result) => {
              if (result.ok) {
                setNoteText('');
                setNoteVersion((n) => n + 1);
              }
            })
          }
        >
          Add note
        </button>
      </div>

      <AgentsPanel task={task} />

      <div className="actions">
        <AlertDialog.Root>
          <AlertDialog.Trigger asChild>
            <button type="button" className="btn btn--danger">
              Delete this task
            </button>
          </AlertDialog.Trigger>
          <AlertDialog.Portal>
            <AlertDialog.Overlay className="overlay" />
            <AlertDialog.Content className="palette dialog">
              <AlertDialog.Title>Delete “{task.title}”?</AlertDialog.Title>
              <AlertDialog.Description className="muted">
                The task, its notes and its place in other tasks&apos; dependencies are removed. Its subtasks stay.
              </AlertDialog.Description>
              <div className="actions">
                <AlertDialog.Cancel asChild>
                  <button type="button" className="btn">
                    Keep it
                  </button>
                </AlertDialog.Cancel>
                <AlertDialog.Action asChild>
                  <button type="button" className="btn btn--danger" onClick={() => void planning.call(() => window.api.invoke('tasks:remove', { id: task.id })).then((r) => r !== undefined && onGone())}>
                    Delete
                  </button>
                </AlertDialog.Action>
              </div>
            </AlertDialog.Content>
          </AlertDialog.Portal>
        </AlertDialog.Root>
      </div>
    </section>
  );
}
