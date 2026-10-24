// The 29 build steps (docs/ROADMAP.md) for the Implementation Status page (spec §27.11). A test compares this list with
// the roadmap's headings, so the titles cannot drift.

export const ROADMAP_STEPS: readonly { n: number; title: string }[] = [
  { n: 1, title: 'Overall architecture and requirements' },
  { n: 2, title: 'System design and dependencies' },
  { n: 3, title: 'Project setup and scaffolding' },
  { n: 4, title: 'Core application structure' },
  { n: 5, title: 'Dashboard and UI' },
  { n: 6, title: 'Project registry' },
  { n: 7, title: 'Project auditing' },
  { n: 8, title: 'Persistent storage' },
  { n: 9, title: 'Context and session handoffs' },
  { n: 10, title: 'Task management' },
  { n: 11, title: 'Agent roles and workflows' },
  { n: 12, title: 'Provider integrations' },
  { n: 13, title: 'Agent orchestration and routing' },
  { n: 14, title: 'Usage tracking and limits' },
  { n: 15, title: 'Safe execution and permissions' },
  { n: 16, title: 'Diff review and code changes' },
  { n: 17, title: 'Activity logs and monitoring' },
  { n: 18, title: 'UE5 integration' },
  { n: 19, title: 'Blender integration' },
  { n: 20, title: 'Godot integration' },
  { n: 21, title: 'Vite.js integration' },
  { n: 22, title: 'Asset management' },
  { n: 23, title: 'Testing and quality checks' },
  { n: 24, title: 'Customization and settings' },
  { n: 25, title: 'First-run setup and onboarding' },
  { n: 26, title: 'Complex reliability and integration review' },
  { n: 27, title: 'Documentation and packaging' },
  { n: 28, title: 'Final architecture and security audit' },
  { n: 29, title: 'Plugins, MCP servers, skills and automation' },
];

/** The last step that is finished and tagged. Each step bumps this in the same commit that completes it. */
export const COMPLETED_THROUGH_STEP = 7;
