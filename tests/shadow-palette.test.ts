import { describe, expect, it } from 'vitest';
import { ScummEngine } from '../src/engine/ScummEngine.js';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { Palette } from '../src/engine/gfx/Palette.js';
import { Screen } from '../src/engine/gfx/Screen.js';
import { drawCel } from '../src/engine/gfx/CostumeRenderer.js';
import type { Cel, Costume } from '../src/engine/gfx/Costume.js';
import {
  SHADOW_COLOUR,
  ShadowPalette,
  V7_SHADOW_SLOTS,
  shadePixel,
} from '../src/engine/gfx/ShadowPalette.js';
import { captureState, restoreState } from '../src/engine/save/SaveState.js';
import { VAR } from '../src/engine/constants.js';
import { buildV6Fixture } from './fixtureV6.js';
import { buildV7Fixture, type V7FixtureOptions } from './fixtureV7.js';
import { buildClassicFixture } from './fixtureClassic.js';
import { buildV8Fixture } from './fixtureV8.js';
import { u32le } from './fixture.js';

/**
 * Shadow palettes, and the v2-v4 room colour map beside them.
 *
 * A shadow palette is a colour-to-colour table a sprite looks the pixel
 * *behind* it up in, so a character darkens the floor rather than painting a
 * black blob on it. Getting any of it wrong is silent: the sprite still draws,
 * it just draws opaque, or through the wrong table, or not at all. So these
 * pin each piece against numbers worked out from the reference's own
 * arithmetic (`setShadowPalette`, `byleRLEDecode`, `bompApplyShadow`,
 * `o2_roomOps`).
 */

/** A palette where only the named entries are set, everything else black. */
function paletteWith(entries: Record<number, [number, number, number]>): Palette {
  const palette = new Palette();
  for (const [index, [r, g, b]] of Object.entries(entries)) {
    palette.setColor(Number(index), r, g, b);
  }
  return palette;
}

describe('building the v5/v6 shadow table', () => {
  it('matches each colour scaled by the multipliers against the range given', () => {
    // Half of (200, 100, 40), taken to six bits first, is exactly entry 20.
    const palette = paletteWith({
      10: [200, 100, 40],
      20: [100, 50, 20],
      21: [0, 0, 0],
      22: [200, 100, 40],
    });
    const shadow = new ShadowPalette(6);

    shadow.buildMatched(palette, 128, 128, 128, 20, 22);

    expect(shadow.table[10]).toBe(20);
    // Full-colour entry 22 halves to entry 20 as well; black stays black.
    expect(shadow.table[22]).toBe(20);
    expect(shadow.table[21]).toBe(21);
  });

  it('leaves colours outside [from, to) as they were', () => {
    const palette = paletteWith({ 10: [200, 100, 40], 20: [100, 50, 20] });
    const shadow = new ShadowPalette(6);
    shadow.table[30] = 99;

    shadow.buildMatched(palette, 128, 128, 128, 20, 20, 0, 16);

    expect(shadow.table[10]).toBe(20);
    expect(shadow.table[16]).toBe(16);
    expect(shadow.table[30]).toBe(99);
  });

  it('starts from identity only when asked to, as Sam & Max does', () => {
    const palette = paletteWith({ 20: [100, 50, 20] });
    const shadow = new ShadowPalette(6);
    shadow.table[30] = 99;

    shadow.buildMatched(palette, 128, 128, 128, 20, 20, 0, 16, true);

    expect(shadow.table[30]).toBe(30);
  });

  it('is identity at the start of a room before v7 and black from v7', () => {
    const v6 = new ShadowPalette(6);
    v6.table[5] = 1;
    v6.resetForRoom();
    expect(v6.isIdentity()).toBe(true);

    const v7 = new ShadowPalette(7);
    expect(v7.slots).toBe(V7_SHADOW_SLOTS);
    expect(v7.table.every((value) => value === 0)).toBe(true);
  });
});

describe('building a numbered v7 shadow table', () => {
  it('writes only the slot and range asked for, through the colour search', () => {
    const palette = paletteWith({ 10: [200, 100, 40], 40: [100, 48, 20] });
    const shadow = new ShadowPalette(7);

    expect(shadow.buildScaled(palette, 2, 128, 128, 128, 10, 10)).toBe(true);

    const slot = shadow.table.subarray(2 * 256, 3 * 256);
    expect(slot[10]).toBe(palette.remapColor(100, 50, 20, -1, 1, true));
    expect(slot[10]).toBe(40);
    // The rest of the slot starts from identity; other slots are untouched.
    expect(slot[11]).toBe(11);
    expect(shadow.table[10]).toBe(0);
  });

  it('refuses a slot or a range the original stops on', () => {
    const shadow = new ShadowPalette(7);
    expect(shadow.buildScaled(new Palette(), 8, 256, 256, 256, 0, 10)).toBe(false);
    expect(shadow.buildScaled(new Palette(), 0, 256, 256, 256, 10, 5)).toBe(false);
  });

  it('follows a colour cycle, so a shadow of rotating colours rotates too', () => {
    const shadow = new ShadowPalette(6);
    shadow.table[50] = 11;

    shadow.cycle(10, 12, 1);

    // What was colour 11 is now at 12, so the entry that named it follows.
    expect(shadow.table[50]).toBe(12);
  });
});

describe('shading one pixel', () => {
  const table = new Uint8Array(8 * 256);
  table[40] = 7;
  table[3 * 256 + 40] = 9;

  it('shades colour 13 of a classic costume and paints anything else', () => {
    const rule = { mode: 0, table, akos: false };
    expect(shadePixel(rule, SHADOW_COLOUR, 40)).toEqual({ colour: 7, shaded: true });
    expect(shadePixel(rule, 5, 40)).toEqual({ colour: 5, shaded: false });
  });

  it('shades every pixel of a classic costume in mode 0x20', () => {
    expect(shadePixel({ mode: 0x20, table, akos: false }, 5, 40).colour).toBe(7);
  });

  it('picks a table by source colour in AKOS mode 3', () => {
    const rule = { mode: 3, table, akos: true };
    expect(shadePixel(rule, 3, 40).colour).toBe(9);
    expect(shadePixel(rule, 8, 40).shaded).toBe(false);
  });

  it('in mode 3 with one table, shades colour 0 and reports the tables it lacks', () => {
    // `(colour << 8) + under` into v6's 256 bytes: colour 0 lands in it, and
    // the original reads past its end for the rest.
    const past: number[] = [];
    const rule = {
      mode: 3,
      table: table.subarray(0, 256),
      akos: true,
      onPastTable: (colour: number) => past.push(colour),
    };
    expect(shadePixel(rule, 0, 40)).toEqual({ colour: 7, shaded: true });
    expect(shadePixel(rule, 3, 40)).toEqual({ colour: 3, shaded: false });
    expect(past).toEqual([3]);
  });

  it('draws AKOS mode 2 plainly, as ScummVM’s shipped decoder does', () => {
    expect(shadePixel({ mode: 2, table, akos: true }, SHADOW_COLOUR, 40)).toEqual({
      colour: SHADOW_COLOUR,
      shaded: false,
    });
  });

  it('draws a cel’s shadow pixels through the table the screen is under', () => {
    const screen = new Screen();
    screen.fillRect(0, 0, 320, 200, 40);
    const cel: Cel = { width: 2, height: 1, dataOffset: 0, relX: 0, relY: 0, moveX: 0, moveY: 0 };
    const pixels = Uint8Array.from([SHADOW_COLOUR, 5]);
    const palette = new Uint8Array(256).map((_, i) => i);
    const options = {
      actorX: 100,
      actorY: 100,
      xMove: 0,
      yMove: 0,
      scaleX: 255,
      scaleY: 255,
      drawToRight: true,
      palette,
      clipTop: 0,
      clipBottom: 200,
    };

    drawCel(screen, {} as Costume, cel, pixels, {
      ...options,
      shadow: { mode: 1, table, akos: true },
    });
    expect([screen.getPixel(100, 100), screen.getPixel(101, 100)]).toEqual([7, 5]);

    screen.fillRect(0, 0, 320, 200, 40);
    drawCel(screen, {} as Costume, cel, pixels, options);
    expect(screen.getPixel(100, 100)).toBe(SHADOW_COLOUR);
  });
});

async function bootV7(options: V7FixtureOptions = {}) {
  const fixture = buildV7Fixture({ roomHeight: 128, ...options });
  const source = new MemoryDataSource('v7');
  source.set(fixture.indexName, fixture.index);
  source.set(fixture.dataName, fixture.data);
  source.set(fixture.languageName, fixture.language);
  const logs: string[] = [];
  const engine = await ScummEngine.create(source, { onLog: (line) => logs.push(line) });
  engine.startScene(1, null, 0);
  return { engine, logs };
}

/** The screen positions an actor draws to, found by rendering with and without it. */
function actorFootprint(engine: ScummEngine, actor: { visible: boolean }): number[] {
  actor.visible = false;
  engine.render();
  const without = Uint8Array.from(engine.screen.pixels);
  actor.visible = true;
  engine.render();
  const at: number[] = [];
  for (let i = 0; i < without.length; i++) if (engine.screen.pixels[i] !== without[i]) at.push(i);
  return at;
}

describe('an actor with a shadow mode', () => {
  it('draws its colour 13 through the shadow table, not as colour 13', async () => {
    const { engine } = await bootV7({ costume: { celColor: SHADOW_COLOUR } });
    engine.variables[VAR.EGO] = 1;
    const actor = engine.getActor(1)!;
    actor.costume = 1;
    engine.putActorInRoom(1, 1);
    engine.putActor(1, 100, 100);

    const footprint = actorFootprint(engine, actor);
    expect(footprint.length).toBeGreaterThan(0);
    expect(footprint.every((i) => engine.screen.pixels[i] === SHADOW_COLOUR)).toBe(true);

    // Every colour shades to 99, so anything shaded is unmistakable.
    engine.shadowPalette.table.fill(99, 0, 256);
    actor.shadowMode = 1;
    engine.render();

    expect(footprint.every((i) => engine.screen.pixels[i] === 99)).toBe(true);
  });
});

describe('a blast object with a shadow mode', () => {
  const X = 100;
  const Y = 60;

  it('shades mode 3 through the table its own colour picks', async () => {
    const { engine } = await bootV7({ blastObjectColours: [3] });
    engine.render();
    const under = engine.screen.getPixel(X, Y);
    engine.shadowPalette.table[3 * 256 + under] = 77;

    engine.enqueueBlastObject(500, X, Y, 0, 0, 255, 255, 1, 3);
    engine.render();

    expect(engine.screen.getPixel(X, Y)).toBe(77);
  });

  it('paints plainly in mode 3 when drawn scaled, as the original does', async () => {
    const { engine } = await bootV7({ blastObjectColours: [3] });
    engine.shadowPalette.table.fill(77);

    engine.enqueueBlastObject(500, X, Y, 0, 0, 128, 128, 1, 3);
    engine.render();

    expect(engine.screen.getPixel(X, Y)).toBe(3);
  });

  it('draws a mode the original does not implement plainly, and says so once', async () => {
    const { engine, logs } = await bootV7({ blastObjectColours: [3] });
    engine.shadowPalette.table.fill(77);

    engine.enqueueBlastObject(500, X, Y, 0, 0, 255, 255, 1, 2);
    engine.enqueueBlastObject(500, X, Y, 0, 0, 255, 255, 1, 2);
    engine.render();

    expect(engine.screen.getPixel(X, Y)).toBe(3);
    expect(logs.filter((line) => line.includes('shadow mode 2'))).toHaveLength(1);
  });
});

describe('the v5/v6 build reached from a script', () => {
  it('builds the table from the room palette and keeps it across a save', async () => {
    const fixture = buildV6Fixture({});
    const source = new MemoryDataSource('v6');
    source.set(fixture.indexName, fixture.index);
    source.set(fixture.dataName, fixture.data);
    const engine = await ScummEngine.create(source);
    engine.startScene(1, null, 0);

    engine.setShadowPalette(0, 0, 0, 1, 255);
    // Every colour scaled to black matches the darkest entry in range.
    const built = Array.from(engine.shadowPalette.table);
    expect(new Set(built).size).toBe(1);

    const saved = captureState(engine);
    engine.startScene(1, null, 0);
    expect(engine.shadowPalette.isIdentity()).toBe(true);

    restoreState(engine, JSON.parse(JSON.stringify(saved)));
    expect(Array.from(engine.shadowPalette.table)).toEqual(built);

    // A save written before the table was kept still loads, with the room's own.
    const { shadowPalette: _dropped, ...older } = saved;
    restoreState(engine, JSON.parse(JSON.stringify(older)));
    expect(engine.shadowPalette.isIdentity()).toBe(true);
  });
});

async function bootClassic(version: 2 | 3 | 4, sixteenColour = false, bootScript?: number[]) {
  const fixture = buildClassicFixture({ version, sixteenColour, bootScript });
  const engine = await ScummEngine.create(new MemoryDataSource(`v${version}`, fixture.files));
  return engine;
}

/** A room pixel of a given colour, as a screen index. */
function firstPixelOf(engine: ScummEngine, colour: number): number {
  const { top, height } = engine.screen.main;
  for (let i = top * 320; i < (top + height) * 320; i++) {
    if (engine.screen.pixels[i] === colour) return i;
  }
  return -1;
}

describe('the v2-v4 room colour map', () => {
  it('draws the room’s colour as the one a script mapped it to', async () => {
    const engine = await bootClassic(3);
    engine.startScene(1, null, 0);
    engine.render();
    const at = firstPixelOf(engine, 5);
    expect(at).toBeGreaterThanOrEqual(0);

    engine.setRoomColour(5, 9);
    engine.render();

    expect(engine.screen.pixels[at]).toBe(9);
  });

  it('is put back to identity by the next room', async () => {
    const engine = await bootClassic(3);
    engine.startScene(1, null, 0);
    engine.setRoomColour(5, 9);
    engine.startScene(1, null, 0);
    engine.render();

    expect(firstPixelOf(engine, 5)).toBeGreaterThanOrEqual(0);
  });

  it('recolours a sixteen-colour v4 room but not a 256-colour one', async () => {
    const ega = await bootClassic(4, true);
    ega.startScene(1, null, 0);
    ega.render();
    const at = firstPixelOf(ega, 5);
    ega.setRoomColour(5, 9);
    ega.render();
    expect(ega.screen.pixels[at]).toBe(9);

    // v4's 256-colour codecs are v5's, which never read the map.
    const vga = await bootClassic(4);
    vga.startScene(1, null, 0);
    vga.render();
    const vgaAt = firstPixelOf(vga, 5);
    vga.setRoomColour(5, 9);
    vga.render();
    expect(vga.screen.pixels[vgaAt]).toBe(5);
  });

  it('is read from v2’s roomOps operands in their own order', async () => {
    // `roomOps 7, 3, room-colour`: colour first, then the slot.
    const engine = await bootClassic(2, false, [0x33, 7, 3, 0x02, 0x00]);
    engine.boot();
    engine.startScene(1, null, 0);
    const calls: number[][] = [];
    engine.setRoomColour = (...args: number[]) => void calls.push(args);
    engine.boot();

    expect(calls).toEqual([[3, 7]]);
  });

  it('applies a v4 shadow slot to the palette as it is uploaded', async () => {
    const engine = await bootClassic(4);
    engine.startScene(1, null, 0);
    engine.palette.flush();
    const colourOfNine = Array.from(engine.palette.rgba.subarray(9 * 4, 9 * 4 + 3));

    engine.setRoomShadowColour(5, 9);
    engine.palette.flush();

    expect(Array.from(engine.palette.rgba.subarray(5 * 4, 5 * 4 + 3))).toEqual(colourOfNine);
  });
});

describe('v4 colour cycling', () => {
  /**
   * `cyclePalette`'s small-header branch: the colours stay put and the
   * upload-time table is laid out downwards from the cycle's position, which
   * moves one on per frame.
   */
  const cycle = () => ({ start: 16, end: 18, delay: 64, direction: -1, counter: 16 });

  it('rewrites the table from the cycle’s position, one step per call', () => {
    const shadow = new ShadowPalette(4);
    const live = cycle();

    shadow.advanceSmallHeaderCycle(live);
    expect(live.counter).toBe(17);
    expect(Array.from(shadow.table.subarray(16, 19))).toEqual([17, 16, 18]);

    shadow.advanceSmallHeaderCycle(live);
    expect(Array.from(shadow.table.subarray(16, 19))).toEqual([18, 17, 16]);

    // Past the end the position wraps to the start.
    shadow.advanceSmallHeaderCycle(live);
    expect(live.counter).toBe(16);
    expect(Array.from(shadow.table.subarray(16, 19))).toEqual([16, 18, 17]);
    expect(shadow.table[15]).toBe(15);
  });

  it('never runs a cycle whose position is zero, so one starting at colour 0 stays put', () => {
    const shadow = new ShadowPalette(4);
    shadow.advanceSmallHeaderCycle({ start: 0, end: 3, delay: 64, direction: -1, counter: 0 });
    expect(shadow.isIdentity()).toBe(true);
  });

  it('moves the displayed colours in a v4 game and leaves the palette alone', async () => {
    const engine = await bootClassic(4);
    engine.startScene(1, null, 0);
    engine.palette.setCycles([cycle()]);
    engine.palette.flush();
    const before = Array.from(engine.palette.rgba.subarray(16 * 4, 19 * 4));
    const base = engine.palette.getColor(17);

    engine.step();
    engine.palette.flush();

    // Index 16 now shows what 17 holds, and the colour at 17 has not moved.
    expect(Array.from(engine.palette.rgba.subarray(16 * 4, 16 * 4 + 4))).toEqual(
      before.slice(4, 8),
    );
    expect(engine.palette.getColor(17)).toEqual(base);
    expect(engine.shadowPalette.table[16]).toBe(17);
  });

  it('does not cycle at all in v3, whose interpreter never calls the cycler', async () => {
    const engine = await bootClassic(3);
    engine.startScene(1, null, 0);
    engine.palette.setCycles([cycle()]);
    const colour = engine.palette.getColor(16);

    for (let i = 0; i < 70; i++) engine.step();

    expect(engine.palette.getColor(16)).toEqual(colour);
    expect(engine.shadowPalette.isIdentity()).toBe(true);
  });
});

describe('the v8 shadow palette calls', () => {
  /** v8's `pushWord`, with its four-byte immediate. */
  const push = (value: number) => [0x01, ...u32le(value)];
  /** `kernelSetFunctions`: the arguments, how many, the call, then stop. */
  const kernelSet = (...args: number[]) => [
    ...args.flatMap(push),
    ...push(args.length),
    0xba,
    0x7b,
  ];

  async function runEntry(script: number[]) {
    const fixture = buildV8Fixture({ entryScript: script });
    const engine = await ScummEngine.create(new MemoryDataSource('v8', fixture.files));
    const calls: number[][] = [];
    engine.setShadowPaletteSlot = (...args: number[]) => void calls.push(args);
    engine.startScene(1, null, 0);
    return calls;
  }

  it('builds a numbered table from 108, slot first', async () => {
    expect(await runEntry(kernelSet(108, 5, 10, 20, 30, 40, 50))).toEqual([
      [5, 10, 20, 30, 40, 50],
    ]);
  });

  it('builds table 0 from 109, which has no slot', async () => {
    expect(await runEntry(kernelSet(109, 10, 20, 30, 40, 50))).toEqual([[0, 10, 20, 30, 40, 50]]);
  });

  it('matches from colour 24, and does not skip cycled colours', () => {
    // v8's `remapPaletteColor` starts its search at 24 and, unlike v7's,
    // takes a colour that is cycling.
    const palette = paletteWith({ 10: [100, 50, 20], 30: [100, 50, 20], 40: [100, 52, 20] });
    palette.setCycles([{ start: 30, end: 31, delay: 1, direction: 1, counter: 0 }]);
    const v8 = new ShadowPalette(8);
    const v7 = new ShadowPalette(7);

    v8.buildScaled(palette, 0, 256, 256, 256, 10, 10);
    v7.buildScaled(palette, 0, 256, 256, 256, 10, 10);

    expect(v8.table[10]).toBe(30);
    expect(v7.table[10]).toBe(10);
  });
});

describe('a v8 blast object', () => {
  const push = (value: number) => [0x01, ...u32le(value)];
  /** One `kernelSetFunctions` call, without a stop after it. */
  const kernelCall = (...args: number[]) => [...args.flatMap(push), ...push(args.length), 0xba];
  const STOP = 0x7b;

  async function boot(entryScript?: number[]) {
    const fixture = buildV8Fixture({ entryScript, objectBompColour: 3 });
    const logs: string[] = [];
    const engine = await ScummEngine.create(new MemoryDataSource('v8', fixture.files), {
      onLog: (line) => logs.push(line),
    });
    return { engine, logs };
  }

  it('is queued by 118 in mode 3 and by 119 in mode 0', async () => {
    const { engine } = await boot([
      ...kernelCall(118, 17, 10, 20, 0, 0, 255, 255, 1),
      ...kernelCall(119, 17, 30, 40, 0, 0, 128, 128, 1),
      STOP,
    ]);
    const calls: number[][] = [];
    engine.enqueueBlastObject = (...args: number[]) => void calls.push(args);
    engine.startScene(1, null, 0);

    expect(calls).toEqual([
      [17, 10, 20, 0, 0, 255, 255, 1, 3],
      [17, 30, 40, 0, 0, 128, 128, 1, 0],
    ]);
  });

  it('reads the picture through OFFS and v8’s 32-bit BOMP header', async () => {
    const { engine, logs } = await boot();
    engine.startScene(1, null, 0);

    engine.enqueueBlastObject(17, 100, 60, 0, 0, 255, 255, 1, 0);
    engine.render();

    expect([0, 1].map((dx) => engine.screen.getPixel(100 + dx, 61))).toEqual([3, 3]);
    expect(engine.screen.getPixel(102, 60)).not.toBe(3);
    expect(logs.join('\n')).not.toMatch(/queued to be drawn/);
  });

  it('shades mode 3 through the numbered table its colour picks', async () => {
    const { engine } = await boot();
    engine.startScene(1, null, 0);
    engine.render();
    const under = engine.screen.getPixel(100, 60);
    engine.shadowPalette.table[3 * 256 + under] = 77;

    engine.enqueueBlastObject(17, 100, 60, 0, 0, 255, 255, 1, 3);
    engine.render();

    expect(engine.screen.getPixel(100, 60)).toBe(77);
  });
});
