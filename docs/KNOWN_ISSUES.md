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

Node 24's docs mark `node:sqlite` as stability 1.2, "Release candidate" (since 24.15.0); it is not yet stable. Node 24 is an LTS line, so breaking changes are unlikely, but all database access goes through the `Db` wrapper so better-sqlite3 can replace it if needed (D-015). The bundler must also leave `node:sqlite` as a built-in; Step 3 or 4 proves it by opening the database in the built app.

## KI-007 · Playwright's Electron support is experimental (found in Step 2, accepted)

Playwright's docs say it "has experimental support for Electron automation" (Electron v21 and later). End-to-end tests stay few and focused on what only the real app can show (window security, startup, persistence across restarts); logic is tested with Vitest (D-019).
Step 3 checked it: Playwright 1.64.1 launches and drives the built Electron 45 app, and the six end-to-end security tests pass. It needs the app built first (`npm run test:e2e` does that).

## KI-008 · Claude Code 2.1.197 is older than the documented behavior (found in Step 2, open)

The installed Claude Code is 2.1.197 (Step 1 check). The current headless docs describe options added later, for example `--permission-prompts` (2.1.259 or later) and `-p` runs starting in Manual mode (2.1.302 or later). Step 12 must detect the version and derive capabilities from it instead of assuming the documented flags exist. Updating Claude Code is the user's choice.

## KI-009 · The window shows Electron's default menu bar (found in Step 3, open)

The Step 3 window has Electron's default menu (File, Edit, View, Window). In a development run it also offers developer tools; packaged builds have developer tools off (`devTools: !app.isPackaged`). Step 5 builds the real shell and decides what the menu contains (or removes it).
