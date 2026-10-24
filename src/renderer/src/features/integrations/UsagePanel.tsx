import { PROVIDER_LABELS } from '@shared/providers';
import { USAGE_STATUS_LABELS } from '@shared/usage';
import { formatTime } from '../../lib/activity';
import { useProjects } from '../../lib/projects';
import { useSettings } from '../../lib/settings';
import { describeRow, describeUsage, limitText, useUsage } from '../../lib/usage';

type LimitKey = 'limits.cloudPerDay' | 'limits.cloudPerProjectPerDay' | 'limits.cloudPerTask' | 'routing.maxAttempts';

/** Usage and limits (spec §12): what the app sent, what the providers said about it, and the launch limits that guard it. */
export function UsagePanel() {
  const { selected } = useProjects();
  const { settings, set } = useSettings();
  const { summary, rows, error } = useUsage(selected?.id, 50);

  const limitInput = (id: string, label: string, key: LimitKey, min: number, max: number, hint: string) => (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="number"
        min={min}
        max={max}
        defaultValue={settings[key]}
        onChange={(event) => {
          const value = Number(event.target.value);
          if (Number.isInteger(value) && value >= min && value <= max) set(key, value);
        }}
      />
      <span className="muted">{hint}</span>
    </div>
  );

  return (
    <section className="card" aria-label="Usage and limits" data-feature="usage">
      <div className="card__head">
        <h2>Usage and limits</h2>
      </div>
      <p className="muted">
        Every request this app sends is logged here, with the token counts or cost the provider returned. A provider that returns nothing shows &quot;Unavailable from this provider&quot;: the app never guesses
        a number and never counts a missing one as zero. A cost is the provider&apos;s own estimate, not a charge. This app cannot see a provider&apos;s quota, so the limits below cap how often it
        launches cloud work; they are a safeguard, not a meter.
      </p>
      {error !== undefined && (
        <p role="alert">
          {error.message} {error.hint}
        </p>
      )}
      {summary !== undefined && (
        <dl className="facts" aria-label="Usage summary">
          <dt>Today</dt>
          <dd>
            {summary.today.launches} sent ({summary.today.cloudLaunches} to the cloud)
            {summary.today.blocked > 0 && `, ${summary.today.blocked} stopped by a limit`}
          </dd>
          <dt>Usage today</dt>
          <dd>{describeUsage(summary.today)}</dd>
          <dt>Last 30 days</dt>
          <dd>{summary.last30Days.launches} sent</dd>
          <dt>Usage, 30 days</dt>
          <dd>{describeUsage(summary.last30Days)}</dd>
          {summary.byProvider.map((p) => (
            <div key={p.provider} className="fact">
              <dt>{PROVIDER_LABELS[p.provider]}</dt>
              <dd>
                {p.launches} sent, {p.reported} reported usage{p.unreported > 0 ? `, ${p.unreported} did not` : ''}
              </dd>
            </div>
          ))}
          <dt>Cloud launches today</dt>
          <dd>{limitText(summary.limits.perDay)}</dd>
          {summary.limits.perProject !== null && selected !== undefined && (
            <>
              <dt>In {selected.name} today</dt>
              <dd>{limitText(summary.limits.perProject)}</dd>
            </>
          )}
        </dl>
      )}
      <div className="stack">
        {limitInput('limit-day', 'Cloud launches per day (0 = no limit)', 'limits.cloudPerDay', 0, 1000, 'All projects together, counted from midnight.')}
        {limitInput('limit-project', 'Cloud launches per project per day (0 = no limit)', 'limits.cloudPerProjectPerDay', 0, 1000, 'Each project on its own.')}
        {limitInput('limit-task', 'Cloud launches per task (0 = no limit)', 'limits.cloudPerTask', 0, 1000, 'Over the whole life of the task, so repeats count too.')}
        {limitInput('limit-attempts', 'Attempts per run', 'routing.maxAttempts', 1, 5, 'How often a failed run may be tried again; the same setting as on the AI Workbench.')}
      </div>
      <p className="muted">A limit stops a launch before you are asked to approve it, says why, and is recorded below. Local models are never limited.</p>

      <h3>Recent requests</h3>
      {rows.length === 0 ? (
        <p className="empty">Nothing has been sent yet.</p>
      ) : (
        <table className="table" aria-label="Recent requests">
          <thead>
            <tr>
              <th>When</th>
              <th>Provider</th>
              <th>For</th>
              <th>Status</th>
              <th>Usage</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{formatTime(row.startedAt)}</td>
                <td>
                  {PROVIDER_LABELS[row.provider]}
                  {row.model !== '' && <span className="muted"> · {row.model}</span>}
                  <div className="muted">{row.location === 'cloud' ? 'cloud' : 'this PC'}</div>
                </td>
                <td>
                  {row.taskTitle ?? row.purpose.replace('-', ' ')}
                  {row.projectName !== null && <div className="muted">{row.projectName}</div>}
                </td>
                <td>
                  {USAGE_STATUS_LABELS[row.status]}
                  {row.reason !== '' && <div className="muted">{row.reason}</div>}
                </td>
                <td>{describeRow(row)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
