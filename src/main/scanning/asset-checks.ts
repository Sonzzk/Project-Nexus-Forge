import type { AssetType, NamingEngine } from '@shared/blender';
import { CHECK_RULES, type AssetCategory, type CheckFinding, type CheckReport } from '@shared/assets';
import { suggestName, UNREAL_PREFIX } from '@shared/naming';
import type { ProjectType } from '@shared/projects';

// Naming and folder checks over the asset index (spec §17). They only report: nothing is renamed or moved. The convention comes from the
// project type, with the sources named in shared/naming.ts (Epic's prefixes for Unreal, Godot's snake_case rule; Unity has no official
// rule, so only the common practice is applied, and the generic rule is plain lowercase snake_case).

const MAX_LISTED = 300;
const MAX_DEPTH = 8;
/** Categories whose file names are not asset names: source code follows the language's own style, builds are tool output. */
const NOT_ASSET_NAMES = new Set<AssetCategory>(['script', 'build']);
const TYPE_BY_CATEGORY: Partial<Record<AssetCategory, AssetType>> = { model: 'static-mesh', texture: 'texture', material: 'material', animation: 'animation' };

const RULE_TEXT: Record<NamingEngine, string> = {
  unreal: 'Epic: [AssetTypePrefix]_[AssetName]_[Descriptor]_[Variant], no spaces. Prefixes are checked only for source files (models, textures, materials, animations): a .uasset\'s type is inside the file, so its prefix cannot be checked from here.',
  godot: 'Godot: snake_case (lowercase) file and folder names, because exported projects use a case-sensitive file system.',
  unity: 'Unity has no official rule. Common practice applied: no spaces or odd characters in names.',
  generic: 'Generic rule: lowercase snake_case, no spaces, safe on every file system.',
};

export const namingEngineOf = (type: ProjectType): NamingEngine => (type === 'unreal' ? 'unreal' : type === 'godot' ? 'godot' : type === 'unity' ? 'unity' : 'generic');

export interface CheckInput {
  path: string;
  category: AssetCategory;
}

export function checkAssets(engine: NamingEngine, files: readonly CheckInput[]): CheckReport {
  const counts = Object.fromEntries(CHECK_RULES.map((r) => [r, 0])) as Record<(typeof CHECK_RULES)[number], number>;
  const findings: CheckFinding[] = [];
  const add = (rule: (typeof CHECK_RULES)[number], path: string, message: string, suggestion: string | null = null): void => {
    counts[rule]++;
    if (findings.length < MAX_LISTED) findings.push({ rule, path, message, suggestion });
  };
  const seenNames = new Map<string, string>();
  const reportedDuplicates = new Set<string>();
  const folders = new Set<string>();

  for (const file of files) {
    const parts = file.path.split('/');
    const name = parts.at(-1) ?? file.path;
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 ? name.slice(dot) : '';
    const dir = parts.slice(0, -1);

    if (dir.length > MAX_DEPTH) add('depth', file.path, `This file is ${dir.length} folders deep; more than ${MAX_DEPTH} makes paths hard to read and can hit Windows' path length limit.`);

    if (!NOT_ASSET_NAMES.has(file.category)) {
      if (dir.length === 0) add('loose-root', file.path, 'This asset sits in the project\'s top folder; give it a folder.');
      const type = TYPE_BY_CATEGORY[file.category] ?? 'other';
      const prefix = UNREAL_PREFIX[type];
      const base = engine === 'unreal' && prefix !== '' && stem.startsWith(prefix) ? stem.slice(prefix.length) : stem;
      const fix = (): string => `${[...dir, suggestName(engine, type, base)].join('/')}${extension.toLowerCase()}`;
      if (/\s/.test(stem)) add('spaces', file.path, 'The name has spaces.', fix());
      else if (/[^A-Za-z0-9_]/.test(stem)) add('characters', file.path, 'Use only letters, digits and underscores in the name.', fix());
      else if ((engine === 'godot' || engine === 'generic') && stem !== stem.toLowerCase()) add('case', file.path, 'Use lowercase only (snake_case).', fix());
      else if (engine === 'unreal' && file.category !== 'engine' && TYPE_BY_CATEGORY[file.category] !== undefined && UNREAL_PREFIX[type] !== '' && !stem.startsWith(UNREAL_PREFIX[type])) add('prefix', file.path, `A ${type.replace('-', ' ')} should start with ${UNREAL_PREFIX[type]}.`, fix());

      const key = `${file.category}:${stem.toLowerCase()}`;
      const first = seenNames.get(key);
      if (first === undefined) seenNames.set(key, file.path);
      else if (first.split('/').slice(0, -1).join('/') !== dir.join('/') && !reportedDuplicates.has(key)) {
        reportedDuplicates.add(key);
        add('duplicate-name', file.path, `Another ${file.category} has the same name: ${first}. Two assets with one name are easy to confuse.`);
      }
    }
    for (let i = 0; i < dir.length; i++) folders.add(dir.slice(0, i + 1).join('/'));
  }

  for (const folder of [...folders].sort()) {
    const leaf = folder.split('/').at(-1) ?? folder;
    if (/\s/.test(leaf) || ((engine === 'godot' || engine === 'generic') && leaf !== leaf.toLowerCase())) add('mixed-case-folder', folder, engine === 'unreal' || engine === 'unity' ? 'The folder name has spaces.' : 'Folder names should be lowercase snake_case, without spaces.');
  }

  return {
    engine,
    rule: RULE_TEXT[engine],
    checked: files.length,
    counts,
    findings,
    more: Object.values(counts).reduce((a, b) => a + b, 0) - findings.length,
    note: 'Report only: nothing was renamed or moved. Renaming an asset can break references to it inside scenes and materials, which this app does not update.',
  };
}
