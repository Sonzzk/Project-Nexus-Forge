/** Sliding-window limiter: at most `max` calls to `tryTake()` per `windowMs`. */
export function createRateLimiter(options: { max: number; windowMs: number; now?: () => number }): {
  tryTake(): boolean;
} {
  const now = options.now ?? Date.now;
  const taken: number[] = [];
  return {
    tryTake() {
      const t = now();
      while (taken.length > 0 && (taken[0] ?? 0) <= t - options.windowMs) taken.shift();
      if (taken.length >= options.max) return false;
      taken.push(t);
      return true;
    },
  };
}
