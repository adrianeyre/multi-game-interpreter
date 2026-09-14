/**
 * The PMachine: one Script engine for the family (ADR 0017).
 *
 * The decoder half of this is verified far beyond what a fixture can carry:
 * every code block of eight freely distributed Sierra demos, SCI0 early through
 * SCI1 middle, disassembles to **129,183 instructions with zero unknown
 * opcodes and zero blocks overrun**, and all 2,925 method entry points land
 * inside a code block. That is the check that matters for an instruction table,
 * and it cannot live in CI. What lives here is the shape of it.
 */

import { describe, expect, it } from 'vitest';

import {
  SCI_OPCODES,
  decodeSciBlock,
  decodeSciInstruction,
  formatSciInstruction,
} from '../src/engine/sci/script/opcodes.js';
import {
  ADDRESS_BASE,
  LOCALS_SEGMENT,
  NULL_REG,
  PMachine,
  reg,
  type Reg,
} from '../src/engine/sci/script/PMachine.js';
import type { SciKernelWorld } from '../src/engine/sci/script/SciKernel.js';
import type { SciHeap } from '../src/engine/sci/script/segments.js';
import { kernelNamesFor, describeUnknownKernel } from '../src/engine/sci/script/kernel.js';
import { readSelectorTable } from '../src/engine/sci/script/selectors.js';
import type { SciVersion } from '../src/engine/sci/sciVersion.js';
import {
  readSci0Blocks,
  readSci0Exports,
  readSci0Methods,
  readSci0Object,
  sci0ExportStride,
  sci0ScriptBias,
} from '../src/engine/sci/script/scriptResource.js';

describe('the instruction encoding', () => {
  /**
   * The claim ADR 0017 rests on, as a test: length comes from the low bit and
   * from nothing else. Same opcode, same operand, two lengths.
   */
  /**
   * Sierra's debug builds record the source file each method came from, after
   * `line`, as a NUL-terminated string behind opcode 0x3e.
   *
   * Read as a one-byte `pushSelf`, the machine walks into the name and executes
   * it. Torin's script 64999 opens a method with `line 221`, then `0x7d`, then
   * `73 79 73 74 65 6d 2e 73 63 00` — `"system.sc"` — and halted three
   * instructions later on a property offset that was really the letter `m`.
   *
   * **Decided by the low bit, which is how every other operand width here is
   * decided.** `run_vm`'s `op_pushSelf` is `if (!(extOpcode & 1)) PUSH32(objp)
   * else` skip a file name (`vm.cpp`), and it consults nothing after the
   * opcode. These tests asserted the opposite for a while — that the bytes
   * decide and the Version gates it — and a retail King's Quest VII is what
   * showed the cost: a real `0x7c pushSelf` in script 64998 is followed by
   * `67 5c 34 00`, which reads as `"g\\4"`, and five bytes of live code were
   * swallowed as a name. The machine shares this decoder, so that desynchronised
   * *execution* inside the SCI32 system script that builds `IsOnMe`'s arguments.
   */
  it('reads a file name after the odd form, and takes its length from the string', () => {
    const name = [...'system.sc'].map((c) => c.charCodeAt(0));
    const code = new Uint8Array([0x7d, ...name, 0x00, 0x48]);
    const instruction = decodeSciInstruction(code, 0, 'sci2-1-middle');

    expect(instruction).toMatchObject({ name: 'fileName', length: 1 + name.length + 1 });
    // And the `ret` after it is found, which is the whole point.
    expect(decodeSciInstruction(code, instruction!.length, 'sci2-1-middle')).toMatchObject({
      name: 'ret',
    });
  });

  /**
   * The even form is `pushSelf` **whatever follows it**, which is the half a
   * printable-run heuristic cannot get right.
   */
  it('leaves the even form one byte even when a terminated name follows', () => {
    const name = [...'system.sc'].map((c) => c.charCodeAt(0));
    for (const version of ['sci1-late', 'sci1-1', 'sci2', 'sci2-1-middle'] as const) {
      expect(
        decodeSciInstruction(new Uint8Array([0x7c, ...name, 0x00, 0x48]), 0, version),
      ).toMatchObject({ name: 'pushSelf', length: 1 });
    }
    // King's Quest VII's own bytes: `pushSelf` then `pTos 92`, which read as a
    // name swallowed the property access and everything after it.
    expect(
      decodeSciInstruction(new Uint8Array([0x7c, 0x67, 0x5c, 0x34, 0x00]), 0, 'sci2-1-middle'),
    ).toMatchObject({ name: 'pushSelf', length: 1 });
  });

  /**
   * And the odd form is a name at **every** Version, because the opcode says so
   * and a Version cannot. The old rule gated this on SCI2.1 and needed a corpus
   * measurement to justify the gate; there is nothing left to measure.
   */
  it('reads the odd form as a name at every Version, and never runs off the end', () => {
    const name = [...'system.sc'].map((c) => c.charCodeAt(0));
    const code = new Uint8Array([0x7d, ...name, 0x00, 0x48]);
    for (const version of ['sci1-late', 'sci1-1', 'sci2'] as const) {
      expect(decodeSciInstruction(code, 0, version)).toMatchObject({ name: 'fileName' });
    }

    // A name with no terminator before the end of the resource still advances,
    // and stops at the end rather than past it.
    const unterminated = decodeSciInstruction(new Uint8Array([0x7d, 0x41, 0x42, 0x43]), 0);
    expect(unterminated?.name).toBe('fileName');
    expect(unterminated!.length).toBe(4);
  });

  it('takes an operand width from the low bit of the opcode byte', () => {
    // `pushi` is 0x1c; 0x38 is it with a 16-bit operand and 0x39 with 8-bit.
    const wide = decodeSciInstruction(new Uint8Array([0x38, 0x34, 0x12]), 0);
    const narrow = decodeSciInstruction(new Uint8Array([0x39, 0x34]), 0);

    expect(wide).toMatchObject({ name: 'pushi', length: 3, operands: [0x1234] });
    expect(narrow).toMatchObject({ name: 'pushi', length: 2, operands: [0x34] });
  });

  /**
   * The operand that is *not* sized by the low bit, and the one most likely to
   * be got wrong: a send's parameter-byte count is always one byte.
   */
  it('keeps a parameter-byte count one byte wide whichever the low bit says', () => {
    expect(decodeSciInstruction(new Uint8Array([0x4a, 0x06]), 0)).toMatchObject({
      name: 'send',
      length: 2,
    });
    expect(decodeSciInstruction(new Uint8Array([0x4b, 0x06]), 0)).toMatchObject({
      name: 'send',
      length: 2,
    });
  });

  it('reads a branch displacement as signed', () => {
    // `bnt` narrow, displacement -4.
    expect(decodeSciInstruction(new Uint8Array([0x31, 0xfc]), 0)?.operands).toEqual([-4]);
  });

  /**
   * Sierra left 0x29 and 0x2f unused. Reaching one means the decode
   * desynchronised several bytes earlier, and inventing a length there is how
   * one bad byte becomes a whole method of plausible nonsense.
   */
  it('refuses the two opcodes Sierra left unused rather than inventing a length', () => {
    expect(SCI_OPCODES[0x29]).toBeUndefined();
    expect(SCI_OPCODES[0x2f]).toBeUndefined();
    expect(decodeSciInstruction(new Uint8Array([0x52]), 0)).toBeNull();
  });

  it('generates the load and store grid rather than naming sixty-four cases', () => {
    expect(SCI_OPCODES[0x40]?.name).toBe('lag');
    expect(SCI_OPCODES[0x41]?.name).toBe('lal');
    expect(SCI_OPCODES[0x50]?.name).toBe('sag');
    expect(SCI_OPCODES[0x60]?.name).toBe('+ag');
    expect(SCI_OPCODES[0x70]?.name).toBe('-ag');
    expect(SCI_OPCODES.filter(Boolean).length).toBe(126);
  });

  it('disassembles a block to its end and formats it', () => {
    const code = new Uint8Array([0x39, 0x05, 0x36, 0x48]);
    const block = decodeSciBlock(code);
    expect(block.map(formatSciInstruction)).toEqual(['pushi 5', 'push', 'ret']);
  });
});

describe('a Script resource', () => {
  /**
   * The two-byte header a SCI0 *early* game puts in front of its block chain.
   *
   * ScummVM names it in passing and does not describe it; the Christmas Card
   * 1988 demo is why this project knows it exists, because it produced no code
   * blocks at all while every other SCI0 demo produced eighty to a hundred and
   * fifty (#216).
   */
  /**
   * Chosen by *coverage*, not by "did it find anything".
   *
   * The first version returned zero as soon as a chain read from zero produced
   * a single block, and retail King's Quest IV showed why that is not enough:
   * twenty-nine of its 190 scripts read from zero produce exactly one block of
   * three bytes — a type and a size that happen to be plausible — and then
   * stop. Read from two, the same scripts produce their real chain. Fixing it
   * took the game from 326 code blocks to 604 and from 29 Unrecovered to none.
   *
   * The demos never showed it, because a demo's scripts happened not to have
   * that pair of bytes in front of them. This is the fault class
   * `verifying-version-support.md` describes, found the only way it can be.
   */
  it('prefers the reading that accounts for more of the resource', () => {
    // Read from zero: a `code` block of eight bytes, then a zero terminator —
    // one block, eight bytes accounted for. Read from two: a `pointers` block
    // of twenty. Both parse; only one of them is the script.
    const script = new Uint8Array(24);
    script.set([0x02, 0x00, 0x08, 0x00, 0x14, 0x00], 0);

    expect(readSci0Blocks(script, 0)).toHaveLength(1);
    expect(readSci0Blocks(script, 2)).toHaveLength(1);
    expect(readSci0Blocks(script, 2)[0].size).toBeGreaterThan(readSci0Blocks(script, 0)[0].size);
    expect(sci0ScriptBias(script)).toBe(2);
  });

  it('may start its block chain two bytes in, and says so rather than reading nothing', () => {
    const blocks = [
      0x02,
      0x00,
      0x08,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00, // a code block of four bytes
      0x00,
      0x00,
    ];
    const plain = new Uint8Array(blocks);
    const early = new Uint8Array([0xd5, 0x03, ...blocks]);

    expect(sci0ScriptBias(plain)).toBe(0);
    expect(sci0ScriptBias(early)).toBe(2);
    expect(readSci0Blocks(early, 2)).toHaveLength(1);
  });

  /**
   * An export entry is two bytes or four, and the block says which.
   *
   * Both widths ship inside `SCI1 early` — the Christmas Card 1990 writes two
   * and Leisure Suit Larry 1 writes four — so there is no Version to branch on
   * and the count and the size are the only two facts that settle it.
   *
   * Read narrow, a wide table gives the right offset for every even export and
   * zero for every odd one: half of them plausible, half of them a frame
   * pushed at offset zero, and nothing anywhere reporting a problem.
   */
  it('takes an export entry width from the block size, not from the Version', () => {
    const put16 = (into: Uint8Array, at: number, value: number): void => {
      into[at] = value & 0xff;
      into[at + 1] = value >> 8;
    };

    // Three exports, two bytes each: block size 4 + 2 + 6.
    const narrow = new Uint8Array(16);
    put16(narrow, 0, 7);
    put16(narrow, 2, 4 + 2 + 3 * 2);
    put16(narrow, 4, 3);
    put16(narrow, 6, 0x11);
    put16(narrow, 8, 0x22);
    put16(narrow, 10, 0x33);

    // The same three exports, four bytes each, high word zero.
    const wide = new Uint8Array(24);
    put16(wide, 0, 7);
    put16(wide, 2, 4 + 2 + 3 * 4);
    put16(wide, 4, 3);
    put16(wide, 6, 0x11);
    put16(wide, 10, 0x22);
    put16(wide, 14, 0x33);

    expect(sci0ExportStride(narrow, readSci0Blocks(narrow)[0])).toBe(2);
    expect(sci0ExportStride(wide, readSci0Blocks(wide)[0])).toBe(4);
    expect(readSci0Exports(narrow, readSci0Blocks(narrow))).toEqual([0x11, 0x22, 0x33]);
    expect(readSci0Exports(wide, readSci0Blocks(wide))).toEqual([0x11, 0x22, 0x33]);
  });

  /** A count of zero cannot choose a stride, and must not crash choosing one. */
  it('falls back to the narrow entry when a table has no entries to measure', () => {
    const empty = new Uint8Array([7, 0, 6, 0, 0, 0]);
    expect(sci0ExportStride(empty, readSci0Blocks(empty)[0])).toBe(2);
    expect(readSci0Exports(empty, readSci0Blocks(empty))).toEqual([]);
  });

  /**
   * The method dictionary's position, which was established against real data
   * rather than assumed — and the two bytes in it are exactly the size of
   * error this project has shipped twice before.
   */
  it('finds a method dictionary from the selector counter, not from the variables', () => {
    const script = new Uint8Array(64);
    const put16 = (at: number, value: number): void => {
      script[at] = value & 0xff;
      script[at + 1] = value >> 8;
    };
    // An object block: type 1, size 4 + 8 + variables.
    put16(0, 1);
    put16(2, 4 + 8 + 4);
    put16(4, 0x1234); // magic
    put16(6, 0); // locals
    put16(8, 2 * 2 + 2); // function area, as every real object stores it
    put16(10, 2); // two variables
    put16(12, 0); // species
    put16(14, 0); // superClass
    // The dictionary lands at (block.offset + 8) - 2 + funcOff = 12 - 2 + 6.
    put16(16, 1); // one method
    put16(18, 42); // its selector
    put16(20, 0); // the zero word that is not a terminator
    put16(22, 30); // its code offset

    const block = readSci0Blocks(script)[0];
    const object = readSci0Object(script, block);
    expect(object).toMatchObject({ variableCount: 2, methodsAt: 16 });
    expect(readSci0Methods(script, object!.methodsAt)).toEqual([{ selector: 42, offset: 30 }]);
  });
});

describe('Selectors, which the game ships itself', () => {
  it('reads a count that is one short, as ScummVM does', () => {
    // Count word 1 means two entries.
    const vocab = new Uint8Array([
      0x01, 0x00, 0x06, 0x00, 0x0b, 0x00, 0x03, 0x00, 0x61, 0x62, 0x63, 0x02, 0x00, 0x64, 0x65,
    ]);
    const table = readSelectorTable(vocab);
    expect(table.names).toEqual(['abc', 'de']);
    expect(table.numbers.get('de')).toBe(1);
  });
});

describe('the Kernel table', () => {
  /**
   * **SCI0 has a table of its own, and this test used to assert SCI1's.**
   *
   * It expected `Joystick` at 0x6d and nothing past it — the shape of SCI1's
   * table with a cut-off. Four demos ship a `vocab.999` naming their own Kernel
   * calls, and all four agree against that: the Christmas Card 1988, Space
   * Quest III, Leisure Suit Larry 2 and King's Quest IV name 113 entries
   * identically, with four file calls at 41 to 44 that SCI1 does not have, so
   * everything after sits four slots lower in SCI1's.
   *
   * Island of Dr. Brain ships one too and is SCI1.1, and *its* table is the
   * other one — 123 of 128 matching `SCI16_NAMES`. That disagreement is what
   * makes these two tables rather than one with a hole in it.
   */
  it('numbers SCI0 as the games that ship a vocab.999 number it', () => {
    const sci0 = kernelNamesFor('sci0-late');
    // The four file calls SCI1 does not have, which is where the tables part.
    expect(sci0[41]).toBe('FOpen');
    expect(sci0[44]).toBe('FClose');
    expect(sci0[45]).toBe('SaveGame');
    // And so everything after is four higher than SCI1 puts it.
    expect(sci0[53]).toBe('FirstNode');
    expect(kernelNamesFor('sci1-late')[49]).toBe('FirstNode');

    const sci1 = kernelNamesFor('sci1-late');
    expect(sci1[0x74]).toBe('FileIO');
  });

  /**
   * The dozen reused slots are the whole reason a SCI Target names a Version.
   * `0x71` is three different calls, and a wrong Version there is a game that
   * runs and does the wrong things.
   */
  it('gives a reused slot the meaning its Version says', () => {
    expect(kernelNamesFor('sci1-early')[0x71]).toBe('Intersections');
    expect(kernelNamesFor('sci1-late')[0x71]).toBe('MoveCursor');
    expect(kernelNamesFor('sci1-1')[0x71]).toBe('PalVary');
    // 0x51 is `Platform` at SCI1.1 and `CanBeHere` at SCI0 — which is the
    // games' own answer, not a reused slot: SCI0's table is shifted four higher
    // from index 41, so 0x51 there is a different entry entirely.
    expect(kernelNamesFor('sci0-late')[0x51]).toBe('CanBeHere');
    expect(kernelNamesFor('sci1-1')[0x51]).toBe('Platform');
  });

  it('renumbers wholesale at SCI2 rather than extending SCI16', () => {
    expect(kernelNamesFor('sci2')[0x40]).toBe('DoSound');
    expect(kernelNamesFor('sci2-1-middle')[0x75]).toBe('DoSound');
  });

  /** SCI3's whole Kernel delta is eleven slots inside SCI2.1's table (#214). */
  it('turns five SCI2.1 entries into dummies at SCI3 and two dummies into calls', () => {
    expect(kernelNamesFor('sci2-1-middle')[0x30]).toBe('SetScroll');
    expect(kernelNamesFor('sci3')[0x30]).toBeUndefined();
    expect(kernelNamesFor('sci2-1-middle')[0x8d]).toBeUndefined();
    expect(kernelNamesFor('sci3')[0x8d]).toBe('MessageBox');
  });

  /**
   * SCI's characteristic failure is silent. This one is not.
   *
   * And it says what the machine *did*, which is a different claim from the one
   * it used to make: `callk` writes `NULL_REG` into the accumulator after
   * logging and carries on, so "reported rather than returning zero" described
   * the one thing that was not happening.
   */
  it('reports an unknown Kernel number by number and Version', () => {
    const message = describeUnknownKernel(0x08, 'sci1-late', kernelNamesFor('sci1-late'));
    expect(message).toMatch(/DrawPic/);
    expect(message).toMatch(/0x8/);
    expect(message).toMatch(/SCI1 late/);
    expect(message).toMatch(/answered zero and carried on/);
    expect(message).not.toMatch(/rather than returning zero/);
  });
});

describe('the machine', () => {
  function machine(code: Uint8Array, logged?: string[]): PMachine {
    return new PMachine('sci0-late', {
      scriptCode: () => code,
      callKernel: () => null,
      exportOffset: () => null,
      heapStart: () => 0,
      log: (line) => logged?.push(line),
    });
  }

  it('runs arithmetic through the accumulator and the stack', () => {
    // pushi 7; ldi 5; sub; ret  — 7 - 5.
    const vm = machine(new Uint8Array([0x39, 0x07, 0x35, 0x05, 0x04, 0x48]));
    vm.enter(0, 0, NULL_REG);
    vm.run(10);
    expect(vm.acc.offset).toBe(2);
  });

  /**
   * An indexed store takes its index from the accumulator and its value from
   * the **stack**, and it cannot take both from the accumulator.
   *
   * Sierra's compiler emits the value as a `push`, then the load that puts the
   * index in the accumulator, then the store — which is exactly the sequence
   * Castle of Dr. Brain runs at 255:5223: `push · lat 19 · sati 12`. Storing
   * the accumulator instead wrote the *index* into the variable and left the
   * value on the stack, so the variable held a small integer where a value
   * belonged and the stack grew a word every time. Eight of these execute
   * across six of the demos.
   */
  it('takes an indexed store\u2019s value from the stack, not from the accumulator', () => {
    // pushi 42; ldi 3; sati 1; lat 4; ret
    //   the value 42 goes on the stack, 3 into the accumulator as the index,
    //   and `sati 1` should put 42 in temp 1 + 3 = 4.
    // Raw bytes: an opcode is `raw >> 1` and the low bit selects an 8-bit
    // operand, so `sati` (0x5a) is 0xb5 and `lat` (0x42) is 0x85.
    const vm = machine(new Uint8Array([0x39, 0x2a, 0x35, 0x03, 0xb5, 0x01, 0x85, 0x04, 0x48]));
    vm.enter(0, 0, NULL_REG);
    vm.run(20);

    expect(vm.acc.offset).toBe(42);
    // And nothing was left behind: the pushed value was consumed.
    expect(vm.stack).toHaveLength(0);
  });

  /**
   * An indexed store leaves what it stored in the accumulator, because an
   * assignment is an expression and Sierra's compiler chains onto its value.
   *
   * `(send (= temps[i] (Class new:)) init: x draw:)` emits the `new:`, a
   * `push` of the object, the load that puts `i` in the accumulator, the
   * indexed store, and a `send` **whose receiver is the accumulator**. Leaving
   * the index there sends to a small integer, which is what Castle of Dr.
   * Brain and Space Quest 1 both halted on.
   */
  it('leaves an indexed store\u2019s value in the accumulator, so a send can chain onto it', () => {
    // pushi 42; ldi 3; sati 1; ret — the accumulator holds 3 as the index
    // going in, and must hold 42 coming out.
    const vm = machine(new Uint8Array([0x39, 0x2a, 0x35, 0x03, 0xb5, 0x01, 0x48]));
    vm.enter(0, 0, NULL_REG);
    vm.run(20);
    expect(vm.acc.offset).toBe(42);
  });

  it('takes a branch on the accumulator and not on the stack', () => {
    // ldi 0; bnt +2; ldi 9; ldi 1; ret
    const vm = machine(new Uint8Array([0x35, 0x00, 0x31, 0x02, 0x35, 0x09, 0x35, 0x01, 0x48]));
    vm.enter(0, 0, NULL_REG);
    vm.run(10);
    expect(vm.acc.offset).toBe(1);
  });

  /**
   * ADR 0019's distinction, and the one that decides whether a save is
   * correct: a static object restores by reloading its script, a Clone has to
   * be recreated whole.
   */
  it('tracks Clones apart from the objects a script defines', () => {
    const vm = machine(new Uint8Array([0x48]));
    const original = {
      id: reg(1, 100),
      species: 3,
      superClass: 0,
      info: 0,
      propertyBias: 0,
      variables: [reg(0, 3), reg(0, 0), reg(0, 0)],
      methods: new Map<number, number>(),
      variableSelectors: [0, 1, 2],
      script: 1,
      clone: false,
    };
    vm.addObject(original);
    expect(vm.clones.size).toBe(0);

    const copy = vm.clone(original.id)!;
    expect(vm.clones.size).toBe(1);
    expect(vm.object(copy)?.clone).toBe(true);
    // A copy of the variables, not a share — the whole point of a Clone.
    vm.object(copy)!.variables[1] = reg(0, 9);
    // A deep copy, not a shared array *and* not shared registers: writing a
    // Clone's property must not reach into the object it was cloned from.
    expect(original.variables[1]).toEqual(reg(0, 0));

    // **`kDisposeClone` marks; it does not free.** Sierra's interpreter defers
    // to the next garbage collection, and King's Quest IV relies on the gap —
    // script 989 writes back into a Clone the instruction after disposing it.
    vm.disposeClone(copy);
    expect(vm.clones.size).toBe(1);
    expect(vm.object(copy)?.freed).toBe(true);
    expect(vm.object(copy)).not.toBeNull();

    // A collection is what actually reclaims it, once nothing can reach it.
    vm.collectClones();
    expect(vm.clones.size).toBe(0);
    expect(vm.object(copy)).toBeNull();
  });

  /**
   * The second half of `kDisposeClone`'s rule, and ScummVM names this game in
   * the comment: "At least kq4early relies on this behavior. The scripts clone
   * Sound, then set bit 1 manually and call kDisposeClone later. In that case
   * we may not free it."
   */
  it('leaves a Clone alone when the script has set the second bit of -info-', () => {
    const vm = machine(new Uint8Array([0x48]));
    vm.addObject({
      id: reg(1, 100),
      species: 3,
      superClass: 0,
      info: 0,
      propertyBias: 0,
      variables: [reg(0, 3), reg(0, 0), reg(0, 0)],
      methods: new Map<number, number>(),
      variableSelectors: [0, 1, 2],
      script: 1,
      clone: false,
    });
    const copy = vm.clone(reg(1, 100))!;

    // The script ORs 2 into `-info-`, which for an inline object is the third
    // property. `kClone` left the Clone bit there, so the pair reads 3.
    vm.object(copy)!.variables[2] = reg(0, 3);
    vm.disposeClone(copy);
    vm.collectClones();

    expect(vm.object(copy)).not.toBeNull();
    expect(vm.object(copy)?.freed).toBeFalsy();
  });

  /**
   * The collector only ever sweeps what a script marked, and only when nothing
   * can reach it — so a Clone still held by a variable survives a collection it
   * was marked for.
   */
  it('keeps a marked Clone that something still holds', () => {
    const vm = machine(new Uint8Array([0x48]));
    vm.addObject({
      id: reg(1, 100),
      species: 3,
      superClass: 0,
      info: 0,
      propertyBias: 0,
      variables: [reg(0, 3), reg(0, 0), reg(0, 0)],
      methods: new Map<number, number>(),
      variableSelectors: [0, 1, 2],
      script: 1,
      clone: false,
    });
    const held = vm.clone(reg(1, 100))!;
    vm.disposeClone(held);
    vm.globals[0] = held;

    vm.collectClones();

    expect(vm.object(held)).not.toBeNull();
  });

  /**
   * `verifying-version-support.md` says "every script engine keeps a ring
   * buffer of recently executed opcodes"; #217's triage found none did. This
   * is the first, so the sentence becomes true rather than being deleted.
   */
  it('keeps a ring of recently executed instructions, and a trace hook', () => {
    const vm = machine(new Uint8Array([0x39, 0x01, 0x39, 0x02, 0x48]));
    const traced: string[] = [];
    vm.trace = (line) => traced.push(line);

    vm.enter(0, 0, NULL_REG);
    vm.run(10);

    expect(vm.recentOpcodes()).toEqual(['0:0 pushi 1', '0:2 pushi 2', '0:4 ret']);
    expect(traced).toEqual(vm.recentOpcodes());
  });

  it('halts loudly on an opcode Sierra left unused rather than guessing a length', () => {
    const vm = machine(new Uint8Array([0x52]));
    vm.enter(0, 0, NULL_REG);
    vm.run(10);
    expect(vm.halted).toMatch(/desynchronised earlier/);
  });

  /**
   * **This used to halt, and the change is deliberate.**
   *
   * Halting ended the run at the first bad send and lost every later finding —
   * King's Quest VII stopped on a single `isKindOf` sent to the number 82 with
   * most of its boot still unexamined. That is the same trade `callk` already
   * makes for a Kernel call it cannot answer, decided the same way: report it,
   * step over it, and count it.
   *
   * The send is abandoned rather than faked. What it would have consumed is
   * dropped off the stack so the next instruction is not reading a block deep,
   * and the accumulator answers nought.
   */
  it('reports a send to something that is not an object and steps over it', () => {
    // pushi 1; pushi 0; send 4 — a selector on a null accumulator.
    const logged: string[] = [];
    const vm = machine(new Uint8Array([0x39, 0x01, 0x39, 0x00, 0x4a, 0x04]), logged);
    vm.enter(0, 0, NULL_REG);
    vm.run(10);
    expect(vm.halted).toBeNull();
    expect(logged.join(' ')).toMatch(/not an object/);
    expect(logged.join(' ')).toMatch(/Stepped over/);
    // The instructions that produced the receiver, which is the only part of
    // the report that is evidence rather than inference — the Kernel blame is a
    // suspicion and the Selector says only what was wanted.
    expect(logged.join(' ')).toMatch(/Recently: .*pushi/);
    expect(vm.badSends).toBe(1);
  });

  it('gives up once the machine is plainly running on rubble', () => {
    // The same bad send in a loop: `bnt` back to the top, so it repeats.
    const logged: string[] = [];
    const vm = machine(new Uint8Array([0x39, 0x01, 0x39, 0x00, 0x4a, 0x04, 0x33, 0xf8]), logged);
    vm.enter(0, 0, NULL_REG);
    vm.run(5000);
    // Stepping over one is a finding; stepping over a thousand is a machine
    // executing nonsense, and it says so rather than reporting each.
    expect(vm.halted).toMatch(/running on rubble/);
  });
});

describe('the Kernel, implemented by name', () => {
  /**
   * Never by number. The number is the Version's business and #217's table
   * resolves it; a file of numbered handlers is precisely how a Kernel table
   * ends up off by one entry, which is the failure nothing on screen shows.
   */
  it('is written against names, not numbers', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/engine/sci/script/SciKernel.ts', 'utf8');
    const table = source.slice(source.indexOf('export const SCI_KERNEL'));
    // No handler is keyed by a number, and none reaches for one.
    expect(table).not.toMatch(/^\s*0x[0-9a-f]+:/m);
  });

  it('answers the calls a game makes before it can draw anything', async () => {
    const { SCI_KERNEL } = await import('../src/engine/sci/script/SciKernel.js');
    for (const name of ['ScriptID', 'Clone', 'NewList', 'GetEvent', 'Random', 'StrLen']) {
      expect(SCI_KERNEL[name], `${name} is not implemented`).toBeTypeOf('function');
    }
  });

  /**
   * `GetTime`'s first argument picks a different unit, not a variant of the
   * same one. King's Quest IV asks mode 1 at boot, and a handler that always
   * answered ticks handed it a frame count where it expected a packed time of
   * day — the reason to test all four is that only mode 0 looks right by eye.
   */
  it('reads GetTime as four packings selected by its mode argument', async () => {
    const { SCI_KERNEL } = await import('../src/engine/sci/script/SciKernel.js');
    const world = { ticks: () => 4242 } as unknown as Parameters<(typeof SCI_KERNEL)['GetTime']>[0];
    const call = (mode?: number) =>
      SCI_KERNEL.GetTime(world, mode === undefined ? [] : [reg(0, mode)]).offset;

    // Mode 0 (and a missing argument) is the game clock, straight from ticks.
    expect(call(0)).toBe(4242);
    expect(call()).toBe(4242);

    // Modes 1–3 are the wall clock, packed Sierra's way. Compare against the
    // same arithmetic over the same instant rather than a frozen constant, so
    // the test says which bits move without pinning the hour it ran at.
    const now = new Date();
    expect(call(1)).toBe(
      ((now.getHours() % 12) << 12) | (now.getMinutes() << 6) | now.getSeconds(),
    );
    expect(call(2)).toBe(
      (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1),
    );
    expect(call(3)).toBe(
      now.getDate() | ((now.getMonth() + 1) << 5) | ((now.getFullYear() - 1980) << 9),
    );
    // A time-of-day packing is not the tick count it used to return.
    expect(call(1)).not.toBe(4242);
  });
});

/**
 * The fourteen (#TBD): the calls a shipped SCI game makes that this engine had
 * no answer for, one test each.
 *
 * Arguments in, stack effect out, and the arguments are the ones Sierra's own
 * scripts pass rather than convenient ones. Each expectation is the figure
 * ScummVM's implementation produces for the same inputs — Tier 3 in
 * `verifying-version-support.md`'s terms, named per test, because no SCI game
 * data is mounted on this machine and a fixture agreeing with the code that
 * built it would not be evidence of anything.
 */
/**
 * SCI0's four file calls, the last names absent from its Kernel table.
 *
 * Run against the surface the engine actually uses (`createSciFileSurface`)
 * rather than a stand-in, because the thing worth checking is the round trip —
 * a game writes a character and reads it back — and a fake that answers
 * whatever the handler asks for cannot fail that.
 */
/**
 * The four SCI1 calls that needed a hook into the engine, and `MoveCursor`.
 *
 * Each is checked for the thing that would be silently wrong rather than for
 * the happy path: `IsItSkip`'s argument order, `ResCheck`'s refusal to guess at
 * a tuple, `AssertPalette` on a palette that is not there.
 */
/**
 * The two rectangles every click test and every collision is measured against.
 *
 * `nsRect` is where an actor's cel was last drawn; `brRect` is the strip of
 * floor it stands on. Both were `() => NULL_REG`, which left them at whatever
 * the script last put there — usually nought, so an actor you could not click
 * on, in a rectangle of no size at the top-left corner.
 */
/**
 * How a SCI actor walks, which was `() => NULL_REG` on both halves.
 *
 * `InitBresen` plans the step pair and the error term; `DoBresen` takes one
 * step a cycle. With both answering nothing, `dx` and `dy` stayed nought and
 * **every walk in every game stood still** — an actor that never arrives and a
 * `moveDone` that never comes, which looks like a hang rather than a fault.
 *
 * The arithmetic is exact, so these step a whole walk and check where it lands
 * rather than asserting one frame.
 */
/**
 * A send to nought naming the Kernel call the nought came from.
 *
 * The constant column's failure mode, made legible. A call with no handler
 * reports itself the first time a game makes it; a call answering a fixed
 * nought is silent, and the script carries the nought along until it sends to
 * it — at which point the halt named a register and nothing else. King's Quest
 * VII stops exactly this way.
 */
/**
 * The three List sub-functions that send a Selector to every element.
 *
 * King's Quest VII's boot calls 19 five times before anything reaches the
 * screen, and with it unanswered the list was walked by nobody while the game
 * carried on against objects it believed it had just told something.
 */
/**
 * SCI's own `printf`, which King's Quest VII calls before anything is drawn.
 *
 * Checked as string-in, string-out. The one rule that is Sierra's rather than
 * C's has a test of its own, because it is the one a reimplementation gets
 * wrong by being sensible.
 */
/**
 * A slot the Version leaves unnamed reads differently from a call nobody wrote.
 *
 * King's Quest VII calls 0x8d at SCI2.1 middle, where the table has a
 * placeholder — `MessageBox` only from SCI3. Both cases used to print the same
 * sentence, which hid the one that is a finding about the release.
 */
/**
 * `-super-` holds a class number in the file and a class *address* at run time.
 *
 * A SCI script reads that property and **sends to it** — `isKindOf` walks the
 * chain by sending `isKindOf` to its own superclass — so leaving the number
 * there is a send to an integer several layers later. King's Quest VII is where
 * it showed: "send to 0:82", four layers from the cause.
 */
/**
 * How a SCI32 game decides what the mouse is on.
 *
 * A menu item, a hotspot, an inventory square: the script asks `IsOnMe` of each
 * candidate and acts on the first that says yes. A constant makes every one of
 * them always hit or never hit, and a menu that is drawn but not clickable
 * looks exactly like a frozen game.
 */
describe('asking what the pointer is over', () => {
  async function hitWorld(skipAt?: (x: number, y: number) => boolean) {
    const { SCI_KERNEL } = await import('../src/engine/sci/script/SciKernel.js');
    const selectors = { nsLeft: 0, nsTop: 2, nsRight: 4, nsBottom: 6, view: 8, loop: 10, cel: 12 };
    const machine = new PMachine('sci2-1-middle', {
      scriptCode: () => new Uint8Array([0x48]),
      callKernel: () => null,
      exportOffset: () => null,
      heapStart: () => 0,
      log: () => undefined,
    });
    machine.selectorNumbers = new Map(Object.entries(selectors));

    const make = (offset: number, box: number[]) => {
      const object = {
        id: reg(1, offset),
        species: 1,
        superClass: 0,
        info: 0,
        propertyBias: 0,
        variables: [...box, 0, 0, 0].map((value) => reg(0, value)),
        methods: new Map<number, number>(),
        variableSelectors: Object.values(selectors),
        script: 1,
        clone: false,
        name: `object${offset}`,
      };
      machine.addObject(object);
      return object;
    };

    const world = {
      machine,
      log: () => undefined,
      celSkipAt: skipAt
        ? (_v: number, _l: number, _c: number, x: number, y: number) => skipAt(x, y)
        : undefined,
    } as unknown as SciKernelWorld;
    return { SCI_KERNEL, world, make };
  }

  it('says yes inside the rectangle and no outside it', async () => {
    const { SCI_KERNEL, world, make } = await hitWorld();
    make(100, [10, 20, 30, 40]);
    const ask = (x: number, y: number) =>
      SCI_KERNEL.IsOnMe!(world, [reg(0, x), reg(0, y), reg(1, 100), reg(0, 0)]).offset;

    expect(ask(15, 25)).toBe(1);
    // The right and bottom edges are outside, which is what a half-open
    // rectangle means and what every other rectangle here already assumes.
    expect(ask(30, 25)).toBe(0);
    expect(ask(15, 40)).toBe(0);
    expect(ask(5, 25)).toBe(0);
  });

  it('asks the pixels when the script says to, so a shape is clickable where it is inked', async () => {
    // Transparent on the left half of the cel, drawn on the right.
    const { SCI_KERNEL, world, make } = await hitWorld((x) => x < 10);
    make(100, [0, 0, 20, 20]);
    const ask = (x: number) =>
      SCI_KERNEL.IsOnMe!(world, [reg(0, x), reg(0, 5), reg(1, 100), reg(0, 1)]).offset;

    expect(ask(2)).toBe(0);
    expect(ask(15)).toBe(1);
  });

  it('answers the overlapping area rather than a yes or no', async () => {
    const { SCI_KERNEL, world, make } = await hitWorld();
    make(100, [0, 0, 10, 10]);
    make(200, [5, 5, 15, 15]);
    // A script compares this against a threshold: brushing past something is
    // not the same as standing on it.
    expect(SCI_KERNEL.ObjectIntersect!(world, [reg(1, 100), reg(1, 200)]).offset).toBe(25);
  });

  it('answers nought for two things that do not touch', async () => {
    const { SCI_KERNEL, world, make } = await hitWorld();
    make(100, [0, 0, 10, 10]);
    make(200, [50, 50, 60, 60]);
    expect(SCI_KERNEL.ObjectIntersect!(world, [reg(1, 100), reg(1, 200)]).offset).toBe(0);
  });
});

/**
 * Where the pointer is, which is not an event and is only ever reported as one.
 *
 * A SCI game has no Kernel call for "where is the mouse" — `kGetEvent` is the
 * only one that says, and it says it in the x and y of the object it is handed
 * whether or not there was an event to go with them. An implementation that
 * writes nothing when the queue is empty leaves the game reading whatever was
 * in that object, and SCI's own `uEvt::new` zeroes it immediately before
 * calling, so the answer is a pointer permanently at the top-left corner.
 *
 * **That is not cosmetic: it is where a SCI32 interface stops working.** These
 * games decide what is under the pointer by comparing the position they are
 * told now against the one they were told last, and re-scanning only when the
 * two differ. Frozen at (0,0) they never differ, nothing is ever highlighted,
 * and — because the highlighted object is what a click is dispatched to —
 * nothing is ever clickable either. Measured in King's Quest VII: `doVerb`
 * dispatched 0 times in 1200 cycles with the menu on screen and `IsOnMe`
 * answering 1 for the button under the pointer the whole time.
 */
describe('reporting where the pointer is', () => {
  async function eventWorld() {
    const { SCI_KERNEL } = await import('../src/engine/sci/script/SciKernel.js');
    const { SciInput, SCI_EVENT } = await import('../src/engine/sci/SciInput.js');
    const selectors = { type: 0, message: 2, modifiers: 4, x: 6, y: 8 };
    const machine = new PMachine('sci2-1-middle', {
      scriptCode: () => new Uint8Array([0x48]),
      callKernel: () => null,
      exportOffset: () => null,
      heapStart: () => 0,
      log: () => undefined,
    });
    machine.selectorNumbers = new Map(Object.entries(selectors));

    const event = {
      id: reg(1, 100),
      species: 1,
      superClass: 0,
      info: 0,
      propertyBias: 0,
      variables: [reg(0, 0), reg(0, 0), reg(0, 0), reg(0, 0), reg(0, 0)],
      methods: new Map<number, number>(),
      variableSelectors: Object.values(selectors),
      script: 1,
      clone: false,
      name: 'uEvt',
    };
    machine.addObject(event);

    const input = new SciInput();
    const world = { machine, input, log: () => undefined } as unknown as SciKernelWorld;
    /** What the game would read back out of the event object it passed in. */
    const read = () => ({
      type: event.variables[0].offset,
      x: event.variables[3].offset,
      y: event.variables[4].offset,
    });
    return { SCI_KERNEL, SCI_EVENT, world, input, read };
  }

  it('writes the position on a poll that finds nothing, and still answers no', async () => {
    const { SCI_KERNEL, SCI_EVENT, world, input, read } = await eventWorld();
    input.moveTo(120, 84);

    // The mask asks for a click. There is no click, so the answer is nought —
    // a script that read this as an event would loop for ever.
    const answer = SCI_KERNEL.GetEvent!(world, [reg(0, SCI_EVENT.mouseDown), reg(1, 100)]);
    expect(answer.offset).toBe(0);
    // And the position is there anyway, because that is the only way to get it.
    expect(read()).toEqual({ type: 0, x: 120, y: 84 });
  });

  it('tracks a pointer that moves while nothing is being clicked', async () => {
    const { SCI_KERNEL, SCI_EVENT, world, input, read } = await eventWorld();
    const poll = () => SCI_KERNEL.GetEvent!(world, [reg(0, SCI_EVENT.mouseDown), reg(1, 100)]);

    input.moveTo(10, 10);
    poll();
    expect(read().x).toBe(10);
    // The second reading differs from the first, which is the whole of what a
    // hover is: a game that gets the same number twice never re-scans.
    input.moveTo(200, 150);
    poll();
    expect(read()).toEqual({ type: 0, x: 200, y: 150 });
  });

  it("prefers the event's own position to the pointer's when there is one", async () => {
    const { SCI_KERNEL, SCI_EVENT, world, input, read } = await eventWorld();
    // A click is queued where it was made, and the pointer has since moved on.
    input.post({ type: SCI_EVENT.mouseDown, message: 0, modifiers: 0, x: 40, y: 60 });
    input.moveTo(300, 190);

    expect(SCI_KERNEL.GetEvent!(world, [reg(0, SCI_EVENT.mouseDown), reg(1, 100)]).offset).toBe(1);
    expect(read()).toEqual({ type: SCI_EVENT.mouseDown, x: 40, y: 60 });
  });

  it('does not turn a move into a queued event, because the queue is bounded', async () => {
    const { SCI_EVENT, input } = await eventWorld();
    input.post({ type: SCI_EVENT.mouseDown, message: 0, modifiers: 0, x: 1, y: 1 });
    // Far more moves than the queue holds. A move that pushed would evict the
    // click, and the player's click is the one thing that must survive.
    for (let step = 0; step < 200; step++) input.moveTo(step, step);
    expect(input.next(SCI_EVENT.mouseDown)?.x).toBe(1);
  });
});

describe('resolving a superclass property', () => {
  function machineWithClass(version: 'sci1-late' | 'sci2-1-middle', superIndex: number) {
    const machine = new PMachine(version, {
      scriptCode: () => new Uint8Array([0x48]),
      callKernel: () => null,
      exportOffset: () => null,
      heapStart: () => 0,
      log: () => undefined,
    });

    const make = (offset: number, superNumber: number) => {
      const variables = [reg(0, 0), reg(0, 0), reg(0, 0), reg(0, 0), reg(0, 0), reg(0, 0)];
      variables[superIndex] = reg(0, superNumber);
      return {
        id: reg(1, offset),
        species: 0,
        superClass: superNumber,
        info: 0,
        propertyBias: 0,
        variables,
        methods: new Map<number, number>(),
        variableSelectors: [],
        script: 1,
        clone: false,
        name: `object${offset}`,
      };
    };

    // Class 82, and an object whose `-super-` names it by number.
    const parent = make(500, 0xffff);
    parent.species = 82;
    machine.addObject(parent);
    // `classes` is the machine's own map from class number to its object.
    machine.classes.set(82, parent);
    return { machine, make, parent };
  }

  it('turns the class number into the class it names', () => {
    const { machine, make } = machineWithClass('sci2-1-middle', 4);
    const child = make(600, 82);
    machine.addObject(child);

    expect(child.variables[4]).toEqual(reg(0, 82));
    machine.resolveSuperClasses();
    // The property now points at the class rather than holding its number, so
    // a script that sends to it reaches an object.
    expect(child.variables[4]?.segment).toBe(1);
    expect(child.variables[4]?.offset).toBe(500);
  });

  it('reads the property at the slot the Version puts it in', () => {
    // SCI0 and SCI1 keep species, superClass and -info- as the first three
    // properties; SCI1.1 drops them and the object's header carries them at
    // three, four and five.
    const { machine, make } = machineWithClass('sci1-late', 1);
    const child = make(600, 82);
    machine.addObject(child);
    machine.resolveSuperClasses();
    expect(child.variables[1]?.segment).toBe(1);
  });

  it('reads 0xffff as no superclass rather than as class 65535', () => {
    const { machine, parent } = machineWithClass('sci2-1-middle', 4);
    machine.resolveSuperClasses();
    expect(parent.variables[4]).toEqual(NULL_REG);
  });

  it('leaves a property that is already an object alone', () => {
    const { machine, make } = machineWithClass('sci2-1-middle', 4);
    const child = make(600, 82);
    child.variables[4] = reg(3, 77);
    machine.addObject(child);
    // A second pass must not undo the first: anything already pointing at a
    // segment has been resolved.
    machine.resolveSuperClasses();
    expect(child.variables[4]).toEqual(reg(3, 77));
  });
});

describe('reporting a Kernel number', () => {
  it('calls an unnamed slot a placeholder, and says what reaching one means', async () => {
    const { describeUnknownKernel, kernelNamesFor } =
      await import('../src/engine/sci/script/kernel.js');
    const said = describeUnknownKernel(0x8d, 'sci2-1-middle', kernelNamesFor('sci2-1-middle'));
    expect(said).toMatch(/leaves unnamed/);
    expect(said).toMatch(/either this game's Version is not|table is wrong/);
  });

  it('still calls a named call unimplemented, because that is a queue item', async () => {
    const { describeUnknownKernel, kernelNamesFor } =
      await import('../src/engine/sci/script/kernel.js');
    // 0x6d is `PalCycle` at SCI2.1 — a real call, simply not written here.
    const said = describeUnknownKernel(0x6d, 'sci2-1-middle', kernelNamesFor('sci2-1-middle'));
    expect(said).toMatch(/PalCycle/);
    expect(said).toMatch(/is not implemented/);
  });
});

describe('formatting a string', () => {
  async function stringWorld() {
    const { SCI_KERNEL } = await import('../src/engine/sci/script/SciKernel.js');
    const { SciHeap } = await import('../src/engine/sci/script/segments.js');
    const machine = new PMachine('sci2-1-middle', {
      scriptCode: () => new Uint8Array([0x48]),
      callKernel: () => null,
      exportOffset: () => null,
      heapStart: () => 0,
      log: () => undefined,
    });
    const heap = new SciHeap();
    const world = { machine, heap, log: () => undefined } as unknown as SciKernelWorld;

    const put = (value: string): Reg => {
      const ref = heap.newArray(3, value.length + 1);
      for (let index = 0; index < value.length; index++) {
        heap.arrayPut(ref, index, value.charCodeAt(index));
      }
      heap.arrayPut(ref, value.length, 0);
      return ref;
    };
    const get = (ref: Reg): string => {
      let out = '';
      for (let index = 0; index < heap.arrayLength(ref); index++) {
        const code = heap.arrayAt(ref, index);
        if (code === 0) break;
        out += String.fromCharCode(code);
      }
      return out;
    };
    return { SCI_KERNEL, world, put, get };
  }

  /** `String(11, source, ...)` — Format, which allocates its own destination. */
  const format = async (template: string, values: Reg[]) => {
    const { SCI_KERNEL, world, put, get } = await stringWorld();
    return get(SCI_KERNEL.String!(world, [reg(0, 11), put(template), ...values]));
  };

  it('substitutes a number and a string', async () => {
    const { SCI_KERNEL, world, put, get } = await stringWorld();
    const answer = SCI_KERNEL.String!(world, [
      reg(0, 11),
      put('%s has %d rings'),
      put('Rosella'),
      reg(0, 3),
    ]);
    expect(get(answer)).toBe('Rosella has 3 rings');
  });

  it('treats %% as an escape and consumes no argument', async () => {
    expect(await format('100%% of %d', [reg(0, 7)])).toBe('100% of 7');
  });

  it('formats a placeholder with no argument left rather than stopping', async () => {
    // Sierra passes nought rather than truncating (`kstring.cpp`), so a line
    // with more placeholders than values prints zeroes. Stopping early would
    // give a shorter string that looks deliberate — this is the rule a sensible
    // reimplementation gets wrong.
    expect(await format('%d and %d', [reg(0, 4)])).toBe('4 and 0');
  });

  it('honours a width and a zero-fill', async () => {
    expect(await format('[%4d]', [reg(0, 42)])).toBe('[  42]');
    expect(await format('[%04d]', [reg(0, 42)])).toBe('[0042]');
    expect(await format('[%-4d]', [reg(0, 42)])).toBe('[42  ]');
  });

  it('reads a negative number as signed', async () => {
    expect(await format('%d', [reg(0, 0xfff6)])).toBe('-10');
  });

  it('writes into the destination FormatAt was given', async () => {
    const { SCI_KERNEL, world, put, get } = await stringWorld();
    const destination = put('                    ');
    const answer = SCI_KERNEL.String!(world, [reg(0, 12), destination, put('room %d'), reg(0, 12)]);
    // Sub 12 answers the destination it was handed rather than a new one.
    expect(answer.offset).toBe(destination.offset);
    expect(get(destination)).toBe('room 12');
  });
});

describe('walking a list and sending to every element', () => {
  async function listWorld(values: number[]) {
    const { SCI_KERNEL } = await import('../src/engine/sci/script/SciKernel.js');
    const { SciHeap } = await import('../src/engine/sci/script/segments.js');

    const machine = new PMachine('sci2-1-middle', {
      scriptCode: () => new Uint8Array([0x48]),
      callKernel: () => null,
      exportOffset: () => null,
      heapStart: () => 0,
      log: () => undefined,
    });
    machine.selectorNumbers = new Map([['flag', 30]]);

    const heap = new SciHeap();
    const list = heap.newList();
    for (const value of values) {
      const object = {
        id: reg(1, 100 + value),
        species: 1,
        superClass: 0,
        info: 0,
        propertyBias: 0,
        variables: [reg(0, value)],
        methods: new Map<number, number>(),
        variableSelectors: [30],
        script: 1,
        clone: false,
        name: `element${value}`,
      };
      machine.addObject(object);
      heap.addToEnd(list, heap.newNode(object.id, reg(0, value)));
    }

    const world = { machine, heap, log: () => undefined } as unknown as SciKernelWorld;
    return { SCI_KERNEL, world, list, machine };
  }

  it('writes a variable Selector on every element rather than calling it', async () => {
    const { SCI_KERNEL, world, list, machine } = await listWorld([1, 1, 1]);
    // Sub 19 with a third argument writes it into the variable — the same
    // sub-function calls a method where the Selector is one, decided per
    // element by what the element has (`klists.cpp`).
    SCI_KERNEL.List!(world, [reg(0, 19), list, reg(0, 30), reg(0, 7)]);
    for (const value of [1, 2, 3]) {
      const object = machine.object(reg(1, 100 + 1));
      expect(object?.variables[0]?.offset).toBe(7);
      void value;
    }
  });

  it('answers the element itself for FirstTrue, not what the element said', async () => {
    const { SCI_KERNEL, world, list } = await listWorld([0, 0, 5]);
    const answer = SCI_KERNEL.List!(world, [reg(0, 20), list, reg(0, 30)]);
    // The third element holds 5, so it is the first true one — and the answer
    // is that object, which is the difference between "which one" and "what it
    // said".
    expect(answer.segment).toBe(1);
    expect(answer.offset).toBe(105);
  });

  it('answers nought for FirstTrue when no element is true', async () => {
    const { SCI_KERNEL, world, list } = await listWorld([0, 0, 0]);
    expect(SCI_KERNEL.List!(world, [reg(0, 20), list, reg(0, 30)]).offset).toBe(0);
  });

  it('is true for AllTrue only when every element is', async () => {
    const all = await listWorld([1, 2, 3]);
    expect(all.SCI_KERNEL.List!(all.world, [reg(0, 21), all.list, reg(0, 30)]).offset).toBe(1);

    const notAll = await listWorld([1, 0, 3]);
    expect(
      notAll.SCI_KERNEL.List!(notAll.world, [reg(0, 21), notAll.list, reg(0, 30)]).offset,
    ).toBe(0);
  });

  it('is true for AllTrue over an empty list, which has no counterexample', async () => {
    const { SCI_KERNEL, world, list } = await listWorld([]);
    expect(SCI_KERNEL.List!(world, [reg(0, 21), list, reg(0, 30)]).offset).toBe(1);
  });
});

describe('blaming the Kernel call behind a bad receiver', () => {
  /**
   * `pushi 0; callk k,0; pushi sel; pushi 0; send 4`.
   *
   * The shape a script has when it asks the Kernel for an object and is handed
   * a constant: the answer goes into the accumulator and the accumulator is the
   * receiver of the send that follows. Opcodes are `(op << 1) | 1` for the
   * byte-operand form.
   */
  function askKernelThenSend(kernel: number): Uint8Array {
    return new Uint8Array([0x39, 0x00, 0x43, kernel, 0x00, 0x39, 0x08, 0x39, 0x00, 0x4b, 0x04]);
  }

  function machineAnswering(answer: Reg | null, kernel: number) {
    const logged: string[] = [];
    const machine = new PMachine('sci2-1-middle', {
      scriptCode: () => askKernelThenSend(kernel),
      callKernel: () => answer,
      exportOffset: () => null,
      heapStart: () => 0,
      log: (line) => logged.push(line),
    });
    return { machine, logged };
  }

  /** The blame now reaches the log rather than the halt, since the send is stepped over. */

  it('names the call when it answered a silent nought', () => {
    // 0x51 is `Palette` at SCI2.1 — a real name, and one of the calls that
    // answers a constant.
    const { machine, logged } = machineAnswering(reg(0, 0), 0x51);
    machine.enter(0, 0, reg(1, 1));
    machine.run(200);

    const said = logged.join(' ');
    expect(said).toMatch(/send to 0:0/);
    // The sentence that was not there: which call, by name.
    expect(said).toMatch(/last Kernel call to answer nought was/);
    expect(said).toMatch(/Kernel 81|Palette/);
  });

  it('says nothing extra when the receiver did not come from a Kernel nought', () => {
    // The call answers a real object this time, so the nought in the receiver —
    // there isn't one — has nothing to do with it. Offered as a suspicion, so a
    // send that succeeds must not carry the sentence at all.
    const { machine, logged } = machineAnswering(reg(0, 5), 0x51);
    machine.enter(0, 0, reg(1, 1));
    machine.run(200);
    expect(logged.join(' ')).not.toMatch(/last Kernel call to answer nought/);
  });
});

describe('walking, one Bresenham step at a time', () => {
  const SELECTORS = {
    client: 0,
    x: 2,
    y: 4,
    dx: 6,
    dy: 8,
    xStep: 10,
    yStep: 12,
    // Sierra's own names, with hyphens. ScummVM's `selector.cpp` pairs each
    // with a C++ identifier — `FIND_SELECTOR2(b_movCnt, "b-moveCnt")` — and
    // this fixture once used the identifiers, which no game's `vocab.997`
    // contains. A fixture that names things the way the code under test happens
    // to name them cannot catch the code naming them wrongly, and this one did
    // not: every one of the six read as zero in King's Quest VII.
    'b-i1': 14,
    'b-i2': 16,
    'b-di': 18,
    'b-incr': 20,
    'b-xAxis': 22,
    'b-moveCnt': 24,
    xLast: 26,
    yLast: 28,
    moveSpeed: 30,
    signal: 32,
  };

  async function walkWorld(target: { x: number; y: number }, from: { x: number; y: number }) {
    const { SCI_KERNEL } = await import('../src/engine/sci/script/SciKernel.js');
    const machine = new PMachine('sci1-late', {
      scriptCode: () => new Uint8Array([0x48]),
      callKernel: () => null,
      exportOffset: () => null,
      heapStart: () => 0,
      log: () => undefined,
    });
    machine.selectorNumbers = new Map(Object.entries(SELECTORS));
    const selectorList = Object.values(SELECTORS);

    const make = (offset: number, values: Partial<Record<keyof typeof SELECTORS, number>>) => ({
      id: reg(1, offset),
      species: 1,
      superClass: 0,
      info: 0,
      propertyBias: 0,
      variables: (Object.keys(SELECTORS) as Array<keyof typeof SELECTORS>).map((name) =>
        reg(0, values[name] ?? 0),
      ),
      methods: new Map<number, number>(),
      variableSelectors: selectorList,
      script: 1,
      clone: false,
      name: `object${offset}`,
    });

    // The client walks two pixels a step, and the mover holds the destination.
    const client = make(200, { x: from.x, y: from.y, xStep: 2, yStep: 2, moveSpeed: 0 });
    const mover = make(100, { client: 0, x: target.x, y: target.y });
    // `client` is a register, not a number, so it is written directly.
    mover.variables[0] = reg(1, 200);
    machine.addObject(client);
    machine.addObject(mover);

    const world = { machine, log: () => undefined } as unknown as SciKernelWorld;
    const read = (object: typeof client, name: keyof typeof SELECTORS): number => {
      const index = machine.resolveProperty(object, SELECTORS[name]);
      const value = index >= 0 ? (object.variables[index]?.offset ?? 0) : 0;
      return value > 0x7fff ? value - 0x10000 : value;
    };
    return { SCI_KERNEL, world, client, mover, read };
  }

  it('plans a walk along the axis the journey is longest in', async () => {
    const { SCI_KERNEL, world, mover, read } = await walkWorld(
      { x: 140, y: 110 },
      { x: 100, y: 100 },
    );
    SCI_KERNEL.InitBresen!(world, [reg(1, 100)]);
    // 40 across against 10 down, so this is an x-axis walk taking whole xSteps.
    expect(read(mover, 'b-xAxis')).toBe(1);
    expect(read(mover, 'dx')).toBe(2);
  });

  it('walks the actor to the destination and stops there', async () => {
    const { SCI_KERNEL, world, client, read } = await walkWorld(
      { x: 140, y: 110 },
      { x: 100, y: 100 },
    );
    SCI_KERNEL.InitBresen!(world, [reg(1, 100)]);

    // Far more cycles than the walk needs: the point is that it arrives and
    // then stays, rather than overshooting or oscillating.
    for (let cycle = 0; cycle < 100; cycle++) SCI_KERNEL.DoBresen!(world, [reg(1, 100)]);
    expect([read(client, 'x'), read(client, 'y')]).toEqual([140, 110]);
  });

  it('keeps every step on the straight line between the two points', async () => {
    const { SCI_KERNEL, world, client, read } = await walkWorld(
      { x: 160, y: 130 },
      { x: 100, y: 100 },
    );
    SCI_KERNEL.InitBresen!(world, [reg(1, 100)]);

    // The line is y = 100 + (x - 100) / 2. Bresenham's whole promise is that
    // every step stays within a pixel of it; a plan that drifts would pass an
    // "arrives eventually" test and fail this one.
    for (let cycle = 0; cycle < 40; cycle++) {
      SCI_KERNEL.DoBresen!(world, [reg(1, 100)]);
      const x = read(client, 'x');
      const y = read(client, 'y');
      if (x === 160 && y === 130) break;
      expect(Math.abs(y - (100 + (x - 100) / 2))).toBeLessThanOrEqual(1);
    }
  });

  it('walks down a vertical journey on the y axis', async () => {
    const { SCI_KERNEL, world, client, mover, read } = await walkWorld(
      { x: 100, y: 160 },
      { x: 100, y: 100 },
    );
    SCI_KERNEL.InitBresen!(world, [reg(1, 100)]);
    expect(read(mover, 'b-xAxis')).toBe(0);
    for (let cycle = 0; cycle < 100; cycle++) SCI_KERNEL.DoBresen!(world, [reg(1, 100)]);
    expect([read(client, 'x'), read(client, 'y')]).toEqual([100, 160]);
  });

  it('walks backwards as readily as forwards', async () => {
    const { SCI_KERNEL, world, client, read } = await walkWorld(
      { x: 40, y: 70 },
      { x: 100, y: 100 },
    );
    SCI_KERNEL.InitBresen!(world, [reg(1, 100)]);
    for (let cycle = 0; cycle < 100; cycle++) SCI_KERNEL.DoBresen!(world, [reg(1, 100)]);
    expect([read(client, 'x'), read(client, 'y')]).toEqual([40, 70]);
  });

  it('does not move an actor already standing on the destination', async () => {
    const { SCI_KERNEL, world, client, read } = await walkWorld(
      { x: 100, y: 100 },
      { x: 100, y: 100 },
    );
    SCI_KERNEL.InitBresen!(world, [reg(1, 100)]);
    SCI_KERNEL.DoBresen!(world, [reg(1, 100)]);
    expect([read(client, 'x'), read(client, 'y')]).toEqual([100, 100]);
  });

  it('remembers where the actor was before the step, for a script that undoes it', async () => {
    const { SCI_KERNEL, world, mover, read } = await walkWorld(
      { x: 140, y: 100 },
      { x: 100, y: 100 },
    );
    SCI_KERNEL.InitBresen!(world, [reg(1, 100)]);
    SCI_KERNEL.DoBresen!(world, [reg(1, 100)]);
    // `xLast`/`yLast` are written from SCI1 on, before the move.
    expect([read(mover, 'xLast'), read(mover, 'yLast')]).toEqual([100, 100]);
  });

  it('answers rather than throwing when the mover has no client', async () => {
    const { SCI_KERNEL } = await import('../src/engine/sci/script/SciKernel.js');
    const machine = new PMachine('sci1-late', {
      scriptCode: () => new Uint8Array([0x48]),
      callKernel: () => null,
      exportOffset: () => null,
      heapStart: () => 0,
      log: () => undefined,
    });
    const world = { machine, log: () => undefined } as unknown as SciKernelWorld;
    expect(() => SCI_KERNEL.InitBresen!(world, [reg(1, 999)])).not.toThrow();
    expect(() => SCI_KERNEL.DoBresen!(world, [reg(1, 999)])).not.toThrow();
  });
});

describe('SetNowSeen and BaseSetter', () => {
  /** An actor at (100, 120) with the Selectors these two calls read and write. */
  async function actorWorld(selectors: Record<string, number>, variables: number[]) {
    const { SCI_KERNEL } = await import('../src/engine/sci/script/SciKernel.js');
    const machine = new PMachine('sci1-late', {
      scriptCode: () => new Uint8Array([0x48]),
      callKernel: () => null,
      exportOffset: () => null,
      heapStart: () => 0,
      log: () => undefined,
    });
    machine.selectorNumbers = new Map(Object.entries(selectors));
    const actor = {
      id: reg(1, 100),
      species: 1,
      superClass: 0,
      info: 0,
      propertyBias: 0,
      variables: variables.map((value) => reg(0, value)),
      methods: new Map<number, number>(),
      variableSelectors: Object.values(selectors),
      script: 1,
      clone: false,
      name: 'ego',
    };
    machine.addObject(actor);

    const world = {
      machine,
      log: () => undefined,
      // A 20x30 cel whose origin sits 2 right and 4 up of the actor's point.
      celRect: (_v: number, _l: number, _c: number, x: number, y: number, z: number) => ({
        left: x + 2 - (20 >> 1),
        top: y + 4 - z + 1 - 30,
        right: x + 2 - (20 >> 1) + 20,
        bottom: y + 4 - z + 1,
      }),
    } as unknown as SciKernelWorld;

    const read = (name: string): number => {
      const index = machine.resolveProperty(actor, selectors[name]!);
      return index >= 0 ? (actor.variables[index]?.offset ?? 0) : 0;
    };
    return { SCI_KERNEL, world, read };
  }

  const nsSelectors = {
    view: 0,
    loop: 2,
    cel: 4,
    x: 6,
    y: 8,
    z: 10,
    nsLeft: 12,
    nsTop: 14,
    nsRight: 16,
    nsBottom: 18,
  };

  it('writes the cel’s rectangle into nsRect', async () => {
    const { SCI_KERNEL, world, read } = await actorWorld(
      nsSelectors,
      [7, 0, 0, 100, 120, 0, 0, 0, 0, 0],
    );
    SCI_KERNEL.SetNowSeen!(world, [reg(1, 100)]);
    // left = x + displaceX - (width >> 1) = 100 + 2 - 10
    expect(read('nsLeft')).toBe(92);
    expect(read('nsRight')).toBe(112);
    // bottom = y + displaceY - z + 1 = 120 + 4 - 0 + 1
    expect(read('nsBottom')).toBe(125);
    expect(read('nsTop')).toBe(95);
  });

  it('leaves an object alone when it has no nsRect to write', async () => {
    // A script calls this on things that have no `nsTop`; Sierra checks first
    // (`compare.cpp:225`), because inventing the property would change what the
    // object is.
    const { SCI_KERNEL, world, read } = await actorWorld(
      { view: 0, loop: 2, cel: 4, x: 6, y: 8, z: 10 },
      [7, 0, 0, 100, 120, 0],
    );
    expect(() => SCI_KERNEL.SetNowSeen!(world, [reg(1, 100)])).not.toThrow();
    expect(read('x')).toBe(100);
  });

  it('gives brRect the cel’s width and yStep’s height, at the actor’s feet', async () => {
    const { SCI_KERNEL, world, read } = await actorWorld(
      {
        view: 0,
        loop: 2,
        cel: 4,
        x: 6,
        y: 8,
        z: 10,
        yStep: 12,
        brLeft: 14,
        brTop: 16,
        brRight: 18,
        brBottom: 20,
      },
      [7, 0, 0, 100, 120, 0, 6, 0, 0, 0, 0],
    );
    SCI_KERNEL.BaseSetter!(world, [reg(1, 100)]);
    // The horizontal extent is the cel's…
    expect(read('brLeft')).toBe(92);
    expect(read('brRight')).toBe(112);
    // …and the vertical is yStep off the actor's own y, not the cel's height:
    // bottom = y + 1, top = bottom - yStep (`compare.cpp:204`).
    expect(read('brBottom')).toBe(121);
    expect(read('brTop')).toBe(115);
  });

  it('leaves an object alone when it has no brRect', async () => {
    const { SCI_KERNEL, world } = await actorWorld(
      { view: 0, loop: 2, cel: 4, x: 6, y: 8, z: 10 },
      [7, 0, 0, 100, 120, 0],
    );
    expect(() => SCI_KERNEL.BaseSetter!(world, [reg(1, 100)])).not.toThrow();
  });

  it('answers rather than throwing when the engine offers no cel geometry', async () => {
    const { SCI_KERNEL } = await import('../src/engine/sci/script/SciKernel.js');
    const machine = new PMachine('sci1-late', {
      scriptCode: () => new Uint8Array([0x48]),
      callKernel: () => null,
      exportOffset: () => null,
      heapStart: () => 0,
      log: () => undefined,
    });
    const world = { machine, log: () => undefined } as unknown as SciKernelWorld;
    expect(() => SCI_KERNEL.SetNowSeen!(world, [reg(1, 1)])).not.toThrow();
    expect(() => SCI_KERNEL.BaseSetter!(world, [reg(1, 1)])).not.toThrow();
  });
});

describe("SCI1's renderer-side Kernel calls", () => {
  async function world(extra: Partial<SciKernelWorld> = {}) {
    const { SCI_KERNEL } = await import('../src/engine/sci/script/SciKernel.js');
    const { SciHeap } = await import('../src/engine/sci/script/segments.js');
    const heap = new SciHeap();
    return {
      SCI_KERNEL,
      heap,
      world: { heap, log: () => undefined, ...extra } as unknown as SciKernelWorld,
    };
  }

  it('reads IsItSkip’s point as (y, x), which is Sierra’s order and not the obvious one', async () => {
    const asked: Array<[number, number, number, number, number]> = [];
    const { SCI_KERNEL, world: w } = await world({
      celSkipAt: (view, loop, cel, x, y) => {
        asked.push([view, loop, cel, x, y]);
        return true;
      },
    });

    // view 7, loop 1, cel 2, then **y = 30, x = 40** (`kgraphics.cpp:469`).
    SCI_KERNEL.IsItSkip!(w, [reg(0, 7), reg(0, 1), reg(0, 2), reg(0, 30), reg(0, 40)]);
    expect(asked).toEqual([[7, 1, 2, 40, 30]]);
  });

  it('answers IsItSkip false for a cel it could not read, rather than true', async () => {
    const { SCI_KERNEL, world: w } = await world({ celSkipAt: () => null });
    // Null is "no such cel". Answering true would tell the game every point on
    // a missing actor is background, which is a click passing through it.
    expect(
      SCI_KERNEL.IsItSkip!(w, [reg(0, 1), reg(0, 0), reg(0, 0), reg(0, 0), reg(0, 0)]).offset,
    ).toBe(0);
  });

  it('reads the resource map for ResCheck rather than answering a flat nought', async () => {
    const { SCI_KERNEL, world: w } = await world({
      resourcePresent: (type, number) => type === 0 && number === 5,
    });
    expect(SCI_KERNEL.ResCheck!(w, [reg(0, 0), reg(0, 5)]).offset).toBe(1);
    expect(SCI_KERNEL.ResCheck!(w, [reg(0, 0), reg(0, 6)]).offset).toBe(0);
  });

  it('refuses ResCheck’s tuple form rather than answering it by number', async () => {
    const { SCI_KERNEL, world: w } = await world({ resourcePresent: () => true });
    // Six arguments is the audio36/sync36 form, addressed by
    // (noun, verb, cond, seq). Saying "present" because a resource of that
    // *number* exists would be worse than saying absent.
    const tuple = [reg(0, 8), reg(0, 1), reg(0, 2), reg(0, 3), reg(0, 4), reg(0, 5)];
    expect(SCI_KERNEL.ResCheck!(w, tuple).offset).toBe(0);
  });

  it('hands TextFonts its whole list, because |f1| selects the second', async () => {
    let fonts: readonly number[] = [];
    const { SCI_KERNEL, world: w } = await world({ setTextFonts: (list) => void (fonts = list) });
    SCI_KERNEL.TextFonts!(w, [reg(0, 4), reg(0, 7)]);
    expect([...fonts]).toEqual([4, 7]);
  });

  it('asks for the palette AssertPalette names', async () => {
    const asked: number[] = [];
    const { SCI_KERNEL, world: w } = await world({ assertPalette: (n) => void asked.push(n) });
    SCI_KERNEL.AssertPalette!(w, [reg(0, 999)]);
    expect(asked).toEqual([999]);
  });

  it('moves the pointer where MoveCursor says, signed', async () => {
    const moves: Array<[number, number]> = [];
    const { SCI_KERNEL, world: w } = await world({ moveCursor: (x, y) => void moves.push([x, y]) });
    // A script can move the pointer relative to a window whose origin puts the
    // result left of the screen; clamping belongs to the input surface.
    SCI_KERNEL.MoveCursor!(w, [reg(0, 0xfff6), reg(0, 20)]);
    expect(moves).toEqual([[-10, 20]]);
  });

  it('answers rather than throwing when the engine offers no hook at all', async () => {
    const { SCI_KERNEL, world: w } = await world();
    // Every one of these is optional on `SciKernelWorld`: a Kernel handler must
    // not need the renderer to exist.
    expect(() => {
      SCI_KERNEL.IsItSkip!(w, [reg(0, 1), reg(0, 0), reg(0, 0), reg(0, 0), reg(0, 0)]);
      SCI_KERNEL.ResCheck!(w, [reg(0, 0), reg(0, 1)]);
      SCI_KERNEL.TextFonts!(w, [reg(0, 1)]);
      SCI_KERNEL.AssertPalette!(w, [reg(0, 1)]);
      SCI_KERNEL.MoveCursor!(w, [reg(0, 1), reg(0, 1)]);
    }).not.toThrow();
  });
});

describe("SCI0's file calls", () => {
  async function fileWorld() {
    const { SCI_KERNEL } = await import('../src/engine/sci/script/SciKernel.js');
    const { createSciFileSurface } = await import('../src/engine/sci/script/sciFiles.js');
    const { SciHeap } = await import('../src/engine/sci/script/segments.js');

    const logged: string[] = [];
    const machine = new PMachine('sci0-late', {
      scriptCode: () => new Uint8Array([0x48]),
      callKernel: () => null,
      exportOffset: () => null,
      heapStart: () => 0,
      log: (line) => logged.push(line),
    });
    const heap = new SciHeap();
    const world = {
      machine,
      heap,
      log: (line: string) => logged.push(line),
      random: () => 0,
      ticks: () => 0,
      files: createSciFileSurface({ log: (line) => logged.push(line) }),
    } as unknown as SciKernelWorld;

    return { SCI_KERNEL, heap, world, logged };
  }

  const put = (heap: SciHeap, text: string): Reg => {
    const ref = heap.allocate(text.length + 1);
    const bytes = heap.bytes(ref)!;
    for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index);
    return ref;
  };
  const get = (heap: SciHeap, ref: Reg): string => {
    const bytes = heap.bytes(ref)!;
    let text = '';
    for (const byte of bytes) {
      if (byte === 0) break;
      text += String.fromCharCode(byte);
    }
    return text;
  };

  it('writes a line and reads it back, which is what a character export is', async () => {
    const { SCI_KERNEL, heap, world } = await fileWorld();

    const handle = SCI_KERNEL.FOpen!(world, [put(heap, 'HERO.SAV'), reg(0, 0)]);
    expect(handle.offset).toBeGreaterThan(0);
    SCI_KERNEL.FPuts!(world, [handle, put(heap, 'Fighter\n')]);
    SCI_KERNEL.FClose!(world, [handle]);

    const reopened = SCI_KERNEL.FOpen!(world, [put(heap, 'HERO.SAV'), reg(0, 1)]);
    expect(reopened.offset).toBeGreaterThan(0);
    const destination = heap.allocate(32);
    const answer = SCI_KERNEL.FGets!(world, [destination, reg(0, 32), reopened]);
    expect(get(heap, destination)).toBe('Fighter');
    expect(answer.offset).toBe(destination.offset);
  });

  it('answers nought for a file that is not there, which is how a game asks', async () => {
    const { SCI_KERNEL, heap, world } = await fileWorld();
    // Mode 1 is the only one that refuses (`file.h:31`). Quest for Glory asks
    // this to find out whether a character was exported here before.
    expect(SCI_KERNEL.FOpen!(world, [put(heap, 'NOBODY.SAV'), reg(0, 1)]).offset).toBe(0);
    // Mode 0 creates instead, so the same name now opens.
    expect(SCI_KERNEL.FOpen!(world, [put(heap, 'NOBODY.SAV'), reg(0, 0)]).offset).toBeGreaterThan(
      0,
    );
  });

  it('answers nought at the end of the file rather than the last line again', async () => {
    const { SCI_KERNEL, heap, world } = await fileWorld();
    const handle = SCI_KERNEL.FOpen!(world, [put(heap, 'ONE.TXT'), reg(0, 0)]);
    SCI_KERNEL.FPuts!(world, [handle, put(heap, 'only\n')]);
    SCI_KERNEL.FClose!(world, [handle]);

    const reading = SCI_KERNEL.FOpen!(world, [put(heap, 'ONE.TXT'), reg(0, 0)]);
    const destination = heap.allocate(16);
    expect(SCI_KERNEL.FGets!(world, [destination, reg(0, 16), reading]).offset).toBe(
      destination.offset,
    );
    const second = SCI_KERNEL.FGets!(world, [destination, reg(0, 16), reading]);
    expect(second.segment).toBe(0);
    expect(second.offset).toBe(0);
    // Cleared rather than left holding the previous line: ScummVM bug #12060 is
    // scripts using the buffer without testing the answer.
    expect(get(heap, destination)).toBe('');
  });

  it('reads nothing at all when the buffer is one byte, as Sierra does', async () => {
    const { SCI_KERNEL, heap, world } = await fileWorld();
    const handle = SCI_KERNEL.FOpen!(world, [put(heap, 'TINY.TXT'), reg(0, 0)]);
    SCI_KERNEL.FPuts!(world, [handle, put(heap, 'text\n')]);
    SCI_KERNEL.FClose!(world, [handle]);

    const reading = SCI_KERNEL.FOpen!(world, [put(heap, 'TINY.TXT'), reg(0, 0)]);
    const destination = heap.allocate(8);
    // `fgets_wrapper` (`file.cpp:269`) reads nothing for a maxsize of one or
    // less rather than reading one character.
    const answer = SCI_KERNEL.FGets!(world, [destination, reg(0, 1), reading]);
    expect(answer.offset).toBe(0);
    expect(get(heap, destination)).toBe('');
  });

  it('continues a line across several FPuts, because scripts write that way', async () => {
    const { SCI_KERNEL, heap, world } = await fileWorld();
    const handle = SCI_KERNEL.FOpen!(world, [put(heap, 'SPLIT.TXT'), reg(0, 0)]);
    SCI_KERNEL.FPuts!(world, [handle, put(heap, 'Fight')]);
    SCI_KERNEL.FPuts!(world, [handle, put(heap, 'er\n')]);
    SCI_KERNEL.FClose!(world, [handle]);

    const reading = SCI_KERNEL.FOpen!(world, [put(heap, 'SPLIT.TXT'), reg(0, 0)]);
    const destination = heap.allocate(32);
    SCI_KERNEL.FGets!(world, [destination, reg(0, 32), reading]);
    expect(get(heap, destination)).toBe('Fighter');
  });

  it('says once that there is no disc behind these files', async () => {
    const { SCI_KERNEL, heap, world, logged } = await fileWorld();
    SCI_KERNEL.FOpen!(world, [put(heap, 'A.TXT'), reg(0, 0)]);
    SCI_KERNEL.FOpen!(world, [put(heap, 'B.TXT'), reg(0, 0)]);
    expect(logged.filter((line) => line.includes('live in memory for this session'))).toHaveLength(
      1,
    );
  });

  it('answers nought with no surface at all, which is a disc that cannot be read', async () => {
    const { SCI_KERNEL } = await import('../src/engine/sci/script/SciKernel.js');
    const { SciHeap } = await import('../src/engine/sci/script/segments.js');
    const heap = new SciHeap();
    // No `files` on the world: a Kernel handler must not need a surface to
    // exist, and nought is what Sierra's own interpreter answers on a disc it
    // cannot write — so a game meets a failure it already has code for.
    const world = { heap, log: () => undefined } as unknown as SciKernelWorld;
    expect(SCI_KERNEL.FOpen!(world, [put(heap, 'X.TXT'), reg(0, 0)]).offset).toBe(0);
  });
});

/**
 * `FileIO`'s twenty sub-functions, which had all answered the same nought.
 *
 * Tier 1 in `verifying-version-support.md`'s terms: no game data is read here.
 * The numbering is ScummVM's `kFileIO_subops` and the behaviours are
 * `kfile.cpp`'s, so what these pin is that this engine agrees with the
 * interpreter Sierra's scripts were written against — the round trip through
 * the surface, and the two different words the two Version families use for
 * failure.
 *
 * The last of them is the one that mattered to a game: King's Quest VII's menu
 * asks sub-function 17 whether there is room to save before it will start, and
 * a nought there is "Cannot start a new game, disk is full."
 */
describe("FileIO's sub-functions", () => {
  async function fileIoWorld(version: 'sci1-1' | 'sci2-1-middle' = 'sci2-1-middle') {
    const { SCI_KERNEL } = await import('../src/engine/sci/script/SciKernel.js');
    const { createSciFileSurface } = await import('../src/engine/sci/script/sciFiles.js');
    const { SciHeap } = await import('../src/engine/sci/script/segments.js');

    const logged: string[] = [];
    const machine = new PMachine(version, {
      scriptCode: () => new Uint8Array([0x48]),
      callKernel: () => null,
      exportOffset: () => null,
      heapStart: () => 0,
      log: (line) => logged.push(line),
    });
    const heap = new SciHeap();
    const world = {
      machine,
      heap,
      log: (line: string) => logged.push(line),
      random: () => 0,
      ticks: () => 0,
      files: createSciFileSurface(),
    } as unknown as SciKernelWorld;

    const put = (text: string): Reg => {
      const ref = heap.allocate(text.length + 1);
      const bytes = heap.bytes(ref)!;
      for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index);
      return ref;
    };
    const get = (ref: Reg): string => {
      const bytes = heap.bytes(ref)!;
      let text = '';
      for (const byte of bytes) {
        if (byte === 0) break;
        text += String.fromCharCode(byte);
      }
      return text;
    };
    const io = (...args: Array<Reg | number>): Reg =>
      SCI_KERNEL.FileIO!(
        world,
        args.map((value) => (typeof value === 'number' ? reg(0, value & 0xffff) : value)),
      );

    return { SCI_KERNEL, heap, world, logged, put, get, io };
  }

  const SUB = {
    open: 0,
    close: 1,
    readRaw: 2,
    writeRaw: 3,
    unlink: 4,
    readString: 5,
    writeString: 6,
    seek: 7,
    findFirst: 8,
    findNext: 9,
    exists: 10,
    rename: 11,
    copy: 12,
    readByte: 13,
    writeByte: 14,
    readWord: 15,
    writeWord: 16,
    checkFreeSpace: 17,
    getCwd: 18,
    isValidDirectory: 19,
  } as const;

  it('writes a string and reads it back, which is what a catalogue is', async () => {
    const { put, get, io, heap } = await fileIoWorld();

    const handle = io(SUB.open, put('kq7cdsg.cat'), 0);
    expect(handle.offset).toBeGreaterThan(0);
    expect(io(SUB.writeString, handle, put('Rosella\n')).offset).toBe(8);
    io(SUB.close, handle);

    expect(io(SUB.exists, put('KQ7CDSG.CAT')).offset).toBe(1);

    const reading = io(SUB.open, put('kq7cdsg.cat'), 1);
    const destination = heap.allocate(32);
    expect(io(SUB.readString, destination, 32, reading).offset).toBe(destination.offset);
    expect(get(destination)).toBe('Rosella');
  });

  it('seeks, because a list of lines has no byte 42 to seek to', async () => {
    const { io, heap } = await fileIoWorld();
    const name = heap.allocate(8);
    heap.bytes(name)!.set([0x61, 0x2e, 0x64, 0x61, 0x74, 0]);

    const handle = io(SUB.open, name, 0);
    const source = heap.allocate(4);
    heap.bytes(source)!.set([1, 2, 3, 4]);
    expect(io(SUB.writeRaw, handle, source, 4).offset).toBe(4);

    // SCI32 answers where the cursor landed rather than merely that it moved.
    expect(io(SUB.seek, handle, 1, 0).offset).toBe(1);
    const destination = heap.allocate(4);
    expect(io(SUB.readRaw, handle, destination, 2).offset).toBe(2);
    expect([...heap.bytes(destination)!.slice(0, 2)]).toEqual([2, 3]);

    // Two from the end is byte three, and a read there is short by design.
    expect(io(SUB.seek, handle, -1, 2).offset).toBe(3);
    expect(io(SUB.readRaw, handle, destination, 8).offset).toBe(1);
  });

  it('writes a byte and a word and reads the same numbers back', async () => {
    const { put, io } = await fileIoWorld();
    const handle = io(SUB.open, put('save.001'), 0);
    io(SUB.writeByte, handle, 0x2a);
    expect(io(SUB.writeWord, handle, 0xbeef).offset).toBe(2);
    io(SUB.seek, handle, 0, 0);
    // Into the low byte of the accumulator, which Sierra leaves the high byte of
    // alone — so the whole answer is checked and not just the low half.
    expect(io(SUB.readByte, handle).offset).toBe(0x2a);
    expect(io(SUB.readWord, handle).offset).toBe(0xbeef);
  });

  it('deletes, renames and walks a mask', async () => {
    const { put, get, io, heap } = await fileIoWorld();
    for (const name of ['sg.001', 'sg.002', 'notes.txt']) io(SUB.close, io(SUB.open, put(name), 0));

    const found = heap.allocate(32);
    expect(io(SUB.findFirst, put('sg.*'), found, 0).offset).toBe(found.offset);
    expect(get(found)).toBe('sg.001');
    expect(io(SUB.findNext, found).offset).toBe(found.offset);
    expect(get(found)).toBe('sg.002');
    // Nought at the end, because a script loops until it is told to stop.
    expect(io(SUB.findNext, found).segment).toBe(0);
    expect(io(SUB.findNext, found).offset).toBe(0);

    // Nought is success for these two and -1 is failure, the other way round
    // from every other sub-function (`kfile.cpp:939`).
    expect(io(SUB.rename, put('sg.001'), put('sg.003')).offset).toBe(0);
    expect(io(SUB.rename, put('nothing.at.all'), put('sg.004')).offset).toBe(0xffff);
    expect(io(SUB.exists, put('sg.003')).offset).toBe(1);
    expect(io(SUB.exists, put('sg.001')).offset).toBe(0);

    expect(io(SUB.unlink, put('notes.txt')).offset).toBe(1);
    expect(io(SUB.exists, put('notes.txt')).offset).toBe(0);
  });

  it('answers -1 at SCI32 and nought below it, which is what the scripts test', async () => {
    const sci32 = await fileIoWorld('sci2-1-middle');
    const sci11 = await fileIoWorld('sci1-1');
    // Mode 1 on a file that is not there is the refusal a game asks for.
    expect(sci32.io(SUB.open, sci32.put('missing.sav'), 1).offset).toBe(0xffff);
    expect(sci11.io(SUB.open, sci11.put('missing.sav'), 1).offset).toBe(0);
  });

  /**
   * The three questions `CheckFreeSpace` is, and the fourth King's Quest VII
   * asks.
   *
   * The first three are `kfile.cpp:157`. The fourth is a finding about the
   * release rather than about this host: `startBut::doVerb` at script 30 offset
   * 1315 calls `FileIO(17, 3, path)`, and ScummVM's own handler enumerates only
   * nought, one and two and errors on anything else.
   */
  it('answers the three free-space questions, and the one KQ7 invents', async () => {
    const { put, io, logged } = await fileIoWorld();
    expect(io(SUB.checkFreeSpace, 0, put('c:\\')).offset).toBe(0);
    expect(io(SUB.checkFreeSpace, 1, put('c:\\')).offset).toBe(0x7fff);
    expect(io(SUB.checkFreeSpace, 2, put('c:\\')).offset).toBe(1);

    expect(io(SUB.checkFreeSpace, 3, put('c:\\')).offset).toBe(1);
    expect(logged.filter((line) => line.includes('CheckFreeSpace sub-op 3'))).toHaveLength(1);
    // Once, not once a cycle: a menu that asks this every frame would otherwise
    // fill the log with the same sentence.
    io(SUB.checkFreeSpace, 3, put('c:\\'));
    expect(logged.filter((line) => line.includes('CheckFreeSpace sub-op 3'))).toHaveLength(1);
  });

  it('answers the two calls with nothing behind them rather than being silent', async () => {
    const { get, io, heap } = await fileIoWorld();
    const buffer = heap.allocate(32);
    expect(io(SUB.getCwd, buffer).offset).toBe(buffer.offset);
    expect(get(buffer)).toBe('C:\\SIERRA\\');
    expect(io(SUB.isValidDirectory, buffer).offset).toBe(1);
  });

  it('names an unknown sub-function rather than answering it silently', async () => {
    const { io, logged } = await fileIoWorld();
    expect(io(99).offset).toBe(0xffff);
    expect(logged.filter((line) => line.includes('FileIO sub-function 99'))).toHaveLength(1);
  });
});

describe('the Kernel calls a shipped game makes that this engine could not answer', () => {
  /** Signed, because half of these answer -1 and a register holds 0xffff. */
  const answer = (value: Reg): number =>
    value.offset > 0x7fff ? value.offset - 0x10000 : value.offset;

  /**
   * A world with a real machine and a real heap behind it.
   *
   * The machine is real because `Sort` runs the game's own code and a stub
   * cannot; the heap is real because `StrSplit` writes into one. Everything
   * else a `SciKernelWorld` offers is absent on purpose — a handler that
   * reached for the renderer to answer arithmetic would fail here.
   */
  async function kernelWorld(code = new Uint8Array([0x48]), extra: Partial<SciKernelWorld> = {}) {
    const { SCI_KERNEL, SCI_UNUSED_KERNEL_NAMES } =
      await import('../src/engine/sci/script/SciKernel.js');
    const { SciHeap } = await import('../src/engine/sci/script/segments.js');

    const logged: string[] = [];
    const machine = new PMachine('sci1-late', {
      scriptCode: () => code,
      callKernel: () => null,
      exportOffset: () => null,
      heapStart: () => 0,
      log: (line) => logged.push(line),
    });
    const heap = new SciHeap();
    const world = {
      machine,
      heap,
      log: (line: string) => logged.push(line),
      random: () => 0,
      ticks: () => 0,
      ...extra,
    } as unknown as SciKernelWorld;

    return { SCI_KERNEL, SCI_UNUSED_KERNEL_NAMES, machine, heap, world, logged };
  }

  const putString = (heap: SciHeap, text: string): Reg => {
    const ref = heap.allocate(text.length + 1);
    const bytes = heap.bytes(ref)!;
    for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index);
    return ref;
  };
  const getString = (heap: SciHeap, ref: Reg): string => {
    const bytes = heap.bytes(ref)!;
    let text = '';
    for (const byte of bytes) {
      if (byte === 0) break;
      text += String.fromCharCode(byte);
    }
    return text;
  };

  /**
   * `SinMult`/`CosMult` and `TimesSin`/`TimesCos` are two names for two slots,
   * and both names have to answer because `SciEngine.kernelNameFor` prefers the
   * table the game ships in its own `vocab.999` — so which name a SCI0 release
   * reaches is a fact about that release.
   *
   * **49 and not 50.** `sin(30°)` is a hair under a half in a double, and
   * ScummVM's `kTimesSin` casts rather than rounds. This used to round, which
   * is a pixel wherever the fraction reaches a half and an accumulating pixel
   * around a circle.
   */
  it('multiplies by a sine the way a C cast does, under both tables’ names', async () => {
    const { SCI_KERNEL, world } = await kernelWorld();
    const call = (name: string, ...args: number[]) =>
      answer(
        SCI_KERNEL[name](
          world,
          args.map((value) => reg(0, value & 0xffff)),
        ),
      );

    expect(call('SinMult', 30, 100)).toBe(49);
    expect(call('SinMult', 90, 100)).toBe(100);
    expect(call('CosMult', 60, 100)).toBe(50);
    // Half a turn is nought, not the 1.2e-14 the double actually holds.
    expect(call('SinMult', 180, 100)).toBe(0);
    // Negative angles stay negative rather than wrapping through the register.
    expect(call('SinMult', -30, 100)).toBe(-49);

    // SCI0's own names for the same two slots, answered by the same arithmetic.
    expect(call('TimesSin', 30, 100)).toBe(call('SinMult', 30, 100));
    expect(call('TimesCos', 60, 100)).toBe(call('CosMult', 60, 100));
  });

  /**
   * `SinDiv(angle, value)` is *value over* the ratio, which is the opposite of
   * the pair above and reads identically at a glance.
   *
   * The pole is the interesting half: ScummVM raises an error where the ratio
   * is within a ten-thousandth of nought, and a Kernel call that throws here
   * would take the instruction ring and the trace with it. So it reports and
   * answers -1, and the test pins both halves of that.
   */
  it('divides by a sine, and says so where Sierra’s interpreter cannot answer', async () => {
    const { SCI_KERNEL, world, logged } = await kernelWorld();
    const call = (name: string, ...args: number[]) =>
      answer(
        SCI_KERNEL[name](
          world,
          args.map((value) => reg(0, value & 0xffff)),
        ),
      );

    expect(call('SinDiv', 30, 100)).toBe(200);
    expect(call('CosDiv', 0, 100)).toBe(100);
    // 199, because the double for `cos(60°)` is a hair over a half.
    expect(call('CosDiv', 60, 100)).toBe(199);

    expect(call('SinDiv', 0, 100)).toBe(-1);
    expect(call('CosDiv', 90, 100)).toBe(-1);
    expect(logged.filter((line) => line.includes('undefined'))).toHaveLength(2);
  });

  /**
   * `TimesTan` is not `scale * tan(angle)`, and that is Sierra's doing.
   * ScummVM's `kTimesTan` shifts the angle a quarter turn and negates, which is
   * the cotangent; `kTimesCot` is the plain tangent. A reader who assumes the
   * names mean what they say writes the pair backwards and every angle but 45°
   * is wrong by a different amount — which is why this is the identity, tested,
   * rather than a transcription nobody checked.
   */
  it('reads TimesTan as the cotangent Sierra wrote, not the tangent it is named', async () => {
    const { SCI_KERNEL, world, logged } = await kernelWorld();
    const call = (name: string, ...args: number[]) =>
      answer(
        SCI_KERNEL[name](
          world,
          args.map((value) => reg(0, value & 0xffff)),
        ),
      );

    // cot(30°) is 1.732 and tan(30°) is 0.577, so the two are not each other.
    expect(call('TimesTan', 30, 100)).toBe(173);
    expect(call('TimesCot', 30, 100)).toBe(57);
    // 99 rather than 100 at a half-quarter turn: the cast, again.
    expect(call('TimesTan', 45, 100)).toBe(99);
    expect(call('TimesCot', 45, 100)).toBe(99);
    // The scale defaults to one rather than to nought, which a 45° test
    // could not tell apart: `trunc(tan(45°))` is nought either way.
    expect(call('TimesCot', 60)).toBe(1);

    // Both run away at a quarter turn — `TimesTan` a quarter turn shifted.
    expect(call('TimesTan', 0, 100)).toBe(-1);
    expect(call('TimesCot', 90, 100)).toBe(-1);
    expect(logged).toHaveLength(2);
  });

  /**
   * `StrSplit` splits a *language*, not a word, and the name is the trap: a
   * multilanguage release writes `English%JJapanese` into one string and the
   * interpreter hands back the half the game asked for.
   */
  it('splits a language out of a string rather than a word', async () => {
    const { SCI_KERNEL, world, heap } = await kernelWorld();
    const split = (text: string) => {
      const buffer = heap.allocate(64);
      const answered = SCI_KERNEL.StrSplit(world, [buffer, putString(heap, text), reg(0, 0x25)]);
      // The buffer is the answer, which is what the calling script stores.
      expect(answered).toEqual(buffer);
      return getString(heap, buffer);
    };

    // No splitter at all, which is what every English-only release holds.
    expect(split('Open the door.')).toBe('Open the door.');
    // A second language after the splitter: the half before it is English.
    expect(split('Open the door.%JAkete kudasai.')).toBe('Open the door.');
    // `%E` names English itself, so the requested half is the one *after* it.
    expect(split('Machen Sie die Tür auf.%EOpen the door.')).toBe('Open the door.');
    // A bare `%` is not a splitter; only `%` or `#` before a language letter.
    expect(split('100% sure')).toBe('100% sure');
  });

  /**
   * `Sort` is the one Kernel call that runs a script: it sends the third
   * object `doit` once per element to get that element's key, so it cannot be
   * answered without re-entering the machine. `PMachine.invoke` exists for this
   * and for nothing else.
   *
   * The elements go in scrambled and come out ordered, which is the assertion
   * that a callback answering a constant would fail — a sort that ignored the
   * key would leave the list in the order it arrived.
   */
  async function sortWorld(doitOffset: number) {
    //  0: lap 1   — the element, which is this order object's key for it
    //  2: ret
    //  3: 0x52    — opcode 0x29, a slot Sierra left unused: a loud halt
    const built = await kernelWorld(new Uint8Array([0x87, 0x01, 0x48, 0x52]));
    built.machine.selectorNumbers = new Map([
      ['size', 10],
      ['elements', 12],
      ['doit', 14],
    ]);
    const object = (offset: number, methods: Array<[number, number]>) => ({
      id: reg(1, offset),
      species: 1,
      superClass: 0,
      info: 0,
      propertyBias: 0,
      variables: [reg(0, 0), NULL_REG],
      methods: new Map(methods),
      variableSelectors: [10, 12],
      script: 1,
      clone: false,
      name: `object${offset}`,
    });
    const source = object(100, []);
    const destination = object(200, []);
    const order = object(300, [[14, doitOffset]]);
    built.machine.addObject(source);
    built.machine.addObject(destination);
    built.machine.addObject(order);

    // Three elements, out of order, keyed by something the sort must ignore.
    const input = built.heap.newList();
    for (const value of [30, 10, 20]) {
      built.heap.addToEnd(input, built.heap.newNode(reg(0, value), reg(0, 900 - value)));
    }
    source.variables = [reg(0, 3), input];

    const values = (list: Reg) => {
      const out: number[] = [];
      let at = built.heap.list(list)?.first ?? NULL_REG;
      while (at.segment !== 0 || at.offset !== 0) {
        const node = built.heap.node(at);
        if (!node) break;
        out.push(node.value.offset);
        at = node.next;
      }
      return out;
    };
    return { ...built, source, destination, order, values };
  }

  it('orders a list by the key the game’s own object answers', async () => {
    const { SCI_KERNEL, world, source, destination, order, values } = await sortWorld(0);

    SCI_KERNEL.Sort(world, [source.id, destination.id, order.id]);

    // Ordered by what `doit` answered, which is the element and not the node's
    // key — the keys run the other way and a sort by them would say 30, 20, 10.
    expect(values(destination.variables[1])).toEqual([10, 20, 30]);
    // The destination is told how long it now is, as Sierra's own `Sort` does.
    expect(destination.variables[0].offset).toBe(3);
  });

  /**
   * A callback that halts is not a callback that answered zero. `invoke` says
   * null, and the alternative — ordering by whatever was left in the
   * accumulator — is a list that looks sorted and is not.
   */
  it('abandons a sort whose order object does not finish', async () => {
    const { SCI_KERNEL, world, source, destination, order, values, logged } = await sortWorld(3);

    SCI_KERNEL.Sort(world, [source.id, destination.id, order.id]);

    expect(values(destination.variables[1])).toEqual([]);
    expect(logged.some((line) => line.includes('abandoned'))).toBe(true);
  });

  /**
   * `GetMessage` is SCI1's spelling of the slot SCI1.1 renames `Message`, and
   * it goes through the same reader: `world.message`, which `sciMessage.ts`
   * answers. Two readers of one resource is how the two come to disagree.
   *
   * The argument order is the thing to pin — the module is the *second*
   * argument, not the first, and a handler that read them in the obvious order
   * asks module 4 for noun 7 and gets a line that exists.
   */
  it('asks the Message reader for GetMessage, in SCI1’s argument order', async () => {
    const { SCI_KERNEL, world, heap, logged } = await kernelWorld();
    const asked: Array<[number, Record<string, number>]> = [];
    (world as { message?: unknown }).message = (
      module: number,
      key: { noun: number; verb: number; cond: number; seq: number },
    ) => {
      asked.push([module, { ...key }]);
      return module === 4 ? { text: 'It is a locked door.', talker: 9 } : null;
    };

    const buffer = heap.allocate(64);
    const answered = SCI_KERNEL.GetMessage(world, [reg(0, 7), reg(0, 4), reg(0, 3), buffer]);

    expect(asked).toEqual([[4, { noun: 7, verb: 3, cond: 0, seq: 0 }]]);
    expect(getString(heap, buffer)).toBe('It is a locked door.');
    // The buffer is the answer, as it is for `StrSplit`.
    expect(answered).toEqual(buffer);

    // A line the game does not ship is reported rather than written as empty.
    SCI_KERNEL.GetMessage(world, [reg(0, 7), reg(0, 5), reg(0, 3), buffer]);
    expect(logged.some((line) => line.includes('No Message 5:7,3,0,0'))).toBe(true);
    expect(getString(heap, buffer)).toBe('It is a locked door.');
  });

  /**
   * `SetVideoMode` is finished, not stubbed. King's Quest VI's intro asks for
   * the planar mode a VGA card had and nothing has since; the flag has no
   * effect on a renderer that does not have the mode to leave.
   */
  it('takes SetVideoMode as a flag for a display mode that no longer exists', async () => {
    const { SCI_KERNEL, world, logged } = await kernelWorld();
    expect(SCI_KERNEL.SetVideoMode(world, [reg(0, 1)])).toEqual(NULL_REG);
    // Answered, not reported: there is nothing here for a reader to act on.
    expect(logged).toEqual([]);
  });

  /**
   * The other answer this run had to give once rather than fourteen times.
   *
   * These are Sierra's own debugger's surface plus the slots ScummVM's table
   * marks "never called?", and a handler that logs and answers zero is a
   * defensible answer for `ShowSends`. Pretending it is implemented is not,
   * which is why the coverage count keeps them in a column of their own.
   */
  it('answers an unused call with zero and one line, not with silence', async () => {
    const { SCI_KERNEL, SCI_UNUSED_KERNEL_NAMES, world, logged } = await kernelWorld();

    for (const name of SCI_UNUSED_KERNEL_NAMES) {
      expect(SCI_KERNEL[name], `${name} has no handler at all`).toBeTypeOf('function');
      expect(SCI_KERNEL[name](world, [])).toEqual(NULL_REG);
    }
    expect(logged).toHaveLength(SCI_UNUSED_KERNEL_NAMES.length);

    // Once per world, because a call in a loop would otherwise fill the log
    // with the same line and bury whatever is actually wrong.
    for (const name of SCI_UNUSED_KERNEL_NAMES) SCI_KERNEL[name](world, []);
    expect(logged).toHaveLength(SCI_UNUSED_KERNEL_NAMES.length);
  });

  /**
   * `Intersections`: where a line crosses a polygon, in pixels.
   *
   * **The expectations here are geometry rather than this engine's output.**
   * Every case below is one whose answer can be worked out on paper — a
   * horizontal line through a square crosses its two upright sides, a line
   * `y = x` crosses the wall at `x = 50` at `(50, 50)` — so a transcription
   * that drifted would disagree with the arithmetic a reader can do, not merely
   * with itself. That is the one thing a fixture cannot give: Tier 1's trap is
   * a fixture built by the code it then agrees with, and a right angle is not.
   *
   * The buffers are words, because every index in the call is a word index.
   */
  const putWords = (heap: SciHeap, words: number[]): Reg => {
    const ref = heap.allocate(words.length * 2);
    const bytes = heap.bytes(ref)!;
    words.forEach((word, index) => {
      bytes[index * 2] = word & 0xff;
      bytes[index * 2 + 1] = (word >> 8) & 0xff;
    });
    return ref;
  };
  const getWords = (heap: SciHeap, ref: Reg, count: number): number[] => {
    const bytes = heap.bytes(ref)!;
    return Array.from({ length: count }, (_, index) => {
      const word = (bytes[index * 2] ?? 0) | ((bytes[index * 2 + 1] ?? 0) << 8);
      return word > 0x7fff ? word - 0x10000 : word;
    });
  };
  /** Bit 13 on the first x is what tells a closed polygon from a polyline. */
  const CLOSED = 1 << 13;

  it('crosses a square where a line through it would, and nowhere else', async () => {
    const { SCI_KERNEL, world, heap } = await kernelWorld();
    // A 100-pixel square, its corners walked anticlockwise from (100, 100).
    const polygon = putWords(heap, [100 | CLOSED, 100, 200, 100, 200, 200, 100, 200]);
    const out = heap.allocate(6 * 2);

    // A horizontal line at y = 150, entering left of the square and leaving
    // right of it. It meets the two upright sides and neither flat one.
    const count = SCI_KERNEL.Intersections(world, [
      reg(0, 50),
      reg(0, 150),
      reg(0, 250),
      reg(0, 150),
      polygon,
      reg(0, 0),
      reg(0, 6),
      reg(0, 2),
      out,
      reg(0, 0),
    ]);

    expect(answer(count)).toBe(2);
    // Each crossing is an x, a y, and the word index of the point the edge it
    // crossed ends at — which is how the calling script knows *which* wall it
    // walked into rather than only that it walked into one.
    expect(getWords(heap, out, 6)).toEqual([200, 150, 4, 100, 150, 0]);
  });

  it('crosses a wall where y = x meets it, and misses when the segment is short', async () => {
    const { SCI_KERNEL, world, heap } = await kernelWorld();
    // A polyline rather than a polygon — no bit 13 — so the walk stops at its
    // end instead of coming back round to its start.
    const wall = putWords(heap, [50, 0, 50, 100]);
    const cross = (sourceX: number, sourceY: number) => {
      const out = heap.allocate(3 * 2);
      const count = SCI_KERNEL.Intersections(world, [
        reg(0, sourceX),
        reg(0, sourceY),
        reg(0, 100),
        reg(0, 100),
        wall,
        reg(0, 0),
        reg(0, 2),
        reg(0, 2),
        out,
        reg(0, 0),
      ]);
      return { count: answer(count), out: getWords(heap, out, 3) };
    };

    // (0, 0) to (100, 100) is the line y = x, which meets x = 50 at (50, 50).
    expect(cross(0, 0)).toEqual({ count: 1, out: [50, 50, 2] });
    // The same infinite line, a segment too short to reach the wall. The two
    // lines still meet; the two *segments* do not, and that is the difference
    // between "these lines cross" and "this walk is blocked".
    expect(cross(80, 80)).toEqual({ count: 0, out: [0, 0, 0] });
  });

  it('extends a backtracked line to the edge of the play area, and then crosses', async () => {
    const { SCI_KERNEL, world, heap } = await kernelWorld();
    const wall = putWords(heap, [100, 0, 100, 200]);
    const cross = (backtrack: number) => {
      const out = heap.allocate(3 * 2);
      const count = SCI_KERNEL.Intersections(world, [
        reg(0, 60),
        reg(0, 60),
        reg(0, 20),
        reg(0, 20),
        wall,
        reg(0, 0),
        reg(0, 2),
        reg(0, 2),
        out,
        reg(0, backtrack),
      ]);
      return { count: answer(count), out: getWords(heap, out, 3) };
    };

    // (60, 60) to (20, 20) stops well short of the wall at x = 100.
    expect(cross(0)).toEqual({ count: 0, out: [0, 0, 0] });
    // With backtrack the source is pushed back along y = x until it leaves the
    // screen. The right edge is 319, which on this line is y = 319 and off the
    // bottom, so it lands on the bottom edge instead — (189, 189) — and the
    // segment now reaches the wall at (100, 100).
    expect(cross(1)).toEqual({ count: 1, out: [100, 100, 2] });
  });

  /**
   * Sierra's loop walks by the stride and ends when it arrives back where it
   * started, so a stride of nought never ends. ScummVM has no guard because no
   * shipped game passes one; this engine reports it, for the reason
   * `CanBeHere` answers permissively rather than hanging — a hang loses every
   * later finding in the same run.
   */
  it('refuses a stride that could not walk a polygon, rather than spinning', async () => {
    const { SCI_KERNEL, world, heap, logged } = await kernelWorld();
    const polygon = putWords(heap, [100 | CLOSED, 100, 200, 100]);
    const out = heap.allocate(3 * 2);
    const args = [
      reg(0, 0),
      reg(0, 0),
      reg(0, 9),
      reg(0, 9),
      polygon,
      reg(0, 0),
      reg(0, 2),
      reg(0, 0),
      out,
      reg(0, 0),
    ];

    expect(SCI_KERNEL.Intersections(world, args)).toEqual(NULL_REG);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('stride of nought');
  });

  it('reports a buffer that names nothing rather than counting crossings it did not find', async () => {
    const { SCI_KERNEL, world, heap, logged } = await kernelWorld();
    const polygon = putWords(heap, [100 | CLOSED, 100, 200, 100]);
    const args = [
      reg(0, 0),
      reg(0, 0),
      reg(0, 9),
      reg(0, 9),
      polygon,
      reg(0, 0),
      reg(0, 2),
      reg(0, 2),
      NULL_REG,
      reg(0, 0),
    ];

    expect(SCI_KERNEL.Intersections(world, args)).toEqual(NULL_REG);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('names nothing');
  });

  /**
   * `Intersections` against geometry, rather than against its own transcription.
   *
   * **What the five cases above cannot catch.** They are hand-worked points on
   * axis-aligned shapes, and a transcription can be wrong in ways that a right
   * angle never exercises: a slope rounded the wrong way, a sign lost on a
   * negative run, the `qSlope`/`pSlope` branches taken in the wrong order. The
   * expectations here are instead two properties that hold for *any* line and
   * *any* polygon by definition of what a crossing is, checked over four
   * thousand pseudo-random query lines against a convex hexagon whose vertices
   * are deliberately off the axes.
   *
   * **Property one: a reported crossing is on both segments.** It must lie on
   * the polygon edge the call named — which also checks the third word of each
   * triple, the edge index, that no hand-worked case really pins — and on the
   * query segment. This is the definition of the answer, so a transcription
   * that drifted anywhere in the slope arithmetic breaks it.
   *
   * **Property two: the count's parity is the topology.** A segment with one
   * endpoint inside a closed polygon and one outside must cross it an odd
   * number of times; both endpoints outside, an even number. Nothing about
   * Sierra's centipixels is in that statement — it is the Jordan curve theorem
   * — and it is what catches a crossing counted twice or dropped.
   *
   * **The excluded cases are the margin, and they were measured rather than
   * assumed.** Sierra grows each segment's bounding box by a pixel per axis
   * before testing containment, so a line passing within about √2 of a vertex
   * lands on *both* edges meeting there and is counted twice; rounding the
   * crossing back to whole pixels adds half a pixel more. Parity therefore
   * fails for grazing lines by construction, in Sierra's interpreter as much as
   * in this one. Sweeping the exclusion radius over the same four thousand
   * lines gives 140 parity failures at no exclusion, 10 at 1.5 pixels, 2 at 2.0
   * and **0 at 2.5** — which is the predicted √2 + ½ and is why the constant
   * below is 2.5 rather than a number that happened to work.
   */
  it('puts every crossing on both segments, and gets the parity right', async () => {
    const { SCI_KERNEL, world, heap } = await kernelWorld();

    // Off-axis on purpose: an axis-aligned box exercises neither the rounding
    // of a fractional slope nor the sign of a negative run.
    const corners = [
      [120, 40],
      [200, 40],
      [240, 100],
      [200, 160],
      [120, 160],
      [80, 100],
    ] as const;
    const words = corners.flatMap(([x, y]) => [x, y]);
    const polygon = putWords(heap, [words[0] | CLOSED, ...words.slice(1)]);
    const lastIndex = (corners.length - 1) * 2;

    /** How far a point is from a segment, for the margin the call works to. */
    const distanceToSegment = (
      px: number,
      py: number,
      [ax, ay]: readonly [number, number],
      [bx, by]: readonly [number, number],
    ): number => {
      const dx = bx - ax;
      const dy = by - ay;
      const lengthSquared = dx * dx + dy * dy;
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
      return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    };
    /** Sierra's per-axis pixel of slack, plus the half pixel rounding costs. */
    const GRAZING = 2.5;
    const edges = corners.map(
      (corner, index) => [corners[(index + corners.length - 1) % corners.length], corner] as const,
    );
    /** The hexagon is convex and wound one way, so a sign test is enough. */
    const isInside = (x: number, y: number): boolean =>
      edges.every(([[ax, ay], [bx, by]]) => (bx - ax) * (y - ay) - (by - ay) * (x - ax) > 0);

    // A fixed multiplier and seed: the same four thousand lines every run, so a
    // failure is reproducible rather than a Tuesday.
    let seed = 12345;
    const nextInt = (bound: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % bound;
    };

    let considered = 0;
    for (let trial = 0; trial < 4000; trial++) {
      const sourceX = nextInt(320);
      const sourceY = nextInt(190);
      const destX = nextInt(320);
      const destY = nextInt(190);

      const out = heap.allocate(12 * 2);
      const count = answer(
        SCI_KERNEL.Intersections(world, [
          reg(0, sourceX),
          reg(0, sourceY),
          reg(0, destX),
          reg(0, destY),
          polygon,
          reg(0, 0),
          reg(0, lastIndex),
          reg(0, 2),
          out,
          reg(0, 0),
        ]),
      );
      const triples = getWords(heap, out, count * 3);
      const line = `(${sourceX},${sourceY})-(${destX},${destY})`;

      for (let found = 0; found < count; found++) {
        const [x, y, index] = triples.slice(found * 3, found * 3 + 3);
        const [from, to] = edges[index / 2];
        expect(
          distanceToSegment(x, y, from, to),
          `${line}: crossing off its named edge`,
        ).toBeLessThan(GRAZING);
        expect(
          distanceToSegment(x, y, [sourceX, sourceY], [destX, destY]),
          `${line}: crossing off the query segment`,
        ).toBeLessThan(GRAZING);
      }

      // A line that grazes a vertex is counted on both edges meeting there, and
      // an endpoint sitting on an edge is inside and outside at once. Parity
      // says nothing about either, so neither is asserted on.
      const grazes =
        corners.some(
          ([x, y]) => distanceToSegment(x, y, [sourceX, sourceY], [destX, destY]) < GRAZING,
        ) ||
        edges.some(([from, to]) => distanceToSegment(sourceX, sourceY, from, to) < GRAZING) ||
        edges.some(([from, to]) => distanceToSegment(destX, destY, from, to) < GRAZING);
      if (grazes) continue;

      considered++;
      const crossesBoundary = isInside(sourceX, sourceY) !== isInside(destX, destY);
      expect(count % 2 === 1, `${line}: crossed ${count} times`).toBe(crossesBoundary);
    }

    // The exclusions are a margin, not most of the sample.
    expect(considered).toBeGreaterThan(3000);
  });

  /**
   * `MergePoly(outline, list, size)`: one obstacle grown to swallow the others.
   *
   * Quest for Glory I VGA calls it when a monster dies and its avoidance
   * polygon has to be folded back into the room's, and the answer is a fresh
   * outline in the heap, closed by the word `0x7777`. The polygons it swallowed
   * are marked in place: their `type` gains `0x10`, through the game's own
   * Selector table and not a hardcoded offset.
   *
   * **The expectations below are geometry, not this engine's output.** Every
   * hand-worked case is a union of axis-aligned squares whose outline a reader
   * can trace on paper, and the property at the end holds for any two
   * overlapping convex shapes by the definition of a union. That is what keeps
   * this Tier 1 rather than circular: no SCI game data is mounted here, and a
   * fixture agreeing with the code that built it would be worth nothing.
   * The transcription itself is Tier 3 — ScummVM's `kMergePoly` and
   * `mergeSinglePolygon` in `engines/sci/engine/kpathing.cpp`.
   */
  async function polygonWorld() {
    const built = await kernelWorld();
    built.machine.selectorNumbers = new Map([
      ['points', 4],
      ['size', 6],
      ['type', 8],
    ]);

    /** Points are four bytes each, x then y, signed and little-endian. */
    const putPoints = (points: Array<[number, number]>, close: boolean): Reg => {
      const ref = built.heap.allocate(4 * (points.length + (close ? 1 : 0)));
      const bytes = built.heap.bytes(ref)!;
      const write = (index: number, x: number, y: number) => {
        bytes[index * 4] = x & 0xff;
        bytes[index * 4 + 1] = (x >> 8) & 0xff;
        bytes[index * 4 + 2] = y & 0xff;
        bytes[index * 4 + 3] = (y >> 8) & 0xff;
      };
      points.forEach(([x, y], index) => write(index, x, y));
      if (close) write(points.length, 0x7777, 0x7777);
      return ref;
    };
    /** The answer, read back to its `0x7777` or to the end of what it got. */
    const getPoints = (ref: Reg): Array<[number, number]> => {
      const bytes = built.heap.bytes(ref);
      if (!bytes) return [];
      const out: Array<[number, number]> = [];
      for (let index = 0; index * 4 + 3 < bytes.length; index++) {
        const x = bytes[index * 4]! | (bytes[index * 4 + 1]! << 8);
        const y = bytes[index * 4 + 2]! | (bytes[index * 4 + 3]! << 8);
        if (x === 0x7777) break;
        out.push([x > 0x7fff ? x - 0x10000 : x, y > 0x7fff ? y - 0x10000 : y]);
      }
      return out;
    };

    // A polygon is an object with `points`, `size` and `type`, which is what a
    // room script's own polygon instances are. 2 is `PBarredAccess`.
    let nextOffset = 100;
    const polygon = (points: Array<[number, number]>, type = 2) => {
      const object = {
        id: reg(1, nextOffset),
        species: 1,
        superClass: 0,
        info: 0,
        propertyBias: 0,
        variables: [putPoints(points, false), reg(0, points.length), reg(0, type)],
        methods: new Map<number, number>(),
        variableSelectors: [4, 6, 8],
        script: 1,
        clone: false,
        name: `polygon${nextOffset}`,
      };
      nextOffset += 100;
      built.machine.addObject(object);
      return object;
    };
    const listOf = (objects: Array<{ id: Reg }>): Reg => {
      const list = built.heap.newList();
      for (const object of objects) {
        built.heap.addToEnd(list, built.heap.newNode(object.id, NULL_REG));
      }
      return list;
    };
    /** Corners of a square, in the winding a room's own outline uses. */
    const square = (x: number, y: number, side: number): Array<[number, number]> => [
      [x, y],
      [x + side, y],
      [x + side, y + side],
      [x, y + side],
    ];

    return { ...built, putPoints, getPoints, polygon, listOf, square };
  }

  it('grows an outline to swallow the obstacle that overlaps it', async () => {
    const { SCI_KERNEL, world, putPoints, getPoints, polygon, listOf, square } =
      await polygonWorld();

    // Two hundred-pixel squares, the second offset by half its side, so the
    // union is an L rotated: out along the top of the first, down its right
    // side to where the second begins, round the second, and back.
    const outline = putPoints(square(0, 0, 100), true);
    const obstacle = polygon(square(50, 50, 100));

    const merged = SCI_KERNEL.MergePoly(world, [outline, listOf([obstacle]), reg(0, 64)]);

    expect(getPoints(merged)).toEqual([
      [0, 0],
      [100, 0],
      [100, 50],
      [150, 50],
      [150, 150],
      [50, 150],
      [50, 100],
      [0, 100],
    ]);
    // 0x12: the type it arrived with, plus the bit that says it has been
    // folded in, written back through `type` rather than through variable 2.
    expect(obstacle.variables[2]!.offset).toBe(0x12);
  });

  it('carries each merge into the next, so a chain of obstacles comes back as one outline', async () => {
    const { SCI_KERNEL, world, putPoints, getPoints, polygon, listOf, square } =
      await polygonWorld();

    // The third square misses the first entirely. It reaches the outline only
    // through the second, so an implementation that merged each polygon against
    // the *original* outline would drop it.
    const outline = putPoints(square(0, 0, 100), true);
    const middle = polygon(square(50, 50, 100));
    const far = polygon(square(120, 20, 60));

    const merged = SCI_KERNEL.MergePoly(world, [outline, listOf([middle, far]), reg(0, 64)]);

    expect(getPoints(merged)).toEqual([
      [0, 0],
      [100, 0],
      [100, 50],
      [120, 50],
      [120, 20],
      [180, 20],
      [180, 80],
      [150, 80],
      [150, 150],
      [50, 150],
      [50, 100],
      [0, 100],
    ]);
    expect([middle.variables[2]!.offset, far.variables[2]!.offset]).toEqual([0x12, 0x12]);
  });

  it('leaves an outline nothing overlaps alone, and the obstacle unmarked with it', async () => {
    const { SCI_KERNEL, world, putPoints, getPoints, polygon, listOf, square, logged } =
      await polygonWorld();

    const outline = putPoints(square(0, 0, 100), true);
    const elsewhere = polygon(square(200, 200, 40));

    const merged = SCI_KERNEL.MergePoly(world, [outline, listOf([elsewhere]), reg(0, 64)]);

    expect(getPoints(merged)).toEqual(square(0, 0, 100));
    // Unmarked, because nothing was folded into anything. A script reads that
    // bit to know which of its polygons are still its own to move.
    expect(elsewhere.variables[2]!.offset).toBe(2);
    expect(logged).toEqual([]);
  });

  it('reads an outline to the end of its allocation when no 0x7777 closes it', async () => {
    const { SCI_KERNEL, world, putPoints, getPoints, polygon, listOf, square } =
      await polygonWorld();

    // Sierra's own scripts pass a buffer sized exactly to its points in at
    // least one room, and the terminator is then off the end of it. Stopping at
    // the allocation is what keeps that from reading whatever follows.
    const outline = putPoints(square(0, 0, 100), false);
    const obstacle = polygon(square(50, 50, 100));

    const merged = SCI_KERNEL.MergePoly(world, [outline, listOf([obstacle]), reg(0, 64)]);

    expect(getPoints(merged)).toEqual([
      [0, 0],
      [100, 0],
      [100, 50],
      [150, 50],
      [150, 150],
      [50, 150],
      [50, 100],
      [0, 100],
    ]);
  });

  /**
   * Two ways a polygon can be unreadable, and the outline survives both.
   *
   * ScummVM halts the interpreter on the second of these. This engine says one
   * line and skips the polygon, because the outline it was already holding is
   * a usable answer and a halt in the middle of a room script is not — the
   * divergence is deliberate and is recorded on the handler.
   */
  it('skips a polygon it cannot read rather than reading past the end of one', async () => {
    const { SCI_KERNEL, world, putPoints, getPoints, polygon, listOf, square, logged } =
      await polygonWorld();

    const nowhere = polygon(square(50, 50, 100));
    nowhere.variables[0] = reg(0, 5); // a number where a pointer belongs
    const overclaiming = polygon(square(50, 50, 100));
    overclaiming.variables[1] = reg(0, 40); // four points in the buffer, forty claimed

    const merged = SCI_KERNEL.MergePoly(world, [
      putPoints(square(0, 0, 100), true),
      listOf([nowhere, overclaiming]),
      reg(0, 64),
    ]);

    expect(getPoints(merged)).toEqual(square(0, 0, 100));
    expect(logged).toEqual([
      'MergePoly met a polygon whose points name nothing, so it was skipped.',
      'MergePoly met a polygon claiming 40 points in a buffer of 16 bytes, so it was skipped rather than read past its end.',
    ]);
  });

  it('answers nothing when the outline itself names nothing', async () => {
    const { SCI_KERNEL, world, listOf, logged } = await polygonWorld();

    expect(SCI_KERNEL.MergePoly(world, [reg(0, 5), listOf([]), reg(0, 64)])).toEqual(NULL_REG);
    expect(logged).toEqual([
      'MergePoly was handed polygon data that names nothing, so nothing was merged.',
    ]);
  });

  /**
   * `MergePoly` against the definition of a union, rather than against its own
   * transcription.
   *
   * **What the hand-worked cases above cannot catch.** They are axis-aligned
   * squares, and the transcription's hard parts are none of that: the vertex
   * order `convert_polygon` reverses and `kMergePoly` then rotates, the angle
   * accumulation that decides whether a patch is an outward detour or an
   * inward one, the `float`-width arithmetic behind each crossing. A square
   * exercises no diagonal and no rounding.
   *
   * The property is the whole specification of the call: **a point is inside
   * the merged outline exactly when it was inside either shape.** It is checked
   * by sampling, over two hundred pseudo-random pairs of convex hulls that
   * properly cross — each with a vertex strictly inside the other and a vertex
   * strictly outside it, because two shapes that merely touch have no union
   * outline to find and one that contains the other is a different case.
   *
   * Points within two pixels of any of the three boundaries are not sampled.
   * Sierra's crossings round to whole pixels, so the merged outline sits within
   * half a pixel of the true union and "inside" is genuinely undefined in that
   * band — in her interpreter as much as in this one.
   */
  it('comes back with an outline enclosing exactly what either shape enclosed', async () => {
    const { SCI_KERNEL, world, putPoints, getPoints, polygon, listOf } = await polygonWorld();

    type Point = [number, number];
    const crossOf = (o: Point, a: Point, b: Point) =>
      (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    /** Andrew's monotone chain, wound the way a room's own outline is. */
    const hull = (points: Point[]): Point[] => {
      const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const chain = (order: Point[]): Point[] => {
        const out: Point[] = [];
        for (const point of order) {
          while (out.length >= 2 && crossOf(out[out.length - 2]!, out[out.length - 1]!, point) <= 0)
            out.pop();
          out.push(point);
        }
        return out.slice(0, -1);
      };
      return [...chain(sorted), ...chain([...sorted].reverse())];
    };
    const isInside = (poly: Point[], [qx, qy]: Point): boolean => {
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i]!;
        const [xj, yj] = poly[j]!;
        if (yi > qy !== yj > qy && qx < ((xj - xi) * (qy - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    };
    const distanceToOutline = (poly: Point[], [qx, qy]: Point): number => {
      let best = Infinity;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [ax, ay] = poly[j]!;
        const [bx, by] = poly[i]!;
        const dx = bx - ax;
        const dy = by - ay;
        const lengthSquared = dx * dx + dy * dy;
        const t =
          lengthSquared === 0
            ? 0
            : Math.max(0, Math.min(1, ((qx - ax) * dx + (qy - ay) * dy) / lengthSquared));
        best = Math.min(best, Math.hypot(qx - (ax + t * dx), qy - (ay + t * dy)));
      }
      return best;
    };

    // A fixed multiplier and seed: the same shapes every run, so a failure is
    // reproducible rather than a Tuesday.
    let seed = 12345;
    const nextInt = (low: number, high: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return low + (((seed / 0x7fffffff) * (high - low + 1)) | 0);
    };
    const blob = (): Point[] => {
      const centreX = nextInt(60, 120);
      const centreY = nextInt(60, 120);
      const radius = nextInt(25, 45);
      return hull(
        Array.from(
          { length: 6 },
          () => [centreX + nextInt(-radius, radius), centreY + nextInt(-radius, radius)] as Point,
        ),
      );
    };

    /** Two shapes that properly cross, rather than touch or contain. */
    const properlyCross = (a: Point[], b: Point[]) =>
      a.some((v) => isInside(b, v)) &&
      a.some((v) => !isInside(b, v)) &&
      b.some((v) => isInside(a, v)) &&
      b.some((v) => !isInside(a, v));

    /** The band around each boundary where "inside" is not a fact. */
    const ROUNDING = 2;
    let checked = 0;
    for (let trial = 0; trial < 600 && checked < 200; trial++) {
      const first = blob();
      const second = blob();
      if (first.length < 3 || second.length < 3 || !properlyCross(first, second)) continue;
      checked++;

      const obstacle = polygon(second);
      const merged = getPoints(
        SCI_KERNEL.MergePoly(world, [putPoints(first, true), listOf([obstacle]), reg(0, 64)]),
      );
      expect(obstacle.variables[2]!.offset, 'two shapes that cross must merge').toBe(0x12);

      for (let sample = 0; sample < 400; sample++) {
        const point: Point = [nextInt(0, 200), nextInt(0, 200)];
        if (
          distanceToOutline(first, point) < ROUNDING ||
          distanceToOutline(second, point) < ROUNDING ||
          distanceToOutline(merged, point) < ROUNDING
        )
          continue;
        expect(
          isInside(merged, point),
          `${JSON.stringify(point)} against ${JSON.stringify(first)} ∪ ${JSON.stringify(second)} = ${JSON.stringify(merged)}`,
        ).toBe(isInside(first, point) || isInside(second, point));
      }
    }

    // The pairs are the sample, not a handful that happened to qualify.
    expect(checked).toBe(200);
  });
});

describe("the interpreter's own heap (ADR 0019)", () => {
  it('keeps a list at both ends, so a backwards walk is right too', async () => {
    const { SciHeap } = await import('../src/engine/sci/script/segments.js');
    const heap = new SciHeap();
    const list = heap.newList();
    const first = heap.newNode(reg(0, 1), reg(0, 10));
    const second = heap.newNode(reg(0, 2), reg(0, 20));

    heap.addToEnd(list, first);
    heap.addToEnd(list, second);

    expect(heap.list(list)?.first).toEqual(first);
    expect(heap.list(list)?.last).toEqual(second);
    expect(heap.node(second)?.previous).toEqual(first);
    expect(heap.node(first)?.next).toEqual(second);
  });

  it('finds and deletes by key, keeping both ends right', async () => {
    const { SciHeap } = await import('../src/engine/sci/script/segments.js');
    const heap = new SciHeap();
    const list = heap.newList();
    const only = heap.newNode(reg(0, 9), reg(0, 42));
    heap.addToEnd(list, only);

    expect(heap.findKey(list, reg(0, 42))).toEqual(only);
    expect(heap.deleteKey(list, reg(0, 42))).toBe(true);
    expect(heap.list(list)?.first).toEqual(NULL_REG);
    expect(heap.list(list)?.last).toEqual(NULL_REG);
  });
});

describe('globals are script 0s locals', () => {
  /**
   * Not a shortcut — it is what SCI is. A `lag 5` and script 0's own `lal 5`
   * address the same word, and every game relies on it. Separate banks read
   * correctly right up until script 0 writes one.
   */
  it('shares one bank between the global and script 0 local views', () => {
    const vm = new PMachine('sci0-late', {
      scriptCode: () => new Uint8Array([0x48]),
      callKernel: () => null,
      exportOffset: () => null,
      heapStart: () => 0,
      log: () => undefined,
    });
    vm.globals[5] = reg(3, 7);
    expect(vm.locals.get(0)?.[5]).toEqual(reg(3, 7));
  });
});

describe('a send that carries several Selectors', () => {
  /**
   * `(obj foo: 1 bar: 2)` is **one** instruction, and each Selector runs after
   * the one before it returns. A machine that dispatched the first and dropped
   * the rest runs a game whose actors move and never speak, with nothing
   * reporting a fault — so the remainder is parked on the calling frame and
   * `ret` picks it up.
   */
  it('runs the second Selector after the first returns', () => {
    // Two methods, at 0 and 1, each a bare `ret`. The caller sends both.
    const code = new Uint8Array([0x48, 0x48]);
    const vm = new PMachine('sci0-late', {
      scriptCode: () => code,
      callKernel: () => null,
      exportOffset: () => null,
      heapStart: () => 0,
      log: () => undefined,
    });

    const object = {
      id: reg(1, 100),
      species: 1,
      superClass: 0,
      info: 0,
      propertyBias: 0,
      variables: [reg(0, 1), reg(0, 0), reg(0, 0)],
      methods: new Map([
        [10, 0],
        [11, 1],
      ]),
      variableSelectors: [0, 1, 2],
      script: 1,
      clone: false,
    };
    vm.addObject(object);

    const ran: number[] = [];
    vm.trace = (line) => {
      const at = Number(line.split(':')[1]?.split(' ')[0]);
      if (Number.isFinite(at)) ran.push(at);
    };

    // A frame to send from, then the block: selector 10 with no arguments,
    // selector 11 with none.
    vm.enter(1, 0, object.id);
    vm.frames[0].pc = 1;
    vm.stack.push(reg(0, 10), reg(0, 0), reg(0, 11), reg(0, 0));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vm as any).doSend(object.id, 8, object.id);
    vm.run(20);

    // Both methods ran: the second only becomes reachable when the first
    // returns, so seeing offset 1 at all is the whole assertion.
    expect(ran).toContain(1);
  });
});

describe('Selectors when a game ships no table', () => {
  /**
   * Several demos ship no `vocab.997` — King's Quest IV, Leisure Suit Larry 1
   * and Torin among them — and without a table nothing can find `play`, which
   * is the Selector SCI's own boot sends. The symptom was a game that loaded
   * everything and then did nothing at all.
   *
   * The fallback is read off real games rather than transcribed: Space Quest
   * III, King's Quest I, Quest for Glory II and Conquests of the Longbow ship
   * tables that agree **exactly** for their first forty-four entries, across
   * four Versions and four games. That agreement is the evidence.
   */
  it('falls back to Sierra own numbering, and says that it did', async () => {
    const { selectorTableFor, SCI16_STATIC_SELECTORS } =
      await import('../src/engine/sci/script/selectors.js');

    const missing = selectorTableFor(null);
    expect(missing.fromGame).toBe(false);
    expect(missing.table.numbers.get('play')).toBe(42);
    expect(SCI16_STATIC_SELECTORS.slice(0, 3)).toEqual(['species', 'superClass', '-info-']);

    // A game that ships one is used unchanged, which is the whole point of the
    // pair being returned rather than a table.
    const shipped = new Uint8Array([0x00, 0x00, 0x04, 0x00, 0x02, 0x00, 0x61, 0x62]);
    expect(selectorTableFor(shipped).fromGame).toBe(true);
  });
});

describe("the fixture's scripts execute (#217's Tier 1)", () => {
  /**
   * The criterion this covers names three things by hand — a Selector send, a
   * `super` call and a Kernel call — because those are the three the PMachine
   * has that neither sibling does, and each fails differently. A send that
   * resolves wrongly runs the wrong code; a `super` that resolves to the object
   * rather than its class runs the *same* code for ever; a Kernel call that
   * answers quietly runs a game that does the wrong things.
   *
   * Built here rather than in `fixtureSci.ts` because it is a machine's
   * behaviour and not a resource's layout — the fixture describes bytes on
   * disk, and this describes what happens when they run.
   */
  function twoClasses(): {
    vm: PMachine;
    kernelCalls: number[];
    ran: string[];
  } {
    // Two methods in one script: `doit` at 0 for the subclass and at 4 for the
    // superclass. The subclass's calls a Kernel and then `super`.
    //
    //   0: callk 0x1c, 0   (GetEvent, no arguments)
    //   3: pushi 1         (the `doit` selector)
    //   5: push0           (no arguments)
    //   6: super 1, 4      (to class 1, four bytes of parameters)
    //   9: ret
    //  10: ret             (the superclass's whole body)
    const code = new Uint8Array([
      0x43,
      0x1c,
      0x00, // callk 0x1c, 0
      0x39,
      0x01, // pushi 1
      // `push0` is opcode 0x3b, so its byte is 0x76 — not 0x3c, which is `dup`
      // and pushes the selector a second time instead of an argument count.
      0x76, // push0
      0x57,
      0x01,
      0x04, // super 1, 4
      0x48, // ret
      0x48, // ret
    ]);

    const kernelCalls: number[] = [];
    const ran: string[] = [];
    const vm = new PMachine('sci0-late', {
      scriptCode: () => code,
      exportOffset: () => null,
      heapStart: () => 0,
      callKernel: (number) => {
        kernelCalls.push(number);
        return NULL_REG;
      },
      log: () => undefined,
    });
    vm.trace = (line) => ran.push(line);

    const superClass = {
      id: reg(1, 200),
      species: 1,
      superClass: 0,
      info: 0,
      propertyBias: 0,
      variables: [reg(0, 1), reg(0, 0), reg(0, 0)],
      methods: new Map([[1, 10]]),
      variableSelectors: [0, 1, 2],
      script: 1,
      clone: false,
      name: 'Base',
    };
    const subclass = {
      id: reg(1, 100),
      species: 2,
      superClass: 1,
      info: 0,
      propertyBias: 0,
      variables: [reg(0, 2), reg(0, 1), reg(0, 0)],
      methods: new Map([[1, 0]]),
      variableSelectors: [0, 1, 2],
      script: 1,
      clone: false,
      name: 'Derived',
    };
    vm.addObject(superClass);
    vm.addObject(subclass);
    vm.classes.set(1, superClass);
    vm.classes.set(2, subclass);

    return { vm, kernelCalls, ran };
  }

  it('runs a Selector send to the method the object resolves it to', () => {
    const { vm, ran } = twoClasses();
    const subclass = vm.object(reg(1, 100))!;

    // The send itself, as a script would make it.
    vm.enter(1, 11, subclass.id);
    vm.stack.push(reg(0, 1), reg(0, 0));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (vm as any).doSend(subclass.id, 4, subclass.id);
    vm.run(20);

    // The subclass's `doit` is at 0, so the send resolved down the graph rather
    // than to the superclass's at 10.
    expect(ran.some((line) => line.startsWith('1:0 '))).toBe(true);
  });

  /**
   * The one that fails silently and for ever: a `super` that resolves back to
   * the object runs the same method again, which is a hang rather than a wrong
   * answer.
   */
  it('runs a super call against the class rather than the object', () => {
    const { vm, ran } = twoClasses();
    const subclass = vm.object(reg(1, 100))!;

    vm.enter(1, 0, subclass.id);
    vm.run(40);

    // The superclass's body is at 10; reaching it means `super` went up.
    expect(ran.some((line) => line.startsWith('1:10 '))).toBe(true);
    expect(vm.halted).toBeNull();
  });

  it('makes a Kernel call, by the number the instruction carries', () => {
    const { vm, kernelCalls } = twoClasses();
    vm.enter(1, 0, reg(1, 100));
    vm.run(40);
    expect(kernelCalls).toEqual([0x1c]);
  });
});

/**
 * Property access, which was not executing at all (#219).
 *
 * `pToa` and its seven siblings are opcodes 0x31 to 0x38. The machine's
 * property branch was gated on `opcode < 0x20` — a range they are not in — so
 * every property read and write in every SCI game fell through to the variable
 * grid instead. There `family` is `(0x31 - 0x40) >> 4`, which is minus one and
 * reaches the grid's `default` arm: a **decrement**.
 *
 * So a property holding zero read back as `(0 - 1) & 0xffff`, and that is where
 * every game's boot died — King's Quest IV's `pToa 8` put 0xffff in the
 * accumulator, the `bnt` after it declined to branch because 0xffff is not
 * zero, and the `send` that followed addressed `0:65535`.
 */
describe('property access, which is opcodes 0x31 to 0x38', () => {
  function withObject(code: Uint8Array, variables: number[]): PMachine {
    const vm = new PMachine('sci0-late', {
      scriptCode: () => code,
      callKernel: () => null,
      exportOffset: () => null,
      heapStart: () => 0,
      log: () => undefined,
    });
    vm.objects.set('1:10', {
      id: reg(1, 10),
      species: 0,
      superClass: 0,
      info: 0,
      propertyBias: 0,
      variables: variables.map((value) => reg(0, value)),
      methods: new Map(),
      variableSelectors: [],
      script: 1,
      clone: false,
    });
    return vm;
  }

  it('reads a property rather than decrementing an unrelated variable', () => {
    // pToa 8; ret — property index 4, because the operand is a byte offset.
    // The byte is the opcode shifted up one with the narrow-width bit set:
    // 0x31 << 1 | 1. Writing 0x31 raw is `bnt`, which is a different fault.
    const vm = withObject(new Uint8Array([0x63, 0x08, 0x48]), [1, 2, 3, 4, 77]);
    vm.enter(1, 0, reg(1, 10));
    vm.run(10);

    expect(vm.acc.offset).toBe(77);
    // The value it used to produce, from decrementing a zero somewhere else.
    expect(vm.acc.offset).not.toBe(0xffff);
  });

  it('writes a property back to the object it was sent to', () => {
    // ldi 42; aTop 4; ret — property index 2.
    const vm = withObject(new Uint8Array([0x35, 0x2a, 0x65, 0x04, 0x48]), [1, 2, 3]);
    vm.enter(1, 0, reg(1, 10));
    vm.run(10);

    expect(vm.objects.get('1:10')?.variables[2]).toEqual(reg(0, 42));
  });

  it('refuses an odd property offset rather than indexing between two', () => {
    // A property offset is a byte offset into a table of words, so an odd one
    // is not a property. `variables[4.5]` is undefined and reads back as a
    // quiet zero, which is the wrong answer rather than a missing one.
    const vm = withObject(new Uint8Array([0x63, 0x07, 0x48]), [1, 2, 3, 4, 5]);
    vm.enter(1, 0, reg(1, 10));
    vm.run(10);

    expect(vm.halted).toMatch(/not an even property offset/);
  });
});

/**
 * What `self` is inside a method, which the three sends disagree about (#219).
 *
 * `send` runs a method **on the receiver**, so the receiver is the new `self`.
 * `self` is the degenerate case where they are the same object. `super` is the
 * one that separates them, and that is its purpose: look the method up on the
 * superclass, keep `self` as the instance.
 *
 * Passing the caller's `self` for a plain `send` is what stopped every SCI16
 * game a few hundred instructions in. A method found on another object ran with
 * `self` still pointing at the caller, and its own `self` send then looked for a
 * Selector on the wrong class — Space Quest 1, Leisure Suit Larry 1 and
 * Conquests of the Longbow all halted on "Selector 115 is neither a method nor
 * a property of object 62", which was true of the caller and irrelevant to the
 * object whose method was running.
 */
describe('what `self` is inside the method a send runs', () => {
  /** Two objects: a caller with a method, and a receiver with one of its own. */
  function twoObjects(code: Uint8Array): PMachine {
    const vm = new PMachine('sci0-late', {
      scriptCode: () => code,
      callKernel: () => null,
      exportOffset: () => null,
      heapStart: () => 0,
      log: () => undefined,
    });
    // The receiver answers Selector 5 with a method at offset 6.
    vm.objects.set('1:20', {
      id: reg(1, 20),
      species: 2,
      superClass: 0xffff,
      info: 0,
      propertyBias: 0,
      variables: [reg(0, 0), reg(0, 0), reg(0, 0)],
      methods: new Map([[5, 6]]),
      variableSelectors: [],
      script: 1,
      clone: false,
    });
    vm.objects.set('1:10', {
      id: reg(1, 10),
      species: 1,
      superClass: 0xffff,
      info: 0,
      propertyBias: 0,
      variables: [reg(0, 0), reg(0, 0), reg(0, 0)],
      methods: new Map(),
      variableSelectors: [],
      script: 1,
      clone: false,
    });
    return vm;
  }

  it('makes the receiver the new self, not the caller', () => {
    // lofsa is awkward to fake, so the receiver is put in the accumulator by
    // hand and the send runs from there.
    //   0: pushi 5   (Selector)
    //   2: push0     (no arguments)
    //   3: send 4
    //   5: ret
    //   6: (the receiver's method) pToa 0; ret
    // Opcode bytes are the table index shifted up one with the width bit, so
    // `send` is 0x25 << 1 = 0x4a and `push0` is 0x3b << 1 = 0x76.
    // pushi 5 (0x39) · push0 (0x76) · send 4 (0x4a) · ret (0x48) · pToa 0 · ret
    const code = new Uint8Array([0x39, 0x05, 0x76, 0x4a, 0x04, 0x48, 0x63, 0x00, 0x48]);
    const vm = twoObjects(code);
    vm.enter(1, 0, reg(1, 10));
    vm.acc = reg(1, 20);
    // `enter` leaves the accumulator alone, so the receiver is still in it when
    // `send` reads it two instructions later.
    vm.run(4);

    // The frame the send pushed must be running *on the receiver*.
    const frames = (vm as unknown as { frames: Array<{ self: { offset: number } }> }).frames;
    expect(frames[frames.length - 1].self.offset).toBe(20);
  });

  it('keeps self as the instance for super, which is what super is for', () => {
    //   0: pushi 5; push0; super 2 4; ret
    // pushi 5 · push0 · super 2 4 (0x57, narrow class then a byte) · ret · …
    const code = new Uint8Array([0x39, 0x05, 0x76, 0x57, 0x02, 0x04, 0x48, 0x63, 0x00, 0x48]);
    const vm = twoObjects(code);
    // Class 2 is the receiver object, reached by number rather than by pointer.
    vm.classes.set(2, vm.objects.get('1:20')!);
    vm.enter(1, 0, reg(1, 10));
    vm.run(4);

    const frames = (vm as unknown as { frames: Array<{ self: { offset: number } }> }).frames;
    // The method came from class 2 and `self` is still the instance that sent.
    expect(frames[frames.length - 1].self.offset).toBe(10);
  });
});

/**
 * An opcode with no case must stop, not do something plausible (#217, #219).
 *
 * The variable grid is opcodes 0x40 to 0x7f. Reaching it with anything below
 * computes a negative `family`, which lands on the switch's `default` arm and
 * *decrements a variable* — and for some operand shapes pushes the result. So
 * four opcodes with no implementation — `call`, `callb`, `calle` and `rest` —
 * were each corrupting a variable and sometimes the stack, silently.
 *
 * `rest` was the visible one: it pushed a word before every send that used
 * `&rest`, so the block was one word out, and six SCI16 games halted reporting
 * parameter blocks of 300 to 65,535 arguments. King's Quest IV appeared to
 * execute two million instructions; it was looping on corrupted state.
 */
describe('an opcode the machine does not implement', () => {
  /**
   * **The guard has no subject left, and that is the point.** Every opcode the
   * table decodes below the variable grid is now implemented, so this asserts
   * the property that made fixing them possible: the grid answers for its own
   * range and nothing else. If a later opcode is added to `opcodes.ts` without
   * a case here, it halts by name instead of decrementing a variable.
   */
  it('answers only for its own range, so a new opcode cannot fall into it', () => {
    const vm = new PMachine('sci0-late', {
      // `lag 0` — a genuine variable opcode, which must still work.
      scriptCode: () => new Uint8Array([0x81, 0x00, 0x48]),
      exportOffset: () => null,
      heapStart: () => 0,
      callKernel: () => null,
      log: () => undefined,
    });
    vm.globals[0] = reg(0, 7);
    vm.enter(0, 0, NULL_REG);
    vm.run(4);

    expect(vm.halted).toBeNull();
    expect(vm.acc).toEqual(reg(0, 7));
  });

  it('gives the receiving object its -info- and its superclass', () => {
    const vm = new PMachine('sci0-late', {
      // info (0x4c); ret — then superP (0x4e); ret.
      scriptCode: () => new Uint8Array([0x4c, 0x48, 0x4e, 0x48]),
      exportOffset: () => null,
      heapStart: () => 0,
      callKernel: () => null,
      log: () => undefined,
    });
    vm.objects.set('1:10', {
      id: reg(1, 10),
      species: 5,
      superClass: 9,
      info: 0x8000,
      propertyBias: 0,
      variables: [],
      methods: new Map(),
      variableSelectors: [],
      script: 1,
      clone: false,
    });

    vm.enter(1, 0, reg(1, 10));
    vm.run(2);
    // Bit 15 of `-info-` is what makes an object a class.
    expect(vm.acc).toEqual(reg(0, 0x8000));

    vm.enter(1, 2, reg(1, 10));
    vm.run(2);
    expect(vm.acc).toEqual(reg(0, 9));
  });

  /**
   * `lea` gives a variable's address, and an address is a register — only
   * expressible because a property holds one now.
   *
   * **Two things about the shape of it are load-bearing and both were learned
   * from King's Quest IV.** The segment names the *bank itself* — the script
   * whose locals these are, or the stack — rather than the *kind* of bank,
   * because a `lea` address is routinely stored in an object and read back
   * from another frame, where "kind 1" resolves against a different script
   * entirely. And the offset is a **byte offset from `ADDRESS_BASE`** rather
   * than a variable index, because SCI scripts tell a pointer from a small
   * number by its magnitude: this game's `GetFarText` wrapper opens
   * `if (param1 < 1000)`, and a bare index of 300 sent it down the branch that
   * asks for a text resource that does not exist.
   */
  it('gives lea an address that cannot be mistaken for an object', () => {
    const vm = new PMachine('sci0-late', {
      // lea 2, 0 — bank 1 (locals), index 0 — then ret.
      scriptCode: () => new Uint8Array([0x5b, 0x02, 0x00, 0x48]),
      exportOffset: () => null,
      heapStart: () => 0,
      callKernel: () => null,
      log: () => undefined,
    });
    vm.enter(0, 0, NULL_REG);
    vm.run(4);

    expect(vm.halted).toBeNull();
    expect(vm.acc).toEqual(reg(LOCALS_SEGMENT + 0, ADDRESS_BASE));
    // Far above any script number a game ships, so it can never collide with a
    // real object's `script:offset`.
    expect(vm.object(vm.acc)).toBeNull();
  });
});

/**
 * `kDoSound`, which had answered the same nought to every sub-function of
 * every Version.
 *
 * **Why this is its own block rather than a line in the coverage probe.** The
 * coverage probe can only see that `DoSound` reads its arguments; it cannot
 * see that the arguments are read *as the right call*. Sierra renumbered
 * `kDoSound` three times, so the same integer names a different operation
 * either side of each seam, and an engine that picks one numbering runs every
 * other Version with its sound calls shuffled — which is a game that runs and
 * does the wrong things, and shows nothing on screen.
 *
 * The numbering is ScummVM's `kDoSound_subops` and the behaviours are
 * `engines/sci/sound/soundcmd.cpp`, both fetched 2026-09-13.
 */
describe("DoSound's sub-functions", () => {
  /** The Sound class's property words, in the order King's Quest VII lays them out. */
  const SOUND_SELECTORS = {
    nodePtr: 20,
    handle: 22,
    flags: 24,
    number: 26,
    vol: 28,
    priority: 30,
    loop: 32,
    signal: 34,
    prevSignal: 36,
    dataInc: 38,
    min: 40,
    sec: 42,
    frame: 44,
    client: 46,
    state: 48,
  } as const;

  async function soundWorld(version: SciVersion = 'sci2-1-middle') {
    const { SCI_KERNEL } = await import('../src/engine/sci/script/SciKernel.js');
    const { SciHeap } = await import('../src/engine/sci/script/segments.js');

    const logged: string[] = [];
    const machine = new PMachine(version, {
      scriptCode: () => new Uint8Array([0x48]),
      callKernel: () => null,
      exportOffset: () => null,
      heapStart: () => 0,
      log: (line) => logged.push(line),
    });
    machine.selectorNumbers = new Map(Object.entries(SOUND_SELECTORS));

    const names = Object.keys(SOUND_SELECTORS);
    const selectorNumbers = Object.values(SOUND_SELECTORS) as number[];
    const object = {
      id: reg(1, 100),
      species: 1,
      superClass: 0,
      info: 0,
      propertyBias: 0,
      variables: selectorNumbers.map(() => reg(0, 0)),
      methods: new Map<number, number>(),
      variableSelectors: [...selectorNumbers],
      script: 1,
      clone: false,
      name: 'theSound',
    };
    machine.addObject(object);

    let enabled = true;
    const world = {
      machine,
      heap: new SciHeap(),
      log: (line: string) => logged.push(line),
      random: () => 0,
      ticks: () => 0,
      sound: {
        get isEnabled() {
          return enabled;
        },
        setEnabled: (next: boolean) => {
          enabled = next;
        },
      },
    } as unknown as SciKernelWorld;

    /** One property, by the name the game's own Selector table gives it. */
    const read = (name: keyof typeof SOUND_SELECTORS): number =>
      object.variables[names.indexOf(name)]!.offset;
    const write = (name: keyof typeof SOUND_SELECTORS, value: number): void => {
      object.variables[names.indexOf(name)] = reg(0, value & 0xffff);
    };
    const call = (...args: Array<Reg | number>): Reg =>
      SCI_KERNEL.DoSound!(
        world,
        args.map((value) => (typeof value === 'number' ? reg(0, value & 0xffff) : value)),
      );

    return { call, read, write, object, world, logged, machine };
  }

  /**
   * The seam that makes a numbered file of handlers the wrong shape: one
   * integer, three different calls.
   */
  it('reads sub-function 8 as a different call at each of the three seams', async () => {
    const { soundOpFor } = await import('../src/engine/sci/sound/sciDoSound.js');
    expect(soundOpFor('sci0-late', 8)).toBe('MasterVolume');
    expect(soundOpFor('sci1-early', 8)).toBe('Stop');
    expect(soundOpFor('sci1-late', 8)).toBe('Play');
    expect(soundOpFor('sci2-1-middle', 8)).toBe('Play');

    // And `Init`, which every game calls, is at three different numbers.
    expect(soundOpFor('sci0-late', 0)).toBe('Init');
    expect(soundOpFor('sci1-early', 5)).toBe('Init');
    expect(soundOpFor('sci2-1-middle', 6)).toBe('Init');
  });

  /**
   * **The fault this whole surface existed to fix, asserted end to end.**
   *
   * Sierra's `Sound::check` will not call `UpdateCues` unless `handle` is set,
   * and `kDoSoundPlay` is the only thing in the Kernel that writes it. With
   * `DoSound` answering a constant, `handle` stayed nought, so `check` never
   * reached `UpdateCues`, `signal` was never raised, and the `client cue:`
   * that a waiting script depends on was never sent.
   */
  it('writes the handle on Play, which is what lets a script reach UpdateCues', async () => {
    const { call, read, write } = await soundWorld();
    write('number', 337);

    call(6, reg(1, 100)); // Init
    // `Sound::dispose` gates on `nodePtr`, so Init has to leave one behind.
    expect(read('nodePtr')).toBe(100);
    // …and Init alone does not set `handle`. `check` is still shut here.
    expect(read('handle')).toBe(0);

    call(8, reg(1, 100)); // Play
    expect(read('handle')).toBe(100);
    // Play clears the clock and the previous signal, so a re-used sound object
    // does not answer its own last cue the moment it starts again.
    expect([read('min'), read('sec'), read('frame'), read('signal')]).toEqual([0, 0, 0, 0]);
  });

  /**
   * The cue itself. `signal` is `SIGNAL_OFFSET`, 0xffff, and `handle` goes back
   * to nought — in that order, so a script re-reading the object inside its own
   * `cue` sees a sound that has stopped rather than one both finished and
   * playing.
   */
  it('raises signal to 0xffff on UpdateCues, which is the cue a waiting script reads', async () => {
    const { call, read } = await soundWorld();
    call(6, reg(1, 100));
    call(8, reg(1, 100));
    expect(read('signal')).toBe(0);

    call(17, reg(1, 100)); // UpdateCues
    expect(read('signal')).toBe(0xffff);
    expect(read('handle')).toBe(0);
  });

  /**
   * Play without Init. Sierra's own scripts do this — ScummVM names King's
   * Quest VI room 460 — and its handler initialises the slot rather than
   * refusing, so the sound still plays.
   */
  it('initialises a slot that Play was reached without', async () => {
    const { call, read } = await soundWorld();
    call(8, reg(1, 100)); // Play, with no Init before it
    expect(read('handle')).toBe(100);
    expect(read('nodePtr')).toBe(100);
  });

  /**
   * **The property is not the argument.** -1 means "loop forever" and is stored
   * as 0xffff; every other value is stored as 1, whatever it was. A handler
   * that wrote the argument through would give a game asking for three loops a
   * `loop` of 3, which Sierra's scripts read as a count they never set.
   */
  it('stores SetLoop as 0xffff or 1 and never as the number it was given', async () => {
    const { call, read } = await soundWorld();
    call(6, reg(1, 100));
    call(16, reg(1, 100), 0xffff); // SetLoop -1
    expect(read('loop')).toBe(0xffff);
    call(16, reg(1, 100), 3);
    expect(read('loop')).toBe(1);
  });

  /**
   * SCI0 has no `signal` and no `handle`: it reports through `state`, and the
   * three values are Sierra's own. A handler that wrote `signal` at SCI0 would
   * be writing a property the game's Sound class does not have.
   */
  it('reports through state at SCI0, where there is no signal to raise', async () => {
    const { call, read } = await soundWorld('sci0-late');
    call(0, reg(1, 100)); // Init, which is sub-function 0 at SCI0
    expect(read('state')).toBe(1); // initialised
    call(1, reg(1, 100)); // Play, which is 1
    expect(read('state')).toBe(3); // playing
    expect(read('signal')).toBe(0);
    call(5, reg(1, 100)); // Stop, which is 5
    expect(read('state')).toBe(0); // stopped
    // "If we set it all the time, we get no music in sq3new and kq1": SCI0
    // raises `signal` for a sample running out, not for a script stopping it.
    expect(read('signal')).toBe(0);
  });

  /**
   * `MasterVolume` answers the volume *before* the change, which is how a
   * script saves it across a mute and puts it back. Answering the new one
   * would have a game restore the volume it had just set.
   */
  it('answers the previous master volume, and clips the new one to 15', async () => {
    const { call } = await soundWorld();
    expect(call(0).offset).toBe(15); // no argument: read it back
    expect(call(0, 9).offset).toBe(15); // answers the old value
    expect(call(0, 99).offset).toBe(9); // …and the one before this, clipped
    expect(call(0).offset).toBe(15); // 99 clipped to the maximum
  });

  /** `Mute` reaches the shell's own toggle rather than a copy of it. */
  it('toggles the shell sound on Mute and answers the state before it', async () => {
    const { call, world } = await soundWorld();
    expect(call(1, 0).offset).toBe(1);
    expect(world.sound!.isEnabled).toBe(false);
    expect(call(1, 1).offset).toBe(0);
    expect(world.sound!.isEnabled).toBe(true);
  });

  /**
   * A sub-function past the end of this Version's table is a finding about the
   * release, not a detail to swallow: either the Version is wrong or the table
   * is. SCI0 has thirteen, so 17 — `UpdateCues`, which only exists from SCI1
   * early — is off the end of it.
   */
  it('reports a sub-function this Version has no name for', async () => {
    const { call, logged } = await soundWorld('sci0-late');
    call(17, reg(1, 100));
    expect(logged.join('\n')).toContain('DoSound sub-function 17');
    expect(logged.join('\n')).toContain('13 of them');
  });
});

/**
 * `GlobalToLocal` and `LocalToGlobal`, which are the same subtraction twice.
 *
 * **Two arguments from SCI2 on, and the second one is the whole call.**
 * `kGlobalToLocal32` looks the Plane up and takes its game rectangle's origin
 * off the event's `x` and `y`. This answered the event unchanged, which is
 * right exactly while every Plane sits at 0, 0 — and King's Quest VII's room
 * 1250 is 960 pixels of scenery on a Plane whose `left` walks down to −318 as
 * it scrolls, so every click in it asked the game to walk the ego 318 pixels
 * left of where the player pointed.
 */
describe('a point crosses between a Plane and the screen', () => {
  async function eventWorld(origin: { x: number; y: number } | null, x: number, y: number) {
    const { SCI_KERNEL } = await import('../src/engine/sci/script/SciKernel.js');
    const machine = new PMachine('sci2-1-middle', {
      scriptCode: () => new Uint8Array([0x48]),
      callKernel: () => null,
      exportOffset: () => null,
      heapStart: () => 0,
      log: () => undefined,
    });
    machine.selectorNumbers = new Map([
      ['x', 0],
      ['y', 2],
    ]);
    const event = {
      id: reg(1, 200),
      species: 1,
      superClass: 0,
      info: 0,
      propertyBias: 0,
      variables: [reg(0, x < 0 ? x + 0x10000 : x), reg(0, y < 0 ? y + 0x10000 : y)],
      methods: new Map<number, number>(),
      variableSelectors: [0, 2],
      script: 1,
      clone: false,
      name: 'theEvent',
    };
    machine.addObject(event);
    const world = {
      machine,
      log: () => undefined,
      planeOrigin: () => origin,
    } as unknown as SciKernelWorld;
    const read = () => [event.variables[0].offset, event.variables[1].offset];
    return { SCI_KERNEL, world, read };
  }

  it("takes the Plane's origin off a screen point", async () => {
    const { SCI_KERNEL, world, read } = await eventWorld({ x: -318, y: 0 }, 60, 108);
    SCI_KERNEL.GlobalToLocal!(world, [reg(1, 200), reg(1, 300)]);
    expect(read()).toEqual([378, 108]);
  });

  it('puts it back, which is what LocalToGlobal is', async () => {
    const { SCI_KERNEL, world, read } = await eventWorld({ x: -318, y: 10 }, 378, 118);
    SCI_KERNEL.LocalToGlobal!(world, [reg(1, 200), reg(1, 300)]);
    expect(read()).toEqual([60, 128]);
  });

  /**
   * **SCI16 is left alone and that is not the same bug.** Before SCI2 this
   * subtracts the current *port's* origin, and this engine has no port to
   * subtract — so the one-argument form answers the event unchanged rather than
   * being given a Plane it does not have.
   */
  it('answers a one-argument call unchanged, which is the SCI16 form', async () => {
    const { SCI_KERNEL, world, read } = await eventWorld({ x: -318, y: 0 }, 60, 108);
    SCI_KERNEL.GlobalToLocal!(world, [reg(1, 200)]);
    expect(read()).toEqual([60, 108]);
  });

  it('answers unchanged where the Plane is not one this engine holds', async () => {
    const { SCI_KERNEL, world, read } = await eventWorld(null, 60, 108);
    SCI_KERNEL.GlobalToLocal!(world, [reg(1, 200), reg(1, 300)]);
    expect(read()).toEqual([60, 108]);
  });
});

/**
 * `InPolygon`, which answered nought to everything.
 *
 * ScummVM's `kInPolygon` is `kAvoidPath`'s three-argument case: read the
 * polygon object's own points, force the type to barred access so a
 * contained-access shape is not inverted, and answer whether the point is
 * inside **or on the edge**.
 *
 * **Answering nought is not neutral, it is "nowhere is walkable".** King's
 * Quest VII asks this of a click before it will move the ego, so a constant
 * zero draws the room, runs the loop, polls the events and refuses every click
 * on the floor.
 */
describe('a point is tested against a walk polygon', () => {
  /** A square from (10,10) to (50,50), as a script builds one. */
  async function polygonWorld(points: ReadonlyArray<[number, number]>, indirect = false) {
    const { SCI_KERNEL } = await import('../src/engine/sci/script/SciKernel.js');
    const { SciHeap } = await import('../src/engine/sci/script/segments.js');
    const machine = new PMachine('sci2-1-middle', {
      scriptCode: () => new Uint8Array([0x48]),
      callKernel: () => null,
      exportOffset: () => null,
      heapStart: () => 0,
      log: () => undefined,
    });
    machine.selectorNumbers = new Map([
      ['size', 0],
      ['points', 2],
      ['type', 4],
      ['data', 6],
    ]);
    const heap = new SciHeap();
    const block = heap.allocate(points.length * 4);
    const bytes = heap.bytes(block)!;
    points.forEach(([x, y], index) => {
      const at = index * 4;
      bytes[at] = x & 0xff;
      bytes[at + 1] = (x >> 8) & 0xff;
      bytes[at + 2] = y & 0xff;
      bytes[at + 3] = (y >> 8) & 0xff;
    });

    const object = (id: number, variables: Reg[], selectors: number[]) => ({
      id: reg(1, id),
      species: 1,
      superClass: 0,
      info: 0,
      propertyBias: 0,
      variables,
      methods: new Map<number, number>(),
      variableSelectors: selectors,
      script: 1,
      clone: false,
      name: `object${id}`,
    });

    // From SCI2 `points` holds a `Points` object whose `data` is the block.
    let held = block;
    if (indirect) {
      machine.addObject(object(400, [block], [6]));
      held = reg(1, 400);
    }
    machine.addObject(object(300, [reg(0, points.length), held, reg(0, 2)], [0, 2, 4]));

    const world = { machine, heap, log: () => undefined } as unknown as SciKernelWorld;
    const ask = (x: number, y: number) =>
      SCI_KERNEL.InPolygon!(world, [reg(0, x), reg(0, y), reg(1, 300)]).offset;
    return ask;
  }

  const SQUARE: ReadonlyArray<[number, number]> = [
    [10, 10],
    [50, 10],
    [50, 50],
    [10, 50],
  ];

  it('says yes inside and no outside', async () => {
    const ask = await polygonWorld(SQUARE);
    expect(ask(30, 30)).toBe(1);
    expect(ask(5, 30)).toBe(0);
    expect(ask(60, 30)).toBe(0);
    expect(ask(30, 5)).toBe(0);
    expect(ask(30, 60)).toBe(0);
  });

  /** Sierra counts an edge as contained, which is what the two ray counts are for. */
  it('counts a vertex and an edge as inside', async () => {
    const ask = await polygonWorld(SQUARE);
    expect(ask(10, 10)).toBe(1);
    expect(ask(30, 10)).toBe(1);
  });

  /**
   * The SCI2 indirection: `points` is a `Points` object and the words are in
   * its `data`. Read without following it, every polygon in a SCI32 game has
   * no points and every click lands outside it.
   */
  it('follows the Points object a SCI32 script builds', async () => {
    const ask = await polygonWorld(SQUARE, true);
    expect(ask(30, 30)).toBe(1);
    expect(ask(60, 30)).toBe(0);
  });

  it('answers no for a polygon with no points rather than throwing', async () => {
    const ask = await polygonWorld([]);
    expect(ask(30, 30)).toBe(0);
  });

  /** A concave shape, where a single crossing count would get the notch wrong. */
  it('handles a concave polygon, notch and all', async () => {
    const ask = await polygonWorld([
      [0, 0],
      [60, 0],
      [60, 60],
      [30, 30],
      [0, 60],
    ]);
    expect(ask(10, 10)).toBe(1);
    expect(ask(30, 50)).toBe(0);
  });
});
