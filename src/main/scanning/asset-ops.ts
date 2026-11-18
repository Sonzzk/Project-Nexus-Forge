import { existsSync, lstatSync, mkdirSync, renameSync, rmdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { AppError } from '@shared/errors';
import { MAX_MOVES, extensionOf, type Move, type OpsPreview, type OpsResult } from '@shared/assets';
import type { ActivityLog } from '../logging';
import type { ProjectRegistry } from '../projects';
import { isSensitivePath, resolveInside, type Confirm, type PermissionService } from '../security';
import type { Db } from '../storage';

// Moving, renaming and removing asset files (spec §17): never without a preview and a confirmation, and never without the project-writes
// permission of Step 15 (granted in a native window, per project). A preview lists every file and where it goes and says what the app
// does not do for the person; the confirmation window repeats it; a project where an agent holds the writer lock is refused. A move
// cannot overwrite a file, cannot change a file's extension, cannot touch a sensitive name, and is undone in reverse order if one
// step fails. Removal means the Recycle Bin (never a permanent delete), so it can be undone from Windows. Reimporting an asset into an
// engine is not offered: it needs the engine's own tools.

export interface AssetOpsOptions {
  db: Db;
  projects: ProjectRegistry;
  permissions: PermissionService;
  activity: ActivityLog;
  confirm: Confirm;
  /** Sends a file to the Recycle Bin (shell.trashItem). */
  trashItem: (fullPath: string) => Promise<void>;
  now?: () => Date;
}

export interface AssetOps {
  previewMove(projectId: string, moves: readonly Move[]): OpsPreview;
  move(projectId: string, moves: readonly Move[]): Promise<OpsResult>;
  previewTrash(projectId: string, paths: readonly string[]): OpsPreview;
  trash(projectId: string, paths: readonly string[]): Promise<OpsResult>;
}

const norm = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '');
const SIDECARS = ['.meta', '.import'];

export function createAssetOps(options: AssetOpsOptions): AssetOps {
  const { db, projects, permissions, activity } = options;
  const projectOf = (id: string) => {
    const found = projects.get(id);
    if (found === undefined) throw new AppError('NOT_FOUND', 'That project is not in the registry.', { hint: 'It may have been removed. Reload the project list.' });
    return found;
  };
  const writerHolds = (projectId: string): boolean => db.get('SELECT 1 FROM writer_locks WHERE project_id = ?', projectId) !== undefined;

  /** A file inside the project that can be moved or removed, or the reason it cannot. */
  function fileProblem(root: string, rel: string): { full: string; bytes: number } | string {
    if (rel === '' || rel.includes('\0') || rel.length > 400) return `"${rel.slice(0, 80)}" is not a usable path.`;
    if (isSensitivePath(rel)) return `${rel} looks like it holds credentials, so this app does not touch it.`;
    let full: string;
    try {
      full = resolveInside(root, rel);
    } catch {
      return `${rel} is not inside the project folder.`;
    }
    try {
      const stats = lstatSync(join(root, rel));
      if (!stats.isFile()) return `${rel} is not a regular file (folders and links are not moved by this app).`;
      return { full, bytes: stats.size };
    } catch {
      return `${rel} does not exist.`;
    }
  }

  function sidecarWarnings(root: string, rels: readonly string[]): string[] {
    const found = rels.filter((r) => SIDECARS.some((s) => existsSync(join(root, r + s)))).slice(0, 3);
    return found.length === 0 ? [] : [`${found.join(', ')} ${found.length === 1 ? 'has' : 'have'} a .meta (Unity) or .import (Godot) file beside it. This app does not move it, so move it too or the engine will treat the file as new.`];
  }

  const trackedPaths = (projectId: string): Set<string> => new Set(db.all<{ rel_path: string }>('SELECT rel_path FROM tracked_assets WHERE project_id = ?', projectId).map((r) => r.rel_path));

  function planMove(projectId: string, moves: readonly Move[]): OpsPreview {
    const project = projectOf(projectId);
    const problems: string[] = [];
    const items: OpsPreview['items'] = [];
    const tracked = trackedPaths(projectId);
    if (moves.length === 0) problems.push('Nothing was chosen to move.');
    if (moves.length > MAX_MOVES) problems.push(`At most ${MAX_MOVES} files can be moved at once; this asked for ${moves.length}.`);
    const targets = new Set<string>();
    for (const move of moves.slice(0, MAX_MOVES)) {
      const from = norm(move.from);
      const to = norm(move.to);
      const source = fileProblem(project.rootPath, from);
      if (typeof source === 'string') {
        problems.push(source);
        continue;
      }
      if (from === to) problems.push(`${from} would not move: the new path is the same.`);
      else if (extensionOf(from) !== extensionOf(to)) problems.push(`${from} would change its extension (${extensionOf(from) || 'none'} to ${extensionOf(to) || 'none'}); a move may not change a file's type.`);
      else if (isSensitivePath(to)) problems.push(`${to} looks like a credentials file name.`);
      else {
        try {
          const full = resolveInside(project.rootPath, to);
          if (existsSync(full)) problems.push(`${to} already exists; this app never overwrites a file.`);
          else if (tracked.has(to)) problems.push(`${to} is the path of a tracked asset whose file is missing; untrack it first so the notes are not mixed up.`);
          else if (targets.has(to.toLowerCase())) problems.push(`Two files would both become ${to}.`);
          else {
            targets.add(to.toLowerCase());
            items.push({ from, to, bytes: source.bytes, tracked: tracked.has(from) });
          }
        } catch {
          problems.push(`${to} is not inside the project folder.`);
        }
      }
    }
    return {
      kind: 'move',
      items,
      problems: problems.slice(0, 60),
      warnings: [
        'References to these files inside scenes, materials, prefabs and scripts are not updated by this app; check them in the engine afterwards. Notes, tags and task links you gave a tracked file follow it.',
        ...sidecarWarnings(project.rootPath, items.map((i) => i.from)),
        'Missing destination folders are created. Git sees a move as a delete and an add until you commit it.',
      ],
      permitted: permissions.has(projectId, null, 'project-writes'),
    };
  }

  function planTrash(projectId: string, paths: readonly string[]): OpsPreview {
    const project = projectOf(projectId);
    const problems: string[] = [];
    const items: OpsPreview['items'] = [];
    const tracked = trackedPaths(projectId);
    if (paths.length === 0) problems.push('Nothing was chosen to remove.');
    if (paths.length > MAX_MOVES) problems.push(`At most ${MAX_MOVES} files can be removed at once; this asked for ${paths.length}.`);
    for (const raw of paths.slice(0, MAX_MOVES)) {
      const rel = norm(raw);
      const source = fileProblem(project.rootPath, rel);
      if (typeof source === 'string') problems.push(source);
      else items.push({ from: rel, to: null, bytes: source.bytes, tracked: tracked.has(rel) });
    }
    return {
      kind: 'trash',
      items,
      problems: problems.slice(0, 60),
      warnings: [
        'The files go to the Windows Recycle Bin, not to a permanent delete; restore them from there if you change your mind. Files too big for the Recycle Bin are refused by Windows, not deleted.',
        'Anything that refers to these files (scenes, materials, scripts) will point at nothing afterwards; this app does not check or update references.',
        ...sidecarWarnings(project.rootPath, items.map((i) => i.from)),
      ],
      permitted: permissions.has(projectId, null, 'project-writes'),
    };
  }

  /** The permission, the writer lock and the window: the steps both operations share. Returns false when the person declined. */
  async function gate(projectId: string, preview: OpsPreview, title: string, verb: string): Promise<boolean> {
    const project = projectOf(projectId);
    if (preview.problems.length > 0) throw new AppError('INVALID_INPUT', preview.problems[0] ?? 'This operation cannot run.', { hint: preview.problems.length > 1 ? `${preview.problems.length - 1} more problem${preview.problems.length === 2 ? '' : 's'} are listed in the preview.` : 'Fix it and preview again.' });
    if (writerHolds(projectId)) throw new AppError('CONFLICT', 'An agent run holds the writer lock on this project, so files cannot be changed from here now.', { hint: 'Wait for the run to finish or cancel it on the AI Workbench.' });
    if (!permissions.has(projectId, null, 'project-writes')) {
      const grant = await permissions.request({ projectId, scope: 'project-writes' });
      if (grant === null) return false;
    }
    const listed = preview.items.slice(0, 15).map((i) => (i.to === null ? `  ${i.from}` : `  ${i.from}\n    -> ${i.to}`));
    const ok = await options.confirm({
      title,
      message: `${verb} ${preview.items.length} file${preview.items.length === 1 ? '' : 's'} in "${project.name}"?`,
      detail: `${listed.join('\n')}${preview.items.length > 15 ? `\n  ... and ${preview.items.length - 15} more` : ''}\n\n${preview.warnings.map((w) => `- ${w}`).join('\n')}`,
      confirmLabel: verb,
    });
    return ok;
  }

  return {
    previewMove: planMove,
    previewTrash: planTrash,

    async move(projectId, moves) {
      const project = projectOf(projectId);
      const preview = planMove(projectId, moves);
      if (!(await gate(projectId, preview, 'Move these files?', 'Move'))) return { done: false, count: 0 };
      const done: { from: string; to: string }[] = [];
      const createdDirs: string[] = [];
      try {
        for (const item of preview.items) {
          const from = resolveInside(project.rootPath, item.from);
          const to = resolveInside(project.rootPath, item.to ?? '');
          const dir = dirname(to);
          const missing: string[] = [];
          for (let d = dir; !existsSync(d) && relative(project.rootPath, d) !== '' && !relative(project.rootPath, d).startsWith('..'); d = dirname(d)) missing.unshift(d);
          mkdirSync(dir, { recursive: true });
          createdDirs.push(...missing);
          if (existsSync(to)) throw new AppError('CONFLICT', `${item.to ?? ''} appeared while moving; nothing was overwritten.`);
          renameSync(from, to);
          done.push({ from, to });
        }
      } catch (error) {
        for (const step of done.reverse()) {
          try {
            renameSync(step.to, step.from);
          } catch {
            // best effort: the message below says what was left
          }
        }
        for (const dir of createdDirs.reverse()) {
          try {
            rmdirSync(dir); // only a folder this move made, and only when it is empty
          } catch {
            // not empty or already gone
          }
        }
        throw new AppError('TOOL_FAILED', 'The move stopped and the files already moved were put back.', { hint: error instanceof Error ? error.message.slice(0, 200) : 'Check the folder.' });
      }
      db.transaction(() => {
        for (const item of preview.items) {
          const to = item.to ?? '';
          db.run('DELETE FROM asset_index WHERE project_id = ? AND rel_path = ?', projectId, to);
          db.run('UPDATE asset_index SET rel_path = ? WHERE project_id = ? AND rel_path = ?', to, projectId, item.from);
          db.run('UPDATE tracked_assets SET rel_path = ? WHERE project_id = ? AND rel_path = ?', to, projectId, item.from);
        }
      });
      permissions.record({ projectId, scope: 'project-writes', what: `Moved ${preview.items.length} asset file${preview.items.length === 1 ? '' : 's'}`, where: project.rootPath, detail: preview.items.slice(0, 20).map((i) => `${i.from} -> ${i.to ?? ''}`).join('; ') });
      activity.record({ kind: 'asset.moved', severity: 'info', summary: `You moved ${preview.items.length} asset file${preview.items.length === 1 ? '' : 's'} in "${project.name}".`, projectId, details: { count: preview.items.length } });
      return { done: true, count: preview.items.length };
    },

    async trash(projectId, paths) {
      const project = projectOf(projectId);
      const preview = planTrash(projectId, paths);
      if (!(await gate(projectId, preview, 'Move these files to the Recycle Bin?', 'Move to the Recycle Bin'))) return { done: false, count: 0 };
      let count = 0;
      try {
        for (const item of preview.items) {
          await options.trashItem(resolveInside(project.rootPath, item.from));
          db.run('DELETE FROM asset_index WHERE project_id = ? AND rel_path = ?', projectId, item.from);
          count++;
        }
      } catch (error) {
        throw new AppError('TOOL_FAILED', `Windows could not move a file to the Recycle Bin after ${count} file${count === 1 ? '' : 's'}.`, { hint: error instanceof Error ? error.message.slice(0, 200) : 'Check the file.' });
      }
      permissions.record({ projectId, scope: 'destructive', what: `Moved ${count} asset file${count === 1 ? '' : 's'} to the Recycle Bin`, where: project.rootPath, detail: preview.items.slice(0, 20).map((i) => i.from).join('; ') });
      activity.record({ kind: 'asset.trashed', severity: 'warning', summary: `You moved ${count} asset file${count === 1 ? '' : 's'} in "${project.name}" to the Recycle Bin.`, projectId, details: { count } });
      return { done: true, count };
    },
  };
}
