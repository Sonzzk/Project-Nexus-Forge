import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CpuInfo } from 'node:os';
import { describe, expect, it } from 'vitest';
import { createFakeRunner, type Scripted } from '../../../test/helpers/fake-runner';
import { memoryLogger } from '../../../test/helpers/logger';
import { createResourceMonitor, heavyAppsIn, NVIDIA_QUERY, parseNvidiaSmi, parseTasklist } from './monitor';
import type { ProcessSpec } from '../process';

const sample = (name: string): string => readFileSync(join(__dirname, '../../../test/fixtures/resources', name), 'utf8');
const SMI = 'C:\\Windows\\System32\\nvidia-smi.exe';
const TASKLIST = 'C:\\Windows\\System32\\tasklist.exe';

/** Two CPU readings 50% busy apart. */
function cpus(): () => CpuInfo[] {
  let n = 0;
  return () => {
    n += 1;
    const t = n * 1000;
    return [{ model: 'cpu', speed: 1, times: { user: t / 2, nice: 0, sys: 0, idle: t / 2, irq: 0 } }];
  };
}

function monitor(script: (spec: ProcessSpec) => Scripted, smi: string | null = SMI) {
  const runner = createFakeRunner(script);
  const m = createResourceMonitor({ runner, locateNvidiaSmi: () => smi ?? undefined, tasklist: TASKLIST, cwd: 'C:\\Data', logger: memoryLogger(), cpus: cpus(), freeBytes: () => 40_000 * 1048576, totalBytes: () => 65_536 * 1048576, sampleMs: 0, now: () => new Date('2026-10-24T12:00:00.000Z') });
  return { runner, m };
}

describe('parsing what the tools print', () => {
  it('reads the nvidia-smi CSV recorded on this PC', () => {
    expect(parseNvidiaSmi(sample('nvidia-smi-rtx3060.csv'))).toEqual([{ name: 'NVIDIA GeForce RTX 3060', utilPercent: 20, vramUsedMiB: 3763, vramTotalMiB: 12288, vramFreeMiB: 8353 }]);
  });

  it('keeps [N/A] and [Not Supported] as unknown, reads several GPUs and skips lines that are not GPUs', () => {
    expect(parseNvidiaSmi(sample('nvidia-smi-two-gpus.csv'))).toEqual([
      { name: 'NVIDIA GeForce RTX 3060', utilPercent: null, vramUsedMiB: 11800, vramTotalMiB: 12288, vramFreeMiB: 488 },
      { name: 'Tesla T4', utilPercent: null, vramUsedMiB: null, vramTotalMiB: 15360, vramFreeMiB: null },
    ]);
    expect(parseNvidiaSmi('')).toEqual([]);
  });

  it('finds Unreal Editor and Blender in the tasklist CSV, each once, and not their helper programs', () => {
    const images = parseTasklist(sample('tasklist.csv'));
    expect(images).toContain('UnrealEditorServices.exe');
    expect(heavyAppsIn(images)).toEqual(['Unreal Editor', 'Blender']);
    expect(heavyAppsIn(['UnrealEditorServices.exe', 'explorer.exe'])).toEqual([]);
    expect(heavyAppsIn(['UE4Editor.exe'])).toEqual(['Unreal Editor']);
  });
});

describe('a snapshot', () => {
  it('asks nvidia-smi with the documented query and tasklist for CSV, and reads CPU and RAM from the system', async () => {
    const { runner, m } = monitor((spec) => ({ stdout: spec.executable === SMI ? sample('nvidia-smi-rtx3060.csv') : sample('tasklist.csv') }));
    const snap = await m.snapshot();
    expect(runner.started.map((s) => [s.executable, s.args, s.owner.kind])).toEqual([
      [SMI, NVIDIA_QUERY, 'resource-probe'],
      [TASKLIST, ['/FO', 'CSV', '/NH'], 'resource-probe'],
    ]);
    expect(snap).toMatchObject({ cpuPercent: 50, ramFreeMiB: 40_000, ramTotalMiB: 65_536, gpus: [{ vramFreeMiB: 8353 }], gpuNote: '', heavyApps: ['Unreal Editor', 'Blender'], appsNote: '' });
    expect(m.latest()).toEqual(snap);
  });

  it('without nvidia-smi it still answers, with no GPU figures and a note why', async () => {
    const { runner, m } = monitor(() => ({ stdout: '' }), null);
    const snap = await m.snapshot();
    expect(runner.started.map((s) => s.executable)).toEqual([TASKLIST]);
    expect(snap).toMatchObject({ gpus: [], gpuNote: expect.stringContaining('nvidia-smi was not found') as unknown, heavyApps: [] });
  });

  it('a probe that fails or times out becomes a note, never an error', async () => {
    const { m } = monitor((spec) => (spec.executable === SMI ? { status: 'timed-out', exitCode: null } : { exitCode: 1 }));
    const snap = await m.snapshot();
    expect(snap.gpuNote).toContain('timed-out');
    expect(snap.appsNote).toContain('exit code 1');
  });

  it('a second request while one is under way joins it, and a recent snapshot can be reused instead of measuring again', async () => {
    const { runner, m } = monitor(() => ({ stdout: '' }));
    const [a, b] = await Promise.all([m.snapshot(), m.snapshot()]);
    expect(a).toBe(b);
    expect(runner.started).toHaveLength(2);
    expect(await m.snapshot(60_000)).toBe(a);
    expect(runner.started).toHaveLength(2);
    await m.snapshot();
    expect(runner.started).toHaveLength(4);
  });
});
