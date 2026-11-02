import { useCallback, useEffect, useState } from 'react';
import type { IpcResult, SerializedError } from '@shared/errors';
import { SCOPE_ABOUT, SCOPE_LABELS, type CommandResult, type PermissionsView } from '@shared/permissions';
import { formatTime } from '../../lib/activity';
import { useProjects } from '../../lib/projects';

/**
 * Permissions and approved commands of the selected project (spec §14). The page only asks: every grant and every approval is
 * made by the person in a native window in the main process, and nothing here can grant anything by itself.
 */
export function PermissionsPanel() {
  const { selected } = useProjects();
  const projectId = selected?.id;
  const [view, setView] = useState<PermissionsView | undefined>();
  const [problem, setProblem] = useState<SerializedError | undefined>();
  const [ran, setRan] = useState<{ label: string; result: CommandResult } | undefined>();
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((n) => n + 1), []);

  useEffect(() => window.api.on('activity:appended', (event) => (event.kind.startsWith('permission.') || event.kind.startsWith('command.')) && reload()), [reload]);

  useEffect(() => {
    if (projectId === undefined) return;
    let cancelled = false;
    void window.api.invoke('permissions:view', { projectId }).then((result) => {
      if (cancelled) return;
      if (result.ok) setView(result.value);
      else setProblem(result.error);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, version]);

  if (selected === undefined || projectId === undefined) return null;

  const act = async <T,>(work: Promise<IpcResult<T>>): Promise<T | undefined> => {
    const result = await work;
    if (!result.ok) {
      setProblem(result.error);
      return undefined;
    }
    setProblem(undefined);
    reload();
    return result.value;
  };
  const active = (view?.grants ?? []).filter((g) => g.revokedAt === null);

  return (
    <section aria-label="Permissions" className="stack" data-feature="permissions">
      <h2>Permissions · {selected.name}</h2>
      <p className="muted">
        Everything starts read-only. Each permission below is granted only by you, in a separate window; an agent or this page cannot grant itself one. You can take any of them back at once.
      </p>
      {problem !== undefined && (
        <p role="alert">
          {problem.message} {problem.hint}
        </p>
      )}

      <div className="card">
        <div className="card__head">
          <h3>{SCOPE_LABELS['project-writes']}</h3>
          <button type="button" className="btn" onClick={() => void act(window.api.invoke('permissions:request', { projectId, scope: 'project-writes' }))}>
            Allow for this project…
          </button>
        </div>
        <p className="muted">{SCOPE_ABOUT['project-writes']} You can also allow it for a single task from the task&apos;s Agent work section.</p>
        {active.length === 0 ? (
          <p className="empty">Not allowed. Agents can only read this project.</p>
        ) : (
          <ul className="rows" aria-label="Active permissions">
            {active.map((grant) => (
              <li key={grant.id}>
                <strong>{grant.taskTitle === null ? 'Whole project' : `Task: ${grant.taskTitle}`}</strong>{' '}
                <span className="muted">
                  · since {formatTime(grant.grantedAt)} · {grant.where}
                </span>{' '}
                <button type="button" className="btn" aria-label={`Take back the permission for ${grant.taskTitle ?? 'the whole project'}`} onClick={() => void act(window.api.invoke('permissions:revoke', { id: grant.id }))}>
                  Take back
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card">
        <div className="card__head">
          <h3>Approved commands</h3>
        </div>
        <p className="muted">
          Commands found in this project. You approve each one yourself; only approved commands can be run from here, and a command whose script changed since you approved it will not run until you approve it again. Agents get no
          command access.
        </p>
        {view?.commandsNote !== undefined && view.commandsNote !== '' && <p className="empty">{view.commandsNote}</p>}
        <ul className="rows" aria-label="Project commands">
          {(view?.commands ?? []).map((command) => (
            <li key={command.label}>
              <strong className="mono">{command.label}</strong>
              {command.source === 'engine' && <span className="badge"> engine command</span>}
              {command.writes && <span className="badge" data-severity="warning"> writes files in the project</span>}
              {command.risks.length > 0 && <span className="badge" data-severity="warning"> looks destructive</span>}
              <div className="muted mono">{command.body === '' ? '(empty script)' : command.body}</div>
              {command.risks.length > 0 && <div role="note">{command.risks.join('; ')}.</div>}
              {command.approval === null ? (
                <button type="button" className="btn" aria-label={`Approve ${command.label}`} onClick={() => void act(window.api.invoke('commands:approve', { projectId, label: command.label }))}>
                  Approve…
                </button>
              ) : (
                <>
                  <span className="muted">Approved {formatTime(command.approval.approvedAt)}. </span>
                  {command.approval.changed ? (
                    <>
                      <span role="note">The script changed since then, so it will not run. </span>
                      <button type="button" className="btn" aria-label={`Approve ${command.label} again`} onClick={() => void act(window.api.invoke('commands:approve', { projectId, label: command.label }))}>
                        Approve again…
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="btn"
                      aria-label={`Run ${command.label}`}
                      onClick={() =>
                        void act(window.api.invoke('commands:run', { id: command.approval?.id ?? '' })).then((result) => {
                          if (result?.ran === true) setRan({ label: command.label, result });
                        })
                      }
                    >
                      Run
                    </button>
                  )}{' '}
                  <button type="button" className="btn" aria-label={`Take back the approval of ${command.label}`} onClick={() => void act(window.api.invoke('commands:revoke', { id: command.approval?.id ?? '' }))}>
                    Take back
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
        {ran !== undefined && (
          <div aria-label="Command output">
            <h4>
              {ran.label} · {ran.result.status === 'exited' ? `exit code ${ran.result.exitCode ?? '?'}` : ran.result.status}
            </h4>
            <pre className="pre">{ran.result.output === '' ? '(no output)' : ran.result.output}</pre>
            {ran.result.truncated && <p className="muted">Only the end of the output is shown.</p>}
          </div>
        )}
      </div>

      <div className="card">
        <div className="card__head">
          <h3>What you approved</h3>
        </div>
        {(view?.approvals ?? []).length === 0 ? (
          <p className="empty">Nothing approved yet.</p>
        ) : (
          <table className="table" aria-label="Approvals">
            <thead>
              <tr>
                <th>When</th>
                <th>What</th>
                <th>Where</th>
              </tr>
            </thead>
            <tbody>
              {(view?.approvals ?? []).map((approval) => (
                <tr key={approval.id}>
                  <td>{formatTime(approval.at)}</td>
                  <td>
                    {approval.what}
                    <div className="muted">{SCOPE_LABELS[approval.scope]}</div>
                  </td>
                  <td className="mono">{approval.where}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
