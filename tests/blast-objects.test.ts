import { describe, expect, it } from 'vitest';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { ScummEngine } from '../src/engine/ScummEngine.js';
import { bompScaleMask } from '../src/engine/gfx/costume/bomp.js';
import { buildV6Fixture, type V6FixtureOptions } from './fixtureV6.js';
import { buildV7Fixture, type V7FixtureOptions } from './fixtureV7.js';
import { u16le } from './fixture.js';

/**
 * Objects a script draws over the finished frame.
 *
 * Sam & Max's verb coin, The Dig's inventory and Full Throttle's action wheel
 * are all the same feature: a script queues an object's picture every frame and
 * the interpreter stamps it on top of everything else, then forgets it. Nothing
 * about it is persistent — the queue is emptied each frame, so a renderer that
 * drains it while drawing shows the wheel for one frame and then nothing.
 *
 * The artwork is a `BOMP` chunk inside the object's `IMxx`, which is what tells
 * a blastable object from one painted into the room: the latter carries an
 * `SMAP` and the original errors out on it. Two things about the drawing differ
 * from a costume cel and are easy to get backwards — the transparent index is
 * 255 rather than 0, and scaling drops rows and columns and closes the
 * survivors up against the top-left corner rather than resampling.
 *
 * Tier 1 (`docs/processes/verifying-version-support.md`): the fixtures encode
 * our reading of the format. Neither demo reaches this code from a boot — a run
 * that never opens the coin, the inventory or the wheel queues nothing — so the
 * scale expectations here are computed from the original's table rather than
 * read off a running game.
 */

const STOP = 0x66;
/** The fixture's object, in both versions. */
const OBJECT = 500;
/** Where the room's background is a flat colour, well clear of the object. */
const BLAST_X = 100;
const BLAST_Y = 60;
/** The background colour under that point, which an opaque draw replaces. */
const BACKGROUND = 22;
/** Artwork colours outside the range the fixture's background strips use. */
const ARTWORK = 200;
const OTHER_ARTWORK = 204;

/** `pushByte` where it fits, `pushWord` where it does not. */
const push = (value: number) =>
  value >= 0 && value <= 0xff ? [0x00, value] : [0x01, ...u16le(value & 0xffff)];
/** `kernelSetFunctions`: the arguments, then how many, then the call. */
const kernelSet = (...args: number[]) => [...args.flatMap(push), ...push(args.length), 0xc9];
/** `writeWordVar n`, which only stores the right value if the stack is level. */
const store = (variable: number) => [0x43, ...u16le(variable)];
const CANARY_VAR = 399;
const canary = [...push(0x2a), ...store(CANARY_VAR)];

async function bootV7(code: number[], options: V7FixtureOptions = {}) {
  const fixture = buildV7Fixture({ ...options, script2: code });
  const source = new MemoryDataSource('v7');
  source.set(fixture.indexName, fixture.index);
  source.set(fixture.dataName, fixture.data);
  source.set(fixture.languageName, fixture.language);

  const logs: string[] = [];
  const engine = await ScummEngine.create(source, { onLog: (line) => logs.push(line) });
  engine.boot(0);
  engine.startScene(1, null, 0);
  engine.scripts.runScript(2, false, false, []);
  return { engine, logs };
}

async function bootV6(code: number[], options: V6FixtureOptions = {}) {
  const fixture = buildV6Fixture({ ...options, script2: code });
  const source = new MemoryDataSource('v6');
  source.set(fixture.indexName, fixture.index);
  source.set(fixture.dataName, fixture.data);

  const logs: string[] = [];
  const engine = await ScummEngine.create(source, { onLog: (line) => logs.push(line) });
  engine.boot(0);
  engine.startScene(1, null, 0);
  engine.scripts.runScript(2, false, false, []);
  return { engine, logs };
}

/** Where a colour was drawn, or null if it was not drawn at all. */
function blockOf(
  engine: ScummEngine,
  color: number,
): { count: number; left: number; top: number; right: number; bottom: number } | null {
  let count = 0;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (let y = 0; y < 200; y++) {
    for (let x = 0; x < 320; x++) {
      if (engine.screen.pixels[y * 320 + x] !== color) continue;
      count++;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  return count === 0 ? null : { count, left, top, right, bottom };
}

describe('what a script says to draw over the frame', () => {
  it('records all eight of a v7 kernel call’s arguments, in order', async () => {
    // Three of them would be enough to put a picture on the screen, which is
    // why a short decode is worth a test: the size, the scale in each axis and
    // the image number all follow the position, so dropping them draws the
    // wrong picture at the wrong size wherever a script asks for a scaled or a
    // highlighted one.
    const { engine } = await bootV7([
      ...kernelSet(119, OBJECT, BLAST_X, BLAST_Y, 12, 14, 128, 64, 2),
      STOP,
    ]);

    expect(engine.currentBlastObjects()).toEqual([
      {
        objectId: OBJECT,
        x: BLAST_X,
        y: BLAST_Y,
        width: 12,
        height: 14,
        scaleX: 128,
        scaleY: 64,
        image: 2,
        mode: 0,
      },
    ]);
  });

  it('asks for shadow mode 3 from the sub-function that means it', async () => {
    // v7 has two sub-functions for one feature: 118 is 119 with the shading
    // that dims The Dig's unavailable inventory items. Nothing in the
    // arguments distinguishes them, so the mode can only come from which
    // number was called.
    const shaded = await bootV7([...kernelSet(118, OBJECT, BLAST_X, BLAST_Y), STOP]);
    const plain = await bootV7([...kernelSet(119, OBJECT, BLAST_X, BLAST_Y), STOP]);

    expect(shaded.engine.currentBlastObjects()[0].mode).toBe(3);
    expect(plain.engine.currentBlastObjects()[0].mode).toBe(0);
  });

  it('records all eight of a v6 kernel call’s arguments too', async () => {
    const { engine } = await bootV6([
      ...kernelSet(119, OBJECT, BLAST_X, BLAST_Y, 12, 14, 128, 64, 2),
      STOP,
    ]);

    expect(engine.currentBlastObjects()).toEqual([
      {
        objectId: OBJECT,
        x: BLAST_X,
        y: BLAST_Y,
        width: 12,
        height: 14,
        scaleX: 128,
        scaleY: 64,
        image: 2,
        mode: 0,
      },
    ]);
  });

  it('reads the whole of the v6 instruction, which fixes the rest', async () => {
    // `drawBlastObject` is the plain instruction rather than the kernel call:
    // it takes a position and a size off the stack and a counted list it does
    // not use, and leaves the scale, the image and the mode fixed. Popping the
    // list but not the size would put the object at the size's numbers.
    const { engine } = await bootV6([
      ...push(OBJECT),
      ...push(10),
      ...push(20),
      ...push(4),
      ...push(6),
      ...push(0), // the counted list, which the original reads and ignores
      0x63,
      ...canary,
      STOP,
    ]);

    expect(engine.currentBlastObjects()).toEqual([
      {
        objectId: OBJECT,
        x: 10,
        y: 20,
        width: 4,
        height: 6,
        scaleX: 255,
        scaleY: 255,
        image: 1,
        mode: 0,
      },
    ]);
    expect(engine.variables[CANARY_VAR]).toBe(0x2a);
  });

  it('stops queueing at two hundred and says so once', async () => {
    const { engine, logs } = await bootV7([STOP]);
    for (let i = 0; i < 205; i++) engine.enqueueBlastObject(OBJECT, BLAST_X, BLAST_Y);

    expect(engine.currentBlastObjects()).toHaveLength(200);
    expect(logs.filter((line) => line.includes('were dropped'))).toHaveLength(1);
  });

  it('keeps the queue for the whole frame and empties it on the next', async () => {
    // Two mistakes with the same symptom, which is why both halves are here: a
    // renderer that drains the queue as it draws, and one that never drains it
    // at all. The first shows the wheel for a single frame; the second leaves
    // it on the screen after the script has stopped asking for it.
    const { engine } = await bootV7([STOP], { blastObjectColours: [ARTWORK] });
    engine.enqueueBlastObject(OBJECT, BLAST_X, BLAST_Y);

    engine.render();
    expect(engine.currentBlastObjects()).toHaveLength(1);
    expect(blockOf(engine, ARTWORK)?.count).toBe(256);

    engine.render();
    expect(blockOf(engine, ARTWORK)?.count).toBe(256);

    engine.step();
    expect(engine.currentBlastObjects()).toHaveLength(0);
    engine.render();
    expect(blockOf(engine, ARTWORK)).toBeNull();
  });
});

describe('drawing a queued object', () => {
  it('puts the artwork where the script asked for it', async () => {
    const { engine } = await bootV7([STOP], { blastObjectColours: [ARTWORK] });
    engine.enqueueBlastObject(OBJECT, BLAST_X, BLAST_Y);
    engine.render();

    // Screen coordinates, not room ones: the coin opens where the mouse is.
    expect(blockOf(engine, ARTWORK)).toEqual({
      count: 256,
      left: BLAST_X,
      top: BLAST_Y,
      right: BLAST_X + 15,
      bottom: BLAST_Y + 15,
    });
  });

  it('draws the image the script chose, not the first one', async () => {
    // An object holds one picture per state, and which one is asked for is how
    // a wheel segment is drawn lit or dark. Always taking `IM01` draws the
    // whole wheel in one state.
    const { engine } = await bootV7([STOP], { blastObjectColours: [ARTWORK, OTHER_ARTWORK] });
    engine.enqueueBlastObject(OBJECT, BLAST_X, BLAST_Y, 0, 0, 255, 255, 2);
    engine.render();

    expect(blockOf(engine, OTHER_ARTWORK)?.count).toBe(256);
    expect(blockOf(engine, ARTWORK)).toBeNull();
  });

  it('falls back to the first image when the object has no such state', async () => {
    // Sam & Max queues image numbers its objects do not have, and the original
    // keeps a fallback to the first image for exactly that. Without it the
    // picture vanishes and the object reads as one with no artwork at all.
    const { engine, logs } = await bootV7([STOP], { blastObjectColours: [ARTWORK] });
    engine.enqueueBlastObject(OBJECT, BLAST_X, BLAST_Y, 0, 0, 255, 255, 3);
    engine.render();

    expect(blockOf(engine, ARTWORK)?.count).toBe(256);
    expect(logs.filter((line) => line.includes('has no image'))).toHaveLength(0);
  });

  it('treats 255 as transparent and 0 as a colour to paint', async () => {
    // The opposite of a costume cel, and the reason it is opt-in: getting it
    // backwards leaves a black rectangle behind the verb coin and drops
    // whatever the artwork drew in white.
    const { engine } = await bootV7([STOP], { blastObjectColours: [255, 0] });

    engine.enqueueBlastObject(OBJECT, BLAST_X, BLAST_Y, 0, 0, 255, 255, 1);
    engine.render();
    expect(engine.screen.pixels[BLAST_Y * 320 + BLAST_X]).toBe(BACKGROUND);
    expect(blockOf(engine, 255)).toBeNull();

    engine.step();
    engine.enqueueBlastObject(OBJECT, BLAST_X, BLAST_Y, 0, 0, 255, 255, 2);
    engine.render();
    expect(engine.screen.pixels[BLAST_Y * 320 + BLAST_X]).toBe(0);
  });

  it('scales by dropping rows and columns, closed up to the corner', async () => {
    // Nine of sixteen at half scale, five at a quarter — the numbers come from
    // the original's table, not from ours. What matters as much as the count is
    // that the survivors are compacted: a half-scale picture is half the size
    // at the same position, not a sparse version of the full-size one, so a
    // sixteen-wide bounding box here would mean the mask was applied to the
    // destination instead of the source.
    const { engine } = await bootV7([STOP], { blastObjectColours: [ARTWORK] });

    engine.enqueueBlastObject(OBJECT, BLAST_X, BLAST_Y, 0, 0, 128, 128);
    engine.render();
    expect(blockOf(engine, ARTWORK)).toEqual({
      count: 81,
      left: BLAST_X,
      top: BLAST_Y,
      right: BLAST_X + 8,
      bottom: BLAST_Y + 8,
    });

    engine.step();
    engine.enqueueBlastObject(OBJECT, BLAST_X, BLAST_Y, 0, 0, 64, 64);
    engine.render();
    expect(blockOf(engine, ARTWORK)).toEqual({
      count: 25,
      left: BLAST_X,
      top: BLAST_Y,
      right: BLAST_X + 4,
      bottom: BLAST_Y + 4,
    });
  });

  it('scales each axis on its own', async () => {
    const { engine } = await bootV7([STOP], { blastObjectColours: [ARTWORK] });
    engine.enqueueBlastObject(OBJECT, BLAST_X, BLAST_Y, 0, 0, 64, 255);
    engine.render();

    expect(blockOf(engine, ARTWORK)).toEqual({
      count: 5 * 16,
      left: BLAST_X,
      top: BLAST_Y,
      right: BLAST_X + 4,
      bottom: BLAST_Y + 15,
    });
  });

  it('says once that a shadow mode was drawn without shading', async () => {
    // Mode 3 recolours the darkest eight indices through a shadow palette
    // nothing here keeps. Drawing the artwork plainly is the closer of the two
    // wrong answers, but silence about it is not: the picture would look right
    // and be unshaded with nothing to say why.
    const { engine, logs } = await bootV7([STOP], { blastObjectColours: [ARTWORK] });
    engine.enqueueBlastObject(OBJECT, BLAST_X, BLAST_Y, 0, 0, 255, 255, 1, 3);
    engine.enqueueBlastObject(OBJECT, BLAST_X, BLAST_Y, 0, 0, 255, 255, 1, 3);
    engine.render();

    expect(logs.filter((line) => line.includes('shadow palette'))).toHaveLength(1);
    expect(blockOf(engine, ARTWORK)?.count).toBe(256);
  });

  it('does not report a shadow mode it was never going to apply', async () => {
    // The original throws the mode away when either axis is short of full
    // scale, so a scaled call asking for mode 3 is not asking for anything
    // this build is missing, and warning about it would be noise.
    const { engine, logs } = await bootV7([STOP], { blastObjectColours: [ARTWORK] });
    engine.enqueueBlastObject(OBJECT, BLAST_X, BLAST_Y, 0, 0, 128, 128, 1, 3);
    engine.render();

    expect(logs.filter((line) => line.includes('shadow palette'))).toHaveLength(0);
  });

  it('reports an object whose image is not blast artwork, once', async () => {
    // The fixture's object ships an `SMAP` by default, which is what an object
    // painted into the room carries. The original errors out on one, so saying
    // which of the two is missing is the whole of the diagnostic.
    const { engine, logs } = await bootV7([STOP]);
    engine.enqueueBlastObject(OBJECT, BLAST_X, BLAST_Y);
    engine.render();
    engine.render();

    expect(logs.filter((line) => line.includes('has no BOMP'))).toHaveLength(1);
  });

  it('reports an object that is not in the room, once', async () => {
    const { engine, logs } = await bootV7([STOP]);
    engine.enqueueBlastObject(999, BLAST_X, BLAST_Y);
    engine.render();
    engine.render();

    expect(logs.filter((line) => line.includes('is not in the room'))).toHaveLength(1);
  });
});

describe('the table that decides which rows and columns survive', () => {
  it('keeps everything at full scale', () => {
    expect(bompScaleMask(16, 255).filter(Boolean)).toHaveLength(16);
  });

  it('copies the two entries the original’s data gets wrong', () => {
    // Indices 255 and 511 read 0xfe where the bit-reversal pattern gives 0xff,
    // and this is where that shows: at a scale of exactly 254 the last row of a
    // sixteen-high picture survives because of it, and one step lower it does
    // not. Correcting the table to the pattern would lose a row that the
    // original draws.
    expect(bompScaleMask(16, 254).filter(Boolean)).toHaveLength(16);
    expect(bompScaleMask(16, 253).filter(Boolean)).toHaveLength(15);
  });

  it('spreads what it drops rather than cutting a stripe out', () => {
    // The pattern is each index with its bits reversed, which is what makes a
    // half-scale picture keep every other row instead of its top half.
    expect(bompScaleMask(16, 128)).toEqual([
      false,
      true,
      false,
      true,
      false,
      true,
      false,
      true,
      false,
      true,
      true,
      true,
      false,
      true,
      false,
      true,
    ]);
  });
});
