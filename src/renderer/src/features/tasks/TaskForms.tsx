import { useState } from 'react';
import {
  COMPLEXITIES,
  COMPLEXITY_LABELS,
  PRIORITIES,
  PRIORITY_LABELS,
  ROLES,
  ROLE_LABELS,
  TASK_TEMPLATES,
  USAGE_CATEGORIES,
  USAGE_LABELS,
  type Complexity,
  type Milestone,
  type Priority,
  type RoleId,
  type Task,
  type TemplateId,
  type UsageCategory,
} from '@shared/tasks';
import type { ProviderChoice } from '@shared/providers';
import type { PlanningApi } from '../../lib/planning';
import { ProviderPicker } from '../integrations/ProviderPicker';

const lines = (text: string): string[] => text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

export function MilestoneSelect({ milestones, value, onChange, id }: { milestones: Milestone[]; value: string | null; onChange: (id: string | null) => void; id: string }) {
  return (
    <select id={id} value={value ?? ''} onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}>
      <option value="">No milestone</option>
      {milestones.map((m) => (
        <option key={m.id} value={m.id}>
          {m.title}
        </option>
      ))}
    </select>
  );
}

/** Fields shared by creating and editing a task. */
export interface TaskDraft {
  title: string;
  description: string;
  milestoneId: string | null;
  subsystem: string;
  priority: Priority;
  complexity: Complexity;
  category: TemplateId | '';
  acceptance: string;
  files: string;
  role: RoleId;
  provider: string;
  usage: UsageCategory;
  testRequirements: string;
  resultNotes: string;
}

export const emptyDraft = (): TaskDraft => ({
  title: '', description: '', milestoneId: null, subsystem: '', priority: 'normal', complexity: '', category: '', acceptance: '', files: '', role: '', provider: '', usage: '', testRequirements: '', resultNotes: '',
});

export const draftOf = (task: Task): TaskDraft => ({
  title: task.title, description: task.description, milestoneId: task.milestoneId, subsystem: task.subsystem, priority: task.priority, complexity: task.complexity, category: task.category,
  acceptance: task.acceptance.join('\n'), files: task.files.join('\n'), role: task.role, provider: task.provider, usage: task.usage, testRequirements: task.testRequirements, resultNotes: task.resultNotes,
});

export const fieldsOf = (draft: TaskDraft) => ({
  title: draft.title, description: draft.description, milestoneId: draft.milestoneId, subsystem: draft.subsystem, priority: draft.priority, complexity: draft.complexity, category: draft.category,
  acceptance: lines(draft.acceptance), files: lines(draft.files), role: draft.role, provider: draft.provider, usage: draft.usage, testRequirements: draft.testRequirements, resultNotes: draft.resultNotes,
});

/** The editable fields of a task (spec §10). `prefix` keeps the labels of two forms apart. */
export function TaskFieldsForm({ draft, onChange, milestones, withResult }: { draft: TaskDraft; onChange: (draft: TaskDraft) => void; milestones: Milestone[]; withResult: boolean }) {
  const set = <K extends keyof TaskDraft>(key: K, value: TaskDraft[K]): void => onChange({ ...draft, [key]: value });
  return (
    <div className="form">
      <label>
        Title
        <input value={draft.title} maxLength={200} onChange={(event) => set('title', event.target.value)} />
      </label>
      <label>
        Description
        <textarea value={draft.description} rows={3} maxLength={8000} onChange={(event) => set('description', event.target.value)} />
      </label>
      <div className="field">
        <label htmlFor="task-milestone">Milestone</label>
        <MilestoneSelect id="task-milestone" milestones={milestones} value={draft.milestoneId} onChange={(id) => set('milestoneId', id)} />
        <label htmlFor="task-priority">Priority</label>
        <select id="task-priority" value={draft.priority} onChange={(event) => set('priority', PRIORITIES.find((p) => p === event.target.value) ?? 'normal')}>
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {PRIORITY_LABELS[p]}
            </option>
          ))}
        </select>
        <label htmlFor="task-complexity">Complexity</label>
        <select id="task-complexity" value={draft.complexity} onChange={(event) => set('complexity', COMPLEXITIES.find((c) => c === event.target.value) ?? '')}>
          {COMPLEXITIES.map((c) => (
            <option key={c} value={c}>
              {COMPLEXITY_LABELS[c]}
            </option>
          ))}
        </select>
      </div>
      <label>
        Subsystem <span className="muted">(for example Movement, Lighting, AI)</span>
        <input value={draft.subsystem} maxLength={80} onChange={(event) => set('subsystem', event.target.value)} />
      </label>
      <label>
        Acceptance criteria <span className="muted">(one per line)</span>
        <textarea value={draft.acceptance} rows={3} onChange={(event) => set('acceptance', event.target.value)} />
      </label>
      <label>
        Relevant files <span className="muted">(project-relative, one per line)</span>
        <textarea value={draft.files} rows={2} onChange={(event) => set('files', event.target.value)} />
      </label>
      <label>
        Test requirements
        <textarea value={draft.testRequirements} rows={2} maxLength={4000} onChange={(event) => set('testRequirements', event.target.value)} />
      </label>
      <div className="field">
        <label htmlFor="task-role">Suggested agent role</label>
        <select id="task-role" value={draft.role} onChange={(event) => set('role', ROLES.find((r) => r === event.target.value) ?? '')}>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </select>
        <label htmlFor="task-provider">Suggested provider</label>
        <input id="task-provider" value={draft.provider} maxLength={80} onChange={(event) => set('provider', event.target.value)} />
        <label htmlFor="task-usage">Cost or usage category</label>
        <select id="task-usage" value={draft.usage} onChange={(event) => set('usage', USAGE_CATEGORIES.find((u) => u === event.target.value) ?? '')}>
          {USAGE_CATEGORIES.map((u) => (
            <option key={u} value={u}>
              {USAGE_LABELS[u]}
            </option>
          ))}
        </select>
      </div>
      {withResult && (
        <label>
          Result and verification notes
          <textarea value={draft.resultNotes} rows={3} maxLength={4000} onChange={(event) => set('resultNotes', event.target.value)} />
        </label>
      )}
    </div>
  );
}

export function NewTaskForm({ projectId, planning, onCreated, onClose }: { projectId: string; planning: PlanningApi; onCreated: (task: Task) => void; onClose: () => void }) {
  const [draft, setDraft] = useState<TaskDraft>(emptyDraft());
  const [template, setTemplate] = useState<TemplateId | ''>('');

  const applyTemplate = (id: TemplateId | ''): void => {
    setTemplate(id);
    const t = TASK_TEMPLATES.find((candidate) => candidate.id === id);
    if (t === undefined) return;
    setDraft({ ...draft, category: t.id, subsystem: t.subsystem, complexity: t.complexity, role: t.role, description: draft.description || t.description, acceptance: t.acceptance.join('\n'), testRequirements: t.testRequirements });
  };

  return (
    <section className="card" aria-label="New task">
      <div className="card__head">
        <h2>New task</h2>
      </div>
      <div className="field">
        <label htmlFor="task-template">Start from a template</label>
        <select id="task-template" value={template} onChange={(event) => applyTemplate(TASK_TEMPLATES.find((t) => t.id === event.target.value)?.id ?? '')}>
          <option value="">None</option>
          {TASK_TEMPLATES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
        <span className="muted">Fills the form with a starting point; change anything.</span>
      </div>
      <TaskFieldsForm draft={draft} onChange={setDraft} milestones={planning.milestones} withResult={false} />
      <div className="actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={draft.title.trim() === ''}
          onClick={() =>
            void planning.call(() => window.api.invoke('tasks:create', { projectId, ...fieldsOf(draft), status: 'inbox' })).then((task) => {
              if (task !== undefined) onCreated(task);
            })
          }
        >
          Add to the Inbox
        </button>
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
      </div>
    </section>
  );
}

export function BreakdownForm({ projectId, planning, onClose }: { projectId: string; planning: PlanningApi; onClose: () => void }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [milestoneId, setMilestoneId] = useState<string | null>(null);
  const [steps, setSteps] = useState('');
  const [chain, setChain] = useState(true);
  const [choice, setChoice] = useState<ProviderChoice | undefined>();
  const [suggesting, setSuggesting] = useState(false);
  const [suggestion, setSuggestion] = useState('');
  const [suggestError, setSuggestError] = useState('');
  const suggest = (): void => {
    if (choice === undefined) return;
    setSuggesting(true);
    setSuggestion('');
    setSuggestError('');
    void window.api.invoke('providers:suggestSteps', { projectId, choice, title, description }).then((result) => {
      setSuggesting(false);
      if (!result.ok) {
        setSuggestError(`${result.error.message} ${result.error.hint ?? ''}`.trim());
        return;
      }
      if (!result.value.sent) {
        setSuggestion('Nothing was sent.');
        return;
      }
      const text = result.value.steps.map((step) => (step.acceptance.length === 0 ? step.title : `${step.title} :: ${step.acceptance.join(' | ')}`)).join('\n');
      setSteps((current) => (current.trim() === '' ? text : `${current.trimEnd()}\n${text}`));
      setSuggestion(`${result.value.steps.length} steps suggested. Review and edit them below; no task has been created.`);
    });
  };
  const parsed = lines(steps).map((line) => {
    const [stepTitle = '', criteria = ''] = line.split('::');
    return { title: stepTitle.trim(), acceptance: criteria.split('|').map((c) => c.trim()).filter(Boolean) };
  });
  return (
    <section className="card" aria-label="Break a feature down">
      <div className="card__head">
        <h2>Break a feature down</h2>
      </div>
      <p className="muted">
        Describe the feature, then list the small steps, one per line. Add acceptance criteria after <span className="mono">::</span>, separated by <span className="mono">|</span>. You get a parent
        task and one task per step.
      </p>
      <div className="form">
        <label>
          Feature
          <input value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <label>
          What should it do?
          <textarea value={description} rows={3} onChange={(event) => setDescription(event.target.value)} />
        </label>
        <div className="field">
          <label htmlFor="breakdown-milestone">Milestone</label>
          <MilestoneSelect id="breakdown-milestone" milestones={planning.milestones} value={milestoneId} onChange={setMilestoneId} />
        </div>
        <details>
          <summary>Suggest steps with AI (optional)</summary>
          <p className="muted">You choose the provider. Only the feature name and description above are sent, never project files. A cloud provider asks you first.</p>
          <ProviderPicker idPrefix="breakdown" onChange={setChoice} />
          <div className="actions">
            <button type="button" className="btn" disabled={choice === undefined || title.trim() === '' || suggesting} onClick={suggest}>
              {suggesting ? 'Asking…' : 'Suggest steps'}
            </button>
            {suggesting && (
              <button type="button" className="btn" onClick={() => void window.api.invoke('providers:cancel', {})}>
                Stop
              </button>
            )}
          </div>
          {suggestion !== '' && <p role="status">{suggestion}</p>}
          {suggestError !== '' && <p role="alert">{suggestError}</p>}
        </details>
        <label>
          Steps <span className="muted">(one per line)</span>
          <textarea value={steps} rows={6} placeholder={'Add the crouch input :: C toggles crouch | works with a controller\nLower the camera'} onChange={(event) => setSteps(event.target.value)} />
        </label>
        <label>
          <input type="checkbox" checked={chain} onChange={(event) => setChain(event.target.checked)} /> Each step waits for the one before it
        </label>
      </div>
      <div className="actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={title.trim() === '' || parsed.length === 0}
          onClick={() =>
            void planning.call(() => window.api.invoke('tasks:breakdown', { projectId, title, description, milestoneId, steps: parsed, chain })).then((made) => {
              if (made !== undefined) onClose();
            })
          }
        >
          Create {parsed.length === 0 ? 'the tasks' : `${parsed.length + 1} tasks`}
        </button>
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
      </div>
    </section>
  );
}
