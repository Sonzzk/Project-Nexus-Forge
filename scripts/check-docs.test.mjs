// Run: node --test scripts/check-docs.test.mjs
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkDocs } from './check-docs.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');

// Copy docs/ to a temp root, let `prepare` change it, and return the check's errors.
function inTempCopy(prepare) {
  const root = mkdtempSync(join(tmpdir(), 'check-docs-'));
  try {
    cpSync(join(repo, 'docs'), join(root, 'docs'), { recursive: true });
    prepare(root);
    return checkDocs(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Apply one edit to a file in docs/.
const errorsAfter = (file, edit) =>
  inTempCopy((root) => {
    const path = join(root, 'docs', file);
    // Same normalization as the check: Windows checkouts use CRLF, and `.` does not match `\r`.
    const before = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
    const after = edit(before);
    assert.notEqual(after, before, 'the edit must change the file');
    writeFileSync(path, after);
  });

const errorsWithPackage = (pkg) => inTempCopy((root) => writeFileSync(join(root, 'package.json'), JSON.stringify(pkg)));

test('the committed docs pass', () => {
  assert.deepEqual(checkDocs(repo), []);
});

test('changing one word of the spec is caught', () => {
  const errors = errorsAfter('MASTER_SPEC.md', (s) => s.replace('Never scan the entire drive', 'Always scan the entire drive'));
  assert.match(errors.join('\n'), /spec text changed/);
});

test('a dependency on a later step is caught', () => {
  const errors = errorsAfter('ROADMAP.md', (s) => s.replace(/(### Step 3 ·[\s\S]*?\*\*Depends on:\*\*) Step 2/, '$1 Step 5'));
  assert.match(errors.join('\n'), /Step 3 depends on later Step 5/);
});

test('a model that differs from the user table is caught', () => {
  const errors = errorsAfter('ROADMAP.md', (s) => s.replace(/(### Step 13 ·[\s\S]*?\*\*Model \/ effort:\*\*) Opus/, '$1 Sonnet'));
  assert.match(errors.join('\n'), /Step 13 is "Sonnet · Extra High", the table says "Opus · Extra High"/);
});

test('a missing required field is caught', () => {
  const errors = errorsAfter('ROADMAP.md', (s) => s.replace(/(### Step 20 ·[\s\S]*?)- \*\*Acceptance criteria:\*\*/, '$1- **Checks:**'));
  assert.match(errors.join('\n'), /Step 20 has no "Acceptance criteria"/);
});

test('a spec section without an owning step is caught', () => {
  const errors = errorsAfter('REQUIREMENTS.md', (s) => s.replace(/^\| §19 \|.*\n/m, ''));
  assert.match(errors.join('\n'), /§19 is not traced/);
});

test('an acceptance criterion without an owning step is caught', () => {
  const errors = errorsAfter('REQUIREMENTS.md', (s) => s.replace(/^\| §27\.6 \|.*\n/m, ''));
  assert.match(errors.join('\n'), /§27\.6 is not traced/);
});

test('a package.json that uses the pinned versions passes', () => {
  assert.deepEqual(errorsWithPackage({ dependencies: { react: '19.3.1' }, devDependencies: { electron: '45.0.0' } }), []);
});

test('a version range in package.json is caught', () => {
  const errors = errorsWithPackage({ devDependencies: { electron: '^45.0.0' } });
  assert.match(errors.join('\n'), /electron is "\^45\.0\.0", not an exact version/);
});

test('a package missing from the pinned table is caught', () => {
  const errors = errorsWithPackage({ dependencies: { 'left-pad': '1.3.0' } });
  assert.match(errors.join('\n'), /left-pad is missing from the ARCHITECTURE\.md dependency table/);
});

test('a package.json version that differs from the pin is caught', () => {
  const errors = errorsWithPackage({ devDependencies: { electron: '44.9.3' } });
  assert.match(errors.join('\n'), /electron is 44\.9\.3 but ARCHITECTURE\.md pins 45\.0\.0/);
});

test('a pinned dependency without an https source is caught', () => {
  const errors = errorsAfter('ARCHITECTURE.md', (s) => s.replace('| https://zod.dev |', '| zod docs |'));
  assert.match(errors.join('\n'), /dependency zod has no https source/);
});

test('a §4 module without an owner is caught', () => {
  const errors = errorsAfter('ARCHITECTURE.md', (s) => s.replace(/^\| Git integration \|.*\n/m, ''));
  assert.match(errors.join('\n'), /module "Git integration" has no row/);
});

test('a module interface that is not sketched is caught', () => {
  const errors = errorsAfter('ARCHITECTURE.md', (s) => s.replace('export interface GitService', 'export interface GitThing'));
  assert.match(errors.join('\n'), /interface GitService \(module "Git integration"\) is not sketched/);
});
