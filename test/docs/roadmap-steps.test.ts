import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ROADMAP_STEPS } from '../../src/shared/roadmap-steps';

describe('roadmap steps', () => {
  it('match the headings in docs/ROADMAP.md', () => {
    const roadmap = readFileSync('docs/ROADMAP.md', 'utf8');
    const headings = [...roadmap.matchAll(/^### Step (\d+) · (.+?)\r?$/gm)].map((m) => ({
      n: Number(m[1]),
      title: m[2],
    }));
    expect(ROADMAP_STEPS.map((s) => ({ ...s }))).toEqual(headings);
  });
});
