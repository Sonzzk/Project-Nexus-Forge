# Known issues

Verified bugs, limitations and workarounds. Remove an entry only when the fix is tested; say which step fixed it.

## KI-002 · GitHub CLI is not installed (found in Step 1, accepted)

`gh` is not on PATH. Pushing works through Git with the Git Credential Manager, so the build does not need it. Tasks that would use `gh` (pull requests, repository settings) need it installed first, with the user's approval.

## KI-003 · Ollama's local API did not answer (found in Step 1, handled in Step 12)

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

## KI-008 · Claude Code 2.1.197 is older than the documented behavior (found in Step 2, handled in Step 12)

The installed Claude Code is 2.1.197 (Step 1 check). The current headless docs describe options added later, for example `--permission-prompts` (2.1.259 or later) and `-p` runs starting in Manual mode (2.1.302 or later). Step 12 must detect the version and derive capabilities from it instead of assuming the documented flags exist. Updating Claude Code is the user's choice.

## KI-009 · The window shows Electron's default menu bar (found in Step 3, open)

The Step 3 window has Electron's default menu (File, Edit, View, Window). In a development run it also offers developer tools; packaged builds have developer tools off (`devTools: !app.isPackaged`). Step 5 kept the menu for development and removes it in a packaged build (`Menu.setApplicationMenu(null)`); that branch is untested until Step 27 packages the app.

## KI-010 · A damaged or newer database: recovery dialog, no read-only mode (found in Step 4, Step 8 resolved the recovery part)

If `gdcc.db` fails its integrity check, is not a SQLite file, or was made by a newer version of the app, startup shows a native error box (what happened, what to do, the data and log folders) and exits. The file is never changed, moved or deleted, and the unit tests cover both cases. There is no in-app choice yet to restore a backup or start a new database, and no read-only mode for a newer database: Step 8 builds both (spec §22). The end-to-end suite does not start the app against a bad file, because the native error box blocks the main process; the unit tests (`db.test.ts`, `migrator.test.ts`) cover it.

## KI-011 · The process runner is proven only against small Node programs (found in Step 4, accepted)

`ProcessRunner` has 35 tests (timeout, cancel with a grandchild process, graceful stop, output cap, duplicate owner, shutdown cleanup, `.cmd` shim, redacted `process_runs` rows), all using Node scripts and a temp `.cmd` file. Nothing starts a real tool yet (Git, Claude Code, engines); the first steps that do (7, 12, 15) must check their command lines against the shim rules in D-029. The non-Windows branch (`SIGKILL` of the PID) exists only so unit tests could run elsewhere and is untested; the app is Windows-first.

## KI-012 · The audit is a heuristic reader, not a compiler (found in Step 7, accepted)

Languages, entry points, file relationships and commands come from names, extensions and small text files, so dynamic imports, generated code, Unreal Blueprints and binary `.uasset` and `.unity` contents are not understood; those findings are Inferred or only counted. The scan stops at 20,000 files, depth 12 or 8 seconds by default and says so in the report; a very large Unreal project will usually hit a limit (the Binaries, Intermediate, Saved and DerivedDataCache folders are skipped first). The audit was proven on fixtures; the user's real Backrooms project was not audited (its folder is not registered).

Update (Step 8): a damaged or newer database now opens a native recovery dialog (restore the newest usable backup, open the backups folder, start a new database with the old file renamed, or quit); see docs/RECOVERY.md and D-033. The logic is unit tested (`recovery.test.ts`, `restore.test.ts`); the dialog itself cannot be driven by the end-to-end suite because it blocks the main process. A newer database is not opened read-only (D-033).

## KI-013 · Context and memory limits (found in Step 9, accepted)

Documentation folders must be inside the project; a folder elsewhere on disk is not supported until the permission model of Step 15 exists. Pack selection is keyword-based, so a task described without words that appear in file names or text may select nothing (the preview says so) and the person adds files by hand. Memory documents have no revision history beyond the pre-save diff and Git. Token figures are estimates. Related tasks join a pack from Step 10 (open tasks that mention the words of the task, shown as their own item). The features were proven on the `audit-godot` and `audit-node` fixtures; the user's real Backrooms project was not used.

## KI-014 · Task planning limits (found in Step 10, accepted)

The board has no drag and drop (buttons offer the valid moves). Milestones are an ordered list, not a calendar timeline; target dates are shown but nothing warns when one passes. The manual breakdown form creates the tasks you describe; AI-assisted breakdown arrives in Step 12. Suggested role and provider on a task are text for now; Steps 11 and 12 connect them to real roles and providers. Release checklists are Step 23, the Backrooms profile Step 18. The features were proven on fixture projects and the fake `window.api`; the user's real projects were not used.

## KI-015 · Agent roles are records until Steps 12 and 13 (found in Step 11, handled in Step 13)

No agent can be started yet: the Run buttons are disabled and labeled `Upcoming · Step 12`. Run states other than queued, completed, failed and cancelled can only be set by the runner that arrives in Steps 12 and 13, so a stored run will normally sit in queued until someone records an outcome by hand. The prompt templates are first drafts; Step 12 checks them against real provider behavior. Providers are free text on the task until Step 12.

Update (Step 12): KI-003 and KI-008 are handled. The Integrations page reports "Ollama is installed but not running" with the fix, and Claude Code's capabilities are read from what each installed version accepts. This PC has two Claude Code installs (2.1.197 on PATH and 2.1.278 in `%USERPROFILE%\.local\bin`); the app uses the second because it looks in that folder first.

Update (Step 13): runs now start from the queue, read-only only. Write-capable implementer runs stay disabled and labeled `Upcoming · Step 15`.

## KI-016 · Provider integrations: what was and was not proven live (found in Step 12, accepted)

Live on this PC (2026-10-24, statuses only, no prompt sent): Ollama installed and detected as not running; with `ollama serve` started for the check, version 0.34.2 and zero models, reported as "needs setup"; the process tree started for the check was stopped afterwards. Claude Code 2.1.278 detected with its options. Codex CLI is not installed. Not proven live: a real Ollama generation (no models are installed and none may be downloaded without approval; the generation, cancel, timeout and download paths are tested against recorded responses on a local stand-in server), a real Claude Code run (it would use the subscription), and any Codex run (its event format is read tolerantly, D-037). Sign-in state of Claude Code and Codex is not checked. Usage and quota are never shown unless a provider returns them; Step 14 stores what Claude Code reports as an estimate.

## KI-017 · Orchestration limits (found in Step 13, accepted)

Runs that change files cannot start until Step 15, so the writer lock is exercised only by unit tests (with writes switched on) and by a lock left in the database; no real writer has held it. A run's answer is kept only when it finishes; streaming output and the live session view arrive in Step 17. Heavy workloads are found by program name only (Unreal Editor, Blender), not by measured GPU use, and a model's size is not compared with free VRAM: the thresholds are the only check, and they promise nothing about whether a model fits. CPU use is averaged over the few hundred milliseconds a check takes. Not proven live: a real local generation (no Ollama models are installed on this PC; the end-to-end test uses a stand-in server) and any real cloud run (the end-to-end test declines the confirmation, so no usage was spent). The resource check itself ran on this PC (nvidia-smi reported the RTX 3060; tasklist was read).

## KI-018 · Usage tracking limits (found in Step 14, accepted)

The log records only what this app sent. Work done by running Claude Code or Codex in a terminal is invisible to it, and it cannot read a provider's remaining quota, so the launch limits are a safeguard on how often the app launches cloud work and do not predict when a provider will refuse. Usage appears only where the provider returned it: Claude Code (tokens and a cost estimate), Ollama (token counts) and Codex (token counts; read from the documented event, never run live because Codex is not installed on this PC). A failed or cancelled request has no usage even if the provider spent some. A Claude Code cost covers the whole conversation if a session were resumed; the app starts a new session for each run, so each row stands alone. Days are the local calendar day of this PC. The log is not trimmed automatically yet; Step 17 adds retention limits. Not proven live: a real cloud launch (no usage may be spent in tests); the end-to-end test uses a stand-in Ollama.
