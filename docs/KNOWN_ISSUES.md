# Known issues

Verified bugs, limitations and workarounds. Remove an entry only when the fix is tested; say which step fixed it.

## KI-002 · GitHub CLI is not installed (found in Step 1, accepted)

`gh` is not on PATH. Pushing works through Git with the Git Credential Manager, so the build does not need it. Tasks that would use `gh` (pull requests, repository settings) need it installed first, with the user's approval.

## KI-003 · Ollama's local API did not answer (found in Step 1, open)

Ollama is installed (`%LOCALAPPDATA%\Programs\Ollama\ollama.exe`), but `http://localhost:11434/api/version` did not respond within 3 seconds on 2026-10-24, most likely because Ollama was not running. Step 12 must report "installed but not running" clearly instead of failing or pretending.

## KI-004 · Engines and some CLIs are not on PATH (found in Step 1, accepted)

Codex CLI, Blender and Godot were not found on PATH; Unreal Engine installs were not checked yet. Discovery in Steps 18–20 and the first-run wizard in Step 25 must look in configured paths and documented install locations, not just PATH.

## KI-005 · Global Git email is a placeholder (found in Step 1, worked around)

The PC's global `user.email` is `you@example.com`. This repository sets a local `user.email` to the GitHub no-reply address used by the user's earlier commits (D-009). Other repositories on this PC still use the placeholder; changing the global setting is the user's call.

## KI-006 · `node:sqlite` is a release candidate (found in Step 2, accepted)

Node 24's docs mark `node:sqlite` as stability 1.2, "Release candidate" (since 24.15.0); it is not yet stable. Node 24 is an LTS line, so breaking changes are unlikely, but all database access goes through the `Db` wrapper so better-sqlite3 can replace it if needed (D-015). Step 4 proved the rest: the bundler leaves `node:sqlite` as a built-in (`require("node:sqlite")` in `out/main`), and the built Electron 45 app opens, migrates, backs up and reopens the database (`test/e2e/core.e2e.ts`, plus the integration tests on system Node 24). The entry stays because the module is still a release candidate.

## KI-007 · Playwright's Electron support is experimental (found in Step 2, accepted)

Playwright's docs say it "has experimental support for Electron automation" (Electron v21 and later). End-to-end tests stay few and focused on what only the real app can show (window security, startup, persistence across restarts); logic is tested with Vitest (D-019).
Step 3 checked it: Playwright 1.64.1 launches and drives the built Electron 45 app, and the six end-to-end security tests pass. It needs the app built first (`npm run test:e2e` does that).

## KI-008 · Claude Code 2.1.197 is older than the documented behavior (found in Step 2, open)

The installed Claude Code is 2.1.197 (Step 1 check). The current headless docs describe options added later, for example `--permission-prompts` (2.1.259 or later) and `-p` runs starting in Manual mode (2.1.302 or later). Step 12 must detect the version and derive capabilities from it instead of assuming the documented flags exist. Updating Claude Code is the user's choice.

## KI-009 · The window shows Electron's default menu bar (found in Step 3, open)

The Step 3 window has Electron's default menu (File, Edit, View, Window). In a development run it also offers developer tools; packaged builds have developer tools off (`devTools: !app.isPackaged`). Step 5 kept the menu for development and removes it in a packaged build (`Menu.setApplicationMenu(null)`); that branch is untested until Step 27 packages the app.

## KI-010 · A damaged or newer database ends in an error box, not a recovery screen (found in Step 4, open until Step 8)

If `gdcc.db` fails its integrity check, is not a SQLite file, or was made by a newer version of the app, startup shows a native error box (what happened, what to do, the data and log folders) and exits. The file is never changed, moved or deleted, and the unit tests cover both cases. There is no in-app choice yet to restore a backup or start a new database, and no read-only mode for a newer database: Step 8 builds both (spec §22). The end-to-end suite does not start the app against a bad file, because the native error box blocks the main process; the unit tests (`db.test.ts`, `migrator.test.ts`) cover it.

## KI-011 · The process runner is proven only against small Node programs (found in Step 4, accepted)

`ProcessRunner` has 35 tests (timeout, cancel with a grandchild process, graceful stop, output cap, duplicate owner, shutdown cleanup, `.cmd` shim, redacted `process_runs` rows), all using Node scripts and a temp `.cmd` file. Nothing starts a real tool yet (Git, Claude Code, engines); the first steps that do (7, 12, 15) must check their command lines against the shim rules in D-029. The non-Windows branch (`SIGKILL` of the PID) exists only so unit tests could run elsewhere and is untested; the app is Windows-first.

## KI-012 · The audit is a heuristic reader, not a compiler (found in Step 7, accepted)

Languages, entry points, file relationships and commands come from names, extensions and small text files, so dynamic imports, generated code, Unreal Blueprints and binary `.uasset` and `.unity` contents are not understood; those findings are Inferred or only counted. The scan stops at 20,000 files, depth 12 or 8 seconds by default and says so in the report; a very large Unreal project will usually hit a limit (the Binaries, Intermediate, Saved and DerivedDataCache folders are skipped first). The audit was proven on fixtures; the user's real Backrooms project was not audited (its folder is not registered).
