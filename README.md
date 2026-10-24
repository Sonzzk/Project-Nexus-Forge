# Project-Nexus-Forge
## 👷-WIP-⚒️

A litte or big project you may call it with the goal of building the ultimate all-in-one development command center. Generally for making games in Unreal, Godot and web based games

## What the app is

**GameDev Command Center** is a local-first Windows desktop app for AI-assisted game development. It keeps your projects (Unreal Engine 5, Godot, Blender, Vite web games and others), their tasks, context, Git status, tests and assets in one place, and works with Claude Code, Codex and local Ollama models without hiding what they do or what they cost. It never moves or changes your game projects unless you approve a specific change, and it needs no account, cloud database or paid API.

It is built with Electron, React and TypeScript (Vite), with SQLite for app data. The design is in [ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Status

The plan and the design are done (Steps 1 and 2), the app is scaffolded (Step 3), its core is built (Step 4) and it has a working shell with a dashboard, command palette and settings (Step 5): a secure Electron window, typed IPC, logging with redaction, a SQLite database with migrations and backups, settings, an activity log and a safe process runner, with working dev, build, lint, test and end-to-end commands. Features arrive one roadmap step at a time (project registry first). Development needs Node.js 24 LTS on Windows 11 (see [decision D-012](docs/DECISIONS.md)). [STATUS.md](docs/STATUS.md) always has the current step.

## Install and run (Windows)

You need Node.js 24 LTS (24.15 or newer 24.x; `node -v` should print v24) and Git. In the project folder:

```bash
npm install
npm run dev
```

`npm run dev` opens the app window with hot reload. The desktop shortcut runs `scripts\launch.cmd`, which does the same. App data (database, backups, logs) goes to `%APPDATA%\GameDevCommandCenter`.

| Command | What it does |
|---|---|
| `npm run dev` | Start the app in development mode |
| `npm run build` | Build main, preload and renderer into `out/` |
| `npm run typecheck` | Type-check all three TypeScript projects |
| `npm run lint` | ESLint, including the import boundaries between main, preload and renderer |
| `npm test` | Unit, integration and component tests (Vitest) |
| `npm run test:e2e` | Build, then run the end-to-end tests against the real Electron app (Playwright) |
| `npm run check:docs` | Check the documents (spec hash, roadmap, requirements trace, dependency pins) and their tests |
| `npm run format` | Format the code with Prettier |

## Where things are

| Path | What |
|---|---|
| `docs/` | Specification, roadmap, architecture, decisions, status and known issues |
| `scripts/` | `check-docs.mjs` (documentation check) and `launch.cmd` (desktop shortcut target) |
| `assets/icon/` | App icon |
| `src/main/`, `src/preload/`, `src/renderer/`, `src/shared/` | App code (layout in ARCHITECTURE.md section 3) |
| `test/` | Test fixtures, mocks and end-to-end tests (`test/e2e`) |

App data lives outside the repository in `%APPDATA%\GameDevCommandCenter` (database, backups and logs).

## Project documents

The app is built in 29 steps, one at a time, each tagged `step-NN` in Git.

- [Master specification](docs/MASTER_SPEC.md): the source of truth
- [App data, backups and export format](docs/DATA.md) and the [recovery guide](docs/RECOVERY.md)
- [Architecture](docs/ARCHITECTURE.md): modules, interfaces, security model, data model, testing strategy and pinned dependencies
- [Roadmap](docs/ROADMAP.md): the 29 steps, their dependencies and acceptance criteria
- [Requirements trace](docs/REQUIREMENTS.md): which step owns each requirement
- [Status](docs/STATUS.md): what is done and what comes next
- [Decisions](docs/DECISIONS.md), [Known issues](docs/KNOWN_ISSUES.md), [Changelog](CHANGELOG.md)
- [CLAUDE.md](CLAUDE.md): working rules for AI coding sessions

Check the documents with `npm run check:docs`.
