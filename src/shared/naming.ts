import type { AssetType, NameCheck, NamingEngine } from './blender';

// Naming conventions for game assets (spec §17). Unreal's prefixes come from Epic's "Recommended Asset Naming Conventions" page, whose
// pattern is [AssetTypePrefix]_[AssetName]_[Descriptor]_[OptionalVariantLetterOrNumber] (read 2026-11-02; it does not cover sounds,
// maps or texture suffixes, so none is invented). Godot's rule is from its project-organization guide: snake_case for files and
// folders, because Godot's exported file system is case-sensitive. Unity has no official rule, so only the common practice is offered.

export const UNREAL_PREFIX: Record<AssetType, string> = {
  'static-mesh': 'SM_',
  'skeletal-mesh': 'SK_',
  texture: 'T_',
  material: 'M_',
  'material-instance': 'MI_',
  animation: 'AS_',
  blueprint: 'BP_',
  other: '',
};

const RULES: Record<NamingEngine, string> = {
  unreal: 'Epic: [AssetTypePrefix]_[AssetName]_[Descriptor]_[Variant], for example SM_Chair_Wooden_01. No spaces.',
  godot: 'Godot: snake_case file and folder names (lowercase), so names do not break after export to a case-sensitive file system.',
  unity: 'Unity has no official rule. Common practice: PascalCase words, with the name, descriptor and variant joined by underscores, no spaces.',
  generic: 'Lowercase snake_case with no spaces: it is safe on every file system.',
};

const words = (text: string): string[] =>
  text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);

const pascal = (w: string): string => w.charAt(0).toUpperCase() + w.slice(1);

/** A name built from the parts, in the convention of the engine. */
export function suggestName(engine: NamingEngine, type: AssetType, base: string, descriptor = '', variant = ''): string {
  // Unreal and Unity: each part is PascalCase and the parts (name, descriptor, variant) are joined by underscores.
  const part = (text: string): string => words(text).map(pascal).join('');
  const segments = [part(base), part(descriptor), words(variant).join('')].filter(Boolean);
  if (engine === 'unreal') return UNREAL_PREFIX[type] + segments.join('_');
  if (engine === 'unity') return segments.join('_');
  return [...words(base), ...words(descriptor), ...words(variant)].map((w) => w.toLowerCase()).join('_');
}

export function checkName(engine: NamingEngine, type: AssetType, name: string, base = name): NameCheck {
  const problems: string[] = [];
  if (name.trim() === '') problems.push('The name is empty.');
  if (/\s/.test(name)) problems.push('The name has spaces.');
  if (/[^A-Za-z0-9_]/.test(name.replace(/\s/g, ''))) problems.push('Use only letters, digits and underscores.');
  if (engine === 'unreal') {
    const prefix = UNREAL_PREFIX[type];
    if (prefix !== '' && !name.startsWith(prefix)) problems.push(`A ${type.replace('-', ' ')} should start with ${prefix}.`);
  } else if (engine === 'godot' || engine === 'generic') {
    if (name !== name.toLowerCase()) problems.push('Use lowercase only (snake_case).');
  }
  return { suggestion: suggestName(engine, type, base), problems, rule: RULES[engine] };
}
