import { useCallback, useEffect, useState } from 'react';
import type { IpcResult, SerializedError } from '@shared/errors';
import type { GodotView } from '@shared/godot';
import { CAPABILITY_LABELS } from '@shared/unreal';
import { useNav } from '../../app/navigation';
import { formatTime } from '../../lib/activity';
import { useProjects } from '../../lib/projects';

type History = { id: string; label: string; startedAt: string; status: string; exitCode: number | null }[];

/** Godot for the selected project (spec §16): downloads, project facts, the editor this app owns, and the approved commands. */
export function GodotPanel() {
  const { selected } = useProjects();
  const { go } = useNav();
  const [view, setView] = useState<GodotView | undefined>();
  const [history, setHistory] = useState<History>([]);
  const [log, setLog] = useState<{ label: string; output: string; truncated: boolean } | undefined>();
  const [problem, setProblem] = useState<SerializedError | undefined>();
  const [message, setMessage] = useState('');
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((n) => n + 1), []);
  const projectId = selected?.id;

  useEffect(() => window.api.on('activity:appended', (event) => (event.kind.startsWith('godot.') || event.kind.startsWith('command.')) && reload()), [reload]);
  useEffect(() => {
    if (projectId === undefined) return;
    let cancelled = false;
    void window.api.invoke('godot:view', { projectId }).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setView(result.value);
        setProblem(undefined);
      } else setProblem(result.error);
    });
    void window.api.invoke('commands:history', { projectId }).then((result) => {
      if (!cancelled && result.ok) setHistory((result.value as History).filter((h) => h.label.startsWith('Godot:')));
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
  if (selected === undefined || projectId === undefined) return null;
  const project = view?.project ?? null;

  return (
    <section className="card" aria-label="Godot" data-feature="godot">
      <div className="card__head">
        <h3>Godot</h3>
        <button type="button" className="btn" onClick={() => void act(window.api.invoke('godot:addPath', {}))}>
          Add a Godot folder…
        </button>
      </div>
      <p className="muted">
        Godot has no installer, so add the folder where you unzipped it. Commands use only what the project holds (its export presets and test framework) and run only after you approve them. A live run on this PC is not claimed unless the log shows one.
      </p>
      {problem !== undefined && (
        <p role="alert">
          {problem.message} {problem.hint}
        </p>
      )}
      {message !== '' && <p role="status">{message}</p>}
      {view !== undefined && view.installs.length === 0 && <p className="empty">No Godot download was found. Add the folder that contains Godot_v….exe.</p>}
      {view !== undefined && view.installs.length > 0 && (
        <table className="table" aria-label="Godot downloads">
          <thead>
            <tr>
              <th>Version</th>
              <th>Found through</th>
              <th>Folder</th>
            </tr>
          </thead>
          <tbody>
            {view.installs.map((i) => (
              <tr key={`${i.folder}|${i.exe ?? i.consoleExe ?? ''}`}>
                <td>
                  {i.version ?? 'unknown'}
                  {i.release !== null && i.release !== 'stable' ? ` ${i.release}` : ''}
                  {i.mono ? ' (.NET)' : ''}
                  {i.note !== '' && <div className="muted">{i.note}</div>}
                </td>
                <td>{i.source === 'configured' ? 'Added by you' : i.source === 'path' ? 'PATH' : 'Default folder'}</td>
                <td className="mono">{i.folder}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {view !== undefined && view.configuredPaths.length > 0 && (
        <ul className="rows" aria-label="Godot folders you added">
          {view.configuredPaths.map((path, index) => (
            <li key={path}>
              <span className="mono">{path}</span>{' '}
              <button type="button" className="btn" aria-label={`Remove the Godot folder ${path} from the list`} onClick={() => void act(window.api.invoke('godot:removePath', { index }))}>
                Remove from list
              </button>
            </li>
          ))}
        </ul>
      )}

      {view !== undefined && !view.isGodot && <p className="empty">{selected.name} has no readable project.godot at the top of its folder, so it is not a Godot project.</p>}
      {project !== null && view !== undefined && (
        <div aria-label={`Godot project ${project.name}`} className="stack">
          <h4>{project.name}</h4>
          <dl className="facts">
            <dt>Asks for</dt>
            <dd>
              Godot {project.engineVersion ?? '(version not stated)'}
              {project.csharp ? ' with C#' : ''}
              {project.renderer === null ? '' : `, ${project.renderer}`}
            </dd>
            <dt>Download used</dt>
            <dd>{view.resolved === null ? view.resolveNote : `${view.resolved.version ?? 'unknown version'}: ${view.resolved.how}`}</dd>
            <dt>Main scene</dt>
            <dd className="mono">{project.mainScene ?? 'not set'}</dd>
            <dt>Autoloads</dt>
            <dd>{project.autoloads.map((a) => a.name).join(', ') || 'none'}</dd>
            <dt>Add-ons</dt>
            <dd>{project.addons.map((a) => `${a.name}${a.version === '' ? '' : ` ${a.version}`}`).join(', ') || 'none'}</dd>
            <dt>Files</dt>
            <dd>
              {project.scripts.gdscript} GDScript, {project.scripts.csharp} C#, {project.scripts.scenes} scenes, {project.scripts.resources} resources
              {project.scripts.truncated ? '; counting stopped early' : ''}
            </dd>
            <dt>Classes</dt>
            <dd>{project.scripts.classes.slice(0, 12).map((c) => c.name).join(', ') || 'no class_name scripts'}</dd>
            <dt>Tests</dt>
            <dd>{project.tests.framework === null ? 'No test framework found' : `${project.tests.framework === 'gut' ? 'GUT' : 'GdUnit4'}${project.tests.directory === null ? '' : ` in ${project.tests.directory}`}`}</dd>
          </dl>
          {project.presets.length > 0 && (
            <table className="table" aria-label="Export presets">
              <thead>
                <tr>
                  <th>Preset</th>
                  <th>Platform</th>
                  <th>Export path</th>
                  <th>Command</th>
                </tr>
              </thead>
              <tbody>
                {project.presets.map((p) => (
                  <tr key={p.name}>
                    <td>{p.name}</td>
                    <td>{p.platform}</td>
                    <td className="mono">{p.exportPath === '' ? '(none)' : p.exportPath}</td>
                    <td className="muted">{p.skipped === '' ? 'Offered' : p.skipped}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {project.notes.map((note) => (
            <p key={note} className="muted">
              {note}
            </p>
          ))}
          <div className="actions">
            {!view.editor.running && (
              <button
                type="button"
                className="btn btn--primary"
                onClick={() =>
                  void act(window.api.invoke('godot:launchEditor', { projectId })).then((r) => {
                    if (r !== undefined) setMessage(r.started ? 'The Godot editor was started. This app owns it and closes it at quit.' : 'The editor was not started.');
                  })
                }
              >
                Start the Godot editor…
              </button>
            )}
            {view.editor.running && (
              <button
                type="button"
                className="btn"
                onClick={() =>
                  void act(window.api.invoke('godot:stopEditor', { projectId })).then((r) => {
                    if (r !== undefined) setMessage(r.stopped ? 'The editor was asked to stop.' : 'The editor was not running.');
                  })
                }
              >
                Stop the Godot editor
              </button>
            )}
            <button type="button" className="btn" onClick={() => void act(window.api.invoke('godot:open', { projectId, target: 'project' }))}>
              Open the project folder
            </button>
            <button type="button" className="btn" disabled={project.addons.length === 0} onClick={() => void act(window.api.invoke('godot:open', { projectId, target: 'addons' }))}>
              Open the add-ons folder
            </button>
          </div>
          {view.editor.running && <p className="muted">The editor is running (started {formatTime(view.editor.startedAt ?? '')}).</p>}

          <h4>What can be done here</h4>
          <table className="table" aria-label="Godot capability report">
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
            <p className="muted">No Godot command is offered for this project (see the capability report).</p>
          ) : (
            <>
              <ul className="rows" aria-label="Godot commands">
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
          <h4>Earlier Godot command runs</h4>
          {history.length === 0 ? (
            <p className="muted">Nothing has been run yet. The output of every approved command is kept here.</p>
          ) : (
            <ul className="rows" aria-label="Godot command logs">
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
            <div aria-label="Godot command log">
              <h4>{log.label}</h4>
              <pre className="diff">{log.output === '' ? '(no output)' : log.output}</pre>
              {log.truncated && <p className="muted">Only the end of the output is kept.</p>}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
