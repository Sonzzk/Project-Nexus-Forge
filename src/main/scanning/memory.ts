import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DOC_INFO, DOC_TYPES, MAX_DOC_BYTES, MEMORY_STORAGES, type DocType, type MemoryApplyResult, type MemoryOverview, type MemoryPreview, type MemoryStorage } from '@shared/context';
import { diffLines } from '@shared/diff';
import { AppError } from '@shared/errors';
import type { ActivityLog } from '../logging';
import type { ProjectRegistry } from '../projects';
import type { Db } from '../storage';
import { readProjectDoc, sha256, wouldCreateFolder, writeProjectDoc } from './project-write';

// Persistent project memory (spec §8). Documents live in the app database (default), in the project folder, or in a
// documentation folder inside the project. The app first looks at what the project already has and proposes only what is
// missing; it never rewrites a document on its own. Changing a document is two steps: a preview with a diff, then a
// confirmation; for a file in the project the confirmation is a native dialog and the file is read back after writing.

export type Confirm = (options: { title: string; message: string; detail?: string; confirmLabel: string }) => Promise<boolean>;

export interface MemoryService {
  overview(projectId: string): MemoryOverview;
  read(projectId: string, type: DocType): { content: string; location: string; exists: boolean };
  /** Compares `content` with what is stored and remembers it for `apply`. Changes nothing. */
  preview(projectId: string, type: DocType, content: string): MemoryPreview;
  /** Writes the previewed content (after a native confirmation for a file in the project). */
  apply(projectId: string, type: DocType): Promise<MemoryApplyResult>;
  setStorage(projectId: string, storage: MemoryStorage, docsDir: string): MemoryOverview;
  /** The stored text of a document, or undefined; used by context packs. */
  text(projectId: string, type: DocType): { content: string; source: string } | undefined;
}

export interface MemoryServiceOptions {
  db: Db;
  projects: ProjectRegistry;
  activity: ActivityLog;
  confirm: Confirm;
  now?: () => Date;
}

const DOC_FOLDERS = ['docs', 'doc', 'documentation', 'design', 'wiki'];

/** A relative folder inside the project: forward slashes, no `..`, no drive, no sensitive names. */
export function cleanDocsDir(value: string): string {
  const folder = value.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (/^[\\/]/.test(value.trim()) || folder === '' || folder.length > 200 || /^[a-zA-Z]:/.test(folder) || folder.split('/').some((part) => part === '' || part === '.' || part === '..' || /[<>:"|?*\0]/.test(part)))
    throw new AppError('INVALID_INPUT', 'Enter a folder inside the project, such as docs.', { hint: 'Use a relative path without ".." or a drive letter.' });
  return folder;
}

export function createMemoryService(options: MemoryServiceOptions): MemoryService {
  const { db, projects, activity, confirm } = options;
  const now = options.now ?? (() => new Date());
  let staged: { projectId: string; type: DocType; content: string; target: string; storage: MemoryStorage; priorHash: string | null } | undefined;

  const project = (id: string) => {
    const found = projects.get(id);
    if (found === undefined) throw new AppError('NOT_FOUND', 'That project is not in the registry.', { hint: 'It may have been removed. Reload the project list.' });
    return found;
  };
  const settingsOf = (projectId: string): { storage: MemoryStorage; docsDir: string } => {
    const row = db.get<{ storage: string; docs_dir: string }>('SELECT storage, docs_dir FROM memory_settings WHERE project_id = ?', projectId);
    const storage = MEMORY_STORAGES.find((s) => s === row?.storage) ?? 'app';
    return { storage, docsDir: row?.docs_dir ?? '' };
  };

  /** Files already in the project named like a memory document, found by listing the root and the usual documentation folders. */
  const found = (root: string): Map<DocType, string> => {
    const hits = new Map<DocType, string>();
    for (const folder of ['', ...DOC_FOLDERS]) {
      let entries;
      try {
        entries = readdirSync(folder === '' ? root : join(root, folder), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile()) continue; // links and folders are not documents
        const type = DOC_TYPES.find((t) => `${t}.md`.toLowerCase() === entry.name.toLowerCase());
        if (type !== undefined && !hits.has(type)) hits.set(type, folder === '' ? entry.name : `${folder}/${entry.name}`);
      }
    }
    return hits;
  };

  /** Where a document is stored for the current settings: the app, or a project-relative path. */
  const targetOf = (projectId: string, root: string, type: DocType): { storage: MemoryStorage; rel: string | undefined } => {
    const { storage, docsDir } = settingsOf(projectId);
    if (storage === 'app') return { storage, rel: undefined };
    if (storage === 'project') return { storage, rel: found(root).get(type) ?? `${type}.md` };
    return { storage, rel: `${cleanDocsDir(docsDir === '' ? 'docs' : docsDir)}/${type}.md` };
  };

  const appDoc = (projectId: string, type: DocType): { content: string; updatedAt: string } | undefined => {
    const row = db.get<{ content: string; updated_at: string }>('SELECT content, updated_at FROM project_docs WHERE project_id = ? AND doc_type = ?', projectId, type);
    return row === undefined ? undefined : { content: row.content, updatedAt: row.updated_at };
  };

  const current = (projectId: string, root: string, type: DocType): { content: string; exists: boolean; location: string; hash: string | null; storage: MemoryStorage; rel: string | undefined } => {
    const target = targetOf(projectId, root, type);
    if (target.rel === undefined) {
      const doc = appDoc(projectId, type);
      return { content: doc?.content ?? '', exists: doc !== undefined, location: 'App database', hash: doc === undefined ? null : sha256(doc.content), storage: target.storage, rel: undefined };
    }
    const file = readProjectDoc(root, target.rel);
    return { content: file.text, exists: file.exists, location: target.rel, hash: file.hash, storage: target.storage, rel: target.rel };
  };

  const overview = (projectId: string): MemoryOverview => {
    const p = project(projectId);
    const settings = settingsOf(projectId);
    const existing = found(p.rootPath);
    const docs = DOC_TYPES.map((type) => {
      const target = targetOf(projectId, p.rootPath, type);
      let exists: boolean;
      let bytes = 0;
      let updatedAt: string | undefined;
      let location = 'App database';
      if (target.rel === undefined) {
        const doc = appDoc(projectId, type);
        exists = doc !== undefined;
        bytes = doc === undefined ? 0 : Buffer.byteLength(doc.content, 'utf8');
        updatedAt = doc?.updatedAt;
      } else {
        location = target.rel;
        try {
          const file = readProjectDoc(p.rootPath, target.rel);
          exists = file.exists;
          bytes = Buffer.byteLength(file.text, 'utf8');
        } catch {
          exists = false; // unreadable as a document (binary, too large): shown as not usable here
        }
      }
      const elsewhere = existing.get(type);
      return {
        type,
        location,
        exists,
        bytes,
        ...(updatedAt === undefined ? {} : { updatedAt }),
        ...(elsewhere === undefined || elsewhere === location ? {} : { foundInProject: elsewhere }),
      };
    });
    const proposal: MemoryOverview['proposal'] = [];
    const projectHasDocs = existing.size > 0;
    for (const type of DOC_TYPES) {
      if (!DOC_INFO[type].core) continue;
      const doc = docs.find((d) => d.type === type);
      if (doc?.exists === true || existing.has(type)) continue;
      proposal.push({
        type,
        reason: projectHasDocs
          ? 'The project already has some documents but not this one; this is the smallest addition that makes resuming work easier.'
          : 'The project has no documentation of this kind yet.',
      });
    }
    return { storage: settings.storage, docsDir: settings.docsDir, docs, proposal };
  };

  return {
    overview,

    read(projectId, type) {
      const p = project(projectId);
      const doc = current(projectId, p.rootPath, type);
      return { content: doc.content, location: doc.location, exists: doc.exists };
    },

    preview(projectId, type, content) {
      const p = project(projectId);
      const bytes = Buffer.byteLength(content, 'utf8');
      if (bytes > MAX_DOC_BYTES) throw new AppError('LIMIT_REACHED', 'That document is too large.', { hint: 'Keep memory documents concise (under 256 KB).' });
      const before = current(projectId, p.rootPath, type);
      const normalized = content.replace(/\r\n/g, '\n');
      const unchanged = before.exists && before.content.replace(/\r\n/g, '\n') === normalized;
      const diff = diffLines(before.content, normalized);
      staged = { projectId, type, content: normalized, target: before.location, storage: before.storage, priorHash: before.hash };
      return {
        type,
        location: before.location,
        isNew: !before.exists,
        unchanged,
        createsFolder: before.rel !== undefined && wouldCreateFolder(p.rootPath, before.rel),
        ...(diff === undefined ? {} : { diff }),
        bytes,
        previousBytes: Buffer.byteLength(before.content, 'utf8'),
      };
    },

    async apply(projectId, type) {
      if (staged?.projectId !== projectId || staged.type !== type)
        throw new AppError('INVALID_INPUT', 'Preview the change first.', { hint: 'Use Preview changes, check the difference, then save.' });
      const p = project(projectId);
      const { content, target, storage, priorHash } = staged;
      const now2 = now().toISOString();

      if (storage === 'app') {
        const before = appDoc(projectId, type);
        if ((before === undefined ? null : sha256(before.content)) !== priorHash)
          throw new AppError('CONFLICT', 'The document changed after you looked at the preview, so nothing was saved.', { hint: 'Preview the change again.' });
        db.run(
          'INSERT INTO project_docs (project_id, doc_type, content, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(project_id, doc_type) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at',
          projectId, type, content, now2,
        );
        if (appDoc(projectId, type)?.content !== content) throw new AppError('INTERNAL', 'The document was not saved correctly.');
      } else {
        const bytes = Buffer.byteLength(content, 'utf8');
        const ok = await confirm({
          title: 'Write this document into the project?',
          message: `Write ${target} in "${p.name}"?`,
          detail: `${priorHash === null ? 'This creates the file' : 'This replaces the file'} ${target} (${bytes} bytes) inside ${p.rootPath}.${wouldCreateFolder(p.rootPath, target) ? ' The folder does not exist yet and will be created.' : ''}\n\nNothing else in the project is touched.`,
          confirmLabel: 'Write the file',
        });
        if (!ok) return { written: false, location: target };
        writeProjectDoc(p.rootPath, target, content, priorHash);
      }
      staged = undefined;
      activity.record({ kind: 'memory.written', severity: 'info', summary: `Saved ${DOC_INFO[type].label} for "${p.name}" (${target}).`, projectId, details: { type, location: target, storage } });
      return { written: true, location: target };
    },

    setStorage(projectId, storage, docsDir) {
      const p = project(projectId);
      const dir = storage === 'docs-dir' ? cleanDocsDir(docsDir) : '';
      db.run(
        'INSERT INTO memory_settings (project_id, storage, docs_dir) VALUES (?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET storage = excluded.storage, docs_dir = excluded.docs_dir',
        projectId, storage, dir,
      );
      staged = undefined;
      activity.record({ kind: 'memory.storage', severity: 'info', summary: `Project memory for "${p.name}" is now stored ${storage === 'app' ? 'in the app database' : storage === 'project' ? 'in the project folder' : `in ${dir}/`}.`, projectId, details: { storage, docsDir: dir } });
      return overview(projectId);
    },

    text(projectId, type) {
      const p = project(projectId);
      const doc = current(projectId, p.rootPath, type);
      return doc.exists && doc.content.trim() !== '' ? { content: doc.content, source: doc.rel === undefined ? `app:${type}` : doc.rel } : undefined;
    },
  };
}
