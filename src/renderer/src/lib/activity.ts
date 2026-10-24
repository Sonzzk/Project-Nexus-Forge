import { useEffect, useState } from 'react';
import type { ActivityEvent } from '@shared/activity';
import type { SerializedError } from '@shared/errors';

/** The newest `limit` activity events, kept current by the `activity:appended` event from main. */
export function useActivity(limit: number): {
  events: ActivityEvent[];
  loading: boolean;
  error: SerializedError | undefined;
} {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<SerializedError | undefined>();

  useEffect(() => {
    let cancelled = false;
    const stop = window.api.on('activity:appended', (event) => {
      setEvents((current) =>
        current.some((e) => e.id === event.id) ? current : [event, ...current].slice(0, limit),
      );
    });
    void window.api.invoke('activity:list', { limit }).then((result) => {
      if (cancelled) return;
      setLoading(false);
      if (result.ok)
        setEvents((current) =>
          [...current, ...result.value.filter((e) => !current.some((c) => c.id === e.id))].slice(0, limit),
        );
      else setError(result.error);
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, [limit]);

  return { events, loading, error };
}

export const formatTime = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
};
