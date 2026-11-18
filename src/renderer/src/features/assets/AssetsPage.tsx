import { useCallback, useEffect, useState } from 'react';
import { Tabs } from 'radix-ui';
import type { TrackedAsset } from '@shared/blender';
import type { ScanSummary } from '@shared/assets';
import type { SerializedError } from '@shared/errors';
import { formatTime } from '../../lib/activity';
import type { Project } from '@shared/projects';
import { useProjects } from '../../lib/projects';
import { AssetsPanel } from '../blender/AssetsPanel';
import { ChecksTab } from './ChecksTab';
import { InventoryTab } from './InventoryTab';
import { RegisterTab } from './RegisterTab';

/** Assets (spec §17): the project's game content as a searchable list with previews, checks, a register and briefs. */
export function AssetsPage() {
  const { selected } = useProjects();
  return (
    <div className="page">
      <header className="page__head">
        <h1>Assets</h1>
        <p className="muted">
          The game content in the project (models, textures, audio, scenes and more): where it is, how big it is, what you have noted about it, and checks on its names. The list holds names, sizes and times only; files are never opened, and nothing is moved without a preview and your confirmation.
        </p>
      </header>
      {selected === undefined ? <p className="empty">Select a project to see its assets.</p> : <AssetsBody key={selected.id} selected={selected} />}
    </div>
  );
}

function AssetsBody({ selected }: { selected: Project }) {
  const [tab, setTab] = useState('inventory');
  const [scan, setScan] = useState<ScanSummary | null | undefined>();
  const [scanning, setScanning] = useState(false);
  const [problem, setProblem] = useState<SerializedError | undefined>();
  const [refresh, setRefresh] = useState(0);
  const [tracked, setTracked] = useState<TrackedAsset[]>([]);
  const projectId = selected.id;
  const bump = useCallback(() => setRefresh((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    void window.api.invoke('assets:search', { projectId, query: '', category: null, tag: '', taskId: null, annotatedOnly: false, limit: 1, offset: 0 }).then((r) => {
      if (!cancelled && r.ok) setScan(r.value.scan);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId]);
  useEffect(() => {
    let cancelled = false;
    void window.api.invoke('assets:tracked', { projectId }).then((r) => {
      if (!cancelled && r.ok) setTracked(r.value);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, refresh]);

  const runScan = (): void => {
    setScanning(true);
    void window.api.invoke('assets:scan', { projectId }).then((r) => {
      setScanning(false);
      if (r.ok) {
        setScan(r.value);
        setProblem(undefined);
        bump();
      } else setProblem(r.error);
    });
  };

  return (
        <>
          <section className="card" aria-label="Asset scan">
            <div className="card__head">
              <h3>Scan</h3>
              <button type="button" className="btn btn--primary" disabled={scanning} onClick={runScan}>
                {scanning ? 'Scanning…' : scan === null || scan === undefined ? 'Scan the project' : 'Scan again'}
              </button>
            </div>
            {problem !== undefined && (
              <p role="alert">
                {problem.message} {problem.hint}
              </p>
            )}
            {scan === null && <p className="muted">This project has not been scanned yet. A scan lists the files and records their size and time; a later scan only updates what changed.</p>}
            {scan !== null && scan !== undefined && (
              <p aria-label="Last scan">
                Last scan {formatTime(scan.scannedAt)}: {scan.files.toLocaleString('en-US')} asset files ({scan.added} new, {scan.changed} changed, {scan.removed} removed, {scan.unchanged} unchanged), {scan.entries.toLocaleString('en-US')} entries looked at in {(scan.durationMs / 1000).toFixed(1)} s.
                {scan.truncated && <strong role="status"> The scan hit its limit, so the list is partial and nothing was removed from it.</strong>}
              </p>
            )}
          </section>
          <Tabs.Root value={tab} onValueChange={setTab}>
            <Tabs.List className="tabs" aria-label="Asset sections">
              <Tabs.Trigger className="tab" value="inventory">
                Inventory
              </Tabs.Trigger>
              <Tabs.Trigger className="tab" value="checks">
                Naming and folders
              </Tabs.Trigger>
              <Tabs.Trigger className="tab" value="register">
                Asset register
              </Tabs.Trigger>
              <Tabs.Trigger className="tab" value="briefs">
                Briefs
              </Tabs.Trigger>
            </Tabs.List>
            <Tabs.Content value="inventory" forceMount hidden={tab !== 'inventory'}>
              <InventoryTab projectId={selected.id} refreshKey={refresh} scanned={scan !== null && scan !== undefined} onChanged={bump} />
            </Tabs.Content>
            <Tabs.Content value="checks" forceMount hidden={tab !== 'checks'}>
              <ChecksTab key={refresh} projectId={selected.id} />
            </Tabs.Content>
            <Tabs.Content value="register" forceMount hidden={tab !== 'register'}>
              <RegisterTab projectId={selected.id} />
            </Tabs.Content>
            <Tabs.Content value="briefs" forceMount hidden={tab !== 'briefs'}>
              <section className="card">
                <AssetsPanel projectId={selected.id} assets={tracked} onChanged={bump} />
              </section>
            </Tabs.Content>
          </Tabs.Root>
        </>
  );
}
