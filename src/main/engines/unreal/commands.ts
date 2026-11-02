import { join } from 'node:path';
import type { CapabilityState, EngineInstall, UnrealProject } from '@shared/unreal';
import type { ExtraCommand } from '../../security';

// The commands this app can offer for an Unreal project (spec §16). Only commands whose form was seen in the engine's own files are
// offered: the build line is the one the engine writes into a project's generated Visual Studio files (NMakeBuildCommandLine:
// `Build.bat <Target> Win64 <Configuration> -Project="<.uproject>" -WaitMutex`), and `-WaitMutex` is listed by `Build.bat -Help` of
// UE 5.8 on this PC. Each is approved by the person and run by the app through the process runner, never by an agent.

/** Build commands for the project's Game and Editor targets, using the engine the project asks for. Empty when it cannot be built. */
export function unrealBuildCommands(project: UnrealProject, root: string, engine: EngineInstall | undefined): ExtraCommand[] {
  if (engine === undefined || !engine.complete || !project.hasSource) return [];
  const buildBat = join(engine.path, 'Engine', 'Build', 'BatchFiles', 'Build.bat');
  const uproject = join(root, project.uproject);
  return project.targets
    .filter((t) => t.type === 'Game' || t.type === 'Editor')
    .map((t) => ({
      label: `Unreal: build ${t.name} (Win64, Development)`,
      argv: [buildBat, t.name, 'Win64', 'Development', `-Project=${uproject}`, '-WaitMutex'],
      body: `Builds the C++ ${t.type === 'Editor' ? 'editor ' : ''}target ${t.name} with Unreal Build Tool from ${engine.id}${engine.version === null ? '' : ` (${engine.version})`}:\nBuild.bat ${t.name} Win64 Development -Project="${uproject}" -WaitMutex\nIt compiles the project's code and writes files in the project's Binaries and Intermediate folders and in the engine's own logs. It does not change Source, Config or Content. A build can take many minutes.`,
      timeoutMs: 3600_000,
      writes: true,
    }));
}

export interface CapabilityInputs {
  project: UnrealProject | undefined;
  engines: readonly EngineInstall[];
  resolved: EngineInstall | undefined;
  resolveNote: string;
}

/** What this integration can do for the project right now, and why not when it cannot. */
export function unrealCapabilities({ project, engines, resolved, resolveNote }: CapabilityInputs): { id: string; label: string; state: CapabilityState; reason: string }[] {
  const cap = (id: string, label: string, state: CapabilityState, reason = ''): { id: string; label: string; state: CapabilityState; reason: string } => ({ id, label, state, reason });
  const found = project !== undefined;
  const complete = resolved?.complete === true;
  return [
    cap('detect', 'Find the .uproject, targets, modules, plugins and content', found ? 'implemented' : 'unavailable', found ? '' : 'There is no readable .uproject at the top of this project folder.'),
    cap('engines', 'List installed engines (launcher list, registered source builds, configured folders)', engines.length > 0 ? 'implemented' : 'awaiting-configuration', engines.length > 0 ? `${engines.length} found.` : 'No engine was found. Install one in the Epic Games Launcher, or add an engine folder.'),
    cap('open', 'Open the project and its folders', found ? 'implemented' : 'unavailable', found ? 'The project opens through Windows, like double-clicking it; folders open in Explorer.' : 'No Unreal project here.'),
    cap(
      'build',
      'Build the C++ targets (approved, run by the app)',
      !found ? 'unavailable' : !project.hasSource ? 'unavailable' : complete ? 'implemented' : 'awaiting-configuration',
      !found ? 'No Unreal project here.' : !project.hasSource ? 'This project has no C++ source (it looks Blueprint-only).' : complete ? `Uses ${resolved.id}.` : resolved !== undefined ? `${resolved.id} is incomplete: ${resolved.note}` : resolveNote,
    ),
    cap('logs', 'Keep the output of every build', 'implemented', 'Each approved command run is saved with its redacted output.'),
    cap('context', 'Unreal context for context packs', found ? 'implemented' : 'unavailable', found ? 'A summary of the project is added to context packs.' : 'No Unreal project here.'),
    cap('templates', 'Planning templates (Blueprints, C++, levels, materials, lighting, AI, audio, performance)', 'implemented'),
    cap('automation-tests', 'Run automation tests from here', 'unavailable', 'Not offered yet: the documented form needs a quoted -ExecCmds value whose passing through the process runner has not been verified. Step 23 revisits it.'),
    cap('editor-python', 'Editor Python or other editor automation', 'experimental-off', 'Off, and not built. It would need its own opt-in permission, a preview of the script, error reporting and a recovery procedure, and it is not assumed that Unreal Python can do everything the editor can.'),
  ];
}
