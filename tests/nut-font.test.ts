import { describe, expect, it } from 'vitest';
import { readNutFont } from '../src/engine/video/nut.js';

/** A tag and a big-endian size, padded to an even boundary. */
function chunk(tag: string, payload: number[]): number[] {
  const size = payload.length;
  return [
    ...[...tag].map((c) => c.charCodeAt(0)),
    (size >>> 24) & 0xff,
    (size >>> 16) & 0xff,
    (size >>> 8) & 0xff,
    size & 0xff,
    ...payload,
    ...(size & 1 ? [0] : []),
  ];
}

const u16 = (v: number) => [v & 0xff, (v >> 8) & 0xff];

function ahdr(chars: number): number[] {
  return [2, 0, ...u16(chars), 0, 0, ...new Array(0x300).fill(0), ...u16(15)];
}

/** A FOBJ: fourteen-byte header, then the codec's data. */
function fobj(codec: number, x: number, y: number, w: number, h: number, data: number[]) {
  return chunk('FOBJ', [
    ...u16(codec),
    ...u16(x),
    ...u16(y),
    ...u16(w),
    ...u16(h),
    0,
    0,
    0,
    0,
    ...data,
  ]);
}

function font(chars: number, glyphs: number[][]) {
  return new Uint8Array(
    chunk('ANIM', [
      ...chunk('AHDR', ahdr(chars)),
      ...glyphs.flatMap((glyph) => chunk('FRME', glyph)),
    ]),
  );
}

/**
 * `.NUT` fonts.
 *
 * A `.NUT` is a SMUSH animation whose frames are letters, so the container
 * reader is the one `smush.ts` already has — the argument for keeping this out
 * of `gfx/Charset.ts` turns out to go all the way down.
 */
describe('reading a .NUT font', () => {
  it('reads one glyph per frame, with its offsets', () => {
    // Codec 21: skip 0, run of 2 (encoded as 1), two pixels.
    const line = [...u16(0), ...u16(1), 7, 8];
    const glyph = fobj(21, 3, 4, 2, 1, [...u16(line.length), ...line]);

    const read = readNutFont(font(1, [glyph]))!;
    expect(read.glyphs).toHaveLength(1);
    expect(read.glyphs[0]).toMatchObject({ width: 2, height: 1, xOffset: 3, yOffset: 4 });
    expect([...read.glyphs[0].pixels]).toEqual([7, 8]);
  });

  it('fills a glyph with its transparent colour before decoding', () => {
    // These codecs *skip* pixels rather than writing them, so without the fill
    // whatever the buffer held shows through the gaps in a letter.
    const line = [...u16(2), ...u16(0), 9]; // skip 2, then one pixel
    const glyph = fobj(21, 0, 0, 3, 1, [...u16(line.length), ...line]);

    const read = readNutFont(font(1, [glyph]))!;
    expect([...read.glyphs[0].pixels]).toEqual([0, 0, 9]);
  });

  it('uses codec 44’s own transparent colour, which is not zero', () => {
    const line = [...u16(2), ...u16(0), 9];
    const glyph = fobj(44, 0, 0, 3, 1, [...u16(line.length), ...line]);

    const read = readNutFont(font(1, [glyph]))!;
    expect(read.glyphs[0].transparency).toBe(2);
    expect([...read.glyphs[0].pixels]).toEqual([2, 2, 9]);
  });

  it('biases a run length by one, so a glyph is not a pixel narrow per run', () => {
    // A run is never zero long. Dropping the bias reads as a slightly wrong
    // font rather than as a decode error, which is much harder to notice.
    const line = [...u16(0), ...u16(2), 1, 2, 3];
    const glyph = fobj(21, 0, 0, 3, 1, [...u16(line.length), ...line]);

    const read = readNutFont(font(1, [glyph]))!;
    expect([...read.glyphs[0].pixels]).toEqual([1, 2, 3]);
  });

  it('decodes a run-length glyph, which some fonts use instead', () => {
    const line = [0x05, 0x04]; // a run of three 4s
    const glyph = fobj(1, 0, 0, 3, 1, [...u16(line.length), ...line]);

    const read = readNutFont(font(1, [glyph]))!;
    expect([...read.glyphs[0].pixels]).toEqual([4, 4, 4]);
  });

  it('reports the tallest glyph, which a line of text advances by', () => {
    const short = fobj(21, 0, 0, 1, 2, [...u16(4), ...u16(1), ...u16(0), 1]);
    const tall = fobj(21, 0, 0, 1, 6, [...u16(4), ...u16(1), ...u16(0), 1]);

    expect(readNutFont(font(2, [short, tall]))!.height).toBe(6);
  });

  it('leaves an unknown codec transparent rather than filling it with noise', () => {
    // An undrawn letter is a gap in a subtitle; a letter drawn from a misread
    // stream is a block of colour over the video.
    const glyph = fobj(99, 0, 0, 2, 1, [1, 2, 3, 4]);
    const read = readNutFont(font(1, [glyph]))!;

    expect([...read.glyphs[0].pixels]).toEqual([0, 0]);
  });

  it('gives the letters it has when a font is truncated', () => {
    // AHDR claims three characters and only one frame follows.
    const glyph = fobj(21, 0, 0, 1, 1, [...u16(4), ...u16(0), ...u16(0), 5]);
    const read = readNutFont(font(3, [glyph]))!;

    expect(read.glyphs).toHaveLength(1);
  });

  it('returns null for a file that is not a font', () => {
    expect(readNutFont(new Uint8Array(chunk('LECF', [1, 2, 3])))).toBeNull();
  });
});
