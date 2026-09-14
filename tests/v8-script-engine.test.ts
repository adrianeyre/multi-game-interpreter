import { describe, expect, it } from 'vitest';

import { ScriptEngine as ScriptEngineV8 } from '../src/engine/script/v8/ScriptEngine.js';
import { StackScriptEngine } from '../src/engine/script/StackScriptEngine.js';

/**
 * v8's shape, pinned.
 *
 * Tier 1 only — The Curse of Monkey Island is not on this machine — so nothing
 * here says v8 *runs*. What it says is that v8 is a third delta on the shared
 * stack machine rather than a subclass of v7, that its instruction set is a
 * renumbering rather than a second table, and that the renumbering is a
 * bijection. A pair that is wrong puts one instruction in the wrong place; a
 * table that had drifted would be plausible everywhere.
 */
describe('the SCUMM v8 interpreter', () => {
  it('is a delta on the shared stack machine, not on v7', () => {
    // ADR 0006 rejected v7-over-v6 and the reason carries: a subclass would
    // carry every later v7 correction into v8 whether it belonged or not.
    expect(Object.getPrototypeOf(ScriptEngineV8.prototype)).toBe(StackScriptEngine.prototype);
  });

  it('installs a table of its own rather than inheriting one', () => {
    expect(Object.getOwnPropertyNames(ScriptEngineV8.prototype)).toContain('installOpcodes');
  });

  it('reads a code-stream word as four bytes, not two', () => {
    // The single most load-bearing line in the Version. Every shared
    // instruction that reads an immediate goes through it, so getting it wrong
    // does not give a wrong value — it leaves the program counter two bytes out
    // at the first constant and nonsense from there on.
    expect(Object.getOwnPropertyNames(ScriptEngineV8.prototype)).toContain('fetchWord');
    expect(Object.getOwnPropertyNames(ScriptEngineV8.prototype)).toContain('fetchWordSigned');
  });
});

describe('the v8 opcode renumbering', () => {
  /**
   * Read back out of the module rather than restated here.
   *
   * A copy of the table in the test would only assert that two transcriptions
   * of the same thing agree, which is the failure mode the table exists to
   * avoid. What is worth asserting is the *properties* a correspondence must
   * have whatever its contents.
   */
  async function pairs(): Promise<Array<readonly [number, number]>> {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile('src/engine/script/v8/ScriptEngine.ts', 'utf8'),
    );
    const table = source.slice(source.indexOf('const V8_FROM_V6'), source.indexOf('];'));
    return [...table.matchAll(/\[0x([0-9a-f]{2}), 0x([0-9a-f]{2})\]/g)].map(
      (match) => [Number.parseInt(match[1], 16), Number.parseInt(match[2], 16)] as const,
    );
  }

  it('maps 118 of v8s 142 instructions onto ones v6 already has', async () => {
    expect(await pairs()).toHaveLength(118);
  });

  it('never sends two v8 opcodes to the same v6 one', async () => {
    // Two v8 numbers sharing a v6 handler would mean one of them is really a
    // v8 instruction that was matched to the wrong name.
    const mapped = await pairs();
    expect(new Set(mapped.map(([, v6]) => v6)).size).toBe(mapped.length);
  });

  it('never binds the same v8 opcode twice', async () => {
    const mapped = await pairs();
    expect(new Set(mapped.map(([v8]) => v8)).size).toBe(mapped.length);
  });

  it('renumbers rather than keeping v6s numbers', async () => {
    // If most pairs were identities this would be a delta and not a
    // renumbering, and the whole mechanism would be the wrong shape.
    const mapped = await pairs();
    const moved = mapped.filter(([v8, v6]) => v8 !== v6).length;
    expect(moved).toBeGreaterThan(mapped.length / 2);
  });
});

describe('reading and re-emitting a v8 script', () => {
  it('reads a pushed constant as four bytes, not two', async () => {
    const { disassembleV8 } = await import('../src/authoring/disassembleV6.js');
    // v8 0x01 is pushWord, which at v6 is 0x01 too — and reads four bytes here.
    const code = new Uint8Array([0x01, 0x2c, 0x01, 0x00, 0x00, 0x7b]);
    const listing = disassembleV8(code);

    expect(listing.instructions[0].name).toBe('pushWord');
    expect(listing.instructions[0].length).toBe(5);
    expect(listing.instructions[0].streamOperand).toBe(300);
  });

  it('re-emits an untouched script byte for byte', async () => {
    const { assembleV8, disassembleV8 } = await import('../src/authoring/disassembleV6.js');
    const code = new Uint8Array([
      0x01,
      0x2c,
      0x01,
      0x00,
      0x00, // pushWord 300
      0x00,
      0x07, // pushByte 7
      0x70,
      0x02,
      0x0a,
      0x00,
      0x00,
      0x00, // dimArray: a sub-opcode and an array
      0x7b, // stopObjectCode, which v6 numbers 0x65
    ]);

    expect(Array.from(assembleV8(disassembleV8(code), code))).toEqual(Array.from(code));
  });

  it('measures a dispatcher it cannot read, so the next instruction is right', async () => {
    const { disassembleV8 } = await import('../src/authoring/disassembleV6.js');
    // actorOps is v8's own and its sub-table is not read. A stack machine makes
    // measuring enough: the operands were pushed by instructions of their own.
    const code = new Uint8Array([0xac, 0x13, 0x7b]);
    const listing = disassembleV8(code);

    expect(listing.instructions[0].name).toBe('actorOps');
    expect(listing.instructions[0].length).toBe(2);
    expect(listing.instructions[1].offset).toBe(2);
  });
});

describe('v8 sub-opcode families', () => {
  /**
   * Every family runs. What differs is how much of each is *understood*, and
   * the tests worth having are about the part that cannot be got wrong safely.
   *
   * An instruction's length is one sub-opcode byte whatever happens inside, so
   * the code stream is never at risk. The *stack* is: popping the wrong number
   * of operands leaves it misaligned and the next instruction reads someone
   * else's value, with no local symptom at all. So the pop table is the
   * load-bearing part, and it is transcribed one case at a time.
   */
  async function source(): Promise<string> {
    return import('node:fs/promises').then((fs) =>
      fs.readFile('src/engine/script/v8/ScriptEngine.ts', 'utf8'),
    );
  }

  it('leaves no family merely measured', async () => {
    // Every dispatcher is bound to something that pops what it should. The
    // list of families that only reported their sub-opcode is gone.
    expect(await source()).not.toContain('V8_DISPATCHERS');
  });

  it("uses v8's own sub-opcode numbers, which share nothing with v6's", async () => {
    const text = await source();
    // An integer array is 10 where v6 spends 199 on it; the cursor family runs
    // from 220 where v6 numbers its own from 0x90.
    expect(text).toMatch(/IntArray: 10/);
    expect(text).toMatch(/WaitForActor: 30/);
    expect(text).toMatch(/CursorOn: 220/);
    expect(text).toMatch(/VerbInit: 150/);
  });

  it('tells "pops nothing" apart from "not in the table"', async () => {
    // The two have to be distinguishable: the first is an answer and the
    // second is a gap, and only the second is worth reporting. A sub-opcode
    // that is genuinely operand-free would otherwise be reported for ever.
    const text = await source();
    expect(text).toContain('V8_NO_OPERAND');
    expect(text).toMatch(/V8_POPS\.has\(subOp\) && !V8_NO_OPERAND\.has\(subOp\)/);
  });

  it('pops an actor before the switch, for every actorOps form', async () => {
    // v8 pops the actor first and unconditionally. A form that popped it
    // inside its own case would take it from under the operands.
    expect(await source()).toMatch(/The actor is popped before the switch, for every form/);
  });
});
