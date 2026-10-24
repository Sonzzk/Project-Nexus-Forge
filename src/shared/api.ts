// The object the preload script exposes as `window.api`. Empty on purpose in Step 3: Step 4 adds
// the two allowlisted functions (`invoke` and `on`), and nothing else may be added without an ADR.
export type Api = Readonly<Record<string, never>>;
