import { describe, expect, it } from 'vitest';
import { checkName, suggestName, UNREAL_PREFIX } from './naming';

describe('asset naming', () => {
  it('builds Unreal names from Epic\'s pattern: prefix, name, descriptor, variant', () => {
    expect(suggestName('unreal', 'static-mesh', 'wooden chair', 'Worn', '01')).toBe('SM_WoodenChair_Worn_01');
    expect(suggestName('unreal', 'texture', 'brick wall', 'normal')).toBe('T_BrickWall_Normal');
    expect(suggestName('unreal', 'material-instance', 'Brick')).toBe('MI_Brick');
    expect(suggestName('unreal', 'other', 'misc_thing')).toBe('MiscThing');
    expect(UNREAL_PREFIX['skeletal-mesh']).toBe('SK_');
  });

  it('uses lowercase snake_case for Godot and the generic rule, and PascalCase for Unity', () => {
    expect(suggestName('godot', 'static-mesh', 'Wooden Chair', 'worn', '2')).toBe('wooden_chair_worn_2');
    expect(suggestName('generic', 'texture', 'brickWall')).toBe('brick_wall');
    expect(suggestName('unity', 'static-mesh', 'wooden chair', 'worn', '01')).toBe('WoodenChair_Worn_01');
  });

  it('names what is wrong with a name and still suggests a fix', () => {
    const bad = checkName('unreal', 'static-mesh', 'wooden chair', 'wooden chair');
    expect(bad.problems).toEqual(expect.arrayContaining(['The name has spaces.', 'A static mesh should start with SM_.']));
    expect(bad.suggestion).toBe('SM_WoodenChair');
    expect(bad.rule).toContain('Epic');
    expect(checkName('unreal', 'static-mesh', 'SM_Chair').problems).toEqual([]);
    expect(checkName('godot', 'texture', 'Brick_Wall').problems).toEqual(['Use lowercase only (snake_case).']);
    expect(checkName('godot', 'texture', 'brick-wall!').problems).toEqual(['Use only letters, digits and underscores.']);
    expect(checkName('generic', 'other', '').problems).toContain('The name is empty.');
  });
});
