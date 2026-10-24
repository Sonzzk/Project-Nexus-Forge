import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { IpcResult, SerializedError } from '@shared/errors';
import type { Project, ProjectPatch } from '@shared/projects';
import { useSettings } from './settings';

// The registry lives in the main process; this keeps a copy for the pages, the project switcher and the dashboard.

interface ProjectsApi {
  projects: Project[];
  loaded: boolean;
  /** The last failure, in the words main gave it. Cleared by the next successful call. */
  error: SerializedError | undefined;
  /** The project the app is showing, or undefined. */
  selected: Project | undefined;
  select: (id: string | null) => void;
  /** Opens the native folder picker; the new project becomes the selected one. Resolves to it, or undefined if cancelled or refused. */
  add: () => Promise<Project | undefined>;
  update: (patch: ProjectPatch) => Promise<Project | undefined>;
  redetect: (id: string) => Promise<Project | undefined>;
  remove: (id: string) => Promise<boolean>;
}

const ProjectsContext = createContext<ProjectsApi | null>(null);

export function ProjectsProvider({ children }: { children: ReactNode }) {
  const { settings, set } = useSettings();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<SerializedError | undefined>();

  const apply = useCallback((result: IpcResult<Project[]>): void => {
    if (result.ok) setProjects(result.value);
    else setError(result.error);
    setLoaded(true);
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    apply(await window.api.invoke('projects:list', {}));
  }, [apply]);

  useEffect(() => {
    let cancelled = false;
    void window.api.invoke('projects:list', {}).then((result) => {
      if (!cancelled) apply(result);
    });
    return () => {
      cancelled = true;
    };
  }, [apply]);
  const run = useCallback(
    async <T,>(
      call: () => Promise<{ ok: true; value: T } | { ok: false; error: SerializedError }>,
    ): Promise<T | undefined> => {
      const result = await call();
      if (!result.ok) {
        setError(result.error);
        return undefined;
      }
      setError(undefined);
      await refresh();
      return result.value;
    },
    [refresh],
  );

  const selectedId = settings['projects.selectedId'];
  const selected = useMemo(
    () => projects.find((project) => project.id === selectedId),
    [projects, selectedId],
  );

  const api = useMemo<ProjectsApi>(
    () => ({
      projects,
      loaded,
      error,
      selected,
      select: (id) => set('projects.selectedId', id),
      add: async () => {
        const added = await run(() => window.api.invoke('projects:pickAndAdd', {}));
        if (added?.project == null) return undefined;
        set('projects.selectedId', added.project.id);
        return added.project;
      },
      update: (patch) => run(() => window.api.invoke('projects:update', patch)),
      redetect: (id) => run(() => window.api.invoke('projects:redetect', { id })),
      remove: async (id) => (await run(() => window.api.invoke('projects:remove', { id }))) !== undefined,
    }),
    [projects, loaded, error, selected, set, run],
  );

  return <ProjectsContext.Provider value={api}>{children}</ProjectsContext.Provider>;
}

export function useProjects(): ProjectsApi {
  const value = useContext(ProjectsContext);
  if (value === null) throw new Error('useProjects must be used inside ProjectsProvider.');
  return value;
}
