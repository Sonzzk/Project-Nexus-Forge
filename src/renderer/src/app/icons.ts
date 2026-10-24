import {
  Boxes,
  BookOpen,
  Bot,
  ClipboardList,
  FlaskConical,
  FolderKanban,
  GitBranch,
  LayoutDashboard,
  ListChecks,
  Plug,
  ScrollText,
  Settings,
  type LucideIcon,
} from 'lucide-react';
import type { NavSection } from '@shared/feature-status';

export const SECTION_ICONS: Record<NavSection, LucideIcon> = {
  dashboard: LayoutDashboard,
  projects: FolderKanban,
  workbench: Bot,
  tasks: ListChecks,
  context: BookOpen,
  git: GitBranch,
  testing: FlaskConical,
  assets: Boxes,
  integrations: Plug,
  activity: ScrollText,
  settings: Settings,
  status: ClipboardList,
};
