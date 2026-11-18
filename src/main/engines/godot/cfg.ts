// Godot's ConfigFile text format (project.godot, export_presets.cfg, plugin.cfg): `[section]` headers, `key=value` lines, `;` comments.
// A value can run over several lines (a string with a line break, an array); a value is kept as its raw text and read with the helpers
// below. Maps, not plain objects, so a key such as `__proto__` is just a key.

export type Cfg = Map<string, Map<string, string>>;

const MAX_CFG_BYTES = 1024 * 1024;

/** How far a value text is from complete: inside a string, or inside brackets. */
function open(value: string): boolean {
  let inString = false;
  let depth = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
  }
  return inString || depth > 0;
}

export function parseCfg(text: string): Cfg {
  const cfg: Cfg = new Map();
  let section = '';
  cfg.set(section, new Map());
  const lines = text.slice(0, MAX_CFG_BYTES).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim();
    if (line === '' || line.startsWith(';')) continue;
    const header = /^\[([^\]]*)\]$/.exec(line);
    if (header !== null) {
      section = header[1] ?? '';
      if (!cfg.has(section)) cfg.set(section, new Map());
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^"|"$/g, '');
    let value = line.slice(eq + 1).trim();
    while (open(value) && i + 1 < lines.length) value += `\n${(lines[++i] ?? '').trim()}`;
    cfg.get(section)?.set(key, value);
  }
  return cfg;
}

/** A quoted string value, unescaped; undefined when the raw text is not a string. */
export function cfgString(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const match = /^"((?:[^"\\]|\\.)*)"$/s.exec(raw.trim());
  return match === null ? undefined : (match[1] ?? '').replace(/\\(["\\])/g, '$1').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
}

/** Every quoted string inside a value such as `PackedStringArray("a", "b")`. */
export function cfgStrings(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return [...raw.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => (m[1] ?? '').replace(/\\(["\\])/g, '$1'));
}

export const cfgBool = (raw: string | undefined): boolean | undefined => (raw === 'true' ? true : raw === 'false' ? false : undefined);
export const cfgInt = (raw: string | undefined): number | undefined => (raw !== undefined && /^-?\d+$/.test(raw.trim()) ? Number(raw) : undefined);

export const cfgGet = (cfg: Cfg, section: string, key: string): string | undefined => cfg.get(section)?.get(key);
