import type { Logger } from '../logging';
import type { Redactor } from '../logging';
import type { Db } from '../storage';

// Every process is recorded in `process_runs` (ARCHITECTURE.md section 12). Arguments and paths are redacted before storing.

export interface ProcessRunStore {
  begin(run: {
    id: string;
    owner: { kind: string; id: string };
    purpose: string;
    executable: string;
    args: readonly string[];
    cwd: string;
    pid: number | undefined;
    startedAt: string;
  }): void;
  finish(id: string, status: string, exitCode: number | null, endedAt: string): void;
  /** Rows still marked `running` belong to a previous run of the app that ended without cleaning up. Marks them `lost`. */
  markStaleRunsLost(): number;
}

export function createProcessRunStore(db: Db, redactor: Redactor, logger: Logger): ProcessRunStore {
  return {
    begin(run) {
      db.run(
        "INSERT INTO process_runs (id, owner_kind, owner_id, purpose, executable, args_json, cwd, pid, started_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running')",
        run.id,
        run.owner.kind,
        run.owner.id,
        redactor.redact(run.purpose),
        redactor.redact(run.executable),
        JSON.stringify(redactor.redactValue(run.args)),
        redactor.redact(run.cwd),
        run.pid ?? null,
        run.startedAt,
      );
    },
    finish(id, status, exitCode, endedAt) {
      db.run(
        'UPDATE process_runs SET status = ?, exit_code = ?, ended_at = ? WHERE id = ?',
        status,
        exitCode,
        endedAt,
        id,
      );
    },
    markStaleRunsLost() {
      const { changes } = db.run("UPDATE process_runs SET status = 'lost' WHERE status = 'running'");
      if (changes > 0)
        logger.warn('process runs from a previous session were marked lost', { count: changes });
      return changes;
    },
  };
}
