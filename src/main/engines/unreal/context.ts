import type { UnrealProject } from '@shared/unreal';

/**
 * The Unreal part of a context pack (spec §16): what an agent needs to know about the project before it plans anything. Everything comes
 * from the .uproject, Config, Source and file names under Content; binary assets are named, never opened, and the text says they must not
 * be edited as files.
 */
export function unrealContextText(p: UnrealProject): string {
  const lines: string[] = [`## Unreal Engine project: ${p.name}`, ''];
  lines.push(`- Engine association: ${p.engineAssociation === '' ? '(none)' : p.engineAssociation}${p.projectVersion === null ? '' : `; project version ${p.projectVersion}`}`);
  if (p.description !== '') lines.push(`- Description: ${p.description}`);
  lines.push(`- Folders present: ${Object.entries(p.folders).filter(([, present]) => present).map(([name]) => name).join(', ') || 'none'}`);
  lines.push(`- Code: ${p.hasSource ? `C++ (${p.targets.length} target${p.targets.length === 1 ? '' : 's'}, ${p.buildCsFiles} module file${p.buildCsFiles === 1 ? '' : 's'})` : 'Blueprint-only (no C++ source)'}`);
  if (p.targets.length > 0) lines.push(`- Targets: ${p.targets.map((t) => `${t.name} (${t.type})`).join(', ')}`);
  if (p.modules.length > 0) lines.push(`- Modules: ${p.modules.map((m) => `${m.name} (${m.type}${m.loadingPhase === '' ? '' : `, ${m.loadingPhase}`})`).join(', ')}`);
  const enabled = p.plugins.filter((x) => x.enabled).map((x) => x.name);
  const disabled = p.plugins.filter((x) => !x.enabled).map((x) => x.name);
  if (enabled.length > 0) lines.push(`- Plugins enabled: ${enabled.join(', ')}`);
  if (disabled.length > 0) lines.push(`- Plugins disabled: ${disabled.join(', ')}`);
  if (p.projectPlugins.length > 0) lines.push(`- Plugins inside the project: ${p.projectPlugins.join(', ')}`);
  if (p.defaultMap !== null) lines.push(`- Default map: ${p.defaultMap}`);
  if (p.editorStartupMap !== null && p.editorStartupMap !== p.defaultMap) lines.push(`- Editor startup map: ${p.editorStartupMap}`);
  if (p.configFiles.length > 0) lines.push(`- Config files: ${p.configFiles.join(', ')}`);
  lines.push('', `### Content (${p.content.assets.toLocaleString('en-US')} assets, ${(p.content.bytes / 1024 / 1024).toFixed(1)} MB${p.content.truncated ? '; counting stopped early' : ''})`);
  if (p.content.topFolders.length > 0) lines.push(p.content.topFolders.map((f) => `- ${f.name}: ${f.assets}`).join('\n'));
  if (p.content.maps.length > 0) lines.push('', 'Maps:', ...p.content.maps.slice(0, 40).map((m) => `- ${m}`));
  lines.push('', 'Assets (.uasset, .umap) are binary: they are listed by name only. Do not edit them as files; describe the change for a person to make in the editor.');
  return `${lines.join('\n')}\n`;
}
