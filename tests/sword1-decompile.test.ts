import { describe, expect, it } from 'vitest';
import {
  disassembleSword1Resource,
  disassembleSword1Script,
  formatSword1Disassembly,
  formatSword1Instruction,
  reassembleSword1Script,
  roundTripsSword1Script,
  sword1CompactFieldName,
} from '../src/authoring/sword1/disassemble.js';
import { IT, parseSword1ScriptModule } from '../src/engine/sword1/script/swordTokens.js';
import { CPT } from '../src/engine/sword1/resource/swordCompact.js';
import { SWORD1_HEADER_SIZE } from '../src/engine/sword1/resource/swordDefs.js';
import { buildScriptResource } from './fixtureSword.js';

const SCRIPT_A = [
  IT.PUSHVARIABLE,
  909,
  IT.PUSHNUMBER,
  12,
  IT.ISEQUAL,
  IT.SKIPONFALSE,
  6,
  IT.PUSHNUMBER,
  1,
  IT.MCODE,
  69,
  1,
  IT.SCRIPTEND,
];

const SCRIPT_B = [
  IT.PUSHLONGOFFSET,
  CPT.YCOORD,
  IT.PUSHNUMBER,
  4,
  IT.PLUS,
  IT.POPLONGOFFSET,
  CPT.YCOORD,
  IT.SWITCH,
  2,
  1,
  5,
  2,
  8,
  11,
  IT.PUSHNUMBER,
  10,
  IT.POPVAR,
  0,
  IT.SCRIPTEND,
  IT.PUSHNUMBER,
  20,
  IT.POPVAR,
  0,
  IT.SCRIPTEND,
  IT.PUSHNUMBER,
  30,
  IT.POPVAR,
  0,
  IT.SCRIPTEND,
];

function module(scripts: number[][]) {
  const resource = buildScriptResource(scripts);
  return parseSword1ScriptModule(resource.subarray(SWORD1_HEADER_SIZE));
}

describe('disassembling', () => {
  it('walks from the module’s own entry points, not from word zero', () => {
    // Word 0 is the count and words 1..n are the offsets. A linear walk would
    // read those as instructions and produce nonsense.
    const disassembly = disassembleSword1Script(module([SCRIPT_A, SCRIPT_B]));
    expect(disassembly.instructions[0].at).toBe(3);
    expect(disassembly.instructions[0].token).toBe(IT.PUSHVARIABLE);
    expect(disassembly.unrecovered).toHaveLength(0);
  });

  it('splits every shipped-shape instruction, including the two variadic ones', () => {
    const disassembly = disassembleSword1Script(module([SCRIPT_B]));
    const tokens = disassembly.instructions.map((instruction) => instruction.token);
    expect(tokens).toContain(IT.SWITCH);
    const branch = disassembly.instructions.find((instruction) => instruction.token === IT.SWITCH);
    // Count, then two (value, jump) pairs, then the default.
    expect(branch?.operands).toEqual([2, 1, 5, 2, 8, 11]);
    expect(branch?.words).toBe(1 + 1 + 2 * 2 + 1);
  });

  it('records a word it cannot decode rather than skipping it', () => {
    const disassembly = disassembleSword1Script(module([[12345, IT.SCRIPTEND]]));
    expect(disassembly.unrecovered).toHaveLength(1);
    expect(disassembly.unrecovered[0].why).toMatch(/not a Broken Sword token/);
  });
});

describe('the listing', () => {
  it('names variables, mcodes and compact fields rather than printing numbers', () => {
    const disassembly = disassembleSword1Script(module([SCRIPT_A, SCRIPT_B]));
    const lines = formatSword1Disassembly(disassembly).join('\n');
    expect(lines).toMatch(/IT_PUSHVARIABLE SCREEN/);
    expect(lines).toMatch(/IT_MCODE fnWalk\/1/);
    expect(lines).toMatch(/IT_PUSHLONGOFFSET o_ycoord/);
  });

  it('prints a jump as its destination, which is what a reader needs', () => {
    const disassembly = disassembleSword1Script(module([SCRIPT_A]));
    const skip = disassembly.instructions.find(
      (instruction) => instruction.token === IT.SKIPONFALSE,
    );
    expect(formatSword1Instruction(skip!)).toMatch(/-> \d+/);
  });

  it('names an unnamed compact offset rather than printing nothing', () => {
    expect(sword1CompactFieldName(CPT.XCOORD)).toBe('o_xcoord');
    expect(sword1CompactFieldName(999)).toBe('cpt+999');
  });
});

describe('reassembling', () => {
  it('re-emits a module to exactly the words it was read from', () => {
    const parsed = module([SCRIPT_A, SCRIPT_B]);
    expect(roundTripsSword1Script(parsed)).toEqual({ ok: true });
  });

  it('round-trips through the resource reader too', () => {
    const resource = buildScriptResource([SCRIPT_A, SCRIPT_B]);
    const { module: parsed, disassembly } = disassembleSword1Resource(
      resource.subarray(SWORD1_HEADER_SIZE),
    );
    expect(roundTripsSword1Script(parsed, disassembly)).toEqual({ ok: true });
  });

  it('keeps jumps correct when an instruction is inserted before them', () => {
    const parsed = module([SCRIPT_A]);
    const disassembly = disassembleSword1Script(parsed);
    // Insert a two-word push at the very start of the script. Every jump across
    // it must be re-derived, which is the property that makes editing safe.
    const first = disassembly.instructions[0];
    const inserted = [
      { at: first.at - 0.5, token: IT.PUSHNUMBER, operands: [7], words: 2 },
      ...disassembly.instructions,
    ];
    const rebuilt = reassembleSword1Script(inserted, disassembly.entries);
    const reparsed = { code: rebuilt, scriptCount: 1, offsets: [rebuilt[1]] };
    const again = disassembleSword1Script(reparsed);
    const skip = again.instructions.find((instruction) => instruction.token === IT.SKIPONFALSE);
    const mcode = again.instructions.find((instruction) => instruction.token === IT.MCODE);
    // The skip's destination is still the instruction it pointed at before.
    expect(skip!.at + 1 + skip!.operands[0]).toBe(
      again.instructions[again.instructions.indexOf(mcode!) + 1].at,
    );
  });

  it('refuses an edit that leaves a jump pointing at no instruction', () => {
    const parsed = module([SCRIPT_A]);
    const disassembly = disassembleSword1Script(parsed);
    // Drop the instruction a jump lands on. Writing this would produce a script
    // that runs into the middle of another one.
    const skip = disassembly.instructions.find(
      (instruction) => instruction.token === IT.SKIPONFALSE,
    )!;
    const target = skip.at + 1 + skip.operands[0];
    const without = disassembly.instructions.filter((instruction) => instruction.at !== target);
    expect(() => reassembleSword1Script(without, disassembly.entries)).toThrow(
      /not the start of an instruction/,
    );
  });

  it('moves a script’s entry with its instructions', () => {
    const parsed = module([SCRIPT_A, SCRIPT_B]);
    const disassembly = disassembleSword1Script(parsed);
    const first = disassembly.instructions[0];
    const inserted = [
      { at: first.at - 0.5, token: IT.PUSHNUMBER, operands: [7], words: 2 },
      ...disassembly.instructions,
    ];
    const rebuilt = reassembleSword1Script(inserted, disassembly.entries);
    // Script 1 used to start where it started; now it starts two words later,
    // because two words were inserted ahead of it.
    expect(rebuilt[2]).toBe(disassembly.entries[1] + 2);
  });
});
