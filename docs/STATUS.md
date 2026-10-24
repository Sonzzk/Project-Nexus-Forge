# Status

**Current step:** Step 5 · Dashboard and UI: done (2026-10-24, tag `step-05`)
**Next step:** Step 6 · Project registry (Sonnet · High), see [ROADMAP.md](ROADMAP.md#step-6--project-registry).

## Completed
- **Step 1.** Spec preserved verbatim; dependency map, roadmap with 29 plan blocks and requirements trace written; CLAUDE.md and progress notes created; docs check added. Verified by `node scripts/check-docs.mjs` (passed) and `node --test scripts/check-docs.test.mjs` (7 of 7 passed, including tamper, forward-dependency, model-mismatch, missing-field and untraced-requirement cases). The spec's SHA-256 matches the text of the original request.
- **Step 2.** `docs/ARCHITECTURE.md` written; every dependency verified and pinned; decisions D-011 to D-027 recorded; docs check extended to dependency pins and module owners. Verified by `node scripts/check-docs.mjs` (passed) and `node --test scripts/check-docs.test.mjs` (14 of 14 passed, including the seven new negative cases).
- **Step 3.** Hand-written electron-vite scaffold (Electron 45, React 19, TypeScript 6, Vite 8): secure window on the `app://renderer` scheme with CSP, dev/build/typecheck/lint/test/e2e/docs scripts, README install steps. Verified by all six gates on the working tree and on a clean copy of the tracked files (`npm ci`, then every gate), and by starting the app through `scripts\launch.cmd`.
- **Step 4.** Typed IPC, errors, logging with redaction, SQLite with migrations and backups, settings store, activity log, process runner and shutdown coordinator (details in ARCHITECTURE.md section 17 and D-029). Verified by all six gates (below), by a clean copy of the tracked files, and by a real launch through `scripts\launch.cmd` and a clean window close.
- **Step 5.** The application shell: tokens and density, sidebar, top bar, command palette, inspector, resizable panels, feature-status manifest, Implementation Status page, dashboard with live recent activity, Activity and Settings pages (ARCHITECTURE.md section 18, D-030). Verified by all six gates and by looking at the real window (screenshots of the dashboard with the inspector open).

## In progress
- Nothing.

## Blocked
- Nothing. `step-03` and `step-04` are pushed to GitHub. A plain `git push origin` from a non-interactive shell hangs on Git Credential Manager's "Select an account" window; pushing to `https://Sonzzk@github.com/Sonzzk/Project-Nexus-Forge.git` with `GCM_INTERACTIVE=never` uses the stored Sonzzk sign-in and works (the same workaround as in the earlier steps).
- Optional tools (GitHub CLI, Codex CLI, Blender, Godot, Unreal) are not needed to build the app; their steps report them as not installed.

## Next
- Step 6: register existing projects by folder (native picker in main), evidence-based type detection with manual override, the projects table, the Projects page and a working project switcher.

## Application feature status
The app has a working shell with a live dashboard, activity history, settings (density, log level) and an implementation status page. The core (IPC, logging, database, settings, activity, process runner, shutdown) works and is tested. Sections marked Upcoming in the sidebar are not built; the roadmap says which step builds each one.

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

## Handoff: Step 5
- **Requested:** the polished application shell used every day, with honest empty states and clearly labeled upcoming features.
- **Changed:** `src/shared/feature-status.ts`, `roadmap-steps.ts`, new settings keys; `src/renderer/src` (`design/`, `app/`, `features/`, `lib/`); CSP style hash; `Menu` removed when packaged; `test/mocks/fake-api.ts`, `test/setup.ts`, `test/docs/`, `test/e2e/shell.e2e.ts`; ARCHITECTURE.md section 18, D-030, CHANGELOG, README and this file.
- **Verified (2026-10-24):** `npm run typecheck`, `lint`, `test` (226 of 226), `build`, `check:docs` (14 of 14) and `test:e2e` (12 of 12: palette from the keyboard without CSP violations, 1280x720 on both densities with the inspector open, sidebar and inspector and panel sizes after a restart). Screenshots of the real window were checked by eye.
- **Unfinished:** nothing in Step 5. The project switcher is empty until Step 6; the packaged-app menu removal is untested until Step 27 (KI-009).
- **Known risks:** the CSP style hash must be updated if Radix changes its scroll-lock style (the e2e test says so); `COMPLETED_THROUGH_STEP` in `src/shared/roadmap-steps.ts` and the manifest states must be updated by every step.
- **Relevant files:** `src/shared/feature-status.ts`, `src/renderer/src/app/AppShell.tsx`, `src/renderer/src/app/shell.test.tsx`, `test/e2e/shell.e2e.ts`.
- **Next task:** Step 6 · Project registry.