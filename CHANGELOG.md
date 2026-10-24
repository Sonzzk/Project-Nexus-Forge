# Changelog

Meaningful changes, newest first. Each step is tagged `step-NN` in Git.

## Unreleased

### Added
- `assets/icon/nexus-ai.png` and multi-size `nexus-ai.ico`: the Nexus AI app icon, used as the window icon since Step 3 (Step 27 uses it for the installer).

## Step 12 · Provider integrations (2026-10-24, tag `step-12`)

### Added
- A typed provider contract and real adapters for Ollama (its documented local API: version, models with context length, load, streaming generation, cancel, timeouts, download with progress after a confirmation), Claude Code and Codex CLI (non-interactive, read-only runs with the prompt on stdin; capabilities read from the installed version's own options). Missing or stopped tools get clear messages, never fake success.
- The Integrations page and a dashboard Provider connectivity card. Usage and quota show "Unavailable from this provider" unless the provider returns them.
- First uses: "Suggest steps with AI" in the feature breakdown and "Draft with AI" in the memory editor. You pick the provider; a cloud provider shows where the text goes and asks first; results appear for review and nothing is created or saved automatically.
- Schema v7, nine channels and one event, four settings. Decision D-037, known issue KI-016.

## Step 11 · Agent roles and workflows (2026-10-24, tag `step-11`)

### Added
- The six agent roles of spec §11 with their purpose, expected output, permission (only the implementer can change files) and prompt template; a prompt preview that uses only the task's own fields.
- Workflow templates (plan only; plan, approve, implement with an optional reviewer and an optional QA step; documentation; asset or level brief) shown with each step's action, provider and blocker before anything exists, and saved as queued run records. The visible run states (queued, planning, awaiting approval, running, awaiting review, testing, completed, failed, cancelled) with a tested state machine.
- An Agent work section in the task detail; the Run button stays disabled and labeled Upcoming until Steps 12 and 13. This step starts no program and sends nothing.
- Schema v6, six channels, export of runs and history. Decision D-036, known issue KI-015.

## Step 10 · Task management (2026-10-24, tag `step-10`)

### Added
- Tasks and Roadmap: tasks with every field of spec §10 and a real lifecycle (Inbox, Planned, Ready, In progress, Review, Testing, Done, plus Blocked, Cancelled, Failed) where only valid moves are offered; dependencies that cannot loop; milestones with scope tiers; a board, a list and a milestone roadmap over the same stored tasks; notes; an optional plan-approval gate; nine task templates; a manual breakdown of a feature into chained steps; an explained next-task recommendation; and a bugs and risks register.
- Progress counted only from stored tasks (no tasks, no percentage), milestone snapshots, and a portfolio across projects. Dashboard cards: Current task and milestone, Next recommended action, Portfolio.
- Schema v5, 22 channels, settings `tasks.requirePlanApproval` and `tasks.view`, export of all planning tables (with a whole-graph loop check on import). Decision D-035, known issue KI-014.

## Step 9 · Context and session handoffs (2026-10-24, tag `step-09`)

### Added
- Project Context page: project memory (the ten documents of spec §8, stored in the app by default or, only after a diff preview and a native confirmation, in the project folder or a documentation folder inside it), context packs (a task-focused selection with a reason for every file and every exclusion, a full preview, saved packs that say when they are out of date) and session handoffs (the seven fields, drafted from Git and the latest audit).
- The dashboard Latest session handoff card; the Git and audit facts feed the handoff draft.
- Schema v4 (`memory_settings`, `project_docs`, `context_packs`, `handoffs`), 15 channels, setting `context.defaultBudget`, export registration for all four tables. Decision D-034, known issue KI-013.

## Step 8 · Persistent storage (2026-10-24, tag `step-08`)

### Added
- Data and backups in Settings: back up now, optional scheduled backups with a retention cap, restore (asks first, saves the current data first, restarts with the chosen backup), export to a versioned JSON file, import with a preview and conflict choice.
- A recovery dialog at start-up for a damaged or newer database (restore the newest usable backup, open the backups folder, start a new database, quit); nothing is ever deleted.
- A table-registration hook so later tables join export and import; `docs/DATA.md` (schema, backups, export format) and `docs/RECOVERY.md`.
- Settings `backup.scheduleEnabled`, `backup.intervalHours`, `backup.keepCount`; channels `storage:*`. Decision D-033.

## Step 7 · Project auditing (2026-10-24, tag `step-07`)

### Added
- A read-only audit of a registered project: engine and version, languages, major folders, entry points, documentation, build and test commands, assets, Git, TODO and FIXME items, file relationships, identical files, and risks. Every finding is marked Confirmed (with the file that proves it) or Inferred. Audits are stored with timestamps, can be run again, and the last ten are kept.
- A bounded scanner (file, depth and time limits; sensitive files, generated folders and links skipped) and a ProjectReader that refuses paths outside the project, sensitive and binary files.
- A read-only Git service (branch, ahead and behind, uncommitted changes, recent commits; "Not a Git repository." and missing Git handled), the Git and Changes page and the dashboard Recent changes card.
- Schema v3 (`audits`), channels `audit:*` and `git:summary`, settings `audit.maxFiles` and `audit.timeBudgetSeconds`. Decision D-032, known issue KI-012.

## Step 6 · Project registry (2026-10-24, tag `step-06`)

### Added
- Register existing folders as projects through a native folder picker, without moving or changing them. Type detection from real files (Unreal, Unity, Godot, Vite, other web, general code, Blender-only, unidentified) with the evidence stored and a manual override that can be undone.
- The Projects page, a working project switcher, the dashboard Projects card, the Add a project action; pause, archive, tags, instructions per project; remove from the registry with a confirmation.
- Schema v2 (`projects`, `project_detections`), channels `projects:*`, setting `projects.selectedId`, activity events for every change.
- 47 new tests, including a snapshot proof that no project file changes, and 3 end-to-end tests. Decision D-031.

## Step 5 · Dashboard and UI (2026-10-24, tag `step-05`)

### Added
- The application shell: dark design tokens with comfortable and compact density, a collapsible sidebar with the 11 sections of spec §5 plus Implementation Status, a top bar with an empty project switcher, a command palette (Ctrl+K), an inspector (Ctrl+J) with resizable panels, keyboard navigation and visible focus.
- The feature-status manifest and the Implementation Status page listing all 29 steps; unbuilt sections and cards say `Upcoming · Step N`.
- Real pages: Dashboard (recent activity, live), Activity and Logs, Settings (density, log level).
- Settings `ui.sidebarCollapsed`, `ui.inspectorOpen`, `ui.layout`; 20 new unit and component tests and 3 end-to-end tests; the fake `window.api` for component tests.
- Decision D-030.

### Changed
- The CSP allows Radix's one fixed scroll-lock style by hash.
- A packaged app has no default menu.

## Step 4 · Core application structure (2026-10-24, tag `step-04`)

### Added
- Typed IPC: channel registry, Zod request and response schemas, a handler wrapper (shutdown refusal, sender check, strict request parsing, validated response, error envelope), `window.api` with `invoke` and `on`, and five channels (`app:getInfo`, `app:reportRendererError`, `settings:get`, `settings:set`, `activity:list`). A contract test rejects request shapes that carry paths, commands or working directories.
- Typed errors (`AppError`, `ErrorCode`) with plain messages and hints.
- Logging: JSON-lines `logs\main.log` with rotation, a shared secret `Redactor`, the sensitive-path denylist (`isSensitivePath`), renderer error reporting (20 a minute), crash capture.
- SQLite through `node:sqlite`: schema v1 (`schema_migrations`, `settings`, `activity_events`, `process_runs`), a migrator with checksums, verified single-file backups before every migration of an existing database (newest ten kept), all-or-nothing migrations, integrity check on open, and refusal to touch a damaged or newer database.
- Settings store with defaults and fallback (`logging.level`, `ui.density`) and the activity log (`ActivityLog.record`, `app.started`, `app.stopped`).
- `ProcessRunner` (the only code that spawns): argument arrays, `.cmd` shim handling, timeout, output cap, cancel with process-tree kill, owner registry, `process_runs` records, cleanup on quit.
- Graceful shutdown coordinator (ordered steps, per-step and total deadlines, force kill at the ceiling).
- The window shows version, database schema, data folder and log file from `app:getInfo`.
- 206 unit and integration tests and 9 end-to-end tests; lint rules for module `index.ts` imports, `child_process`, `node:sqlite` and `fetch`.
- Zod 4.6.7; decision D-029; known issues KI-010 and KI-011.

### Changed
- KI-006 now records that `node:sqlite` is proven inside the built app.
- ARCHITECTURE.md gets section 17 (what Step 4 did and where it differs from the sketches).

## Step 3 · Project setup and scaffolding (2026-10-24, tag `step-03`)

### Added
- The Electron 45 + React 19 + TypeScript 6 + electron-vite 6 app, written by hand in the ARCHITECTURE.md layout: `src/main`, `src/preload`, `src/renderer`, `src/shared`. It opens a window with a placeholder page; there are no features yet.
- Secure window: context isolation, sandbox, no Node integration, `app://renderer` scheme with the CSP as header and meta tag, blocked navigation, new windows, webviews and permission requests, single-instance lock, data folder `%APPDATA%\GameDevCommandCenter` (`GDCC_USER_DATA_DIR` in dev and tests only). Empty frozen `window.api`.
- npm scripts `dev`, `build`, `typecheck`, `lint`, `format`, `test`, `test:e2e`, `check:docs`; strict TypeScript (three projects), ESLint with import boundaries, Prettier, Vitest and Playwright configs; `.gitignore`, `.npmrc` (`engine-strict`), pinned `package.json` and the committed lockfile.
- 23 unit tests (CSP text, renderer path resolver, navigation allowlist) and 6 end-to-end security tests on the built app.
- Decision D-028 and known issue KI-009.

### Changed
- `scripts/launch.cmd` now starts the real app (`npm run dev`).
- `README.md` has install and run instructions and the command table; `CLAUDE.md` quality gates use the npm scripts; ARCHITECTURE.md records what Step 3 did and where it differed from the checklist.
- KI-001 (Node.js 20) removed: a clean install, build, tests and the app run on Node 24.22.1.

## Step 2 · System design and dependencies (2026-10-24, tag `step-02`)

### Added
- `docs/ARCHITECTURE.md`: runtimes and pinned dependencies with license, source and verification date; process model; folder structure; owner folder and interface sketches for every spec §4 module; IPC design; security model covering every §4 and §14 rule; data model v1 with the migration and backup policy; feature-status manifest; error model; logging; process ownership and shutdown; testing strategy; risks; the Step 3 checklist.
- Decisions D-011 to D-027 (Electron 45, Node.js 24, electron-vite, `node:sqlite`, TypeScript 6.0, UI building blocks, logging, tests, packaging, IPC, `app://` scheme, data folder, Windows processes, Claude Code project hooks, migrations).
- Known issues KI-006 to KI-008.
- The docs check now verifies that every pinned dependency has an exact version, license, date, step and https source; that `package.json` (from Step 3) uses exactly the pinned versions; and that every §4 module has a `src/` folder and sketched interfaces. Seven new tests cover it.

### Changed
- `README.md`: what the app is, current status and where things are; the original text is kept.
- `CLAUDE.md`: points to ARCHITECTURE.md, adds the pinning and path/command rules and the end-to-end test gate.
- `docs/ROADMAP.md`: Step 3 now writes the scaffold by hand from ARCHITECTURE.md and checks Node.js 24 first.
- D-003 is accepted; KI-001 records the Node.js decision.

### After the `step-02` tag
- Installed Node.js 24.22.1 LTS on the PC with the user's approval (D-012 accepted, KI-001 fixed). The docs check and its 14 tests pass on it.

## Step 1 · Overall architecture and requirements (2026-10-24, tag `step-01`)

### Added
- `docs/MASTER_SPEC.md`: the full master specification and the user's 29-step table, verbatim, with a SHA-256 in `docs/MASTER_SPEC.sha256`.
- `docs/ROADMAP.md`: milestones, phase mapping, dependency map, step classification, ordering-conflict rules and a plan block for each of the 29 steps.
- `docs/REQUIREMENTS.md`: every spec section, every §27 and §29K acceptance criterion and the notes after the step table, mapped to owning steps.
- `CLAUDE.md`: permanent working rules for every build session.
- `docs/STATUS.md`, `docs/DECISIONS.md`, `docs/KNOWN_ISSUES.md` and this changelog.
- `scripts/check-docs.mjs` and its tests in `scripts/check-docs.test.mjs`.

### Changed
- `README.md`: added links to the project documents; the original text is kept.

### Fixed (after the `step-01` tag)
- `scripts/check-docs.test.mjs`: two tests failed on Windows checkouts with CRLF line endings; the test helper now normalizes line endings like the check does.
