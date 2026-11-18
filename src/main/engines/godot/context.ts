import type { GodotProject } from '@shared/godot';

/**
 * The Godot part of a context pack (spec §16): what an agent needs to know about the project before it plans anything. It comes from
 * project.godot, export_presets.cfg and the first lines of each script (class_name and extends); script bodies are not included.
 */
export function godotContextText(p: GodotProject): string {
  const lines: string[] = [`## Godot project: ${p.name}`, ''];
  lines.push(`- Engine: Godot ${p.engineVersion ?? '(version not stated)'}${p.csharp ? ' with C#' : ''}${p.renderer === null ? '' : `, renderer ${p.renderer}`}; config_version ${p.configVersion ?? '?'}`);
  if (p.mainScene !== null) lines.push(`- Main scene: ${p.mainScene}`);
  if (p.autoloads.length > 0) lines.push(`- Autoloads: ${p.autoloads.map((a) => `${a.name} (${a.path})`).join(', ')}`);
  if (p.addons.length > 0) lines.push(`- Add-ons: ${p.addons.map((a) => `${a.name}${a.version === '' ? '' : ` ${a.version}`}`).join(', ')}`);
  if (p.enabledPlugins.length > 0) lines.push(`- Enabled editor plugins: ${p.enabledPlugins.join(', ')}`);
  if (p.presets.length > 0) lines.push(`- Export presets: ${p.presets.map((x) => `${x.name} (${x.platform || '?'}${x.exportPath === '' ? '' : ` -> ${x.exportPath}`})`).join('; ')}`);
  lines.push(`- Files: ${p.scripts.gdscript} GDScript, ${p.scripts.csharp} C#, ${p.scripts.scenes} scenes, ${p.scripts.resources} resources${p.scripts.truncated ? ' (counting stopped early)' : ''}`);
  if (p.tests.framework !== null) lines.push(`- Tests: ${p.tests.framework === 'gut' ? 'GUT' : 'GdUnit4'}${p.tests.directory === null ? '' : ` in ${p.tests.directory}`}`);
  if (p.scripts.classes.length > 0) lines.push('', 'Scripts with class_name:', ...p.scripts.classes.slice(0, 60).map((c) => `- ${c.name} extends ${c.extends} (${c.path})`));
  lines.push('', 'Scenes (.tscn) and resources (.tres) are text but easy to break by hand: change them through the editor or describe the change for a person to make. Never edit the .godot folder.');
  return `${lines.join('\n')}\n`;
}
