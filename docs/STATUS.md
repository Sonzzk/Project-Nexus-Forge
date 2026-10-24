# Status

**Current step:** Step 13 · Agent orchestration and routing: done (2026-10-24, tag `step-13`)
**Next step:** Step 14 · Usage tracking and limits (Sonnet · High), see [ROADMAP.md](ROADMAP.md#step-14--usage-tracking-and-limits).

## Completed
- **Step 1.** Spec preserved verbatim; dependency map, roadmap with 29 plan blocks and requirements trace written; CLAUDE.md and progress notes created; docs check added. Verified by `node scripts/check-docs.mjs` (passed) and `node --test scripts/check-docs.test.mjs` (7 of 7 passed, including tamper, forward-dependency, model-mismatch, missing-field and untraced-requirement cases). The spec's SHA-256 matches the text of the original request.
- **Step 2.** `docs/ARCHITECTURE.md` written; every dependency verified and pinned; decisions D-011 to D-027 recorded; docs check extended to dependency pins and module owners. Verified by `node scripts/check-docs.mjs` (passed) and `node --test scripts/check-docs.test.mjs` (14 of 14 passed, including the seven new negative cases).
- **Step 3.** Hand-written electron-vite scaffold (Electron 45, React 19, TypeScript 6, Vite 8): secure window on the `app://renderer` scheme with CSP, dev/build/typecheck/lint/test/e2e/docs scripts, README install steps. Verified by all six gates on the working tree and on a clean copy of the tracked files (`npm ci`, then every gate), and by starting the app through `scripts\launch.cmd`.
- **Step 4.** Typed IPC, errors, logging with redaction, SQLite with migrations and backups, settings store, activity log, process runner and shutdown coordinator (details in ARCHITECTURE.md section 17 and D-029). Verified by all six gates (below), by a clean copy of the tracked files, and by a real launch through `scripts\launch.cmd` and a clean window close.
- **Step 5.** The application shell: tokens and density, sidebar, top bar, command palette, inspector, resizable panels, feature-status manifest, Implementation Status page, dashboard with live recent activity, Activity and Settings pages (ARCHITECTURE.md section 18, D-030). Verified by all six gates and by looking at the real window (screenshots of the dashboard with the inspector open).

- **Step 6.** Project registry: register folders through a native picker, read-only type detection with stored evidence and a manual override, the Projects page, a working project switcher (ARCHITECTURE.md section 19, D-031). Verified by all six gates and a snapshot test showing no project file changes.
- **Step 7.** Read-only project audit (13 sections, every finding Confirmed with evidence or Inferred), bounded scanner, ProjectReader and path policy, read-only Git service, the audit panel, the Git and Changes page and the dashboard Recent changes card (ARCHITECTURE.md section 20, D-032). Verified by all six gates and a snapshot test showing no project file changes.
- **Step 8.** Backups (manual, scheduled, retention), restore that saves the current data first and swaps at the next start, a recovery dialog for a damaged or newer database, versioned JSON export and import with preview, conflict choice and native confirmations, a table-registration hook, `docs/DATA.md` and `docs/RECOVERY.md` (ARCHITECTURE.md section 21, D-033). Verified by all six gates and an end-to-end restore through a real restart.
- **Step 9.** Project memory (app database by default; project folder or a documentation folder inside it only after a diff preview and a native confirmation), context packs with reasons, exclusions, a full preview and staleness, session handoffs and the dashboard card (ARCHITECTURE.md section 22, D-034). Verified by all six gates; the project-folder write was tested on fixtures only.
- **Step 10.** Tasks and Roadmap: lifecycle, dependencies, milestones with scope tiers, board, list and roadmap views, templates, manual breakdown, explained recommendation, bugs and risks register, snapshots, portfolio and dashboard cards (ARCHITECTURE.md section 23, D-035). Verified by all six gates.
- **Step 11.** Six agent roles (only the implementer can write), the nine run states with a tested state machine, workflow templates with optional reviewer and QA steps, queued run records, prompt preview and the Agent work section of the task detail; no program is started (ARCHITECTURE.md section 24, D-036). Verified by all six gates.
- **Step 12.** Provider contract, Ollama / Claude Code / Codex CLI adapters, the Integrations page, a dashboard connectivity card, and AI-assisted step suggestions and document drafts that are only ever previewed (ARCHITECTURE.md section 25, D-037). Verified by all six gates and by live status checks on this PC (below).
- **Step 13.** Routing profiles with per-role and per-run choices, the run queue (priorities, holds with reasons, one run per provider, duplicate-launch refusal, cancel of owned programs only), the per-project writer lock that survives restarts, bounded and confirmed retries, the resource monitor and the local-inference policy, the AI Workbench and the Active agent sessions card (ARCHITECTURE.md section 26, D-038). Verified by all six gates (below).

## In progress
- Nothing.

## Blocked
- Nothing. `step-03` and `step-04` are pushed to GitHub. A plain `git push origin` from a non-interactive shell hangs on Git Credential Manager's "Select an account" window; pushing to `https://Sonzzk@github.com/Sonzzk/Project-Nexus-Forge.git` with `GCM_INTERACTIVE=never` uses the stored Sonzzk sign-in and works (the same workaround as in the earlier steps).
- Optional tools (GitHub CLI, Codex CLI, Blender, Godot, Unreal) are not needed to build the app; their steps report them as not installed.

## Next
- Step 14 (Sonnet): the usage log (task, provider, model, times, status, and usage only when a provider returns it), configurable launch limits per day, project and task enforced before a run starts, and a usage page with a dashboard summary. It builds on the queue's `request`/`launch` path and the `route_json` each run keeps.

## Application feature status
The app has a working shell, a project registry with detection and overrides, read-only project audits, a read-only Git view, backups with restore and export and import, project memory, context packs and session handoffs, tasks and a roadmap, agent roles and workflow plans, provider integrations (Ollama, Claude Code, Codex CLI), an AI Workbench with a routed run queue for read-only agent runs, a writer lock and a local-inference policy, a live dashboard, activity history, settings and an implementation status page. The core (IPC, logging, database, settings, activity, process runner, shutdown) works and is tested. Sections marked Upcoming in the sidebar are not built; the roadmap says which step builds each one.

## Workspace snapshot (2026-10-24)

| Item | Found |
|---|---|
| Repository | `V:\Project-Nexus-Forge` cloned from `github.com/Sonzzk/Project-Nexus-Forge` (`main`) |
| Git | 2.46.2, Git Credential Manager configured |
| Node.js / npm | v24.22.1 (installed 2026-10-24 over v20.18.1, `C:\Program Files\nodejs`) / 10.9.9 from the user's global prefix `A:\npm-global`, which Node's `npm.cmd` prefers over the bundled npm 11.19.1 (D-012) |
| SQLite (`node:sqlite`) | 3.53.4 |
| winget | v1.29.380 |
| Desktop shortcut | `Nexus Forge.lnk` runs `scripts\launch.cmd` with `assets\icon\nexus-ai.ico` (made by the shortcut thread) |
| Python | 3.11 |
| Claude Code | 2.1.197 (older than the current docs, KI-008) |
| Ollama | installed; local API not answering at the Step 1 check (KI-003) |
| GPU | NVIDIA GeForce RTX 3060, 12288 MiB, driver 610.74 (`nvidia-smi` available) |
| VS Code | installed |
| Not on PATH | GitHub CLI, Codex CLI, Blender, Godot, pnpm, yarn (KI-002, KI-004); Unreal not checked |

## Live checks of the providers on this PC (2026-10-24)
- **Ollama (before it was started):** installed at `%LOCALAPPDATA%\Programs\Ollama\ollama.exe`; the app reported "Ollama is installed but not running".
- **Ollama (with `ollama serve` started for the check and stopped afterwards by process id):** version 0.34.2, zero models, reported as "needs setup". No model was downloaded and no prompt was sent.
- **Claude Code:** found at `%USERPROFILE%\.local\bin\claude.exe`, version 2.1.278, with `-p`, streaming output and plan mode detected as available (a second install, 2.1.197, is on PATH). No prompt was sent, so no subscription usage was spent; the sign-in state is not checked.
- **Codex CLI:** not installed, reported as "Not installed ... It is optional".
- **A bug the live check found and fixed:** two pages asking for provider status at the same moment made the second detection run fail with "already has a program running". Checks now join one another and every detection run has its own owner (tests added).
- **Not proven live:** a real Ollama generation (no models installed), a real Claude Code run and any Codex run (see KI-016).

## Handoff: Step 13
- **Requested:** routing profiles (Manual, Local First, Balanced, Cloud First) with per-role provider and model choices and the route and known cost shown before cloud work; a run queue with priorities, cancellation and duplicate-launch prevention; a per-project single-writer lock that survives restarts; read-only runs alongside when safe; bounded timeouts and retries with approval before escalating or repeating a failed cloud call; a resource monitor (CPU, RAM, nvidia-smi GPU and VRAM, configurable interval, graceful absence) and the local-inference policy (modes, thresholds, heavy-workload holds, pause and cancel, documented Ollama unloading, never stopping other programs).
- **Changed:** `src/shared/routing.ts`, `src/shared/resources.ts`, `src/main/planning/queue.ts`, `src/main/resources/` (monitor), migration `0008_queue.sql`, new run fields in `src/shared/agents.ts` and `planning/agents.ts` and their export columns, `ProviderService` (one request per provider, `runAgent`, `busy`, `unload`), Ollama `keep_alive` and `unload`, CLI runs owned by their run id, nine channels, ten settings, the AI Workbench (`features/workbench/`), Start, Cancel and Try again in the task's Agent work, the Active agent sessions card, manifest states (AI Workbench, Run an agent and the sessions card available; `action.write-run` upcoming at Step 15), `COMPLETED_THROUGH_STEP` 13, fakes and fixtures (`test/fixtures/resources`), `test/e2e/queue.e2e.ts`; ARCHITECTURE.md section 26, D-038, KI-017 (KI-015 handled), DATA.md schema v8, CHANGELOG and this file.
- **Verified (2026-10-24):** `npm run typecheck`, `lint`, `test` (793 of 793), `build`, `check:docs` and `test:e2e` (37 of 37, including a local run through the real app against a stand-in Ollama, a run held by the policy with its reason, a resource check that read this PC, and a Claude Code run that showed its route and cost and was declined in its confirmation, so nothing was sent). A screenshot of the Workbench in the built app showed this PC's RTX 3060 (7.8 GB of 12.0 GB VRAM free at the time) and 33.7 GB of RAM free.
- **Unfinished:** nothing in Step 13. Not built on purpose: write-capable runs (Step 15), the usage log and launch limits (Step 14), streaming output and the live session view (Step 17), per-process GPU measurement (KI-017).
- **Known risks:** the writer lock has only been held in tests, because no run can write yet; heavy workloads are found by program name; no real local generation or cloud run was made (no Ollama models are installed, and no usage may be spent).
- **Relevant files:** `src/main/planning/queue.ts`, `src/shared/routing.ts`, `src/shared/resources.ts`, `src/main/resources/monitor.ts`, `src/renderer/src/features/workbench/WorkbenchPage.tsx`.
- **Next task:** Step 14 · Usage tracking and limits.

## Handoff: Step 12
- **Requested:** a typed provider interface with capability detection, real adapters for Ollama, Claude Code and Codex CLI behind it, an Integrations page with actionable messages and "Unavailable from this provider" for quotas, no hosted call without showing the destination, no write-capable run, and AI-assisted task breakdown and document drafting with a manually chosen provider that is always previewed.
- **Changed:** `src/main/providers/` (`ollama.ts`, `cli.ts`, `service.ts`, `locate.ts`, `types.ts`), `src/shared/providers.ts`, migration `0007_providers.sql`, nine `providers:*` channels and the `providers:progress` event, four `providers.*` settings, the Integrations page and `ProviderPicker`, AI sections in the breakdown form and the memory editor, the Provider connectivity card, manifest states (Integrations available; the workbench and Run an agent moved to Step 13, agent sessions to Step 17), the ESLint exception for `fetch` in the Ollama adapter, test helpers (`fixture-server`, `fake-runner`, `mock-provider`) and fixtures, `test/e2e/providers.e2e.ts`; ARCHITECTURE.md section 25, D-037, KI-016, DATA.md schema v7, CHANGELOG and this file.
- **Verified (2026-10-24):** `npm run typecheck`, `lint`, `test` (714 of 714), `build`, `check:docs` and `test:e2e` (34 of 34), plus the live checks above.
- **Unfinished:** nothing in Step 12. Not built on purpose: running agents on tasks, the queue, routing and the resource monitor (Step 13), usage numbers (Step 14), persistent approvals (Step 15).
- **Known risks:** Codex's JSON event shape is read tolerantly and was never run; Claude Code's sign-in is only discovered when a request fails; a model's size is not known before a download.
- **Relevant files:** `src/main/providers/service.ts`, `src/main/providers/ollama.ts`, `src/main/providers/cli.ts`, `src/renderer/src/features/integrations/IntegrationsPage.tsx`.
- **What Step 13 will do (Opus · Extra High):** routing profiles (Manual, Local First, Balanced, Cloud First) with per-role overrides and a visible routing choice before cloud work; a run queue with priorities, cancellation and duplicate-launch prevention; a per-project single-writer lock that survives restarts; bounded retries and approval before escalating to a more expensive model; and a resource monitor with the local-inference policy (thresholds, heavy-workload detection, never terminating other applications). It builds on `ProviderService`, the agent run records of Step 11 and the process runner of Step 4.
- **Next task:** Step 13 · Agent orchestration and routing.

## Handoff: Step 11
- **Requested:** agent roles, their default permissions and visible workflow states, without launching any agent: a role registry, run records linked to tasks with a state machine, workflow templates that show the expected action and provider before anything runs, role choice in the task detail, Run buttons labeled Upcoming, and a test that this step spawns no process.
- **Changed:** `src/shared/agents.ts`, `src/main/planning/agents.ts` and its export tables, migration `0006_agents.sql`, six `agents:*` channels, the Agent work section (`features/tasks/AgentsPanel.tsx`) in the task detail, `test/mocks/fake-planning.ts` (agent handlers), `test/e2e/agents.e2e.ts`; ARCHITECTURE.md section 24, D-036, KI-015, DATA.md schema v6, CHANGELOG and this file.
- **Verified (2026-10-24):** `npm run typecheck`, `lint`, `test` (625 of 625), `build`, `check:docs` and `test:e2e` (30 of 30, including a plan whose implementer step is blocked until the plan is approved, queued runs that survive a restart, an outcome recorded by hand, and a disabled Run button labeled Upcoming · Step 12).
- **Unfinished:** nothing in Step 11. Launching, queue ordering, the writer lock and routing are Steps 12 and 13 (KI-015).
- **Known risks:** the prompt templates are untested against real providers; run states other than queued and the three outcomes cannot be set from the UI by design.
- **Relevant files:** `src/shared/agents.ts`, `src/main/planning/agents.ts`, `src/renderer/src/features/tasks/AgentsPanel.tsx`.
- **Next task:** Step 12 · Provider integrations.

## Handoff: Step 10
- **Requested:** a game-development task manager with a real lifecycle, board, list and roadmap views, milestones, notes, honest progress, an explained next-task recommendation, a manual feature breakdown, task templates and the generic parts of the Backrooms mode (subsystems, scope tiers, a bugs and risks register); tasks join export.
- **Changed:** `src/main/planning/` (`tasks.ts`, `milestones.ts`, `export.ts`, `parse.ts`), `src/shared/tasks.ts`, migration `0005_tasks.sql`, 22 channels (`tasks:*`, `milestones:*`, `risks:*`), `ExportableTable.verify` in the storage transfer, settings `tasks.requirePlanApproval` and `tasks.view`, the Tasks and Roadmap page (`features/tasks/`), three dashboard cards, manifest states (Tasks and Roadmap, the Create a task action, Current task, Next action and a new Portfolio card now available), `test/mocks/fake-planning.ts`, `test/e2e/tasks.e2e.ts`; ARCHITECTURE.md section 23, D-035, KI-014, DATA.md schema v5, CHANGELOG and this file.
- **Verified (2026-10-24):** `npm run typecheck`, `lint`, `test` (580 of 580), `build`, `check:docs` and `test:e2e` (28 of 28, including a task taken through every lifecycle step with progress counted from the stored task, a chained breakdown whose second step refuses to start early, and the register and recommendation surviving a restart).
- **Unfinished:** nothing in Step 10. Drag and drop, a calendar timeline, release checklists (Step 23) and the Backrooms profile (Step 18) are not built (KI-014).
- **Known risks:** the recommendation is simple arithmetic and may not match intuition on every project; its reasons are always shown. Suggested role and provider are text until Steps 11 and 12.
- **Relevant files:** `src/shared/tasks.ts`, `src/main/planning/tasks.ts`, `src/main/planning/milestones.ts`, `src/renderer/src/features/tasks/TasksPage.tsx`.
- **Next task:** Step 11 · Agent roles and workflows.

## Handoff: Step 9
- **Requested:** persistent project memory with a minimal compatible proposal and a preview before any write into a project, task-specific context packs with a preview and staleness, and session handoffs with the seven fields, shown on the dashboard.
- **Changed:** `src/main/scanning/` (`memory.ts`, `project-write.ts`, `packs.ts`, `handoffs.ts`, `export.ts`; `scanner.ts` now reports modification times), `src/shared/context.ts` and `diff.ts`, migration `0004_context.sql`, 15 channels (`memory:*`, `packs:*`, `handoffs:*`) and handlers, setting `context.defaultBudget`, the Project Context page (`features/context/`), the dashboard card, manifest states (Project Context and the handoff card available), fixtures reused from Step 7, `test/e2e/context.e2e.ts`; ARCHITECTURE.md section 22, D-034, KI-013, DATA.md schema v4, CHANGELOG and this file.
- **Verified (2026-10-24):** `npm run typecheck`, `lint`, `test` (481 of 481), `build`, `check:docs` and `test:e2e` (25 of 25, including a document created in the app and kept across a restart, a project-folder write that only happens after the preview and the accepted confirmation and adds exactly one file, a pack that leaves out a planted `.env`, goes out of date when a file changes and is fresh after a rebuild, and a handoff shown on the dashboard after a restart).
- **Unfinished:** nothing in Step 9. Documentation folders outside the project, pack ranking beyond keywords, related tasks in packs (Step 10) and revisions of memory documents are not built (KI-013).
- **Known risks:** the only writes into a project folder are single Markdown documents after a native confirmation, tested on temp copies of fixtures; the user's real Backrooms project was never touched. Token figures are estimates.
- **Relevant files:** `src/main/scanning/memory.ts`, `src/main/scanning/project-write.ts`, `src/main/scanning/packs.ts`, `src/renderer/src/features/context/`.
- **Next task:** Step 10 · Task management.

## Handoff: Step 8
- **Requested:** recoverable app data: documented schema, manual and scheduled backups with a retention cap, restore that first backs up the current database, export and import to versioned JSON with validation, preview and conflict handling, a startup integrity check with handling of a damaged or newer database, a recovery guide and a table-registration hook.
- **Changed:** `src/main/storage/` (`restore.ts`, `transfer.ts`, `service.ts`, `scheduler.ts`; `backups.ts` and `index.ts` extended), `src/main/app/recovery.ts`, table definitions beside their owners (`settings/export.ts`, `projects/export.ts`, `logging/export.ts`), `SettingsStore.reload`, six `storage:*` channels, `src/shared/storage.ts`, three `backup.*` settings, the Data and backups section of Settings, startup wiring in `src/main/index.ts`, `docs/DATA.md`, `docs/RECOVERY.md`, ARCHITECTURE.md section 21, D-033, KI-010 update and CHANGELOG.
- **Verified (2026-10-24):** `npm run typecheck`, `lint`, `test` (408 of 408), `build`, `check:docs` and `test:e2e` (21 of 21, including a backup restored through a real app restart with the pre-restore copy kept, export then remove then import with the folder confirmed and untouched, and a hostile import file refused).
- **Unfinished:** nothing in Step 8. The native recovery dialog (damaged or newer database at start-up) is covered by unit tests with fake dialogs but was not shown on screen, because it blocks the main process in an automated run. A newer database is not opened read-only (D-033).
- **Known risks:** a restore needs a restart and, in a development run, `app.relaunch()` starts a plain Electron instance; the packaged app (Step 27) is the real target. Export files contain project folder names and notes.
- **Relevant files:** `src/main/storage/restore.ts`, `src/main/storage/transfer.ts`, `src/main/storage/service.ts`, `src/main/app/recovery.ts`, `src/renderer/src/features/settings/DataSection.tsx`.
- **Next task:** Step 9 · Context and session handoffs.

## Handoff: Step 7
- **Requested:** a read-only, evidence-based audit report for a registered project: bounded scanner, analyzers, read-only Git through the process runner, and a report UI with Confirmed and Inferred findings, stored and re-runnable.
- **Changed:** `src/main/scanning/` (`scanner.ts`, `reader.ts`, `analyzers.ts`, `audit.ts`), `src/main/git/`, `src/main/security/path-policy.ts`, migration `0003_audits.sql`, `src/shared/audit.ts`, six channels (`audit:*`, `git:summary`) and handlers, settings `audit.maxFiles` and `audit.timeBudgetSeconds`, `src/renderer/src/lib/audit.ts`, the audit panel, the Git page, the dashboard card, manifest states (Git and Changes, Recent changes now available), fixtures `audit-godot` and `audit-node`, `test/e2e/audit.e2e.ts`; ARCHITECTURE.md section 20, D-032, KI-012, CHANGELOG and this file. Part of the scanner, reader, Git service and audit schema was written by an earlier thread that stopped at a usage limit; it was reviewed, tested and kept.
- **Verified (2026-10-24):** `npm run typecheck`, `lint`, `test` (338 of 338), `build`, `check:docs` (14 of 14) and `test:e2e` (18 of 18, including an audit of a fixture project with a stored report surviving a restart, and a real Git repository read through the Git page).
- **Unfinished:** nothing in Step 7. The user's real Backrooms project was not registered or audited. A `.env` file placed inside a fixture is never read (tested). Git was exercised against a Git 2.46.2 repository created in a temp folder.
- **Known risks:** heuristic findings are Inferred and can be wrong or incomplete (KI-012); a very large project hits the default scan limits and the report says so.
- **Relevant files:** `src/main/scanning/analyzers.ts`, `src/main/scanning/audit.ts`, `src/main/git/git.ts`, `src/renderer/src/features/audit/AuditPanel.tsx`.
- **Next task:** Step 8 · Persistent storage.
