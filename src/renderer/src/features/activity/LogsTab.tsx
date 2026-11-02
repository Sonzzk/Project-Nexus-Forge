import { useEffect, useState } from 'react';
import { LOG_LEVEL_NAMES, type LogsResult } from '@shared/diagnostics';
import type { SerializedError } from '@shared/errors';
import { useSettings } from '../../lib/settings';

type RetentionKey = 'retention.activityDays' | 'retention.processRunDays' | 'retention.sessionDays' | 'retention.usageDays' | 'retention.logFiles';

/** The app's own log (redacted), the diagnostics bundle for bug reports, and the retention limits (spec §22, §27.8). */
export function LogsTab() {
  const { settings, set } = useSettings();
  const [level, setLevel] = useState<(typeof LOG_LEVEL_NAMES)[number] | ''>('');
  const [search, setSearch] = useState('');
  const [lines, setLines] = useState(200);
  const [logs, setLogs] = useState<LogsResult | undefined>();
  const [error, setError] = useState<SerializedError | undefined>();
  const [message, setMessage] = useState('');
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void window.api.invoke('logs:tail', { lines, ...(level === '' ? {} : { level }), ...(search.trim() === '' ? {} : { search: search.trim() }) }).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setLogs(result.value);
        setError(undefined);
      } else setError(result.error);
    });
    return () => {
      cancelled = true;
    };
  }, [level, search, lines, version]);

  const limit = (key: RetentionKey, id: string, label: string, min: number, max: number, hint: string) => (
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
    <div className="stack">
      {error !== undefined && (
        <p role="alert">
          {error.message} {error.hint}
        </p>
      )}
      {message !== '' && <p role="status">{message}</p>}

      <section className="card" aria-label="Diagnostics bundle">
        <div className="card__head">
          <h2>Diagnostics bundle</h2>
        </div>
        <p className="muted">
          One file for a bug report: app and tool versions, settings, provider status, row counts, recent warnings and errors, recent programs the app started, and the latest log lines. Secrets and your user folder name are removed; project
          files, prompts and answers are not included. You choose where it is saved.
        </p>
        <button
          type="button"
          className="btn"
          onClick={() =>
            void window.api.invoke('diagnostics:export', {}).then((result) => {
              if (!result.ok) setError(result.error);
              else setMessage(result.value.saved ? 'The diagnostics bundle was saved.' : 'Nothing was saved.');
            })
          }
        >
          Save a diagnostics bundle…
        </button>
      </section>

      <section className="card" aria-label="Retention limits">
        <div className="card__head">
          <h2>Retention limits</h2>
        </div>
        <p className="muted">History older than these limits is deleted once a day and at start (0 keeps everything). Running work and reviews you have not decided on are never deleted.</p>
        {limit('retention.activityDays', 'keep-activity', 'Activity history (days)', 0, 3650, 'What you see on the Activity tab.')}
        {limit('retention.processRunDays', 'keep-processes', 'Records of programs the app started (days)', 0, 3650, 'Git, resource checks, agent programs.')}
        {limit('retention.sessionDays', 'keep-sessions', 'Agent session records (days)', 0, 3650, 'Output, tools used and exit status of runs.')}
        {limit('retention.usageDays', 'keep-usage', 'Usage log (days)', 0, 3650, 'Requests sent to providers and what they reported.')}
        {limit('retention.logFiles', 'keep-logs', 'Older log files kept', 1, 5, 'Each is up to 5 MB; the current one is always kept.')}
        <button
          type="button"
          className="btn"
          onClick={() =>
            void window.api.invoke('retention:run', {}).then((result) => {
              if (!result.ok) setError(result.error);
              else {
                const r = result.value;
                setMessage(`Removed ${r.activity} activity entries, ${r.processRuns} program records, ${r.sessions} session records, ${r.usage} usage rows and ${r.logFiles} old log files.`);
                setVersion((n) => n + 1);
              }
            })
          }
        >
          Clean up now
        </button>
      </section>

      <section className="card" aria-label="Log viewer">
        <div className="card__head">
          <h2>Log</h2>
          <button type="button" className="btn" onClick={() => setVersion((n) => n + 1)}>
            Refresh
          </button>
        </div>
        <div className="field">
          <label htmlFor="log-level">Level</label>
          <select id="log-level" value={level} onChange={(event) => setLevel(LOG_LEVEL_NAMES.find((l) => l === event.target.value) ?? '')}>
            <option value="">Everything</option>
            {LOG_LEVEL_NAMES.map((l) => (
              <option key={l} value={l}>
                {l === 'error' ? 'Errors' : l === 'warn' ? 'Warnings and errors' : l === 'info' ? 'Info and worse' : 'Debug and worse'}
              </option>
            ))}
          </select>
          <label htmlFor="log-search">Search</label>
          <input id="log-search" type="search" value={search} onChange={(event) => setSearch(event.target.value)} />
          <label htmlFor="log-lines">Lines</label>
          <select id="log-lines" value={lines} onChange={(event) => setLines(Number(event.target.value))}>
            {[100, 200, 500, 1000].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
        {logs !== undefined && (
          <p className="muted">
            Files: {logs.files.length === 0 ? 'none' : logs.files.map((f) => `${f.name} (${(f.bytes / 1024).toFixed(0)} KB)`).join(', ')}
          </p>
        )}
        {logs !== undefined && logs.entries.length === 0 && <p className="empty">No log lines match.</p>}
        <table className="table" aria-label="Log lines">
          <thead>
            <tr>
              <th>Time</th>
              <th>Level</th>
              <th>Where</th>
              <th>What</th>
            </tr>
          </thead>
          <tbody>
            {logs?.entries.map((entry, i) => (
              <tr key={i} data-level={entry.level}>
                <td className="mono">{entry.at.slice(11, 19)}</td>
                <td>{entry.level}</td>
                <td className="mono">{entry.module}</td>
                <td>
                  {entry.message}
                  {entry.data !== '' && <div className="muted mono">{entry.data}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
