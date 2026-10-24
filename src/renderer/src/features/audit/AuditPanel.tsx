import type { AuditEvidence, AuditSection, Finding } from '@shared/audit';
import type { Project } from '@shared/projects';
import { formatTime } from '../../lib/activity';
import { useAudit } from '../../lib/audit';

function EvidenceList({ evidence, onReveal }: { evidence: AuditEvidence[]; onReveal: (path: string) => void }) {
  return (
    <ul className="evidence">
      {evidence.map((item) => (
        <li key={`${item.path}:${item.line ?? ''}:${item.detail ?? ''}`}>
          {item.path === '.' ? (
            <span className="muted">Whole folder</span>
          ) : (
            <button
              type="button"
              className="link mono"
              title="Show in Explorer"
              aria-label={`Show ${item.path} in Explorer`}
              onClick={() => onReveal(item.path)}
            >
              {item.path}
              {item.line === undefined ? '' : `:${item.line}`}
            </button>
          )}
          {item.detail !== undefined && <span className="muted"> · {item.detail}</span>}
        </li>
      ))}
    </ul>
  );
}

function FindingRow({ finding, onReveal }: { finding: Finding; onReveal: (path: string) => void }) {
  return (
    <li className="finding" data-kind={finding.kind}>
      <span className="badge" data-kind={finding.kind} title={finding.kind === 'confirmed' ? 'A file proves this' : 'A reasonable reading, not proven'}>
        {finding.kind === 'confirmed' ? 'Confirmed' : 'Inferred'}
      </span>
      <div>
        <strong data-severity={finding.severity}>{finding.title}</strong>
        {finding.detail !== undefined && <p className="muted">{finding.detail}</p>}
        {finding.evidence.length > 0 && <EvidenceList evidence={finding.evidence} onReveal={onReveal} />}
      </div>
    </li>
  );
}

function SectionView({ section, onReveal }: { section: AuditSection; onReveal: (path: string) => void }) {
  const warnings = section.findings.filter((f) => f.severity === 'warning').length;
  return (
    <details className="audit-section" open={section.id === 'overview' || section.id === 'risks'}>
      <summary>
        <strong>{section.title}</strong> <span className="muted">· {section.summary}</span>
        {warnings > 0 && <span className="badge badge--warn"> {warnings} to look at</span>}
      </summary>
      <ul className="findings">
        {section.findings.map((finding, index) => (
          <FindingRow key={`${finding.title}:${index}`} finding={finding} onReveal={onReveal} />
        ))}
      </ul>
    </details>
  );
}

/** The audit report of one project (spec §7): every finding is Confirmed (with its file) or Inferred. */
export function AuditPanel({ project }: { project: Project }) {
  const { report, history, running, error, run, open, reveal } = useAudit(project.id);
  const stats = report?.scan;

  return (
    <section className="card" aria-label={`Audit of ${project.name}`}>
      <div className="card__head">
        <h2>Project audit</h2>
        <button
          type="button"
          className="btn btn--primary"
          disabled={running || !project.folderExists}
          onClick={() => void run()}
        >
          {running ? 'Auditing…' : report ? 'Run the audit again' : 'Run an audit'}
        </button>
      </div>
      <p className="muted">
        Reads the folder (never changes it) and reports what it finds. Confirmed means a file proves it; Inferred is a
        reasonable reading.
      </p>
      {error !== undefined && (
        <p role="alert">
          {error.message} {error.hint}
        </p>
      )}
      {report === undefined && <p className="empty">Loading…</p>}
      {report === null && !running && error === undefined && (
        <p className="empty">This project has not been audited yet.</p>
      )}
      {report && stats && (
        <>
          <div className="actions">
            <span role="status">
              Audited {formatTime(report.finishedAt)} · {stats.files.toLocaleString('en-US')} files in{' '}
              {Math.round(stats.elapsedMs)} ms
            </span>
            {history.length > 1 && (
              <label>
                <span className="muted">Earlier audits </span>
                <select
                  value={report.id}
                  aria-label="Earlier audits"
                  onChange={(event) => void open(event.target.value)}
                >
                  {history.map((item) => (
                    <option key={item.id} value={item.id}>
                      {formatTime(item.finishedAt)} ({item.files.toLocaleString('en-US')} files)
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          {stats.truncated.length > 0 && (
            <p role="alert">
              The scan stopped early ({stats.truncated.join(', ')} limit), so this report is incomplete.
            </p>
          )}
          {report.sections.map((section) => (
            <SectionView key={section.id} section={section} onReveal={(path) => void reveal(path)} />
          ))}
        </>
      )}
    </section>
  );
}
