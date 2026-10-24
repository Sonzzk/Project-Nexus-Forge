# Status

**Current step:** Step 4 · Core application structure: done (2026-10-24, tag `step-04`)
**Next step:** Step 5 · Dashboard and UI (Sonnet · High), see [ROADMAP.md](ROADMAP.md#step-5--dashboard-and-ui).

## Completed
- **Step 1.** Spec preserved verbatim; dependency map, roadmap with 29 plan blocks and requirements trace written; CLAUDE.md and progress notes created; docs check added. Verified by `node scripts/check-docs.mjs` (passed) and `node --test scripts/check-docs.test.mjs` (7 of 7 passed, including tamper, forward-dependency, model-mismatch, missing-field and untraced-requirement cases). The spec's SHA-256 matches the text of the original request.
- **Step 2.** `docs/ARCHITECTURE.md` written; every dependency verified and pinned; decisions D-011 to D-027 recorded; docs check extended to dependency pins and module owners. Verified by `node scripts/check-docs.mjs` (passed) and `node --test scripts/check-docs.test.mjs` (14 of 14 passed, including the seven new negative cases).
- **Step 3.** Hand-written electron-vite scaffold (Electron 45, React 19, TypeScript 6, Vite 8): secure window on the `app://renderer` scheme with CSP, dev/build/typecheck/lint/test/e2e/docs scripts, README install steps. Verified by all six gates on the working tree and on a clean copy of the tracked files (`npm ci`, then every gate), and by starting the app through `scripts\launch.cmd`.
- **Step 4.** Typed IPC, errors, logging with redaction, SQLite with migrations and backups, settings store, activity log, process runner and shutdown coordinator (details in ARCHITECTURE.md section 17 and D-029). Verified by all six gates (below), by a clean copy of the tracked files, and by a real launch through `scripts\launch.cmd` and a clean window close.

## In progress
- Nothing.

## Blocked
- Nothing. `step-03` and `step-04` are pushed to GitHub. A plain `git push origin` from a non-interactive shell hangs on Git Credential Manager's "Select an account" window; pushing to `https://Sonzzk@github.com/Sonzzk/Project-Nexus-Forge.git` with `GCM_INTERACTIVE=never` uses the stored Sonzzk sign-in and works (the same workaround as in the earlier steps).
- Optional tools (GitHub CLI, Codex CLI, Blender, Godot, Unreal) are not needed to build the app; their steps report them as not installed.

## Next
- Step 5: the application shell (design tokens, sidebar with the 11 sections, top bar, command palette, resizable panels, feature-status manifest, dashboard frame with real recent activity from `activity:list`). It starts from `window.api`, the activity log and the `ui.density` setting that Step 4 provides.

## Application feature status
The app opens a window that shows its version, database schema, data folder and log file. The core (IPC, logging, database, settings, activity, process runner, shutdown) works and is tested; no user-facing feature exists yet. Every feature in the spec is **not started**; the roadmap says which step builds each one.

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

## Handoff: Step 4
- **Requested:** the foundations every feature uses: typed IPC, errors, logging with redaction, SQLite with migrations and backups, a settings store, activity events, a safe process runner and a graceful shutdown path.
- **Changed:** added `src/shared` (`errors.ts`, `settings.ts`, `activity.ts`, `ipc/channels.ts`, `ipc/contract.ts`, `ipc/events.ts`, a real `api.ts`); `src/main` modules `ipc/`, `logging/`, `storage/` (with `migrations/0001_init.sql`), `settings/`, `security/sensitive-paths.ts`, `process/`, `app/shutdown.ts`, `app/crash.ts`, a composition root in `index.ts`; the preload bridge (`invoke`, `on`); renderer error reporting and the info panel; test helpers in `test/helpers` and `test/e2e/core.e2e.ts`; lint rules for module indexes, `child_process`, `node:sqlite` and `fetch`; Zod 4.6.7; ARCHITECTURE.md section 17, D-029, KI-006 (updated), KI-010, KI-011, `CHANGELOG.md`, `README.md` and this file.
- **Verified (2026-10-24):** `npm run typecheck`, `npm run lint` (planted violations of every new import rule failed it), `npm test` (206 of 206 in 15 files), `npm run build` (`node:sqlite` stays external, SQL inlined, preload 0.9 kB), `npm run check:docs` (passed, 14 of 14), `npm run test:e2e` (9 of 9). A clean copy of the tracked files passed all six after `npm ci`. A real launch through `scripts\launch.cmd` created `%APPDATA%\GameDevCommandCenter\data\gdcc.db` and `logs\main.log`, showed the info panel, and closing the window logged "shutting down" and "shutdown finished" with no Electron process left. That run also left one `app.started` row in the real database, which is genuine app data.
- **Unfinished:** nothing in Step 4; `step-03` and `step-04` are pushed. No UI beyond the info panel. A damaged or newer database ends in an error box, not a recovery screen (KI-010, Step 8). Nothing starts a real tool through the runner yet (KI-011).
- **Known risks:** `node:sqlite` is still a release candidate (KI-006); the shim rules for `.cmd` programs must be respected by Steps 7, 12 and 15 (D-029); the sync SQLite connection runs on the main thread, so large queries must be paged (ARCHITECTURE.md section 15).
- **Relevant files:** `src/main/index.ts` (composition and startup), `src/main/ipc/handle.ts`, `src/main/storage/migrator.ts`, `src/main/process/runner.ts`, `src/shared/ipc/contract.ts`, `test/e2e/core.e2e.ts`.
- **Next task:** Step 5 · Dashboard and UI.