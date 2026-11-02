import { useCallback, useEffect, useState } from 'react';
import type { IpcResult, SerializedError } from '@shared/errors';
import { CAPABILITY_LABELS, type OpenTarget, type UnrealView } from '@shared/unreal';
import { useNav } from '../../app/navigation';
import { formatTime } from '../../lib/activity';
import { useProjects } from '../../lib/projects';
import { BlenderPanel } from '../blender/BlenderPanel';
import { BackroomsProfile } from './BackroomsProfile';

const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const OPEN_LABELS = { source: 'Source', config: 'Config', content: 'Content', plugins: 'Plugins', logs: 'Saved/Logs' } as const;

interface RunLog {
  id: string;
  label: string;
  startedAt: string;
  endedAt: string | null;
  status: string;
  exitCode: number | null;
}

/** Engine integrations (spec §16): Unreal Engine 5 for the selected project, the engines installed on this PC, and the optional game profile. */
export function EnginesPanel() {
  const { selected } = useProjects();
  const { go } = useNav();
  const [view, setView] = useState<UnrealView | undefined>();
  const [history, setHistory] = useState<RunLog[]>([]);
  const [log, setLog] = useState<{ label: string; output: string; truncated: boolean } | undefined>();
  const [problem, setProblem] = useState<SerializedError | undefined>();
  const [message, setMessage] = useState('');
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((n) => n + 1), []);
  const projectId = selected?.id;

  useEffect(() => window.api.on('activity:appended', (event) => (event.kind.startsWith('engine.') || event.kind.startsWith('command.')) && reload()), [reload]);
  useEffect(() => {
    if (projectId === undefined) return;
    let cancelled = false;
    void Promise.all([window.api.invoke('engines:view', { projectId }), window.api.invoke('commands:history', { projectId })]).then(([v, h]) => {
      if (cancelled) return;
      if (v.ok) {
        setView(v.value);
        setProblem(undefined);
      } else setProblem(v.error);
      if (h.ok) setHistory(h.value);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, version]);

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
  const open = (target: OpenTarget): void => {
    if (projectId !== undefined) void act(window.api.invoke('engines:open', { projectId, target })).then((r) => r?.opened === true && setMessage(target === 'project' ? 'Handed to Windows. The editor now runs on its own.' : ''));
  };

  const project = view?.project ?? null;
  return (
    <section className="stack" aria-label="Engines" data-feature="engines">
      <h2>Engines</h2>
      {problem !== undefined && (
        <p role="alert">
          {problem.message} {problem.hint}
        </p>
      )}
      {message !== '' && <p role="status">{message}</p>}

      <section className="card" aria-label="Unreal Engine">
        <div className="card__head">
          <h3>Unreal Engine</h3>
          <button type="button" className="btn" onClick={() => void act(window.api.invoke('engines:addPath', {}))}>
            Add an engine folder…
          </button>
        </div>
        <p className="muted">
          Engines come from the Epic Games Launcher&apos;s list, source builds registered in Windows, and folders you add. A folder counts only if it has the engine&apos;s version file; an incomplete install is
          said to be incomplete.
        </p>
        {view !== undefined && view.engines.length === 0 && <p className="empty">No Unreal Engine was found on this PC.</p>}
        {view !== undefined && view.engines.length > 0 && (
          <table className="table" aria-label="Installed engines">
            <thead>
              <tr>
                <th>Engine</th>
                <th>Version</th>
                <th>Found through</th>
                <th>Folder</th>
              </tr>
            </thead>
            <tbody>
              {view.engines.map((e) => (
                <tr key={e.path}>
                  <td>
                    {e.id}
                    {!e.complete && <span className="badge" data-severity="warning"> incomplete</span>}
                    {e.note !== '' && <div className="muted">{e.note}</div>}
                  </td>
                  <td>{e.version ?? 'unknown'}</td>
                  <td>{e.source === 'launcher' ? 'Epic launcher' : e.source === 'registry' ? 'Windows registry' : e.source === 'configured' ? 'Added by you' : 'Default folder'}</td>
                  <td className="mono">{e.path}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {view !== undefined && view.configuredPaths.length > 0 && (
          <ul className="rows" aria-label="Engine folders you added">
            {view.configuredPaths.map((path, index) => (
              <li key={path}>
                <span className="mono">{path}</span>{' '}
                <button type="button" className="btn" aria-label={`Remove the engine folder ${path} from the list`} onClick={() => void act(window.api.invoke('engines:removePath', { index }))}>
                  Remove from list
                </button>
              </li>
            ))}
          </ul>
        )}

        {selected === undefined && <p className="empty">Select a project to see its Unreal details.</p>}
        {selected !== undefined && view !== undefined && !view.isUnreal && <p className="empty">{selected.name} has no .uproject at the top of its folder, so it is not an Unreal project.</p>}
        {project !== null && view !== undefined && (
          <div aria-label={`Unreal project ${project.name}`} className="stack">
            <h4>{project.name}</h4>
            <dl className="facts">
              <dt>Project file</dt>
              <dd className="mono">{project.uproject}</dd>
              <dt>Asks for engine</dt>
              <dd>{project.engineAssociation === '' ? '(none named)' : project.engineAssociation}</dd>
              <dt>Engine used</dt>
              <dd>{view.resolved === null ? view.resolveNote : `${view.resolved.id}: ${view.resolved.how}`}</dd>
              <dt>Code</dt>
              <dd>{project.hasSource ? `C++: ${project.targets.map((t) => `${t.name} (${t.type})`).join(', ') || 'no targets found'}` : 'Blueprint-only (no C++ source)'}</dd>
              <dt>Modules</dt>
              <dd>{project.modules.map((m) => m.name).join(', ') || 'none listed'}</dd>
              <dt>Plugins</dt>
              <dd>
                {project.plugins.filter((p) => p.enabled).length} enabled, {project.plugins.filter((p) => !p.enabled).length} disabled
                {project.projectPlugins.length > 0 ? `; in the project: ${project.projectPlugins.join(', ')}` : ''}
              </dd>
              <dt>Default map</dt>
              <dd className="mono">{project.defaultMap ?? 'not set'}</dd>
              <dt>Content</dt>
              <dd>
                {project.content.assets.toLocaleString('en-US')} assets, {mb(project.content.bytes)}
                {project.content.topFolders.length > 0 ? ` (${project.content.topFolders.slice(0, 6).map((f) => `${f.name} ${f.assets}`).join(', ')})` : ''}
                {project.content.truncated ? '; counting stopped early' : ''}
              </dd>
            </dl>
            {project.notes.map((note) => (
              <p key={note} className="muted">
                {note}
              </p>
            ))}
            <div className="actions">
              <button type="button" className="btn btn--primary" onClick={() => open('project')}>
                Open in Unreal Editor…
              </button>
              {(['source', 'config', 'content', 'plugins', 'logs'] as const).map((target) => (
                <button key={target} type="button" className="btn" disabled={target === 'source' ? !project.folders.source : target === 'plugins' ? !project.folders.plugins : false} onClick={() => open(target)}>
                  Open {OPEN_LABELS[target]}
                </button>
              ))}
              <button type="button" className="btn" disabled={view.resolved === null} onClick={() => open('engine')}>
                Open the engine folder
              </button>
            </div>

            <h4>What can be done here</h4>
            <table className="table" aria-label="Capability report">
              <thead>
                <tr>
                  <th>Capability</th>
                  <th>State</th>
                  <th>Why</th>
                </tr>
              </thead>
              <tbody>
                {view.capabilities.map((c) => (
                  <tr key={c.id} data-state={c.state}>
                    <td>{c.label}</td>
                    <td>{CAPABILITY_LABELS[c.state]}</td>
                    <td className="muted">{c.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <h4>Commands</h4>
            {view.commands.length === 0 ? (
              <p className="muted">No build command is offered for this project (see the capability report).</p>
            ) : (
              <>
                <ul className="rows" aria-label="Unreal commands">
                  {view.commands.map((c) => (
                    <li key={c.label}>
                      {c.label} {c.writes && <span className="badge"> writes files in the project</span>}
                    </li>
                  ))}
                </ul>
                <p className="muted">
                  Approve a command before it can run: that is done on the AI Workbench under Permissions, in a window that shows exactly what would run. Agents cannot run these commands.{' '}
                  <button type="button" className="btn" onClick={() => go('workbench')}>
                    Go to Permissions
                  </button>
                </p>
              </>
            )}
            <h4>Earlier command runs</h4>
            {history.length === 0 ? (
              <p className="muted">Nothing has been run yet. The output of every approved command is kept here.</p>
            ) : (
              <ul className="rows" aria-label="Command logs">
                {history.map((h) => (
                  <li key={h.id}>
                    <button
                      type="button"
                      className="btn"
                      aria-label={`Show the log of ${h.label} from ${h.startedAt}`}
                      onClick={() =>
                        void window.api.invoke('commands:log', { id: h.id }).then((r) => {
                          if (r.ok) setLog({ label: r.value.label, output: r.value.output, truncated: r.value.truncated });
                          else setProblem(r.error);
                        })
                      }
                    >
                      Show log
                    </button>{' '}
                    {h.label} <span className="muted">· {formatTime(h.startedAt)} · {h.status === 'exited' ? `exit code ${h.exitCode ?? '?'}` : h.status}</span>
                  </li>
                ))}
              </ul>
            )}
            {log !== undefined && (
              <div aria-label="Command log">
                <h4>{log.label}</h4>
                <pre className="diff">{log.output === '' ? '(no output)' : log.output}</pre>
                {log.truncated && <p className="muted">Only the end of the output is kept.</p>}
              </div>
            )}
          </div>
        )}
      </section>

      <BlenderPanel />

      {selected !== undefined && <BackroomsProfile projectId={selected.id} projectName={selected.name} />}
    </section>
  );
}
