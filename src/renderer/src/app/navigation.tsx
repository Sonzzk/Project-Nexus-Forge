import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import type { ActivityEvent } from '@shared/activity';
import type { NavSection } from '@shared/feature-status';

// Eleven fixed sections in one window: a typed state is enough (D-017), no router library.

interface NavApi {
  section: NavSection;
  go: (section: NavSection) => void;
  /** The activity event shown in the inspector, if any. */
  selected: ActivityEvent | undefined;
  select: (event: ActivityEvent | undefined) => void;
}

const NavContext = createContext<NavApi | null>(null);

export function NavProvider({
  children,
  initial = 'dashboard',
}: {
  children: ReactNode;
  initial?: NavSection;
}) {
  const [section, go] = useState<NavSection>(initial);
  const [selected, select] = useState<ActivityEvent | undefined>();
  const value = useMemo(() => ({ section, go, selected, select }), [section, selected]);
  return <NavContext.Provider value={value}>{children}</NavContext.Provider>;
}

export function useNav(): NavApi {
  const value = useContext(NavContext);
  if (value === null) throw new Error('useNav must be used inside NavProvider.');
  return value;
}
