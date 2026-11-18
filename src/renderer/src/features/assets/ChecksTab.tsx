import { useState } from 'react';
import type { CheckReport } from '@shared/assets';
import type { SerializedError } from '@shared/errors';

const RULE_TEXT = { spaces: 'Spaces in a name', characters: 'Odd characters', case: 'Capital letters', prefix: 'Missing type prefix', 'duplicate-name': 'Same name twice', depth: 'Too deep', 'loose-root': 'Loose in the top folder', 'mixed-case-folder': 'Folder name' } as const;

/** Naming and folder checks (spec §17). They only report: nothing here renames or moves a file. */
export function ChecksTab({ projectId }: { projectId: string }) {
  const [report, setReport] = useState<CheckReport | undefined>();
  const [problem, setProblem] = useState<SerializedError | undefined>();

  const run = (): void => {
    void window.api.invoke('assets:checks', { projectId }).then((r) => {
      if (r.ok) {
        setReport(r.value);
        setProblem(undefined);
      } else setProblem(r.error);
    });
  };
  const total = report === undefined ? 0 : Object.values(report.counts).reduce((a, b) => a + b, 0);

  return (
    <section className="card" aria-label="Naming and folder checks">
      <div className="card__head">
        <h3>Naming and folder checks</h3>
        <button type="button" className="btn btn--primary" onClick={run}>
          {report === undefined ? 'Run the checks' : 'Run again'}
        </button>
      </div>
      <p className="muted">The rule follows the project&apos;s engine. These checks only report; nothing is renamed or moved.</p>
      {problem !== undefined && (
        <p role="alert">
          {problem.message} {problem.hint}
        </p>
      )}
      {report !== undefined && (
        <>
          <p>
            <strong>Rule:</strong> {report.rule}
          </p>
          <p role="status">
            {report.checked.toLocaleString('en-US')} files checked, {total} finding{total === 1 ? '' : 's'}. {report.note}
          </p>
          {total > 0 && (
            <ul className="rows" aria-label="Findings by rule">
              {(Object.entries(report.counts) as [keyof typeof RULE_TEXT, number][])
                .filter(([, n]) => n > 0)
                .map(([rule, n]) => (
                  <li key={rule}>
                    {RULE_TEXT[rule]}: {n}
                  </li>
                ))}
            </ul>
          )}
          {report.findings.length > 0 && (
            <table className="table" aria-label="Findings">
              <thead>
                <tr>
                  <th>Path</th>
                  <th>Problem</th>
                  <th>A name that fits</th>
                </tr>
              </thead>
              <tbody>
                {report.findings.map((f) => (
                  <tr key={`${f.rule}:${f.path}`}>
                    <td className="mono">{f.path}</td>
                    <td>{f.message}</td>
                    <td className="mono">{f.suggestion ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {report.more > 0 && <p className="muted">{report.more} more findings are not listed.</p>}
        </>
      )}
    </section>
  );
}
