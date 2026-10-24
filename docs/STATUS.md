# Status

**Current step:** Step 6 · Project registry: done (2026-10-24, tag `step-06`)
**Next step:** Step 7 · Project auditing (Sonnet · High), see [ROADMAP.md](ROADMAP.md#step-7--project-auditing).

## Completed
- **Step 1.** Spec preserved verbatim; dependency map, roadmap with 29 plan blocks and requirements trace written; CLAUDE.md and progress notes created; docs check added. Verified by `node scripts/check-docs.mjs` (passed) and `node --test scripts/check-docs.test.mjs` (7 of 7 passed, including tamper, forward-dependency, model-mismatch, missing-field and untraced-requirement cases). The spec's SHA-256 matches the text of the original request.
- **Step 2.** `docs/ARCHITECTURE.md` written; every dependency verified and pinned; decisions D-011 to D-027 recorded; docs check extended to dependency pins and module owners. Verified by `node scripts/check-docs.mjs` (passed) and `node --test scripts/check-docs.test.mjs` (14 of 14 passed, including the seven new negative cases).
- **Step 3.** Hand-written electron-vite scaffold (Electron 45, React 19, TypeScript 6, Vite 8): secure window on the `app://renderer` scheme with CSP, dev/build/typecheck/lint/test/e2e/docs scripts, README install steps. Verified by all six gates on the working tree and on a clean copy of the tracked files (`npm ci`, then every gate), and by starting the app through `scripts\launch.cmd`.
- **Step 4.** Typed IPC, errors, logging with redaction, SQLite with migrations and backups, settings store, activity log, process runner and shutdown coordinator (details in ARCHITECTURE.md section 17 and D-029). Verified by all six gates (below), by a clean copy of the tracked files, and by a real launch through `scripts\launch.cmd` and a clean window close.
- **Step 5.** The application shell: tokens and density, sidebar, top bar, command palette, inspector, resizable panels, feature-status manifest, Implementation Status page, dashboard with live recent activity, Activity and Settings pages (ARCHITECTURE.md section 18, D-030). Verified by all six gates and by looking at the real window (screenshots of the dashboard with the inspector open).

- **Step 6.** Project registry: register folders through a native picker, read-only type detection with stored evidence and a manual override, the Projects page, a working project switcher (ARCHITECTURE.md section 19, D-031). Verified by all six gates and a snapshot test showing no project file changes.

## In progress
- Nothing.

## Blocked
- Nothing. `step-03` and `step-04` are pushed to GitHub. A plain `git push origin` from a non-interactive shell hangs on Git Credential Manager's "Select an account" window; pushing to `https://Sonzzk@github.com/Sonzzk/Project-Nexus-Forge.git` with `GCM_INTERACTIVE=never` uses the stored Sonzzk sign-in and works (the same workaround as in the earlier steps).
- Optional tools (GitHub CLI, Codex CLI, Blender, Godot, Unreal) are not needed to build the app; their steps report them as not installed.

## Next
- Step 7: a bounded, read-only scanner and analyzers, a read-only Git service through the process runner, and the audit report page with Confirmed versus Inferred findings.

## Application feature status
The app has a working shell, a project registry with detection and overrides, a live dashboard, activity history, settings and an implementation status page. The core (IPC, logging, database, settings, activity, process runner, shutdown) works and is tested. Sections marked Upcoming in the sidebar are not built; the roadmap says which step builds each one.

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

## Handoff: Step 6
- **Requested:** register existing projects by folder without moving or modifying them, with evidence-based type detection and manual override; Projects page, working switcher, activity events.
- **Changed:** `src/shared/projects.ts`, migration `0002_projects.sql`, `src/main/projects/` (`detect.ts`, `registry.ts`), five `projects:*` channels and handlers, the folder picker in `src/main/index.ts`, `src/renderer/src/lib/projects.tsx`, the Projects page, the top-bar switcher and dashboard card, manifest states, fixtures in `test/fixtures/projects`, `test/helpers/tree.ts`, `test/e2e/projects.e2e.ts`; ARCHITECTURE.md section 19, D-031, CHANGELOG and this file.
- **Verified (2026-10-24):** `npm run typecheck`, `lint`, `test` (273 of 273), `build`, `check:docs` (14 of 14) and `test:e2e` (15 of 15, including add through the stubbed picker, an override and tags surviving a restart, and removal leaving the folder identical).
- **Unfinished:** nothing in Step 6. The user's real Backrooms project was not registered or read (its folder is not known to the app); detection was proven on fixtures only. Archived projects are stored but not yet treated differently anywhere.
- **Known risks:** detection reads only the top level of a folder, so a project whose `.uproject` or `project.godot` sits in a subfolder is reported as unidentified until the user overrides it (Step 7's audit looks deeper).
- **Relevant files:** `src/main/projects/detect.ts`, `src/main/projects/registry.ts`, `src/main/projects/projects.test.ts`, `src/renderer/src/features/projects/ProjectsPage.tsx`.
- **Next task:** Step 7 · Project auditing.
