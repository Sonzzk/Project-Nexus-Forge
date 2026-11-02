import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { z } from 'zod';
import { AppError } from '@shared/errors';
import { ASSET_KINDS, ASSET_TYPES, NAMING_ENGINES, type AssetKind, type Brief, type BriefFields, type InspectResult, type TrackedAsset } from '@shared/blender';
import { suggestName } from '@shared/naming';
import type { ActivityLog } from '../../logging';
import type { ProjectRegistry } from '../../projects';
import { resolveInside } from '../../security';
import type { ExportableTable } from '../../storage';
import type { Db } from '../../storage';

// Asset tracking and briefs (spec §16 Blender, §17). These are the person's own notes about files in a project and about what an asset
// must be. Tracking never moves, renames or copies a file; it records the path, kind, size and modification time, so a later look can
// say whether the file changed or went missing. Nothing here claims to make a model: a brief is a written requirement.

const KIND_BY_EXTENSION: [RegExp, AssetKind][] = [
  [/\.(blend|fbx|obj|gltf|glb|usd[acz]?|abc|dae|stl|ply|3ds)$/i, 'model'],
  [/\.(png|jpe?g|tga|exr|hdr|tiff?|bmp|webp|psd|dds|ktx2?)$/i, 'texture'],
  [/\.(wav|ogg|mp3|flac|aiff?)$/i, 'audio'],
  [/\.(anim|bvh)$/i, 'animation'],
  [/\.(umap|unity|tscn|scn)$/i, 'scene'],
  [/\.(py|gd|cs|cpp|h|js|ts)$/i, 'script'],
];
export const assetKindOf = (path: string): AssetKind => KIND_BY_EXTENSION.find(([re]) => re.test(path))?.[1] ?? 'other';

export interface AssetService {
  list(projectId: string): TrackedAsset[];
  track(input: { projectId: string; path: string; note?: string | undefined; tags?: string[] | undefined }): TrackedAsset;
  untrack(id: string): { removed: true };
  briefs(projectId: string): Brief[];
  saveBrief(input: { projectId: string; id?: string | undefined; fields: BriefFields }): Brief;
  removeBrief(id: string): { removed: true };
  /** Markdown notes for importing an asset into an engine, built from the brief, the tracked file and the last inspect of it. */
  handoff(briefId: string): { text: string; basedOnInspect: string | null };
}

interface AssetRow {
  id: string;
  project_id: string;
  rel_path: string;
  kind: AssetKind;
  note: string;
  tags_json: string;
  size_bytes: number;
  mtime_ms: number;
  tracked_at: string;
}
interface BriefRow {
  id: string;
  project_id: string;
  name: string;
  asset_type: BriefFields['assetType'];
  engine: BriefFields['engine'];
  purpose: string;
  scale: string;
  formats: string;
  textures: string;
  performance: string;
  integration: string;
  notes: string;
  task_id: string | null;
  asset_id: string | null;
  created_at: string;
  updated_at: string;
}

const briefFrom = (r: BriefRow): Brief => ({ id: r.id, name: r.name, assetType: r.asset_type, engine: r.engine, purpose: r.purpose, scale: r.scale, formats: r.formats, textures: r.textures, performance: r.performance, integration: r.integration, notes: r.notes, taskId: r.task_id, assetId: r.asset_id, createdAt: r.created_at, updatedAt: r.updated_at });

export function createAssetService(options: { db: Db; projects: ProjectRegistry; activity: ActivityLog; now?: () => Date }): AssetService {
  const { db, projects, activity } = options;
  const now = options.now ?? (() => new Date());
  const projectOf = (id: string) => {
    const found = projects.get(id);
    if (found === undefined) throw new AppError('NOT_FOUND', 'That project is not in the registry.', { hint: 'It may have been removed. Reload the project list.' });
    return found;
  };
  const statusOf = (root: string, row: AssetRow): TrackedAsset['status'] => {
    try {
      const stats = lstatSync(resolveInside(root, row.rel_path));
      return stats.size === row.size_bytes && Math.floor(stats.mtimeMs) === row.mtime_ms ? 'unchanged' : 'changed';
    } catch {
      return 'missing';
    }
  };
  const assetFrom = (root: string, r: AssetRow): TrackedAsset => ({ id: r.id, path: r.rel_path, kind: r.kind, note: r.note, tags: JSON.parse(r.tags_json) as string[], trackedAt: r.tracked_at, status: statusOf(root, r) });

  return {
    list(projectId) {
      const root = projectOf(projectId).rootPath;
      return db.all<AssetRow>('SELECT * FROM tracked_assets WHERE project_id = ? ORDER BY rel_path', projectId).map((r) => assetFrom(root, r));
    },

    track({ projectId, path, note = '', tags = [] }) {
      const project = projectOf(projectId);
      const full = resolveInside(project.rootPath, path);
      let stats;
      try {
        stats = lstatSync(full);
      } catch {
        throw new AppError('NOT_FOUND', 'That file does not exist in the project.', { hint: 'Choose a file that is listed for the project.' });
      }
      if (!stats.isFile()) throw new AppError('INVALID_INPUT', 'Only a file can be tracked, not a folder.');
      const rel = path.replace(/\\/g, '/');
      const cleanTags = [...new Set(tags.map((t) => t.trim().slice(0, 40)).filter(Boolean))].slice(0, 20);
      const existing = db.get<{ id: string }>('SELECT id FROM tracked_assets WHERE project_id = ? AND rel_path = ?', projectId, rel);
      const id = existing?.id ?? randomUUID();
      db.run(
        `INSERT INTO tracked_assets (id, project_id, rel_path, kind, note, tags_json, size_bytes, mtime_ms, tracked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, rel_path) DO UPDATE SET note = excluded.note, tags_json = excluded.tags_json, size_bytes = excluded.size_bytes, mtime_ms = excluded.mtime_ms`,
        id, projectId, rel, assetKindOf(rel), note.slice(0, 500), JSON.stringify(cleanTags), stats.size, Math.floor(stats.mtimeMs), now().toISOString(),
      );
      if (existing === undefined) activity.record({ kind: 'asset.tracked', severity: 'info', summary: `You started tracking ${rel} in "${project.name}".`, projectId });
      return assetFrom(project.rootPath, db.get<AssetRow>('SELECT * FROM tracked_assets WHERE id = ?', id) as AssetRow);
    },

    untrack(id) {
      const row = db.get<AssetRow>('SELECT * FROM tracked_assets WHERE id = ?', id);
      if (row === undefined) throw new AppError('NOT_FOUND', 'That asset is not tracked.');
      db.run('DELETE FROM tracked_assets WHERE id = ?', id); // the file itself is never touched
      activity.record({ kind: 'asset.untracked', severity: 'info', summary: `You stopped tracking ${row.rel_path}. The file was not changed.`, projectId: row.project_id });
      return { removed: true };
    },

    briefs(projectId) {
      projectOf(projectId);
      return db.all<BriefRow>('SELECT * FROM asset_briefs WHERE project_id = ? ORDER BY updated_at DESC, id', projectId).map(briefFrom);
    },

    saveBrief({ projectId, id, fields }) {
      projectOf(projectId);
      if (fields.assetId !== null && db.get('SELECT 1 FROM tracked_assets WHERE id = ? AND project_id = ?', fields.assetId, projectId) === undefined) throw new AppError('INVALID_INPUT', 'That tracked asset does not belong to this project.');
      if (fields.taskId !== null && db.get('SELECT 1 FROM tasks WHERE id = ? AND project_id = ?', fields.taskId, projectId) === undefined) throw new AppError('INVALID_INPUT', 'That task does not belong to this project.');
      const at = now().toISOString();
      const values = [fields.name, fields.assetType, fields.engine, fields.purpose, fields.scale, fields.formats, fields.textures, fields.performance, fields.integration, fields.notes, fields.taskId, fields.assetId] as const;
      if (id === undefined) {
        const made = randomUUID();
        db.run('INSERT INTO asset_briefs (id, project_id, name, asset_type, engine, purpose, scale, formats, textures, performance, integration, notes, task_id, asset_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', made, projectId, ...values, at, at);
        return briefFrom(db.get<BriefRow>('SELECT * FROM asset_briefs WHERE id = ?', made) as BriefRow);
      }
      const changed = db.run('UPDATE asset_briefs SET name = ?, asset_type = ?, engine = ?, purpose = ?, scale = ?, formats = ?, textures = ?, performance = ?, integration = ?, notes = ?, task_id = ?, asset_id = ?, updated_at = ? WHERE id = ? AND project_id = ?', ...values, at, id, projectId).changes;
      if (changed === 0) throw new AppError('NOT_FOUND', 'That brief does not exist.');
      return briefFrom(db.get<BriefRow>('SELECT * FROM asset_briefs WHERE id = ?', id) as BriefRow);
    },

    removeBrief(id) {
      if (db.run('DELETE FROM asset_briefs WHERE id = ?', id).changes === 0) throw new AppError('NOT_FOUND', 'That brief does not exist.');
      return { removed: true };
    },

    handoff(briefId) {
      const row = db.get<BriefRow>('SELECT * FROM asset_briefs WHERE id = ?', briefId);
      if (row === undefined) throw new AppError('NOT_FOUND', 'That brief does not exist.');
      const brief = briefFrom(row);
      const asset = brief.assetId === null ? undefined : db.get<AssetRow>('SELECT * FROM tracked_assets WHERE id = ?', brief.assetId);
      const run = asset === undefined ? undefined : db.get<{ id: string; started_at: string; result_json: string }>("SELECT id, started_at, result_json FROM blender_runs WHERE project_id = ? AND kind = 'inspect' AND outcome = 'passed' AND source_rel = ? AND result_json IS NOT NULL ORDER BY started_at DESC LIMIT 1", row.project_id, asset.rel_path);
      const scene = run === undefined ? undefined : (JSON.parse(run.result_json) as InspectResult);
      const line = (label: string, value: string): string => (value.trim() === '' ? `- ${label}: not specified in the brief` : `- ${label}: ${value.trim()}`);
      const lines = [
        `# Import handoff: ${brief.name}`,
        '',
        `Target engine: ${brief.engine}. Asset type: ${brief.assetType}. Suggested name: \`${suggestName(brief.engine, brief.assetType, brief.name)}\``,
        '',
        '## What it is for',
        brief.purpose.trim() === '' ? 'Not specified in the brief.' : brief.purpose.trim(),
        '',
        '## Requirements (from the brief)',
        line('Scale', brief.scale),
        line('Formats', brief.formats),
        line('Textures', brief.textures),
        line('Performance', brief.performance),
        line('Engine integration', brief.integration),
        '',
        '## Source file',
        asset === undefined ? 'No Blender file is linked to this brief.' : `- ${asset.rel_path} (tracked ${asset.tracked_at.slice(0, 10)}; ${asset.size_bytes.toLocaleString('en-US')} bytes)`,
      ];
      if (scene !== undefined && run !== undefined)
        lines.push(
          '',
          `## What the last inspect found (${run.started_at.slice(0, 10)}, Blender ${scene.blender})`,
          `- ${scene.objects} objects (${Object.entries(scene.objectTypes).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(', ') || 'none'}), ${scene.meshes} meshes, ${scene.triangles.toLocaleString('en-US')} triangles before modifiers`,
          `- ${scene.materials} materials, ${scene.images} images, ${scene.armatures} armatures, ${scene.actions} actions`,
          `- Units: ${scene.unitSystem}, scale ${scene.unitScale}`,
          scene.missingFiles.length === 0 ? '- No missing external files.' : `- Missing external files (fix before export): ${scene.missingFiles.map((m) => m.path).join(', ')}`,
          scene.libraries.length === 0 ? '- No linked libraries.' : `- Linked libraries (their content must be available when exporting): ${scene.libraries.join(', ')}`,
        );
      else if (asset !== undefined) lines.push('', '## What the last inspect found', 'No inspect has been run on this file yet. Run "Inspect" on it first to fill this in.');
      lines.push(
        '',
        '## Checklist before and after export',
        '- In Blender: check the unit scale and apply object transforms. The FBX exporter (`export_scene.fbx`) has its own scale options (`global_scale`, `apply_unit_scale`, `apply_scale_options`) and axis handling (`bake_space_transform`); confirm what the target engine expects.',
        '- Export to a folder of its own, not over the previous export.',
        '- In the engine: import into the folder named under "Engine integration", then check scale, orientation, materials, collision and the triangle budget against this brief.',
        brief.engine === 'unreal' ? '- Unreal assets (`.uasset`, `.umap`) are binary: change them in the editor, never as text files.' : '- Keep the exported file next to a note of the Blender version and export settings used.',
        '',
        'This note was written from your brief and the facts above. The export settings are a checklist to verify in the engine; the app does not run the export or import.',
      );
      return { text: lines.join('\n'), basedOnInspect: run?.id ?? null };
    },
  };
}

const isoText = z.iso.datetime();
const id = z.string().min(1).max(64);
const safeRel = (p: unknown): boolean => typeof p === 'string' && p.length > 0 && p.length <= 400 && !/^([a-zA-Z]:|[\\/])/.test(p) && !p.split(/[\\/]/).includes('..') && !p.includes('\0');

export const assetTables: ExportableTable[] = [
  {
    id: 'tracked_assets',
    label: 'Tracked assets',
    schema: z.strictObject({ id, project_id: id, rel_path: z.string().min(1).max(400), kind: z.enum(ASSET_KINDS), note: z.string().max(500), tags_json: z.string().max(2000), size_bytes: z.number().int().nonnegative(), mtime_ms: z.number().int().nonnegative(), tracked_at: isoText }),
    key: ['id'],
    unique: [['project_id', 'rel_path']],
    parents: [{ column: 'project_id', table: 'projects', parentColumn: 'id' }],
    check: (row) => (safeRel(row['rel_path']) ? undefined : 'the path is not a project-relative path'),
    orderBy: 'rel_path, id',
  },
  {
    id: 'asset_briefs',
    label: 'Asset briefs',
    schema: z.strictObject({
      id,
      project_id: id,
      name: z.string().min(1).max(120),
      asset_type: z.enum(ASSET_TYPES),
      engine: z.enum(NAMING_ENGINES),
      purpose: z.string().max(2000),
      scale: z.string().max(500),
      formats: z.string().max(500),
      textures: z.string().max(1000),
      performance: z.string().max(1000),
      integration: z.string().max(2000),
      notes: z.string().max(4000),
      task_id: id.nullable(),
      asset_id: id.nullable(),
      created_at: isoText,
      updated_at: isoText,
    }),
    key: ['id'],
    parents: [
      { column: 'project_id', table: 'projects', parentColumn: 'id' },
      { column: 'task_id', table: 'tasks', parentColumn: 'id' },
      { column: 'asset_id', table: 'tracked_assets', parentColumn: 'id' },
    ],
    orderBy: 'created_at, id',
  },
];
