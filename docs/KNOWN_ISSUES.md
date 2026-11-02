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

Update (Step 15): write-capable runs are enabled behind the permission gate (KI-019).

## KI-016 · Provider integrations: what was and was not proven live (found in Step 12, accepted)

Live on this PC (2026-10-24, statuses only, no prompt sent): Ollama installed and detected as not running; with `ollama serve` started for the check, version 0.34.2 and zero models, reported as "needs setup"; the process tree started for the check was stopped afterwards. Claude Code 2.1.278 detected with its options. Codex CLI is not installed. Not proven live: a real Ollama generation (no models are installed and none may be downloaded without approval; the generation, cancel, timeout and download paths are tested against recorded responses on a local stand-in server), a real Claude Code run (it would use the subscription), and any Codex run (its event format is read tolerantly, D-037). Sign-in state of Claude Code and Codex is not checked. Usage and quota are never shown unless a provider returns them; Step 14 stores what Claude Code reports as an estimate.

## KI-017 · Orchestration limits (found in Step 13, accepted)

Runs that change files could not start until Step 15; since then the writer lock is held by writing runs, tested with a test double on a throwaway project (`write-run.test.ts`) and not by a real provider run. A run's answer is kept only when it finishes; streaming output and the live session view arrive in Step 17. Heavy workloads are found by program name only (Unreal Editor, Blender), not by measured GPU use, and a model's size is not compared with free VRAM: the thresholds are the only check, and they promise nothing about whether a model fits. CPU use is averaged over the few hundred milliseconds a check takes. Not proven live: a real local generation (no Ollama models are installed on this PC; the end-to-end test uses a stand-in server) and any real cloud run (the end-to-end test declines the confirmation, so no usage was spent). The resource check itself ran on this PC (nvidia-smi reported the RTX 3060; tasklist was read).

## KI-018 · Usage tracking limits (found in Step 14, accepted)

The log records only what this app sent. Work done by running Claude Code or Codex in a terminal is invisible to it, and it cannot read a provider's remaining quota, so the launch limits are a safeguard on how often the app launches cloud work and do not predict when a provider will refuse. Usage appears only where the provider returned it: Claude Code (tokens and a cost estimate), Ollama (token counts) and Codex (token counts; read from the documented event, never run live because Codex is not installed on this PC). A failed or cancelled request has no usage even if the provider spent some. A Claude Code cost covers the whole conversation if a session were resumed; the app starts a new session for each run, so each row stands alone. Days are the local calendar day of this PC. The usage log is trimmed by the retention limit of Step 17 (730 days by default; 0 keeps everything). Not proven live: a real cloud launch (no usage may be spent in tests); the end-to-end test uses a stand-in Ollama.

## KI-019 · Safe execution limits (found in Step 15, accepted)

- **Not proven live.** No real Claude Code or Codex writing run was made, because that would spend subscription usage. The first write-capable run was made on a throwaway project with a test double in place of the provider; the real flags were checked against the documentation and `claude --help` (2.1.278) and are asserted in unit tests. The deny-rule syntax has not been seen to block a file in a live run.
- **Agents cannot run commands.** A Claude Code writing run can edit files but its own test runs are denied; the person runs approved commands. Codex's workspace-write sandbox can run commands inside the project folder, and its network behavior there is not documented on the page checked.
- **Claude Code installed as a `.cmd` shim** (for example from npm) cannot be used for writing runs, and its read-only runs go without the secret-file deny rules. The native `claude.exe` has neither limit.
- **Checkpoints** contain tracked changes only (no untracked files), need Git to be able to commit as someone (a missing identity makes the run stop before it starts), and are plain references: nothing lists or restores them until Step 16.
- **Project hooks** (`.claude/settings.json`) and MCP servers (`.mcp.json`) run when Claude Code starts in a project, even read-only; the confirmation names them. The agent cannot edit them.
- **The destructive-command classifier is a net**, not a proof: a script that deletes through a program it does not know (a custom tool) is not flagged. Only `package.json` scripts are discovered; engine commands arrive with Steps 18 to 21.
- **A task's declared files are advice**: the agent is not limited to them, and the window says so.

## KI-020 · Review and undo limits (found in Step 16, accepted)

- **Only runs that passed the gate are reviewable**, and only in a repository that has commits. A change made by hand, or by an agent run in a terminal, is not a session.
- **The review compares with the state when the run was approved**, so edits you make to the project while a run is working, or between the run and the review, look like the agent's. The reject window says so, and a copy is kept first.
- **Untracked ignored files** (build outputs, engine caches) are never in a checkpoint, a review or a commit. Renames show as a deletion and an addition.
- **Large reviews are cut:** a file over 4,000 changed lines or 200 KB of diff, and reviews over 1.5 MB or 300 files, show a note instead of text. A reject needs a copy of every changed file, so it stops at 50 MB for one file or 200 MB in all.
- **Working trees are not used by runs yet.** They can be added and removed from the Git page, but an agent run still works in the project folder under the single-writer lock (D-041).
- **Revert** refuses merge commits and a commit that is not in the current branch's history. A repository hook can still stop a commit or a revert; its message is shown.
- **Not proven live:** the review was exercised on real Git repositories with a test double in place of the provider, not after a real Claude Code or Codex run.

## KI-021 · Monitoring limits (found in Step 17, accepted)

- **Live output is the provider's, as far as it streams.** Claude Code streams its answer (and the tool list and denials appear only when the run ends); Codex and Ollama runs show their answer when they finish or as their adapter delivers it. The page never claims more. No provider exposes reasoning, and none is shown.
- **Tool and denial lists are only as good as the provider's events.** Claude Code's are parsed from its documented stream; Codex's command and file-change items are read tolerantly and were never seen from a real run (Codex is not installed here). A tool the agent used that the provider did not report is not listed.
- **Not proven live:** a real Claude Code session record. The tests use recorded streams and the stand-in Ollama server.
- **No in-app resume.** Claude Code's documented `--resume` is shown for use in a terminal; the app does not send a follow-up into an old conversation.
- **Test output** is not recorded until Step 23.
- **The attention list and the dashboard refresh on activity events**, not on a timer, so a resource warning is as old as the last check.
- **Retention is by age only**, not by size; a very busy day can still add a lot of rows before the next daily prune. The log files keep their own 5 MB rotation.

## KI-022 · Unreal integration limits (found in Step 18, accepted)

- **No build was run against a real project.** The build command was run only against a fixture `Build.bat` that echoes its arguments (unit and end-to-end tests). A real build of the projects on this PC was not run: it can take many minutes, writes `Binaries` and `Intermediate` in a real project, and the rules forbid changing real projects from tests. The first real build is yours to approve; if the engine rejects the command line, the log shows why.
- **Only Win64, Development builds** of Game and Editor targets are offered. Other configurations, platforms, packaging and cooking are not (Step 22/27 may add packaging). The two Visual Studio flags `-FromMsBuild` and `-architecture=x64` are not passed (D-043).
- **No automation tests and no editor automation.** Running automation tests from here is unavailable until the quoting is verified (Step 23); editor Python is off and not built. The capability report says both.
- **Engine discovery depends on four sources**, one of them an undocumented launcher file. An install in a folder that none of them lists, and that was not added by hand, is not found. On this PC only UE_5.8 is listed; `Seven_Shifts_Models` asks for 5.6 and the app reports that no matching engine was found instead of picking another version. Source builds registered in the registry could not be tested live (the key is empty here).
- **A build uses Build.bat under whichever dotnet the engine ships.** If the engine's own prerequisites (Visual Studio, the Windows SDK, the .NET runtime Unreal needs) are missing, the build fails with the engine's message, which the log keeps. The app does not check prerequisites.
- **Opening the project is a hand-off.** Windows decides which program opens the `.uproject`; the editor may compile or upgrade the project, which changes files, and the app cannot stop it.
- **The project description is a count, not an asset index.** Binary assets are counted and named by folder, never opened; plugin dependencies, redirectors and asset references are not analyzed. A very large `Content` folder stops counting at 20,000 entries and says so.
- **The Backrooms profile stores only your confirmations.** Hints are word matches on target, module, plugin, folder and map names and can be wrong or missing; they never confirm anything. It does not read a design document.
- **Command logs are kept for the retention period of program records** (60 days by default) and the output is cut to the last 200,000 characters.

## KI-023 · Blender integration limits (found in Step 19, accepted)

- **Scripts are not sandboxed.** The copy protects the `.blend` only; an approved script can read and write anything your account can and can start programs. The approval window says so.
- **Factory startup.** Runs ignore your preferences and add-ons (`--factory-startup`), so a script that needs one of your add-ons fails with Blender's message. Only the add-ons that ship with Blender are available.
- **Large scenes.** A scene over 2 GB is refused; copying and fingerprinting a big one takes time and disk space, and only one Blender run goes at a time. Content hashing is skipped above 1 GiB, where only size and time are compared.
- **Version of an unusual file is unknown.** Compressed files are read by decompressing the first 64 KB; if that fails the version shows "unknown" and the newer-Blender warning cannot be given. Files from Blender before 2.8 were not tested.
- **Inspect counts data blocks**, not the evaluated scene: triangles are before modifiers, linked libraries are listed but not opened, and procedural or geometry-node output is not counted. Missing-file checks cover images, sounds, fonts and movie clips.
- **No export or import is run by the app.** A script you approve can export, and its outputs are recorded; the import notes are a checklist. Copying results into the project is left to you.
- **Opening a scene is a hand-off.** Windows picks the Blender version; the app cannot tell which one opened or stop it.
- **Live bridge not built.** The app starts Blender itself; it does not talk to a running Blender window (add-on or MCP). A Blender MCP server configured elsewhere on this PC is not used by the app.
- **Tracking compares size and modification time**, not content, so a file rewritten with the same size and time is not noticed.
- **The real-Blender tests run only where Blender is found** (`GDCC_BLENDER_DIR` or Program Files). Elsewhere they are skipped and reported as skipped, not passed.
- **Live check scope:** two small real scenes were described on copies; no real script was run against your files, and `Locker2.blend` (190 MB) and the asset-pack files were only scanned (headers), not opened by Blender.
