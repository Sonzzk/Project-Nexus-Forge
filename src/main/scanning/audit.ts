import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { AuditReportSchema, type AuditReport, type AuditSummary } from '@shared/audit';
import { AppError } from '@shared/errors';
import type { GitService } from '../git';
import type { ActivityLog, Logger, Redactor } from '../logging';
import type { ProjectRegistry } from '../projects';
import type { Db } from '../storage';
import { analyze } from './analyzers';
import { createProjectReader } from './reader';
import { scanProject } from './scanner';

// The audit service (spec §7): scan, analyze, ask Git, store the report. It only reads the project folder; the report goes
// into the app database. Audits are kept per project, newest first, and the oldest beyond KEEP_PER_PROJECT are dropped.

export interface AuditService {
  /** Audits the project now and stores the report. Throws CONFLICT if one is already running for it. */
  run(projectId: string): Promise<AuditReport>;
  latest(projectId: string): AuditReport | null;
  list(projectId: string): AuditSummary[];
  get(projectId: string, auditId: string): AuditReport;
}

export interface AuditServiceOptions {
  db: Db;
  projects: ProjectRegistry;
  git: GitService;
  activity: ActivityLog;
  logger: Logger;
  redactor: Redactor;
  /** Current scan limits (the `audit.*` settings). */
  limits: () => { maxFiles: number; budgetMs: number };
  now?: () => Date;
  newId?: () => string;
}

export const KEEP_PER_PROJECT = 10;

export function createAuditService(options: AuditServiceOptions): AuditService {
  const { db, projects, git, activity, logger, redactor } = options;
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? randomUUID;
  const running = new Set<string>();

  const parse = (json: string): AuditReport => AuditReportSchema.parse(JSON.parse(json));
  const mustProject = (projectId: string) => {
    const project = projects.get(projectId);
    if (project === undefined)
      throw new AppError('NOT_FOUND', 'That project is not in the registry.', { hint: 'It may have been removed. Reload the project list.' });
    return project;
  };

  return {
    async run(projectId) {
      const project = mustProject(projectId);
      if (!existsSync(project.rootPath))
        throw new AppError('NOT_FOUND', `The folder ${project.rootPath} could not be found.`, {
          hint: 'Reconnect the drive or restore the folder, then run the audit again. Nothing was changed.',
        });
      if (running.has(projectId))
        throw new AppError('CONFLICT', 'An audit of this project is already running.', { hint: 'Wait for it to finish.' });
      running.add(projectId);
      const id = newId();
      const startedAt = now().toISOString();
      try {
        const { maxFiles, budgetMs } = options.limits();
        const scan = await scanProject(project.rootPath, { maxFiles, budgetMs });
        const gitSummary = await git.summary(project.rootPath, `audit-${id}`);
        const sections = analyze({
          scan,
          reader: createProjectReader(project.rootPath),
          git: gitSummary,
          projectType: project.type,
          redact: (text) => redactor.redact(text),
        });
        const report = AuditReportSchema.parse({
          id,
          projectId,
          startedAt,
          finishedAt: now().toISOString(),
          scan: scan.stats,
          git: gitSummary,
          sections,
        });
        db.transaction(() => {
          db.run(
            'INSERT INTO audits (id, project_id, started_at, finished_at, files, report_json) VALUES (?, ?, ?, ?, ?, ?)',
            id, projectId, report.startedAt, report.finishedAt, scan.stats.files, JSON.stringify(report),
          );
          db.run(
            `DELETE FROM audits WHERE project_id = ? AND id NOT IN
               (SELECT id FROM audits WHERE project_id = ? ORDER BY finished_at DESC, id DESC LIMIT ?)`,
            projectId, projectId, KEEP_PER_PROJECT,
          );
        });
        const findings = sections.flatMap((s) => s.findings);
        activity.record({
          kind: 'audit.finished',
          severity: 'info',
          summary: `Audited "${project.name}": ${scan.stats.files.toLocaleString('en-US')} files, ${findings.filter((f) => f.kind === 'confirmed').length} confirmed and ${findings.filter((f) => f.kind === 'inferred').length} inferred findings.`,
          projectId,
          details: { auditId: id, files: scan.stats.files, truncated: scan.stats.truncated, elapsedMs: scan.stats.elapsedMs },
        });
        logger.info('audit finished', { id, projectId, files: scan.stats.files, elapsedMs: scan.stats.elapsedMs });
        return report;
      } finally {
        running.delete(projectId);
      }
    },

    latest(projectId) {
      mustProject(projectId);
      const row = db.get<{ report_json: string }>(
        'SELECT report_json FROM audits WHERE project_id = ? ORDER BY finished_at DESC, id DESC LIMIT 1',
        projectId,
      );
      return row === undefined ? null : parse(row.report_json);
    },

    list(projectId) {
      mustProject(projectId);
      return db
        .all<{ id: string; project_id: string; finished_at: string; files: number }>(
          'SELECT id, project_id, finished_at, files FROM audits WHERE project_id = ? ORDER BY finished_at DESC, id DESC',
          projectId,
        )
        .map((row) => ({ id: row.id, projectId: row.project_id, finishedAt: row.finished_at, files: row.files }));
    },

    get(projectId, auditId) {
      mustProject(projectId);
      const row = db.get<{ report_json: string }>('SELECT report_json FROM audits WHERE id = ? AND project_id = ?', auditId, projectId);
      if (row === undefined) throw new AppError('NOT_FOUND', 'That audit does not exist.', { hint: 'It may have been replaced by a newer one.' });
      return parse(row.report_json);
    },
  };
}
