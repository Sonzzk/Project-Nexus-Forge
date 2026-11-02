import { useState } from 'react';
import { Tabs } from 'radix-ui';
import { ResourceFacts, useResources } from '../ResourceFacts';
import { ActivityTab } from './ActivityTab';
import { LogsTab } from './LogsTab';
import { SessionsTab } from './SessionsTab';

function ResourcesTab() {
  const { report, check, busy, error } = useResources();
  return (
    <div className="stack">
      <p className="muted">
        CPU and RAM come from Windows, GPU and VRAM from NVIDIA&apos;s nvidia-smi when it is installed, and running Unreal Editor or Blender from the process list. Nothing is measured until you ask here or a local model is waiting to start, and
        nothing is ever closed or stopped for you.
      </p>
      <div className="actions">
        <button type="button" className="btn" disabled={busy} onClick={() => void check()}>
          {busy ? 'Checking…' : 'Check resources now'}
        </button>
      </div>
      {error !== undefined && (
        <p role="alert">
          {error.message} {error.hint}
        </p>
      )}
      {report.loaded && report.report === undefined && <p className="empty">No check has been made since the app started.</p>}
      {report.loaded && report.report !== undefined && <ResourceFacts report={report.report} />}
    </div>
  );
}

/** Activity and Logs (spec §15, §22): the history with filters and export, live agent sessions and the queue, resources, and the log. */
export function ActivityPage() {
  const [tab, setTab] = useState('activity');
  return (
    <div className="page">
      <header className="page__head">
        <h1>Activity and Logs</h1>
        <p className="muted">What the app did and what the agents are doing, shown only as far as it was observed. Pick an entry in the history to see its details.</p>
      </header>
      <Tabs.Root value={tab} onValueChange={setTab}>
        <Tabs.List className="tabs" aria-label="Activity sections">
          <Tabs.Trigger className="tab" value="activity">
            Activity
          </Tabs.Trigger>
          <Tabs.Trigger className="tab" value="sessions">
            Live sessions
          </Tabs.Trigger>
          <Tabs.Trigger className="tab" value="resources">
            Resources
          </Tabs.Trigger>
          <Tabs.Trigger className="tab" value="logs">
            Logs and diagnostics
          </Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="activity">
          <ActivityTab />
        </Tabs.Content>
        <Tabs.Content value="sessions">
          <SessionsTab />
        </Tabs.Content>
        <Tabs.Content value="resources">
          <ResourcesTab />
        </Tabs.Content>
        <Tabs.Content value="logs">
          <LogsTab />
        </Tabs.Content>
      </Tabs.Root>
    </div>
  );
}
