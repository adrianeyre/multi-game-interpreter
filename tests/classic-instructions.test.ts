import { describe, expect, it } from 'vitest';

import { assembleClassic, disassembleClassic } from '../src/authoring/disassembleClassic.js';

/**
 * The Classic forms whose length is not derivable from the encoding.
 *
 * Every one of these is a place the old reader stopped, and every one is a
 * place a wrong measurement would shift every instruction after it. The
 * fixtures are hand-built rather than captured, which is Tier 1's trap
 * exactly — so each is followed by `stopObjectCode`, and the assertion is that
 * the reader lands on it. A length that is wrong by any amount does not.
 */
function reads(bytes: number[], names: string[], version: 2 | 3 | 4 | 5 = 5): void {
  const code = new Uint8Array([...bytes, 0x00]);
  const listing = disassembleClassic(code, version);

  expect(listing.reason).toBeNull();
  expect(listing.instructions.map((instruction) => instruction.name)).toEqual([
    ...names,
    'stopObjectCode',
  ]);
  expect(Array.from(assembleClassic(listing, code))).toEqual(Array.from(code));
}

describe('measuring the Classic forms that carry their own length', () => {
  it('an argument list terminated by 0xFF', () => {
    // startScript 9 [1, 2]
    reads([0x0a, 0x09, 0x00, 0x01, 0x00, 0x00, 0x02, 0x00, 0xff], ['startScript']);
  });

  it('an inline message with a control code that takes no argument', () => {
    // setObjectName 10, "A" then 0xFF 0x03 (a code with no argument)
    reads([0x54, 0x0a, 0x00, 0x41, 0xff, 0x03, 0x00], ['setObjectName']);
  });

  it('an inline message with a control code that takes a word', () => {
    // The same, with code 4 — which carries two more bytes. Measuring it as
    // one is how a string's own letters get executed as instructions.
    reads([0x54, 0x0a, 0x00, 0x41, 0xff, 0x04, 0x01, 0x02, 0x00], ['setObjectName']);
  });

  it('a sub-opcode stream that ends on 0xFF', () => {
    // actorOps 1: costume 3, talk colour 12, then end.
    reads([0x13, 0x01, 0x01, 0x03, 0x0c, 0x0c, 0xff], ['actorOps']);
  });

  it('the print family, whose terminator is a message rather than 0xFF', () => {
    // print 1: colour 5, then text "Hi". Sub-opcode 15 ends the instruction by
    // returning, so nothing looks for another sub-opcode after the message.
    reads([0x14, 0x01, 0x01, 0x05, 0x0f, 0x48, 0x69, 0x00], ['print']);
  });

  it('roomOps 15, whose four operands sit behind three sub-opcode bytes', () => {
    // The measurement the Fate of Atlantis round-trip caught: read as three
    // operands behind two sub-opcodes, this leaves two bytes behind.
    reads([0x33, 0x0f, 0x20, 0x0f, 0x10, 0xbe, 0x0f, 0x01], ['roomOps']);
  });

  it('roomOps 13, whose string is a filename rather than a message', () => {
    // 0xFF here is a character, not a control code. A reader that treated it as
    // one would consume two bytes past the end of the name.
    reads([0x33, 0x0d, 0x01, 0x61, 0x2e, 0x69, 0x71, 0x00], ['roomOps']);
  });

  it('setVarRange, whose count is in the stream and whose width is a mode bit', () => {
    // Three bytes, because the 0x80 bit is clear.
    reads([0x26, 0x0a, 0x00, 0x03, 0x01, 0x02, 0x03], ['setVarRange']);
    // Three words, because it is set.
    reads([0xa6, 0x0a, 0x00, 0x03, 0x01, 0x00, 0x02, 0x00, 0x03, 0x00], ['setVarRange']);
  });

  it('beginOverride, which steps over the jump that follows it when enabled', () => {
    reads([0x58, 0x01, 0x18, 0x05, 0x00], ['beginOverride']);
    // Disabled, there is no jump to step over and the instruction is two bytes.
    reads([0x58, 0x00], ['beginOverride']);
  });

  it('doSentence 0xFE, which stops before the two objects the others read', () => {
    reads([0x19, 0xfe], ['doSentence']);
    reads([0x19, 0x01, 0x0a, 0x00, 0x0b, 0x00], ['doSentence']);
  });

  it('expression, which can nest a whole instruction inside itself', () => {
    // expression -> Var[10]: push 2, then run `getRandomNr -> Var[0], 6`, add.
    reads(
      [0xac, 0x0a, 0x00, 0x01, 0x02, 0x00, 0x06, 0x16, 0x00, 0x00, 0x06, 0x02, 0xff],
      ['expression'],
    );
  });

  it('an indexed variable, which carries its subscript in the stream', () => {
    // move -> Var[10], Var[0x2005][…]: the indexed form is two bytes longer,
    // and reading it as a plain variable reads the rest of the script as noise.
    reads([0x9a, 0x0a, 0x00, 0x05, 0x20, 0x01, 0x00], ['move']);
  });

  it('names the three address spaces a variable reference can select', () => {
    // The top nibble picks the space, and the interpreter's `readVar` branches
    // on it: 0x8000 is a bit variable, 0x4000 a script local, neither a global.
    // Printed as `Var[n]` all three read as the same number, and Loom's distaff
    // is gated on `Bit[14]`/`Bit[1]` — which as `Var[14]`/`Var[1]` read as the
    // music timer and VAR_EGO, and make a live branch look like dead code.
    const listing = disassembleClassic(
      new Uint8Array([
        0x28,
        0x0e,
        0x80,
        0x02,
        0x00, // equalZero Bit[14], jump +2
        0x28,
        0x03,
        0x40,
        0x02,
        0x00, // equalZero Local[3], jump +2
        0x28,
        0x96,
        0x00,
        0x02,
        0x00, // equalZero Var[150], jump +2
        0x00,
      ]),
      4,
    );
    expect(listing.instructions.map((each) => each.text)).toEqual([
      'equalZero Bit[14], jump +2',
      'equalZero Local[3], jump +2',
      'equalZero Var[150], jump +2',
      'stopObjectCode',
    ]);
  });

  it('pseudoRoom, whose list ends on a zero rather than on 0xFF', () => {
    reads([0xcc, 0x0a, 0x82, 0x83, 0x00], ['pseudoRoom']);
  });

  it('a stack list inside a sub-opcode: charset colours', () => {
    reads([0x2c, 0x0e, 0x00, 0x01, 0x00, 0x00, 0x02, 0x00, 0xff], ['cursorCommand']);
  });
});

describe('editing a Classic instruction', () => {
  it('writes a field back without moving anything around it', () => {
    const code = new Uint8Array([0x1c, 0x03, 0x0a, 0x09, 0x00, 0x01, 0x00, 0xff, 0x00]);
    const listing = disassembleClassic(code, 5);

    // startSound's operand.
    listing.instructions[0].fields[0].value = 42;
    const rebuilt = assembleClassic(listing, code);

    expect(rebuilt.length).toBe(code.length);
    expect(rebuilt[1]).toBe(42);
    expect(Array.from(rebuilt.subarray(2))).toEqual(Array.from(code.subarray(2)));
  });

  it('offers a word field as two bytes so a large value survives', () => {
    // walkActorTo 1, 300, 80 — x is a word, and 300 does not fit in a byte.
    const code = new Uint8Array([0x1e, 0x01, 0x2c, 0x01, 0x50, 0x00, 0x00]);
    const listing = disassembleClassic(code, 5);
    const x = listing.instructions[0].fields[1];

    expect(x.width).toBe(2);
    expect(x.value).toBe(300);

    x.value = 400;
    const rebuilt = assembleClassic(listing, code);
    expect(disassembleClassic(rebuilt, 5).instructions[0].fields[1].value).toBe(400);
  });
});
