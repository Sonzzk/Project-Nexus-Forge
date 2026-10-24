# Known issues

Verified bugs, limitations and workarounds. Remove an entry only when the fix is tested; say which step fixed it.

## KI-001 · Installed Node.js is end-of-life and too old for current Vite (found in Step 1, fixed in Step 2)

The PC has Node.js v20.18.1 (checked 2026-10-24). The Node.js release schedule lists the v20 line as end-of-life on 2026-04-30 (https://github.com/nodejs/Release, schedule.json), and the Vite guide (v8.3.4, checked 2026-10-24) says "Vite requires Node.js version 20.19+, 22.12+". The scaffold in Step 3 will not install or run on this Node version.
Step 2 decided on Node.js 24.22.1 LTS (D-012) and, with the user's approval, installed it on 2026-10-24 (`node -v` shows v24.22.1; the docs check and its 14 tests pass on it). This entry stays until Step 3 confirms a clean install of the app on it.

## KI-002 · GitHub CLI is not installed (found in Step 1, accepted)

`gh` is not on PATH. Pushing works through Git with the Git Credential Manager, so the build does not need it. Tasks that would use `gh` (pull requests, repository settings) need it installed first, with the user's approval.

## KI-003 · Ollama's local API did not answer (found in Step 1, open)

Ollama is installed (`%LOCALAPPDATA%\Programs\Ollama\ollama.exe`), but `http://localhost:11434/api/version` did not respond within 3 seconds on 2026-10-24, most likely because Ollama was not running. Step 12 must report "installed but not running" clearly instead of failing or pretending.

## KI-004 · Engines and some CLIs are not on PATH (found in Step 1, accepted)

Codex CLI, Blender and Godot were not found on PATH; Unreal Engine installs were not checked yet. Discovery in Steps 18–20 and the first-run wizard in Step 25 must look in configured paths and documented install locations, not just PATH.

## KI-005 · Global Git email is a placeholder (found in Step 1, worked around)

The PC's global `user.email` is `you@example.com`. This repository sets a local `user.email` to the GitHub no-reply address used by the user's earlier commits (D-009). Other repositories on this PC still use the placeholder; changing the global setting is the user's call.

## KI-006 · `node:sqlite` is a release candidate (found in Step 2, accepted)

Node 24's docs mark `node:sqlite` as stability 1.2, "Release candidate" (since 24.15.0); it is not yet stable. Node 24 is an LTS line, so breaking changes are unlikely, but all database access goes through the `Db` wrapper so better-sqlite3 can replace it if needed (D-015). The bundler must also leave `node:sqlite` as a built-in; Step 3 or 4 proves it by opening the database in the built app.

## KI-007 · Playwright's Electron support is experimental (found in Step 2, accepted)

Playwright's docs say it "has experimental support for Electron automation" (Electron v21 and later). End-to-end tests stay few and focused on what only the real app can show (window security, startup, persistence across restarts); logic is tested with Vitest (D-019).

## KI-008 · Claude Code 2.1.197 is older than the documented behavior (found in Step 2, open)

The installed Claude Code is 2.1.197 (Step 1 check). The current headless docs describe options added later, for example `--permission-prompts` (2.1.259 or later) and `-p` runs starting in Manual mode (2.1.302 or later). Step 12 must detect the version and derive capabilities from it instead of assuming the documented flags exist. Updating Claude Code is the user's choice.
