# Decisions

Important decisions and why they were made. Newest last. Status is Accepted, Proposed (to be confirmed by a named step) or Superseded.

## D-001 · Where the project documents live (Step 1, Accepted)

The spec suggests documents in three places: §8 lists project-memory files for the *game projects the app manages*, §24 asks for README, ARCHITECTURE, ROADMAP and DECISIONS, and §30 names `docs/ROADMAP.md`, `docs/STATUS.md`, `docs/DECISIONS.md`, `docs/KNOWN_ISSUES.md` and a root `CHANGELOG.md`.
For this repository we follow §30: progress documents in `docs/`, `CHANGELOG.md`, `README.md` and `CLAUDE.md` at the root. `ARCHITECTURE.md` goes to `docs/` in Step 2. The §8 list is a feature of the app (Step 9), not a layout for this repository.

## D-002 · Steps versus spec sections, and section 30 (Step 1, Accepted)

The request says "sections 1–29", but the spec has 30 sections, and the user's table has 29 *build steps* whose titles do not match the spec's section numbers (for example step 12 "Provider integrations" covers spec §9 and step 17 "Activity logs and monitoring" covers spec §15).
Section 30 is treated as binding permanent rules and condensed into CLAUDE.md. The roadmap follows the user's 29 steps; REQUIREMENTS.md maps all 30 sections onto them so nothing is skipped.

## D-003 · Application stack (Step 1, Accepted in Step 2; versions and libraries in D-011 to D-026)

Selected: the spec's preferred stack, an Electron desktop shell with React and TypeScript built by Vite, SQLite for structured data, Zod for validating external input, persistent logs and automated tests. Electron's main process does trusted OS work; the renderer stays sandboxed behind a typed preload bridge.
Why: it is Windows-first, runs Node in the main process for spawning and supervising CLIs (Claude Code, Codex, Git, engines), shares TypeScript and Vite with the user's web games, and has the largest ecosystem for AI coding agents to work in.
Alternatives considered:
- **Tauri** (Rust backend with the system WebView): smaller installers and lower memory, but adds a Rust toolchain the user does not use, and process supervision, SQLite and CLI integration would be written in Rust, which raises the maintenance burden.
- **.NET with WinUI 3 or WPF**: native Windows feel, but splits the codebase from the web-game tooling, has a smaller component ecosystem for a polished custom UI, and needs Visual Studio tooling.
- **Local web server opened in a browser**: no installer, but no native folder pickers or tray behavior, and a localhost server is a larger attack surface for file and process access.
Exact versions, the build template, the SQLite binding, the component approach and the packaging tool are decided and pinned in Step 2.

## D-004 · Storage foundation moves into Step 4 (Step 1, Accepted)

Step 6 (project registry) must persist data, but Step 8 (persistent storage) comes after it. Step 4 therefore builds the SQLite database, migration runner, backup before each migration, settings store and activity table. Step 8 adds backups, restore, export and import, corruption handling and recovery guidance. This avoids a throwaway JSON store.

## D-005 · No write-capable agent runs before Step 15 (Step 1, Accepted)

Agent roles, providers, routing and usage limits (Steps 11–14) come before safe execution (Step 15). Until Step 15 passes, agent sessions may only run in read-only or plan modes, and every write-capable control is disabled and labeled. Ollama generation is text-only and allowed.

## D-006 · Keep the user's step order despite the spec's phase order (Step 1, Accepted; the user may ask to reorder)

Spec §24 wants Phase 1 (MVP) finished before Phase 2 and 3 work. The user's table puts Phase 2–3 items (Steps 11, 13–16) before Phase 1 items (activity log page in 17, settings in 24, first-run wizard in 25). We keep the user's order because they defined the threads by it, and mitigate with D-004, D-005, an early settings store and recent-activity list (Steps 4–5), and a formal §27 acceptance test in Step 26. If the user wants the spec's phase order instead, renumbering the plan blocks is cheap until Step 11 starts.

## D-007 · Spec items without a step of their own (Step 1, Accepted)

- **Git integration:** read-only status and history in Step 7, pre-write checks and `git init` offer in Step 15, diff, approve, reject, revert, checkpoints and worktrees in Step 16.
- **Resource monitoring (§13):** the monitor service and local-inference policy in Step 13 (routing needs it), the UI in Step 17.
- **Backrooms mode (§19):** generic subsystems, scope tiers and risk register in Step 10; the Backrooms profile and horror-quality checklist in Step 18.
- **AI-assisted task breakdown (§10):** manual breakdown in Step 10, AI help as the first provider consumer in Step 12.

## D-008 · Step 29 gets its own security review (Step 1, Accepted)

Step 29 (installing plugins, MCP servers and skills) is the riskiest feature but comes after the final audit in Step 28. Step 29 ends with a focused security review of its install and MCP code paths (sub-task 29.7).

## D-009 · Git workflow and identity for this repository (Step 1, Accepted)

Each step commits to `main` after every stable sub-task, then adds an annotated `step-NN` tag and pushes with tags, so every step is a rollback point. No force pushes. The PC's global Git email is a placeholder (`you@example.com`), so this repository sets a local `user.email` to the GitHub no-reply address already used by the user's earlier commits; the global setting is untouched.

## D-010 · A dependency-free docs check as Step 1's test (Step 1, Accepted)

Step 1 produces documents, so its automated test is `scripts/check-docs.mjs` (Node standard library only). It verifies the spec hash, that the roadmap has 29 well-formed steps whose titles and models match the user's table, that effort levels match the table notes, that no step depends on a later step, and that every spec section and acceptance criterion has an owning step. `scripts/check-docs.test.mjs` proves the check catches tampering, forward dependencies, model mismatches and untraced sections. Step 3 wires it into `npm run check:docs`.

## D-011 · Electron 45 and exact version pins (Step 2, Accepted)

Electron 45.0.0 (stable 2026-10-20, Chromium 156, Node 24.22.0) is the newest stable major and has the longest support window (to 2027-04-27, tentative); Electron supports only the latest three majors. Every package is pinned to an exact version in `package.json`, listed with license, source and verification date in ARCHITECTURE.md section 1, and the docs check fails when the two disagree. Alternative: Electron 44.9.3, more mature but out of support on 2027-03-02, before the planned release steps. Sources: https://releases.electronjs.org/schedule and releases.json, checked 2026-10-24.

## D-012 · Node.js 24 LTS for development (Step 2, Accepted; installed 2026-10-24 with the user's approval)

The PC has Node.js 20.18.1, end of life since 2026-04-30 and below Vite's minimum (KI-001). Recommended: **Node.js 24.22.1 LTS**, the same major as Electron 45's Node, supported to 2028-04-30, inside every tool's engine range (Vitest needs ^22.12, ^24 or >=26; jsdom needs ^24.15; `node:sqlite` is a release candidate from 24.15.0). Install with `winget install OpenJS.NodeJS.LTS --version 24.22.1`, which runs the official `node-v24.22.1-x64.msi` from nodejs.org (winget's SHA-256 `3bda4baf…1b01` matches nodejs.org's SHASUMS256.txt). It replaces Node 20 machine-wide in `C:\Program Files\nodejs`.
Alternatives: Node 22 (maintenance, end of life 2027-04-30, too short for this build); Node 26 (LTS from 2026-10-28, a different major from Electron's Node, and newer than some tools have been tested on); a version manager such as fnm, nvm-windows or Volta (lets other projects keep Node 20, but adds another machine-wide tool, and Node 20 gets no security fixes anyway). Sources: https://github.com/nodejs/Release schedule.json and https://nodejs.org/dist/index.json, checked 2026-10-24.
Outcome: the user approved ("install it") on 2026-10-24. winget verified the installer hash and installed Node.js 24.22.1 over Node 20; `node -v` shows v24.22.1 and `node:sqlite` opens a database (SQLite 3.53.4). `npm -v` shows 10.9.9 because the user's global npm prefix `A:\npm-global` holds its own npm, which Node's `npm.cmd` prefers over the bundled npm 11.19.1. npm 10.9.9 supports Node 24 (it is the npm bundled with Node 22), so it was left alone; changing the global npm is the user's call.

## D-013 · electron-vite for development and builds (Step 2, Accepted)

electron-vite 6.0.0 with Vite 8.3.5 builds main, preload and renderer from electron-vite's documented `src/main`, `src/preload`, `src/renderer` layout with little configuration. Alternative: Electron Forge 8.0.1 with its Vite plugin, which Forge's docs still mark experimental ("As of Electron Forge v7.5.0 ... marked as experimental"). Sources: https://electron-vite.org/guide/ and https://www.electronforge.io/config/plugins/vite, checked 2026-10-24.

## D-014 · Hand-written scaffold, not the create-electron template (Step 2, Accepted)

Step 3 writes the small scaffold by hand. The `@quick-start/create-electron` template brings `@electron-toolkit/preload`, whose `electronAPI` exposes a generic `ipcRenderer` to the renderer, and offers `electron-updater`; both conflict with the IPC rules and spec §24 (no automatic updater). Removing them afterwards is more work than writing the dozen files.

## D-015 · `node:sqlite` instead of better-sqlite3 (Step 2, Accepted)

The database uses Node's built-in `node:sqlite` (`DatabaseSync`, prepared statements, `backup()`), stability 1.2 "release candidate" since Node 24.15.0, no flag. It works inside Electron since electron/electron#47706 (merged 2025-07-15, backported to 36, 37 and 38), and Electron 45 bundles Node 24.22.0. Because development Node and Electron's Node are the same major, the same code runs in Vitest and in the app with no native-module rebuilds.
Alternative: better-sqlite3 13.0.3, mature and fast, but a native module that must be rebuilt for Electron's ABI and separately for system Node; it stays the fallback behind the `Db` wrapper. Risks: KI-006. Sources: https://nodejs.org/docs/latest-v24.x/api/sqlite.html and the Electron PR, checked 2026-10-24.

## D-016 · TypeScript 6.0, not 7 (Step 2, Accepted)

TypeScript 7.0.2 (the native compiler) is the latest, but typescript-eslint 8.72.0 supports `>=4.8.4 <6.1.0`. We pin TypeScript 6.0.3 and revisit when typescript-eslint supports 7. Source: https://typescript-eslint.io/users/dependency-versions/, checked 2026-10-24.

## D-017 · UI building blocks (Step 2, Accepted; Step 5 applies it)

Radix primitives (`radix-ui` 1.8.1) for accessible behavior, our own components styled with CSS Modules and CSS custom-property design tokens (built into Vite), `cmdk` for the command palette, `react-resizable-panels` for panels and `lucide-react` for icons. Navigation is a typed state, not a router library; data access is a small hook over `window.api`, not a state library.
Alternatives: Tailwind with shadcn/ui (adds a build plugin and utility classes; its components use Radix anyway), Mantine or Fluent UI (heavier, harder to give the dense custom look), react-router and state libraries (not needed for eleven fixed sections in one window).

## D-018 · Own structured logger (Step 2, Accepted; Step 4 builds it)

A small logger writes JSON lines with size-based rotation (5 MB, five files) and redacts with the same `Redactor` that protects previews and context packs. Alternatives: electron-log 5.4.4 and pino 10.4.0 (pino's rotation needs worker-thread transports that complicate packaging; both would still need our redaction).

## D-019 · Test tools and what `npm test` means (Step 2, Accepted)

Vitest 5.0.5 runs unit, integration and component tests (jsdom 30.1.3 with Testing Library) on system Node 24; Playwright 1.64.1 `_electron` runs a few end-to-end tests on the built app (`npm run test:e2e`). Unit tests on system Node are representative because it matches Electron's Node major; Electron-only APIs stay behind small interfaces. Live checks against installed tools are opt-in and never part of `npm test`. Playwright's Electron support is experimental (KI-007), so end-to-end tests stay few. Source: https://playwright.dev/docs/api/class-electron, checked 2026-10-24.

## D-020 · Packaging with electron-builder and fuses, no updater (Step 2, Accepted; Step 27 applies it)

electron-builder 26.18.0 for an NSIS installer and a portable build, and `@electron/fuses` 2.1.3 to turn off RunAsNode, NODE_OPTIONS and inspect arguments and to turn on ASAR integrity. No `electron-updater` (spec §24). Step 27 re-checks both versions before installing.

## D-021 · No terminal emulator for now (Step 2, Accepted)

node-pty and xterm.js are not added. Claude Code (`claude -p --output-format stream-json`) and Codex (`codex exec --json`) have documented structured non-interactive modes, which are better than parsing terminal output (spec §9A). node-pty is a native module. A later step that truly needs an interactive session adds them with its own ADR. Sources: https://code.claude.com/docs/en/headless and https://learn.chatgpt.com/docs/non-interactive-mode, checked 2026-10-24.

## D-022 · IPC through an allowlisted, schema-checked bridge (Step 2, Accepted; Step 4 builds it)

`window.api` exposes only `invoke` and `on` for channel and event names in a shared registry. Main validates the sender and the input (Zod) for every call and answers with a result envelope, because Electron passes only an error's message across `invoke`. Requests never carry absolute paths, executables, command arguments or shell strings; folders come from main's native dialog and files are `{ projectId, relativePath }`. Alternative: one named function per channel in the preload, which is more code for the same protection.

## D-023 · Renderer on a custom `app://` scheme (Step 2, Accepted; Step 3 builds it)

Production pages are served from `app://renderer/` by a `protocol.handle` handler that serves only the built renderer folder and sets the CSP header, following Electron's security checklist ("prefer usage of custom protocols" over `file://`, which can read any file). Source: https://www.electronjs.org/docs/latest/tutorial/security, checked 2026-10-24.

## D-024 · App data folder independent of the display name (Step 2, Accepted)

Main sets the data folder to `%APPDATA%\GameDevCommandCenter` before startup, so the configurable display name (spec §29I) never moves user data. Unpackaged dev and test runs may redirect it with `GDCC_USER_DATA_DIR`; packaged builds ignore that variable.

## D-025 · Child processes on Windows (Step 2, Accepted; Step 4 builds it)

Only `ProcessRunner` spawns, with argument arrays and no shell. Node's docs say `.bat` and `.cmd` files are not executable without a terminal and recommend running them through `cmd.exe`; many npm CLIs are `.cmd` shims, so the runner uses `%ComSpec% /d /s /c` for them only when every argument passes a strict character check, and sends prompts and other free text through stdin. On Windows `subprocess.kill()` ends only the direct child, so cancellation kills the owned process tree with `taskkill /T /F` after a grace period. Source: https://nodejs.org/docs/latest-v24.x/api/child_process.html, checked 2026-10-24.

## D-026 · Claude Code runs load project hooks and MCP servers (Step 2, Accepted; Step 12 applies it)

Claude Code's docs say a `claude -p` run without `--bare` runs the project's `.claude/settings.json` hooks and `.mcp.json` servers with no trust dialog. Before the first run in a project, the adapter lists them and asks the user, because that is running project code. `--bare` skips them but signs in with an API key rather than the subscription, so it is never the default (spec §9: no silent switch to metered billing). Source: https://code.claude.com/docs/en/headless, checked 2026-10-24.

## D-027 · Migrations run all-or-nothing after a verified backup (Step 2, Accepted; Step 4 builds it)

Applied migrations are recorded in a `schema_migrations` table with checksums. Before migrating, the app backs up the database with `node:sqlite`'s `backup()` and runs `quick_check` on the copy; then all pending migrations run in one transaction, so a failure leaves the database exactly as it was. A database newer than the app opens read-only. An unreadable database is never replaced; the user chooses on a recovery screen.

## D-028 · Step 3 scaffold choices (Step 3, Accepted)

- **All packages are `devDependencies`.** electron-vite bundles main, preload and renderer, so nothing is `require`d from `node_modules` at run time and the packaged app needs no `node_modules` (Step 27). A package goes under `dependencies` only to stay external, with an ADR. Source: https://electron-vite.org/guide/dev, checked 2026-10-24.
- **Config file names.** `eslint.config.mjs` and `vitest.config.mts`: the package has no `"type": "module"`, because electron-vite then emits CommonJS for main and the sandboxed preload, which must be CommonJS. A `.js` or `.ts` config with ESM syntax would load as CommonJS and print a Vite warning.
- **Three type-check projects.** `tsconfig.node.json` (main, preload, shared, configs: no DOM), `tsconfig.web.json` (renderer, shared) and `tsconfig.e2e.json` (Playwright tests: DOM types, because their callbacks run in the page). `npm run typecheck` runs all three.
- **`window.api` type** lives in `src/shared/window.d.ts`, so the renderer and the end-to-end tests see the same declaration.
- **Missing renderer files answer 404.** `net.fetch` of a missing file rejects; the `app://` handler catches it and returns 404, which the end-to-end test covers.
- **`webContents.getLastWebPreferences()`** exists in Electron 45 at run time but is missing from its type definitions; the end-to-end test casts it. It is the only way to assert the real window preferences from main, so the test uses it.
- **Import boundaries are lint rules**: the renderer may not import Electron or Node modules or `main/` and `preload/` code; shared code may not import Electron or Node; `dangerouslySetInnerHTML` is banned in the renderer; `src/` may not import `test/`. A planted violation was checked to fail lint.
- **No installs beyond the pinned packages.** The user approved Node.js 24 (D-012) and the project's own dependencies; Step 3 installed exactly the Step 3 rows of ARCHITECTURE.md section 1 and nothing machine-wide.

## D-029 · Step 4 core structure choices (Step 4, Accepted)

- **No backup for a brand-new database.** Spec §22 and ARCHITECTURE.md section 8 say a verified backup precedes every migration. A file that was just created holds nothing to protect, so the first migration (0 to 1) skips it; every later migration makes and verifies one first, and no verified backup means no migration. A backup is one self-contained file: after SQLite's online `backup()` the copy is switched out of WAL mode and `quick_check`ed (`sealBackup`), so there are no `-wal` or `-shm` side files to prune or lose.
- **A newer or damaged database stops startup.** `DB_NEWER_THAN_APP` and `DB_CORRUPT` end with a native error box (message, hint, data and log paths) and exit. The files are untouched. The read-only mode for a newer database and the recovery screen with restore are Step 8 (spec §22), as the roadmap says.
- **`ActivityLog.record` is the `recordActivity` API** that CLAUDE.md and the roadmap name; later steps call `activity.record(...)`.
- **`SettingsStore.set(key, value: unknown)`** instead of `value: Settings[K]`, so the renderer's untrusted value is validated in one place and the IPC layer needs no cast. Settings keys in Step 4: `logging.level` and `ui.density` (spec §5 asks for configurable density; Step 5 uses it).
- **IPC requests are strict objects and responses are validated.** An unknown field fails (so a request can never smuggle a `path` field past a schema), and a handler that returns the wrong shape yields `INTERNAL` instead of sending it. Errors travel in the `IpcResult` envelope, because Electron passes only an error's message across `invoke`.
- **Process runner semantics.** `maxOutputBytes` is the retained tail per stream; the process is stopped with `output-limit` at ten times that (`OUTPUT_KILL_FACTOR`), so a runaway program cannot fill memory while a long agent run is not cut off at the tail size. Raw output is returned to callers (they parse it) and is never logged; callers redact before display. `gracefulStop: 'close-stdin'` is opt-in: without it, cancel ends the tree at once rather than waiting a grace period for a stop signal nobody sent (Windows has no SIGTERM for console-less children, and `child.kill()` ends only the direct child, which would orphan grandchildren from `taskkill /T`). Only a process that has not exited is ever signalled, so a reused PID is never hit. A failed launch is a `spawn-failed` result, not an exception.
- **Stale process rows become `lost` at start.** A row still `running` belongs to a previous session; the runner cannot know whether that program is alive, so Step 4 records it as lost (the roadmap's Step 26 may offer to stop a surviving one).
- **`.cmd` shims** run as `%ComSpec% /d /s /c ""<file>" <args>"` only for drive-letter paths without `"%^&|<>!` and arguments from `[A-Za-z0-9_\-./:=@+,\\]`; cmd.exe still splits an argument at `=`, so shims should not rely on it. Everything else is refused with a hint to use stdin.
- **Import rules in lint.** Module `index.ts` files for `logging`, `settings` and `security` were added so cross-module imports have somewhere to go; the rules are listed in ARCHITECTURE.md section 4. The global `fetch` is banned in `src/main` until `providers/ollama/` exists; `net.fetch` in the `app://` handler is a different API.
- **Dependencies.** Zod 4.6.7 (the pinned Step 4 row) is the only package added, under `devDependencies` like the rest (D-028).

## D-030 · Step 5 shell choices (Step 5, Accepted)

- **Navigation is a typed state; upcoming sections are reachable.** A sidebar item for an unbuilt section opens a page that says which step builds it and offers no control, so no button is dead and nothing pretends. An unbuilt palette action is disabled and labeled instead.
- **Panel sizes are percentages.** In react-resizable-panels 4 a bare number is pixels; the code uses strings such as \"28%\", and saves the layout only after a user drag or key press (isUserInteraction).
- **Radix scroll-lock style by hash.** See ARCHITECTURE.md section 18. The alternative was style-src 'unsafe-inline', which would also allow every other inline style.
- **Packaged builds drop the default menu** (Menu.setApplicationMenu(null)); development keeps it for developer tools. Not exercised until Step 27 packages the app (KI-009).
- **Packages:** radix-ui, cmdk, react-resizable-panels, lucide-react, jsdom, @testing-library/react, @testing-library/dom and @testing-library/user-event at the Step 5 rows of ARCHITECTURE.md section 1.

## D-031 · Step 6 project registry choices (Step 6, Accepted)

- **Status is the user's choice; a missing folder is a fact.** `status` is active, paused or archived. Whether the folder exists is computed on every read (`folderExists`), so a drive that is plugged in again just works and nothing is silently changed.
- **Priority decides the type, evidence keeps everything.** See ARCHITECTURE.md section 19. A manual override stores the type and drops the engine fields (they describe the detected type); going back to "detected" restores them from the stored detection.
- **Real path, one key.** The registry stores the real path (links and junctions resolved) and a lower-cased key without a trailing separator, so one folder cannot be registered twice. It does not forbid a project inside another.
- **Nothing in a project folder is created.** No `.gdcc` marker, no cache. All app data about a project lives in the app database, which Step 8 backs up.
- **Fixtures are committed files under `test/fixtures/projects`**; tests copy one into a temp folder before registering it. The `.env` check writes its file at run time because `.env` files are git-ignored.

## D-032 · Step 7 project auditing choices (Step 7, Accepted)

- **Report stored as JSON.** ARCHITECTURE.md section 8 sketched a separate `audit_findings` table. Nothing queries findings individually, so `audits.report_json` holds the validated report and keeps the schema small. A findings table can be added by a later migration if a feature needs to query across audits.
- **Audits cascade with the project and keep ten.** They are derived from a folder the user can audit again, unlike activity history, which keeps `project_id` without a foreign key.
- **Hashing is allowed for duplicates; contents are not read.** The spec says the scanner never reads binary contents. Finding identical copies of textures and models needs a digest, so `ProjectReader.hash` streams a file into SHA-256 and returns only the digest. It is limited to files of 64 MB or less, 400 files and 1 GB in total per audit, applies the same sensitive and outside-the-project rules, and is only done for files that share a size with another file.
- **Confirmed needs a file.** `FindingSchema` rejects a confirmed finding without evidence. Findings about the folder as a whole (counts) use the evidence path `.` and are Confirmed only when the scanner counted them; the absence of something is Inferred.
- **Heuristics are labeled.** Entry points guessed from names, build commands implied by `Cargo.toml` or a `.sln`, and import relationships are Inferred. Import resolution covers JavaScript and TypeScript relative imports, C and C++ quoted includes, GDScript `preload` and `load`, Godot `ext_resource` paths and Python relative imports; dynamic and generated references are not seen.
- **Git is read through the process runner only.** Source: git-scm.com/docs/git-status, checked 2026-10-24: `--porcelain=v2 --branch` with the `# branch.oid`, `# branch.head`, `# branch.upstream` and `# branch.ab` header lines. `GIT_OPTIONAL_LOCKS=0` is the documented environment form of `--no-optional-locks` (git(1); the status page itself only names the flag); a test proves a status call leaves the repository byte-identical. `git.exe` is found in the default install folders and on PATH; nothing is downloaded or installed.
- **Settings:** `audit.maxFiles` and `audit.timeBudgetSeconds` have defaults and ranges; their controls arrive with the settings page in Step 24.
- **Fixtures** `audit-godot` and `audit-node` are text files; binary files and `.env` files for tests are written into a temp copy at run time. Vitest excludes `test/fixtures`.

## D-033 · Step 8 persistent storage choices (Step 8, Accepted)

- **A restore is staged and applied at the next start.** The database is open and shared by every service while the app runs; swapping the file under them is unsafe. The page asks, main confirms natively, backs up the current data (`pre-restore`) and restarts; the start-up code swaps the file before anything opens it. The used file is renamed, not deleted.
- **Backups are files, not a table.** ARCHITECTURE.md section 8 sketched a `backups` table. The file name already carries the time and reason, a table could disagree with the folder, and a database backup cannot contain its own list. `BackupService.list` reads the folder.
- **Retention is per reason.** The newest `backup.keepCount` of each reason are kept, so a busy schedule cannot push out the manual backup or the "before a restore" safety copy.
- **The recovery "screen" is a native dialog.** It has to work when the database cannot open, so it cannot depend on the renderer or on settings. It offers restore, open folder, new database and quit.
- **No read-only mode for a newer database.** Every service writes at start-up (activity, settings) and a half-working read-only app would fail in confusing ways. The app refuses to touch the data, explains, and offers restore of the newest usable older backup or a new database. This is the "refuse writes, explain" of the roadmap. KI-010 is updated.
- **Imports are conservative.** Default is keep existing data; replacing needs a native confirmation with a count; rows that clash with a unique value or lack a parent are never imported; new project folders are listed in a native confirmation because the registry otherwise accepts folders only from the folder picker; the current data is backed up first; one transaction.
- **Audits are not exported.** They are derived from the project and can be run again; process runs are a diagnostic record. Registered exportable tables today: settings, projects, project detections, activity.
- **Export contains project folder names and notes.** The file is written where the user chooses and the UI says to keep it private. Activity details were redacted when recorded.

## D-034 · Step 9 context and handoff choices (Step 9, Accepted)

- **Documents are stored where the user says; the app database is the default.** Writing into a project is never the default, never automatic and never silent: preview with a diff, a native confirmation that names the file, a check that the file did not change in between, and a read-back.
- **"Configured documentation directory" means a folder inside the project.** An external folder would need its own authorization and write permission, which belong to Step 15. A relative path is validated like every project path (no `..`, no drive, no links out). Recorded as KI-013.
- **Propose, do not generate.** The proposal is the missing core documents only (project context, decisions, session handoff) and the starting text is a short outline the person edits; no model writes anything in this step.
- **No revision history for memory documents.** The diff before every save and Git (for files in the project) are the history. The app database keeps the current text only; adding revisions later is a new table, not a change to this one.
- **Pack selection is lexical and explainable, not semantic.** Scores come from names, paths and keyword counts in files of 64 KB or less, with a budget of 500 files and 16 MB read per build. The reason for each item is shown. Embeddings or a model-based ranker can replace the scorer later without changing the pack format.
- **The token figure is an estimate.** Characters divided by four, labeled as an estimate everywhere. Exact counts differ by provider and arrive with the provider adapters (Step 12 and later).
- **A pack is a request plus a manifest.** Contents are rebuilt from the files, so a saved pack never stores copies of project text in the database. The manifest holds the size, modification time and SHA-256 of each included item.
- **Hand-picked files follow the same rules.** The sensitive-name list, the binary and size limits, and the scanner's skipped folders apply no matter how a file got on the list; a path that leaves the project rejects the whole request.
- **The handoff draft is deliberately small.** Only Git and audit facts are prefilled; "what was requested" and "what was verified" are claims only the person can make.
