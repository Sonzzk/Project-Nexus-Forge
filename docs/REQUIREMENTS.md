# Requirements trace

Every section of [MASTER_SPEC.md](MASTER_SPEC.md) and every acceptance criterion, mapped to the build steps in [ROADMAP.md](ROADMAP.md) that own it. "S7" means Step 7. The first step listed builds the requirement; later steps extend or verify it. `node scripts/check-docs.mjs` fails if any section or criterion loses its owner.

## Spec sections

| ID | Requirement | Steps | Notes |
|---|---|---|---|
| §1 | Role and mission: a real, maintainable app built in tested milestones, not one big untested dump | S1, S26 | Working method lives in CLAUDE.md; S26 checks the result |
| §2 | Environment: Windows 11, i5-10400F, RTX 3060 12 GB, 64 GB RAM, UE5, Blender, Godot, Vite, Claude Code, Ollama (~9B), tiny budget; must survive switching engines, providers or hardware | S2, S12, S13, S18, S19, S20, S21 | Hardware limits drive S13; adapters keep vendors replaceable |
| §3 | Core vision: answer the ten questions at any time; centralize context, tasks, history, agents, tests, Git, engines, assets and providers | S5, S10, S17, S26 | S26 checks every question against real data |
| §4 | Technical foundation: Electron, React, TypeScript, Vite, SQLite, Zod, persistent logs, tests; verified versions; secure main/preload/renderer split; 13 modules with explicit interfaces; local-first | S2, S3, S4, S28 | S2 designs and pins, S3 scaffolds, S4 builds the core, S28 audits |
| §5 | UX: polished dark UI, 11-section sidebar, project switcher, command palette, inspector, density, keyboard navigation, no dead controls | S5, S24, S28 | Feature-status manifest keeps controls honest |
| §6 | Multi-project management: per-project fields, type detection from files, manual override, add without moving, read-only discovery of authorized folders only | S6, S7, S8, S10, S22 | Backup settings S8, roadmap and risks S10, asset inventory S22 |
| §7 | Audit and context engine: evidence-based audit, confirmed versus inferred, visual report; reusable, previewable, task-specific context packs | S7, S9 | |
| §8 | Persistent project memory: inspect existing docs first, minimal compatible set, storage choice, preview before edits, incremental updates, session handoff | S9, S22, S23 | ASSET_REGISTER in S22, TEST_PLAN checklists in S23 |
| §9 | AI provider architecture: typed provider contract, capability detection, honest "Unavailable from this provider" | S2, S12, S14 | |
| §9A | Claude Code through documented CLI interfaces, normal auth and permissions | S12, S15 | Write-capable runs only after S15 |
| §9B | Ollama through its documented local API, no automatic large downloads | S12, S13 | Warm-up and unloading policy in S13 |
| §9C | Codex CLI, optional and independent | S12 | |
| §9D | Future providers through adapters, no hard-coded vendor | S2, S12 | |
| §10 | Task planning: full task fields, lifecycle, Kanban, list, milestone roadmap, templates, next-task recommendation, plan approval, plain-language breakdown | S10, S11, S12 | AI-assisted breakdown arrives with providers in S12 |
| §11 | Agent roles and orchestration: six roles, read-only by default, visible states, single writer, worktrees for parallel work | S11, S13, S15, S16 | |
| §12 | Model routing and usage economy: four profiles, per-role overrides, cost visibility, usage log, budgets, bounded retries, approval before escalation | S13, S14 | |
| §13 | Hardware-aware local inference: resource monitor, safety policy, thresholds, game-performance mode, never kill other apps | S13, S17 | Service in S13, UI in S17 |
| §14 | Safe execution and change review: pre-write checks, no destructive operations without approval, diffs, approve/reject/revert, checkpoints, scoped permissions, secret protection | S4, S7, S15, S16 | Redaction base S4, Git reads S7 |
| §15 | Live activity, terminal and session view: observable facts only, persisted sessions, command queue | S12, S13, S17 | |
| §16 | Engine and application integrations through a shared interface with honest capability reports | S2, S6, S18, S19, S20, S21 | |
| §16-UE | Unreal Engine 5 adapter | S18 | |
| §16-Blender | Blender adapter | S19 | |
| §16-Godot | Godot adapter | S20 | |
| §16-Vite | Vite and web games adapter | S21 | |
| §17 | Asset and content management: inventory, metadata, previews, naming, briefs, no unconfirmed moves | S19, S22 | |
| §18 | Testing and QA: definition of done, test runner, five result states, static checks separated from playtests, checklists | S3, S23 | S3 sets up the app's own tests |
| §19 | Backrooms game development mode: domains, scope tiers, risk register, feature-creep control | S10, S18 | Generic parts S10, profile S18 |
| §20 | Project dashboard and long-term roadmap: real progress, portfolio, pause, snapshots, release checklists | S5, S6, S9, S10, S12, S15, S16, S17, S23 | Each step adds its dashboard card |
| §21 | Settings and customization, guided first run, optional features off until ready | S4, S24, S25 | Store in S4, page in S24, wizard in S25 |
| §22 | Data storage and reliability: SQLite with migrations, transactions, export/import, never overwrite silently, backups | S4, S8 | |
| §23 | Development standards: strict TS, lint, typed errors, tests, process cleanup, no mock data in the real UI | S3, S4, S26, S28 | Applies to every step |
| §24 | Development phases 0–6 | S1, S2, S3, S12, S15, S16, S18, S22, S27 | Phase-to-step map at the top of ROADMAP.md |
| §25 | Working method for the coding agent | S1, S26 | Rules in CLAUDE.md, applied in every step |
| §26 | What not to do | S1, S15, S28 | Rules in CLAUDE.md; S28 audits |
| §27 | First usable release acceptance criteria | S26 | Tested explicitly in S26 (rows below) |
| §28 | First response: architecture and alternatives, folder structure, first milestone, risks, MVP features | S1, S2, S3 | |
| §29 | Automated tooling, plugins, MCP servers, skills and bootstrapping | S29 | Only after registry, persistence, logging and safety work |
| §29A | Project bootstrap wizard | S29 | Sub-task 29.3 |
| §29B | Tool discovery engine and registry fields | S29 | Sub-task 29.1 |
| §29C | Plugins, skills, MCP servers, subagents, hooks and CLI utilities as separate categories | S29 | Sub-task 29.1 |
| §29D | Recommended tool profiles (essential, UE5, Blender, Godot, Vite) | S29 | Sub-task 29.3 |
| §29E | Automated skill generation | S29 | Sub-task 29.5 |
| §29F | MCP server management | S29 | Sub-task 29.2 |
| §29G | Safe automated installation | S29 | Sub-task 29.3 |
| §29H | Tool health and maintenance | S29 | Sub-task 29.4 |
| §29I | Project name and identity | S27, S29 | Configurable app name in S27, identity profiles in 29.6 |
| §29J | Tooling policy | S29 | Applied across 29.1–29.5 |
| §30 | Permanent project instructions and development rules (CLAUDE.md, progress docs, Git, security, quality gates, scope control) | S1, S28 | Created in S1, kept current by every step |

## First usable release (§27)

| ID | Criterion | Steps | Notes |
|---|---|---|---|
| §27.1 | Launch the desktop app on Windows | S3, S27 | Dev run in S3, packaged build in S27 |
| §27.2 | Add the Backrooms project without moving or modifying it | S6, S25 | |
| §27.3 | See basic project information and detected structure | S6, S7 | |
| §27.4 | Inspect a clear project-audit report | S7 | |
| §27.5 | Create tasks, milestones, notes and project context | S9, S10 | |
| §27.6 | Close and reopen the app without losing that information | S4, S8 | |
| §27.7 | See whether Ollama and supported coding CLIs are installed and available | S12 | |
| §27.8 | Use a useful project dashboard and a real activity log | S5, S10, S17 | |
| §27.9 | Get clear errors for unavailable tools instead of fake success | S12, S25 | |
| §27.10 | Run the app's tests and basic quality checks successfully | S3, S23 | |
| §27.11 | Read the implementation status of later phases | S5 | Implementation Status page, plus docs/STATUS.md |

All eleven are tested together in S26 and recorded in `docs/ACCEPTANCE.md`.

## Tooling feature complete (§29K)

| ID | Criterion | Steps | Notes |
|---|---|---|---|
| §29K.1 | Add a project and receive relevant tooling recommendations | S29 | 29.3 |
| §29K.2 | See prerequisites and implications of each recommendation | S29 | 29.3 |
| §29K.3 | Approve or reject individual installations | S29 | 29.3 |
| §29K.4 | Install or configure supported tools through verified procedures | S29 | 29.3 |
| §29K.5 | Check their real status afterward | S29 | 29.4 |
| §29K.6 | See and diagnose failed integrations | S29 | 29.2, 29.4 |
| §29K.7 | Manage project-specific skills and provider configurations | S29 | 29.1, 29.5 |
| §29K.8 | Review installation history and restore earlier configurations where safe | S29 | 29.3 |
| §29K.9 | Avoid unnecessary downloads, duplicate tools and unapproved paid services | S29 | 29.3 with the §29J policy |

## Notes after the step table

| ID | Requirement | Steps | Notes |
|---|---|---|---|
| Note 1 | Commit whenever a milestone works, so there is always a known-good version | S1 | Git workflow in CLAUDE.md, followed by every step |
| Note 2 | Approval before risky actions; an agent can never quietly grant itself more permissions | S15, S29 | |
| Note 3 | Database backup before schema migrations, tested recovery, never delete user project data | S4, S8 | |
