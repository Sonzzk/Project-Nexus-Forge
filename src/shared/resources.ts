import { z } from 'zod';

// Hardware-aware local inference (spec §13): what the resource monitor measured, and the policy that decides whether a local
// model may start now. The policy only holds or warns; it never stops another program or unloads anything by itself.

export const INFERENCE_MODES = ['allow-local', 'prioritize-game'] as const;
export type InferenceMode = (typeof INFERENCE_MODES)[number];
export const INFERENCE_MODE_LABELS: Record<InferenceMode, string> = { 'allow-local': 'Allow Local Inference', 'prioritize-game': 'Prioritize Game Performance' };

export const GpuSchema = z.object({
  name: z.string().max(120),
  /** Null when the driver does not report it. */
  utilPercent: z.number().min(0).max(100).nullable(),
  vramUsedMiB: z.number().nonnegative().nullable(),
  vramTotalMiB: z.number().nonnegative().nullable(),
  vramFreeMiB: z.number().nonnegative().nullable(),
});
export type Gpu = z.output<typeof GpuSchema>;

export const ResourceSnapshotSchema = z.object({
  at: z.iso.datetime(),
  /** Average over the few hundred milliseconds the check took; null when it could not be measured. */
  cpuPercent: z.number().min(0).max(100).nullable(),
  ramFreeMiB: z.number().nonnegative(),
  ramTotalMiB: z.number().nonnegative(),
  gpus: z.array(GpuSchema).max(8),
  /** Why the GPU figures are missing or partial; empty when nvidia-smi answered. */
  gpuNote: z.string().max(300),
  /** Heavy workloads found running, such as Unreal Editor or Blender. */
  heavyApps: z.array(z.string().max(80)).max(20),
  /** Why the program list could not be read; empty when it was. */
  appsNote: z.string().max(300),
});
export type ResourceSnapshot = z.output<typeof ResourceSnapshotSchema>;

export interface InferencePolicy {
  mode: InferenceMode;
  minFreeVramMiB: number;
  minFreeRamMiB: number;
  holdForHeavyApps: boolean;
}

export const PolicyVerdictSchema = z.object({
  allowed: z.boolean(),
  /** Why a local start is held. Empty when it may start. */
  blocks: z.array(z.string().max(300)).max(10),
  /** What could not be checked, or is close to a limit. Shown, but does not hold. */
  warnings: z.array(z.string().max(300)).max(10),
});
export type PolicyVerdict = z.output<typeof PolicyVerdictSchema>;

export const ResourceReportSchema = z.object({ snapshot: ResourceSnapshotSchema, verdict: PolicyVerdictSchema });
export type ResourceReport = z.output<typeof ResourceReportSchema>;

const gib = (mib: number): string => `${(mib / 1024).toFixed(1)} GB`;

/** May a local model start now? Unknown figures warn instead of holding; nothing here promises a model will fit. */
export function evaluateLocal(snapshot: ResourceSnapshot, policy: InferencePolicy): PolicyVerdict {
  const blocks: string[] = [];
  const warnings: string[] = [];
  if (policy.mode === 'prioritize-game') blocks.push('Prioritize Game Performance is on, so local models do not start. Switch to Allow Local Inference to run them.');
  if (snapshot.heavyApps.length > 0) {
    const names = snapshot.heavyApps.join(' and ');
    if (policy.holdForHeavyApps) blocks.push(`${names} ${snapshot.heavyApps.length === 1 ? 'is' : 'are'} running, so local models wait instead of competing for the GPU.`);
    else warnings.push(`${names} ${snapshot.heavyApps.length === 1 ? 'is' : 'are'} running; a local model will compete with it for the GPU.`);
  }
  if (snapshot.appsNote !== '') warnings.push(`Could not check for Unreal Editor or Blender: ${snapshot.appsNote}`);
  if (snapshot.ramFreeMiB < policy.minFreeRamMiB) blocks.push(`Only ${gib(snapshot.ramFreeMiB)} of RAM is free; the minimum set is ${gib(policy.minFreeRamMiB)}.`);
  const free = snapshot.gpus.map((g) => g.vramFreeMiB).filter((v): v is number => v !== null);
  if (free.length === 0) warnings.push(`Free VRAM could not be measured${snapshot.gpuNote === '' ? '' : ` (${snapshot.gpuNote})`}, so the VRAM minimum was not checked.`);
  else if (Math.max(...free) < policy.minFreeVramMiB) blocks.push(`Only ${gib(Math.max(...free))} of VRAM is free; the minimum set is ${gib(policy.minFreeVramMiB)}.`);
  return { allowed: blocks.length === 0, blocks, warnings };
}
