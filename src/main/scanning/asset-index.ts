import { AppError } from '@shared/errors';
import { ASSET_CATEGORIES, TAG_LIMITS, previewTypeOf, type AnnotateRequest, type AssetCategory, type AssetItem, type AssetSearchRequest, type AssetSearchResult, type CheckReport, type ScanSummary } from '@shared/assets';
import type { TrackedAsset } from '@shared/blender';
import type { ActivityLog } from '../logging';
import type { ProjectRegistry } from '../projects';
import type { Db } from '../storage';
import { checkAssets, namingEngineOf } from './asset-checks';
import { scanAssetFiles } from './asset-scan';

// The asset index (spec §17): what a project's game content is called, where it is, how big it is and when it changed, found by walking
// the folder and kept in the app's database (metadata only, never content). On top of it the person's own annotations (tags, notes,
// source, usage and the tasks that need a file) are kept with the tracked assets of Step 19, so they survive a rescan. A rescan is
// incremental: only added, changed and removed files are written, and a scan that hit its limit removes nothing.

export interface AssetIndexOptions {
  db: Db;
  projects: ProjectRegistry;
  activity: ActivityLog;
  /** The tracked-asset store of Step 19: it checks the file exists inside the project and records its size and time. */
  tracking: { track(input: { projectId: string; path: string; note?: string | undefined; tags?: string[] | undefined }): TrackedAsset };
  limits: () => { maxEntries: number; budgetMs: number };
  now?: () => Date;
}

export interface AssetIndex {
  scan(projectId: string): ScanSummary;
  search(request: AssetSearchRequest): AssetSearchResult;
  annotate(request: AnnotateRequest): AssetItem;
  checks(projectId: string): CheckReport;
  /** Files of the index as (path, category) in path order, for checks and for the register. */
  files(projectId: string): { path: string; category: AssetCategory; bytes: number; mtimeMs: number }[];
  lastScan(projectId: string): ScanSummary | null;
}

interface IndexRow {
  rel_path: string;
  category: AssetCategory;
  ext: string;
  size_bytes: number;
  mtime_ms: number;
}
interface SearchRow extends IndexRow {
  aid: string | null;
  note: string | null;
  tags_json: string | null;
  tsize: number | null;
  tmtime: number | null;
  source: string | null;
  usage: string | null;
}
interface ScanRow {
  scanned_at: string;
  entries: number;
  files: number;
  added: number;
  changed: number;
  removed: number;
  unchanged: number;
  truncated: number;
  duration_ms: number;
}

const likeEscape = (text: string): string => text.replace(/[\\%_]/g, (c) => `\\${c}`);
const scanFrom = (r: ScanRow): ScanSummary => ({ scannedAt: r.scanned_at, entries: r.entries, files: r.files, added: r.added, changed: r.changed, removed: r.removed, unchanged: r.unchanged, truncated: r.truncated === 1, durationMs: r.duration_ms });

export function createAssetIndex(options: AssetIndexOptions): AssetIndex {
  const { db, projects, activity, tracking } = options;
  const now = options.now ?? (() => new Date());
  const projectOf = (id: string) => {
    const found = projects.get(id);
    if (found === undefined) throw new AppError('NOT_FOUND', 'That project is not in the registry.', { hint: 'It may have been removed. Reload the project list.' });
    return found;
  };
  const lastScan = (projectId: string): ScanSummary | null => {
    const row = db.get<ScanRow>('SELECT * FROM asset_scans WHERE project_id = ?', projectId);
    return row === undefined ? null : scanFrom(row);
  };

  const itemFrom = (projectId: string, r: SearchRow, taskIds: string[]): AssetItem => ({
    path: r.rel_path,
    category: r.category,
    extension: r.ext,
    bytes: r.size_bytes,
    modifiedAt: new Date(r.mtime_ms).toISOString(),
    previewable: previewTypeOf(r.rel_path) !== undefined,
    annotation:
      r.aid === null
        ? null
        : { id: r.aid, note: r.note ?? '', tags: JSON.parse(r.tags_json ?? '[]') as string[], source: r.source ?? '', usage: r.usage ?? '', taskIds, status: r.tsize === r.size_bytes && r.tmtime === r.mtime_ms ? 'unchanged' : 'changed' },
  });

  function search(request: AssetSearchRequest): AssetSearchResult {
    const projectId = request.projectId;
    projectOf(projectId);
    const category = request.category ?? null;
    const limit = Math.min(200, Math.max(1, request.limit ?? 60));
    const offset = Math.max(0, request.offset ?? 0);
    const where: string[] = ['i.project_id = ?'];
    const params: (string | number)[] = [projectId];
    if (category !== null) {
      where.push('i.category = ?');
      params.push(category);
    }
    for (const term of (request.query ?? '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6)) {
      const like = `%${likeEscape(term)}%`;
      where.push("(lower(i.rel_path) LIKE ? ESCAPE '\\' OR lower(t.note) LIKE ? ESCAPE '\\' OR lower(t.tags_json) LIKE ? ESCAPE '\\' OR lower(d.source) LIKE ? ESCAPE '\\' OR lower(d.usage) LIKE ? ESCAPE '\\')");
      params.push(like, like, like, like, like);
    }
    const tag = (request.tag ?? '').trim().toLowerCase();
    if (tag !== '') {
      where.push("lower(t.tags_json) LIKE ? ESCAPE '\\'");
      params.push(`%"${likeEscape(tag)}"%`); // tags are stored as a JSON list, so a quoted tag matches whole tags only
    }
    if ((request.taskId ?? null) !== null) {
      where.push('EXISTS (SELECT 1 FROM asset_task_refs r WHERE r.asset_id = t.id AND r.task_id = ?)');
      params.push(request.taskId ?? '');
    }
    if (request.annotatedOnly === true) where.push('t.id IS NOT NULL');
    const from = 'FROM asset_index i LEFT JOIN tracked_assets t ON t.project_id = i.project_id AND t.rel_path = i.rel_path LEFT JOIN asset_details d ON d.asset_id = t.id';
    const total = db.get<{ n: number }>(`SELECT COUNT(*) AS n ${from} WHERE ${where.join(' AND ')}`, ...params)?.n ?? 0;
    const rows = db.all<SearchRow>(
      `SELECT i.rel_path, i.category, i.ext, i.size_bytes, i.mtime_ms, t.id AS aid, t.note, t.tags_json, t.size_bytes AS tsize, t.mtime_ms AS tmtime, d.source, d.usage ${from} WHERE ${where.join(' AND ')} ORDER BY i.rel_path LIMIT ? OFFSET ?`,
      ...params,
      limit,
      offset,
    );
    const refs = new Map<string, string[]>();
    for (const row of rows)
      if (row.aid !== null) refs.set(row.aid, db.all<{ task_id: string }>('SELECT task_id FROM asset_task_refs WHERE asset_id = ? ORDER BY task_id', row.aid).map((r) => r.task_id));
    const counts = Object.fromEntries(ASSET_CATEGORIES.map((c) => [c, 0])) as Record<AssetCategory, number>;
    for (const row of db.all<{ category: AssetCategory; n: number }>('SELECT category, COUNT(*) AS n FROM asset_index WHERE project_id = ? GROUP BY category', projectId)) counts[row.category] = row.n;
    return { items: rows.map((r) => itemFrom(projectId, r, refs.get(r.aid ?? '') ?? [])), total, counts, scan: lastScan(projectId) };
  }

  return {
    lastScan,

    scan(projectId) {
      const project = projectOf(projectId);
      const limits = options.limits();
      const outcome = scanAssetFiles(project.rootPath, { maxEntries: limits.maxEntries, budgetMs: limits.budgetMs });
      const existing = new Map(db.all<IndexRow>('SELECT rel_path, category, ext, size_bytes, mtime_ms FROM asset_index WHERE project_id = ?', projectId).map((r) => [r.rel_path, r]));
      const at = now().toISOString();
      let added = 0;
      let changed = 0;
      let unchanged = 0;
      let removed = 0;
      db.transaction(() => {
        const seen = new Set<string>();
        for (const file of outcome.files) {
          seen.add(file.path);
          const before = existing.get(file.path);
          if (before === undefined) {
            db.run('INSERT INTO asset_index (project_id, rel_path, category, ext, size_bytes, mtime_ms, scanned_at) VALUES (?, ?, ?, ?, ?, ?, ?)', projectId, file.path, file.category, file.extension, file.bytes, file.mtimeMs, at);
            added++;
          } else if (before.size_bytes !== file.bytes || before.mtime_ms !== file.mtimeMs || before.category !== file.category) {
            db.run('UPDATE asset_index SET category = ?, ext = ?, size_bytes = ?, mtime_ms = ?, scanned_at = ? WHERE project_id = ? AND rel_path = ?', file.category, file.extension, file.bytes, file.mtimeMs, at, projectId, file.path);
            changed++;
          } else unchanged++;
        }
        // A scan that stopped early has not seen every file, so it cannot say that a file is gone.
        if (!outcome.truncated)
          for (const path of existing.keys())
            if (!seen.has(path)) {
              db.run('DELETE FROM asset_index WHERE project_id = ? AND rel_path = ?', projectId, path);
              removed++;
            }
        db.run(
          `INSERT INTO asset_scans (project_id, scanned_at, entries, files, added, changed, removed, unchanged, truncated, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(project_id) DO UPDATE SET scanned_at = excluded.scanned_at, entries = excluded.entries, files = excluded.files, added = excluded.added, changed = excluded.changed, removed = excluded.removed, unchanged = excluded.unchanged, truncated = excluded.truncated, duration_ms = excluded.duration_ms`,
          projectId, at, outcome.entries, outcome.files.length, added, changed, removed, unchanged, outcome.truncated ? 1 : 0, outcome.durationMs,
        );
      });
      const summary = lastScan(projectId) as ScanSummary;
      activity.record({
        kind: 'assets.scanned',
        severity: outcome.truncated ? 'warning' : 'info',
        summary: `Indexed ${summary.files} asset files in "${project.name}" (${added} new, ${changed} changed, ${removed} removed)${outcome.truncated ? '; the scan hit its limit, so the index is partial' : ''}.`,
        projectId,
        details: { entries: outcome.entries, durationMs: outcome.durationMs },
      });
      return summary;
    },

    search,

    annotate(request) {
      const projectId = request.projectId;
      const project = projectOf(projectId);
      const tags = [...new Set((request.tags ?? []).map((t) => t.trim().slice(0, TAG_LIMITS.tagLength)).filter(Boolean))].slice(0, TAG_LIMITS.tags);
      const taskIds = [...new Set(request.taskIds ?? [])].slice(0, TAG_LIMITS.tasks);
      for (const task of taskIds) if (db.get('SELECT 1 FROM tasks WHERE id = ? AND project_id = ?', task, projectId) === undefined) throw new AppError('INVALID_INPUT', 'One of those tasks does not belong to this project.', { hint: 'Pick tasks from this project\'s list.' });
      const asset = tracking.track({ projectId, path: request.relativePath, note: request.note ?? '', tags });
      db.transaction(() => {
        db.run('INSERT INTO asset_details (asset_id, source, usage) VALUES (?, ?, ?) ON CONFLICT(asset_id) DO UPDATE SET source = excluded.source, usage = excluded.usage', asset.id, (request.source ?? '').slice(0, TAG_LIMITS.source), (request.usage ?? '').slice(0, TAG_LIMITS.usage));
        db.run('DELETE FROM asset_task_refs WHERE asset_id = ?', asset.id);
        for (const task of taskIds) db.run('INSERT INTO asset_task_refs (asset_id, task_id) VALUES (?, ?)', asset.id, task);
      });
      activity.record({ kind: 'asset.annotated', severity: 'info', summary: `You added notes to ${asset.path} in "${project.name}".`, projectId });
      const rel = request.relativePath.replace(/\\/g, '/');
      const found = search({ projectId, query: '', category: null, tag: '', taskId: null, annotatedOnly: true, limit: 200, offset: 0 }).items.find((i) => i.path === rel);
      if (found !== undefined) return found;
      // The file is tracked but not in the index yet (not scanned, or not game content): describe it from the tracked row.
      return { path: rel, category: 'engine', extension: '', bytes: 0, modifiedAt: now().toISOString(), previewable: false, annotation: { id: asset.id, note: asset.note, tags: asset.tags, source: request.source ?? '', usage: request.usage ?? '', taskIds, status: asset.status } };
    },

    files(projectId) {
      projectOf(projectId);
      return db.all<IndexRow>('SELECT rel_path, category, ext, size_bytes, mtime_ms FROM asset_index WHERE project_id = ? ORDER BY rel_path', projectId).map((r) => ({ path: r.rel_path, category: r.category, bytes: r.size_bytes, mtimeMs: r.mtime_ms }));
    },

    checks(projectId) {
      const project = projectOf(projectId);
      const files = db.all<IndexRow>('SELECT rel_path, category FROM asset_index WHERE project_id = ? ORDER BY rel_path', projectId);
      const report = checkAssets(namingEngineOf(project.type), files.map((f) => ({ path: f.rel_path, category: f.category })));
      return files.length === 0 ? { ...report, note: 'The index is empty. Scan the project first. ' + report.note } : report;
    },
  };
}
