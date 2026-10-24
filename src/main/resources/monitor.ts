import { randomUUID } from 'node:crypto';
import { cpus as osCpus, freemem, totalmem, type CpuInfo } from 'node:os';
import type { Gpu, ResourceSnapshot } from '@shared/resources';
import type { Logger } from '../logging';
import type { ProcessRunner } from '../process';

// The resource monitor (spec §13). CPU and RAM come from the operating system (Node's os module); GPU and VRAM from
// NVIDIA's nvidia-smi when it is installed (`--query-gpu` with `--format=csv,noheader,nounits`, fields from
// `nvidia-smi --help-query-gpu`); running programs from Windows' tasklist (`/FO CSV /NH`). Both programs run through the
// process runner, only when a snapshot is asked for, and a missing program is a note in the snapshot, never an error.
// Nothing here stops, signals or changes another program.

export interface ResourceMonitorOptions {
  runner: ProcessRunner;
  /** nvidia-smi, if installed. */
  locateNvidiaSmi: () => string | undefined;
  /** %SystemRoot%\System32\tasklist.exe. */
  tasklist: string;
  /** An existing folder the probes run in (the app data folder). */
  cwd: string;
  logger: Logger;
  cpus?: () => CpuInfo[];
  freeBytes?: () => number;
  totalBytes?: () => number;
  /** How long CPU use is sampled when the probes finish faster. */
  sampleMs?: number;
  now?: () => Date;
}

export interface ResourceMonitor {
  /** Measures now, or reuses a snapshot no older than `maxAgeMs`. A second call while one is under way joins it. */
  snapshot(maxAgeMs?: number): Promise<ResourceSnapshot>;
  latest(): ResourceSnapshot | undefined;
}

export const NVIDIA_QUERY = ['--query-gpu=name,utilization.gpu,memory.used,memory.total,memory.free', '--format=csv,noheader,nounits'];
const HEAVY: readonly { label: string; image: RegExp }[] = [
  { label: 'Unreal Editor', image: /^(UnrealEditor|UE4Editor)(-[\w-]+)?\.exe$/i },
  { label: 'Blender', image: /^blender\.exe$/i },
];

const number = (text: string | undefined): number | null => {
  const value = Number((text ?? '').trim());
  return (text ?? '').trim() !== '' && Number.isFinite(value) ? value : null; // "[N/A]" and "[Not Supported]" become null
};

/** One GPU per line: name, utilization %, used MiB, total MiB, free MiB. Lines that do not fit are skipped. */
export function parseNvidiaSmi(text: string): Gpu[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.split(',').map((part) => part.trim()))
    .filter((parts) => parts.length === 5 && parts[0] !== '')
    .slice(0, 8)
    .map(([name = '', util, used, total, free]) => ({
      name: name.slice(0, 120),
      utilPercent: number(util),
      vramUsedMiB: number(used),
      vramTotalMiB: number(total),
      vramFreeMiB: number(free),
    }));
}

/** The image names in `tasklist /FO CSV /NH` output ("Image Name","PID",...). */
export function parseTasklist(text: string): string[] {
  return text.split(/\r?\n/).flatMap((line) => {
    const match = /^"([^"]+)","\d+"/.exec(line.trim());
    return match?.[1] === undefined ? [] : [match[1]];
  });
}

/** The heavy workloads among running programs, by name; each is listed once. */
export const heavyAppsIn = (images: readonly string[]): string[] => HEAVY.filter((app) => images.some((image) => app.image.test(image))).map((app) => app.label);

const cpuTotals = (list: CpuInfo[]): { idle: number; total: number } =>
  list.reduce((sum, cpu) => ({ idle: sum.idle + cpu.times.idle, total: sum.total + cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq }), { idle: 0, total: 0 });

export function createResourceMonitor(options: ResourceMonitorOptions): ResourceMonitor {
  const { runner, logger } = options;
  const cpus = options.cpus ?? osCpus;
  const freeBytes = options.freeBytes ?? freemem;
  const totalBytes = options.totalBytes ?? totalmem;
  const sampleMs = options.sampleMs ?? 250;
  const now = options.now ?? (() => new Date());
  let last: ResourceSnapshot | undefined;
  let running: Promise<ResourceSnapshot> | undefined;

  const probe = async (executable: string, args: string[], name: string): Promise<{ ok: true; text: string } | { ok: false; why: string }> => {
    try {
      const result = await runner.start({ executable, args, cwd: options.cwd, timeoutMs: 10_000, maxOutputBytes: 512 * 1024, purpose: `Read ${name} for the resource monitor`, owner: { kind: 'resource-probe', id: `${name}-${randomUUID()}` } }).result;
      if (result.status === 'exited' && result.exitCode === 0) return { ok: true, text: result.stdoutTail };
      return { ok: false, why: `${name} did not answer (${result.status === 'exited' ? `exit code ${result.exitCode ?? 'unknown'}` : result.status})` };
    } catch (error) {
      logger.warn('resource probe failed', { name, error });
      return { ok: false, why: `${name} could not be started` };
    }
  };

  const measure = async (): Promise<ResourceSnapshot> => {
    const before = cpuTotals(cpus());
    const started = Date.now();
    const smi = options.locateNvidiaSmi();
    const [gpu, apps] = await Promise.all([
      smi === undefined ? Promise.resolve({ ok: false as const, why: 'nvidia-smi was not found, so there is no NVIDIA GPU information' }) : probe(smi, NVIDIA_QUERY, 'nvidia-smi'),
      probe(options.tasklist, ['/FO', 'CSV', '/NH'], 'tasklist'),
    ]);
    const wait = sampleMs - (Date.now() - started);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    const after = cpuTotals(cpus());
    const total = after.total - before.total;
    const gpus = gpu.ok ? parseNvidiaSmi(gpu.text) : [];
    const snapshot: ResourceSnapshot = {
      at: now().toISOString(),
      cpuPercent: total > 0 ? Math.min(100, Math.max(0, Math.round((1 - (after.idle - before.idle) / total) * 100))) : null,
      ramFreeMiB: Math.round(freeBytes() / 1048576),
      ramTotalMiB: Math.round(totalBytes() / 1048576),
      gpus,
      gpuNote: gpu.ok ? (gpus.length === 0 ? 'nvidia-smi reported no GPU' : '') : gpu.why,
      heavyApps: apps.ok ? heavyAppsIn(parseTasklist(apps.text)) : [],
      appsNote: apps.ok ? '' : apps.why,
    };
    last = snapshot;
    return snapshot;
  };

  return {
    snapshot(maxAgeMs = 0) {
      if (last !== undefined && maxAgeMs > 0 && now().getTime() - Date.parse(last.at) <= maxAgeMs) return Promise.resolve(last);
      running ??= measure().finally(() => {
        running = undefined;
      });
      return running;
    },
    latest: () => last,
  };
}
