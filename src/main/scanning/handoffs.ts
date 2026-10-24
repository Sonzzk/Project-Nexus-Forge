import { randomUUID } from 'node:crypto';
import { HANDOFF_FIELDS, HandoffFieldsSchema, type Handoff, type HandoffFields } from '@shared/context';
import { AppError } from '@shared/errors';
import type { GitService } from '../git';
import type { ActivityLog } from '../logging';
import type { ProjectRegistry } from '../projects';
import type { Db } from '../storage';
import type { AuditService } from './audit';

// Session handoffs (spec §8): what was requested, what changed, what was verified, what remains, known bugs and risks,
// relevant files, and the next task, saved per project. The draft fills in only what the app can actually know (Git state
// and the latest audit); the rest is left for the person who did the work to write.

export interface HandoffService {
  /** A starting point for a new handoff; nothing is saved. */
  draft(projectId: string): Promise<HandoffFields>;
  save(projectId: string, fields: HandoffFields): Handoff;
  list(projectId: string, limit?: number): Handoff[];
  latest(projectId: string): Handoff | null;
}

export interface HandoffServiceOptions {
  db: Db;
  projects: ProjectRegistry;
  git: GitService;
  audits: AuditService;
  activity: ActivityLog;
  now?: () => Date;
  newId?: () => string;
}

interface Row {
  id: string;
  project_id: string;
  created_at: string;
  requested: string;
  changed: string;
  verified: string;
  unfinished: string;
  risks: string;
  files: string;
  next_task: string;
}

const toHandoff = (r: Row): Handoff => ({
  id: r.id,
  projectId: r.project_id,
  createdAt: r.created_at,
  requested: r.requested,
  changed: r.changed,
  verified: r.verified,
  unfinished: r.unfinished,
  risks: r.risks,
  files: r.files,
  nextTask: r.next_task,
});

export function createHandoffService(options: HandoffServiceOptions): HandoffService {
  const { db, projects, git, audits, activity } = options;
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? randomUUID;
  let drafts = 0;

  const project = (id: string) => {
    const found = projects.get(id);
    if (found === undefined) throw new AppError('NOT_FOUND', 'That project is not in the registry.', { hint: 'It may have been removed. Reload the project list.' });
    return found;
  };

  return {
    async draft(projectId) {
      const p = project(projectId);
      const lines = (items: string[]): string => items.map((item) => `- ${item}`).join('\n');
      let changed = '';
      let risks = '';
      let unfinished = '';
      if (p.folderExists) {
        const summary = await git.summary(p.rootPath, `handoff-${++drafts}-${projectId}`);
        if (summary.isRepository) {
          const c = summary.changes;
          const parts: string[] = [];
          if (c !== undefined) parts.push(c.staged + c.modified + c.untracked + c.conflicted === 0 ? 'The working tree is clean.' : `Uncommitted: ${c.staged} staged, ${c.modified} modified, ${c.untracked} untracked.`);
          if (summary.branch !== undefined) parts.push(`Branch ${summary.branch}.`);
          const commits = (summary.recentCommits ?? []).slice(0, 8).map((commit) => `${commit.hash.slice(0, 8)} ${commit.subject}`);
          changed = [parts.join(' '), commits.length > 0 ? `Recent commits:\n${lines(commits)}` : ''].filter(Boolean).join('\n\n');
        } else changed = summary.message ?? 'No Git history is available for this project.';
      }
      const audit = audits.latest(projectId);
      if (audit !== null) {
        const section = (id: string) => audit.sections.find((s) => s.id === id)?.findings ?? [];
        const open = section('unfinished').filter((f) => f.kind === 'confirmed' && f.evidence[0]?.path !== '.');
        unfinished = open.length === 0 ? '' : `From the audit of ${audit.finishedAt.slice(0, 10)}:\n${lines(open.slice(0, 8).map((f) => `${f.title} (${f.evidence[0]?.path}${f.evidence[0]?.line === undefined ? '' : `:${f.evidence[0].line}`})`))}`;
        const warnings = section('risks').filter((f) => f.severity === 'warning');
        risks = warnings.length === 0 ? '' : `From the audit of ${audit.finishedAt.slice(0, 10)}:\n${lines(warnings.slice(0, 8).map((f) => f.title))}`;
      }
      return { requested: '', changed, verified: '', unfinished, risks, files: '', nextTask: '' };
    },

    save(projectId, fields) {
      const p = project(projectId);
      const parsed = HandoffFieldsSchema.parse(fields);
      if (HANDOFF_FIELDS.every((key) => parsed[key].trim() === ''))
        throw new AppError('INVALID_INPUT', 'Fill in at least one part of the handoff.', { hint: 'Describe what was requested, what changed or what comes next.' });
      const id = newId();
      db.run(
        'INSERT INTO handoffs (id, project_id, created_at, requested, changed, verified, unfinished, risks, files, next_task) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, projectId, now().toISOString(), parsed.requested, parsed.changed, parsed.verified, parsed.unfinished, parsed.risks, parsed.files, parsed.nextTask,
      );
      const saved = toHandoff(db.get<Row>('SELECT * FROM handoffs WHERE id = ?', id) as Row);
      activity.record({ kind: 'handoff.saved', severity: 'info', summary: `Saved a session handoff for "${p.name}".`, projectId, details: { id } });
      return saved;
    },

    list(projectId, limit = 20) {
      project(projectId);
      return db.all<Row>('SELECT * FROM handoffs WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT ?', projectId, limit).map(toHandoff);
    },

    latest(projectId) {
      project(projectId);
      const r = db.get<Row>('SELECT * FROM handoffs WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT 1', projectId);
      return r === undefined ? null : toHandoff(r);
    },
  };
}
