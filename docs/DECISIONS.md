# Decisions

Important decisions and why they were made. Newest last. Status is Accepted, Proposed (to be confirmed by a named step) or Superseded.

## D-001 · Where the project documents live (Step 1, Accepted)

The spec suggests documents in three places: §8 lists project-memory files for the *game projects the app manages*, §24 asks for README, ARCHITECTURE, ROADMAP and DECISIONS, and §30 names `docs/ROADMAP.md`, `docs/STATUS.md`, `docs/DECISIONS.md`, `docs/KNOWN_ISSUES.md` and a root `CHANGELOG.md`.
For this repository we follow §30: progress documents in `docs/`, `CHANGELOG.md`, `README.md` and `CLAUDE.md` at the root. `ARCHITECTURE.md` goes to `docs/` in Step 2. The §8 list is a feature of the app (Step 9), not a layout for this repository.

## D-002 · Steps versus spec sections, and section 30 (Step 1, Accepted)

The request says "sections 1–29", but the spec has 30 sections, and the user's table has 29 *build steps* whose titles do not match the spec's section numbers (for example step 12 "Provider integrations" covers spec §9 and step 17 "Activity logs and monitoring" covers spec §15).
Section 30 is treated as binding permanent rules and condensed into CLAUDE.md. The roadmap follows the user's 29 steps; REQUIREMENTS.md maps all 30 sections onto them so nothing is skipped.

## D-003 · Application stack (Step 1, Proposed; Step 2 confirms versions and libraries)

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
