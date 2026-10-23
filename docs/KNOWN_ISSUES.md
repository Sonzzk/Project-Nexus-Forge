# Known issues

Verified bugs, limitations and workarounds. Remove an entry only when the fix is tested; say which step fixed it.

## KI-001 · Installed Node.js is end-of-life and too old for current Vite (found in Step 1, open)

The PC has Node.js v20.18.1 (checked 2026-10-24). The Node.js release schedule lists the v20 line as end-of-life on 2026-04-30 (https://github.com/nodejs/Release, schedule.json), and the Vite guide (v8.3.4, checked 2026-10-24) says "Vite requires Node.js version 20.19+, 22.12+". The scaffold in Step 3 will not install or run on this Node version.
Workaround: none yet. Step 2 picks the runtime (v22 is in maintenance until 2027-04-30, v24 is LTS until 2028-04-30) and asks the user before anything is installed.

## KI-002 · GitHub CLI is not installed (found in Step 1, accepted)

`gh` is not on PATH. Pushing works through Git with the Git Credential Manager, so the build does not need it. Tasks that would use `gh` (pull requests, repository settings) need it installed first, with the user's approval.

## KI-003 · Ollama's local API did not answer (found in Step 1, open)

Ollama is installed (`%LOCALAPPDATA%\Programs\Ollama\ollama.exe`), but `http://localhost:11434/api/version` did not respond within 3 seconds on 2026-10-24, most likely because Ollama was not running. Step 12 must report "installed but not running" clearly instead of failing or pretending.

## KI-004 · Engines and some CLIs are not on PATH (found in Step 1, accepted)

Codex CLI, Blender and Godot were not found on PATH; Unreal Engine installs were not checked yet. Discovery in Steps 18–20 and the first-run wizard in Step 25 must look in configured paths and documented install locations, not just PATH.

## KI-005 · Global Git email is a placeholder (found in Step 1, worked around)

The PC's global `user.email` is `you@example.com`. This repository sets a local `user.email` to the GitHub no-reply address used by the user's earlier commits (D-009). Other repositories on this PC still use the placeholder; changing the global setting is the user's call.
