import { useCallback, useEffect, useState } from 'react';
import type { BlenderRunDetail, BlenderView } from '@shared/blender';
import type { IpcResult, SerializedError } from '@shared/errors';
import { CAPABILITY_LABELS } from '@shared/unreal';
import { useProjects } from '../../lib/projects';
import { formatTime } from '../../lib/activity';
import { AssetsPanel } from './AssetsPanel';

const mb = (bytes: number): string => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const OUTCOME_TEXT = { passed: 'Passed', failed: 'Failed', inconclusive: 'Inconclusive' } as const;

/** Blender for the selected project (spec §16): installs, scenes, headless runs on copies, approved scripts, and the asset pages. */
export function BlenderPanel() {
  const { selected } = useProjects();
  const [view, setView] = useState<BlenderView | undefined>();
  const [detail, setDetail] = useState<BlenderRunDetail | undefined>();
  const [problem, setProblem] = useState<SerializedError | undefined>();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState<string | undefined>();
  const [target, setTarget] = useState<Record<string, string>>({});
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((n) => n + 1), []);
  const projectId = selected?.id;

  useEffect(() => window.api.on('activity:appended', (event) => event.kind.startsWith('blender.') && reload()), [reload]);
  useEffect(() => {
    if (projectId === undefined) return;
    let cancelled = false;
    void window.api.invoke('blender:view', { projectId }).then((result) => {
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

  const act = async <T,>(label: string, work: Promise<IpcResult<T>>): Promise<T | undefined> => {
    setBusy(label);
    const result = await work;
    setBusy(undefined);
    if (!result.ok) {
      setProblem(result.error);
      return undefined;
    }
    setProblem(undefined);
    reload();
    return result.value;
  };
  if (selected === undefined || projectId === undefined) return null;

  const run = async (label: string, work: Promise<IpcResult<BlenderRunDetail>>): Promise<void> => {
    const result = await act(label, work);
    if (result !== undefined) {
      setDetail(result);
      setMessage(`${OUTCOME_TEXT[result.outcome]}: ${label}.`);
    }
  };

  return (
    <section className="card" aria-label="Blender" data-feature="blender">
      <div className="card__head">
        <h3>Blender</h3>
        <button type="button" className="btn" onClick={() => void act('add', window.api.invoke('blender:addPath', {}))}>
          Add a Blender folder…
        </button>
      </div>
      <p className="muted">
        Blender is started only by this app, in the background, on a <strong>copy</strong> of a scene in the app&apos;s own data folder. Your .blend files are never opened for writing, and every run records whether the original is unchanged.
      </p>
      {problem !== undefined && (
        <p role="alert">
          {problem.message} {problem.hint}
        </p>
      )}
      {message !== '' && <p role="status">{message}</p>}
      {view !== undefined && view.installs.length === 0 && <p className="empty">No Blender installation was found. Install Blender, or add the folder that contains blender.exe.</p>}
      {view !== undefined && view.installs.length > 0 && (
        <table className="table" aria-label="Blender installations">
          <thead>
            <tr>
              <th>Version</th>
              <th>Found through</th>
              <th>Folder</th>
            </tr>
          </thead>
          <tbody>
            {view.installs.map((i) => (
              <tr key={i.folder}>
                <td>
                  {i.version ?? 'unknown'}
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
        <ul className="rows" aria-label="Blender folders you added">
          {view.configuredPaths.map((path, index) => (
            <li key={path}>
              <span className="mono">{path}</span>{' '}
              <button type="button" className="btn" aria-label={`Remove the Blender folder ${path} from the list`} onClick={() => void act('remove', window.api.invoke('blender:removePath', { index }))}>
                Remove from list
              </button>
            </li>
          ))}
        </ul>
      )}

      {view !== undefined && !view.hasBlend && <p className="empty">{selected.name} has no .blend file.</p>}
      {view !== undefined && view.hasBlend && (
        <>
          <h4>Scenes in {selected.name}</h4>
          <table className="table" aria-label="Blender scenes">
            <thead>
              <tr>
                <th>File</th>
                <th>Size</th>
                <th>Saved by</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {view.files.map((f) => (
                <tr key={f.path}>
                  <td className="mono">
                    {f.path}
                    {f.backups > 0 && <div className="muted">{f.backups} backup file{f.backups === 1 ? '' : 's'} beside it (.blend1)</div>}
                  </td>
                  <td>{mb(f.bytes)}</td>
                  <td>
                    {f.version === null ? 'unknown' : `Blender ${f.version}`}
                    {f.format === 'compressed' && <span className="muted"> · compressed</span>}
                    {f.newerThanInstalled && <div role="note">Saved by a newer Blender than any installed one.</div>}
                  </td>
                  <td>
                    <div className="actions">
                      <button type="button" className="btn" aria-label={`Open ${f.path} in Blender`} onClick={() => void act('open', window.api.invoke('blender:open', { projectId, relativePath: f.path })).then((r) => r?.opened === true && setMessage('Handed to Windows. Blender now runs on its own.'))}>
                        Open…
                      </button>
                      <button type="button" className="btn" disabled={busy !== undefined || view.installs.length === 0} aria-label={`Inspect ${f.path}`} onClick={() => void run(`inspect ${f.path}`, window.api.invoke('blender:inspect', { projectId, relativePath: f.path }))}>
                        {busy === `inspect ${f.path}` ? 'Inspecting…' : 'Inspect'}
                      </button>
                      {f.tracked ? (
                        <span className="muted">Tracked</span>
                      ) : (
                        <button type="button" className="btn" aria-label={`Track ${f.path}`} onClick={() => void act('track', window.api.invoke('assets:track', { projectId, relativePath: f.path }))}>
                          Track
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {view.truncated && <p className="muted">The folder is large, so only the first part was searched.</p>}
        </>
      )}

      {view !== undefined && view.scripts.length > 0 && (
        <>
          <h4>Blender scripts in this project</h4>
          <p className="muted">Python files that import bpy. A script runs only after you approve its exact text, always on a copy of the scene you choose. Agents cannot run them.</p>
          <ul className="rows" aria-label="Blender scripts">
            {view.scripts.map((s) => (
              <li key={s.path}>
                <strong className="mono">{s.path}</strong> <span className="muted">· {s.bytes} bytes · {s.hash}</span>
                {s.changed && <div role="note">The script changed since you approved it, so it will not run.</div>}
                <div className="actions">
                  <button type="button" className="btn" aria-label={s.approved || s.changed ? `Approve ${s.path} again` : `Approve ${s.path}`} onClick={() => void act('approve', window.api.invoke('blender:approveScript', { projectId, scriptPath: s.path }))}>
                    {s.approved ? 'Review and approve again…' : s.changed ? 'Approve again…' : 'Approve…'}
                  </button>
                  {s.approved && s.approvalId !== null && (
                    <>
                      <label>
                        <span className="muted">On a copy of </span>
                        <select aria-label={`Scene to run ${s.path} on`} value={target[s.path] ?? view.files[0]?.path ?? ''} onChange={(event) => setTarget({ ...target, [s.path]: event.target.value })}>
                          {view.files.map((f) => (
                            <option key={f.path} value={f.path}>
                              {f.path}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button type="button" className="btn btn--primary" disabled={busy !== undefined || view.installs.length === 0} aria-label={`Run ${s.path}`} onClick={() => void run(`run ${s.path}`, window.api.invoke('blender:runApproved', { projectId, scriptPath: s.path, relativePath: target[s.path] ?? view.files[0]?.path ?? '' }))}>
                        {busy === `run ${s.path}` ? 'Running…' : 'Run'}
                      </button>
                      <button type="button" className="btn" aria-label={`Take back the approval of ${s.path}`} onClick={() => void act('revoke', window.api.invoke('blender:revokeScript', { id: s.approvalId ?? '' }))}>
                        Take back
                      </button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {view !== undefined && (
        <>
          <h4>Runs</h4>
          {view.runs.length === 0 ? (
            <p className="muted">Nothing has been run yet. Every run is recorded here with its output and whether the original was left alone.</p>
          ) : (
            <ul className="rows" aria-label="Blender runs">
              {view.runs.map((r) => (
                <li key={r.id}>
                  <button type="button" className="btn" aria-label={`Show details of the run on ${r.source} from ${r.startedAt}`} onClick={() => void act('details', window.api.invoke('blender:run', { id: r.id })).then((d) => d !== undefined && setDetail(d))}>
                    Details
                  </button>{' '}
                  <span className="badge" data-outcome={r.outcome}>
                    {OUTCOME_TEXT[r.outcome]}
                  </span>{' '}
                  {r.kind === 'inspect' ? 'Inspect' : `Script ${r.script ?? ''}`} · <span className="mono">{r.source}</span> <span className="muted">· {formatTime(r.startedAt)}</span>
                  {!r.originalUnchanged && <div role="alert">The original file is different after this run. Check it.</div>}
                  {r.errorSummary !== '' && <div className="muted">{r.errorSummary}</div>}
                </li>
              ))}
            </ul>
          )}
          {detail !== undefined && (
            <div aria-label="Run details" className="stack">
              <h4>
                {detail.kind === 'inspect' ? 'Inspect' : `Script ${detail.script ?? ''}`} · {OUTCOME_TEXT[detail.outcome]}
              </h4>
              <dl className="facts">
                <dt>Original file</dt>
                <dd>{detail.originalUnchanged ? 'Unchanged (same size, time and content as before the run)' : 'DIFFERENT after the run'}</dd>
                <dt>Blender</dt>
                <dd>{detail.blenderVersion ?? 'unknown'} · exit code {detail.exitCode ?? 'none'} · {detail.status}</dd>
              </dl>
              {detail.result !== null && (
                <dl className="facts" aria-label="Scene facts">
                  <dt>Objects</dt>
                  <dd>
                    {detail.result.objects} ({Object.entries(detail.result.objectTypes).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(', ') || 'none'})
                  </dd>
                  <dt>Geometry</dt>
                  <dd>
                    {detail.result.meshes} meshes, {detail.result.triangles.toLocaleString('en-US')} triangles before modifiers
                  </dd>
                  <dt>Materials and images</dt>
                  <dd>
                    {detail.result.materials} materials, {detail.result.images} images
                  </dd>
                  <dt>Units</dt>
                  <dd>
                    {detail.result.unitSystem}, scale {detail.result.unitScale}
                  </dd>
                  <dt>Missing files</dt>
                  <dd>{detail.result.missingFiles.length === 0 ? 'None' : detail.result.missingFiles.map((m) => `${m.kind} ${m.path}`).join(', ')}</dd>
                </dl>
              )}
              {detail.outputs.length > 0 && (
                <>
                  <h5>Files this run left in the app&apos;s data folder</h5>
                  <ul className="rows" aria-label="Run output files">
                    {detail.outputs.map((o) => (
                      <li key={o.path}>
                        <span className="mono">{o.path}</span> <span className="muted">· {mb(o.bytes)}</span>
                      </li>
                    ))}
                  </ul>
                  <button type="button" className="btn" onClick={() => void act('reveal', window.api.invoke('blender:revealRun', { id: detail.id }))}>
                    Open the run folder
                  </button>
                  <p className="muted">Nothing is copied into your project. Move what you want yourself.</p>
                </>
              )}
              {detail.errorSummary !== '' && <p role="note">{detail.errorSummary}</p>}
              <pre className="diff">{detail.log === '' ? '(no output)' : detail.log}</pre>
              {detail.truncated && <p className="muted">Only the end of the output is kept.</p>}
            </div>
          )}

          <h4>What can be done here</h4>
          <table className="table" aria-label="Blender capability report">
            <thead>
              <tr>
                <th>Capability</th>
                <th>State</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              {view.capabilities.map((c) => (
                <tr key={c.id}>
                  <td>{c.label}</td>
                  <td>{CAPABILITY_LABELS[c.state]}</td>
                  <td className="muted">{c.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <AssetsPanel projectId={projectId} assets={view.assets} onChanged={reload} />
        </>
      )}
    </section>
  );
}
