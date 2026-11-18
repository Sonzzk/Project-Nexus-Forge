import { useCallback, useEffect, useState } from 'react';
import type { IpcResult, SerializedError } from '@shared/errors';
import { CAPABILITY_LABELS } from '@shared/unreal';
import type { WebView } from '@shared/web';
import { useNav } from '../../app/navigation';
import { formatTime } from '../../lib/activity';
import { useProjects } from '../../lib/projects';

const KIND_TEXT = { dev: 'Dev server', preview: 'Preview server', build: 'Build', lint: 'Lint', typecheck: 'Type-check', test: 'Test', other: 'Other' } as const;

/** Vite and web projects (spec §16): package manager, scripts, dependencies, and the servers this app owns and can stop. */
export function WebPanel() {
  const { selected } = useProjects();
  const { go } = useNav();
  const [view, setView] = useState<WebView | undefined>();
  const [problem, setProblem] = useState<SerializedError | undefined>();
  const [message, setMessage] = useState('');
  const [showDeps, setShowDeps] = useState(false);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((n) => n + 1), []);
  const projectId = selected?.id;

  useEffect(() => window.api.on('activity:appended', (event) => (event.kind.startsWith('web.') || event.kind.startsWith('command.')) && reload()), [reload]);
  useEffect(() => {
    if (projectId === undefined) return;
    let cancelled = false;
    void window.api.invoke('web:view', { projectId }).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setView(result.value);
        setProblem(undefined);
      } else setProblem(result.error);
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
  const running = view?.servers.filter((s) => s.status === 'running') ?? [];

  return (
    <section className="card" aria-label="Web and Vite" data-feature="web">
      <div className="card__head">
        <h3>Web and Vite</h3>
        <button type="button" className="btn" onClick={reload}>
          Refresh
        </button>
      </div>
      <p className="muted">
        Scripts come from package.json and run only after you approve each one (AI Workbench, Permissions). A dev or preview server is started here, owned by this app, and ended when you stop it or quit. This app never installs, adds or upgrades packages on its own.
      </p>
      {problem !== undefined && (
        <p role="alert">
          {problem.message} {problem.hint}
        </p>
      )}
      {message !== '' && <p role="status">{message}</p>}
      {view !== undefined && !view.isWeb && <p className="empty">{selected.name} has no readable package.json at the top of its folder, so it is not a web project.</p>}
      {project !== null && view !== undefined && (
        <div aria-label={`Web project ${project.name}`} className="stack">
          <h4>{project.name}</h4>
          <dl className="facts">
            <dt>Package manager</dt>
            <dd>
              {project.packageManager.name}
              {project.packageManager.version === null ? '' : ` ${project.packageManager.version}`} (
              {project.packageManager.source === 'packageManager-field' ? 'named in package.json' : project.packageManager.source === 'lockfile' ? `from ${project.packageManager.lockfile ?? 'the lockfile'}` : 'the default: there is no lockfile'})
            </dd>
            <dt>Vite</dt>
            <dd>
              {project.vite.range === null ? 'Not a dependency' : `${project.vite.range}${project.vite.installed === null ? ' (not installed)' : `, installed ${project.vite.installed}`}`}
              {project.viteConfig === null ? '' : `; config ${project.viteConfig}`}
            </dd>
            <dt>Frameworks</dt>
            <dd>{project.frameworks.join(', ') || 'none recognized'}</dd>
            <dt>Dependencies</dt>
            <dd>
              {project.dependencyCount} listed, {project.nodeModules ? 'installed' : 'not installed'}{' '}
              <button type="button" className="btn" onClick={() => setShowDeps((v) => !v)}>
                {showDeps ? 'Hide the list' : 'Show the list'}
              </button>
            </dd>
          </dl>
          {showDeps && (
            <table className="table" aria-label="Dependencies">
              <thead>
                <tr>
                  <th>Package</th>
                  <th>Range</th>
                  <th>Installed</th>
                </tr>
              </thead>
              <tbody>
                {project.dependencies.map((d) => (
                  <tr key={d.name}>
                    <td>
                      {d.name}
                      {d.dev ? <span className="muted"> (dev)</span> : ''}
                    </td>
                    <td className="mono">{d.range}</td>
                    <td className="mono">{d.installed ?? 'not installed'}</td>
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

          <h4>Scripts</h4>
          {project.scripts.length === 0 ? (
            <p className="muted">package.json has no scripts.</p>
          ) : (
            <table className="table" aria-label="Scripts">
              <thead>
                <tr>
                  <th>Script</th>
                  <th>What it is</th>
                  <th>Text</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {project.scripts.map((s) => {
                  const live = running.find((server) => server.label === s.label);
                  return (
                    <tr key={s.label}>
                      <td className="mono">{s.label}</td>
                      <td>{KIND_TEXT[s.kind]}</td>
                      <td className="mono muted">{s.body}</td>
                      <td>
                        {!s.longRunning && <span className="muted">{s.approved ? 'Approved: run it under Permissions' : 'Approve it under Permissions to run it'}</span>}
                        {s.longRunning && live !== undefined && <span className="muted">Running</span>}
                        {s.longRunning && live === undefined && !s.approved && (
                          <button type="button" className="btn" aria-label={`Approve ${s.label}`} onClick={() => void act(window.api.invoke('commands:approve', { projectId, label: s.label }))}>
                            {s.changed ? 'Approve again…' : 'Approve…'}
                          </button>
                        )}
                        {s.longRunning && live === undefined && s.approved && (
                          <button
                            type="button"
                            className="btn btn--primary"
                            aria-label={`Start ${s.label}`}
                            onClick={() =>
                              void act(window.api.invoke('web:startServer', { projectId, label: s.label })).then((r) => {
                                if (r !== undefined) setMessage(r.started ? `${s.label} was started. This app owns it and ends it at quit.` : 'It was not started.');
                              })
                            }
                          >
                            Start the server
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {view.extraCommands.length > 0 && (
            <p className="muted">
              {view.extraCommands.map((c) => c.label).join('; ')} is also offered: it is approved under Permissions like the scripts.{' '}
              <button type="button" className="btn" onClick={() => go('workbench')}>
                Go to Permissions
              </button>
            </p>
          )}

          <h4>Servers</h4>
          {view.servers.length === 0 ? (
            <p className="muted">No server has been started in this session.</p>
          ) : (
            <ul className="rows" aria-label="Servers">
              {view.servers.map((s) => (
                <li key={s.id}>
                  <strong className="mono">{s.label}</strong>{' '}
                  <span className="badge" data-severity={s.status === 'failed' ? 'warning' : undefined}>
                    {s.status === 'running' ? 'running' : s.status === 'stopped' ? 'stopped' : `failed${s.exitCode === null ? '' : ` (exit code ${s.exitCode})`}`}
                  </span>{' '}
                  <span className="muted">
                    started {formatTime(s.startedAt)}
                    {s.port === null ? (s.status === 'running' ? '; no port printed yet' : '') : `; port ${s.port}`}
                  </span>
                  <div className="actions">
                    {s.status === 'running' && (
                      <button type="button" className="btn" aria-label={`Stop ${s.label}`} onClick={() => void act(window.api.invoke('web:stopServer', { serverId: s.id })).then((r) => r !== undefined && setMessage(r.stopped ? 'The server was stopped.' : 'It was not running.'))}>
                        Stop
                      </button>
                    )}
                    {s.url !== null && (
                      <button type="button" className="btn" aria-label={`Open ${s.url} in your browser`} onClick={() => void act(window.api.invoke('web:openServer', { serverId: s.id }))}>
                        Open {s.url}
                      </button>
                    )}
                  </div>
                  {s.output !== '' && (
                    <details>
                      <summary>Output</summary>
                      <pre className="diff">{s.output}</pre>
                    </details>
                  )}
                </li>
              ))}
            </ul>
          )}

          <h4>What can be done here</h4>
          <table className="table" aria-label="Web capability report">
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
        </div>
      )}
    </section>
  );
}
