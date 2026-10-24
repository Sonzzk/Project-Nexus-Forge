import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Every test that writes uses a fresh temp folder and removes it afterwards (ARCHITECTURE.md section 14).
const created: string[] = [];
const closers: (() => void)[] = [];

export function makeTempDir(prefix = 'gdcc-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

/** Registers something to close (a database, a process) before the temp folders are removed, even if the test failed. */
export function closeOnCleanup(close: () => void): void {
  closers.push(close);
}

export function removeTempDirs(): void {
  for (const close of closers.splice(0)) {
    try {
      close();
    } catch {
      // Already closed or broken; removing the folder is what matters.
    }
  }
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
}
