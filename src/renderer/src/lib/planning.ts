import { useCallback, useEffect, useState } from 'react';
import type { IpcResult, SerializedError } from '@shared/errors';
import type { Milestone, Recommendations, Risk, Task } from '@shared/tasks';

// Everything the Tasks page shows for one project, loaded together and reloaded after every change made through `call`.

export interface PlanningApi {
  tasks: Task[];
  milestones: Milestone[];
  risks: Risk[];
  next: Recommendations | undefined;
  loaded: boolean;
  /** The last failure, in the words main gave it; cleared by the next success. */
  error: SerializedError | undefined;
  /** Runs one call, shows its error if it fails, and reloads everything if it works. */
  call: <T>(run: () => Promise<IpcResult<T>>) => Promise<T | undefined>;
}

export function usePlanning(projectId: string): PlanningApi {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [risks, setRisks] = useState<Risk[]>([]);
  const [next, setNext] = useState<Recommendations | undefined>();
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<SerializedError | undefined>();
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      window.api.invoke('tasks:list', { projectId }),
      window.api.invoke('milestones:list', { projectId }),
      window.api.invoke('risks:list', { projectId }),
      window.api.invoke('tasks:recommend', { projectId }),
    ]).then(([t, m, r, n]) => {
      if (cancelled) return;
      if (t.ok) setTasks(t.value);
      else setError(t.error);
      if (m.ok) setMilestones(m.value);
      if (r.ok) setRisks(r.value);
      if (n.ok) setNext(n.value);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, version]);

  const call = useCallback(async <T,>(run: () => Promise<IpcResult<T>>): Promise<T | undefined> => {
    const result = await run();
    if (!result.ok) {
      setError(result.error);
      return undefined;
    }
    setError(undefined);
    setVersion((n) => n + 1);
    return result.value;
  }, []);

  return { tasks, milestones, risks, next, loaded, error, call };
}
