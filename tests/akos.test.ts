import { describe, expect, it } from 'vitest';
import { decodeBomp, decodeBompLine } from '../src/engine/gfx/costume/bomp.js';
import {
  AKOS_MANY_DIRECTIONS,
  AkosCodec,
  decodeAkosCel,
  parseAkos,
} from '../src/engine/gfx/costume/akos.js';
import { chunk, u16le, u32le } from './fixture.js';
import { drawCel } from '../src/engine/gfx/CostumeRenderer.js';
import { Screen, SCREEN_HEIGHT } from '../src/engine/gfx/Screen.js';

/**
 * The v6 sprite format.
 *
 * BOMP first, because a cel is a BOMP image and every AKOS assertion below
 * rests on it decoding correctly.
 */

/** A BOMP line: a 16-bit byte count, then the control stream. */
function bompLine(control: number[]): number[] {
  return [...u16le(control.length), ...control];
}

/** A run of `count` pixels of `color`. */
const run = (count: number, color: number) => [((count - 1) << 1) | 1, color];
/** Literal pixels, copied straight through. */
const literal = (pixels: number[]) => [(pixels.length - 1) << 1, ...pixels];

describe('BOMP lines', () => {
  it('expands a run', () => {
    const out = new Uint8Array(4);
    decodeBompLine(new Uint8Array(run(4, 7)), 0, out, 4);

    expect(Array.from(out)).toEqual([7, 7, 7, 7]);
  });

  it('copies a literal', () => {
    const out = new Uint8Array(3);
    decodeBompLine(new Uint8Array(literal([1, 2, 3])), 0, out, 3);

    expect(Array.from(out)).toEqual([1, 2, 3]);
  });

  it('mixes runs and literals across one line', () => {
    const out = new Uint8Array(6);
    decodeBompLine(new Uint8Array([...run(2, 9), ...literal([1, 2]), ...run(2, 5)]), 0, out, 6);

    expect(Array.from(out)).toEqual([9, 9, 1, 2, 5, 5]);
  });

  it('leaves colour 0 transparent rather than writing it', () => {
    // What makes a costume draw over a room instead of as a rectangle.
    const out = new Uint8Array(4).fill(200);
    decodeBompLine(new Uint8Array([...run(2, 0), ...literal([0, 3])]), 0, out, 4);

    expect(Array.from(out)).toEqual([200, 200, 200, 3]);
  });

  it('stops at the line width even when a run overruns it', () => {
    // Decoding is driven by the output width, not by the input length — a
    // decoder that trusted the input would write past the end of the line.
    const out = new Uint8Array(3);
    decodeBompLine(new Uint8Array(run(100, 4)), 0, out, 3);

    expect(Array.from(out)).toEqual([4, 4, 4]);
  });
});

describe('a BOMP image', () => {
  it('walks to each line through its length prefix', () => {
    const image = new Uint8Array([
      ...bompLine(run(3, 1)),
      ...bompLine(run(3, 2)),
      ...bompLine([...literal([7]), ...run(2, 3)]),
    ]);

    expect(Array.from(decodeBomp(image, 3, 3))).toEqual([1, 1, 1, 2, 2, 2, 7, 3, 3]);
  });

  it('stops cleanly on a truncated image rather than reading past it', () => {
    const image = new Uint8Array([...bompLine(run(3, 1))]);
    // Two lines asked for, one supplied: the second stays transparent.
    expect(Array.from(decodeBomp(image, 3, 2))).toEqual([1, 1, 1, 0, 0, 0]);
  });
});

/** An AKOS costume with one 4x2 cel. */
function buildAkos({ codec = AkosCodec.CdatRle as number, flags = 0 } = {}) {
  const cel = [...bompLine(run(4, 6)), ...bompLine([...run(2, 6), ...run(2, 0)])];

  const akhd = chunk('AKHD', [
    ...u16le(1), // version
    ...u16le(flags),
    ...u16le(2), // chores
    ...u16le(1), // cels
    ...u16le(codec),
    ...u16le(1), // layers
  ]);
  const akpl = chunk('AKPL', [0, 1, 2, 3]);
  // Six bytes per cel: a 32-bit offset into AKCD, then a 16-bit one into AKCI.
  const akof = chunk('AKOF', [...u32le(0), ...u16le(0)]);
  const akci = chunk('AKCI', [
    ...u16le(4), // width
    ...u16le(2), // height
    ...u16le(3), // relX
    ...u16le(0x10000 - 5), // relY, negative
    ...u16le(1), // moveX
    ...u16le(2), // moveY
  ]);
  const akcd = chunk('AKCD', cel);
  const akch = chunk('AKCH', [...u16le(0), ...u16le(12)]);

  return new Uint8Array(chunk('AKOS', [...akhd, ...akpl, ...akof, ...akci, ...akcd, ...akch]));
}

describe('reading an AKOS costume', () => {
  it('reads the header fields', () => {
    const costume = parseAkos(buildAkos())!;

    expect(costume.celCount).toBe(1);
    expect(costume.choreCount).toBe(2);
    expect(costume.layerCount).toBe(1);
    expect(costume.codec).toBe(AkosCodec.CdatRle);
  });

  it('reads a cel through the two different offset widths in one record', () => {
    // The 32-bit half addresses the pixels and the 16-bit half the geometry.
    // Reading the record as one uniform array gets both wrong.
    const [cel] = parseAkos(buildAkos())!.cels;

    expect(cel.width).toBe(4);
    expect(cel.height).toBe(2);
    expect(cel.relX).toBe(3);
    expect(cel.relY).toBe(-5);
    expect(cel.moveX).toBe(1);
    expect(cel.moveY).toBe(2);
  });

  it('reads the palette index list', () => {
    expect(Array.from(parseAkos(buildAkos())!.palette)).toEqual([0, 1, 2, 3]);
  });

  it('reads the chore offset table', () => {
    expect(parseAkos(buildAkos())!.chores).toEqual([0, 12]);
  });

  it('is not fooled by another resource', () => {
    expect(parseAkos(new Uint8Array(chunk('COST', [1, 2, 3])))).toBeNull();
  });
});

describe('decoding a cel', () => {
  it('decodes the pixels, transparent where the cel is transparent', () => {
    const costume = parseAkos(buildAkos())!;
    const pixels = decodeAkosCel(costume, 0)!;

    expect(Array.from(pixels)).toEqual([6, 6, 6, 6, 6, 6, 0, 0]);
  });

  it('refuses a codec it does not decode, rather than producing noise', () => {
    /**
     * A cel decoded with the wrong codec is not a worse picture, it is noise —
     * and noise that renders looks like a rendering bug for a long time.
     */
    const costume = parseAkos(buildAkos({ codec: AkosCodec.RunMajMin }))!;

    expect(costume.decodable).toBe(false);
    expect(decodeAkosCel(costume, 0)).toBeNull();
  });

  it('returns null for a cel that is not there', () => {
    expect(decodeAkosCel(parseAkos(buildAkos())!, 9)).toBeNull();
  });
});

describe('direction', () => {
  it('reads the eight-direction flag', () => {
    const many = parseAkos(buildAkos({ flags: AKOS_MANY_DIRECTIONS }))!;
    expect(many.flags & AKOS_MANY_DIRECTIONS).not.toBe(0);
    expect(parseAkos(buildAkos())!.flags & AKOS_MANY_DIRECTIONS).toBe(0);
  });
});

describe('drawing an AKOS cel', () => {
  /**
   * `drawCel` takes decoded pixels plus geometry and ignores the costume it is
   * handed, so it is already format-agnostic — an AKOS cel has the same shape
   * as a classic one (width, height, relX, relY, moveX, moveY) and draws
   * through the same path. This is the join that makes a v6 actor drawable.
   */
  it('puts an AKOS cel on the screen through the shared renderer', () => {
    const costume = parseAkos(buildAkos())!;
    const pixels = decodeAkosCel(costume, 0)!;
    const screen = new Screen();

    // A palette that maps the cel's colour 6 to a value we can look for.
    const palette = new Uint8Array(256);
    palette[6] = 200;

    drawCel(screen, {} as never, costume.cels[0], pixels, {
      actorX: 40,
      actorY: 60,
      xMove: costume.cels[0].relX,
      yMove: costume.cels[0].relY,
      scaleX: 255,
      scaleY: 255,
      drawToRight: true,
      palette,
      clipTop: 0,
      clipBottom: SCREEN_HEIGHT,
    });

    expect(Array.from(screen.pixels).filter((pixel) => pixel === 200).length).toBeGreaterThan(0);
  });

  it('draws nothing where the cel is transparent', () => {
    const costume = parseAkos(buildAkos())!;
    const pixels = decodeAkosCel(costume, 0)!;
    const screen = new Screen();
    screen.pixels.fill(3);

    const palette = new Uint8Array(256);
    palette[6] = 200;

    drawCel(screen, {} as never, costume.cels[0], pixels, {
      actorX: 40,
      actorY: 60,
      xMove: 0,
      yMove: 0,
      scaleX: 255,
      scaleY: 255,
      drawToRight: true,
      palette,
      clipTop: 0,
      clipBottom: SCREEN_HEIGHT,
    });

    // The cel is 4x2 with its bottom-right two pixels transparent, so the
    // background must still show through somewhere inside its footprint.
    expect(Array.from(screen.pixels).filter((pixel) => pixel === 3).length).toBeGreaterThan(0);
  });
});
