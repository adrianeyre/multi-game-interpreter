import { describe, expect, it } from 'vitest';
import {
  CP,
  IR,
  isSword2Token,
  sword2InstructionLength,
  sword2TokenName,
} from '../src/engine/sword2/script/sword2Tokens.js';
import {
  parseSword2Object,
  runSword2Script,
  SWORD2_SCRIPT_ID,
  SWORD2_STACK_SIZE,
  type Sword2ObjectLayout,
  type Sword2ScriptHost,
} from '../src/engine/sword2/script/Sword2Interpreter.js';
import {
  disassembleSword2Object,
  formatSword2Disassembly,
  formatSword2Instruction,
  reassembleSword2Code,
  roundTripsSword2Object,
} from '../src/authoring/sword2/disassemble.js';
import {
  decodeSword2Frame,
  decompressRLE16,
  decompressRLE256,
  parseSword2Parallax,
  unwindRaw16,
} from '../src/engine/sword2/gfx/sword2Decode.js';
import { SWORD2_OPCODE_COUNT, sword2OpcodeName } from '../src/engine/sword2/script/opcodeNames.js';
import {
  buildSword2Anim,
  buildSword2Globals,
  buildSword2Icon,
  buildSword2Object,
  buildSword2ParallaxLayer,
} from './fixtureSword.js';
import {
  SWORD2_BOTTOM_MENU_TOP,
  SWORD2_ICON_DEPTH,
  SWORD2_ICON_SPACING,
  SWORD2_ICON_START,
  SWORD2_ICON_WIDTH,
  SWORD2_MENU,
} from '../src/engine/sword2/Sword2Menu.js';
import { Sword2Logic } from '../src/engine/sword2/script/Sword2Logic.js';
import type { Sword2LogicHost } from '../src/engine/sword2/script/Sword2Logic.js';
import type { Sword2Resources } from '../src/engine/sword2/resource/Sword2Resources.js';

/** Little-endian helpers, so a test reads like the encoding it is testing. */
function i16(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}
function i32(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff];
}

function host(overrides: Partial<Sword2ScriptHost> = {}): Sword2ScriptHost & {
  vars: Map<number, number>;
  calls: Array<{ number: number; params: number[] }>;
  faults: string[];
} {
  const vars = new Map<number, number>();
  const calls: Array<{ number: number; params: number[] }> = [];
  const faults: string[] = [];
  return {
    vars,
    calls,
    faults,
    getVar: (number) => vars.get(number) ?? 0,
    setVar: (number, value) => void vars.set(number, value),
    callMcode: (number, params) => {
      calls.push({ number, params: Array.from(params.subarray(0, 4)) });
      return IR.CONT;
    },
    encodeOffset: () => 1,
    onFault: (message) => void faults.push(message),
    ...overrides,
  };
}

function object(code: number[], locals = 4): Sword2ObjectLayout {
  return parseSword2Object(buildSword2Object('fixture', [code], locals));
}

describe('the token table', () => {
  it('derives every instruction length from the instruction itself', () => {
    const code = Uint8Array.from([
      CP.PUSH_INT32,
      ...i32(7),
      CP.CALL_MCODE,
      ...i16(16),
      2,
      CP.PUSH_STRING,
      3,
      0x61,
      0x62,
      0x63,
      0,
      CP.SWITCH,
      ...i32(2),
      ...i32(1),
      ...i32(8),
      ...i32(2),
      ...i32(8),
      ...i32(8),
      CP.END_SCRIPT,
    ]);
    expect(sword2InstructionLength(code, 0)).toBe(5);
    expect(sword2InstructionLength(code, 5)).toBe(4);
    expect(sword2InstructionLength(code, 9)).toBe(2 + 3 + 1);
    expect(sword2InstructionLength(code, 15)).toBe(1 + 4 + 2 * 8 + 4);
  });

  it('answers zero for a byte that is not a token, so data is told from code', () => {
    expect(sword2InstructionLength(Uint8Array.from([200]), 0)).toBe(0);
    expect(isSword2Token(200)).toBe(false);
    expect(sword2TokenName(200)).toBe('token200');
  });
});

describe('reading a game object', () => {
  it('finds the locals, the offset table and the code from the resource itself', () => {
    const layout = object([CP.END_SCRIPT], 6);
    expect(layout.name).toBe('fixture');
    expect(layout.localsBytes).toBe(24);
    expect(layout.scriptCount).toBe(1);
    expect(layout.codeBytes).toBe(1);
    expect(layout.checksumOk).toBe(true);
  });

  it('refuses a resource whose script identifier is not 12345678', () => {
    const bytes = buildSword2Object('fixture', [[CP.END_SCRIPT]]);
    // Find and corrupt the identifier.
    const view = new DataView(bytes.buffer);
    for (let at = 0; at + 4 <= bytes.length; at += 1) {
      if (view.getUint32(at, true) === SWORD2_SCRIPT_ID) {
        view.setUint32(at, 1, true);
        break;
      }
    }
    expect(() => parseSword2Object(bytes)).toThrow(/not a game object/);
  });

  it('reports a checksum mismatch without refusing, as ScummVM does', () => {
    const bytes = buildSword2Object('fixture', [[CP.PUSH_INT32, ...i32(1), CP.END_SCRIPT]]);
    // Flip a code byte after the checksum was computed.
    bytes[bytes.length - 1] ^= 0xff;
    expect(parseSword2Object(bytes).checksumOk).toBe(false);
  });
});

describe('the script machine', () => {
  it('pushes a constant, adds and pops to a global', () => {
    const scriptHost = host();
    const layout = object([
      CP.PUSH_INT32,
      ...i32(20),
      CP.PUSH_INT32,
      ...i32(22),
      CP.OP_PLUS,
      CP.POP_GLOBAL_VAR32,
      ...i16(5),
      CP.END_SCRIPT,
    ]);
    const result = runSword2Script(layout, scriptHost, 0);
    expect(result.result).toBe(IR.CONT);
    expect(scriptHost.vars.get(5)).toBe(42);
  });

  it('keeps locals in the object’s own resource, so they persist', () => {
    const scriptHost = host();
    const layout = object([CP.PUSH_INT32, ...i32(9), CP.POP_LOCAL_VAR32, ...i16(4), CP.END_SCRIPT]);
    runSword2Script(layout, scriptHost, 0);
    const view = new DataView(layout.bytes.buffer, layout.bytes.byteOffset);
    expect(view.getInt32(layout.localsAt + 4, true)).toBe(9);
  });

  it('pops operands so the left operand is the deeper one', () => {
    const scriptHost = host();
    const layout = object([
      CP.PUSH_INT32,
      ...i32(10),
      CP.PUSH_INT32,
      ...i32(3),
      CP.OP_MINUS,
      CP.POP_GLOBAL_VAR32,
      ...i16(1),
      CP.END_SCRIPT,
    ]);
    runSword2Script(layout, scriptHost, 0);
    expect(scriptHost.vars.get(1)).toBe(7);
  });

  it('quits for a cycle and resumes at the next instruction', () => {
    const layout = object([
      CP.PUSH_INT32,
      ...i32(1),
      CP.QUIT,
      CP.POP_GLOBAL_VAR32,
      ...i16(2),
      CP.END_SCRIPT,
    ]);
    const first = runSword2Script(layout, host(), 0);
    expect(first.result).toBe(IR.STOP);
    expect(first.offset).toBe(6);
  });

  it('terminates without moving the offset, so the same script restarts', () => {
    const layout = object([CP.PUSH_INT32, ...i32(1), CP.TERMINATE, CP.END_SCRIPT]);
    const result = runSword2Script(layout, host(), 0);
    expect(result.result).toBe(IR.TERMINATE);
    expect(result.offset).toBe(0);
  });

  it('skips relative to the operand’s own position, not past it', () => {
    const scriptHost = host();
    // A false condition skips by 9: past the operand (4) and past the
    // five-byte push that follows.
    const layout = object([
      CP.PUSH_INT32,
      ...i32(0),
      CP.SKIPONFALSE,
      ...i32(9),
      CP.PUSH_INT32,
      ...i32(111),
      CP.PUSH_INT32,
      ...i32(222),
      CP.POP_GLOBAL_VAR32,
      ...i16(3),
      CP.END_SCRIPT,
    ]);
    runSword2Script(layout, scriptHost, 0);
    expect(scriptHost.vars.get(3)).toBe(222);
  });

  it('zeroes the parameters a script did not pass', () => {
    const scriptHost = host();
    const layout = object([CP.PUSH_INT32, ...i32(5), CP.CALL_MCODE, ...i16(10), 1, CP.END_SCRIPT]);
    runSword2Script(layout, scriptHost, 0);
    // Parameter 0 is the pushed 5; the rest are cleared rather than stale.
    expect(scriptHost.calls[0].params).toEqual([5, 0, 0, 0]);
  });

  it('carries an mcode’s return value into the next jump table', () => {
    const scriptHost = host({
      // Return IR_CONT with a value of 1 packed above the low three bits.
      callMcode: () => IR.CONT | (1 << 3),
    });
    const layout = object([
      CP.CALL_MCODE,
      ...i16(0),
      0,
      CP.JUMP_ON_RETURNED,
      2,
      ...i32(8),
      ...i32(17),
      CP.PUSH_INT32,
      ...i32(100),
      CP.POP_GLOBAL_VAR32,
      ...i16(7),
      CP.END_SCRIPT,
      CP.PUSH_INT32,
      ...i32(200),
      CP.POP_GLOBAL_VAR32,
      ...i16(7),
      CP.END_SCRIPT,
    ]);
    runSword2Script(layout, scriptHost, 0);
    expect(scriptHost.vars.get(7)).toBe(200);
  });

  it('reads a division by zero as zero and says so', () => {
    const scriptHost = host();
    const layout = object([
      CP.PUSH_INT32,
      ...i32(8),
      CP.PUSH_INT32,
      ...i32(0),
      CP.OP_DIVIDE,
      CP.POP_GLOBAL_VAR32,
      ...i16(1),
      CP.END_SCRIPT,
    ]);
    runSword2Script(layout, scriptHost, 0);
    expect(scriptHost.vars.get(1)).toBe(0);
    expect(scriptHost.faults.join(' ')).toMatch(/divided by zero/);
  });

  it('reports a stack overflow as a decoding fault', () => {
    const code: number[] = [];
    for (let at = 0; at <= SWORD2_STACK_SIZE; at++) code.push(CP.PUSH_INT32, ...i32(at));
    code.push(CP.END_SCRIPT);
    const result = runSword2Script(object(code), host(), 0);
    expect(result.fault).toMatch(/stack/);
  });

  it('refuses a byte that is not a token', () => {
    const result = runSword2Script(object([200, CP.END_SCRIPT]), host(), 0);
    expect(result.fault).toMatch(/not a Broken Sword II token/);
  });

  it('reads the structures of the running object when it runs another’s script', () => {
    const seen: number[] = [];
    const scriptHost = host({
      encodeOffset: (target) => {
        seen.push(target.bytes.length);
        return 1;
      },
    });
    const script = object([CP.PUSH_DEREFERENCED_STRUCTURE, ...i32(0), CP.END_SCRIPT]);
    // A data object with a different size, so the call can be told apart.
    const data = parseSword2Object(buildSword2Object('other', [[CP.END_SCRIPT]], 12));
    runSword2Script(script, scriptHost, 0, data);
    expect(seen).toEqual([data.bytes.length]);
  });
});

describe('decompiling', () => {
  const CODE = [
    CP.PUSH_GLOBAL_VAR32,
    ...i16(62),
    CP.PUSH_INT32,
    ...i32(3),
    CP.OP_ISEQUAL,
    CP.SKIPONFALSE,
    ...i32(9),
    CP.PUSH_INT32,
    ...i32(1),
    CP.CALL_MCODE,
    ...i16(15),
    1,
    CP.PUSH_STRING,
    5,
    0x68,
    0x65,
    0x6c,
    0x6c,
    0x6f,
    0,
    CP.END_SCRIPT,
  ];

  it('splits an object’s code into instructions with no unrecovered bytes', () => {
    const layout = object(CODE);
    const disassembly = disassembleSword2Object(layout);
    expect(disassembly.unrecovered).toHaveLength(0);
    expect(disassembly.instructions.length).toBeGreaterThan(5);
  });

  it('carries a pushed string’s text, not only its length', () => {
    const disassembly = disassembleSword2Object(object(CODE));
    const push = disassembly.instructions.find(
      (instruction) => instruction.token === CP.PUSH_STRING,
    );
    expect(push?.text).toBe('hello');
  });

  it('names opcodes in the listing rather than printing numbers', () => {
    const layout = object(CODE);
    const listing = formatSword2Disassembly(layout, disassembleSword2Object(layout)).join('\n');
    expect(listing).toMatch(/CP_CALL_MCODE fnWalk\/1/);
    expect(listing).toMatch(/CP_PUSH_STRING "hello"/);
  });

  it('re-emits an object’s code to exactly the bytes it was read from', () => {
    expect(roundTripsSword2Object(object(CODE))).toEqual({ ok: true });
  });

  it('keeps jumps correct when an instruction is inserted before them', () => {
    const layout = object(CODE);
    const disassembly = disassembleSword2Object(layout);
    const inserted = [
      { at: -1, token: CP.PUSH_INT32, operands: [9], bytes: 5 },
      ...disassembly.instructions,
    ];
    const rebuilt = reassembleSword2Code(inserted, disassembly.entries);
    // Every entry moved by the five bytes that were inserted ahead of it.
    expect(rebuilt.entries[0]).toBe(5);
    expect(rebuilt.code.length).toBe(layout.codeBytes + 5);
  });

  /**
   * A jump table whose entries are far enough apart that the two readings of
   * the base address disagree. Entry 1's delta of 17 resolves to byte 23 when
   * measured from the table's start (`at + 2`) and to byte 27 — the middle of
   * the push that starts at 23 — when the index is allowed to scale the base.
   */
  const JUMP_TABLE = [
    CP.CALL_MCODE,
    ...i16(0),
    0,
    CP.JUMP_ON_RETURNED,
    2,
    ...i32(8),
    ...i32(17),
    CP.PUSH_INT32,
    ...i32(100),
    CP.POP_GLOBAL_VAR32,
    ...i16(7),
    CP.END_SCRIPT,
    CP.PUSH_INT32,
    ...i32(200),
    CP.POP_GLOBAL_VAR32,
    ...i16(7),
    CP.END_SCRIPT,
  ];

  it('measures every jump table entry from the table’s start, not from its own slot', () => {
    const disassembly = disassembleSword2Object(object(JUMP_TABLE));
    const table = disassembly.instructions.find(
      (instruction) => instruction.token === CP.JUMP_ON_RETURNED,
    )!;
    const listing = formatSword2Instruction(table);
    // Both targets are instruction starts: 14 and 23, and neither is 27.
    expect(listing).toBe('CP_JUMP_ON_RETURNED 2 entries: 0 -> 14, 1 -> 23');
  });

  it('re-emits a jump table of more than one entry byte-identically', () => {
    expect(roundTripsSword2Object(object(JUMP_TABLE))).toEqual({ ok: true });
  });

  it('moves a whole jump table when an instruction is inserted ahead of it', () => {
    const layout = object(JUMP_TABLE);
    const disassembly = disassembleSword2Object(layout);
    const inserted = [
      { at: -1, token: CP.PUSH_INT32, operands: [9], bytes: 5 },
      ...disassembly.instructions,
    ];
    const rebuilt = reassembleSword2Code(inserted, disassembly.entries);
    const view = new DataView(rebuilt.code.buffer, rebuilt.code.byteOffset);
    // The table now starts at 9, and its targets moved by five with it.
    expect(rebuilt.code[9]).toBe(CP.JUMP_ON_RETURNED);
    expect(11 + view.getInt32(11, true)).toBe(19);
    expect(11 + view.getInt32(15, true)).toBe(28);
  });

  it('refuses an edit that leaves a jump pointing at no instruction', () => {
    const layout = object(CODE);
    const disassembly = disassembleSword2Object(layout);
    const skip = disassembly.instructions.find(
      (instruction) => instruction.token === CP.SKIPONFALSE,
    )!;
    const target = skip.at + 1 + skip.operands[0];
    const without = disassembly.instructions.filter((instruction) => instruction.at !== target);
    expect(() => reassembleSword2Code(without, disassembly.entries)).toThrow(
      /not the start of an instruction/,
    );
  });
});

describe('the sprite compressions', () => {
  it('alternates flat and raw blocks, with a zero meaning "none of that kind"', () => {
    const out = new Uint8Array(6);
    const result = decompressRLE256(Uint8Array.from([2, 9, 3, 1, 2, 3, 0, 1, 4]), out, 6);
    expect(result.ok).toBe(true);
    expect(Array.from(out)).toEqual([9, 9, 1, 2, 3, 4]);
  });

  it('reports an overrun rather than writing past the frame', () => {
    const out = new Uint8Array(2);
    expect(decompressRLE256(Uint8Array.from([8, 1]), out, 2).ok).toBe(false);
  });

  it('unpacks RLE16 raw blocks two pixels a byte, high nibble first on the PC', () => {
    const table = Uint8Array.from([0, 11, 22, 33, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const out = new Uint8Array(4);
    unwindRaw16(out, 0, Uint8Array.from([0x12, 0x30]), 0, 3, table, true);
    expect(Array.from(out.subarray(0, 3))).toEqual([11, 22, 33]);
  });

  it('swaps the nibble order for the PlayStation conversion', () => {
    const table = Uint8Array.from([0, 11, 22, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const out = new Uint8Array(2);
    unwindRaw16(out, 0, Uint8Array.from([0x12]), 0, 2, table, false);
    expect(Array.from(out)).toEqual([22, 11]);
  });

  it('counts RLE16 raw blocks in pixels and advances the source in bytes', () => {
    const table = Uint8Array.from([0, 5, 6, 7, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const out = new Uint8Array(4);
    // Zero flat, then four pixels in two bytes.
    const result = decompressRLE16(Uint8Array.from([0, 4, 0x12, 0x34]), out, table, 4);
    expect(result.ok).toBe(true);
    expect(Array.from(out)).toEqual([5, 6, 7, 8]);
  });

  it('leaves transparency where a frame decodes partly', () => {
    const decoded = decodeSword2Frame(Uint8Array.from([2, 3]), 1, 4, 1);
    expect(Array.from(decoded.pixels)).toEqual([3, 3, 0, 0]);
    expect(decoded.ok).toBe(false);
  });

  it('decodes a parallax row by row, in both of the forms a row is written in', () => {
    // `initializeBackgroundLayer` (`render.cpp:465-533`): one uint32 offset per
    // *row*, not one per sixteen-pixel column strip — that is Sword1's layout,
    // and reading this with it takes row offsets for strip offsets, lands in
    // the middle of packet data, and fills the screen with horizontal noise
    // that still looks like a picture that has gone wrong.
    const rows = [
      [1, 2, 3, 4, 5, 6], // no transparency: written as a raw row
      [0, 0, 7, 8, 0, 9], // a leading gap, an interior gap, no trailing packet
      null, // a row nothing was drawn on at all
      [0, 0, 0, 0, 0, 5],
    ];
    const parallax = parseSword2Parallax(buildSword2ParallaxLayer(6, 4, rows));
    expect(parallax?.width).toBe(6);
    expect(parallax?.height).toBe(4);
    expect(Array.from(parallax!.pixels)).toEqual([
      1, 2, 3, 4, 5, 6, 0, 0, 7, 8, 0, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5,
    ]);
  });
});

describe('the opcode table', () => {
  it('holds the 118 entries the shipped interpreter declares', () => {
    expect(SWORD2_OPCODE_COUNT).toBe(118);
    expect(sword2OpcodeName(15)).toBe('fnWalk');
    expect(sword2OpcodeName(999)).toBe('opcode999');
  });
});

/**
 * An opcode that ran is not an opcode this project does not implement.
 *
 * `fnPlaySequence` is implemented: it hands the pushed filename to the host,
 * which plays the Smacker. When the film is not in the folder the host answers
 * false and records the name — the demo ships `Enddemo.smk` and the scripts ask
 * for `eye`, `demo` and `intro`, so on that install this happens three times.
 * Filing that into the unimplemented map as well put an *implemented* opcode on
 * the stall report under "opcodes this project does not implement", and said
 * the same absence twice in one report under two different explanations. AGOS
 * keeps this line (`agos-vga-scheduler.test.ts`: "passes a PLAY_EFFECT through
 * and does not report it unimplemented") and this family had drifted off it.
 */
describe('reporting an opcode that ran', () => {
  function logicWithHost(host: Partial<Sword2LogicHost>): Sword2Logic {
    const resources = {
      fetch: () => null,
      describeMissingResource: () => 'not in this fixture',
    } as unknown as Sword2Resources;
    return new Sword2Logic(resources, host as Sword2LogicHost);
  }

  const anObject = object([]);

  it('does not call fnPlaySequence unimplemented, when the film is simply absent', () => {
    const asked: string[] = [];
    const logic = logicWithHost({
      playSequence: (name: string) => {
        asked.push(name);
        return false;
      },
    });

    logic.callMcode(88, Int32Array.from([0]), anObject);

    expect(asked).toHaveLength(1);
    expect(logic.describeUnimplemented()).toBeUndefined();
  });

  it('still calls an opcode it really does not implement unimplemented', () => {
    const logic = logicWithHost({});
    // 115 is `fnRestoreGame`, which this project does not implement.
    logic.callMcode(115, Int32Array.from([0]), anObject);
    expect(logic.describeUnimplemented()).toContain('fnRestoreGame');
  });
});

/**
 * The four animation opcodes, two of which were one.
 *
 * `interpreter.cpp`'s table puts `fnReverseMegaTableAnim` at 63 and
 * `fnReverseAnim` at 64, next to each other. This project dispatched 63 as
 * `fnReverseAnim` and had no 64 at all, so every reverse table anim read a
 * mega *pointer* as a resource id, and every real `fnReverseAnim` fell through
 * to "an opcode this project does not implement" — 88,235 times in 3,536
 * cycles of the demo, because the script waiting on that animation loops until
 * it ends and nothing was going to end it.
 *
 * The table pair differs from the plain pair in one thing only: where the
 * resource comes from on the first frame. `megaTableAnimate` reads
 * `animTable[4 * curDir]` while the logic is not yet looping, and then hands
 * the same `doAnimate` a zero, because from the second frame on the id it
 * wants is already in the graphic structure (`anims.cpp:142-158`).
 */
describe('the animation opcodes', () => {
  /** Offsets inside the fixture's variable block, in bytes. */
  const LOGIC = 0;
  const GRAPHIC = 8;
  const MEGA = 24;
  const TABLE = 80;
  const CUR_DIR = 40;
  const ANIM_RESOURCE = 4;
  const ANIM_PC = 8;

  function animLogic(frames: number): {
    logic: Sword2Logic;
    tokens: { logic: number; graphic: number; mega: number; table: number };
    object: Sword2ObjectLayout;
    fetched: number[];
  } {
    const fetched: number[] = [];
    const bytes = buildSword2Anim(
      'walk',
      Array.from({ length: frames }, () => ({ x: 0, y: 0, width: 1, height: 1 })),
    );
    const resources = {
      fetch: (id: number) => {
        fetched.push(id);
        return id >= 700 ? { bytes } : null;
      },
      describeMissingResource: (id: number) => `resource ${id} is not in this fixture`,
    } as unknown as Sword2Resources;
    const logic = new Sword2Logic(resources, {} as Sword2LogicHost);
    const layout = object([], 32);
    const at = (field: number) => logic.encodeOffset(layout, layout.localsAt + field);
    const tokens = { logic: at(LOGIC), graphic: at(GRAPHIC), mega: at(MEGA), table: at(TABLE) };
    return { logic, tokens, object: layout, fetched };
  }

  it('runs opcode 64 as fnReverseAnim rather than reporting it unimplemented', () => {
    const { logic, tokens, object: layout } = animLogic(6);

    const result = logic.callMcode(
      64,
      Int32Array.from([tokens.logic, tokens.graphic, 700]),
      layout,
    );

    expect(result).toBe(IR.REPEAT);
    expect(logic.describeUnimplemented()).toBeUndefined();
    expect(logic.peek(tokens.graphic, ANIM_RESOURCE)).toBe(700);
    // Reverse starts at the last frame and counts down.
    expect(logic.peek(tokens.graphic, ANIM_PC)).toBe(5);
  });

  it('runs opcode 63 as fnReverseMegaTableAnim, taking the resource from the table', () => {
    const { logic, tokens, object: layout, fetched } = animLogic(6);
    logic.poke(tokens.mega, CUR_DIR, 3);
    for (let direction = 0; direction < 8; direction++) {
      logic.poke(tokens.table, 4 * direction, 700 + direction);
    }

    const result = logic.callMcode(
      63,
      Int32Array.from([tokens.logic, tokens.graphic, tokens.mega, tokens.table]),
      layout,
    );

    expect(result).toBe(IR.REPEAT);
    // Not `tokens.mega`, which is what reading 63 as a three-parameter
    // `fnReverseAnim` fetched.
    expect(fetched).toEqual([703]);
    expect(logic.peek(tokens.graphic, ANIM_RESOURCE)).toBe(703);
    expect(logic.peek(tokens.graphic, ANIM_PC)).toBe(5);
  });

  it('runs opcode 22 as fnMegaTableAnim, and reads the table only on the first frame', () => {
    const { logic, tokens, object: layout, fetched } = animLogic(6);
    logic.poke(tokens.mega, CUR_DIR, 1);
    for (let direction = 0; direction < 8; direction++) {
      logic.poke(tokens.table, 4 * direction, 700 + direction);
    }
    const params = Int32Array.from([tokens.logic, tokens.graphic, tokens.mega, tokens.table]);

    expect(logic.callMcode(22, params, layout)).toBe(IR.REPEAT);
    expect(logic.peek(tokens.graphic, ANIM_PC)).toBe(0);

    // Turning mid-animation must not swap the animation out from under it:
    // once it is looping the id comes from the graphic structure.
    logic.poke(tokens.mega, CUR_DIR, 6);
    expect(logic.callMcode(22, params, layout)).toBe(IR.REPEAT);
    expect(logic.peek(tokens.graphic, ANIM_RESOURCE)).toBe(701);
    expect(logic.peek(tokens.graphic, ANIM_PC)).toBe(1);
    expect(fetched).toEqual([701, 701]);
  });
});

/**
 * The one opcode that decides whether a player character is drawn at all.
 *
 * `fnSetValue` is Revolution's own "temp. function!" and it writes exactly one
 * field: the mega's far-referenced `megaset_res` (`function.cpp:1575-1587`,
 * `ObjectMega::setMegasetRes`, which is `_addr + 48`). `fnStandAt` then copies
 * that resource into the graphic's `anim_resource`, and `Sword2Screen.frame()`
 * returns null when the anim resource is zero.
 *
 * So a write to the wrong offset does not produce a visibly wrong character;
 * it produces **no character**, on a room that is otherwise complete and
 * interactive and walkable. That is what the demo showed: George registered,
 * scaled, given a mouse area, and never drawn. Offset 40 is `cur_dir`, eight
 * bytes short — near enough to look right in a diff and nowhere near right.
 */
describe('fnSetValue', () => {
  const MEGA_AT = 24;
  const GRAPHIC_AT = 8;
  const CUR_DIR = 40;
  const MEGASET_RES = 48;
  const ANIM_RESOURCE = 4;

  function megaLogic(): {
    logic: Sword2Logic;
    tokens: { graphic: number; mega: number };
    object: Sword2ObjectLayout;
  } {
    const bytes = buildSword2Anim(
      'george',
      // Eight walk, eight turn and eight stand frames, so `fnStandAt` has a
      // stand frame to land on.
      Array.from({ length: 24 }, () => ({ x: 0, y: 0, width: 1, height: 1 })),
    );
    const resources = {
      fetch: (id: number) => (id === 1234 ? { bytes } : null),
      describeMissingResource: (id: number) => `resource ${id} is not in this fixture`,
    } as unknown as Sword2Resources;
    const logic = new Sword2Logic(resources, {} as Sword2LogicHost);
    const layout = object([], 32);
    const at = (field: number) => logic.encodeOffset(layout, layout.localsAt + field);
    return { logic, tokens: { graphic: at(GRAPHIC_AT), mega: at(MEGA_AT) }, object: layout };
  }

  it('writes the megaset resource to megaset_res, and not to cur_dir', () => {
    const { logic, tokens, object: layout } = megaLogic();

    expect(logic.callMcode(58, Int32Array.from([tokens.mega, 1234]), layout)).toBe(IR.CONT);

    expect(logic.peek(tokens.mega, MEGASET_RES)).toBe(1234);
    expect(logic.peek(tokens.mega, CUR_DIR)).toBe(0);
  });

  it('gives fnStandAt an animation to draw, which is the whole of being visible', () => {
    const { logic, tokens, object: layout } = megaLogic();

    logic.callMcode(58, Int32Array.from([tokens.mega, 1234]), layout);
    const stand = Int32Array.from([tokens.graphic, tokens.mega, 750, 500, 3]);
    expect(logic.callMcode(18, stand, layout)).toBe(IR.CONT);

    expect(logic.peek(tokens.graphic, ANIM_RESOURCE)).toBe(1234);
  });

  it('leaves the graphic with no animation when the megaset was never set', () => {
    const { logic, tokens, object: layout } = megaLogic();

    const stand = Int32Array.from([tokens.graphic, tokens.mega, 750, 500, 3]);
    logic.callMcode(18, stand, layout);

    expect(logic.peek(tokens.graphic, ANIM_RESOURCE)).toBe(0);
  });
});

/**
 * The two strips down the edges of a wide room.
 *
 * `fnSetScrollLeftMouse` and `fnSetScrollRightMouse` write a 20-pixel band at
 * priority 0 — the highest there is — and zero the pointer when the view
 * cannot go any further that way, which un-registers the band altogether
 * (`function.cpp:1805-1859`, `mouse.cpp:163`). Neither was implemented, so
 * both fell through to the unimplemented map 3,427 times apiece in 3,536
 * cycles: every cycle of the demo, because they are service-script calls.
 */
describe('the scroll strips', () => {
  const MOUSE = { X1: 0, Y1: 4, X2: 8, Y2: 12, PRIORITY: 16, POINTER: 20 };

  function scrollLogic(scrollX: number, maxX: number): { logic: Sword2Logic; token: number } {
    const resources = {
      fetch: () => null,
      describeMissingResource: () => 'absent',
    } as unknown as Sword2Resources;
    const logic = new Sword2Logic(resources, {
      roomSize: () => ({ width: 1600, height: 480 }),
      scrollOffset: () => ({ x: scrollX, y: 0 }),
      maxScroll: () => ({ x: maxX, y: 0 }),
    } as unknown as Sword2LogicHost);
    const layout = object([], 8);
    return { logic, token: logic.encodeOffset(layout, layout.localsAt) };
  }

  it('writes the left strip against the left of the display, at the top priority', () => {
    const { logic, token } = scrollLogic(300, 960);

    expect(logic.callMcode(74, Int32Array.from([token]), object([]))).toBe(IR.CONT);

    expect(logic.describeUnimplemented()).toBeUndefined();
    // Room coordinates: the band stays under the same part of the display as
    // the room moves beneath it.
    expect(logic.peek(token, MOUSE.X1)).toBe(0);
    expect(logic.peek(token, MOUSE.X2)).toBe(320);
    expect(logic.peek(token, MOUSE.Y2)).toBe(479);
    expect(logic.peek(token, MOUSE.PRIORITY)).toBe(0);
    expect(logic.peek(token, MOUSE.POINTER)).toBe(1440);
  });

  it('writes the right strip against the right of the display', () => {
    const { logic, token } = scrollLogic(300, 960);

    logic.callMcode(75, Int32Array.from([token]), object([]));

    expect(logic.peek(token, MOUSE.X1)).toBe(300 + 640 - 20);
    expect(logic.peek(token, MOUSE.X2)).toBe(1599);
    expect(logic.peek(token, MOUSE.POINTER)).toBe(1441);
  });

  it('zeroes the pointer at each end, which is what un-registers the strip', () => {
    const atLeft = scrollLogic(0, 960);
    atLeft.logic.callMcode(74, Int32Array.from([atLeft.token]), object([]));
    expect(atLeft.logic.peek(atLeft.token, MOUSE.POINTER)).toBe(0);

    const atRight = scrollLogic(960, 960);
    atRight.logic.callMcode(75, Int32Array.from([atRight.token]), object([]));
    expect(atRight.logic.peek(atRight.token, MOUSE.POINTER)).toBe(0);
  });
});

/**
 * A line of speech, which this engine used to swallow whole.
 *
 * `fnISpeak` is opcode 44 and it was not in the dispatch, so every spoken line
 * in the demo — the scripts reached four of them in three thousand cycles, and
 * many more once conversations start — fell into the unimplemented map and the
 * script loop it belongs to spun. Nothing was drawn and nothing was said.
 *
 * It is a multi-cycle opcode: `ob_logic.looping` is the state, the first cycle
 * is deliberately thrown away, and the line ends either when the sample ends,
 * when a countdown runs out, or when the player clicks past it.
 */
describe('speaking a line', () => {
  const LOGIC = { LOOPING: 0 };
  const GRAPHIC = { ANIM_RESOURCE: 4, ANIM_PC: 8 };
  const SPEECH = { PEN: 0, WIDTH: 4 };
  /** 3258 * 0x10000 + 1: the shape every text id has. */
  const TEXT_ID = 3258 * 0x10000 + 1;

  function speechLogic(overrides: Partial<Sword2LogicHost> = {}) {
    const shown: Array<{ textId: number; x: number; y: number; width: number; pen: number }> = [];
    const removed: number[] = [];
    const spoken: number[] = [];
    const globals = buildSword2Globals(new Array(1400).fill(0));
    const resources = {
      fetch: (id: number) => (id === 1 ? { bytes: globals, header: { fileType: 5 } } : null),
      describeMissingResource: () => 'not in this fixture',
    } as unknown as Sword2Resources;
    const host: Partial<Sword2LogicHost> = {
      speechFinished: () => true,
      stopSpeech: () => {},
      subtitles: () => true,
      speechLine: () => ({ wavId: 4242, text: 'Hello' }),
      requestSpeech: (wavId: number) => {
        spoken.push(wavId);
        return false;
      },
      displayText: (textId, x, y, width, pen) => {
        shown.push({ textId, x, y, width, pen });
        return shown.length;
      },
      removeText: (block: number) => void removed.push(block),
      firstFrame: () => null,
      animFrameCount: () => 0,
      scrollOffset: () => ({ x: 0, y: 0 }),
      ...overrides,
    };
    const logic = new Sword2Logic(resources, host as Sword2LogicHost);
    logic.initialise();
    const layout = object([], 32);
    const at = (field: number) => logic.encodeOffset(layout, layout.localsAt + field);
    const tokens = { graphic: at(0), speech: at(16), logic: at(32), mega: at(48) };
    const params = Int32Array.from([
      tokens.graphic,
      tokens.speech,
      tokens.logic,
      tokens.mega,
      TEXT_ID,
      0,
      0,
      0,
      0,
    ]);
    return { logic, layout, tokens, params, shown, removed, spoken };
  }

  it('is dispatched rather than reported unimplemented', () => {
    const { logic, layout, params } = speechLogic();
    logic.callMcode(44, params, layout);
    expect(logic.describeUnimplemented()).toBeUndefined();
  });

  it('throws the first cycle away so a walk can show its last frame', () => {
    const { logic, layout, params, tokens, shown } = speechLogic();

    // "Drop out for 1st cycle to allow walks/anims to end and display last
    // frame before system locks while speech loaded."
    expect(logic.callMcode(44, params, layout)).toBe(IR.REPEAT);
    expect(shown).toHaveLength(0);
    expect(logic.peek(tokens.logic, LOGIC.LOOPING)).toBe(0);

    expect(logic.callMcode(44, params, layout)).toBe(IR.REPEAT);
    expect(shown).toHaveLength(1);
    expect(logic.peek(tokens.logic, LOGIC.LOOPING)).toBe(1);
  });

  it('takes the wav id off the front of the text line when the script passed none', () => {
    const { logic, layout, params, spoken } = speechLogic();
    logic.callMcode(44, params, layout);
    logic.callMcode(44, params, layout);
    // The first two bytes of every text line are the sample number.
    expect(spoken).toEqual([4242]);
  });

  it('shows a line whose "speech" is a sound effect, and asks for no sample', () => {
    // 4082 is one of the eleven wav ids that are effects written as speech;
    // there is no sample for them and asking for one logs an absence per line.
    const { logic, layout, params, spoken, shown } = speechLogic({
      speechLine: () => ({ wavId: 4082, text: 'a door slams' }),
    });
    logic.callMcode(44, params, layout);
    logic.callMcode(44, params, layout);
    expect(spoken).toEqual([]);
    expect(shown).toHaveLength(1);
  });

  it('carries the speech object’s pen and width to the sprite', () => {
    const { logic, layout, params, tokens, shown } = speechLogic();
    logic.poke(tokens.speech, SPEECH.PEN, 5);
    logic.poke(tokens.speech, SPEECH.WIDTH, 300);
    logic.callMcode(44, params, layout);
    logic.callMcode(44, params, layout);
    expect(shown[0].pen).toBe(5);
    expect(shown[0].width).toBe(300);
  });

  it('ends on its own clock when no sample is playing, and takes the line down', () => {
    const { logic, layout, params, tokens, shown, removed } = speechLogic();
    logic.callMcode(44, params, layout);
    logic.callMcode(44, params, layout);

    // strlen("Hello") + 30 cycles, counted from the cycle after the sprite.
    let result: number = IR.REPEAT;
    let cycles = 0;
    while (result === IR.REPEAT && cycles < 100) {
      result = logic.callMcode(44, params, layout);
      cycles++;
    }
    // strlen("Hello") + 30, less the cycle that set the sprite up — which
    // decrements the clock as well, because the countdown is in the
    // every-cycle half of the opcode.
    expect(cycles).toBe(34);
    expect(result).toBe(IR.CONT);
    expect(removed).toEqual([shown.length]);
    expect(logic.peek(tokens.logic, LOGIC.LOOPING)).toBe(0);
  });

  it('ends on a click past the delay, and not on a button that was already down', () => {
    const { logic, layout, params } = speechLogic();
    logic.callMcode(44, params, layout);
    logic.callMcode(44, params, layout);

    // "We can left-click past the text after half a second" — six cycles.
    for (let cycle = 0; cycle < 4; cycle++) {
      expect(logic.callMcode(44, params, layout)).toBe(IR.REPEAT);
    }
    logic.setVar(109, 1); // LEFT_BUTTON
    expect(logic.callMcode(44, params, layout)).toBe(IR.CONT);

    // The button is still down, and the script goes straight into the reply.
    // ScummVM reads a mouse *event* here, so a level that never fell is not a
    // second click — without that, one held button ends the whole conversation
    // in as many cycles as it has lines.
    logic.callMcode(44, params, layout);
    logic.callMcode(44, params, layout);
    for (let cycle = 0; cycle < 20; cycle++) {
      expect(logic.callMcode(44, params, layout)).toBe(IR.REPEAT);
    }

    // Released and pressed again, it ends the line.
    logic.setVar(109, 0);
    logic.callMcode(44, params, layout);
    logic.setVar(109, 1);
    expect(logic.callMcode(44, params, layout)).toBe(IR.CONT);
  });

  it('runs a frame of the talker’s animation every cycle', () => {
    const { logic, layout, params, tokens } = speechLogic({ animFrameCount: () => 3 });
    const withAnim = Int32Array.from(params);
    withAnim[6] = 700;
    logic.callMcode(44, withAnim, layout);
    logic.callMcode(44, withAnim, layout);
    expect(logic.peek(tokens.graphic, GRAPHIC.ANIM_RESOURCE)).toBe(700);
    // Frame 0 on the cycle the anim was set up, then one frame per cycle,
    // wrapping at the end because a lip-synced anim repeats.
    expect(logic.peek(tokens.graphic, GRAPHIC.ANIM_PC)).toBe(1);
    logic.callMcode(44, withAnim, layout);
    expect(logic.peek(tokens.graphic, GRAPHIC.ANIM_PC)).toBe(2);
    logic.callMcode(44, withAnim, layout);
    expect(logic.peek(tokens.graphic, GRAPHIC.ANIM_PC)).toBe(0);
  });

  it('picks the talker’s animation out of a direction table', () => {
    const { logic, layout, params, tokens } = speechLogic({ animFrameCount: () => 3 });
    const table = logic.encodeOffset(layout, layout.localsAt + 96);
    for (let direction = 0; direction < 8; direction++) {
      logic.poke(table, direction * 4, 800 + direction);
    }
    logic.poke(tokens.mega, 40, 3); // MEGA.CUR_DIR
    const withTable = Int32Array.from(params);
    withTable[7] = table;
    logic.callMcode(44, withTable, layout);
    logic.callMcode(44, withTable, layout);
    expect(logic.peek(tokens.graphic, GRAPHIC.ANIM_RESOURCE)).toBe(803);
  });
});

/**
 * The conversation opcodes: two objects talking through seven globals.
 *
 * There is no message queue in this family. When George is to say something to
 * Nico, George's script runs *Nico's* script 5 — her "get speech state" — which
 * answers in `RESULT`: 1 for waiting, 0 for busy. If she is waiting, the
 * command goes into `SPEECH_ID`, `INS_COMMAND` and `INS1`–`INS5`, and her own
 * speech script picks it up on its next cycle. That is the whole mechanism, and
 * it is why these opcodes cannot be written without running another object's
 * script: the answer they branch on is produced by the object being asked.
 *
 * All three of `fnWeWait`, `fnTheyDoWeWait` and `fnTheyDo` are multi-cycle, and
 * `fnTheyDoWeWait` keeps its state in the *caller's* `ob_logic.looping` because
 * it has three phases and only one bit to remember them with.
 */
describe('the conversation opcodes', () => {
  const LOGIC = { LOOPING: 0 };
  const TARGET = 100;
  /** A scratch global the fixture target's script 5 copies into `RESULT`. */
  const SPEECH_STATE = 200;
  const SV = {
    RESULT: 1,
    SPEECH_ID: 9,
    INS1: 10,
    INS2: 11,
    INS3: 12,
    TALK_FLAG: 13,
    CHOOSER_COUNT_FLAG: 15,
    INS_COMMAND: 59,
    INS4: 60,
    INS5: 61,
    MOUSE_AVAILABLE: 686,
    DEMO: 1153,
  };

  function conversationLogic() {
    const globals = buildSword2Globals(new Array(1400).fill(0));
    // Scripts 0-4 are empty; script 5 is the one the opcodes run, and it
    // answers out of `SPEECH_STATE` so a test can make the target busy or
    // waiting between cycles the way a real speech script does.
    const empty = [CP.END_SCRIPT];
    const getSpeechState = [
      CP.PUSH_GLOBAL_VAR32,
      ...i16(SPEECH_STATE),
      CP.POP_GLOBAL_VAR32,
      ...i16(SV.RESULT),
      CP.END_SCRIPT,
    ];
    const target = buildSword2Object(
      'nico',
      [empty, empty, empty, empty, empty, getSpeechState],
      4,
      3,
      TARGET,
    );
    const resources = {
      fetch: (id: number) => {
        if (id === 1) return { bytes: globals, header: { fileType: 5 } };
        if (id === TARGET) return { bytes: target, header: { fileType: 3 } };
        return null;
      },
      describeMissingResource: () => 'not in this fixture',
    } as unknown as Sword2Resources;
    const logic = new Sword2Logic(resources, {
      log: () => {},
    } as unknown as Sword2LogicHost);
    logic.initialise();
    const caller = object([], 32);
    const obLogic = logic.encodeOffset(caller, caller.localsAt);
    /** 1 = the target is waiting (free), 0 = busy. */
    const targetIs = (state: 'waiting' | 'busy') =>
      logic.setVar(SPEECH_STATE, state === 'waiting' ? 1 : 0);
    const instruction = () => ({
      speechId: logic.getVar(SV.SPEECH_ID),
      command: logic.getVar(SV.INS_COMMAND),
      ins: [SV.INS1, SV.INS2, SV.INS3, SV.INS4, SV.INS5].map((slot) => logic.getVar(slot)),
    });
    return { logic, caller, obLogic, targetIs, instruction };
  }

  it('dispatches all six rather than reporting them unimplemented', () => {
    const { logic, caller, obLogic } = conversationLogic();
    logic.callMcode(24, Int32Array.from([]), caller); // fnStartConversation
    logic.callMcode(39, Int32Array.from([TARGET]), caller); // fnWeWait
    logic.callMcode(40, Int32Array.from([obLogic, TARGET, 1, 0, 0, 0, 0, 0]), caller);
    logic.callMcode(41, Int32Array.from([TARGET, 1, 0, 0, 0, 0, 0]), caller); // fnTheyDo
    logic.callMcode(94, Int32Array.from([7, 0, 10]), caller); // fnAddSequenceText
    logic.callMcode(25, Int32Array.from([]), caller); // fnEndConversation
    expect(logic.describeUnimplemented()).toBeUndefined();
  });

  describe('fnWeWait', () => {
    it('takes its answer from the target’s own script and not from a stale RESULT', () => {
      const { logic, caller, targetIs } = conversationLogic();
      // A caller that read RESULT without running script 5 would see this.
      logic.setVar(SV.RESULT, 1);
      targetIs('busy');
      expect(logic.callMcode(39, Int32Array.from([TARGET]), caller)).toBe(IR.REPEAT);
      expect(logic.getVar(SV.RESULT)).toBe(0);
    });

    it('continues once the target is waiting', () => {
      const { logic, caller, targetIs } = conversationLogic();
      targetIs('busy');
      expect(logic.callMcode(39, Int32Array.from([TARGET]), caller)).toBe(IR.REPEAT);
      targetIs('waiting');
      expect(logic.callMcode(39, Int32Array.from([TARGET]), caller)).toBe(IR.CONT);
    });
  });

  describe('fnTheyDoWeWait', () => {
    const command = (obLogic: number) => Int32Array.from([obLogic, TARGET, 7, 11, 12, 13, 14, 15]);

    it('sends the command, waits out the doing, then continues', () => {
      const { logic, caller, obLogic, targetIs, instruction } = conversationLogic();
      const params = command(obLogic);

      targetIs('waiting');
      expect(logic.callMcode(40, params, caller)).toBe(IR.REPEAT);
      expect(instruction()).toEqual({ speechId: TARGET, command: 7, ins: [11, 12, 13, 14, 15] });
      // The caller's own looping bit is the memory that the command was sent.
      expect(logic.peek(obLogic, LOGIC.LOOPING)).toBe(1);

      // The target picks the command up and is busy with it.
      logic.setVar(SV.INS_COMMAND, 0);
      targetIs('busy');
      expect(logic.callMcode(40, params, caller)).toBe(IR.REPEAT);

      targetIs('waiting');
      expect(logic.callMcode(40, params, caller)).toBe(IR.CONT);
      expect(logic.peek(obLogic, LOGIC.LOOPING)).toBe(0);
    });

    it('does not send the command to a target that is still busy', () => {
      const { logic, caller, obLogic, targetIs, instruction } = conversationLogic();
      targetIs('busy');
      expect(logic.callMcode(40, command(obLogic), caller)).toBe(IR.REPEAT);
      expect(instruction().command).toBe(0);
      expect(logic.peek(obLogic, LOGIC.LOOPING)).toBe(0);
    });

    it('does not overwrite a command another object has already queued', () => {
      const { logic, caller, obLogic, targetIs, instruction } = conversationLogic();
      targetIs('waiting');
      logic.setVar(SV.INS_COMMAND, 3);
      expect(logic.callMcode(40, command(obLogic), caller)).toBe(IR.REPEAT);
      expect(instruction().command).toBe(3);
      expect(logic.peek(obLogic, LOGIC.LOOPING)).toBe(0);
    });

    it('waits for the target to become free before it finishes, not only for its own send', () => {
      // The bug this guards: reading the looping bit and returning CONT on the
      // same cycle the command went out. The target would never get a chance
      // to run, and every line of a conversation would be skipped.
      const { logic, caller, obLogic, targetIs } = conversationLogic();
      const params = command(obLogic);
      targetIs('waiting');
      expect(logic.callMcode(40, params, caller)).toBe(IR.REPEAT);
      logic.setVar(SV.INS_COMMAND, 0);
      targetIs('busy');
      for (let cycle = 0; cycle < 5; cycle++) {
        expect(logic.callMcode(40, params, caller)).toBe(IR.REPEAT);
      }
    });
  });

  describe('fnTheyDo', () => {
    const params = Int32Array.from([TARGET, 7, 11, 12, 13, 14, 15]);

    it('sends the command and carries straight on', () => {
      const { logic, caller, targetIs, instruction } = conversationLogic();
      targetIs('waiting');
      expect(logic.callMcode(41, params, caller)).toBe(IR.CONT);
      expect(instruction()).toEqual({ speechId: TARGET, command: 7, ins: [11, 12, 13, 14, 15] });
    });

    it('repeats without sending while the target is busy', () => {
      const { logic, caller, targetIs, instruction } = conversationLogic();
      targetIs('busy');
      expect(logic.callMcode(41, params, caller)).toBe(IR.REPEAT);
      expect(instruction().command).toBe(0);
    });
  });

  describe('starting and ending a conversation', () => {
    it('resets the chooser count only when this is not a return to the menu', () => {
      const { logic, caller } = conversationLogic();
      logic.setVar(SV.CHOOSER_COUNT_FLAG, 4);
      logic.setVar(SV.TALK_FLAG, 1); // already talking: back for another chooser
      logic.callMcode(24, Int32Array.from([]), caller);
      expect(logic.getVar(SV.CHOOSER_COUNT_FLAG)).toBe(4);

      logic.setVar(SV.TALK_FLAG, 0);
      logic.callMcode(24, Int32Array.from([]), caller);
      expect(logic.getVar(SV.CHOOSER_COUNT_FLAG)).toBe(0);
    });

    it('takes the pointer away while the conversation runs', () => {
      const { logic, caller } = conversationLogic();
      logic.setVar(SV.MOUSE_AVAILABLE, 1);
      logic.callMcode(24, Int32Array.from([]), caller);
      expect(logic.getVar(SV.MOUSE_AVAILABLE)).toBe(0);
    });

    it('clears the talk flag at the end', () => {
      const { logic, caller } = conversationLogic();
      logic.setVar(SV.TALK_FLAG, 1);
      expect(logic.callMcode(25, Int32Array.from([]), caller)).toBe(IR.CONT);
      expect(logic.getVar(SV.TALK_FLAG)).toBe(0);
    });
  });

  describe('fnAddSequenceText', () => {
    it('queues nothing on a release that sets DEMO, which is not a failure', () => {
      // Eight of these are reached on this install and every one is a
      // legitimate no-op. Counting them as unimplemented said the demo was
      // short of something it is not.
      const { logic, caller } = conversationLogic();
      logic.setVar(SV.DEMO, 1);
      expect(logic.callMcode(94, Int32Array.from([7, 0, 10]), caller)).toBe(IR.CONT);
      expect(logic.sequenceTextCount).toBe(0);
    });

    it('records the line off the demo, and stops at fifteen', () => {
      const { logic, caller } = conversationLogic();
      logic.setVar(SV.DEMO, 0);
      for (let line = 0; line < 20; line++) {
        expect(logic.callMcode(94, Int32Array.from([line, line * 10, line * 10 + 9]), caller)).toBe(
          IR.CONT,
        );
      }
      // MAX_SEQUENCE_TEXT_LINES. ScummVM asserts here; overflowing the list
      // silently would be worse than either.
      expect(logic.sequenceTextCount).toBe(15);
    });
  });
});

/**
 * The conversation menu: the four opcodes that put a choice in front of a player.
 *
 * The gap this closes was measured by disassembling the mounted demo: across
 * its 905 game objects — the sweep's 973 counts the screen managers too — the
 * scripts call `fnAddSubject` 567 times, `fnChoose` 57, `fnAddMenuObject` 66
 * and `fnRemoveChooser` 9 — and all four landed in
 * `default:` and were counted as unimplemented. A conversation would run its
 * lines and then repeat forever on the chooser, because `fnChoose` returning
 * `IR_CONT` with no packed response sends `CP_JUMP_ON_RETURNED` down entry 0
 * every time.
 *
 * **No playthrough of this demo reaches one.** The probe's own route — click
 * the fence, which is the only named thing it can reach — ends in a session
 * change and a cutscene, and the stall report names no unimplemented opcode at
 * all. So these drive the opcodes directly, which is the honest way to measure
 * something the install does not itself reach.
 */
describe('the conversation menu', () => {
  const SV = {
    RESULT: 1,
    MOUSE_X: 4,
    MOUSE_Y: 5,
    IN_SUBJECT: 6,
    OBJECT_HELD: 14,
    CHOOSER_COUNT_FLAG: 15,
    LEFT_BUTTON: 109,
    AUTO_SELECTED: 1115,
  };
  /** `EXIT_ICON`, `defs.h:204`. The one icon the auto-skip knows by number. */
  const EXIT_ICON = 65;
  /** `MENU_MASTER_OBJECT`, `mouse.h:29`. The object `buildMenu` runs. */
  const MENU_MASTER = 44;

  /**
   * A logic with a menu, a pointer, and a `menu_master` that carries two icons.
   *
   * The icons are real `ICON_FILE` resources rather than bare ids because the
   * renderer reads their pixels: an icon is two 35x30 images and the menu
   * chooses between them, so a fixture that held only ids could not tell a
   * greyed icon from a coloured one.
   */
  function menuLogic() {
    const globals = buildSword2Globals(new Array(1400).fill(0));
    const icons = new Map([
      [EXIT_ICON, buildSword2Icon('EXIT', 11, 12)],
      [70, buildSword2Icon('GRUB', 21, 22)],
      [71, buildSword2Icon('LABEL', 31, 32)],
      [72, buildSword2Icon('NEWSCUT', 41, 42)],
    ]);
    // `menu_master`'s script 0 is the one `buildMenu` runs: it registers every
    // object the player is carrying, one `fnAddMenuObject` per pocket, out of
    // its own local variables. This one has three pockets and `carry` says
    // what is in them, which is how a test makes the player pick something up
    // or lose it between two builds.
    const POCKETS = 3;
    const registerPocket = (at: number): number[] => [
      CP.PUSH_LOCAL_ADDR,
      ...i16(at),
      CP.CALL_MCODE,
      ...i16(23),
      1,
    ];
    const menuMaster = buildSword2Object(
      'menu_master',
      [[...registerPocket(0), ...registerPocket(8), ...registerPocket(16), CP.END_SCRIPT]],
      POCKETS * 8,
      3,
      MENU_MASTER,
    );
    const localsAt = parseSword2Object(menuMaster).localsAt;
    const locals = new DataView(menuMaster.buffer, menuMaster.byteOffset, menuMaster.byteLength);
    /** Fills the three `MenuObject` structures: an icon and its luggage. */
    const carry = (icons: readonly number[]): void => {
      for (let pocket = 0; pocket < POCKETS; pocket++) {
        const icon = icons[pocket] ?? 0;
        locals.setInt32(localsAt + pocket * 8, icon, true);
        locals.setInt32(localsAt + pocket * 8 + 4, icon ? icon + 630 : 0, true);
      }
    };
    carry([70, 71]);

    const resources = {
      fetch: (id: number) => {
        if (id === 1) return { bytes: globals, header: { fileType: 5 } };
        if (id === MENU_MASTER) return { bytes: menuMaster, header: { fileType: 3 } };
        const icon = icons.get(id);
        if (icon) return { bytes: icon, header: { fileType: 12 } };
        return null;
      },
      describeMissingResource: () => 'not in this fixture',
    } as unknown as Sword2Resources;

    const logic = new Sword2Logic(resources, {
      scrollOffset: () => ({ x: 0, y: 0 }),
      log: () => {},
    } as unknown as Sword2LogicHost);
    logic.initialise();
    const caller = object([], 32);

    /** Puts the pointer somewhere on the display and presses the left button. */
    const clickAt = (x: number, y: number): void => {
      logic.setVar(SV.MOUSE_X, x);
      logic.setVar(SV.MOUSE_Y, y);
      logic.setVar(SV.LEFT_BUTTON, 1);
    };
    /** The centre of pocket `n` on the bottom bar, in display pixels. */
    const pocketCentre = (n: number): { x: number; y: number } => ({
      x: SWORD2_ICON_START + n * (SWORD2_ICON_WIDTH + SWORD2_ICON_SPACING) + SWORD2_ICON_WIDTH / 2,
      y: SWORD2_BOTTOM_MENU_TOP + SWORD2_ICON_DEPTH / 2,
    });
    const addSubject = (id: number, ref: number): number =>
      logic.callMcode(12, Int32Array.from([id, ref]), caller);
    const choose = (): number => logic.callMcode(14, Int32Array.from([]), caller);

    return { logic, caller, carry, clickAt, pocketCentre, addSubject, choose };
  }

  /** The bottom bar's pockets, as the renderer would be handed them. */
  function bottomBar(logic: Sword2Logic): {
    shown: boolean;
    pockets: ReadonlyArray<{ icon: number; coloured: boolean } | null>;
  } {
    return logic.menu.bars[SWORD2_MENU.BOTTOM];
  }

  it('dispatches all four rather than reporting them unimplemented', () => {
    const { logic, caller, addSubject, choose } = menuLogic();
    addSubject(70, 5);
    choose();
    logic.callMcode(23, Int32Array.from([0]), caller); // fnAddMenuObject
    logic.callMcode(112, Int32Array.from([]), caller); // fnRemoveChooser
    expect(logic.describeUnimplemented()).toBeUndefined();
  });

  describe('fnAddSubject', () => {
    it('counts the subjects in IN_SUBJECT, which is where the game keeps the count', () => {
      const { logic, addSubject } = menuLogic();
      expect(addSubject(70, 5)).toBe(IR.CONT);
      addSubject(71, 6);
      expect(logic.getVar(SV.IN_SUBJECT)).toBe(2);
    });

    it('takes id -1 as the default response, which is not a subject', () => {
      // `icons.cpp:56-62`: -1 is "the response when someone uses an object on
      // a person and he doesn't know anything about it". Counting it as a
      // subject would put an icon on the bar for something that has no icon.
      const { logic, addSubject } = menuLogic();
      addSubject(70, 5);
      addSubject(-1, 99);
      expect(logic.getVar(SV.IN_SUBJECT)).toBe(1);
      expect(bottomBar(logic).pockets.filter(Boolean)).toHaveLength(0);
    });
  });

  describe('fnChoose', () => {
    it('puts the subjects on the bottom bar and waits for a click', () => {
      const { logic, addSubject, choose } = menuLogic();
      addSubject(70, 5);
      addSubject(71, 6);
      expect(choose()).toBe(IR.REPEAT);
      const bar = bottomBar(logic);
      expect(bar.shown).toBe(true);
      expect(bar.pockets.slice(0, 3)).toEqual([
        { icon: 70, coloured: true },
        { icon: 71, coloured: true },
        null,
      ]);
    });

    it('keeps waiting while the pointer is over the room rather than the bar', () => {
      const { addSubject, choose, clickAt, pocketCentre } = menuLogic();
      addSubject(70, 5);
      addSubject(71, 6);
      choose();
      clickAt(pocketCentre(0).x, 300);
      expect(choose()).toBe(IR.REPEAT);
    });

    it('keeps waiting on a click in the gap between two icons', () => {
      const { addSubject, choose, clickAt, pocketCentre } = menuLogic();
      addSubject(70, 5);
      addSubject(71, 6);
      choose();
      // Past the end of the second icon: two pockets reach to x 103, and the
      // five pixels after that are spacing rather than a third subject.
      clickAt(105, pocketCentre(0).y);
      expect(choose()).toBe(IR.REPEAT);
    });

    it('answers with the chosen subject’s reference, packed for the jump table', () => {
      const { logic, addSubject, choose, clickAt, pocketCentre } = menuLogic();
      addSubject(70, 5);
      addSubject(71, 6);
      choose();
      clickAt(pocketCentre(1).x, pocketCentre(1).y);
      // `IR_CONT | (response << 3)`, which is the one place in the game that
      // uses the packing (`function.cpp:178-196`).
      expect(choose()).toBe(IR.CONT | (6 << 3));
      // The bar closes, the count resets, and RESULT names what was picked
      // for the non-speech scripts that call the chooser themselves.
      expect(logic.getVar(SV.IN_SUBJECT)).toBe(0);
      expect(logic.getVar(SV.RESULT)).toBe(71);
    });

    it('greys the subjects that were not chosen', () => {
      const { logic, addSubject, choose, clickAt, pocketCentre } = menuLogic();
      addSubject(70, 5);
      addSubject(71, 6);
      choose();
      clickAt(pocketCentre(1).x, pocketCentre(1).y);
      choose();
      expect(bottomBar(logic).pockets.slice(0, 2)).toEqual([
        { icon: 70, coloured: false },
        { icon: 71, coloured: true },
      ]);
    });

    it('uses an object held on a person as the subject, without showing a bar', () => {
      // "The player used an object on a person... Act as if the user tried to
      // talk to the person about that object" (`mouse.cpp:889-912`).
      const { logic, addSubject, choose } = menuLogic();
      addSubject(70, 5);
      addSubject(71, 6);
      logic.setVar(SV.OBJECT_HELD, 71);
      expect(choose()).toBe(IR.CONT | (6 << 3));
      expect(bottomBar(logic).shown).toBe(false);
      expect(logic.getVar(SV.OBJECT_HELD)).toBe(0);
      expect(logic.getVar(SV.IN_SUBJECT)).toBe(0);
    });

    it('falls back to the default response for an object nobody knows about', () => {
      const { logic, addSubject, choose } = menuLogic();
      addSubject(70, 5);
      addSubject(-1, 99);
      logic.setVar(SV.OBJECT_HELD, 71);
      expect(choose()).toBe(IR.CONT | (99 << 3));
    });

    it('skips a first chooser whose only subject is the exit icon', () => {
      // "the player doesn't have anything to talk about. Skip it."
      // `AUTO_SELECTED` is set because the speech script branches on it.
      const { logic, addSubject, choose } = menuLogic();
      addSubject(EXIT_ICON, 4);
      expect(choose()).toBe(IR.CONT | (4 << 3));
      expect(logic.getVar(SV.AUTO_SELECTED)).toBe(1);
      expect(bottomBar(logic).shown).toBe(false);
    });

    it('shows that same lone exit icon once the conversation has been through a chooser', () => {
      const { logic, addSubject, choose } = menuLogic();
      logic.setVar(SV.CHOOSER_COUNT_FLAG, 1);
      addSubject(EXIT_ICON, 4);
      expect(choose()).toBe(IR.REPEAT);
      expect(logic.getVar(SV.AUTO_SELECTED)).toBe(0);
      expect(bottomBar(logic).shown).toBe(true);
    });
  });

  describe('fnRemoveChooser', () => {
    it('takes the bar down', () => {
      const { logic, caller, addSubject, choose } = menuLogic();
      addSubject(70, 5);
      addSubject(71, 6);
      choose();
      expect(bottomBar(logic).shown).toBe(true);
      expect(logic.callMcode(112, Int32Array.from([]), caller)).toBe(IR.CONT);
      expect(bottomBar(logic).shown).toBe(false);
    });
  });

  describe('fnAddMenuObject', () => {
    it('builds the inventory bar out of what menu_master registers', () => {
      // `fnRefreshInventory` (116) is what a script calls to rebuild the bar,
      // and `buildMenu` runs `menu_master`'s script 0 to find out what the
      // player is carrying — so the only way this opcode is reached is
      // through that script, and the only way to test it is to run it.
      const { logic, caller } = menuLogic();
      expect(logic.callMcode(116, Int32Array.from([]), caller)).toBe(IR.CONT);
      const bar = bottomBar(logic);
      expect(bar.shown).toBe(true);
      expect(bar.pockets.slice(0, 3).map((pocket) => pocket?.icon ?? null)).toEqual([70, 71, null]);
    });

    it('reads the icon and the luggage out of the structure the script points at', () => {
      const { logic, caller } = menuLogic();
      logic.callMcode(116, Int32Array.from([]), caller);
      expect(logic.menu.inventory).toEqual([
        { icon: 70, luggage: 700 },
        { icon: 71, luggage: 701 },
      ]);
    });

    it('colours only the object being examined, which is what the code does', () => {
      // Revolution's comment above `refreshInventory` says "Cause 'object_held'
      // icon to be greyed. The rest are colored", and the flag it sets makes
      // `buildMenu` do the opposite (`icons.cpp:160-164`). The code is what the
      // game runs. The comment is noted here so that reading the original later
      // does not look like a fault found in this engine.
      const { logic, caller } = menuLogic();
      logic.setVar(SV.OBJECT_HELD, 70);
      logic.callMcode(116, Int32Array.from([]), caller);
      expect(bottomBar(logic).pockets.slice(0, 2)).toEqual([
        { icon: 70, coloured: true },
        { icon: 71, coloured: false },
      ]);
    });

    it('greys the object being carried when the bar is built without examining one', () => {
      // The other branch of the same rule, which is the one an inventory the
      // player opened by hand would take. Driven through the module because no
      // opcode reaches it yet — there is no mouse mode for the bottom bar.
      const { logic, caller } = menuLogic();
      void caller;
      logic.setVar(SV.OBJECT_HELD, 70);
      logic.menu.buildMenu();
      expect(bottomBar(logic).pockets.slice(0, 2)).toEqual([
        { icon: 70, coloured: false },
        { icon: 71, coloured: true },
      ]);
    });

    it('keeps the order the bar already had and appends what is new', () => {
      // `buildMenu`'s whole middle section: "the new list is ordered in the
      // same way as the old list, with new objects added to the end of it".
      // Rebuilding from scratch would reshuffle a player's inventory every
      // time they picked something up.
      const { logic, caller, carry } = menuLogic();
      logic.callMcode(116, Int32Array.from([]), caller);
      // The player has given away the first object and picked up another.
      carry([0, 71, 72]);
      logic.callMcode(116, Int32Array.from([]), caller);
      expect(logic.menu.inventory.map((object) => object.icon)).toEqual([71, 72]);
      expect(
        bottomBar(logic)
          .pockets.slice(0, 3)
          .map((pocket) => pocket?.icon ?? null),
      ).toEqual([71, 72, null]);
    });
  });

  describe('a script driving the whole choice', () => {
    it('jumps to the branch the chosen subject names', () => {
      /*
       * The shape every speech script in the game uses, and the shape this
       * project could not run: two subjects, `fnChoose`, then a jump table
       * indexed by the response. Entry 0 is the "nothing chosen" branch, so a
       * chooser that answered a bare `IR_CONT` — which is what an
       * unimplemented `fnChoose` does — took entry 0 every time, whatever the
       * player clicked.
       */
      const { logic, clickAt, pocketCentre } = menuLogic();
      /** A scratch global each branch writes, so the test reads a choice. */
      const CHOSE = 300;
      const addSubject = (id: number, ref: number): number[] => [
        CP.PUSH_INT32,
        ...i32(id),
        CP.PUSH_INT32,
        ...i32(ref),
        CP.CALL_MCODE,
        ...i16(12),
        2,
      ];
      const branch = (value: number): number[] => [
        CP.PUSH_INT32,
        ...i32(value),
        CP.POP_GLOBAL_VAR32,
        ...i16(CHOSE),
        CP.END_SCRIPT,
      ];
      const preamble = [...addSubject(70, 1), ...addSubject(71, 2), CP.CALL_MCODE, ...i16(14), 0];
      // A jump is measured from the table's own first entry, which is where
      // the interpreter's `ip` sits when it reads one — so a branch's jump is
      // the rest of the table plus the branches before it.
      const branchBytes = branch(0).length;
      const jumps = [0, 1, 2].map((entry) => 3 * 4 + entry * branchBytes);
      const speaker = parseSword2Object(
        buildSword2Object('Speech script', [
          [
            ...preamble,
            CP.JUMP_ON_RETURNED,
            3,
            ...jumps.flatMap((jump) => i32(jump)),
            ...branch(10),
            ...branch(11),
            ...branch(12),
          ],
        ]),
      );

      // First pass: the subjects go up and the chooser waits, which is a
      // `IR_REPEAT` rewound to the call and reported to the cycle as a stop.
      expect(runSword2Script(speaker, logic, 0).result).toBe(IR.STOP);
      expect(logic.getVar(SV.IN_SUBJECT)).toBe(2);
      expect(logic.getVar(CHOSE)).toBe(0);

      // Second: the player clicks the second icon, and the table takes the
      // branch that subject's reference names.
      clickAt(pocketCentre(1).x, pocketCentre(1).y);
      expect(runSword2Script(speaker, logic, 0).result).toBe(IR.CONT);
      expect(logic.getVar(CHOSE)).toBe(12);
    });
  });
});

describe('fnSpeechProcess', () => {
  const TARGET = 100;
  /** Where sacco_12 keeps each structure, so the offsets are the game's own. */
  const OB_LOGIC = 0;
  const OB_GRAPHIC = 8;
  const OB_SPEECH = 44;
  const OB_MEGA = 80;
  /** `ob_speech.wait_state`. 44 + 32 is the local sacco_12's script 5 reads. */
  const WAIT_STATE_LOCAL = OB_SPEECH + 32;
  const SPEECH = { COMMAND: 8, INS1: 12, INS2: 16, INS3: 20, INS4: 24, INS5: 28, WAIT_STATE: 32 };
  const INS = { TALK: 1, BACKGROUND: 11, TRACE: 7, QUIT: 42 };
  const SV = {
    ID: 0,
    RESULT: 1,
    SPEECH_ID: 9,
    INS1: 10,
    INS2: 11,
    INS3: 12,
    INS_COMMAND: 59,
    INS4: 60,
    INS5: 61,
  };
  const TEXT_ID = 3258 * 0x10000 + 1;

  function talkerLogic(overrides: Partial<Sword2LogicHost> = {}) {
    const shown: Array<{ textId: number; x: number; y: number }> = [];
    const globals = buildSword2Globals(new Array(1400).fill(0));
    const empty = [CP.END_SCRIPT];
    // Script 5, the "get speech state" script every talker has: it hands the
    // asker its own wait_state and nothing else.
    const getSpeechState = [
      CP.PUSH_LOCAL_VAR32,
      ...i16(WAIT_STATE_LOCAL),
      CP.POP_GLOBAL_VAR32,
      ...i16(SV.RESULT),
      CP.END_SCRIPT,
    ];
    const targetBytes = buildSword2Object(
      'sacco',
      [empty, empty, empty, empty, empty, getSpeechState],
      32,
      3,
      TARGET,
    );
    const resources = {
      fetch: (id: number) => {
        if (id === 1) return { bytes: globals, header: { fileType: 5 } };
        if (id === TARGET) return { bytes: targetBytes, header: { fileType: 3 } };
        return null;
      },
      describeMissingResource: () => 'not in this fixture',
    } as unknown as Sword2Resources;
    const host: Partial<Sword2LogicHost> = {
      speechFinished: () => true,
      stopSpeech: () => {},
      subtitles: () => true,
      speechLine: () => ({ wavId: 4242, text: 'Hello' }),
      requestSpeech: () => false,
      displayText: (textId, x, y) => {
        shown.push({ textId, x, y });
        return shown.length;
      },
      removeText: () => {},
      firstFrame: () => null,
      animFrameCount: () => 0,
      scrollOffset: () => ({ x: 0, y: 0 }),
      log: () => {},
      ...overrides,
    };
    const logic = new Sword2Logic(resources, host as Sword2LogicHost);
    logic.initialise();

    // The same bytes the logic will parse, so a poke through either is seen by
    // both — which is how the real thing works and what the test has to match.
    const target = parseSword2Object(targetBytes);
    const at = (field: number) => logic.encodeOffset(target, target.localsAt + field);
    const speech = at(OB_SPEECH);
    const params = Int32Array.from([at(OB_GRAPHIC), speech, at(OB_LOGIC), at(OB_MEGA)]);

    const caller = object([], 32);
    const callerLogic = logic.encodeOffset(caller, caller.localsAt);

    /** One cycle of the talker's own logic, with `ID` set as the run list sets it. */
    const talkerCycle = () => {
      logic.setVar(SV.ID, TARGET);
      return logic.callMcode(47, params, target);
    };
    const waitState = () => logic.peek(speech, SPEECH.WAIT_STATE);
    const command = () => logic.peek(speech, SPEECH.COMMAND);
    return {
      logic,
      target,
      caller,
      callerLogic,
      params,
      speech,
      shown,
      talkerCycle,
      waitState,
      command,
    };
  }

  it('answers "waiting" when it has nothing to do, which is what unblocks the asker', () => {
    const { logic, caller, talkerCycle, waitState } = talkerLogic();

    // The stub never wrote this, and fnWeWait below never returned.
    expect(talkerCycle()).toBe(IR.REPEAT);
    expect(waitState()).toBe(1);
    expect(logic.callMcode(39, Int32Array.from([TARGET]), caller)).toBe(IR.CONT);
  });

  it('takes a command addressed to it, and leaves one addressed to somebody else', () => {
    const { logic, talkerCycle, command, waitState } = talkerLogic();
    logic.setVar(SV.SPEECH_ID, TARGET + 1);
    logic.setVar(SV.INS_COMMAND, INS.BACKGROUND);
    talkerCycle();
    expect(command()).toBe(0);
    expect(logic.getVar(SV.INS_COMMAND)).toBe(INS.BACKGROUND);

    // Re-addressed, the same command is taken and run — `fnBackSprite` is one
    // of the six ScummVM treats as finishing the cycle it starts.
    logic.setVar(SV.SPEECH_ID, TARGET);
    talkerCycle();
    expect(logic.getVar(SV.INS_COMMAND)).toBe(0);
    expect(command()).toBe(0);
    expect(waitState()).toBe(1);
  });

  it('copies the command out of the globals, which the sender holds for one cycle', () => {
    const { logic, talkerCycle, speech } = talkerLogic();
    logic.setVar(SV.SPEECH_ID, TARGET);
    logic.setVar(SV.INS_COMMAND, INS.TRACE);
    for (const [index, slot] of [SV.INS1, SV.INS2, SV.INS3, SV.INS4, SV.INS5].entries()) {
      logic.setVar(slot, 70 + index);
    }
    talkerCycle();

    expect(
      [SPEECH.INS1, SPEECH.INS2, SPEECH.INS3, SPEECH.INS4, SPEECH.INS5].map((field) =>
        logic.peek(speech, field),
      ),
    ).toEqual([70, 71, 72, 73, 74]);
    // Both cleared: the mailbox is free for the next sender.
    expect(logic.getVar(SV.SPEECH_ID)).toBe(0);
    expect(logic.getVar(SV.INS_COMMAND)).toBe(0);
  });

  it('cancels a command it has no arm for rather than sticking on it', () => {
    // `INS_trace` is in Revolution's enum and in nobody's switch, ScummVM's
    // included. Cancelling is theirs, not this project giving up.
    const { logic, talkerCycle, command, waitState } = talkerLogic();
    logic.setVar(SV.SPEECH_ID, TARGET);
    logic.setVar(SV.INS_COMMAND, INS.TRACE);
    talkerCycle();
    expect(command()).toBe(0);
    expect(waitState()).toBe(1);
  });

  it('leaves the conversation on INS_quit', () => {
    const { logic, talkerCycle, command } = talkerLogic();
    logic.setVar(SV.SPEECH_ID, TARGET);
    logic.setVar(SV.INS_COMMAND, INS.QUIT);
    // Delivery and the command itself are the two passes of one cycle, so
    // `INS_quit` lets the script go on the same cycle it was sent.
    expect(talkerCycle()).toBe(IR.CONT);
    expect(command()).toBe(0);
    expect(logic.getVar(SV.INS_COMMAND)).toBe(0);
  });

  it('carries a line from fnTheyDoWeWait through to the text on screen and back', () => {
    // The whole loop, both halves, which is the only test that would have
    // caught the deadlock: neither opcode is wrong on its own.
    const { logic, caller, callerLogic, shown, talkerCycle, waitState } = talkerLogic();
    const ask = Int32Array.from([callerLogic, TARGET, INS.TALK, TEXT_ID, 0, 0, 0, 0]);

    // The talker has not run yet, so it is busy and the asker waits.
    expect(logic.callMcode(40, ask, caller)).toBe(IR.REPEAT);
    expect(logic.peek(callerLogic, 0)).toBe(0); // not looping: nothing sent

    talkerCycle();
    expect(waitState()).toBe(1);

    // Now the command goes out, and the talker picks it up and starts talking.
    expect(logic.callMcode(40, ask, caller)).toBe(IR.REPEAT);
    expect(logic.peek(callerLogic, 0)).toBe(1);
    expect(logic.getVar(SV.SPEECH_ID)).toBe(TARGET);
    talkerCycle();
    expect(waitState()).toBe(0);

    let cycles = 0;
    while (waitState() === 0 && cycles < 200) {
      expect(logic.callMcode(40, ask, caller)).toBe(IR.REPEAT);
      talkerCycle();
      cycles++;
    }
    // The line ran for its own length rather than being skipped past.
    expect(cycles).toBeGreaterThan(1);
    expect(shown.map((line) => line.textId)).toEqual([TEXT_ID]);

    // The line is over; the asker gets its turn back and stops looping.
    expect(logic.callMcode(40, ask, caller)).toBe(IR.CONT);
    expect(logic.peek(callerLogic, 0)).toBe(0);
  });
});
