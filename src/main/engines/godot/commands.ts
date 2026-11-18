import type { CapabilityState } from '@shared/unreal';
import type { GodotInstall, GodotProject } from '@shared/godot';
import type { ExtraCommand } from '../../security';

// The commands this app offers for a Godot project (spec §16). Each is built only from what the project and the installed engine say:
// presets that export_presets.cfg defines (with the export path the preset itself holds), the test framework found under addons, and the
// documented `--import`. The option forms were checked against Godot's command-line tutorial (D-045). Commands start the editor program
// with `--headless` (its output is read through pipes), and run only after the person approves them; agents cannot run them.

/** The install a project should use: same major.minor as config/features, and the C# build for a C# project. Never a guess. */
export function resolveGodot(project: GodotProject, installs: readonly GodotInstall[]): { install: GodotInstall; how: string } | { install: undefined; why: string } {
  if (project.engineVersion === null) return { install: undefined, why: 'The project does not say which Godot version it uses (no version in config/features), so this app does not guess; opening it in a different version can change project files.' };
  const same = installs.filter((i) => i.version !== null && i.version.split('.').slice(0, 2).join('.') === project.engineVersion);
  if (same.length === 0) return { install: undefined, why: `The project asks for Godot ${project.engineVersion}, which was not found${installs.length > 0 ? ` (found: ${installs.map((i) => i.version ?? '?').join(', ')})` : ''}. Add the folder of that download.` };
  const exact = same.find((i) => i.mono === project.csharp) ?? undefined;
  if (exact === undefined) return { install: undefined, why: project.csharp ? `The project uses C#, but only the standard Godot ${project.engineVersion} (not the .NET build) was found.` : `Only the .NET build of Godot ${project.engineVersion} was found; the project does not use C#, so the standard build is expected.` };
  return { install: exact, how: `config/features names ${project.engineVersion}${project.csharp ? ' with C#' : ''}, which matches ${exact.folder}` };
}

const releaseOnly = (i: GodotInstall): boolean => i.release === 'stable' || i.release === null;

export function godotCommands(project: GodotProject, root: string, install: GodotInstall | undefined): ExtraCommand[] {
  const exe = install?.exe ?? install?.consoleExe ?? null;
  if (install === undefined || exe === null || project.configVersion === null || project.configVersion < 5) return [];
  const where = `Godot ${install.version ?? '?'}${releaseOnly(install) ? '' : ` ${install.release}`}`;
  const base = ['--headless', '--path', root];
  const out: ExtraCommand[] = [
    {
      label: 'Godot: import resources (headless)',
      argv: [exe, ...base, '--import'],
      body: `Starts the editor without a window, waits for the project's resources to be imported and quits (${where}):\ngodot --headless --path "${root}" --import\nIt writes the engine's cache in the project's .godot folder and may re-save .import files; it does not change scenes or scripts.`,
      timeoutMs: 1800_000,
      writes: true,
    },
  ];
  for (const preset of project.presets) {
    if (preset.skipped !== '') continue;
    for (const mode of ['release', 'debug'] as const)
      out.push({
        label: `Godot: export ${preset.name} (${mode})`,
        argv: [exe, ...base, `--export-${mode}`, preset.name, preset.exportPath],
        body: `Exports the preset "${preset.name}" (${preset.platform || 'platform not named'}) in ${mode} mode to ${preset.exportPath} with ${where}:\ngodot --headless --path "${root}" --export-${mode} "${preset.name}" "${preset.exportPath}"\nThe preset and path come from export_presets.cfg. It writes the exported files at that path inside the project and imports resources first; it needs the export templates for this version to be installed (the app does not install them). It does not change scenes or scripts.`,
        timeoutMs: 3600_000,
        writes: true,
      });
  }
  const t = project.tests;
  if (t.framework === 'gut' && (t.hasConfig || t.directory !== null)) {
    const dir = t.hasConfig ? [] : [`-gdir=res://${t.directory}`];
    out.push({
      label: 'Godot: run GUT tests',
      argv: [exe, ...base, '-d', '-s', 'addons/gut/gut_cmdln.gd', ...dir, '-gexit'],
      body: `Runs the GUT tests with ${where}:\ngodot --headless --path "${root}" -d -s addons/gut/gut_cmdln.gd ${dir.join(' ')}${dir.length > 0 ? ' ' : ''}-gexit\n${t.hasConfig ? 'The test folders come from the project\'s .gutconfig.json.' : `The tests are the test_*.gd files in ${t.directory}.`} GUT exits with code 1 when a test fails. Tests can write files (saves, logs) if the project's tests do; the app cannot tell in advance.`,
      timeoutMs: 1800_000,
      writes: true,
    });
  }
  return out;
}

export interface GodotCapabilityInputs {
  project: GodotProject | undefined;
  installs: readonly GodotInstall[];
  resolved: GodotInstall | undefined;
  resolveNote: string;
}

/** What this integration can do for the project right now, and why not when it cannot. */
export function godotCapabilities({ project, installs, resolved, resolveNote }: GodotCapabilityInputs): { id: string; label: string; state: CapabilityState; reason: string }[] {
  const cap = (id: string, label: string, state: CapabilityState, reason = ''): { id: string; label: string; state: CapabilityState; reason: string } => ({ id, label, state, reason });
  const found = project !== undefined;
  const godot4 = found && project.configVersion !== null && project.configVersion >= 5;
  const canRun = (resolved?.exe ?? resolved?.consoleExe) != null;
  const needs = !found ? 'No Godot project here.' : !godot4 ? 'Only Godot 4 projects (config_version 5) are supported for commands.' : resolved === undefined ? resolveNote : !canRun ? 'The install has no Godot program in its folder.' : '';
  const commandState: CapabilityState = !found || !godot4 ? 'unavailable' : canRun ? 'implemented' : 'awaiting-configuration';
  const presets = found ? project.presets.filter((p) => p.skipped === '').length : 0;
  const tests = found ? project.tests : undefined;
  return [
    cap('detect', 'Read project.godot, export_presets.cfg, add-ons and GDScript files', found ? 'implemented' : 'unavailable', found ? '' : 'There is no readable project.godot at the top of this project folder.'),
    cap('installs', 'Find Godot downloads (folders you add, default folders, PATH) and read their version', installs.length > 0 ? 'implemented' : 'awaiting-configuration', installs.length > 0 ? `${installs.length} found.` : 'No Godot was found. Download it and add its folder.'),
    cap('editor', 'Launch and stop the editor (owned by this app)', found && resolved?.exe != null ? 'implemented' : found ? 'awaiting-configuration' : 'unavailable', found ? (resolved?.exe != null ? `Starts ${resolved.exe}.` : resolveNote || 'No matching editor program was found.') : 'No Godot project here.'),
    cap('import', 'Import resources (headless, approved)', commandState, needs),
    cap('export', 'Export a preset from export_presets.cfg (approved)', commandState !== 'implemented' ? commandState : presets > 0 ? 'implemented' : 'unavailable', commandState !== 'implemented' ? needs : presets > 0 ? `${presets} preset${presets === 1 ? '' : 's'} can be exported.` : found && project.presets.length > 0 ? 'No preset has a usable export path (see each preset\'s note).' : 'The project has no export_presets.cfg or no presets in it.'),
    cap(
      'tests',
      'Run GUT tests (approved)',
      commandState !== 'implemented' ? commandState : tests?.framework === 'gut' && (tests.hasConfig || tests.directory !== null) ? 'implemented' : 'unavailable',
      commandState !== 'implemented' ? needs : tests?.framework === 'gut' ? (tests.hasConfig || tests.directory !== null ? 'GUT is installed under addons.' : 'GUT is installed but no .gutconfig.json or test folder with test_*.gd files was found.') : tests?.framework === 'gdunit4' ? 'GdUnit4 is installed; its command line needs its own runner script and is not offered.' : 'No test framework (GUT) was found under addons.',
    ),
    cap('context', 'GDScript and project context for context packs', found ? 'implemented' : 'unavailable', found ? 'A summary of the project, its autoloads and its class_name scripts is added to context packs.' : 'No Godot project here.'),
    cap('output', 'Keep the output of every approved command', 'implemented', 'Each approved command run is saved with its redacted output.'),
    cap('script-check', 'Parse-check GDScript files (--check-only)', 'unavailable', 'Not offered: the option needs one script per run and only a script that inherits SceneTree; per-file commands were not built.'),
  ];
}
