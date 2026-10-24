import { useEffect, useState } from 'react';
import type { Handoff } from '@shared/context';
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
  'card.agent-sessions': 'Running and recent agent sessions appear here.',
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
        {CARDS.filter((feature) => feature.state !== 'available').map((feature) => (
          <UpcomingCard key={feature.id} feature={feature} />
        ))}
      </div>
    </div>
  );
}
