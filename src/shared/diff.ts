// A small line diff for previews (spec §8: "Before editing existing documents, preview meaningful changes").
// Pure and dependency-free so main and renderer tests can share it. Documents are capped, so a plain LCS table is enough.

export type DiffLine =
  | { kind: 'same' | 'add' | 'remove'; text: string }
  /** `count` unchanged lines that were left out of the preview. */
  | { kind: 'skip'; count: number };

export const MAX_DIFF_LINES = 3000;

const splitLines = (text: string): string[] => {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\n$/, ''); // one final line break does not make an extra line
  return text === '' ? [] : normalized.split('\n');
};

/**
 * Line diff of `before` against `after`, with long unchanged runs collapsed to a `skip` line (`context` lines kept around
 * each change). Returns undefined when either text has more than MAX_DIFF_LINES lines (the caller shows a size summary).
 */
export function diffLines(before: string, after: string, context = 2): DiffLine[] | undefined {
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) return undefined;

  // lengths[i][j] = length of the longest common run of a[i..] and b[j..]
  const lengths: Uint16Array[] = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const row = lengths[i] as Uint16Array;
      row[j] = a[i] === b[j] ? ((lengths[i + 1] as Uint16Array)[j + 1] ?? 0) + 1 : Math.max((lengths[i + 1] as Uint16Array)[j] ?? 0, row[j + 1] ?? 0);
    }
  }

  const all: { kind: 'same' | 'add' | 'remove'; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      all.push({ kind: 'same', text: a[i] as string });
      i++;
      j++;
    } else if (j < b.length && (i === a.length || ((lengths[i] as Uint16Array)[j + 1] ?? 0) > ((lengths[i + 1] as Uint16Array)[j] ?? 0))) {
      all.push({ kind: 'add', text: b[j] as string });
      j++;
    } else {
      all.push({ kind: 'remove', text: a[i] as string });
      i++;
    }
  }

  // Keep changed lines and `context` lines around them; collapse the rest.
  const keep = all.map(() => false);
  all.forEach((line, index) => {
    if (line.kind === 'same') return;
    for (let k = Math.max(0, index - context); k <= Math.min(all.length - 1, index + context); k++) keep[k] = true;
  });
  const result: DiffLine[] = [];
  let skipped = 0;
  all.forEach((line, index) => {
    if (keep[index]) {
      if (skipped > 0) result.push({ kind: 'skip', count: skipped });
      skipped = 0;
      result.push(line);
    } else skipped++;
  });
  if (skipped > 0 && result.length > 0) result.push({ kind: 'skip', count: skipped });
  return result;
}

export const hasChanges = (diff: DiffLine[] | undefined): boolean => diff === undefined || diff.some((line) => line.kind === 'add' || line.kind === 'remove');
