import { describe, expect, it } from 'vitest';
import { ScummEngine } from '../src/engine/ScummEngine.js';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { VAR } from '../src/engine/constants.js';
import {
  AkosCodec,
  decodeAkosCel,
  decodeByleRle,
  decodeMajMin,
  parseAkos,
} from '../src/engine/gfx/costume/akos.js';
import { BOMP_TRANSPARENT, drawBomp } from '../src/engine/gfx/costume/bomp.js';
import { Screen } from '../src/engine/gfx/Screen.js';
import { SHADOW_COLOUR } from '../src/engine/gfx/ShadowPalette.js';
import { buildAkosCostume, buildV6Fixture, type AkosCostumeOptions } from './fixtureV6.js';
import { buildV7Fixture } from './fixtureV7.js';

/**
 * The three LucasArts AKOS codecs, and the BOMP blitter two of them draw
 * through.
 *
 * Each expectation is worked out by hand from the reference's own routines —
 * `paintCelByleRLECommon`/`byleRLEDecode` for codec 1, `MajMinCodec` for
 * codec 16, `drawBomp`/`bompApplyShadow` for codec 5 and blast objects — and
 * each codec disagrees with the others about something a wrong reader would
 * get plausibly wrong: pixel order, which colour is transparent, and whether
 * the actor's palette applies.
 */

/** Packs bits least significant first, as `MajMinCodec::readBits` takes them. */
function packBits(bits: number[]): number[] {
  const bytes: number[] = [];
  bits.forEach((bit, i) => {
    if (i % 8 === 0) bytes.push(0);
    bytes[bytes.length - 1] |= bit << (i % 8);
  });
  // Padding: the reader tops itself up a byte ahead of need.
  return [...bytes, 0, 0, 0];
}

/** `n` bits of `value`, least significant first. */
const field = (value: number, n: number) => Array.from({ length: n }, (_, i) => (value >> i) & 1);

/** A codec 16 stream: absolute-colour width, first colour, then the bits. */
const majMin = (shift: number, first: number, bits: number[]) => [shift, first, ...packBits(bits)];

describe('codec 1, byte RLE', () => {
  it('fills column by column, splitting each byte by the colour count', () => {
    // Sixteen colours: four bits of colour, four of length. 0x63 is three of
    // colour 6; the zero length in 0x20 defers to the next byte.
    const pixels = decodeByleRle(new Uint8Array([0x63, 0x20, 0x01]), 2, 2, 16);
    expect(Array.from(pixels)).toEqual([6, 6, 6, 2]);

    // Thirty-two colours: five bits of colour and three of length.
    expect(Array.from(decodeByleRle(new Uint8Array([(9 << 3) | 4]), 2, 2, 32))).toEqual([
      9, 9, 9, 9,
    ]);
    // Sixty-four: six and two.
    expect(Array.from(decodeByleRle(new Uint8Array([(40 << 2) | 3]), 3, 1, 64))).toEqual([
      40, 40, 40,
    ]);
  });

  it('reads a zero second length byte as a run of 256, not as the end', () => {
    const pixels = decodeByleRle(new Uint8Array([0x50, 0x00]), 16, 17, 16);
    expect(pixels.subarray(0, 256).every((pixel) => pixel === 5)).toBe(true);
    expect(pixels[256]).toBe(0);
  });

  it('is what a codec 1 costume decodes to, as columns', () => {
    const costume = parseAkos(
      Uint8Array.from(buildAkosCostume({ codec: AkosCodec.ByteRle, cel: [0x68] })),
    )!;
    const image = decodeAkosCel(costume, 0)!;
    expect(image.layout).toBe('columns');
    expect(Array.from(image.pixels)).toEqual([6, 6, 6, 6, 6, 6, 6, 6]);
  });
});

describe('codec 16, run major/minor', () => {
  it('writes the colour, then reads what the next one is', () => {
    const bits = [
      0, // keep 5
      1,
      1,
      ...field(6, 3), // change by 6 - 4 = +2: 7
      1,
      0,
      ...field(200, 8), // an absolute colour: 200
      0, // keep
    ];
    expect(Array.from(decodeMajMin(Uint8Array.from(majMin(8, 5, bits)), 4, 1))).toEqual([
      5, 5, 7, 200,
    ]);
  });

  it('wraps a change below zero within the byte', () => {
    const bits = [1, 1, ...field(0, 3), 0]; // change by -4
    expect(Array.from(decodeMajMin(Uint8Array.from(majMin(8, 2, bits)), 2, 1))).toEqual([2, 254]);
  });

  it('repeats a colour without reading the stream, across a line end', () => {
    // A change of zero reads a count instead; with a count of 3 the next two
    // pixels are taken from the repeat, and the stream resumes after them.
    const bits = [1, 1, ...field(4, 3), ...field(3, 8), 1, 0, ...field(50, 6)];
    expect(Array.from(decodeMajMin(Uint8Array.from(majMin(6, 9, bits)), 3, 2))).toEqual([
      9, 9, 9, 9, 50, 50,
    ]);
  });

  it('is what a codec 16 costume decodes to, as rows', () => {
    const costume = parseAkos(
      Uint8Array.from(
        buildAkosCostume({ codec: AkosCodec.RunMajMin, cel: majMin(8, 42, new Array(8).fill(0)) }),
      ),
    )!;
    const image = decodeAkosCel(costume, 0)!;
    expect(costume.decodable).toBe(true);
    expect(image.layout).toBe('rows');
    expect(Array.from(image.pixels)).toEqual(new Array(8).fill(42));
  });
});

describe('the BOMP blitter', () => {
  const image = { pixels: Uint8Array.from([1, 2, BOMP_TRANSPARENT, 0]), width: 4, height: 1 };

  function row(screen: Screen, y = 10) {
    return [0, 1, 2, 3].map((x) => screen.getPixel(10 + x, y));
  }

  it('paints 0, leaves 255 alone, and reverses a mirrored line', () => {
    const screen = new Screen();
    screen.pixels.fill(7);

    drawBomp(screen, image, { x: 10, y: 10 });
    expect(row(screen)).toEqual([1, 2, 7, 0]);

    screen.pixels.fill(7);
    drawBomp(screen, image, { x: 10, y: 10, mirror: true });
    expect(row(screen)).toEqual([0, 7, 2, 1]);
  });

  it('maps through an actor palette but keeps 255 transparent', () => {
    const screen = new Screen();
    screen.pixels.fill(7);
    const actorPalette = new Uint8Array(256).fill(99);

    drawBomp(screen, image, { x: 10, y: 10, actorPalette });
    expect(row(screen)).toEqual([99, 99, 7, 99]);
  });

  it('shades colour 13 in mode 1 and colours below 8 by their own table in mode 3', () => {
    const table = new Uint8Array(8 * 256);
    table[7] = 70;
    table[2 * 256 + 7] = 27;
    const screen = new Screen();
    screen.pixels.fill(7);
    const shaded = { pixels: Uint8Array.from([SHADOW_COLOUR, 2, 9]), width: 3, height: 1 };

    drawBomp(screen, shaded, { x: 10, y: 10, shadow: { mode: 1, table, akos: true } });
    expect(row(screen).slice(0, 3)).toEqual([70, 2, 9]);

    screen.pixels.fill(7);
    drawBomp(screen, shaded, { x: 10, y: 10, shadow: { mode: 3, table, akos: true } });
    expect(row(screen).slice(0, 3)).toEqual([SHADOW_COLOUR, 27, 9]);
  });

  it('shades a scaled picture as it does a full-size one', () => {
    // `drawBomp` scales first and shades what is left, so the two compose. A
    // blast object never asks for both, but the blitter itself supports it.
    const table = new Uint8Array(256).fill(50);
    const screen = new Screen();
    screen.pixels.fill(7);
    const all13 = { pixels: new Uint8Array(16).fill(SHADOW_COLOUR), width: 4, height: 4 };

    drawBomp(screen, all13, {
      x: 10,
      y: 10,
      scaleX: 128,
      scaleY: 128,
      shadow: { mode: 1, table, akos: true },
    });

    const touched = Array.from(screen.pixels).filter((pixel) => pixel !== 7);
    expect(touched.length).toBeGreaterThan(0);
    expect(touched.length).toBeLessThan(16);
    expect(touched.every((pixel) => pixel === 50)).toBe(true);
  });

  it('lets a z-plane hide a pixel', () => {
    const screen = new Screen();
    screen.pixels.fill(7);
    drawBomp(screen, image, { x: 10, y: 10, isMasked: (x) => x === 10 });
    expect(row(screen)).toEqual([7, 2, 7, 0]);
  });

  it('in a single-table build, shades colour 0 through it and reports the rest', () => {
    // v6 keeps one 256-entry table. Mode 3's colour-0 lookup lands in it;
    // colours 1-7 land past its end in the original.
    const table = new Uint8Array(256).fill(44);
    const past: number[] = [];
    const screen = new Screen();
    screen.pixels.fill(7);
    const low = { pixels: Uint8Array.from([0, 3]), width: 2, height: 1 };

    drawBomp(screen, low, {
      x: 10,
      y: 10,
      shadow: { mode: 3, table, akos: true, onPastTable: (colour) => past.push(colour) },
    });

    expect(row(screen).slice(0, 2)).toEqual([44, 3]);
    expect(past).toEqual([3]);
  });
});

const ACTOR = 1;

async function bootV7WithCostume(costume: AkosCostumeOptions) {
  const fixture = buildV7Fixture({ roomHeight: 128, costume });
  const source = new MemoryDataSource('v7');
  source.set(fixture.indexName, fixture.index);
  source.set(fixture.dataName, fixture.data);
  source.set(fixture.languageName, fixture.language);
  const logs: string[] = [];
  const engine = await ScummEngine.create(source, { onLog: (line) => logs.push(line) });
  engine.startScene(1, null, 0);
  engine.variables[VAR.EGO] = ACTOR;
  const actor = engine.getActor(ACTOR)!;
  actor.costume = 1;
  engine.putActorInRoom(ACTOR, 1);
  engine.putActor(ACTOR, 100, 100);
  return { engine, actor, logs };
}

/** The colours an actor puts on screen, found by drawing it and hiding it. */
function actorColours(engine: ScummEngine, actor: { visible: boolean }): Set<number> {
  engine.render();
  const drawn = Uint8Array.from(engine.screen.pixels);
  actor.visible = false;
  engine.render();
  actor.visible = true;
  const colours = new Set<number>();
  for (let i = 0; i < drawn.length; i++) {
    if (engine.screen.pixels[i] !== drawn[i]) colours.add(drawn[i]);
  }
  return colours;
}

describe('an AKOS actor in each codec', () => {
  it('draws codec 1 through the actor’s palette', async () => {
    const { engine, actor } = await bootV7WithCostume({ codec: AkosCodec.ByteRle, cel: [0x68] });
    actor.palette[6] = 99;
    expect(actorColours(engine, actor)).toEqual(new Set([99]));
  });

  it('draws codec 16 in its own colours, whatever the actor’s palette says', async () => {
    const { engine, actor } = await bootV7WithCostume({
      codec: AkosCodec.RunMajMin,
      cel: majMin(8, 42, new Array(8).fill(0)),
    });
    actor.palette[42] = 99;
    expect(actorColours(engine, actor)).toEqual(new Set([42]));
  });

  it('maps codec 5 only for a 256-colour costume whose actor overrides colour 0', async () => {
    const small = await bootV7WithCostume({ celColor: 6 });
    small.actor.palette[0] = 1;
    small.actor.palette[6] = 99;
    expect(actorColours(small.engine, small.actor)).toEqual(new Set([6]));

    const full = await bootV7WithCostume({ colors: 256, celColor: 6 });
    full.actor.palette[6] = 99;
    expect(actorColours(full.engine, full.actor)).toEqual(new Set([6]));
    full.actor.palette[0] = 1;
    expect(actorColours(full.engine, full.actor)).toEqual(new Set([99]));
  });
});

describe('AKOS shadow mode 2', () => {
  it('draws as mode 0, as ScummVM’s shipped renderer does, and says so once', async () => {
    const { engine, actor, logs } = await bootV7WithCostume({ celColor: SHADOW_COLOUR });
    engine.shadowPalette.table.fill(99);
    actor.shadowMode = 2;

    expect(actorColours(engine, actor)).toEqual(new Set([SHADOW_COLOUR]));
    engine.render();
    expect(logs.filter((line) => line.includes('shadow mode 2'))).toHaveLength(1);
  });
});

describe('AKOS shadow mode 3 in a v6 game', () => {
  async function bootV6(celColor: number) {
    const fixture = buildV6Fixture({ costume: { celColor } });
    const source = new MemoryDataSource('v6');
    source.set(fixture.indexName, fixture.index);
    source.set(fixture.dataName, fixture.data);
    const logs: string[] = [];
    const engine = await ScummEngine.create(source, { onLog: (line) => logs.push(line) });
    engine.boot(0);
    engine.startScene(1, null, 0);
    const actor = engine.actors[ACTOR];
    actor.costume = 1;
    actor.room = 1;
    actor.visible = true;
    engine.putActor(ACTOR, 80, 100);
    return { engine, actor, logs };
  }

  it('shades colour 0 through the one table the game keeps', async () => {
    const { engine, actor } = await bootV6(0);
    // Colour 0 painted plainly first, then shaded: the room here is not 0.
    expect(actorColours(engine, actor)).toEqual(new Set([0]));

    engine.shadowPalette.table.fill(99);
    actor.shadowMode = 3;
    expect(actorColours(engine, actor)).toEqual(new Set([99]));
  });

  it('draws colours 1-7 unshaded, naming the table it does not have', async () => {
    const { engine, actor, logs } = await bootV6(3);
    engine.shadowPalette.table.fill(99);
    actor.shadowMode = 3;

    expect(actorColours(engine, actor)).toEqual(new Set([3]));
    expect(logs.filter((line) => line.includes('shadow table 3'))).toHaveLength(1);
  });
});
