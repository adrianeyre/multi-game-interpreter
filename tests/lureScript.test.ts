import { describe, expect, it } from 'vitest';

import {
  LURE_OPCODE_COUNT,
  LURE_OPCODE_NAMES,
  lureOpcodeName,
} from '../src/engine/lure/script/opcodeNames.js';
import {
  LureScriptError,
  disassembleLureListing,
  disassembleLureScript,
  lureOpcodeHistogram,
} from '../src/engine/lure/script/lureScript.js';

/**
 * Encodes one instruction the way the game does: the low bit of the opcode
 * byte is a has-parameter flag and the opcode is shifted up by one.
 */
function instruction(opcode: number, parameter?: number): number[] {
  if (parameter === undefined) return [(opcode << 1) & 0xff];
  return [((opcode << 1) | 1) & 0xff, parameter & 0xff, (parameter >> 8) & 0xff];
}

/** `abort` is opcode 0, so its byte is 0x00 — one byte, no parameter. */
const ABORT = instruction(0);

function script(...parts: number[][]): Uint8Array {
  return new Uint8Array(parts.flat());
}

describe('the opcode byte is not the opcode', () => {
  it('shifts the has-parameter bit off, so one opcode has two bytes', () => {
    // The trap this encoding sets: read the byte as the opcode and every
    // number doubles while every length comes out as one.
    const withParameter = disassembleLureScript(script(instruction(6, 300), ABORT), 0)
      .instructions[0];
    const without = disassembleLureScript(script(instruction(6), ABORT), 0).instructions[0];

    expect(withParameter?.opcode).toBe(6);
    expect(without?.opcode).toBe(6);
    expect(withParameter?.parameter).toBe(300);
    expect(without?.parameter).toBeNull();
    expect(withParameter?.byteLength).toBe(3);
    expect(without?.byteLength).toBe(1);
    // Same opcode, different first byte — 0x0d and 0x0c.
    expect(script(instruction(6, 0))[0]).toBe(0x0d);
    expect(script(instruction(6))[0]).toBe(0x0c);
  });

  it('reads the parameter little-endian', () => {
    const bytes = script(instruction(1, 0xbeef), ABORT);
    expect(bytes[1]).toBe(0xef);
    expect(bytes[2]).toBe(0xbe);
    expect(disassembleLureScript(bytes, 0).instructions[0]?.parameter).toBe(0xbeef);
  });
});

describe('walking a script', () => {
  it('stops at the abort and includes it', () => {
    const result = disassembleLureScript(
      script(instruction(1, 5), instruction(2), instruction(11, 65535), ABORT),
      0,
    );
    expect(result.instructions).toHaveLength(4);
    expect(result.instructions.at(-1)?.name).toBe('abort');
    expect(result.byteLength).toBe(3 + 1 + 3 + 1);
  });

  it('disassembles from an offset that is not zero', () => {
    const bytes = script(instruction(1, 5), ABORT, instruction(2), ABORT);
    const second = disassembleLureScript(bytes, 4);
    expect(second.entryOffset).toBe(4);
    expect(second.instructions.map((i) => i.name)).toEqual(['subtract', 'abort']);
  });

  it('lists each instruction with its address, name and operand', () => {
    const lines = disassembleLureListing(
      disassembleLureScript(script(instruction(1, 7), instruction(2), ABORT), 0),
    );
    expect(lines[0]).toMatch(/^\s+0 {2}add 7$/);
    expect(lines[1]).toMatch(/^\s+3 {2}subtract$/);
    expect(lines[2]).toMatch(/^\s+4 {2}abort$/);
  });

  it('counts opcodes across scripts, commonest first', () => {
    const one = disassembleLureScript(script(instruction(1, 1), instruction(1, 2), ABORT), 0);
    const two = disassembleLureScript(script(instruction(2), ABORT), 0);
    expect(lureOpcodeHistogram([one, two])).toEqual([
      { opcode: 0, name: 'abort', count: 2 },
      { opcode: 1, name: 'add', count: 2 },
      { opcode: 2, name: 'subtract', count: 1 },
    ]);
  });
});

describe('what it refuses rather than guesses at', () => {
  it('refuses a script that never reaches an abort', () => {
    // No abort anywhere: walking to the end of the resource is a different
    // fact from a short script, and a truncated listing hides it.
    const bytes = script(instruction(1), instruction(1), instruction(1));
    expect(() => disassembleLureScript(bytes, 0)).toThrow(LureScriptError);
    expect(() => disassembleLureScript(bytes, 0)).toThrow(/without reaching an abort/);
  });

  it('refuses a parameter that runs past the end of the resource', () => {
    const bytes = new Uint8Array([(1 << 1) | 1, 0x34]);
    expect(() => disassembleLureScript(bytes, 0)).toThrow(/runs past the end/);
  });

  it('refuses an entry offset outside the resource', () => {
    const bytes = script(ABORT);
    expect(() => disassembleLureScript(bytes, 99)).toThrow(/outside the script resource/);
    expect(() => disassembleLureScript(bytes, -1)).toThrow(/outside the script resource/);
  });

  it('stops a runaway walk at the limit rather than looping', () => {
    const long = new Uint8Array(200).fill((1 << 1) & 0xff);
    expect(() => disassembleLureScript(long, 0, 10)).toThrow(/ran 10 instructions/);
  });

  it('reports an opcode past the generated table rather than naming it wrongly', () => {
    const beyond = LURE_OPCODE_COUNT + 3;
    const result = disassembleLureScript(script(instruction(beyond), ABORT), 0);
    expect(result.unnamedOpcodes).toEqual([beyond]);
    expect(result.instructions[0]?.name).toBe(`<opcode ${beyond}>`);
  });
});

describe('the generated opcode table', () => {
  it('names every number it covers', () => {
    expect(LURE_OPCODE_COUNT).toBe(LURE_OPCODE_NAMES.length);
    for (let opcode = 0; opcode < LURE_OPCODE_COUNT; opcode += 1) {
      expect(lureOpcodeName(opcode)).toMatch(/^[a-z][A-Za-z0-9]*$/);
    }
  });

  it('keeps abort at zero, which the walk depends on', () => {
    // Spot-checks rather than a copy of the table. `abort` at 0 is
    // load-bearing: it is what ends every script, and it is also why an
    // all-zero region disassembles as a run of one-byte aborts.
    expect(lureOpcodeName(0)).toBe('abort');
    expect(lureOpcodeName(1)).toBe('add');
    expect(lureOpcodeName(6)).toBe('notEquals');
  });

  it('prints a number it has no name for rather than nothing', () => {
    expect(lureOpcodeName(LURE_OPCODE_COUNT)).toBe(`<opcode ${LURE_OPCODE_COUNT}>`);
  });
});
