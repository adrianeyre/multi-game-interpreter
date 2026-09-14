import { describe, expect, it } from 'vitest';
import { ScummEngine } from '../src/engine/ScummEngine.js';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { Palette } from '../src/engine/gfx/Palette.js';
import { buildV7Fixture, type V7FixtureOptions } from './fixtureV7.js';
import { u16le } from './fixture.js';

/**
 * Recolouring an actor, and the colour search underneath it.
 *
 * A script recolours an actor by naming three scale factors: the costume's own
 * `RGBS` colours are scaled by them and each result is replaced by whichever
 * colour the *room* holds that comes closest. That search is the interesting
 * part — it is not a plain RGB distance. It weighs green three times as heavily
 * as blue, throws away the low two bits of every channel because the hardware
 * it was written for could not show them, never answers with colour zero, and
 * when given a threshold will write a wanted colour into a spare palette entry
 * rather than accept one too far away.
 *
 * Each of those is a way to be silently wrong: the actor still gets a palette,
 * it is just the wrong colour, or transparent.
 */

const ACTOR = 1;

/** A fresh palette with every entry black, then the named entries set. */
function paletteWith(entries: Record<number, [number, number, number]>): Palette {
  const palette = new Palette();
  for (const [index, [r, g, b]] of Object.entries(entries)) {
    palette.setColor(Number(index), r, g, b);
  }
  return palette;
}

describe('finding the palette colour closest to a wanted one', () => {
  it('answers with the entry that already holds the colour', () => {
    const palette = paletteWith({ 40: [80, 40, 212] });

    expect(palette.remapColor(80, 40, 212, -1)).toBe(40);
  });

  it('never answers with colour zero, which a cel would draw as nothing', () => {
    // Colour zero is the exact answer here and every other entry is white, so
    // a search that considered it would return it — and an actor painted in
    // colour zero is an actor with a hole in it.
    const white: Record<number, [number, number, number]> = {};
    for (let i = 1; i < 256; i++) white[i] = [255, 255, 255];
    const palette = paletteWith(white);

    expect(palette.remapColor(0, 0, 0, -1)).toBe(1);
  });

  it('weighs an error in green more heavily than one in red', () => {
    // Both entries are eight off, one in red and one in green. Green counts
    // double, so the entry that is wrong in red is the closer of the two.
    const palette = paletteWith({ 1: [108, 100, 100], 2: [100, 108, 100] });

    expect(palette.remapColor(100, 100, 100, -1)).toBe(1);
  });

  it('weighs an error in blue less heavily than one in red', () => {
    const palette = paletteWith({ 1: [100, 100, 108], 2: [108, 100, 100] });

    expect(palette.remapColor(100, 100, 100, -1)).toBe(1);
  });

  it('treats colours the six-bit hardware cannot tell apart as the same colour', () => {
    // Entry 200 is the nearer of the two in plain arithmetic — one off in each
    // channel against four. But the low two bits of a channel never reached
    // the screen, so entry 40 *is* the wanted colour and matching it ends the
    // search there.
    const palette = paletteWith({ 40: [80, 40, 212], 200: [84, 44, 216] });

    expect(palette.remapColor(83, 43, 215, -1)).toBe(40);
  });

  it('compares the palette’s own colours six bits at a time too', () => {
    // Both entries carry low bits the screen never showed, and entry 200 is
    // the nearer of the two if they are read as written. Once both are cut back
    // to what the hardware could display, entry 40 *is* the wanted colour.
    const palette = paletteWith({ 40: [82, 42, 214], 200: [81, 41, 213] });

    expect(palette.remapColor(80, 40, 212, -1)).toBe(40);
  });

  it('refuses a cycling colour when asked to', () => {
    // Entry 40 is the wanted colour exactly, and about to rotate away from it.
    const palette = paletteWith({ 40: [80, 40, 212], 100: [80, 40, 220] });
    palette.setCycles([{ start: 38, end: 42, delay: 16, direction: 1, counter: 0 }]);

    expect(palette.remapColor(80, 40, 212, -1, 1, true)).toBe(100);
    expect(palette.remapColor(80, 40, 212, -1, 1, false)).toBe(40);
  });

  it('starts the search where it is told', () => {
    const palette = paletteWith({ 1: [80, 40, 212], 100: [80, 40, 212] });

    expect(palette.remapColor(80, 40, 212, -1, 24)).toBe(100);
  });

  it('writes the wanted colour into a spare entry when nothing is close enough', () => {
    // Nothing in a palette of black is within eight of light grey, so the
    // colour is made rather than approximated: the search walks down from the
    // top for an entry that is white in every channel and claims it.
    const palette = paletteWith({ 250: [255, 255, 255] });

    expect(palette.remapColor(200, 200, 200, 8)).toBe(250);
    expect(palette.getColor(250)).toEqual([200, 200, 200]);
  });

  it('keeps the nearest colour when it is inside the threshold', () => {
    const palette = paletteWith({ 40: [80, 40, 212], 250: [255, 255, 255] });

    expect(palette.remapColor(84, 44, 212, 8)).toBe(40);
    expect(palette.getColor(250)).toEqual([255, 255, 255]);
  });

  it('leaves a spare entry alone when no threshold is given', () => {
    const palette = paletteWith({ 250: [255, 255, 255] });

    palette.remapColor(200, 200, 200, -1);

    expect(palette.getColor(250)).toEqual([255, 255, 255]);
  });
});

/**
 * The v7 fixture's room palette, entry by entry.
 *
 * `buildPalette` in the fixture writes `(i * 2) & 0xff, i, 255 - i`, so every
 * entry is a different colour and a test can name one it expects to be chosen.
 * Even entries are used below because an odd entry quantises to the same colour
 * as the even one below it, and the search stops at the first of the two.
 */
const roomColor = (i: number): [number, number, number] => [(i * 2) & 0xff, i, 255 - i];

/** An `RGBS` block of `colors` triplets, black but for the ones named. */
function rgbsWith(colors: number, entries: Record<number, [number, number, number]>): number[] {
  const out = new Array(colors * 3).fill(0);
  for (const [index, [r, g, b]] of Object.entries(entries)) {
    out[Number(index) * 3] = r;
    out[Number(index) * 3 + 1] = g;
    out[Number(index) * 3 + 2] = b;
  }
  return out;
}

async function bootV7(options: V7FixtureOptions = {}) {
  // The room's only walkbox is at its foot, so the actor is placed inside the
  // view of a shorter room.
  const fixture = buildV7Fixture({ roomHeight: 128, ...options });
  const source = new MemoryDataSource('v7');
  source.set(fixture.indexName, fixture.index);
  source.set(fixture.dataName, fixture.data);
  source.set(fixture.languageName, fixture.language);

  const logs: string[] = [];
  const engine = await ScummEngine.create(source, { onLog: (line) => logs.push(line) });
  engine.boot(0);
  engine.startScene(1, null, 0);

  const actor = engine.getActor(ACTOR)!;
  actor.costume = 1;
  engine.putActorInRoom(ACTOR, 1);
  engine.putActor(ACTOR, 100, 100);

  return { engine, actor, logs, run: () => engine.scripts.runScript(2, false, false, []) };
}

describe('recolouring an actor', () => {
  it('replaces each of the costume’s colours with the nearest the room has', async () => {
    const { engine, actor } = await bootV7({
      costume: {
        colors: 64,
        rgbs: rgbsWith(64, { 0: roomColor(40), 40: roomColor(60), 63: roomColor(200) }),
      },
    });

    engine.remapActorPalette(ACTOR, 256, 256, 256, -1);

    expect(actor.palette[0]).toBe(40);
    expect(actor.palette[40]).toBe(60);
    expect(actor.palette[63]).toBe(200);
  });

  it('scales each channel by its own factor first', async () => {
    // 256 leaves a channel alone and 128 halves it, the factors being eight-bit
    // fractions. Red doubled in the costume and halved here lands back on the
    // room colour the other two channels already name.
    const { engine, actor } = await bootV7({
      costume: { colors: 16, rgbs: rgbsWith(16, { 0: [160, 40, 215] }) },
    });

    engine.remapActorPalette(ACTOR, 128, 256, 256, -1);

    expect(actor.palette[0]).toBe(40);
  });

  it('answers for colours above the thirty-second, which an AKOS costume has', async () => {
    // The array an actor keeps these in is 256 entries because that is how many
    // an AKOS costume can name. At 32 every colour above the thirty-first read
    // back as zero instead of as an override, and zero in a cel is transparent.
    const { engine, actor } = await bootV7({
      costume: { colors: 64, rgbs: rgbsWith(64, { 50: roomColor(120) }) },
    });

    engine.remapActorPalette(ACTOR, 256, 256, 256, -1);

    expect(actor.palette.length).toBe(256);
    expect(actor.palette[50]).toBe(120);
  });

  it('leaves the shared low colours alone for an actor casting a shadow', async () => {
    const { engine, actor } = await bootV7({
      costume: {
        colors: 64,
        rgbs: rgbsWith(64, { 5: roomColor(40), 40: roomColor(60) }),
      },
    });
    actor.shadowMode = 1;

    engine.remapActorPalette(ACTOR, 256, 256, 256, -1);

    expect(actor.palette[5]).toBe(0xff);
    expect(actor.palette[40]).toBe(60);
  });

  it('says once why a costume with no true colours kept its own', async () => {
    // The default fixture costume has an `AKPL` but no `RGBS`, so there is
    // nothing to scale and the original gives up here too.
    const { engine, actor, logs } = await bootV7();

    engine.remapActorPalette(ACTOR, 256, 256, 256, -1);
    engine.remapActorPalette(ACTOR, 256, 256, 256, -1);

    expect(actor.palette[0]).toBe(0xff);
    expect(logs.filter((line) => /recolour actor 1/.test(line))).toHaveLength(1);
    expect(logs.join('\n')).toMatch(/no RGBS/);
  });

  it('says why an actor in another room kept its own', async () => {
    const { engine, actor, logs } = await bootV7({
      costume: { colors: 16, rgbs: rgbsWith(16, { 0: roomColor(40) }) },
    });
    actor.room = 2;

    engine.remapActorPalette(ACTOR, 256, 256, 256, -1);

    expect(actor.palette[0]).toBe(0xff);
    expect(logs.join('\n')).toMatch(/in room 2, not 1/);
  });

  it('draws a colour above the thirty-second rather than nothing', async () => {
    // The regression the wider array is for, seen through the renderer: the
    // cel is drawn entirely in colour 40, which the costume names and the actor
    // does not override, so that is what has to reach the screen.
    const { engine, actor } = await bootV7({ costume: { colors: 64, celColor: 40 } });
    engine.startAnimActor(actor, 0);

    engine.render();
    const drawn = Uint8Array.from(engine.screen.pixels);
    actor.visible = false;
    engine.render();

    const colours = new Set<number>();
    for (let i = 0; i < drawn.length; i++) {
      if (engine.screen.pixels[i] !== drawn[i]) colours.add(drawn[i]);
    }
    expect(colours).toEqual(new Set([40]));
  });
});

/** `push`, as a byte where one will do and a word where it will not. */
const push = (value: number) =>
  value >= 0 && value <= 0xff ? [0x00, value] : [0x01, ...u16le(value & 0xffff)];
/** `kernelSetFunctions`: the arguments, then how many, then the call. */
const kernelSet = (...args: number[]) => [...args.flatMap(push), ...push(args.length), 0xc9];
/** `writeWordVar n`, which only stores the right value if the stack is level. */
const store = (variable: number) => [0x43, ...u16le(variable)];
const CANARY_VAR = 399;
const canary = [...push(0x2a), ...store(CANARY_VAR)];

describe('the v7 kernel functions that reach it', () => {
  it('takes a cursor from an object’s artwork', async () => {
    const { engine, run } = await bootV7({ script2: [...kernelSet(12, 7, 3), ...canary] });

    run();

    expect(engine.currentCursor).toBe(7);
    expect(engine.variables[CANARY_VAR]).toBe(0x2a);
  });

  it('recolours an actor without a threshold', async () => {
    const { engine, actor, run } = await bootV7({
      costume: { colors: 16, rgbs: rgbsWith(16, { 0: [200, 200, 200] }) },
      script2: kernelSet(13, ACTOR, 256, 256, 256),
    });
    engine.palette.setColor(250, 255, 255, 255);

    run();

    expect(actor.palette[0]).not.toBe(0xff);
    // Nothing in the room is within reach of light grey, but without a
    // threshold the actor takes the nearest colour anyway and the spare entry
    // is left as it was.
    expect(engine.palette.getColor(250)).toEqual([255, 255, 255]);
  });

  it('recolours an actor with a threshold, which can claim a spare colour', async () => {
    const { engine, actor, run } = await bootV7({
      costume: { colors: 16, rgbs: rgbsWith(16, { 0: [200, 200, 200] }) },
      script2: kernelSet(14, ACTOR, 256, 256, 256, 8),
    });
    engine.palette.setColor(250, 255, 255, 255);

    run();

    expect(actor.palette[0]).toBe(250);
    expect(engine.palette.getColor(250)).toEqual([200, 200, 200]);
  });

  it('records the radio-chatter layer being asked for and dropped', async () => {
    const on = await bootV7({ script2: kernelSet(20, 1) });
    on.run();
    expect(on.engine.radioChatter).toBe(true);

    const off = await bootV7({ script2: kernelSet(20, 0) });
    off.run();
    expect(off.engine.radioChatter).toBe(false);
  });

  it('reads a shadow palette’s arguments in v7’s order, not v6’s', async () => {
    // v7 sends a slot number first and the colour range last; v6 sends the
    // three channel scales first and the range after. Reading v7's arguments in
    // v6's order takes the slot for a red scale and shifts everything after it.
    const { engine, run } = await bootV7({ script2: kernelSet(108, 3, 10, 20, 30, 40, 50) });
    const calls: number[][] = [];
    engine.setShadowPalette = (...args: number[]) => void calls.push(args);

    run();

    expect(calls).toEqual([[10, 20, 30, 40, 50]]);
  });

  it('takes the slotless form as the same act against slot zero', async () => {
    const { engine, run } = await bootV7({ script2: kernelSet(109, 10, 20, 30, 40, 50) });
    const calls: number[][] = [];
    engine.setShadowPalette = (...args: number[]) => void calls.push(args);

    run();

    expect(calls).toEqual([[10, 20, 30, 40, 50]]);
  });
});
