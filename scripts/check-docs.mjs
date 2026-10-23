// Docs gate: the spec is unchanged, the roadmap matches the user's step table,
// and every spec section and acceptance criterion is owned by a step.
// Usage: node scripts/check-docs.mjs [repoRoot]
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const STEP_COUNT = 29;
// From the notes under the step table in the spec: "Sections 1–2" and "Sections 13, 15, 26, 28" are Extra High, the rest High.
const EXTRA_HIGH = new Set([1, 2, 13, 15, 26, 28]);
const REQUIRED_FIELDS = ['Model / effort', 'Spec sections', 'Goal', 'Depends on', 'Acceptance criteria'];
const TRACED_IDS = [
  ...Array.from({ length: 30 }, (_, i) => `§${i + 1}`),
  ...Array.from({ length: 11 }, (_, i) => `§27.${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `§29K.${i + 1}`),
];

// Git on Windows may check files out with CRLF; compare content, not line endings.
const read = (root, path) => readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n');

export function checkDocs(root) {
  let spec, expectedHash, roadmap, requirements;
  try {
    spec = read(root, 'docs/MASTER_SPEC.md');
    expectedHash = read(root, 'docs/MASTER_SPEC.sha256').trim();
    roadmap = read(root, 'docs/ROADMAP.md');
    requirements = read(root, 'docs/REQUIREMENTS.md');
  } catch (err) {
    return [`Missing file: ${err.path ?? err.message}`];
  }
  const errors = [];

  const body = spec.match(/<!-- SPEC:BEGIN -->\n([\s\S]*)\n<!-- SPEC:END -->/)?.[1];
  if (body === undefined) errors.push('MASTER_SPEC.md: SPEC markers not found');
  else if (createHash('sha256').update(body).digest('hex') !== expectedHash)
    errors.push('MASTER_SPEC.md: spec text changed (hash differs from docs/MASTER_SPEC.sha256)');

  // The user's table in the spec: "Section N", blank line, title, blank line, model.
  const table = new Map();
  for (const [, n, title, model] of (body ?? '').matchAll(/^Section (\d+)[ \t]*\n\n(.+?)[ \t]*\n\n(Opus|Sonnet|Haiku)[ \t]*$/gm))
    table.set(Number(n), { title, model });
  if (table.size !== STEP_COUNT) errors.push(`MASTER_SPEC.md: found ${table.size} rows in the step table, expected ${STEP_COUNT}`);

  const blocks = roadmap.split(/^### Step /m).slice(1).map((b) => b.split(/^## /m)[0]);
  if (blocks.length !== STEP_COUNT) errors.push(`ROADMAP.md: found ${blocks.length} step blocks, expected ${STEP_COUNT}`);
  blocks.forEach((block, i) => {
    const expected = i + 1;
    const [, num, title] = block.match(/^(\d+) · (.+)/) ?? [];
    const n = Number(num);
    if (n !== expected) return errors.push(`ROADMAP.md: step block ${expected} is numbered "${num}"`);
    const field = (name) => block.match(new RegExp(`^- \\*\\*${name}:\\*\\*(.*)$`, 'm'))?.[1].trim();
    for (const name of REQUIRED_FIELDS) if (field(name) === undefined) errors.push(`ROADMAP.md: Step ${n} has no "${name}"`);

    const row = table.get(n);
    if (row && title.trim() !== row.title) errors.push(`ROADMAP.md: Step ${n} title "${title.trim()}" differs from the table ("${row.title}")`);
    const effort = EXTRA_HIGH.has(n) ? 'Extra High' : 'High';
    const modelEffort = field('Model / effort');
    if (row && modelEffort !== undefined && modelEffort !== `${row.model} · ${effort}`)
      errors.push(`ROADMAP.md: Step ${n} is "${modelEffort}", the table says "${row.model} · ${effort}"`);

    const deps = field('Depends on');
    if (deps === undefined) return;
    const refs = [...deps.matchAll(/Step (\d+)/g)].map((m) => Number(m[1]));
    if (n > 1 && refs.length === 0) errors.push(`ROADMAP.md: Step ${n} depends on nothing`);
    for (const d of refs) if (d >= n) errors.push(`ROADMAP.md: Step ${n} depends on later Step ${d}`);
  });

  const traced = new Map();
  for (const [, id, rest] of requirements.matchAll(/^\| (§[^ |]+) \|(.*)$/gm)) traced.set(id, rest);
  for (const id of TRACED_IDS) {
    const steps = [...(traced.get(id) ?? '').matchAll(/\bS(\d+)\b/g)].map((m) => Number(m[1]));
    if (steps.length === 0) errors.push(`REQUIREMENTS.md: ${id} is not traced to any step`);
  }
  for (const [id, rest] of traced)
    for (const [, s] of rest.matchAll(/\bS(\d+)\b/g))
      if (Number(s) < 1 || Number(s) > STEP_COUNT) errors.push(`REQUIREMENTS.md: ${id} names unknown step S${s}`);

  return errors;
}

// Windows paths may differ only in drive-letter case.
if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  const root = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..');
  const errors = checkDocs(root);
  for (const e of errors) console.error(`✗ ${e}`);
  console.log(errors.length ? `${errors.length} problem(s) found` : 'Docs check passed');
  process.exitCode = errors.length ? 1 : 0;
}
