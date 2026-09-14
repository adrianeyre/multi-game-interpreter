import { describe, expect, it } from 'vitest';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { detectAgiGame } from '../src/engine/agi/resource/agiDetect.js';
import { AgiResources } from '../src/engine/agi/resource/AgiResources.js';
import { disassembleLogic, formatLogicListing } from '../src/authoring/agi/disassembleLogic.js';
import {
  avisDurgan,
  readLogicMessages,
  writeLogicMessages,
} from '../src/engine/agi/resource/logicMessages.js';
import { opcodeSetFor } from '../src/engine/agi/script/opcodes.js';
import type { Target } from '../src/authoring/target.js';
import { buildAgiV2Fixture, buildAgiV3Fixture, buildLogic, u16le } from './fixtureAgi.js';

const DOS_2917: Target = {
  engine: 'agi',
  interpreter: 0x2917,
  platform: 'dos',
  identification: 'agidata',
};

function sourceFrom(files: Map<string, Uint8Array>): MemoryDataSource {
  const source = new MemoryDataSource('agi-fixture');
  for (const [name, bytes] of files) source.set(name, bytes);
  return source;
}

describe('the arity table comes from the Target, never from one hardcoded set', () => {
  /**
   * The fact that shapes every file that reads AGI bytecode: an instruction's
   * argument count is not in the bytecode. `quit` takes no argument under 2.089
   * and one under everything later, and both are AGI v2 (ADR 0012).
   */
  it('gives quit no argument at exactly 2.089 and one everywhere else', () => {
    const at2089 = opcodeSetFor({ engine: 'agi', interpreter: 0x2089, platform: 'dos' });
    const later = opcodeSetFor({ engine: 'agi', interpreter: 0x2917, platform: 'dos' });

    expect(at2089.actions[0x86]?.operands).toHaveLength(0);
    expect(later.actions[0x86]?.operands).toHaveLength(1);
    // And it is exactly 2.089, not "below it": earlier builds take the
    // argument, which is why the condition is an equality.
    const earlier = opcodeSetFor({ engine: 'agi', interpreter: 0x2072, platform: 'dos' });
    expect(earlier.actions[0x86]?.operands).toHaveLength(1);
  });

  it('gives print.at three operands below 2.089 and four at or above it', () => {
    const early = opcodeSetFor({ engine: 'agi', interpreter: 0x2072, platform: 'dos' });
    const later = opcodeSetFor({ engine: 'agi', interpreter: 0x2917, platform: 'dos' });

    expect(early.actions[0x97]?.operands).toHaveLength(3);
    expect(early.actions[0x98]?.operands).toHaveLength(3);
    expect(later.actions[0x97]?.operands).toHaveLength(4);
    expect(later.actions[0x98]?.operands).toHaveLength(4);
  });

  it('gives hide.mouse and hold.key an operand at exactly 3.002.086', () => {
    const at3086 = opcodeSetFor({ engine: 'agi', interpreter: 0x3086, platform: 'dos' });
    const later = opcodeSetFor({ engine: 'agi', interpreter: 0x3149, platform: 'dos' });

    expect(at3086.actions[0xb0]?.operands).toHaveLength(1);
    expect(at3086.actions[0xad]?.operands).toHaveLength(1);
    expect(later.actions[0xb0]?.operands).toHaveLength(0);
    expect(later.actions[0xad]?.operands).toHaveLength(0);
  });

  it('changes hide.mouse and show.mouse arity on Apple IIgs', () => {
    const iigs = opcodeSetFor({ engine: 'agi', interpreter: 0x3149, platform: 'apple-ii-gs' });
    expect(iigs.actions[0xb0]?.operands).toHaveLength(1);
    expect(iigs.actions[0xb2]?.operands).toHaveLength(1);
  });

  /**
   * The sharpest illustration of why a Target has to carry the platform:
   * `discard.sound` is not the same *opcode number* on Apple IIgs, so a table
   * keyed on version alone would call the wrong instruction rather than take
   * the wrong number of arguments.
   */
  it('moves discard.sound to 0xAA on an Apple IIgs at or below 2.440', () => {
    const early = opcodeSetFor({ engine: 'agi', interpreter: 0x2440, platform: 'apple-ii-gs' });
    expect(early.actions[0xaa]?.name).toBe('discard.sound');
    expect(early.adjustments.join(' ')).toMatch(/discard\.sound is opcode 0xAA/);
  });

  it('moves discard.sound to 0xAE on an Apple IIgs between 2.440 and 3.0', () => {
    const middle = opcodeSetFor({ engine: 'agi', interpreter: 0x2917, platform: 'apple-ii-gs' });
    expect(middle.actions[0xae]?.name).toBe('discard.sound');
    // And the two slots those games use that nobody has identified still
    // consume the right number of bytes, rather than derailing the reader.
    expect(middle.actions[0xaf]?.operands).toHaveLength(1);
    expect(middle.actions[0xb0]?.operands).toHaveLength(1);
  });

  it('leaves discard.sound at 0xAF on an Apple IIgs v3 game', () => {
    const late = opcodeSetFor({ engine: 'agi', interpreter: 0x3149, platform: 'apple-ii-gs' });
    expect(late.actions[0xaf]?.name).toBe('discard.sound');
  });

  /** Three titles disagree with their own interpreter version. */
  it('gives adj.ego.move.to.x.y two operands for Gold Rush on Amiga', () => {
    const goldRush = opcodeSetFor({
      engine: 'agi',
      interpreter: 0x3149,
      platform: 'amiga',
      gameId: 'goldrush',
    });
    expect(goldRush.actions[0xb6]?.operands).toHaveLength(2);

    // Same game on DOS takes none, and another game on Amiga takes none.
    expect(
      opcodeSetFor({ engine: 'agi', interpreter: 0x3149, platform: 'dos', gameId: 'goldrush' })
        .actions[0xb6]?.operands,
    ).toHaveLength(0);
    expect(
      opcodeSetFor({ engine: 'agi', interpreter: 0x3149, platform: 'amiga', gameId: 'kq3' })
        .actions[0xb6]?.operands,
    ).toHaveLength(0);
  });

  /**
   * A disassembly is only as trustworthy as the table behind it, so "which
   * table" has to be reportable — it is the question a wrong-looking listing
   * turns on (ADR 0013).
   */
  it('records every adjustment it made rather than applying them silently', () => {
    const set = opcodeSetFor({ engine: 'agi', interpreter: 0x2089, platform: 'dos' });
    expect(set.adjustments.join(' ')).toMatch(/quit.*exactly 2\.089/);
  });

  it('holds 183 action commands and 20 condition slots', () => {
    const set = opcodeSetFor(DOS_2917);
    expect(set.actions).toHaveLength(183);
    expect(set.tests).toHaveLength(20);
  });

  it('refuses to build an AGI instruction set for a SCUMM Target', () => {
    expect(() => opcodeSetFor({ engine: 'scumm', version: 6 })).toThrow(/not AGI/);
  });
});

describe('a Logic message table', () => {
  it('reads messages back 1-indexed, as print addresses them', () => {
    const logic = new Uint8Array(buildLogic({ code: [0x00], messages: ['first', 'second'] }));
    const messages = readLogicMessages(logic, true);

    expect(messages.texts[0]).toBeUndefined();
    expect(messages.texts[1]).toBe('first');
    expect(messages.texts[2]).toBe('second');
  });

  /** Getting this backwards turns every message into noise. */
  it('un-obfuscates when told to and leaves plain text alone when told not to', () => {
    const encrypted = new Uint8Array(buildLogic({ code: [0x00], messages: ['hello'] }));
    const plain = new Uint8Array(buildLogic({ code: [0x00], messages: ['hello'], encrypt: false }));

    expect(readLogicMessages(encrypted, true).texts[1]).toBe('hello');
    expect(readLogicMessages(plain, false).texts[1]).toBe('hello');
    // And the wrong way round produces noise rather than an error, which is
    // exactly why the resource layer has to be asked rather than guessed at.
    expect(readLogicMessages(plain, true).texts[1]).not.toBe('hello');
  });

  it('applies the key cyclically from the start of the text region', () => {
    const round = avisDurgan(avisDurgan(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])));
    expect([...round]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('re-emits an untouched table byte for byte', () => {
    for (const encrypt of [true, false]) {
      const original = new Uint8Array(
        buildLogic({ code: [0x00, 0x00], messages: ['one', 'two', 'three'], encrypt }),
      );
      const messages = readLogicMessages(original, encrypt);
      const written = writeLogicMessages(messages.texts, encrypt);

      expect([...written]).toEqual([...original.subarray(messages.sectionAt)]);
    }
  });

  it('refuses a resource whose length field points past its own end', () => {
    const logic = new Uint8Array([0xff, 0xff, 1, 2, 3]);
    expect(() => readLogicMessages(logic, true)).toThrow(/past the end/);
  });

  it('refuses a resource too short to hold its own length field', () => {
    expect(() => readLogicMessages(new Uint8Array([1]), true)).toThrow(/two-byte length/);
  });
});

describe('disassembling the fixture', () => {
  async function resourcesFor(which: 'v2' | 'v3') {
    const fixture = which === 'v3' ? buildAgiV3Fixture() : buildAgiV2Fixture();
    const source = sourceFrom(fixture.files);
    return AgiResources.load(source, await detectAgiGame(source));
  }

  /** #126's own bar: every Logic in the fixture disassembles fully. */
  it.each(['v2', 'v3'] as const)('decodes every Logic in the %s fixture fully', async (which) => {
    const resources = await resourcesFor(which);

    for (const number of resources.list('logic')) {
      const listing = disassembleLogic(resources.read('logic', number), DOS_2917, {
        encryptedMessages: !resources.wasCompressed('logic', number),
      });

      expect(listing.stopped, `logic ${number}: ${listing.stopped?.reason}`).toBeUndefined();
      expect(listing.unknownOpcodes).toHaveLength(0);
      expect(listing.instructions.length).toBeGreaterThan(0);
    }
  });

  it('reads the fixture boot logic as the if-block it is', async () => {
    const resources = await resourcesFor('v2');
    const listing = disassembleLogic(resources.read('logic', 0), DOS_2917);

    const [first] = listing.instructions;
    expect(first.kind).toBe('if');
    expect(first.conditions).toHaveLength(1);
    expect(first.conditions?.[0]).toMatchObject({
      name: 'isset',
      negated: false,
      operands: [{ kind: 'flag', value: 11 }],
    });
    // The jump target is where the block ends, worked out here so nothing
    // downstream has to redo the arithmetic that makes an else reconstructable.
    expect(first.target).toBe(first.offset + first.size + 2);

    // `call.v(v0)` is the whole of how a room's own Logic runs: AGI has no
    // room-entry hook, so logic 0 calls the Logic whose number is the room.
    expect(listing.instructions.map((i) => i.name)).toEqual(['if', 'new.room', 'call.v', 'return']);
  });

  it('reads the room logic said() with its word groups', async () => {
    const resources = await resourcesFor('v2');
    const listing = disassembleLogic(resources.read('logic', 1), DOS_2917);

    const said = listing.instructions
      .flatMap((i) => i.conditions ?? [])
      .find((c) => c.kind === 'said');
    expect(said?.words).toEqual([1]);
  });

  it('formats a listing with offsets and the messages beside it', async () => {
    const resources = await resourcesFor('v2');
    const text = formatLogicListing(disassembleLogic(resources.read('logic', 1), DOS_2917));

    expect(text).toMatch(/AGI v2 \(2\.917\)/);
    expect(text).toMatch(/draw\.pic/);
    expect(text).toMatch(/m1 = "You are in a small room\."/);
  });
});

describe('said, the one self-describing instruction', () => {
  /**
   * Every other opcode's length comes from a table outside the bytecode.
   * `said`'s comes from a count byte in the stream, which makes it the only
   * instruction whose length a reader can actually measure.
   */
  it('takes its length from the count byte rather than the arity table', () => {
    const code = [0xff, 0x0e, 3, ...u16le(11), ...u16le(22), ...u16le(33), 0xff, ...u16le(0), 0x00];
    const listing = disassembleLogic(new Uint8Array(buildLogic({ code, messages: [] })), DOS_2917);

    expect(listing.stopped).toBeUndefined();
    expect(listing.instructions[0].conditions?.[0].words).toEqual([11, 22, 33]);
    // And the instruction after it is reached, which is the real check: a
    // mismeasured said swallows whatever follows.
    expect(listing.instructions[1]?.name).toBe('return');
  });

  it('handles a said naming no words at all', () => {
    const code = [0xff, 0x0e, 0, 0xff, ...u16le(0), 0x00];
    const listing = disassembleLogic(new Uint8Array(buildLogic({ code, messages: [] })), DOS_2917);
    expect(listing.stopped).toBeUndefined();
    expect(listing.instructions[0].conditions?.[0].words).toEqual([]);
  });
});

describe('conditions, with or groups and negation', () => {
  it('groups an or and keeps the ands beside it', () => {
    // if (isset(f1) && (isset(f2) || isset(f3)))
    const code = [0xff, 0x07, 1, 0xfc, 0x07, 2, 0x07, 3, 0xfc, 0xff, ...u16le(0), 0x00];
    const listing = disassembleLogic(new Uint8Array(buildLogic({ code, messages: [] })), DOS_2917);

    expect(listing.stopped).toBeUndefined();
    const conditions = listing.instructions[0].conditions!;
    expect(conditions).toHaveLength(2);
    expect(conditions[0]).toMatchObject({ name: 'isset', negated: false });
    expect(conditions[1].kind).toBe('or');
    expect(conditions[1].terms?.map((t) => t.operands[0].value)).toEqual([2, 3]);
  });

  it('negates only the term the not precedes', () => {
    const code = [0xff, 0xfd, 0x07, 1, 0x07, 2, 0xff, ...u16le(0), 0x00];
    const listing = disassembleLogic(new Uint8Array(buildLogic({ code, messages: [] })), DOS_2917);

    const conditions = listing.instructions[0].conditions!;
    expect(conditions[0].negated).toBe(true);
    expect(conditions[1].negated).toBe(false);
  });

  it('refuses an if whose or group is never closed', () => {
    const code = [0xff, 0xfc, 0x07, 1, 0xff, ...u16le(0), 0x00];
    const listing = disassembleLogic(new Uint8Array(buildLogic({ code, messages: [] })), DOS_2917);
    expect(listing.stopped?.reason).toMatch(/"or" group/);
  });

  it('refuses a condition opcode that is not a test command', () => {
    // 0x40 is `object.on.water` as an action and nothing as a condition.
    const code = [0xff, 0x40, 1, 0xff, ...u16le(0), 0x00];
    const listing = disassembleLogic(new Uint8Array(buildLogic({ code, messages: [] })), DOS_2917);
    expect(listing.stopped?.reason).toMatch(/not.*a test command/);
  });
});

describe('stopping rather than guessing', () => {
  /**
   * `CONTEXT.md` says disassembly "stops rather than guessing when an
   * instruction's length cannot be measured". For AGI a length is *never*
   * measurable from the bytes, so the honest reading is that an opcode the
   * Target's table has no entry for ends the walk — a resync would produce a
   * plausible listing of instructions that are not in the resource.
   */
  it('stops at an opcode this build has no entry for, naming its byte value', () => {
    const code = [0x0c, 5, 0xc0, 0x00];
    const listing = disassembleLogic(new Uint8Array(buildLogic({ code, messages: [] })), DOS_2917);

    expect(listing.unknownOpcodes).toEqual([0xc0]);
    expect(listing.stopped?.offset).toBe(4);
    expect(listing.stopped?.reason).toMatch(/0xc0/);
    // Never skipped: the unknown opcode is in the listing, as an unknown.
    expect(listing.instructions.at(-1)).toMatchObject({ kind: 'unknown', opcode: 0xc0 });
  });

  it('includes the bytes either side of where it stopped', () => {
    const listing = disassembleLogic(
      new Uint8Array(buildLogic({ code: [0xc0], messages: [] })),
      DOS_2917,
    );
    // A misparse is only diagnosable from the bytes around it.
    expect(listing.stopped?.reason).toMatch(/@\d+ /);
  });

  it('stops when an instruction operands would run past the code section', () => {
    // `assignn` takes two operands and there is one byte left.
    const listing = disassembleLogic(
      new Uint8Array(buildLogic({ code: [0x03, 1], messages: [] })),
      DOS_2917,
    );
    expect(listing.stopped?.reason).toMatch(/run past the end/);
  });

  it('stops when an if never closes', () => {
    const listing = disassembleLogic(
      new Uint8Array(buildLogic({ code: [0xff, 0x07, 1], messages: [] })),
      DOS_2917,
    );
    expect(listing.stopped?.reason).toMatch(/without closing/);
  });

  /**
   * The rule restated for AGI: stop when the Target does not name an
   * interpreter, rather than decode on a default.
   */
  it('refuses a SCUMM Target outright rather than picking an AGI table', () => {
    expect(() =>
      disassembleLogic(new Uint8Array(buildLogic({ code: [0x00], messages: [] })), {
        engine: 'scumm',
        version: 5,
      }),
    ).toThrow(/not AGI/);
  });
});

describe('a goto reads as a signed displacement', () => {
  it('resolves a backwards jump, which is how AGI writes a loop', () => {
    const code = [0x00, 0xfe, ...u16le(0x10000 - 4)];
    const listing = disassembleLogic(new Uint8Array(buildLogic({ code, messages: [] })), DOS_2917);

    const goto = listing.instructions.find((i) => i.kind === 'goto')!;
    // Offsets are into the resource, and the code section starts at 2 — past
    // the two-byte length field. The goto sits at 3 and is three bytes long, so
    // a displacement of -4 lands on 2, which is the top of the code.
    expect(goto.offset).toBe(3);
    expect(goto.target).toBe(2);
  });
});
