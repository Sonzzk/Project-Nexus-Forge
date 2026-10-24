import { useEffect, useState } from 'react';
import { WORKFLOWS, RUN_STATE_LABELS, FINAL_RUN_STATES, type AgentRoleId, type AgentRun, type WorkflowId, type WorkflowPreview } from '@shared/agents';
import { AGENT_ROLE_IDS } from '@shared/agents';
import type { SerializedError } from '@shared/errors';
import { featureById, stateLabel } from '@shared/feature-status';
import { ROLE_LABELS, type Task } from '@shared/tasks';
import { formatTime } from '../../lib/activity';

type RoleInfo = { id: AgentRoleId; label: string; purpose: string; expectedOutput: string; writeCapable: boolean };

/**
 * Agent work for one task (spec §11): the roles and what each may do, a workflow shown with its actions and providers
 * before anything exists, queued run records, and a prompt preview. Nothing here runs an agent; that arrives in Steps 12 and 13.
 */
export function AgentsPanel({ task }: { task: Task }) {
  const [roles, setRoles] = useState<RoleInfo[]>([]);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [version, setVersion] = useState(0);
  const [workflow, setWorkflow] = useState<WorkflowId>('implement');
  const [includeReviewer, setIncludeReviewer] = useState(false);
  const [includeQa, setIncludeQa] = useState(false);
  const [plan, setPlan] = useState<WorkflowPreview | undefined>();
  const [promptRole, setPromptRole] = useState<AgentRoleId>(AGENT_ROLE_IDS.find((r) => r === task.role) ?? 'planner');
  const [prompt, setPrompt] = useState<{ text: string; note: string } | undefined>();
  const [error, setError] = useState<SerializedError | undefined>();
  const launch = featureById('action.run-agent');

  useEffect(() => {
    let cancelled = false;
    void Promise.all([window.api.invoke('agents:roles', {}), window.api.invoke('agents:runs', { taskId: task.id })]).then(([r, s]) => {
      if (cancelled) return;
      if (r.ok) setRoles(r.value);
      if (s.ok) setRuns(s.value);
    });
    return () => {
      cancelled = true;
    };
  }, [task.id, version]);

  const request = { taskId: task.id, workflow, includeReviewer, includeQa };
  const role = roles.find((r) => r.id === promptRole);
  const reload = (): void => setVersion((n) => n + 1);
  const fail = (e: SerializedError): void => setError(e);

  return (
    <section aria-label="Agent work for this task">
      <h3>Agent work</h3>
      <p className="muted">
        Roles and workflows are planned and recorded here. Running an agent arrives in Step 13, so nothing below starts a program or sends anything to a
        provider.
      </p>
      {error !== undefined && (
        <p role="alert">
          {error.message} {error.hint}
        </p>
      )}

      <div className="field">
        <label htmlFor="agent-role">Role</label>
        <select
          id="agent-role"
          value={promptRole}
          onChange={(event) => {
            setPromptRole(AGENT_ROLE_IDS.find((r) => r === event.target.value) ?? 'planner');
            setPrompt(undefined);
          }}
        >
          {AGENT_ROLE_IDS.map((id) => (
            <option key={id} value={id}>
              {ROLE_LABELS[id]}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn"
          onClick={() =>
            void window.api.invoke('agents:prompt', { taskId: task.id, role: promptRole }).then((result) => {
              if (result.ok) {
                setError(undefined);
                setPrompt({ text: result.value.prompt, note: result.value.note });
              } else fail(result.error);
            })
          }
        >
          Preview the prompt
        </button>
      </div>
      {role !== undefined && (
        <p>
          <span className="badge" data-write={role.writeCapable}>
            {role.writeCapable ? 'Can change project files' : 'Read-only'}
          </span>{' '}
          {role.purpose} <span className="muted">Returns: {role.expectedOutput}</span>
        </p>
      )}
      {prompt !== undefined && (
        <>
          <pre className="diff" aria-label="Prompt preview">
            {prompt.text}
          </pre>
          <p className="muted">{prompt.note}</p>
        </>
      )}

      <h3>Workflow</h3>
      <div className="field">
        <label htmlFor="agent-workflow">Template</label>
        <select
          id="agent-workflow"
          value={workflow}
          onChange={(event) => {
            setWorkflow(WORKFLOWS.find((w) => w.id === event.target.value)?.id ?? 'implement');
            setPlan(undefined);
          }}
        >
          {WORKFLOWS.map((w) => (
            <option key={w.id} value={w.id}>
              {w.label}
            </option>
          ))}
        </select>
        {workflow === 'implement' && (
          <>
            <label>
              <input type="checkbox" checked={includeReviewer} onChange={(event) => {
                setIncludeReviewer(event.target.checked);
                setPlan(undefined);
              }} /> Also ask a reviewer
            </label>
            <label>
              <input type="checkbox" checked={includeQa} onChange={(event) => {
                setIncludeQa(event.target.checked);
                setPlan(undefined);
              }} /> Also run QA
            </label>
          </>
        )}
      </div>
      <p className="muted">{WORKFLOWS.find((w) => w.id === workflow)?.description}</p>
      <div className="actions">
        <button
          type="button"
          className="btn"
          onClick={() =>
            void window.api.invoke('agents:preview', request).then((result) => {
              if (result.ok) {
                setError(undefined);
                setPlan(result.value);
              } else fail(result.error);
            })
          }
        >
          Show the plan
        </button>
        <button
          type="button"
          className="btn"
          disabled={plan === undefined}
          onClick={() =>
            void window.api.invoke('agents:queue', request).then((result) => {
              if (result.ok) {
                setError(undefined);
                setPlan(undefined);
                reload();
              } else fail(result.error);
            })
          }
        >
          Save as queued runs
        </button>
        <button type="button" className="btn" disabled title="Running agents is not built yet">
          Run the workflow · {launch === undefined ? 'Upcoming' : (stateLabel(launch) ?? 'Upcoming')}
        </button>
      </div>
      {plan !== undefined && (
        <ol className="rows" aria-label="Workflow plan">
          {plan.steps.map((step, index) => (
            <li key={`${step.kind}-${step.role ?? index}`} data-included={step.included}>
              <strong>{step.kind === 'approval' ? 'You approve the plan' : step.roleLabel}</strong>{' '}
              {step.optional && <span className="badge">{step.included ? 'Optional · included' : 'Optional · off'}</span>}{' '}
              {step.kind === 'agent' && <span className="badge">{step.writeCapable ? 'Writes files' : 'Read-only'}</span>}
              <div className="muted">{step.action}</div>
              {step.kind === 'agent' && (
                <div className="muted">
                  Provider: {step.provider === '' ? 'not chosen yet (name one on the task; real providers are on the Integrations page)' : step.provider}
                  {step.usage !== '' && ` · usage: ${step.usage}`}
                </div>
              )}
              {step.included && step.blockedBy !== '' && <div role="note">Blocked: {step.blockedBy}</div>}
            </li>
          ))}
        </ol>
      )}

      <h3>Runs for this task</h3>
      {runs.length === 0 && <p className="empty">No runs recorded for this task.</p>}
      <ul className="rows" aria-label="Runs">
        {runs.map((run) => (
          <li key={run.id} className="backup-row">
            <span>
              <strong>{ROLE_LABELS[run.role]}</strong> <span className="muted">· {run.writeCapable ? 'writes files' : 'read-only'}{run.providerId === '' ? '' : ` · ${run.providerId}`} · {formatTime(run.createdAt)}</span>
              {run.note !== '' && <div className="muted">{run.note}</div>}
            </span>
            <span className="badge" data-state={run.state}>
              {RUN_STATE_LABELS[run.state]}
            </span>
            {FINAL_RUN_STATES.includes(run.state) ? (
              <span />
            ) : (
              <span className="actions">
                {(['completed', 'failed', 'cancelled'] as const).map((outcome) => (
                  <button
                    key={outcome}
                    type="button"
                    className="btn"
                    aria-label={`Record ${ROLE_LABELS[run.role]} run as ${outcome}`}
                    onClick={() =>
                      void window.api.invoke('agents:record', { runId: run.id, outcome, note: '' }).then((result) => {
                        if (result.ok) {
                          setError(undefined);
                          reload();
                        } else fail(result.error);
                      })
                    }
                  >
                    {outcome === 'completed' ? 'Done by hand' : outcome === 'failed' ? 'Failed' : 'Cancel'}
                  </button>
                ))}
              </span>
            )}
            <span />
          </li>
        ))}
      </ul>
    </section>
  );
}
