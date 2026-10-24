// Docs gate: the spec is unchanged, the roadmap matches the user's step table,
// every spec section and acceptance criterion is owned by a step, every dependency
// is pinned with its evidence (and package.json matches), and every §4 module has an owner.
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
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;
// Rows of a Markdown table, without the header and separator lines.
const tableRows = (text) =>
  text.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('|')).slice(2).map((l) => l.slice(1, -1).split('|').map((c) => c.trim()));

export function checkDocs(root) {
  let spec, expectedHash, roadmap, requirements, architecture;
  try {
    spec = read(root, 'docs/MASTER_SPEC.md');
    expectedHash = read(root, 'docs/MASTER_SPEC.sha256').trim();
    roadmap = read(root, 'docs/ROADMAP.md');
    requirements = read(root, 'docs/REQUIREMENTS.md');
    architecture = read(root, 'docs/ARCHITECTURE.md');
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

  const marked = (name) => architecture.match(new RegExp(`<!-- ${name}:BEGIN -->\\n([\\s\\S]*?)\\n<!-- ${name}:END -->`))?.[1];

  // Pinned dependencies: exact version, license, verification date, installing step and an https source.
  const pins = new Map();
  const deps = marked('DEPS');
  if (deps === undefined) errors.push('ARCHITECTURE.md: DEPS markers not found');
  for (const [name, version, license, verified, step, , source] of tableRows(deps ?? '')) {
    const where = `ARCHITECTURE.md: dependency ${name}`;
    if (pins.has(name)) errors.push(`${where} is listed twice`);
    pins.set(name, version);
    if (!EXACT_VERSION.test(version ?? '')) errors.push(`${where} has no exact version`);
    if (!license) errors.push(`${where} has no license`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(verified ?? '')) errors.push(`${where} has no verification date`);
    if (!(Number(step) >= 1 && Number(step) <= STEP_COUNT)) errors.push(`${where} names no valid step`);
    if (!/^https:\/\/\S+$/.test(source ?? '')) errors.push(`${where} has no https source`);
  }

  // From Step 3 on, package.json must use exactly the pinned versions.
  let pkg;
  try {
    pkg = JSON.parse(read(root, 'package.json'));
  } catch (err) {
    if (err.code !== 'ENOENT') errors.push(`package.json: ${err.message}`);
  }
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies'])
    for (const [name, version] of Object.entries(pkg?.[field] ?? {})) {
      if (!EXACT_VERSION.test(version)) errors.push(`package.json: ${name} is "${version}", not an exact version`);
      else if (!pins.has(name)) errors.push(`package.json: ${name} is missing from the ARCHITECTURE.md dependency table`);
      else if (pins.get(name) !== version) errors.push(`package.json: ${name} is ${version} but ARCHITECTURE.md pins ${pins.get(name)}`);
    }

  // Every §4 module (read from the spec) has a row with a src/ folder and interfaces sketched in the file.
  const modules =
    body?.match(/Separate the application into clear modules:\n\n([\s\S]*?)\n\nUse explicit interfaces/)?.[1].split('\n').map((l) => l.replace(/^\* /, '').trim()) ?? [];
  if (modules.length !== 13) errors.push(`MASTER_SPEC.md: found ${modules.length} §4 modules, expected 13`);
  const moduleTable = marked('MODULES');
  if (moduleTable === undefined) errors.push('ARCHITECTURE.md: MODULES markers not found');
  const moduleRows = new Map(tableRows(moduleTable ?? '').map(([name, ...rest]) => [name, rest]));
  for (const module of modules) {
    const [folders, interfaces = ''] = moduleRows.get(module) ?? [];
    if (folders === undefined) {
      errors.push(`ARCHITECTURE.md: §4 module "${module}" has no row in the module table`);
      continue;
    }
    if (!folders.includes('src/')) errors.push(`ARCHITECTURE.md: §4 module "${module}" has no src/ folder`);
    const names = interfaces.split(',').map((s) => s.trim()).filter(Boolean);
    if (names.length === 0) errors.push(`ARCHITECTURE.md: §4 module "${module}" names no interface`);
    for (const name of names)
      if (!new RegExp(`\\b(?:interface|type|class) ${name}\\b`).test(architecture))
        errors.push(`ARCHITECTURE.md: interface ${name} (module "${module}") is not sketched`);
  }

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
