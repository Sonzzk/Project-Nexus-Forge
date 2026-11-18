import { CATEGORY_LABELS, ASSET_CATEGORIES, type AssetCategory } from '@shared/assets';
import type { Db } from '../storage';

// The text of ASSET_REGISTER.md (spec §8): the assets the person annotated (their source and where they are used) and a summary of the
// whole index. It is built from the app's records only; the person previews it and chooses where it is stored (the app's database, or
// a file in the project after a diff and a confirmation) through the project memory of Step 9. Nothing here reads a file's content.

const cell = (text: string): string => text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim() || '-';
const size = (bytes: number): string => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(bytes === 0 ? 0 : 1, Math.round(bytes / 1024))} KB`);

interface AnnotatedRow {
  rel_path: string;
  category: AssetCategory | null;
  size_bytes: number | null;
  note: string;
  tags_json: string;
  source: string | null;
  usage: string | null;
  id: string;
}

export function buildAssetRegister(db: Db, project: { id: string; name: string }, today: string): string {
  const rows = db.all<AnnotatedRow>(
    `SELECT t.id, t.rel_path, i.category, i.size_bytes, t.note, t.tags_json, d.source, d.usage
     FROM tracked_assets t LEFT JOIN asset_index i ON i.project_id = t.project_id AND i.rel_path = t.rel_path LEFT JOIN asset_details d ON d.asset_id = t.id
     WHERE t.project_id = ? ORDER BY t.rel_path`,
    project.id,
  );
  const tasksOf = (assetId: string): string =>
    db
      .all<{ title: string }>('SELECT k.title FROM asset_task_refs r JOIN tasks k ON k.id = r.task_id WHERE r.asset_id = ? ORDER BY k.title', assetId)
      .map((t) => t.title)
      .join('; ');
  const lines: string[] = [
    `# Asset register: ${project.name}`,
    '',
    `Written ${today} by GameDev Command Center from the asset index and your own notes. Where a Source is empty, it was not recorded; nothing here was guessed. Edit the notes in the app and write this document again, or edit it by hand.`,
    '',
    '## Important assets',
    '',
  ];
  if (rows.length === 0) lines.push('No asset has been annotated yet. Add a source, usage, tags or tasks to a file in the Assets section and it will be listed here.', '');
  else {
    lines.push('| Asset | Type | Source | Used in | Tags | Notes |', '|---|---|---|---|---|---|');
    for (const r of rows) {
      const used = [r.usage ?? '', tasksOf(r.id) === '' ? '' : `tasks: ${tasksOf(r.id)}`].filter((x) => x !== '').join('; ');
      lines.push(`| \`${r.rel_path}\` | ${r.category === null ? 'not in the index' : CATEGORY_LABELS[r.category]} | ${cell(r.source ?? '')} | ${cell(used)} | ${cell((JSON.parse(r.tags_json) as string[]).join(', '))} | ${cell(r.note)} |`);
    }
    lines.push('');
  }
  const summary = db.all<{ category: AssetCategory; n: number; bytes: number }>('SELECT category, COUNT(*) AS n, SUM(size_bytes) AS bytes FROM asset_index WHERE project_id = ? GROUP BY category', project.id);
  lines.push('## Inventory summary', '');
  if (summary.length === 0) lines.push('The project has not been scanned yet.');
  else {
    lines.push('| Category | Files | Size |', '|---|---|---|');
    for (const category of ASSET_CATEGORIES) {
      const found = summary.find((s) => s.category === category);
      if (found !== undefined) lines.push(`| ${CATEGORY_LABELS[category]} | ${found.n.toLocaleString('en-US')} | ${size(found.bytes)} |`);
    }
  }
  lines.push('');
  return lines.join('\n');
}
