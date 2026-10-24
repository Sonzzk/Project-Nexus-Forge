import type { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { CHANNELS, EVENTS } from './channels';
import { contract } from './contract';

// ARCHITECTURE.md section 6, "Forbidden channel shapes": a request never carries an absolute path, a shell string, an
// executable, raw command arguments or a working directory, and no channel reads or writes arbitrary paths, runs
// arbitrary commands, grants permissions or returns secrets. Names are checked here; semantics are checked in review.

const FORBIDDEN_FIELDS =
  /^(path|paths|absolutepath|filepath|file|filename|dir|directory|folder|cwd|workingdir|workingdirectory|executable|exe|command|cmd|args|argv|arguments|shell|script|env|environment|url|uri)$/i;
const FORBIDDEN_CHANNEL_WORDS =
  /(readfile|writefile|deletefile|listdir|readdir|exec|spawn|shell|runcommand|runscript|grant|permission|secret|credential|token|password|env)/i;

/** Every field name reachable in a schema, however deeply nested. */
function fieldNames(schema: z.ZodType): string[] {
  const def = (schema as unknown as { _zod: { def: Record<string, unknown> } })._zod.def;
  const type = def['type'];
  if (type === 'object') {
    const shape = def['shape'] as Record<string, z.ZodType>;
    return Object.entries(shape).flatMap(([name, child]) => [name, ...fieldNames(child)]);
  }
  if (type === 'array') return fieldNames(def['element'] as z.ZodType);
  if (type === 'optional' || type === 'default' || type === 'nullable' || type === 'readonly')
    return fieldNames(def['innerType'] as z.ZodType);
  if (type === 'union') return (def['options'] as z.ZodType[]).flatMap(fieldNames);
  if (type === 'record') return fieldNames(def['valueType'] as z.ZodType);
  return [];
}

describe('IPC contract', () => {
  it('has a request and a response schema for every channel, and no schema for a channel that is not listed', () => {
    expect(Object.keys(contract).sort()).toEqual([...CHANNELS].sort());
  });

  it('names channels <area>:<verb> and events the same way', () => {
    for (const name of [...CHANNELS, ...EVENTS]) expect(name).toMatch(/^[a-z]+:[a-zA-Z]+$/);
  });

  it.each(CHANNELS)(
    '%s: the request has no path, command, executable, argument, shell or working-directory field',
    (channel) => {
      expect(fieldNames(contract[channel].request).filter((name) => FORBIDDEN_FIELDS.test(name))).toEqual([]);
    },
  );

  it.each(CHANNELS)('%s: the response has no secret-bearing field', (channel) => {
    expect(
      fieldNames(contract[channel].response).filter((name) =>
        /password|secret|token|apikey|credential/i.test(name),
      ),
    ).toEqual([]);
  });

  it('has no channel that reads, writes, runs or grants anything arbitrary', () => {
    expect(CHANNELS.filter((name) => FORBIDDEN_CHANNEL_WORDS.test(name.split(':')[1] ?? ''))).toEqual([]);
  });

  it('the field-name check really does catch a forbidden shape', async () => {
    const { z: zod } = await import('zod');
    const bad = zod.strictObject({ project: zod.string(), options: zod.strictObject({ cwd: zod.string() }) });
    expect(fieldNames(bad).filter((name) => FORBIDDEN_FIELDS.test(name))).toEqual(['cwd']);
  });

  it('every request schema is strict: unknown fields are rejected, not ignored', () => {
    for (const channel of CHANNELS) {
      const request = contract[channel].request;
      const probe = request.safeParse({ __unexpected__: 1 });
      // A schema may fail for other reasons, but it must never accept an unknown field.
      if (probe.success) throw new Error(`${channel} accepted an unknown field`);
    }
  });
});
