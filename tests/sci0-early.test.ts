/**
 * SCI0 early, which is the Version King's Quest IV 1.000.111 shipped on.
 *
 * Three things move at this seam and all three are the same fact seen from
 * different places: **Sierra spent the low bit of a Selector ID on a
 * read/write toggle**. So the numbering is doubled, a lookup has to mask, and
 * `callk` — alone among the parameter-block consumers — leaves `&rest` alone,
 * because ScummVM's `op_callk` guards all three of its `r_rest` lines with
 * `if (!oldScriptHeader)`.
 *
 * Every one of them was found on the real game and each was hiding the next:
 * undoubled, the game object answered no `play` at all; masked but with
 * `callk` spending the adjustment, `firstTrue` handed `NodeValue` the wrong
 * word and the game halted on "send to 0:0".
 */

import { describe, expect, it } from 'vitest';

import { NULL_REG, PMachine, reg } from '../src/engine/sci/script/PMachine.js';
import { readSelectorTable, selectorTableFor } from '../src/engine/sci/script/selectors.js';
import { selectorIdCarriesReadWriteBit } from '../src/engine/sci/sciVersion.js';

/** A `vocab.997`: a short count, then an offset each, then the strings. */
function selectorVocab(names: string[]): Uint8Array {
  const header = 2 + names.length * 2;
  const bodies = names.map((name) => {
    const bytes = new Uint8Array(2 + name.length);
    bytes[0] = name.length & 0xff;
    bytes[1] = name.length >> 8;
    for (let i = 0; i < name.length; i++) bytes[2 + i] = name.charCodeAt(i);
    return bytes;
  });
  const out = new Uint8Array(header + bodies.reduce((total, b) => total + b.length, 0));
  out[0] = (names.length - 1) & 0xff;
  out[1] = (names.length - 1) >> 8;
  let at = header;
  for (const [index, body] of bodies.entries()) {
    out[2 + index * 2] = at & 0xff;
    out[2 + index * 2 + 1] = (at >> 8) & 0xff;
    out.set(body, at);
    at += body.length;
  }
  return out;
}

describe('which Versions carry the read/write bit', () => {
  it('is SCI0 early and nothing else', () => {
    expect(selectorIdCarriesReadWriteBit('sci0-early')).toBe(true);
    for (const version of ['sci0-late', 'sci01', 'sci1-early', 'sci1-1', 'sci3'] as const) {
      expect(selectorIdCarriesReadWriteBit(version)).toBe(false);
    }
  });
});

describe('the Selector table a SCI0 early game ships', () => {
  const vocab = selectorVocab(['species', 'superClass', '-info-', 'y', 'x']);

  /**
   * The measurement that named this: King's Quest IV ships 255 Selector names
   * and its own game object's method dictionary asks for 444 and 446. No
   * 255-entry table can answer those, and a doubled one answers 510.
   */
  it('answers twice as many numbers as it has names', () => {
    const doubled = readSelectorTable(vocab, { lsbToggle: true });

    expect(doubled.names).toHaveLength(10);
    expect(doubled.names[4]).toBe('-info-');
    expect(doubled.names[5]).toBe('-info-');
  });

  it('names each Selector at the even number a read would send', () => {
    const doubled = readSelectorTable(vocab, { lsbToggle: true });

    expect(doubled.numbers.get('species')).toBe(0);
    expect(doubled.numbers.get('superClass')).toBe(2);
    expect(doubled.numbers.get('x')).toBe(8);
  });

  it('is read straight through for every later Version', () => {
    const plain = readSelectorTable(vocab);

    expect(plain.names).toHaveLength(5);
    expect(plain.numbers.get('x')).toBe(4);
  });

  /**
   * ScummVM duplicates the static table on the same condition it duplicates a
   * shipped one, and a game with no `vocab.997` sends the same doubled IDs as
   * one with it.
   */
  it('doubles the fallback numbering too, for a game that ships no table', () => {
    const { table, fromGame } = selectorTableFor(null, { lsbToggle: true });

    expect(fromGame).toBe(false);
    expect(table.numbers.get('play')).toBe(84);
    expect(table.numbers.get('doit')).toBe(120);
    // And undoubled it is Sierra's ordinary SCI16 numbering.
    expect(selectorTableFor(null).table.numbers.get('play')).toBe(42);
  });
});

describe('a lookup on a SCI0 early object', () => {
  function machine(version: 'sci0-early' | 'sci0-late'): PMachine {
    return new PMachine(version, {
      scriptCode: () => new Uint8Array(0),
      callKernel: () => null,
      exportOffset: () => null,
      heapStart: () => 0,
      log: () => undefined,
    });
  }

  /**
   * The class dictionaries hold only the even form, so a write — which arrives
   * as the odd one — has to be masked before it is looked up. King's Quest
   * IV's script 994 sends 413 to a class whose dictionary lists 412.
   */
  it('masks the low bit off, so a write finds the property a read finds', () => {
    const early = machine('sci0-early');

    expect(early.normaliseSelector(412)).toBe(412);
    expect(early.normaliseSelector(413)).toBe(412);
  });

  it('leaves an odd Selector alone on a later Version, where it is a number', () => {
    expect(machine('sci0-late').normaliseSelector(413)).toBe(413);
  });
});

describe('&rest across a Kernel call', () => {
  /**
   * `firstTrue`, from King's Quest IV's script 999, in the shape that found
   * this: the `&rest` belongs to the `send`, and a `callk` between the two
   * must not spend it.
   *
   * `push0` is the send's argument count, `rest` adds this frame's leftover
   * arguments to it, and the `callk` in the middle computes the receiver.
   * Spending the adjustment at the `callk` handed the Kernel the word `&rest`
   * had pushed instead of the node, and the game halted three instructions
   * later on "send to 0:0".
   */
  function runRestThenCallk(version: 'sci0-early' | 'sci0-late'): number[] {
    let sawArgs: number[] = [];
    // push0 · rest 1 · push1 · pushi 99 · callk 0, 2 · ret
    //   Raw bytes: an opcode is `raw >> 1` and the low bit selects an 8-bit
    //   operand, so `push0` (0x3b) is 0x76, `rest` (0x2c) is 0x59 and `callk`
    //   (0x21) is 0x43.
    const code = new Uint8Array([0x76, 0x59, 0x01, 0x78, 0x39, 0x63, 0x43, 0x00, 0x02, 0x48]);
    const vm = new PMachine(version, {
      scriptCode: () => code,
      callKernel: (_number, args) => {
        sawArgs = args.map((value) => value.offset);
        return NULL_REG;
      },
      exportOffset: () => null,
      heapStart: () => 0,
      log: () => undefined,
    });
    // One argument, so `rest 1` has exactly one word to hand on.
    vm.enter(0, 0, NULL_REG, [reg(0, 7)]);
    vm.run(20);
    return sawArgs;
  }

  it('leaves the adjustment for the send, on SCI0 early', () => {
    // The Kernel call takes its own one argument — 99 — and nothing else, so
    // the word `&rest` pushed is still there for the send that follows.
    expect(runRestThenCallk('sci0-early')).toEqual([99]);
  });

  it('spends the adjustment at the Kernel call, from SCI0 late on', () => {
    // Two words instead, read one lower down the stack — which is exactly the
    // shift that handed King's Quest IV's `NodeValue` the wrong word.
    expect(runRestThenCallk('sci0-late')).toEqual([1, 99]);
  });
});

describe('a SCI0 script’s export table', () => {
  /**
   * ScummVM's `Script::load` names the two it knows: "script 912 in Camelot and
   * script 306 in KQ4". King's Quest IV's script 306 ships a one-entry table at
   * offset 6 and a two-entry one at 14, and the first is the broken one.
   */
  it('is the last block, because a few scripts ship two and the first is broken', async () => {
    const { readSci0Blocks, readSci0Exports } =
      await import('../src/engine/sci/script/scriptResource.js');

    // Two `exports` blocks — type 7 — one after the other, then a terminator.
    // Each block's size counts its own four-byte header.
    const script = new Uint8Array([
      0x07,
      0x00,
      0x08,
      0x00, // exports, 8 bytes: header + count + one entry
      0x01,
      0x00,
      0x11,
      0x11, // count 1, offset 0x1111 — the broken table
      0x07,
      0x00,
      0x0a,
      0x00, // exports, 10 bytes: header + count + two entries
      0x02,
      0x00,
      0x22,
      0x22,
      0x33,
      0x33, // count 2 — the real one
      0x00,
      0x00, // terminator
    ]);

    const blocks = readSci0Blocks(script, 0);
    expect(blocks.filter((block) => block.type === 'exports')).toHaveLength(2);
    expect(readSci0Exports(script, blocks)).toEqual([0x2222, 0x3333]);
  });
});

describe('a string, wherever the script put it', () => {
  /**
   * **Three spaces, and a reader that knew one.** A SCI string lives on the
   * heap, in a script's own data, or packed two characters to a word inside a
   * variable bank — `lea` hands out the address of a local and a string built
   * at runtime goes there. King's Quest IV's button labels are literals in
   * script 699 and the line measured beside them is in a local, so a
   * heap-only reader answered `""` for both: `TextSize` measured nothing,
   * every control's rect stayed 4,4,4,4, and `DrawControl` had nothing to draw.
   */
  it('reads one out of a variable bank, two characters to a word', async () => {
    const { ADDRESS_BASE, LOCALS_SEGMENT, PMachine, reg } =
      await import('../src/engine/sci/script/PMachine.js');
    const machine = new PMachine('sci0-early', {
      scriptCode: () => new Uint8Array(0),
      callKernel: () => null,
      exportOffset: () => null,
      heapStart: () => 0,
      log: () => undefined,
    });
    machine.enter(0, 0, reg(0, 0));

    // "Yes" packed little-endian: 'Y','e' then 's','\0'.
    const globals = machine.globals;
    globals[4] = reg(0, 0x65 * 256 + 0x59);
    globals[5] = reg(0, 0x0073);

    const view = machine.byteViewAt(reg(LOCALS_SEGMENT + 0, ADDRESS_BASE + 4 * 2))!;
    let text = '';
    for (let at = 0; at < view.length; at++) {
      const byte = view.get(at);
      if (byte === 0) break;
      text += String.fromCharCode(byte);
    }

    expect(text).toBe('Yes');
  });

  it('writes one back into the same bank, a byte at a time', async () => {
    const { ADDRESS_BASE, LOCALS_SEGMENT, PMachine, reg } =
      await import('../src/engine/sci/script/PMachine.js');
    const machine = new PMachine('sci0-early', {
      scriptCode: () => new Uint8Array(0),
      callKernel: () => null,
      exportOffset: () => null,
      heapStart: () => 0,
      log: () => undefined,
    });
    machine.enter(0, 0, reg(0, 0));

    const view = machine.byteViewAt(reg(LOCALS_SEGMENT + 0, ADDRESS_BASE))!;
    view.set(0, 0x4e); // 'N'
    view.set(1, 0x6f); // 'o'
    view.set(2, 0);

    // The two characters share one word, which is the whole point of the view.
    expect(machine.globals[0].offset).toBe(0x6f4e);
  });

  /**
   * A reference into a script is far more often an *object* than a string, and
   * reading one as text produces a plausible run of letters out of a property
   * table. The two are indistinguishable from the register alone, so the
   * machine answers with what it knows: an address it has an object at is not
   * bytes.
   */
  it('refuses to read an object as text', async () => {
    const { PMachine, reg } = await import('../src/engine/sci/script/PMachine.js');
    const machine = new PMachine('sci0-early', {
      scriptCode: () => new Uint8Array([0x48, 0x59, 0x65, 0x73, 0x00]),
      callKernel: () => null,
      exportOffset: () => null,
      heapStart: () => 0,
      log: () => undefined,
    });

    expect(machine.byteViewAt(reg(1, 1))).not.toBeNull();

    machine.addObject({
      id: reg(1, 1),
      species: 0,
      superClass: 0,
      info: 0,
      propertyBias: 0,
      variables: [],
      methods: new Map<number, number>(),
      variableSelectors: [],
      script: 1,
      clone: false,
    });

    expect(machine.byteViewAt(reg(1, 1))).toBeNull();
  });
});

describe('a SCI16 window, and the port inside it', () => {
  /**
   * **A control's rectangle is measured from the port, not from the screen.**
   * The port is the inside of the window the script opened — past the frame
   * and past the title bar — so a dialog whose buttons sit at 4,4 belongs four
   * pixels inside its window and not four pixels into the room.
   */
  it('puts the port past the frame and the title bar', async () => {
    const { SciEngine } = await import('../src/engine/sci/SciEngine.js');
    const engine = Object.create(SciEngine.prototype) as unknown as {
      windows: Map<number, { contentLeft: number; contentTop: number }>;
      currentPort: number;
      portOrigin(): { x: number; y: number };
    };
    engine.windows = new Map();
    engine.currentPort = 0;

    // With no window open the port is the screen itself.
    expect(engine.portOrigin()).toEqual({ x: 0, y: 0 });

    engine.windows.set(1, { contentLeft: 8, contentTop: 26 });
    engine.currentPort = 1;
    expect(engine.portOrigin()).toEqual({ x: 8, y: 26 });
  });
});

describe('Display’s attribute list', () => {
  /**
   * Sierra's codes, from ScummVM's `paint16.cpp`. This project had font at 102
   * — which is the *pen colour* — and the foreground at 103, which is the
   * *background*, so a game asking for a font got a colour and the walk
   * stopped at the first code it did not know.
   */
  it('reads the pen colour, the font and the width at Sierra’s own numbers', async () => {
    const { SCI_KERNEL } = await import('../src/engine/sci/script/SciKernel.js');
    const { reg, NULL_REG } = await import('../src/engine/sci/script/PMachine.js');

    let drawn: { text: string; options: Record<string, number> } | null = null;
    const world = {
      machine: { byteViewAt: () => null },
      heap: { bytes: () => null },
      log: () => undefined,
      farText: (resource: number, index: number) =>
        resource === 700 && index === 2 ? 'a line' : null,
      showText: (text: string, options: Record<string, number>) => {
        drawn = { text, options };
        return true;
      },
    } as never;

    // Display(700, 2, MOVEPEN 20 40, FONT 4, PENCOLOUR 9, WIDTH 200)
    SCI_KERNEL.Display(world, [
      reg(0, 700),
      reg(0, 2),
      reg(0, 100),
      reg(0, 20),
      reg(0, 40),
      reg(0, 105),
      reg(0, 4),
      reg(0, 102),
      reg(0, 9),
      reg(0, 106),
      reg(0, 200),
      NULL_REG,
    ]);

    expect(drawn).not.toBeNull();
    expect(drawn!.text).toBe('a line');
    // `MOVEPEN` is y then x, which is Sierra's order and not the one a reader
    // expects, so it is asserted rather than assumed.
    expect(drawn!.options).toMatchObject({ y: 20, x: 40, font: 4, colour: 9, width: 200 });
  });
});
