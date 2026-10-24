import { describe, expect, it } from 'vitest';
import { diffLines, hasChanges, MAX_DIFF_LINES } from './diff';

describe('diffLines', () => {
  it('shows nothing changed for equal text, including different line endings', () => {
    expect(hasChanges(diffLines('a\nb\n', 'a\r\nb\r\n'))).toBe(false);
    expect(diffLines('', '')).toEqual([]);
  });

  it('marks added, removed and changed lines and keeps context around them', () => {
    const before = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'].join('\n');
    const after = ['one', 'two', 'THREE', 'four', 'five', 'six', 'seven', 'eight', 'nine'].join('\n');
    expect(diffLines(before, after, 1)).toEqual([
      { kind: 'skip', count: 1 },
      { kind: 'same', text: 'two' },
      { kind: 'remove', text: 'three' },
      { kind: 'add', text: 'THREE' },
      { kind: 'same', text: 'four' },
      { kind: 'skip', count: 3 },
      { kind: 'same', text: 'eight' },
      { kind: 'add', text: 'nine' },
    ]);
  });

  it('treats a new document as all additions and a cleared one as all removals', () => {
    expect(diffLines('', 'a\nb')).toEqual([
      { kind: 'add', text: 'a' },
      { kind: 'add', text: 'b' },
    ]);
    expect(diffLines('a', '')).toEqual([{ kind: 'remove', text: 'a' }]);
  });

  it('declines to diff a text that is too long instead of freezing', () => {
    const long = Array.from({ length: MAX_DIFF_LINES + 1 }, (_, n) => `line ${n}`).join('\n');
    expect(diffLines(long, 'x')).toBeUndefined();
    expect(hasChanges(undefined)).toBe(true);
  });

  it('moves a line down as one removal and one addition, not a rewrite of everything', () => {
    const diff = diffLines('a\nb\nc\nd', 'b\nc\nd\na', 5) ?? [];
    expect(diff.filter((line) => line.kind === 'add')).toHaveLength(1);
    expect(diff.filter((line) => line.kind === 'remove')).toHaveLength(1);
  });
});
