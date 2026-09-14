import { describe, expect, it } from 'vitest';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { ScummEngine } from '../src/engine/ScummEngine.js';
import { buildFixture } from './fixture.js';

/**
 * Operand widths, pinned by what runs *after* the instruction.
 *
 * An instruction that consumes the wrong number of bytes does not fail where
 * it is: the program counter is left pointing into its own operands, so
 * everything after it is misread and the script eventually runs off its own
 * end. So each case here follows the instruction under test with a `move` into
 * a known variable — if that value arrives, the bytes before it were consumed
 * exactly.
 */
function runBoot(instruction: number[]) {
  const marker = [
    // VAR[100] = 1234
    0x1a, 100, 0, 0xd2, 0x04,
    // stopObjectCode
    0x00,
  ];
  const fixture = buildFixture({ bootScript: [...instruction, ...marker] });
  const source = new MemoryDataSource('operands');
  source.set(fixture.indexName, fixture.index);
  source.set(fixture.dataName, fixture.data);

  const messages: string[] = [];
  return ScummEngine.create(source, { onLog: (message) => messages.push(message) }).then(
    (engine) => {
      engine.boot(0);
      return { engine, messages, marker: engine.variables[100] };
    },
  );
}

describe('sub-opcode operand widths', () => {
  it('reads one byte for cursorCommand "set charset"', async () => {
    // 0x2c cursorCommand, sub-opcode 13 with a direct byte operand.
    const { engine, marker, messages } = await runBoot([0x2c, 13, 4]);

    expect(marker).toBe(1234);
    expect(engine.currentCharsetId).toBe(4);
    expect(messages.some((m) => /read past the end/.test(m))).toBe(false);
  });

  it('reads sixteen words for cursorCommand "charset colours"', async () => {
    // A vararg list: each item is its own flags byte (0 = a direct word)
    // followed by the word, and 0xFF ends the list.
    const colors = Array.from({ length: 16 }, (_, i) => [0x00, i + 1, 0]).flat();
    const { marker } = await runBoot([0x2c, 14, ...colors, 0xff]);
    expect(marker).toBe(1234);
  });

  it('reads one byte for actorOps "animation speed"', async () => {
    // 0x13 actorOps on actor 1, sub-opcode 22, then the 0xFF terminator.
    const { engine, marker } = await runBoot([0x13, 1, 22, 5, 0xff]);

    expect(marker).toBe(1234);
    expect(engine.getActor(1)?.animSpeed).toBe(5);
  });

  it('reads one byte for actorOps "shadow mode"', async () => {
    const { engine, marker } = await runBoot([0x13, 1, 23, 3, 0xff]);

    expect(marker).toBe(1234);
    expect(engine.getActor(1)?.shadowMode).toBe(3);
  });

  it('reads a word and a byte for verbOps "assign object"', async () => {
    // 0x7a verbOps on verb 1, sub-opcode 22: image word 0x0102, room byte 9.
    const { engine, marker } = await runBoot([0x7a, 1, 22, 0x02, 0x01, 9, 0xff]);

    expect(marker).toBe(1234);
    const verb = engine.verbs.get(1);
    expect(verb?.image).toBe(0x0102);
    expect(verb?.imageRoom).toBe(9);
  });

  it('reads one byte for verbOps "back colour"', async () => {
    const { engine, marker } = await runBoot([0x7a, 1, 23, 7, 0xff]);

    expect(marker).toBe(1234);
    expect(engine.verbs.get(1)?.bakColor).toBe(7);
  });

  it('reads a word for resourceRoutines "load object"', async () => {
    // 0x0c resourceRoutines, sub-opcode 20: object id byte, then room word.
    const { marker } = await runBoot([0x0c, 20, 5, 0x0a, 0x00]);
    expect(marker).toBe(1234);
  });

  it('reads no operand for roomOps "room colour", which is not a v5 form', async () => {
    const { marker, messages } = await runBoot([0x33, 2]);
    expect(marker).toBe(1234);
    expect(messages.some((m) => /Unimplemented roomOps sub-opcode 0x02/.test(m))).toBe(true);
  });

  it('reads two words for parseString "at"', async () => {
    // 0x14 print, actor 252, sub-opcode 0 with two direct words, terminator.
    const { marker } = await runBoot([0x14, 0xfc, 0x00, 0xa0, 0x00, 0x64, 0x00, 0xff]);
    expect(marker).toBe(1234);
  });

  it('reads one byte for parseString "colour"', async () => {
    const { marker } = await runBoot([0x14, 0xfc, 0x01, 0x0b, 0xff]);
    expect(marker).toBe(1234);
  });

  it('reads two words for parseString "erase"', async () => {
    const { marker } = await runBoot([0x14, 0xfc, 0x03, 0x10, 0x00, 0x20, 0x00, 0xff]);
    expect(marker).toBe(1234);
  });

  it('reads two bytes for actorOps "scale"', async () => {
    // Sub-opcode 17 sets x and y scale separately. Reading one byte left the
    // other to be taken as the terminator, which is what drifted script 202.
    const { engine, marker } = await runBoot([0x13, 1, 17, 200, 180, 0xff]);

    expect(marker).toBe(1234);
    expect(engine.getActor(1)?.scaleX).toBe(200);
    expect(engine.getActor(1)?.scaleY).toBe(180);
  });

  it('reads one byte for actorOps "init animation"', async () => {
    const { engine, marker } = await runBoot([0x13, 1, 14, 9, 0xff]);

    expect(marker).toBe(1234);
    expect(engine.getActor(1)?.initFrame).toBe(9);
  });

  it('reads one byte for actorOps "width"', async () => {
    const { engine, marker } = await runBoot([0x13, 1, 16, 30, 0xff]);

    expect(marker).toBe(1234);
    expect(engine.getActor(1)?.width).toBe(30);
  });

  it('reads two bytes for actorOps "talk animation"', async () => {
    const { engine, marker } = await runBoot([0x13, 1, 5, 7, 8, 0xff]);

    expect(marker).toBe(1234);
    expect(engine.getActor(1)?.talkStartFrame).toBe(7);
    expect(engine.getActor(1)?.talkStopFrame).toBe(8);
  });

  it('takes no operand for actorOps "ignore boxes" and "follow boxes"', async () => {
    const { engine, marker } = await runBoot([0x13, 1, 20, 0xff]);
    expect(marker).toBe(1234);
    expect(engine.getActor(1)?.ignoreBoxes).toBe(true);

    const followed = await runBoot([0x13, 1, 21, 0xff]);
    expect(followed.marker).toBe(1234);
    expect(followed.engine.getActor(1)?.ignoreBoxes).toBe(false);
  });

  it('replays the actorOps sequence that drifted script 202', async () => {
    // From the reported bytes: init, costume 59, scale 255/255, then the
    // terminator — followed by ignore-boxes and always-zclip, which only parse
    // as instructions if scale consumed both of its bytes.
    const { marker, messages } = await runBoot([
      0x13, 1, 0x08, 0x01, 0x3b, 0x11, 0xff, 0xff, 0x14, 0x13, 0x01, 0xff,
    ]);

    expect(marker).toBe(1234);
    expect(messages.some((m) => /Unimplemented|read past the end/.test(m))).toBe(false);
  });

  it('names an unknown sub-opcode rather than drifting silently', async () => {
    // Sub-opcode 30 of actorOps is not a v5 instruction. Its operands cannot
    // be consumed, so the report is the only warning that what follows is
    // being misread.
    const { messages } = await runBoot([0x13, 1, 30, 0xff]);

    expect(messages.some((m) => /Unimplemented actorOps sub-opcode 0x1e/.test(m))).toBe(true);
  });
});

describe('a real script that used to misparse', () => {
  /**
   * The instruction sequence from Monkey Island 1's logo room (script 176),
   * taken from a dump of the real thing: set the charset, split the screen,
   * then print a positioned, coloured, centred message.
   *
   * Every operand width in it was wrong in at least one way before, and the
   * misparse showed up as the message's own letters being executed as
   * sub-opcodes. Running it to the marker is the end-to-end version of the
   * cases above.
   */
  const logoSequence = [
    // cursorCommand 13: charset 1
    0x2c,
    0x0d,
    0x01,
    // roomOps 3: screen 0, 200
    0x33,
    0x03,
    0x00,
    0x00,
    0xc8,
    0x00,
    // print actor 252: colour 11, centre, at (160, 100), text
    0x14,
    0xfc,
    0x01,
    0x0b,
    0x04,
    0x00,
    0xa0,
    0x00,
    0x64,
    0x00,
    0x0f,
    ...[...'Game Requires Monkey Island CD in Drive!'].map((c) => c.charCodeAt(0)),
    0x00,
  ];

  it('parses through to the instruction after the message', async () => {
    const { engine, marker, messages } = await runBoot(logoSequence);

    expect(marker).toBe(1234);
    expect(engine.currentCharsetId).toBe(1);
    expect(messages.some((m) => /read past the end|Unimplemented/.test(m))).toBe(false);
  });
});

describe('release quirks', () => {
  it('reports a CD track length Monkey Island 1 accepts', async () => {
    // The logo script refuses to continue unless variable 74 is between 1200
    // and 1250 — it is checking the disc's second audio track.
    const fixture = buildFixture();
    const source = new MemoryDataSource('monkey');
    source.set('MONKEY.000', fixture.index);
    source.set('MONKEY.001', fixture.data);

    const engine = await ScummEngine.create(source);
    expect(engine.variables[74]).toBe(1225);
  });

  it('leaves variable 74 alone for other games', async () => {
    const fixture = buildFixture();
    const source = new MemoryDataSource('other');
    source.set('MONKEY2.000', fixture.index);
    source.set('MONKEY2.001', fixture.data);

    const engine = await ScummEngine.create(source);
    expect(engine.variables[74]).toBe(0);
  });
});

describe('drawObject with no options', () => {
  it('accepts the "neither" sub-opcode without calling it unimplemented', async () => {
    // 0x05 drawObject on object 300, sub-opcode 0x1f: draw it where it is.
    const { marker, messages } = await runBoot([0x05, 0x2c, 0x01, 0x1f]);

    expect(marker).toBe(1234);
    expect(messages.some((m) => /drawObject sub-opcode/.test(m))).toBe(false);
  });
});

describe('reports that carry the bytes', () => {
  it('includes the surrounding bytes and the instruction trail', async () => {
    // actorOps sub-opcode 30 does not exist, so the report fires — and the
    // point of the report is the context, not the name.
    const { messages } = await runBoot([0x13, 0x01, 30, 0xff]);

    const joined = messages.join('\n');
    expect(joined).toMatch(/bytes: @\d+( \^?[0-9a-f]{2})+/);
    expect(joined).toMatch(/last instructions \(offset:opcode\): \d+:0x[0-9a-f]{2}/);
  });

  it('marks the offending byte in the window with a caret', async () => {
    const { messages } = await runBoot([0x13, 0x01, 30, 0xff]);
    expect(messages.join('\n')).toMatch(/\^1e/);
  });
});
