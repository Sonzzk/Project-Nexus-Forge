import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { extname, basename } from 'node:path';
import { z } from 'zod';
import { PackItemSchema, type ContextPack, type DocType, type PackItem, type PackRequest, type PackSummary } from '@shared/context';
import { AppError } from '@shared/errors';
import type { ActivityLog } from '../logging';
import type { ProjectRegistry } from '../projects';
import type { Db } from '../storage';
import { isSensitivePath, resolveInside } from '../security';
import { TEXT_EXTENSIONS } from './analyzers';
import type { MemoryService } from './memory';
import { sha256 } from './project-write';
import { BINARY_EXTENSIONS, createProjectReader, type ProjectReader } from './reader';
import { scanProject } from './scanner';

// Context packs (spec §7): a concise, task-specific selection of project files and notes for an AI agent. The selection is
// explainable (every item says why it is in, every exclusion says why it is out), bounded by a token estimate, and never
// includes sensitive, binary, generated or very large files, however a file got on the list. Nothing is sent anywhere here:
// the pack is shown in full first, and a saved pack remembers size, time and hash per file so it can say when it is stale.

export interface PackService {
  /** Builds a draft (not saved). Nothing is read outside the project and nothing is changed. */
  build(request: PackRequest): Promise<ContextPack>;
  /** Saves the last draft built for this project. */
  save(projectId: string, title: string): ContextPack;
  list(projectId: string): PackSummary[];
  /** A saved pack, rebuilt from the files as they are now, with the files that changed since it was made. */
  get(projectId: string, id: string): Promise<ContextPack>;
  /** Builds a saved pack again from its own request and replaces its manifest. */
  refresh(projectId: string, id: string): Promise<ContextPack>;
  remove(projectId: string, id: string): void;
}

export interface PackServiceOptions {
  db: Db;
  projects: ProjectRegistry;
  memory: MemoryService;
  activity: ActivityLog;
  limits: () => { maxFiles: number; budgetMs: number };
  /** The open tasks of the project that mention any of the words, as Markdown (empty when none). The planning module provides it. */
  relatedTasks?: (projectId: string, words: readonly string[]) => string;
  now?: () => Date;
  newId?: () => string;
}

const MAX_FILE_BYTES = 64 * 1024;
const MAX_READS = 500;
const MAX_READ_TOTAL = 16 * 1024 * 1024;
const MEMORY_TYPES_FIRST: DocType[] = ['PROJECT_CONTEXT', 'DECISIONS', 'SESSION_HANDOFF'];
const DECISIONS_TAIL_CHARS = 4000;
const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'have', 'has', 'are', 'was', 'were', 'will', 'should', 'make', 'add', 'fix', 'change', 'update', 'when', 'then', 'than', 'not', 'but', 'you', 'can', 'its', 'all', 'any', 'use', 'using', 'need', 'needs', 'new']);
const CONTEXT_DOC_NAMES = /^(readme|claude|agents|contributing)(\.[a-z]+)?$/i;

export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

const keywordsOf = (task: string): string[] => {
  const words = task.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? [];
  const split = task.match(/[A-Z][a-z0-9]+/g)?.map((w) => w.toLowerCase()) ?? [];
  return [...new Set([...words, ...split])].filter((w) => !STOP_WORDS.has(w)).slice(0, 40);
};

interface Candidate {
  path: string;
  size: number;
  mtimeMs: number;
  score: number;
  reasons: string[];
  text?: string;
}

const manifestSchema = z.array(PackItemSchema);
const extraSchema = z.array(z.string());

export function createPackService(options: PackServiceOptions): PackService {
  const { db, projects, memory, activity } = options;
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? randomUUID;
  const drafts = new Map<string, { pack: ContextPack; request: PackRequest }>(); // the last built draft per project

  const project = (id: string) => {
    const found = projects.get(id);
    if (found === undefined) throw new AppError('NOT_FOUND', 'That project is not in the registry.', { hint: 'It may have been removed. Reload the project list.' });
    return found;
  };

  const mtimeOf = (root: string, rel: string): number => lstatSync(resolveInside(root, rel)).mtimeMs;

  async function assemble(request: PackRequest, id: string, saved: boolean, createdAt: string): Promise<ContextPack> {
    const p = project(request.projectId);
    const reader = createProjectReader(p.rootPath);
    const items: PackItem[] = [];
    const sections: string[] = [];
    const excluded: { path: string; reason: string }[] = [];
    let total = 0;
    const title = request.task.trim().split(/\r?\n/)[0]?.slice(0, 80) ?? 'Context pack';
    const header = `# Context pack for "${p.name}"\n\nTask: ${request.task.trim()}\n`;
    total += estimateTokens(header);

    const add = (item: Omit<PackItem, 'estimate'>, section: string): boolean => {
      const tokens = estimateTokens(section);
      if (total + tokens > request.budget) return false;
      total += tokens;
      sections.push(section);
      items.push({ ...item, estimate: tokens });
      return true;
    };

    // 1. The project's own instructions and memory: short, high value.
    if (p.instructions.trim() !== '')
      add({ path: 'instructions', kind: 'instructions', reason: 'Instructions you wrote for AI agents on this project', bytes: Buffer.byteLength(p.instructions, 'utf8'), mtimeMs: 0, sha256: sha256(p.instructions) }, `## Project instructions\n\n${p.instructions.trim()}\n`);
    for (const type of MEMORY_TYPES_FIRST) {
      const doc = memory.text(request.projectId, type);
      if (doc === undefined) continue;
      const body = type === 'DECISIONS' && doc.content.length > DECISIONS_TAIL_CHARS ? `…(older decisions left out)\n${doc.content.slice(-DECISIONS_TAIL_CHARS)}` : doc.content;
      const fromApp = doc.source.startsWith('app:');
      const fits = add(
        { path: doc.source, kind: 'memory', reason: `Project memory: ${type}`, bytes: Buffer.byteLength(doc.content, 'utf8'), mtimeMs: fromApp ? 0 : mtimeOf(p.rootPath, doc.source), sha256: fromApp ? sha256(doc.content) : reader.hash(doc.source, MAX_FILE_BYTES * 4) },
        `## Project memory: ${type} (${doc.source})\n\n${body.trim()}\n`,
      );
      if (!fits) excluded.push({ path: doc.source, reason: 'over the token budget' });
    }

    // 2. Related open tasks: what is already planned around this task.
    const related = options.relatedTasks?.(request.projectId, keywordsOf(request.task)) ?? '';
    if (related.trim() !== '')
      add({ path: 'tasks', kind: 'tasks', reason: 'Open tasks that mention the same things', bytes: Buffer.byteLength(related, 'utf8'), mtimeMs: 0, sha256: sha256(related) }, `## Related tasks\n\n${related.trim()}\n`);

    // 3. Files the user picked by hand come next; the same rules apply to them.
    const picked = new Set<string>();
    for (const raw of request.extraFiles) {
      const rel = raw.replace(/\\/g, '/').replace(/^\.\//, '');
      resolveInside(p.rootPath, rel); // a path that leaves the project rejects the whole request
      picked.add(rel);
    }

    // 3. Everything else is scored against the task.
    const { maxFiles, budgetMs } = options.limits();
    const scan = await scanProject(p.rootPath, { maxFiles, budgetMs }); // sensitive files and generated folders are already skipped
    const known = new Map(scan.files.map((f) => [f.path, f]));
    const words = keywordsOf(request.task);
    let reads = 0;
    let readBytes = 0;
    const candidates: Candidate[] = [];
    const consider = (path: string, forced: boolean): void => {
      const file = known.get(path);
      if (file === undefined) {
        excluded.push({ path, reason: isSensitivePath(path) ? 'may hold credentials; never included' : existsSync(resolveInside(p.rootPath, path)) ? 'skipped by the scanner (generated folder or link)' : 'not found' });
        return;
      }
      const ext = extname(path).toLowerCase();
      if (BINARY_EXTENSIONS.has(ext) || !(TEXT_EXTENSIONS.has(ext) || ext === '' || ext === '.md' || ext === '.txt')) {
        if (forced) excluded.push({ path, reason: 'binary or unknown file type; never included' });
        return;
      }
      if (file.size > MAX_FILE_BYTES) {
        if (forced) excluded.push({ path, reason: `too large (${Math.round(file.size / 1024)} KB; limit ${MAX_FILE_BYTES / 1024} KB)` });
        return;
      }
      const lower = path.toLowerCase();
      const name = basename(lower);
      let score = forced ? 100 : 0;
      let relevant = forced;
      const reasons: string[] = forced ? ['Picked by you'] : [];
      for (const word of words) {
        if (name.includes(word)) {
          relevant = true;
          score += 8;
          reasons.push(`file name mentions "${word}"`);
        } else if (lower.includes(word)) {
          relevant = true;
          score += 4;
          reasons.push(`path mentions "${word}"`);
        }
      }
      let text: string | undefined;
      if (reads < MAX_READS && readBytes < MAX_READ_TOTAL && file.size > 0) {
        try {
          text = reader.readText(path, MAX_FILE_BYTES);
          reads++;
          readBytes += text.length;
        } catch {
          return; // unreadable as text
        }
        const body = text.toLowerCase();
        let hits = 0;
        const matched: string[] = [];
        for (const word of words) {
          const count = Math.min(5, body.split(word).length - 1);
          if (count > 0) {
            hits += count;
            matched.push(word);
          }
        }
        if (hits > 0) {
          relevant = true;
          score += Math.min(hits, 15);
          reasons.push(`contains ${matched.slice(0, 4).map((w) => `"${w}"`).join(', ')}`);
        }
      }
      if (CONTEXT_DOC_NAMES.test(basename(path)) && !path.includes('/')) {
        score += 3;
        reasons.push('top-level project document');
      }
      if (relevant) candidates.push({ path, size: file.size, mtimeMs: file.mtimeMs, score, reasons, ...(text === undefined ? {} : { text }) });
    };
    for (const rel of picked) consider(rel, true);
    for (const file of scan.files) if (!picked.has(file.path)) consider(file.path, false);

    candidates.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    const already = new Set(items.map((i) => i.path));
    for (const c of candidates) {
      if (already.has(c.path)) continue;
      const text = c.text ?? reader.readText(c.path, MAX_FILE_BYTES);
      const fence = text.includes('```') ? '~~~~' : '```';
      const ext = extname(c.path).slice(1);
      const fits = add(
        { path: c.path, kind: 'file', reason: c.reasons.slice(0, 4).join('; '), bytes: c.size, mtimeMs: mtimeOf(p.rootPath, c.path), sha256: reader.hash(c.path, MAX_FILE_BYTES) },
        `## File: ${c.path}\n\n${fence}${ext}\n${text.trimEnd()}\n${fence}\n`,
      );
      if (!fits && excluded.length < 100) excluded.push({ path: c.path, reason: 'over the token budget' });
    }
    if (items.length === 0 && excluded.length === 0) excluded.push({ path: '.', reason: 'No file matched the task. Describe it with names from the project, or pick files by hand.' });

    const text = [header, ...sections].join('\n');
    return {
      id,
      projectId: request.projectId,
      title,
      task: request.task.trim(),
      budget: request.budget,
      estimate: estimateTokens(text),
      destination: request.destination,
      items: items.slice(0, 200),
      excluded: excluded.slice(0, 100),
      text,
      createdAt,
      stale: [],
      saved,
    };
  }

  /** Files whose size/time changed are compared by hash; a memory item is compared with the current document. */
  function staleness(projectId: string, items: PackItem[], task: string): ContextPack['stale'] {
    const p = project(projectId);
    const reader: ProjectReader = createProjectReader(p.rootPath);
    const stale: ContextPack['stale'] = [];
    for (const item of items) {
      try {
        if (item.kind === 'tasks') {
          if (sha256(options.relatedTasks?.(projectId, keywordsOf(task)) ?? '') !== item.sha256) stale.push({ path: item.path, change: 'changed' });
        } else if (item.kind === 'instructions') {
          if (sha256(p.instructions) !== item.sha256) stale.push({ path: item.path, change: 'changed' });
        } else if (item.path.startsWith('app:')) {
          const doc = memory.text(projectId, item.path.slice(4) as DocType);
          if (doc === undefined) stale.push({ path: item.path, change: 'missing' });
          else if (sha256(doc.content) !== item.sha256) stale.push({ path: item.path, change: 'changed' });
        } else {
          const full = resolveInside(p.rootPath, item.path);
          if (!existsSync(full)) stale.push({ path: item.path, change: 'missing' });
          else {
            const stats = lstatSync(full);
            // Size and time are the cheap check; only a file that looks different is read, and only its hash decides.
            if ((stats.mtimeMs !== item.mtimeMs || stats.size !== item.bytes) && reader.hash(item.path, MAX_FILE_BYTES * 4) !== item.sha256) stale.push({ path: item.path, change: 'changed' });
          }
        }
      } catch {
        stale.push({ path: item.path, change: 'missing' }); // gone, moved outside, or no longer allowed to be read
      }
    }
    return stale;
  }

  interface Row { id: string; project_id: string; title: string; task: string; token_budget: number; destination: string; extra_files_json: string; manifest_json: string; token_estimate: number; created_at: string; updated_at: string }
  const row = (projectId: string, id: string): Row => {
    const found = db.get<Row>('SELECT * FROM context_packs WHERE id = ? AND project_id = ?', id, projectId);
    if (found === undefined) throw new AppError('NOT_FOUND', 'That context pack does not exist.', { hint: 'It may have been deleted.' });
    return found;
  };
  const requestOf = (r: Row): PackRequest => ({ projectId: r.project_id, task: r.task, budget: r.token_budget, extraFiles: extraSchema.parse(JSON.parse(r.extra_files_json)), destination: r.destination });

  return {
    async build(request) {
      const pack = await assemble(request, '', false, now().toISOString());
      drafts.set(request.projectId, { pack, request });
      return pack;
    },

    save(projectId, title) {
      project(projectId);
      const built = drafts.get(projectId);
      if (built === undefined) throw new AppError('INVALID_INPUT', 'Build a context pack first.', { hint: 'Describe the task and press Build the pack.' });
      const { pack: draft, request } = built;
      const id = newId();
      const stamp = now().toISOString();
      const name = title.trim().slice(0, 120) || draft.title;
      db.run(
        'INSERT INTO context_packs (id, project_id, title, task, token_budget, destination, extra_files_json, manifest_json, token_estimate, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, projectId, name, draft.task, draft.budget, draft.destination, JSON.stringify(request.extraFiles), JSON.stringify(draft.items), draft.estimate, draft.createdAt, stamp,
      );
      activity.record({ kind: 'pack.saved', severity: 'info', summary: `Saved context pack "${name}" (${draft.items.length} items, about ${draft.estimate} tokens).`, projectId, details: { id, files: draft.items.length } });
      return { ...draft, id, title: name, saved: true };
    },

    list(projectId) {
      project(projectId);
      return db.all<Row>('SELECT * FROM context_packs WHERE project_id = ? ORDER BY created_at DESC, id', projectId).map((r) => {
        const items = manifestSchema.safeParse(JSON.parse(r.manifest_json));
        return {
          id: r.id,
          title: r.title,
          destination: r.destination,
          estimate: r.token_estimate,
          files: items.success ? items.data.length : 0,
          createdAt: r.created_at,
          stale: items.success ? staleness(projectId, items.data, r.task).length : 0,
        };
      });
    },

    async get(projectId, id) {
      const r = row(projectId, id);
      const stored = manifestSchema.parse(JSON.parse(r.manifest_json));
      const stale = staleness(projectId, stored, r.task);
      const pack = await assemble(requestOf(r), r.id, true, r.created_at);
      return { ...pack, title: r.title, stale };
    },

    async refresh(projectId, id) {
      const r = row(projectId, id);
      const pack = await assemble(requestOf(r), r.id, true, r.created_at);
      db.run('UPDATE context_packs SET manifest_json = ?, token_estimate = ?, updated_at = ? WHERE id = ?', JSON.stringify(pack.items), pack.estimate, now().toISOString(), id);
      activity.record({ kind: 'pack.refreshed', severity: 'info', summary: `Rebuilt context pack "${r.title}".`, projectId, details: { id } });
      return { ...pack, title: r.title };
    },

    remove(projectId, id) {
      const r = row(projectId, id);
      db.run('DELETE FROM context_packs WHERE id = ?', id);
      activity.record({ kind: 'pack.removed', severity: 'info', summary: `Deleted context pack "${r.title}".`, projectId });
    },
  };
}
