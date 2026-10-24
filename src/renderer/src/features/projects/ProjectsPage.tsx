import { useState } from 'react';
import { AlertDialog } from 'radix-ui';
import {
  PROJECT_STATUSES,
  PROJECT_TYPES,
  PROJECT_TYPE_LABELS,
  type Project,
  type ProjectType,
} from '@shared/projects';
import { formatTime } from '../../lib/activity';
import { useProjects } from '../../lib/projects';

const STATUS_LABELS = { active: 'Active', paused: 'Paused', archived: 'Archived' } as const;

function ProjectDetail({ project }: { project: Project }) {
  const { update, redetect, remove } = useProjects();
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const [tags, setTags] = useState(project.tags.join(', '));
  const [instructions, setInstructions] = useState(project.instructions);
  const [status, setStatus] = useState(project.status);
  const [typeChoice, setTypeChoice] = useState<ProjectType | 'detected'>(
    project.typeSource === 'manual' ? project.type : 'detected',
  );
  const [saved, setSaved] = useState(false);

  const detected = project.detection;
  const save = async (): Promise<void> => {
    const result = await update({
      id: project.id,
      name: name.trim() === '' ? project.name : name,
      description,
      tags: tags
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
      instructions,
      status,
      typeOverride: typeChoice === 'detected' ? null : typeChoice,
    });
    setSaved(result !== undefined);
  };

  return (
    <section className="card" aria-label={`Details of ${project.name}`}>
      <div className="card__head">
        <h2>{project.name}</h2>
        {!project.folderExists && (
          <span className="badge" role="status">
            Folder not found
          </span>
        )}
      </div>

      <dl className="facts">
        <dt>Folder</dt>
        <dd className="mono">{project.rootPath}</dd>
        <dt>Type</dt>
        <dd>
          {PROJECT_TYPE_LABELS[project.type]}
          {project.engineVersion !== undefined && ` ${project.engineVersion}`}
          {project.typeSource === 'manual'
            ? ' · set by you'
            : detected === undefined
              ? ''
              : ` · ${detected.confidence === 'confirmed' ? 'confirmed from files' : 'inferred from files'}`}
        </dd>
        <dt>Added</dt>
        <dd>{formatTime(project.createdAt)}</dd>
      </dl>

      {detected !== undefined && (
        <details>
          <summary>Evidence from the folder ({detected.evidence.length})</summary>
          <ul className="evidence">
            {detected.evidence.map((item) => (
              <li key={`${item.path}:${item.detail}`}>
                <span className="mono">{item.path}</span> <span className="muted">· {item.detail}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="form">
        <label>
          Name
          <input value={name} maxLength={120} onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          Description
          <input
            value={description}
            maxLength={2000}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        <label>
          Tags <span className="muted">(separated by commas)</span>
          <input value={tags} onChange={(event) => setTags(event.target.value)} />
        </label>
        <label>
          Status
          <select
            value={status}
            onChange={(event) =>
              setStatus(PROJECT_STATUSES.find((s) => s === event.target.value) ?? 'active')
            }
          >
            {PROJECT_STATUSES.map((value) => (
              <option key={value} value={value}>
                {STATUS_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Project type
          <select
            value={typeChoice}
            onChange={(event) =>
              setTypeChoice(PROJECT_TYPES.find((t) => t === event.target.value) ?? 'detected')
            }
          >
            <option value="detected">
              Detected from files{detected === undefined ? '' : ` (${PROJECT_TYPE_LABELS[detected.type]})`}
            </option>
            {PROJECT_TYPES.map((value) => (
              <option key={value} value={value}>
                {PROJECT_TYPE_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Instructions for AI agents <span className="muted">(kept with the project)</span>
          <textarea
            value={instructions}
            rows={4}
            maxLength={20000}
            onChange={(event) => setInstructions(event.target.value)}
          />
        </label>
      </div>

      <div className="actions">
        <button type="button" className="btn btn--primary" onClick={() => void save()}>
          Save changes
        </button>
        <button
          type="button"
          className="btn"
          disabled={!project.folderExists}
          onClick={() => void redetect(project.id)}
        >
          Read the files again
        </button>
        <AlertDialog.Root>
          <AlertDialog.Trigger asChild>
            <button type="button" className="btn btn--danger">
              Remove from the registry
            </button>
          </AlertDialog.Trigger>
          <AlertDialog.Portal>
            <AlertDialog.Overlay className="overlay" />
            <AlertDialog.Content className="palette dialog">
              <AlertDialog.Title>Remove “{project.name}”?</AlertDialog.Title>
              <AlertDialog.Description className="muted">
                This only makes the app forget the project. Its folder and every file in it stay exactly as
                they are.
              </AlertDialog.Description>
              <div className="actions">
                <AlertDialog.Cancel asChild>
                  <button type="button" className="btn">
                    Keep it
                  </button>
                </AlertDialog.Cancel>
                <AlertDialog.Action asChild>
                  <button type="button" className="btn btn--danger" onClick={() => void remove(project.id)}>
                    Remove
                  </button>
                </AlertDialog.Action>
              </div>
            </AlertDialog.Content>
          </AlertDialog.Portal>
        </AlertDialog.Root>
        <span role="status" className="muted">
          {saved ? 'Saved.' : ''}
        </span>
      </div>
    </section>
  );
}

export function ProjectsPage() {
  const { projects, loaded, error, selected, select, add } = useProjects();
  const [openId, setOpenId] = useState<string | undefined>();
  const open = projects.find((project) => project.id === openId) ?? selected ?? projects[0];

  return (
    <div className="page">
      <header className="page__head">
        <h1>Projects</h1>
        <p className="muted">
          Register the folders you work in. The app reads them to recognize their type and never changes them.
        </p>
      </header>
      <div className="actions">
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => void add().then((project) => project && setOpenId(project.id))}
        >
          Add a project…
        </button>
      </div>
      {error !== undefined && (
        <p role="alert">
          {error.message} {error.hint}
        </p>
      )}
      {loaded && projects.length === 0 && (
        <p className="empty">
          No projects yet. Choose “Add a project…” and pick the folder of a game or tool you are working on.
        </p>
      )}
      <div className="split">
        <ul className="rows" aria-label="Registered projects">
          {projects.map((project) => (
            <li key={project.id}>
              <div className="project-row" aria-current={project.id === selected?.id ? 'true' : undefined}>
                <button
                  type="button"
                  className="row row--project"
                  aria-pressed={project.id === open?.id}
                  onClick={() => setOpenId(project.id)}
                >
                  <span
                    className="dot"
                    data-severity={project.folderExists && project.status === 'active' ? 'info' : 'warning'}
                  />
                  <span>{PROJECT_TYPE_LABELS[project.type]}</span>
                  <span className="row__summary">
                    <strong>{project.name}</strong>
                    {project.status !== 'active' && (
                      <span className="muted"> · {STATUS_LABELS[project.status]}</span>
                    )}
                    {!project.folderExists && <span className="muted"> · folder not found</span>}
                  </span>
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={project.id === selected?.id}
                  onClick={() => select(project.id)}
                  aria-label={
                    project.id === selected?.id ? `${project.name} is selected` : `Select ${project.name}`
                  }
                >
                  {project.id === selected?.id ? 'Selected' : 'Select'}
                </button>
              </div>
            </li>
          ))}
        </ul>
        {open !== undefined && <ProjectDetail key={open.id} project={open} />}
      </div>
    </div>
  );
}
