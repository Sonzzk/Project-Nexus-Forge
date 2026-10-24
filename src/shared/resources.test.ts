import { describe, expect, it } from 'vitest';
import { evaluateLocal, type InferencePolicy, type ResourceSnapshot } from './resources';

const policy: InferencePolicy = { mode: 'allow-local', minFreeVramMiB: 6144, minFreeRamMiB: 8192, holdForHeavyApps: true };
const snapshot = (extra: Partial<ResourceSnapshot> = {}): ResourceSnapshot => ({
  at: '2026-10-24T12:00:00.000Z',
  cpuPercent: 10,
  ramFreeMiB: 40_000,
  ramTotalMiB: 65_000,
  gpus: [{ name: 'NVIDIA GeForce RTX 3060', utilPercent: 3, vramUsedMiB: 2000, vramTotalMiB: 12288, vramFreeMiB: 10288 }],
  gpuNote: '',
  heavyApps: [],
  appsNote: '',
  ...extra,
});

describe('the local-inference policy', () => {
  it('allows a local start when every threshold is met', () => {
    expect(evaluateLocal(snapshot(), policy)).toEqual({ allowed: true, blocks: [], warnings: [] });
  });

  it('blocks below the VRAM or RAM minimum and says by how much', () => {
    const low = evaluateLocal(snapshot({ gpus: [{ name: 'GPU', utilPercent: 90, vramUsedMiB: 9000, vramTotalMiB: 12288, vramFreeMiB: 3288 }] }), policy);
    expect(low.allowed).toBe(false);
    expect(low.blocks).toEqual([expect.stringMatching(/Only 3\.2 GB of VRAM.*6\.0 GB/)]);
    expect(evaluateLocal(snapshot({ ramFreeMiB: 4096 }), policy).blocks).toEqual([expect.stringMatching(/Only 4\.0 GB of RAM.*8\.0 GB/)]);
  });

  it('holds while Unreal Editor or Blender runs, or only warns when holding is switched off', () => {
    expect(evaluateLocal(snapshot({ heavyApps: ['Unreal Editor'] }), policy)).toMatchObject({ allowed: false, blocks: [expect.stringContaining('Unreal Editor is running')] });
    expect(evaluateLocal(snapshot({ heavyApps: ['Unreal Editor', 'Blender'] }), { ...policy, holdForHeavyApps: false })).toMatchObject({ allowed: true, warnings: [expect.stringContaining('Unreal Editor and Blender are running')] });
  });

  it('Prioritize Game Performance holds every local start', () => {
    expect(evaluateLocal(snapshot(), { ...policy, mode: 'prioritize-game' })).toMatchObject({ allowed: false, blocks: [expect.stringContaining('Prioritize Game Performance')] });
  });

  it('missing nvidia-smi or program list warns instead of holding, and never invents a figure', () => {
    const verdict = evaluateLocal(snapshot({ gpus: [], gpuNote: 'nvidia-smi was not found', appsNote: 'tasklist could not be started' }), policy);
    expect(verdict.allowed).toBe(true);
    expect(verdict.warnings).toEqual([expect.stringContaining('tasklist could not be started'), expect.stringContaining('VRAM minimum was not checked')]);
    expect(evaluateLocal(snapshot({ gpus: [{ name: 'GPU', utilPercent: null, vramUsedMiB: null, vramTotalMiB: null, vramFreeMiB: null }] }), policy).warnings).toEqual([expect.stringContaining('could not be measured')]);
  });

  it('uses the GPU with the most free VRAM', () => {
    const two = snapshot({ gpus: [{ name: 'A', utilPercent: 0, vramUsedMiB: 7000, vramTotalMiB: 8000, vramFreeMiB: 1000 }, { name: 'B', utilPercent: 0, vramUsedMiB: 0, vramTotalMiB: 12288, vramFreeMiB: 12288 }] });
    expect(evaluateLocal(two, policy).allowed).toBe(true);
  });
});
