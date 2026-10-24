import { useState } from 'react';
import { PRIORITY_LABELS } from '@shared/tasks';
import { usePlanning, type PlanningApi } from '../../lib/planning';
import { useProjects } from '../../lib/projects';
import { useSettings } from '../../lib/settings';
import { RisksView } from './RisksView';
import { TaskDetail } from './TaskDetail';
import { BreakdownForm, NewTaskForm } from './TaskForms';
import { BoardView, ListView, RoadmapView } from './Views';

type View = 'board' | 'list' | 'roadmap' | 'risks';
const VIEW_LABELS: Record<View, string> = { board: 'Board', list: 'List', roadmap: 'Roadmap', risks: 'Bugs and risks' };

function NextAction({ planning, onSelect }: { planning: PlanningApi; onSelect: (id: string) => void }) {
  if (planning.next === undefined) return null;
  const top = planning.next.items[0];
  return (
    <section className="card" aria-label="Next recommended task">
      <div className="card__head">
        <h2>Next recommended task</h2>
      </div>
      {top === undefined ? (
        <p className="empty">{planning.next.message}</p>
      ) : (
        <>
          <p>
            <button type="button" className="link" onClick={() => onSelect(top.task.id)}>
              <strong>{top.task.title}</strong>
            </button>{' '}
            <span className="muted">· {PRIORITY_LABELS[top.task.priority]}</span>
          </p>
          <p className="muted">Why: {top.reasons.join('; ')}.</p>
        </>
      )}
    </section>
  );
}

function ProjectTasks({ projectId }: { projectId: string }) {
  const { settings, set } = useSettings();
  const planning = usePlanning(projectId);
  const [view, setView] = useState<View>(settings['tasks.view']);
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [form, setForm] = useState<'none' | 'task' | 'breakdown'>('none');
  const selected = planning.tasks.find((t) => t.id === selectedId);

  const choose = (next: View): void => {
    setView(next);
    if (next !== 'risks') set('tasks.view', next);
  };

  return (
    <>
      {planning.error !== undefined && (
        <p role="alert">
          {planning.error.message} {planning.error.hint}
        </p>
      )}
      <div className="actions">
        <div role="tablist" aria-label="Task views" className="tabs">
          {(Object.keys(VIEW_LABELS) as View[]).map((v) => (
            <button key={v} type="button" role="tab" className="tab" aria-selected={view === v} data-state={view === v ? 'active' : 'inactive'} onClick={() => choose(v)}>
              {VIEW_LABELS[v]}
            </button>
          ))}
        </div>
        <button type="button" className="btn btn--primary" onClick={() => setForm('task')}>
          New task…
        </button>
        <button type="button" className="btn" onClick={() => setForm('breakdown')}>
          Break a feature down…
        </button>
      </div>

      <NextAction planning={planning} onSelect={setSelectedId} />
      {form === 'task' && (
        <NewTaskForm
          projectId={projectId}
          planning={planning}
          onCreated={(task) => {
            setSelectedId(task.id);
            setForm('none');
          }}
          onClose={() => setForm('none')}
        />
      )}
      {form === 'breakdown' && <BreakdownForm projectId={projectId} planning={planning} onClose={() => setForm('none')} />}

      {planning.loaded && planning.tasks.length === 0 && view !== 'risks' && view !== 'roadmap' && (
        <p className="empty">No tasks yet. Add one with “New task…”, or describe a feature and break it down into small tasks.</p>
      )}
      <div className={selected === undefined ? undefined : 'split split--tasks'}>
        <div className="stack">
          {view === 'board' && <BoardView planning={planning} selectedId={selectedId} onSelect={setSelectedId} />}
          {view === 'list' && <ListView planning={planning} selectedId={selectedId} onSelect={setSelectedId} />}
          {view === 'roadmap' && <RoadmapView planning={planning} selectedId={selectedId} onSelect={setSelectedId} projectId={projectId} />}
          {view === 'risks' && <RisksView projectId={projectId} planning={planning} />}
        </div>
        {selected !== undefined && <TaskDetail key={selected.id} task={selected} planning={planning} onGone={() => setSelectedId(undefined)} />}
      </div>
    </>
  );
}

/** Tasks and Roadmap (spec §10, §19, §20): board, list and milestone roadmap over the same stored tasks, and the bugs and risks register. */
export function TasksPage() {
  const { selected } = useProjects();
  return (
    <div className="page">
      <header className="page__head">
        <h1>Tasks and Roadmap</h1>
        <p className="muted">Plan the work for the selected project. Progress is counted from the tasks stored here, never estimated.</p>
      </header>
      {selected === undefined ? <p className="empty">Select a project to plan its tasks.</p> : <ProjectTasks key={selected.id} projectId={selected.id} />}
    </div>
  );
}
