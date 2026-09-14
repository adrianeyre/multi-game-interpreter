import { describe, expect, it } from 'vitest';
import {
  decodeSkyInstruction,
  listSkyScript,
  skyScriptOffset,
  skyScriptCount,
  skyScriptModule,
  SkyScriptError,
  SKY_OPCODES,
} from '../src/engine/sky/script/skyOpcodes.js';

/** A script, written as words the way the encoding describes them. */
function script(...words: number[]): Uint16Array {
  return Uint16Array.from(words);
}

describe('the Sky script encoding', () => {
  it('derives an instruction’s length from its opcode alone', () => {
    // The property the encoding spike asks about: a boundary is derived rather
    // than measured, which is what makes a listing able to walk a whole script.
    const push = decodeSkyInstruction(script(2, 42), 0);
    expect(push.name).toBe('push_number');
    expect(push.operands).toEqual([42]);
    expect(push.words).toBe(2);

    const plus = decodeSkyInstruction(script(8), 0);
    expect(plus.words).toBe(1);
    expect(plus.operands).toEqual([]);

    const call = decodeSkyInstruction(script(11, 2, 0x40), 0);
    expect(call.name).toBe('call_mcode');
    expect(call.words).toBe(3);
  });

  it('resolves a skip’s target, dividing the byte distance by two', () => {
    // The one place a unit changes. A listing that forgets it reports every
    // branch at twice its distance, and every one of them looks plausible.
    const forwards = decodeSkyInstruction(script(9, 8), 0);
    expect(forwards.words).toBe(2);
    expect(forwards.target).toBe(2 + 4);

    // Backwards, which is how a script loops.
    const backwards = decodeSkyInstruction(script(9, 0x10000 - 8), 0);
    expect(backwards.target).toBe(2 - 4);
  });

  it('reads a switch, whose length it declares itself', () => {
    // Two cases, then a default distance: 1 + 1 + 2*2 + 1 = 7 words.
    const instruction = decodeSkyInstruction(script(14, 2, 10, 4, 20, 8, 12), 0);
    expect(instruction.name).toBe('switch');
    expect(instruction.words).toBe(7);
    expect(instruction.operands).toEqual([2, 10, 4, 20, 8, 12]);
  });

  it('stops rather than guessing at an opcode the encoding does not define', () => {
    const listing = listSkyScript(script(2, 1, 8, 999, 19));
    expect(listing.instructions).toHaveLength(2);
    expect(listing.stoppedAt).toBe(3);
    expect(listing.stoppedBecause).toMatch(/not one of this encoding's 21 opcodes/);
    // The behaviour that matters: it does not resynchronise. A plausible
    // listing of instructions that are not in the script is the worst result.
    expect(listing.stoppedBecause).toMatch(/rather than guessing/);
  });

  it('stops when an instruction runs off the end of its script', () => {
    // The signal that the offset the listing started from was wrong.
    const listing = listSkyScript(script(2));
    expect(listing.instructions).toHaveLength(0);
    expect(listing.stoppedBecause).toMatch(/operand words/);
  });

  it('ends a listing at a terminal instruction rather than reading on', () => {
    const listing = listSkyScript(script(2, 7, 19, 2, 9));
    expect(listing.instructions.map((i) => i.name)).toEqual(['push_number', 'script_exit']);
    expect(listing.stoppedBecause).toBeNull();
  });

  it('knows both numbers that mean script_exit', () => {
    expect(SKY_OPCODES[13]?.name).toBe('script_exit');
    expect(SKY_OPCODES[19]?.name).toBe('script_exit');
    expect(SKY_OPCODES[13]?.terminal).toBe(true);
  });

  it('refuses script 0, which is the table’s own length', () => {
    // Every one of the seven shipped modules has exactly this trap in it, and
    // it is the only entry in any of them that does not list to an exit.
    const module = script(3, 5, 9, 0, 0);
    expect(skyScriptCount(module)).toBe(3);
    expect(skyScriptOffset(module, 1)).toBe(5);
    expect(skyScriptOffset(module, 2)).toBe(9);
    expect(() => skyScriptOffset(module, 0)).toThrow(SkyScriptError);
    expect(() => skyScriptOffset(module, 0)).toThrow(/Scripts are numbered from 1/);
    expect(() => skyScriptOffset(module, 3)).toThrow(/table holding 3 entries/);
  });

  it('splits a script number into its module and its index', () => {
    expect(skyScriptModule(0x3042)).toBe(3);
    expect(skyScriptOffset(script(2, 7), 0x1001)).toBe(7);
  });
});
