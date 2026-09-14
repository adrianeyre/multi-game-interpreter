import { describe, expect, it } from 'vitest';
import { assembleV6, disassembleV6, formatV6Listing } from '../src/authoring/disassembleV6.js';
import { V6_SCRIPT } from './fixtureV6.js';
import { u16le } from './fixture.js';

const bytes = (values: number[]) => new Uint8Array(values);
const letters = (text: string) => [...text].map((character) => character.charCodeAt(0));

describe('reading v6 bytecode', () => {
  it('decodes every instruction of the fixture script', () => {
    const listing = disassembleV6(bytes(V6_SCRIPT));

    expect(listing.undecodedFrom).toBeNull();
    expect(listing.instructions.map((instruction) => instruction.name)).toEqual([
      'pushByte',
      'writeWordVar',
      'pushWordVar',
      'pushByte',
      'mul',
      'writeWordVar',
      'stopObjectCode',
    ]);
  });

  it('gives every instruction an offset and a length that tile the script', () => {
    const listing = disassembleV6(bytes(V6_SCRIPT));

    let at = 0;
    for (const instruction of listing.instructions) {
      expect(instruction.offset).toBe(at);
      at += instruction.length;
    }
    expect(at).toBe(V6_SCRIPT.length);
  });
});

describe('folding the stack back into expressions', () => {
  it('reads an assignment as an assignment', () => {
    const listing = disassembleV6(bytes([0x00, 0x07, 0x43, ...u16le(250), 0x66]));
    expect(listing.instructions[1].text).toBe('var250 = 7');
  });

  it('nests a call inside an assignment', () => {
    // pushWordVar var12; getObjectX; writeWordVar var250
    const listing = disassembleV6(bytes([0x03, ...u16le(12), 0x8d, 0x43, ...u16le(250), 0x66]));
    expect(listing.instructions[2].text).toBe('var250 = getObjectX(var12)');
  });

  it('keeps operand order in a subtraction, which a stack reverses', () => {
    // Instructions, not bytes: the two pushes are instructions of their own,
    // so `sub` is the third.
    const listing = disassembleV6(bytes([0x00, 0x0a, 0x00, 0x04, 0x15, 0x66]));
    expect(listing.instructions[2].text).toBe('10 - 4');
  });

  it('reads a two-dimensional array read the way it is written', () => {
    // pushByte 2 (row), pushByte 3 (column), wordArrayIndexedRead arr100
    const listing = disassembleV6(bytes([0x00, 0x02, 0x00, 0x03, 0x0b, ...u16le(100), 0x66]));
    expect(listing.instructions[2].text).toBe('arr100[2][3]');
  });

  it('reads an array write', () => {
    const listing = disassembleV6(bytes([0x00, 0x09, 0x00, 0x2a, 0x47, ...u16le(100), 0x66]));
    expect(listing.instructions[2].text).toBe('arr100[9] = 42');
  });

  it('renders a counted list when the count is a literal', () => {
    // pushByte 0 (flags), pushByte 3 (script), pushByte 2, args 7 and 8, count
    const listing = disassembleV6(
      bytes([0x00, 0x00, 0x00, 0x03, 0x00, 0x07, 0x00, 0x08, 0x00, 0x02, 0x5e, 0x66]),
    );
    // Fixed operands first, in the order the script pushed them (flags, then
    // script), then the list.
    expect(listing.instructions[5].text).toBe('startScript 0, 3, [7, 8]');
  });

  it('says "…" rather than inventing operands it does not have', () => {
    // `add` with nothing pushed: the operands came from somewhere this reader
    // did not see, so it must not claim to know them.
    const listing = disassembleV6(bytes([0x14, 0x66]));
    expect(listing.instructions[0].text).toBe('… + …');
  });
});

describe('jumps', () => {
  it('resolves a forward jump to an absolute target', () => {
    // jump +2 from offset 0: the instruction is 3 bytes, so it lands on 5.
    const listing = disassembleV6(bytes([0x73, ...u16le(2), 0x66, 0x66, 0x66]));
    expect(listing.instructions[0].target).toBe(5);
    expect(listing.instructions[0].text).toBe('jump -> 5');
  });

  it('resolves a backward jump', () => {
    const listing = disassembleV6(bytes([0x66, 0x73, ...u16le(0x10000 - 4), 0x66]));
    expect(listing.instructions[1].target).toBe(0);
  });
});

describe('stopping rather than guessing', () => {
  /**
   * v6 is regular enough to decode exactly, which is a reason to decode more of
   * it — not a reason to invent the instructions whose layout is still
   * unestablished. The ones absent from the table carry inline strings or
   * sub-opcode streams.
   */
  it('stops at an opcode with no known layout and says which', () => {
    // 0xD3 is a gap in v6's table: no instruction has that number.
    const listing = disassembleV6(bytes([0x00, 0x01, 0xd3, 0x00, 0x02, 0x66]));

    expect(listing.undecodedFrom).toBe(2);
    expect(listing.reason).toMatch(/0xd3/);
    // One instruction read — the `pushByte` — before the unknown opcode.
    expect(listing.instructions).toHaveLength(1);
  });

  it('keeps the undecoded bytes in the listing, exactly as they were', () => {
    const code = bytes([0x00, 0x01, 0xd3, 0xde, 0xad]);
    const text = formatV6Listing(disassembleV6(code), code);

    expect(text).toMatch(/3 bytes follow, kept exactly as they were/);
    expect(text).toMatch(/d3 de ad/);
  });

  /**
   * A sub-opcode instruction's length depends on the sub-opcode, so an
   * unrecognised one is as unmeasurable as an unrecognised opcode — and stops
   * the reading at the *instruction*, not at the sub-opcode byte, since the
   * opcode is part of what cannot be re-emitted from a decoded form.
   */
  it('stops at a sub-opcode with no known layout and names the family', () => {
    const listing = disassembleV6(bytes([0x00, 0x01, 0x9c, 0xde, 0x66]));

    expect(listing.undecodedFrom).toBe(2);
    expect(listing.reason).toMatch(/roomOps sub-opcode 222/);
  });

  it('stops at a message with no terminator rather than reading to the end', () => {
    const listing = disassembleV6(bytes([0x00, 0x01, 0xba, ...letters('unterminated')]));

    expect(listing.undecodedFrom).toBe(2);
    expect(listing.reason).toMatch(/no terminator/);
  });
});

describe('the instructions that carry a sub-opcode', () => {
  it('reads a run of actorOps as one instruction each', () => {
    const listing = disassembleV6(
      bytes([
        0x00,
        0x03,
        0x9d,
        197, // actorOps.setCurrentActor(3)
        0x00,
        0x0c,
        0x9d,
        84, // actorOps.elevation(12)
        0x9d,
        83, // actorOps.default()
        0x66,
      ]),
    );

    expect(listing.undecodedFrom).toBeNull();
    expect(listing.instructions.map((instruction) => instruction.text)).toEqual([
      '3',
      'actorOps.setCurrentActor(3)',
      '12',
      'actorOps.elevation(12)',
      'actorOps.default()',
      'stopObjectCode',
    ]);
  });

  it('measures the operand a sub-opcode form carries in the code stream', () => {
    const listing = disassembleV6(
      bytes([
        0x00,
        0x09,
        0xbc,
        199, // dimArray.int(9) of array 700
        ...u16le(700),
        0x66,
      ]),
    );

    expect(listing.undecodedFrom).toBeNull();
    expect(listing.instructions[1].text).toBe('dimArray.int(9, 700)');
    expect(listing.instructions[1].length).toBe(4);
  });

  it('measures the inline message a sub-opcode form carries', () => {
    const listing = disassembleV6(
      bytes([0x00, 0x02, 0x9d, 197, 0x9d, 88, ...letters('Bernard'), 0x00, 0x66]),
    );

    expect(listing.undecodedFrom).toBeNull();
    expect(listing.instructions.at(-1)?.name).toBe('stopObjectCode');
    expect(listing.instructions[2].text).toContain('Bernard');
  });

  it('shows a control code as a code rather than decoding it as text', () => {
    // The reader cannot substitute a variable into a message; only the engine
    // can, at the moment it says the line.
    const listing = disassembleV6(
      bytes([0x00, 0x01, 0xba, ...letters('Hi'), 0xff, 0x04, 0x0a, 0x00, 0x00, 0x66]),
    );

    expect(listing.undecodedFrom).toBeNull();
    expect(listing.instructions[1].text).toContain('Hi');
    expect(listing.instructions[1].text).toContain('x04');
  });

  it('folds the whole print family into one line each', () => {
    const listing = disassembleV6(
      bytes([0xb4, 254, 0x00, 0x09, 0xb4, 66, 0xb4, 75, ...letters('Look'), 0x00, 0x66]),
    );

    expect(listing.undecodedFrom).toBeNull();
    expect(listing.instructions.map((instruction) => instruction.name)).toEqual([
      'printLine.begin',
      'pushByte',
      'printLine.color',
      'printLine.text',
      'stopObjectCode',
    ]);
  });
});

describe('re-emitting a script', () => {
  /**
   * The property instruction-level editing rests on (ADR 0005): decode, change
   * nothing, re-emit, and the bytes are the ones that arrived. Without it an
   * edit anywhere rewrites everything, and no author could trust the result.
   */
  it('reproduces an untouched script byte for byte', () => {
    const code = bytes(V6_SCRIPT);
    expect(Array.from(assembleV6(disassembleV6(code), code))).toEqual(Array.from(code));
  });

  it('reproduces a script it could only partly read', () => {
    const code = bytes([0x00, 0x01, 0x43, ...u16le(9), 0xd3, 0xde, 0xad, 0xbe]);
    expect(Array.from(assembleV6(disassembleV6(code), code))).toEqual(Array.from(code));
  });

  /**
   * The sub-opcode instructions are re-emitted from their raw bytes rather than
   * from decoded fields, which is what keeps this exact for a script full of
   * them — a real one is, from its first line of dialogue onwards.
   */
  it('reproduces a script of sub-opcode instructions and inline text', () => {
    const code = bytes([
      0x00,
      0x03,
      0x9d,
      197, // actorOps.setCurrentActor(3)
      0x9d,
      88, // actorOps.name("Bernard")
      ...letters('Bernard'),
      0x00,
      0x00,
      0x09,
      0x9c,
      181, // roomOps.fade(9)
      0x00,
      0x03,
      0xba, // talkActor
      ...letters('Hello'),
      0x00,
      0xa9,
      169, // wait.forMessage()
      0x66,
    ]);

    const listing = disassembleV6(code);
    expect(listing.undecodedFrom).toBeNull();
    expect(Array.from(assembleV6(listing, code))).toEqual(Array.from(code));
  });

  it('changes only the instruction that was edited', () => {
    const code = bytes(V6_SCRIPT);
    const listing = disassembleV6(code);

    // The first instruction is `pushByte 7`. Make it push 9 instead.
    const first = listing.instructions[0];
    expect(first.name).toBe('pushByte');
    listing.instructions[0] = { ...first, streamOperand: 9 };

    const rebuilt = assembleV6(listing, code);
    expect(rebuilt).toHaveLength(code.length);
    expect(rebuilt[1]).toBe(9);
    // Everything else is untouched.
    expect(Array.from(rebuilt.subarray(2))).toEqual(Array.from(code.subarray(2)));
  });
});

describe('the formatted listing', () => {
  it('shows statements rather than repeating each push on its own line', () => {
    const text = formatV6Listing(disassembleV6(bytes(V6_SCRIPT)), bytes(V6_SCRIPT));
    const lines = text.split('\n').map((line) => line.trim());

    expect(lines).toEqual(['2  var250 = 7', '11  var251 = var250 * 2', '14  stopObjectCode']);
  });
});
