import { useEffect, useState } from 'react';
import { ASSET_TYPES, NAMING_ENGINES, type AssetType, type Brief, type BriefFields, type NamingEngine, type TrackedAsset } from '@shared/blender';
import type { SerializedError } from '@shared/errors';
import { checkName, suggestName } from '@shared/naming';

const STATUS_TEXT = { unchanged: 'Unchanged', changed: 'Changed since tracked', missing: 'Missing' } as const;
const TYPE_LABEL: Record<AssetType, string> = { 'static-mesh': 'Static mesh', 'skeletal-mesh': 'Skeletal mesh', texture: 'Texture', material: 'Material', 'material-instance': 'Material instance', animation: 'Animation', blueprint: 'Blueprint', other: 'Other' };
const ENGINE_LABEL: Record<NamingEngine, string> = { unreal: 'Unreal Engine', godot: 'Godot', unity: 'Unity', generic: 'Any (snake_case)' };

const EMPTY: BriefFields = { name: '', assetType: 'static-mesh', engine: 'unreal', purpose: '', scale: '', formats: '', textures: '', performance: '', integration: '', notes: '', taskId: null, assetId: null };

/** Tracked asset files, asset briefs with a naming check, and import handoff notes (spec §17). Nothing here moves or renames a file. */
export function AssetsPanel({ projectId, assets, onChanged }: { projectId: string; assets: TrackedAsset[]; onChanged: () => void }) {
  const [briefs, setBriefs] = useState<Brief[]>([]);
  const [draft, setDraft] = useState<BriefFields>(EMPTY);
  const [editing, setEditing] = useState<string | undefined>();
  const [handoff, setHandoff] = useState<{ title: string; text: string; basedOnInspect: boolean } | undefined>();
  const [problem, setProblem] = useState<SerializedError | undefined>();
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void window.api.invoke('briefs:list', { projectId }).then((result) => {
      if (!cancelled && result.ok) setBriefs(result.value);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, version]);

  const set = <K extends keyof BriefFields>(key: K, value: BriefFields[K]): void => setDraft({ ...draft, [key]: value });
  const save = (): void => {
    void window.api.invoke('briefs:save', { projectId, ...(editing === undefined ? {} : { id: editing }), fields: draft }).then((result) => {
      if (!result.ok) {
        setProblem(result.error);
        return;
      }
      setProblem(undefined);
      setDraft(EMPTY);
      setEditing(undefined);
      setVersion((n) => n + 1);
    });
  };
  const naming = draft.name.trim() === '' ? undefined : checkName(draft.engine, draft.assetType, suggestName(draft.engine, draft.assetType, draft.name), draft.name);

  return (
    <section className="stack" aria-label="Assets and briefs" data-feature="assets">
      <h4>Tracked asset files</h4>
      {assets.length === 0 ? (
        <p className="muted">No file is tracked yet. Track a scene from the list above. Tracking records the path, size and time so you can see when it changes; it never moves, renames or copies the file.</p>
      ) : (
        <ul className="rows" aria-label="Tracked assets">
          {assets.map((a) => (
            <li key={a.id}>
              <span className="mono">{a.path}</span> <span className="muted">· {a.kind}</span> <span className="badge" data-status={a.status}>{STATUS_TEXT[a.status]}</span>{' '}
              <button type="button" className="btn" aria-label={`Stop tracking ${a.path}`} onClick={() => void window.api.invoke('assets:untrack', { id: a.id }).then(onChanged)}>
                Stop tracking
              </button>
            </li>
          ))}
        </ul>
      )}

      <h4>Asset briefs</h4>
      {problem !== undefined && (
        <p role="alert">
          {problem.message} {problem.hint}
        </p>
      )}
      <div className="form" aria-label={editing === undefined ? 'New asset brief' : 'Edit asset brief'}>
        <label>
          Asset name
          <input value={draft.name} maxLength={120} onChange={(event) => set('name', event.target.value)} />
        </label>
        <div className="field">
          <label htmlFor="brief-type">Type</label>
          <select id="brief-type" value={draft.assetType} onChange={(event) => set('assetType', ASSET_TYPES.find((t) => t === event.target.value) ?? 'other')}>
            {ASSET_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </select>
          <label htmlFor="brief-engine">Target engine</label>
          <select id="brief-engine" value={draft.engine} onChange={(event) => set('engine', NAMING_ENGINES.find((t) => t === event.target.value) ?? 'generic')}>
            {NAMING_ENGINES.map((t) => (
              <option key={t} value={t}>
                {ENGINE_LABEL[t]}
              </option>
            ))}
          </select>
          <label htmlFor="brief-asset">Source file</label>
          <select id="brief-asset" value={draft.assetId ?? ''} onChange={(event) => set('assetId', event.target.value === '' ? null : event.target.value)}>
            <option value="">None</option>
            {assets.map((a) => (
              <option key={a.id} value={a.id}>
                {a.path}
              </option>
            ))}
          </select>
        </div>
        {naming !== undefined && (
          <p aria-label="Naming check" className={naming.problems.length > 0 ? '' : 'muted'}>
            Suggested name: <code>{naming.suggestion}</code>. {naming.rule}
          </p>
        )}
        {(
          [
            ['purpose', 'What it is for'],
            ['scale', 'Scale'],
            ['formats', 'File formats'],
            ['textures', 'Texture needs'],
            ['performance', 'Performance limits'],
            ['integration', 'Engine integration'],
            ['notes', 'Notes'],
          ] as const
        ).map(([key, label]) => (
          <label key={key}>
            {label}
            <textarea rows={2} value={draft[key]} onChange={(event) => set(key, event.target.value)} />
          </label>
        ))}
        <div className="actions">
          <button type="button" className="btn btn--primary" disabled={draft.name.trim() === ''} onClick={save}>
            {editing === undefined ? 'Save brief' : 'Save changes'}
          </button>
          {editing !== undefined && (
            <button
              type="button"
              className="btn"
              onClick={() => {
                setDraft(EMPTY);
                setEditing(undefined);
              }}
            >
              Cancel
            </button>
          )}
        </div>
        <p className="muted">A brief is a written requirement. This app does not make 3D models; it keeps what an asset must be so it can be made, checked and imported.</p>
      </div>
      {briefs.length > 0 && (
        <ul className="rows" aria-label="Asset briefs">
          {briefs.map((b) => (
            <li key={b.id}>
              <strong>{b.name}</strong> <span className="muted">· {TYPE_LABEL[b.assetType]} · {ENGINE_LABEL[b.engine]}</span>
              <div className="actions">
                <button type="button" className="btn" aria-label={`Edit the brief ${b.name}`} onClick={() => {
                    setEditing(b.id);
                    setDraft({ name: b.name, assetType: b.assetType, engine: b.engine, purpose: b.purpose, scale: b.scale, formats: b.formats, textures: b.textures, performance: b.performance, integration: b.integration, notes: b.notes, taskId: b.taskId, assetId: b.assetId });
                  }}>
                  Edit
                </button>
                <button type="button" className="btn" aria-label={`Write import notes for ${b.name}`} onClick={() => void window.api.invoke('briefs:handoff', { id: b.id }).then((r) => r.ok && setHandoff({ title: b.name, text: r.value.text, basedOnInspect: r.value.basedOnInspect !== null }))}>
                  Import notes
                </button>
                <button type="button" className="btn" aria-label={`Delete the brief ${b.name}`} onClick={() => void window.api.invoke('briefs:remove', { id: b.id }).then(() => setVersion((n) => n + 1))}>
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {handoff !== undefined && (
        <div aria-label="Import handoff notes">
          <h5>Import notes: {handoff.title}</h5>
          <textarea readOnly rows={14} value={handoff.text} aria-label="Handoff text" />
          <div className="actions">
            <button type="button" className="btn" onClick={() => void navigator.clipboard.writeText(handoff.text)}>
              Copy
            </button>
            <button type="button" className="btn" onClick={() => setHandoff(undefined)}>
              Close
            </button>
          </div>
          {!handoff.basedOnInspect && <p className="muted">These notes are from the brief only. Inspect the linked scene to add what it contains.</p>}
        </div>
      )}
    </section>
  );
}
