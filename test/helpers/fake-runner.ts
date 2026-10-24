import type { OutputChunk, ProcessResult, ProcessRunner, ProcessSpec, RunHandle } from '../../src/main/process';

// A stand-in for the process runner that records what would have been started and answers from a script. Test code only
// (ARCHITECTURE.md section 14); nothing is ever spawned.

export interface Scripted {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  status?: ProcessResult['status'];
  errorMessage?: string;
  /** Stdout delivered in pieces through `onOutput` before the result, to test streaming. */
  chunks?: string[];
  /** Never finishes on its own; ends only when cancelled. */
  hold?: boolean;
}

export interface FakeRunner extends ProcessRunner {
  started: ProcessSpec[];
  cancelled: string[];
}

export function createFakeRunner(script: (spec: ProcessSpec) => Scripted): FakeRunner {
  const started: ProcessSpec[] = [];
  const cancelled: string[] = [];
  let counter = 0;
  const runner: FakeRunner = {
    started,
    cancelled,
    start(spec): RunHandle {
      started.push(spec);
      const scripted = script(spec);
      const listeners = new Set<(chunk: OutputChunk) => void>();
      let finish: (result: ProcessResult) => void = () => undefined;
      const result = new Promise<ProcessResult>((resolve) => {
        finish = resolve;
      });
      const stamp = '2026-10-24T10:00:00.000Z';
      const done = (override: Partial<ProcessResult> = {}): void =>
        finish({ status: scripted.status ?? 'exited', exitCode: scripted.exitCode === undefined ? 0 : scripted.exitCode, stdoutTail: scripted.stdout ?? '', stderrTail: scripted.stderr ?? '', truncated: false, startedAt: stamp, endedAt: stamp, ...(scripted.errorMessage === undefined ? {} : { errorMessage: scripted.errorMessage }), ...override });
      setTimeout(() => {
        for (const piece of scripted.chunks ?? []) for (const listener of listeners) listener({ stream: 'stdout', text: piece });
        if (scripted.hold !== true) done();
      }, 0);
      return {
        id: `fake-${++counter}`,
        pid: undefined,
        onOutput: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        result,
        cancel: (reason) => {
          cancelled.push(reason);
          done({ status: 'cancelled', exitCode: null });
          return Promise.resolve();
        },
      };
    },
    active: () => [],
    cancelAll: () => Promise.resolve(),
    forceKillAll: () => Promise.resolve(),
    stopAccepting: () => undefined,
  };
  return runner;
}
