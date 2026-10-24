import { useState } from 'react';
import { Tabs } from 'radix-ui';
import type { DocType } from '@shared/context';
import { useProjects } from '../../lib/projects';
import { HandoffsTab } from './HandoffsTab';
import { MemoryTab } from './MemoryTab';
import { PacksTab } from './PacksTab';

/** Project Context (spec §7, §8): project memory, context packs and session handoffs for the selected project. */
export function ContextPage() {
  const { selected } = useProjects();
  const [tab, setTab] = useState('memory');
  const [preload, setPreload] = useState<{ type: DocType; content: string } | undefined>();

  return (
    <div className="page">
      <header className="page__head">
        <h1>Project Context</h1>
        <p className="muted">
          What an AI agent (or you, next week) needs to pick up the project: its notes, a focused selection of files for one task, and a handoff for the next session.
        </p>
      </header>
      {selected === undefined ? (
        <p className="empty">Select a project to see its memory, context packs and handoffs.</p>
      ) : (
        <Tabs.Root value={tab} onValueChange={setTab}>
          <Tabs.List className="tabs" aria-label="Project context sections">
            <Tabs.Trigger className="tab" value="memory">
              Project memory
            </Tabs.Trigger>
            <Tabs.Trigger className="tab" value="packs">
              Context packs
            </Tabs.Trigger>
            <Tabs.Trigger className="tab" value="handoffs">
              Session handoffs
            </Tabs.Trigger>
          </Tabs.List>
          <Tabs.Content value="memory" forceMount hidden={tab !== 'memory'}>
            <MemoryTab key={selected.id} project={selected} preload={preload} />
          </Tabs.Content>
          <Tabs.Content value="packs" forceMount hidden={tab !== 'packs'}>
            <PacksTab key={selected.id} project={selected} />
          </Tabs.Content>
          <Tabs.Content value="handoffs" forceMount hidden={tab !== 'handoffs'}>
            <HandoffsTab
              key={selected.id}
              project={selected}
              onUseAsDocument={(type, content) => {
                setPreload({ type, content });
                setTab('memory');
              }}
            />
          </Tabs.Content>
        </Tabs.Root>
      )}
    </div>
  );
}
