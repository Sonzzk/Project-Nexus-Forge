import { FEATURES, stateLabel, type FeatureStatus } from '@shared/feature-status';
import { useNav } from '../../app/navigation';
import { PROJECT_TYPE_LABELS } from '@shared/projects';
import { useActivity } from '../../lib/activity';
import { useProjects } from '../../lib/projects';
import { ActivityRows } from '../ActivityRows';

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
        {CARDS.filter((feature) => feature.state !== 'available').map((feature) => (
          <UpcomingCard key={feature.id} feature={feature} />
        ))}
      </div>
    </div>
  );
}
