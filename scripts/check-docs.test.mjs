// Run: node --test scripts/check-docs.test.mjs
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkDocs } from './check-docs.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');

// Copy docs/ to a temp root, apply one edit, and return the check's errors.
function errorsAfter(file, edit) {
  const root = mkdtempSync(join(tmpdir(), 'check-docs-'));
  try {
    cpSync(join(repo, 'docs'), join(root, 'docs'), { recursive: true });
    const path = join(root, 'docs', file);
    const before = readFileSync(path, 'utf8');
    const after = edit(before);
    assert.notEqual(after, before, 'the edit must change the file');
    writeFileSync(path, after);
    return checkDocs(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

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
