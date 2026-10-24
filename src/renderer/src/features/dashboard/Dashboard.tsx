import { useEffect, useRef, useState } from 'react';
import type { Handoff } from '@shared/context';
import { STATUS_TEXT } from '@shared/providers';
import { ROLE_LABELS, STATUS_LABELS } from '@shared/tasks';
import { RUN_STATE_LABELS } from '@shared/agents';
import { useQueue } from '../../lib/queue';
import { describeUsage, limitText, useUsage } from '../../lib/usage';
import { formatTime } from '../../lib/activity';
import { FEATURES, stateLabel, type FeatureStatus } from '@shared/feature-status';
import { useNav } from '../../app/navigation';
import { PROJECT_TYPE_LABELS } from '@shared/projects';
import { useActivity } from '../../lib/activity';
import { useProjects } from '../../lib/projects';
import { ActivityRows } from '../ActivityRows';
import { GitFacts, useGitSummary } from '../git/GitPage';

const CARDS = FEATURES.filter((feature) => feature.kind === 'card');

// What each card will show once its step lands. Until then it says so and shows no numbers.
const EMPTY_TEXT: Record<string, string> = {
  'card.projects': 'Registered projects, their type and status appear here.',
  'card.current-task': 'The current task and milestone, with progress from stored tasks only.',
  'card.git': 'Branch, uncommitted changes and recent commits of the selected project.',
  'card.tests': 'The latest test run and its result.',
  'card.handoff': 'The most recent session handoff for the selected project.',
  'card.next-action': 'An explained recommendation for what to work on next.',
};

function UpcomingCard({ feature }: { feature: FeatureStatus }) {
  return (
    <section className="card" aria-label={feature.label} data-feature={feature.id}>
      <div className="card__head">
        <h2>{feature.label}</h2>
        <span className="badge">{stateLabel(feature)}</span>
      </div>
      <p className="empty">{EMPTY_TEXT[feature.id] ?? 'Not built yet.'}</p>
    </section>
  );
}

function ProjectsCard() {
  const { projects, loaded, selected, select, add } = useProjects();
  const { go } = useNav();
  return (
    <section className="card" aria-label="Projects" data-feature="card.projects">
      <div className="card__head">
        <h2>Projects</h2>
        <button type="button" className="btn" onClick={() => go('projects')}>
          Manage
        </button>
      </div>
      {loaded && projects.length === 0 ? (
        <>
          <p className="empty">No projects registered yet.</p>
          <div>
            <button type="button" className="btn btn--primary" onClick={() => void add()}>
              Add a project…
            </button>
          </div>
        </>
      ) : (
        <ul className="rows" aria-label="Projects on the dashboard">
          {projects.slice(0, 6).map((project) => (
            <li key={project.id}>
              <button
                type="button"
                className="row row--card"
                aria-pressed={project.id === selected?.id}
                onClick={() => select(project.id)}
              >
                <span
                  className="dot"
                  data-severity={project.folderExists && project.status === 'active' ? 'info' : 'warning'}
                />
                <span className="row__summary">
                  <strong>{project.name}</strong>{' '}
                  <span className="muted">· {PROJECT_TYPE_LABELS[project.type]}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function GitCard() {
  const { selected } = useProjects();
  const { go } = useNav();
  const { git, error } = useGitSummary(selected?.id);
  return (
    <section className="card" aria-label="Recent changes" data-feature="card.git">
      <div className="card__head">
        <h2>Recent changes</h2>
        <button type="button" className="btn" onClick={() => go('git')}>
          Open
        </button>
      </div>
      {selected === undefined && <p className="empty">Select a project to see its branch and recent commits.</p>}
      {error !== undefined && (
        <p role="alert">
          {error.message} {error.hint}
        </p>
      )}
      {git !== undefined && <GitFacts git={git} />}
    </section>
  );
}

/** Running and waiting runs of the selected project, straight from the queue (spec §5: active agent sessions). */
function AgentSessionsCard() {
  const { selected } = useProjects();
  const { go } = useNav();
  const { view, error } = useQueue(selected?.id);
  const busy = (view?.runs ?? []).filter((run) => run.requestedAt !== null || run.hold !== '' || run.state === 'planning' || run.state === 'running');
  return (
    <section className="card" aria-label="Active agent sessions" data-feature="card.agent-sessions">
      <div className="card__head">
        <h2>Active agent sessions</h2>
        <button type="button" className="btn" onClick={() => go('workbench')}>
          Open
        </button>
      </div>
      {selected === undefined && <p className="empty">Select a project to see its agent runs.</p>}
      {error !== undefined && (
        <p role="alert">
          {error.message} {error.hint}
        </p>
      )}
      {view !== undefined && busy.length === 0 && <p className="empty">No agent run is running or waiting.</p>}
      {view?.lock != null && !view.lock.active && <p role="note">A writer lock from an interrupted run is still held. Check it on the AI Workbench.</p>}
      <ul className="rows" aria-label="Running and waiting runs">
        {busy.slice(0, 6).map((run) => (
          <li key={run.id}>
            <strong>{ROLE_LABELS[run.role]}</strong> <span className="muted">· {run.taskTitle} · {RUN_STATE_LABELS[run.state]}</span>
            {run.hold !== '' && <div className="muted">{run.hold}</div>}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** What the app sent today, against the launch limits. Numbers appear only where a provider returned them. */
function UsageCard() {
  const { selected } = useProjects();
  const { go } = useNav();
  const { summary } = useUsage(selected?.id);
  return (
    <section className="card" aria-label="Usage and limits" data-feature="card.usage">
      <div className="card__head">
        <h2>Usage and limits</h2>
        <button type="button" className="btn" onClick={() => go('integrations')}>
          Open
        </button>
      </div>
      {summary === undefined ? (
        <p className="empty">Loading…</p>
      ) : (
        <dl className="facts">
          <dt>Sent today</dt>
          <dd>
            {summary.today.launches} ({summary.today.cloudLaunches} to the cloud){summary.today.blocked > 0 && `, ${summary.today.blocked} stopped by a limit`}
          </dd>
          <dt>Cloud launches</dt>
          <dd>{limitText(summary.limits.perDay)} today</dd>
          {summary.limits.perProject !== null && (
            <>
              <dt>This project</dt>
              <dd>{limitText(summary.limits.perProject)} today</dd>
            </>
          )}
          <dt>Usage</dt>
          <dd>{describeUsage(summary.today)}</dd>
        </dl>
      )}
    </section>
  );
}

function HandoffCard() {
  const { selected } = useProjects();
  const { go } = useNav();
  const [latest, setLatest] = useState<Handoff | null | undefined>(undefined);
  const projectId = selected?.id;
  useEffect(() => {
    if (projectId === undefined) return;
    let cancelled = false;
    void window.api.invoke('handoffs:latest', { projectId }).then((result) => {
      if (!cancelled) setLatest(result.ok ? result.value : null);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId]);
  const shown = projectId === undefined ? undefined : latest;
  const firstLine = (text: string): string => text.trim().split('\n')[0] ?? '';
  return (
    <section className="card" aria-label="Latest session handoff" data-feature="card.handoff">
      <div className="card__head">
        <h2>Latest session handoff</h2>
        <button type="button" className="btn" onClick={() => go('context')}>
          Open
        </button>
      </div>
      {selected === undefined && <p className="empty">Select a project to see its latest handoff.</p>}
      {selected !== undefined && shown === null && <p className="empty">No handoff saved for this project yet.</p>}
      {shown && (
        <dl className="facts">
          <dt>Saved</dt>
          <dd>{formatTime(shown.createdAt)}</dd>
          {firstLine(shown.requested) !== '' && (
            <>
              <dt>Requested</dt>
              <dd>{firstLine(shown.requested)}</dd>
            </>
          )}
          {firstLine(shown.unfinished) !== '' && (
            <>
              <dt>Unfinished</dt>
              <dd>{firstLine(shown.unfinished)}</dd>
            </>
          )}
          <dt>Next</dt>
          <dd>{firstLine(shown.nextTask) || 'Not recorded'}</dd>
        </dl>
      )}
    </section>
  );
}

function useJson<T>(key: string | undefined, load: (key: string) => Promise<{ ok: true; value: T } | { ok: false }>): T | undefined {
  const [value, setValue] = useState<{ key: string; value: T } | undefined>();
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });
  useEffect(() => {
    if (key === undefined) return;
    let cancelled = false;
    void loadRef.current(key).then((result) => {
      if (!cancelled && result.ok) setValue({ key, value: result.value });
    });
    return () => {
      cancelled = true;
    };
  }, [key]);
  return value?.key === key ? value?.value : undefined;
}

function CurrentTaskCard() {
  const { selected } = useProjects();
  const { go } = useNav();
  const projectId = selected?.id;
  const tasks = useJson(projectId, (id) => window.api.invoke('tasks:list', { projectId: id }));
  const milestones = useJson(projectId, (id) => window.api.invoke('milestones:list', { projectId: id }));
  const risks = useJson(projectId, (id) => window.api.invoke('risks:list', { projectId: id }));
  const current = milestones?.find((m) => m.status === 'active') ?? milestones?.find((m) => m.status === 'planned');
  const active = tasks?.filter((t) => t.children === 0 && ['in-progress', 'review', 'testing'].includes(t.status)) ?? [];
  const blocked = tasks?.filter((t) => t.status === 'blocked') ?? [];
  const open = (kind: string): number => risks?.filter((r) => r.kind === kind && r.status === 'open').length ?? 0;
  return (
    <section className="card" aria-label="Current task and milestone" data-feature="card.current-task">
      <div className="card__head">
        <h2>Current task and milestone</h2>
        <button type="button" className="btn" onClick={() => go('tasks')}>
          Open
        </button>
      </div>
      {selected === undefined && <p className="empty">Select a project to see its milestone and tasks.</p>}
      {selected !== undefined && tasks !== undefined && (
        <dl className="facts">
          <dt>Milestone</dt>
          <dd>
            {current === undefined
              ? 'None yet'
              : `${current.title} · ${current.progress.percent === null ? 'no tasks yet' : `${current.progress.done} of ${current.progress.total} done (${current.progress.percent}%)`}`}
          </dd>
          <dt>Active</dt>
          <dd>{active.length === 0 ? 'Nothing in progress' : active.map((t) => `${t.title} (${STATUS_LABELS[t.status]})`).join(', ')}</dd>
          <dt>Blocked</dt>
          <dd>{blocked.length === 0 ? 'None' : blocked.map((t) => t.title).join(', ')}</dd>
          <dt>Open</dt>
          <dd>
            {open('bug')} bugs · {open('risk')} risks
          </dd>
        </dl>
      )}
    </section>
  );
}

function ProvidersCard() {
  const { go } = useNav();
  const providers = useJson('all', () => window.api.invoke('providers:list', {}));
  return (
    <section className="card" aria-label="Provider connectivity" data-feature="card.providers">
      <div className="card__head">
        <h2>Provider connectivity</h2>
        <button type="button" className="btn" onClick={() => go('integrations')}>
          Open
        </button>
      </div>
      <ul className="rows" aria-label="Providers at a glance">
        {providers?.map((p) => (
          <li key={p.id} className="row row--card">
            <span className="dot" data-severity={p.status === 'working' || p.status === 'installed' ? 'info' : 'warning'} />
            <span className="row__summary">
              <strong>{p.label}</strong> <span className="muted">· {STATUS_TEXT[p.status]}{p.version === null ? '' : ` ${p.version}`}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function NextActionCard() {
  const { selected } = useProjects();
  const { go } = useNav();
  const projectId = selected?.id;
  const next = useJson(projectId, (id) => window.api.invoke('tasks:recommend', { projectId: id }));
  const top = next?.items[0];
  return (
    <section className="card" aria-label="Next recommended action" data-feature="card.next-action">
      <div className="card__head">
        <h2>Next recommended action</h2>
        <button type="button" className="btn" onClick={() => go('tasks')}>
          Open
        </button>
      </div>
      {selected === undefined && <p className="empty">Select a project to get a recommendation.</p>}
      {selected !== undefined && next !== undefined && top === undefined && <p className="empty">{next.message}</p>}
      {top !== undefined && (
        <>
          <p>
            <strong>{top.task.title}</strong>
          </p>
          <p className="muted">Why: {top.reasons.join('; ')}.</p>
        </>
      )}
    </section>
  );
}

function PortfolioCard() {
  const { select } = useProjects();
  const { go } = useNav();
  const entries = useJson('all', () => window.api.invoke('tasks:portfolio', {}));
  return (
    <section className="card" aria-label="Portfolio" data-feature="card.portfolio">
      <div className="card__head">
        <h2>Portfolio</h2>
      </div>
      {entries !== undefined && entries.length === 0 && <p className="empty">No projects registered yet.</p>}
      <ul className="rows" aria-label="Projects at a glance">
        {entries?.map((entry) => (
          <li key={entry.projectId}>
            <button
              type="button"
              className="row row--card"
              onClick={() => {
                select(entry.projectId);
                go('tasks');
              }}
            >
              <span className="dot" data-severity={entry.projectStatus === 'active' ? 'info' : 'warning'} />
              <span className="row__summary">
                <strong>{entry.name}</strong>{' '}
                <span className="muted">
                  · {entry.projectStatus !== 'active' ? `${entry.projectStatus} · ` : ''}
                  {entry.progress.percent === null ? 'no tasks yet' : `${entry.progress.done} of ${entry.progress.total} done (${entry.progress.percent}%)`}
                  {entry.currentMilestone === null ? '' : ` · ${entry.currentMilestone}`}
                  {entry.openBugs + entry.openRisks > 0 ? ` · ${entry.openBugs} bugs, ${entry.openRisks} risks` : ''}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Dashboard() {
  const { events, loading, error } = useActivity(8);
  const { selected, select } = useNav();
  return (
    <div className="page">
      <header className="page__head">
        <h1>Dashboard</h1>
        <p className="muted">
          What is happening in the app. Cards marked Upcoming fill in as their steps are built.
        </p>
      </header>
      <div className="cards">
        <section className="card card--wide" aria-label="Recent activity" data-feature="card.recent-activity">
          <div className="card__head">
            <h2>Recent activity</h2>
          </div>
          {error !== undefined && (
            <p role="alert">
              {error.message} {error.hint}
            </p>
          )}
          {loading && error === undefined && <p className="empty">Loading…</p>}
          {!loading && events.length === 0 && error === undefined && (
            <p className="empty">Nothing has happened yet.</p>
          )}
          {events.length > 0 && <ActivityRows events={events} selectedId={selected?.id} onSelect={select} />}
        </section>
        <ProjectsCard />
        <GitCard />
        <HandoffCard />
        <AgentSessionsCard />
        <UsageCard />
        <CurrentTaskCard />
        <NextActionCard />
        <ProvidersCard />
        <PortfolioCard />
        {CARDS.filter((feature) => feature.state !== 'available').map((feature) => (
          <UpcomingCard key={feature.id} feature={feature} />
        ))}
      </div>
    </div>
  );
}
