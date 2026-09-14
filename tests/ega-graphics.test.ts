import { describe, expect, it } from 'vitest';

import { decodeEgaStrip } from '../src/engine/gfx/BitmapCodec.js';
import { RoomGraphics } from '../src/engine/gfx/RoomGraphics.js';

/**
 * The pre-v5 bitmap codec, which is not a variation on the VGA family.
 *
 * `BitmapCodec.ts` decodes the `SMAP` codecs by reading a code byte and a
 * bits-per-pixel digit out of it. The EGA scheme has neither: three control
 * shapes chosen by the top two bits, scanning down each column rather than
 * across, with a dithered case that alternates two colours out of one byte.
 */

/** Reads a strip back as rows of eight, for readable assertions. */
function strip(bytes: number[], height: number, seed?: number[]): number[][] {
  const dst = new Uint8Array(8 * height);
  if (seed) dst.set(seed);
  decodeEgaStrip(new Uint8Array(bytes), 0, {
    dst,
    dstOffset: 0,
    dstStride: 8,
    height,
    transparentColor: 255,
  });
  const rows: number[][] = [];
  for (let y = 0; y < height; y++) rows.push([...dst.subarray(y * 8, y * 8 + 8)]);
  return rows;
}

describe('the EGA strip codec', () => {
  it('fills a strip with one colour, counting down each column', () => {
    // 0x44 = a run of four in colour 4, repeated to fill an 8x4 strip.
    const rows = strip(Array(8).fill(0x44), 4);
    expect(rows).toEqual([
      [4, 4, 4, 4, 4, 4, 4, 4],
      [4, 4, 4, 4, 4, 4, 4, 4],
      [4, 4, 4, 4, 4, 4, 4, 4],
      [4, 4, 4, 4, 4, 4, 4, 4],
    ]);
  });

  it('takes the run length from the next byte when the nibble is zero', () => {
    // 0x07 says "colour 7, length follows"; 32 fills the whole 8x4 strip.
    expect(strip([0x07, 32], 4)[2]).toEqual([7, 7, 7, 7, 7, 7, 7, 7]);
  });

  it('dithers two colours out of one byte rather than running them separately', () => {
    // 0xC4 = a dithered run of four; 0x53 alternates colour 5 and colour 3.
    // Read as two runs the picture is the right shape and visibly striped.
    const rows = strip([0xc4, 0x53, 0xc4, 0x53, 0x04, 24], 4);
    expect(rows.map((row) => row[0])).toEqual([5, 3, 5, 3]);
  });

  it('copies the pixel to the left, which is how a strip continues one before it', () => {
    // Column 0 is colour 6; 0x84 then copies four pixels leftwards into
    // column 1, which is what makes the second column the same as the first.
    const rows = strip([0x46, 0x84, 0x04, 24], 4);
    expect(rows.map((row) => row[1])).toEqual([6, 6, 6, 6]);
  });

  it('stops at the end of the strip rather than running past it', () => {
    // A run far longer than the strip holds. Writing past it would corrupt
    // whatever the caller put after the scratch buffer.
    const rows = strip([0x03, 200], 2);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual([3, 3, 3, 3, 3, 3, 3, 3]);
  });
});

describe('a v4 room image', () => {
  /**
   * `BM` holds its own strip table: the payload's length, then one offset per
   * strip counted from the payload's start. Sixteen bits wide for a
   * sixteen-colour release and thirty-two for a 256-colour one, which moves
   * both the stride and the first entry.
   */
  function bmBlock(entryBytes: 2 | 4, strips: number[][]): Uint8Array {
    const tableBytes = entryBytes * (strips.length + 1);
    const offsets: number[] = [];
    let at = tableBytes;
    for (const data of strips) {
      offsets.push(at);
      at += data.length;
    }

    const payload: number[] = [];
    const push = (value: number) => {
      payload.push(value & 0xff, (value >> 8) & 0xff);
      if (entryBytes === 4) payload.push((value >> 16) & 0xff, (value >> 24) & 0xff);
    };
    push(at);
    for (const offset of offsets) push(offset);
    for (const data of strips) payload.push(...data);

    const size = payload.length + 6;
    return new Uint8Array([
      size & 0xff,
      (size >> 8) & 0xff,
      (size >> 16) & 0xff,
      (size >> 24) & 0xff,
      'B'.charCodeAt(0),
      'M'.charCodeAt(0),
      ...payload,
    ]);
  }

  it('decodes a sixteen-colour image through the EGA codec', () => {
    const graphics = new RoomGraphics(16, 4, 0, 255);
    // Two strips: one solid colour 2, one solid colour 9.
    graphics.decodeSmallImage(
      bmBlock(2, [
        [0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42],
        [0x49, 0x49, 0x49, 0x49, 0x49, 0x49, 0x49, 0x49],
      ]),
      // The strip table, not the block: a room's `BM` puts it straight after
      // the six byte header and an object's `OI` puts an id in between, so the
      // decoder is told where the table is rather than deducing it.
      6,
      0,
      0,
      16,
      4,
      true,
    );

    expect(graphics.background[0]).toBe(2);
    expect(graphics.background[7]).toBe(2);
    expect(graphics.background[8]).toBe(9);
    expect(graphics.background[15]).toBe(9);
  });

  it('decodes a 256-colour image through the codec family v5 shares', () => {
    // Codec 1 is raw eight-bit pixels, and a 256-colour v4 release writes the
    // same strips a v5 one does — the difference is only where the table is.
    const raw = [1, ...Array.from({ length: 8 * 2 }, (_, i) => (i % 8) + 10)];
    const graphics = new RoomGraphics(8, 2, 0, 255);
    graphics.decodeSmallImage(bmBlock(4, [raw]), 6, 0, 0, 8, 2, false);

    expect([...graphics.background.subarray(0, 8)]).toEqual([10, 11, 12, 13, 14, 15, 16, 17]);
  });
});

describe('writing pre-v5 art back', () => {
  /**
   * The encoder's bar is *correct*, not byte-identical.
   *
   * `CONTEXT.md` makes byte-identity a property of resources nobody touched,
   * and unedited art is copied rather than re-encoded — so the only thing worth
   * asserting is the round trip: what the game's own reader makes of what the
   * encoder wrote has to be the pixels it was given.
   */
  async function roundTrip(
    pixels: number[],
    width: number,
    height: number,
    sixteenColour: boolean,
  ): Promise<Uint8Array> {
    const { encodeSmallImage } = await import('../src/authoring/ImageEncoder.js');
    const body = encodeSmallImage({ width, height, pixels: new Uint8Array(pixels) }, sixteenColour);
    // The encoder writes the block's payload; the reader is told where the
    // table starts, so the two meet without a header in between.
    const data = new Uint8Array(body);
    const graphics = new RoomGraphics(width, height, 0, 255);
    graphics.decodeSmallImage(data, 0, 0, 0, width, height, sixteenColour);
    return graphics.background;
  }

  it('round-trips a sixteen-colour image through the EGA run form', async () => {
    const width = 16;
    const height = 4;
    const pixels = Array.from({ length: width * height }, (_, i) => (i % 13) & 0x0f);

    expect(Array.from(await roundTrip(pixels, width, height, true))).toEqual(pixels);
  });

  it('round-trips a run longer than a nibble can carry', async () => {
    // A colour run of sixteen or more spills into a length byte, which is a
    // different encoding of the same thing and the one a flat area produces.
    const width = 8;
    const height = 40;
    const pixels = new Array(width * height).fill(7);

    expect(Array.from(await roundTrip(pixels, width, height, true))).toEqual(pixels);
  });

  it('round-trips a 256-colour image through the codec v5 shares', async () => {
    const width = 24;
    const height = 3;
    const pixels = Array.from({ length: width * height }, (_, i) => (i * 7) & 0xff);

    expect(Array.from(await roundTrip(pixels, width, height, false))).toEqual(pixels);
  });

  it('writes a table whose entries are narrower for sixteen colours', async () => {
    const { encodeSmallImage } = await import('../src/authoring/ImageEncoder.js');
    const image = { width: 16, height: 2, pixels: new Uint8Array(32) };

    // Three entries — the length and two strips — at two bytes against four.
    const ega = encodeSmallImage(image, true);
    const vga = encodeSmallImage(image, false);
    expect(ega[0] | (ega[1] << 8)).toBe(ega.length);
    expect(vga[0] | (vga[1] << 8) | (vga[2] << 16) | (vga[3] << 24)).toBe(vga.length);
  });
});

describe('the colours an editor offers for a room', () => {
  /**
   * A sixteen-colour room must not be offered 256.
   *
   * The encoder writes a colour index into four bits, so a colour picked above
   * fifteen comes back as a *different* colour — silently, and only in the
   * exported game.
   */
  it('offers exactly the colours a sixteen-colour room has', async () => {
    const { paletteChoices } = await import('../src/authoring/palette.js');

    expect(paletteChoices(16)).toEqual(Array.from({ length: 16 }, (_, i) => i));
    expect(paletteChoices(16).every((index) => index < 16)).toBe(true);
  });

  it('spreads across the cube for a 256-colour room rather than listing it', async () => {
    const { paletteChoices } = await import('../src/authoring/palette.js');
    const choices = paletteChoices(256);

    // The named sixteen in full, then a sample — a picker with 256 swatches is
    // a picker nobody uses.
    expect(choices.slice(0, 16)).toEqual(Array.from({ length: 16 }, (_, i) => i));
    expect(choices.length).toBeLessThan(64);
    expect(Math.max(...choices)).toBeLessThan(256);
  });

  it('never offers nothing, however small the palette', async () => {
    const { paletteChoices } = await import('../src/authoring/palette.js');
    expect(paletteChoices(0)).toEqual([0]);
  });
});
