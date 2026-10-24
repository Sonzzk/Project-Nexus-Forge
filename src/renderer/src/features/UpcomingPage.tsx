import { FEATURES, stateLabel, type NavSection } from '@shared/feature-status';
import { ROADMAP_STEPS } from '@shared/roadmap-steps';

/** The page behind a section that is not built yet: it says which step builds it and offers nothing that does not work. */
export function UpcomingPage({ section }: { section: NavSection }) {
  const feature = FEATURES.find((f) => f.kind === 'navigation' && f.section === section);
  if (feature === undefined) return null;
  const title = ROADMAP_STEPS.find((step) => step.n === feature.step)?.title;
  return (
    <div className="page">
      <header className="page__head">
        <h1>{feature.label}</h1>
        <p>
          <span className="badge">{stateLabel(feature)}</span>
        </p>
      </header>
      <p className="muted">
        This section is not built yet. It arrives in Step {feature.step}
        {title === undefined ? '' : ` (${title})`}. The Implementation Status page lists every step.
      </p>
    </div>
  );
}
