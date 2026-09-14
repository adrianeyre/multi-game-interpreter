import { describe, expect, it } from 'vitest';

import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { Room } from '../src/engine/room/Room.js';
import { ScummEngine } from '../src/engine/ScummEngine.js';
import { TEXT_SLOT } from '../src/engine/constants.js';
import { captureState, restoreState } from '../src/engine/save/SaveState.js';
import { buildClassicFixture } from './fixtureClassic.js';

/**
 * Two faults Loom's opening menu found, and the shape of each.
 *
 * Both are pre-v5 facts that v5 does not share, and both are silent: neither
 * fails to parse, fails to draw or reports anything. The menu is where they
 * meet — a screen with a cycle table that cycles nothing and three labels
 * printed to a slot that is not speech — so the two are checked together.
 *
 * Measured against `games/loom`, which is the one install in this family that
 * is on a machine; what is here is the reading that install forced, expressed
 * against the synthetic v4 build so it runs in CI.
 */

/** A pre-v5 block: a little-endian size counting the header, then a two-character tag. */
function small(tag: string, payload: number[]): Uint8Array {
  const size = payload.length + 6;
  return Uint8Array.from([
    size & 0xff,
    (size >> 8) & 0xff,
    (size >> 16) & 0xff,
    (size >> 24) & 0xff,
    tag.charCodeAt(0),
    tag.charCodeAt(1),
    ...payload,
  ]);
}

function u16be(value: number): number[] {
  return [(value >> 8) & 0xff, value & 0xff];
}

/** One `CC` slot: a big-endian rate and then the inclusive range. */
function cycleSlot(rate: number, start: number, end: number): number[] {
  return [...u16be(rate), start, end];
}

/** A room carrying nothing but a header and the sixteen-slot `CC` table. */
function roomWithCycles(slots: number[][]): Room {
  const table = slots.flat();
  const padded = [...table, ...new Array(16 * 4 - table.length).fill(0)];
  const body = [...small('HD', [64, 0, 16, 0, 0, 0]), ...small('CC', padded)];
  return new Room(1, small('RO', body), 4);
}

describe("a pre-v5 room's colour cycles", () => {
  it('reads a live slot as a rate, a range and a downward rotation', () => {
    // 16384 / 256 is a delay of 64, and the original fills the flags with 2 for
    // every slot it writes — which is its own "rotate downwards".
    const room = roomWithCycles([cycleSlot(256, 16, 31)]);

    expect(room.cycles).toHaveLength(1);
    expect(room.cycles[0]).toMatchObject({ start: 16, end: 31, delay: 64, direction: -1 });
  });

  it('treats 0x0AAA as an empty slot rather than as a cycle six times a second', () => {
    // The value Loom's opening room writes into every slot it is not using.
    // 16384 / 0x0AAA is 6, so read as a rate it is an entirely ordinary delay,
    // and the range beside it — 1 to 14 in the real room — takes the palette
    // with it. Nothing about it fails; the screen simply flickers.
    const room = roomWithCycles([cycleSlot(0x0aaa, 1, 14), cycleSlot(0x0aaa, 0, 0)]);

    expect(room.cycles).toEqual([]);
  });

  it('ignores a slot whose range does not run forwards, and one with no rate', () => {
    const room = roomWithCycles([cycleSlot(256, 31, 16), cycleSlot(0, 16, 31)]);

    expect(room.cycles).toEqual([]);
  });

  it('walks the whole table rather than stopping at the first empty slot', () => {
    // v5's list is terminated by a zero index; this is a fixed table, so a
    // reader that stopped at the first gap would miss every cycle after it.
    const room = roomWithCycles([
      cycleSlot(0, 0, 0),
      cycleSlot(0x0aaa, 0, 0),
      cycleSlot(512, 200, 207),
    ]);

    expect(room.cycles).toHaveLength(1);
    expect(room.cycles[0]).toMatchObject({ start: 200, end: 207, delay: 32 });
  });
});

/**
 * `print` addressed to a slot rather than to a speaker.
 *
 * Built against the v4 fixture so the engine is doing the reading, and driven
 * through `showText` rather than through bytecode: what is being checked is
 * where a printed line goes, not how a script says so.
 */
async function bootClassic(bootScript?: number[]): Promise<ScummEngine> {
  const fixture = buildClassicFixture({ version: 4, bootScript });
  const engine = await ScummEngine.create(new MemoryDataSource('v4', fixture.files));
  // Before the boot script runs, because the boot script may print. v4 numbers
  // its charsets from one — `901.LFL` is charset 1, and there is no charset 0
  // — so a game selects one before it prints anything. Loom's boot script picks
  // charset 2; the fixture ships the one font it has.
  engine.setCharsetResource(1);
  engine.boot();
  return engine;
}

describe('a string printed to the painted slot', () => {
  it('stays on the screen instead of expiring like speech', async () => {
    const engine = await bootClassic();

    engine.showText({
      ...engine.beginTextOptions(254),
      slot: TEXT_SLOT.Painted,
      x: 160,
      y: 67,
      color: 9,
      center: true,
      hasPosition: true,
      text: 'STANDARD',
    });

    for (let step = 0; step < 600; step++) engine.step();

    expect(engine.paintedStringsForTest().map((line) => line.text)).toEqual(['STANDARD']);
  });

  it('keeps every line, where speech keeps only the last', async () => {
    const engine = await bootClassic();

    // The fault the menu showed: three labels printed one after another, each
    // replacing the one before it, leaving three empty boxes and the last
    // label under the bottom one.
    for (const [index, text] of ['STANDARD', 'PRACTICE', 'EXPERT'].entries()) {
      engine.showText({
        ...engine.beginTextOptions(254),
        slot: TEXT_SLOT.Painted,
        x: 160,
        y: 67 + index * 24,
        color: 9,
        center: true,
        hasPosition: true,
        text,
      });
    }

    expect(engine.paintedStringsForTest().map((line) => line.text)).toEqual([
      'STANDARD',
      'PRACTICE',
      'EXPERT',
    ]);
  });

  it('replaces a line drawn again in the same place, rather than stacking one on it', async () => {
    const engine = await bootClassic();

    for (const color of [9, 15]) {
      engine.showText({
        ...engine.beginTextOptions(254),
        slot: TEXT_SLOT.Painted,
        x: 160,
        y: 67,
        color,
        center: true,
        hasPosition: true,
        text: 'STANDARD',
      });
    }

    expect(engine.paintedStringsForTest()).toHaveLength(1);
    expect(engine.paintedStringsForTest()[0].color).toBe(15);
  });

  it('puts the line where the script asked, not a line lower', async () => {
    const engine = await bootClassic();
    engine.showText({
      ...engine.beginTextOptions(254),
      slot: TEXT_SLOT.Painted,
      x: 160,
      y: 67,
      color: 9,
      center: true,
      hasPosition: true,
      text: 'STANDARD',
    });

    // `drawString` sets the charset's top to the position it was handed. Speech
    // is placed by its bottom edge and grows upwards, which is a line's height
    // out for anything drawn into a box.
    expect(engine.paintedStringsForTest()[0].y).toBe(67);
  });

  it('is lost when the room changes, as the background redraw loses it', async () => {
    const engine = await bootClassic();
    engine.showText({
      ...engine.beginTextOptions(254),
      slot: TEXT_SLOT.Painted,
      x: 160,
      y: 67,
      color: 9,
      center: true,
      hasPosition: true,
      text: 'STANDARD',
    });

    engine.startScene(1, null, 0);

    expect(engine.paintedStringsForTest()).toEqual([]);
  });
});

describe('a line the script places by hand', () => {
  it('is drawn below the picture when that is where it was sent', async () => {
    const engine = await bootClassic();
    // Loom's prompt asks for row 152, eight rows below its 144-row picture.
    engine.screen.setLayout(0, 144);

    engine.showText({
      ...engine.beginTextOptions(255),
      x: 160,
      y: 152,
      color: 15,
      center: true,
      hasPosition: true,
      text: 'Please choose your skill level.',
    });

    expect(engine.displayedTextForTest()[0].y).toBe(152);
  });
});

/** A v4 `print`: the opcode, the actor operand, then sub-opcodes. */
function printInstruction(actor: number, x: number, y: number, color: number, text: string) {
  return [
    0x14,
    actor,
    // "at", both coordinates direct words.
    0x00,
    x & 0xff,
    (x >> 8) & 0xff,
    y & 0xff,
    (y >> 8) & 0xff,
    // colour, a direct byte, and then "centre".
    0x01,
    color,
    0x04,
    // "text", which runs to the end of the instruction.
    0x0f,
    ...[...text].map((character) => character.charCodeAt(0)),
    0,
  ];
}

describe("v4's `print`, which names a slot where v6 has an instruction per slot", () => {
  it('sends actor 254 to the painted slot and 255 to speech', async () => {
    const engine = await bootClassic([
      ...printInstruction(254, 160, 67, 9, 'A'),
      ...printInstruction(255, 160, 152, 15, 'A'),
      0xa0,
    ]);

    expect(engine.paintedStringsForTest().map((line) => line.y)).toEqual([67]);
    expect(engine.displayedTextForTest().map((line) => line.text)).toEqual(['A']);
  });

  it('reads an ordinary actor number as an actor, not as a slot', async () => {
    const engine = await bootClassic([...printInstruction(3, 160, 67, 9, 'A'), 0xa0]);

    expect(engine.paintedStringsForTest()).toEqual([]);
  });
});

/**
 * Verb images below v5, which is the whole of Loom's interface.
 *
 * Loom has no verb panel and no inventory. What sits under the picture is the
 * distaff: eight image verbs for the staff positions, forty more for the notes
 * on them, and the dots between drawn with `print 254`. Every one of those
 * pictures is an object in room 1, and the game defines the verbs there and
 * then plays the rest of the game in other rooms.
 */
/** A v4 `verbOps`: verb, position, image, enable. */
function verbImageInstruction(verb: number, image: number, x: number, y: number) {
  return [
    0x7a,
    verb,
    // "at", both coordinates direct words.
    0x05,
    x & 0xff,
    (x >> 8) & 0xff,
    y & 0xff,
    (y >> 8) & 0xff,
    // the image, a direct word, and then "on".
    0x01,
    image & 0xff,
    (image >> 8) & 0xff,
    0x06,
    0xff,
  ];
}

/** `loadRoom`, so there is a room resource for a verb image to be found in. */
const ENTER_ROOM_1 = [0x72, 1];
const STOP = [0xa0];

describe('an image verb below v5', () => {
  it('remembers which room its picture came from', async () => {
    // `verbOps`'s image sub-opcode names an object and no room; the original
    // copies the picture out of the room resource there and then. Nothing is
    // copied here, so the room has to be recorded or the lookup later finds
    // the object in whichever room is on screen — which for Loom is never the
    // one the artwork is in.
    const engine = await bootClassic([
      ...ENTER_ROOM_1,
      ...verbImageInstruction(1, 700, 0, 144),
      ...STOP,
    ]);

    expect(engine.verbs.get(1)?.imageRoom).toBe(1);
  });

  it('keeps the picture it has when the current room cannot supply a new one', async () => {
    // The original copies only when the object is one of the current room's,
    // and otherwise returns having done nothing — so the verb goes on showing
    // what it was showing. Loom leans on this the whole game: it defines the
    // distaff once in room 1 and then re-positions those same verbs from every
    // other room, and each of those re-definitions names the room-1 objects
    // again. Recorded unconditionally, the second one blanks the interface.
    const engine = await bootClassic([
      ...ENTER_ROOM_1,
      ...verbImageInstruction(1, 700, 0, 144),
      // The same verb, named again with an object this room does not have.
      ...verbImageInstruction(1, 999, 0, 152),
      ...STOP,
    ]);

    const verb = engine.verbs.get(1);
    expect(verb?.image).toBe(700);
    expect(verb?.imageRoom).toBe(1);
    // The position is not the picture, and it does move.
    expect(verb?.y).toBe(152);
  });

  it('draws, where reading it as a v5 image draws nothing', async () => {
    const engine = await bootClassic([
      ...ENTER_ROOM_1,
      ...verbImageInstruction(1, 700, 0, 144),
      ...STOP,
    ]);
    engine.render();

    let lit = 0;
    for (let y = 144; y < 200; y++) {
      for (let x = 0; x < 320; x++) if (engine.screen.getPixel(x, y) !== 0) lit++;
    }
    // The fixture's picture is a solid 16x16 square — smaller than the box its
    // object header claims, which is the fixture's business and not this
    // test's. What matters is that every pixel of it arrives: read as a v5
    // image the strip table is not found at all and the panel stays black.
    expect(lit).toBe(16 * 16);
  });

  it('is clickable, because a verb that draws has bounds to hit', async () => {
    const engine = await bootClassic([
      ...ENTER_ROOM_1,
      ...verbImageInstruction(1, 700, 0, 144),
      ...STOP,
    ]);
    engine.render();

    expect(engine.verbs.hitTest(8, 150)).toBe(1);
  });
});

describe('a painted string when the room changes', () => {
  it('goes if it was over the picture and stays if it was not', async () => {
    const engine = await bootClassic();
    // Loom's own layout: picture in the top 144 rows, interface below.
    engine.screen.setLayout(0, 144);

    for (const y of [67, 169]) {
      engine.showText({
        ...engine.beginTextOptions(254),
        slot: TEXT_SLOT.Painted,
        x: 160,
        y,
        color: 9,
        center: true,
        hasPosition: true,
        text: 'A',
      });
    }

    engine.startScene(1, null, 0);

    // A room change redraws the main virtual screen and nothing else, so what
    // was drawn into the band below it is still there. Loom's note names live
    // in that band, and clearing them with the room left a staff with no
    // letters on it the first time the player walked through a door.
    expect(engine.paintedStringsForTest().map((line) => line.y)).toEqual([169]);
  });
});

describe('a saved game', () => {
  it('brings back the verb table and what was painted under it', async () => {
    const engine = await bootClassic([
      ...ENTER_ROOM_1,
      ...verbImageInstruction(1, 700, 0, 144),
      ...STOP,
    ]);
    engine.screen.setLayout(0, 144);
    engine.showText({
      ...engine.beginTextOptions(254),
      slot: TEXT_SLOT.Painted,
      x: 160,
      y: 169,
      color: 9,
      center: true,
      hasPosition: true,
      text: 'A',
    });

    const saved = captureState(engine, 'test');

    // Whatever a restore might otherwise leave behind.
    engine.verbs.reset();
    engine.restorePaintedStrings([]);

    restoreState(engine, saved);

    // Nothing rebuilds a verb table: the script that built it has run, and for
    // Loom it ran in a room the player left long ago. A save that dropped it
    // came back with no interface and no way to get one.
    const verb = engine.verbs.get(1);
    expect(verb?.image).toBe(700);
    expect(verb?.imageRoom).toBe(1);
    expect(verb?.enabled).toBe(true);
    expect(engine.paintedStringsForTest().map((line) => line.y)).toEqual([169]);
  });

  it('loads one written before either was kept', async () => {
    const engine = await bootClassic();
    const saved = captureState(engine, 'test');
    delete saved.verbs;
    delete saved.paintedStrings;

    expect(() => restoreState(engine, saved)).not.toThrow();
  });
});
