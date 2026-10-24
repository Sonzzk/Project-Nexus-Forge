# Changelog

Meaningful changes, newest first. Each step is tagged `step-NN` in Git.

## Unreleased

### Added
- `assets/icon/nexus-ai.png` and multi-size `nexus-ai.ico`: the Nexus AI app icon, used as the window icon since Step 3 (Step 27 uses it for the installer).

## Step 3 · Project setup and scaffolding (2026-10-24, tag `step-03`)

### Added
- The Electron 45 + React 19 + TypeScript 6 + electron-vite 6 app, written by hand in the ARCHITECTURE.md layout: `src/main`, `src/preload`, `src/renderer`, `src/shared`. It opens a window with a placeholder page; there are no features yet.
- Secure window: context isolation, sandbox, no Node integration, `app://renderer` scheme with the CSP as header and meta tag, blocked navigation, new windows, webviews and permission requests, single-instance lock, data folder `%APPDATA%\GameDevCommandCenter` (`GDCC_USER_DATA_DIR` in dev and tests only). Empty frozen `window.api`.
- npm scripts `dev`, `build`, `typecheck`, `lint`, `format`, `test`, `test:e2e`, `check:docs`; strict TypeScript (three projects), ESLint with import boundaries, Prettier, Vitest and Playwright configs; `.gitignore`, `.npmrc` (`engine-strict`), pinned `package.json` and the committed lockfile.
- 23 unit tests (CSP text, renderer path resolver, navigation allowlist) and 6 end-to-end security tests on the built app.
- Decision D-028 and known issue KI-009.

### Changed
- `scripts/launch.cmd` now starts the real app (`npm run dev`).
- `README.md` has install and run instructions and the command table; `CLAUDE.md` quality gates use the npm scripts; ARCHITECTURE.md records what Step 3 did and where it differed from the checklist.
- KI-001 (Node.js 20) removed: a clean install, build, tests and the app run on Node 24.22.1.

## Step 2 · System design and dependencies (2026-10-24, tag `step-02`)

### Added
- `docs/ARCHITECTURE.md`: runtimes and pinned dependencies with license, source and verification date; process model; folder structure; owner folder and interface sketches for every spec §4 module; IPC design; security model covering every §4 and §14 rule; data model v1 with the migration and backup policy; feature-status manifest; error model; logging; process ownership and shutdown; testing strategy; risks; the Step 3 checklist.
- Decisions D-011 to D-027 (Electron 45, Node.js 24, electron-vite, `node:sqlite`, TypeScript 6.0, UI building blocks, logging, tests, packaging, IPC, `app://` scheme, data folder, Windows processes, Claude Code project hooks, migrations).
- Known issues KI-006 to KI-008.
- The docs check now verifies that every pinned dependency has an exact version, license, date, step and https source; that `package.json` (from Step 3) uses exactly the pinned versions; and that every §4 module has a `src/` folder and sketched interfaces. Seven new tests cover it.

### Changed
- `README.md`: what the app is, current status and where things are; the original text is kept.
- `CLAUDE.md`: points to ARCHITECTURE.md, adds the pinning and path/command rules and the end-to-end test gate.
- `docs/ROADMAP.md`: Step 3 now writes the scaffold by hand from ARCHITECTURE.md and checks Node.js 24 first.
- D-003 is accepted; KI-001 records the Node.js decision.

### After the `step-02` tag
- Installed Node.js 24.22.1 LTS on the PC with the user's approval (D-012 accepted, KI-001 fixed). The docs check and its 14 tests pass on it.

## Step 1 · Overall architecture and requirements (2026-10-24, tag `step-01`)

### Added
- `docs/MASTER_SPEC.md`: the full master specification and the user's 29-step table, verbatim, with a SHA-256 in `docs/MASTER_SPEC.sha256`.
- `docs/ROADMAP.md`: milestones, phase mapping, dependency map, step classification, ordering-conflict rules and a plan block for each of the 29 steps.
- `docs/REQUIREMENTS.md`: every spec section, every §27 and §29K acceptance criterion and the notes after the step table, mapped to owning steps.
- `CLAUDE.md`: permanent working rules for every build session.
- `docs/STATUS.md`, `docs/DECISIONS.md`, `docs/KNOWN_ISSUES.md` and this changelog.
- `scripts/check-docs.mjs` and its tests in `scripts/check-docs.test.mjs`.

### Changed
- `README.md`: added links to the project documents; the original text is kept.

### Fixed (after the `step-01` tag)
- `scripts/check-docs.test.mjs`: two tests failed on Windows checkouts with CRLF line endings; the test helper now normalizes line endings like the check does.
