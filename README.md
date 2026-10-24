# Project-Nexus-Forge
## 👷-WIP-⚒️

A litte or big project you may call it with the goal of building the ultimate all-in-one development command center. Generally for making games in Unreal, Godot and web based games

## What the app is

**GameDev Command Center** is a local-first Windows desktop app for AI-assisted game development. It keeps your projects (Unreal Engine 5, Godot, Blender, Vite web games and others), their tasks, context, Git status, tests and assets in one place, and works with Claude Code, Codex and local Ollama models without hiding what they do or what they cost. It never moves or changes your game projects unless you approve a specific change, and it needs no account, cloud database or paid API.

It is built with Electron, React and TypeScript (Vite), with SQLite for app data. The design is in [ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Status

The plan and the design are done (Steps 1 and 2). There is no application code yet; Step 3 scaffolds the app. Development needs Node.js 24 LTS on Windows 11 (see [decision D-012](docs/DECISIONS.md)). [STATUS.md](docs/STATUS.md) always has the current step.

## Where things are

| Path | What |
|---|---|
| `docs/` | Specification, roadmap, architecture, decisions, status and known issues |
| `scripts/` | `check-docs.mjs` (documentation check) and `launch.cmd` (desktop shortcut target) |
| `assets/icon/` | App icon |
| `src/main/`, `src/preload/`, `src/renderer/`, `src/shared/` | App code, from Step 3 (layout in ARCHITECTURE.md section 3) |
| `test/` | Test fixtures, mocks and end-to-end tests, from Step 3 |

App data lives outside the repository in `%APPDATA%\GameDevCommandCenter` (database, backups and logs).

## Project documents

The app is built in 29 steps, one at a time, each tagged `step-NN` in Git.

- [Master specification](docs/MASTER_SPEC.md): the source of truth
- [Architecture](docs/ARCHITECTURE.md): modules, interfaces, security model, data model, testing strategy and pinned dependencies
- [Roadmap](docs/ROADMAP.md): the 29 steps, their dependencies and acceptance criteria
- [Requirements trace](docs/REQUIREMENTS.md): which step owns each requirement
- [Status](docs/STATUS.md): what is done and what comes next
- [Decisions](docs/DECISIONS.md), [Known issues](docs/KNOWN_ISSUES.md), [Changelog](CHANGELOG.md)
- [CLAUDE.md](CLAUDE.md): working rules for AI coding sessions

Check the documents with `node scripts/check-docs.mjs` and `node --test scripts/check-docs.test.mjs`.
