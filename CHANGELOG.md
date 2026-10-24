# Changelog

Meaningful changes, newest first. Each step is tagged `step-NN` in Git.

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
