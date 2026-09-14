import { describe, expect, it } from 'vitest';
import {
  drawFrameObject,
  readFrameObject,
  readPaletteChunk,
  readSmushFile,
  SmushCodec,
} from '../src/engine/video/smush.js';
import { SCREEN_HEIGHT, SCREEN_WIDTH } from '../src/engine/gfx/Screen.js';

/** A tag and a big-endian size, as the SMUSH container frames every chunk. */
function chunk(tag: string, payload: number[]): number[] {
  const size = payload.length;
  return [
    ...[...tag].map((c) => c.charCodeAt(0)),
    (size >>> 24) & 0xff,
    (size >>> 16) & 0xff,
    (size >>> 8) & 0xff,
    size & 0xff,
    ...payload,
    // Padded to an even boundary, which the reader has to account for.
    ...(size & 1 ? [0] : []),
  ];
}

function ahdr({ major = 2, frames = 3, speed = 15 } = {}): number[] {
  return [
    major,
    0, // minor
    frames & 0xff,
    (frames >> 8) & 0xff,
    0,
    0, // two spare
    ...new Array(0x300).fill(0).map((_, i) => i & 0xff),
    speed & 0xff,
    (speed >> 8) & 0xff,
  ];
}

describe('the .SAN container', () => {
  it('reads the header out of ANIM > AHDR', () => {
    const file = new Uint8Array(chunk('ANIM', [...chunk('AHDR', ahdr({ frames: 42 }))]));
    const read = readSmushFile(file)!;

    expect(read.header.majorVersion).toBe(2);
    expect(read.header.frameCount).toBe(42);
    expect(read.header.palette).toHaveLength(0x300);
  });

  it('reads a frame-rate override, which decides whether a video plays right', () => {
    const file = new Uint8Array(chunk('ANIM', [...chunk('AHDR', ahdr({ speed: 12 }))]));
    expect(readSmushFile(file)!.header.speed).toBe(12);
  });

  it('reports no override rather than zero, so the default is not overwritten', () => {
    const file = new Uint8Array(chunk('ANIM', [...chunk('AHDR', ahdr({ speed: 0 }))]));
    expect(readSmushFile(file)!.header.speed).toBeNull();
  });

  it('ignores an override from a version 1 header, which does not carry one', () => {
    const file = new Uint8Array(chunk('ANIM', [...chunk('AHDR', ahdr({ major: 1, speed: 12 }))]));
    expect(readSmushFile(file)!.header.speed).toBeNull();
  });

  it('collects each FRME and the chunks inside it', () => {
    const file = new Uint8Array(
      chunk('ANIM', [
        ...chunk('AHDR', ahdr()),
        ...chunk('FRME', [...chunk('NPAL', new Array(0x300).fill(1))]),
        ...chunk('FRME', [...chunk('FOBJ', new Array(20).fill(0)), ...chunk('IACT', [1, 2, 3, 4])]),
      ]),
    );
    const read = readSmushFile(file)!;

    expect(read.frames).toHaveLength(2);
    expect(read.frames[0].chunks.map((c) => c.tag)).toEqual(['NPAL']);
    expect(read.frames[1].chunks.map((c) => c.tag)).toEqual(['FOBJ', 'IACT']);
  });

  it('steps over the padding an odd-sized chunk carries', () => {
    // Without the pad every chunk after the first odd one is read a byte early,
    // which decodes as a plausible tag often enough to be confusing.
    const file = new Uint8Array(
      chunk('ANIM', [
        ...chunk('AHDR', ahdr()),
        ...chunk('FRME', [...chunk('TRES', [1, 2, 3]), ...chunk('IACT', [9])]),
      ]),
    );
    const read = readSmushFile(file)!;
    expect(read.frames[0].chunks.map((c) => c.tag)).toEqual(['TRES', 'IACT']);
  });

  it('returns null for a file that is not a SMUSH animation', () => {
    // A .SAN that will not open is a missing cutscene, and naming it is more
    // use than an exception thrown from inside a frame loop.
    expect(readSmushFile(new Uint8Array(chunk('LECF', [1, 2, 3])))).toBeNull();
  });
});

describe('frame objects', () => {
  const fobj = (codec: number, left: number, top: number, w: number, h: number, data: number[]) =>
    new Uint8Array([
      codec & 0xff,
      codec >> 8,
      left & 0xff,
      (left >> 8) & 0xff,
      top & 0xff,
      (top >> 8) & 0xff,
      w & 0xff,
      w >> 8,
      h & 0xff,
      h >> 8,
      0,
      0,
      0,
      0,
      ...data,
    ]);

  it('reads the codec and the rectangle from the 14-byte header', () => {
    const object = readFrameObject(fobj(SmushCodec.Rle, 10, 20, 320, 200, []))!;
    expect(object).toMatchObject({ codec: 1, left: 10, top: 20, width: 320, height: 200 });
  });

  it('draws an uncompressed frame straight into the framebuffer', () => {
    const object = readFrameObject(
      fobj(SmushCodec.Uncompressed, 0, 0, 4, 2, [1, 2, 3, 4, 5, 6, 7, 8]),
    )!;
    const target = new Uint8Array(SCREEN_WIDTH * SCREEN_HEIGHT);

    expect(drawFrameObject(object, target)).toBe(true);
    expect([...target.subarray(0, 4)]).toEqual([1, 2, 3, 4]);
    expect([...target.subarray(SCREEN_WIDTH, SCREEN_WIDTH + 4)]).toEqual([5, 6, 7, 8]);
  });

  it('decodes a run-length line, treating zero as black rather than transparent', () => {
    // The difference from the costume decoder that shares this encoding: a
    // video frame *is* the picture, so skipping zeros would leave the previous
    // frame showing through every shadow.
    const line = [0x03, 0x00, 0x05, 0x07]; // run of 2 zeros, then run of 3 sevens
    const data = [line.length & 0xff, line.length >> 8, ...line];
    const object = readFrameObject(fobj(SmushCodec.Rle, 0, 0, 5, 1, data))!;

    const target = new Uint8Array(SCREEN_WIDTH * SCREEN_HEIGHT).fill(9);
    expect(drawFrameObject(object, target)).toBe(true);
    expect([...target.subarray(0, 5)]).toEqual([0, 0, 7, 7, 7]);
  });

  it('handles the second RLE codec number the same way', () => {
    const line = [0x05, 0x04];
    const data = [line.length & 0xff, line.length >> 8, ...line];
    const object = readFrameObject(fobj(SmushCodec.RleAlt, 0, 0, 3, 1, data))!;

    const target = new Uint8Array(SCREEN_WIDTH * SCREEN_HEIGHT);
    expect(drawFrameObject(object, target)).toBe(true);
    expect([...target.subarray(0, 3)]).toEqual([4, 4, 4]);
  });

  it('clips a frame object that runs off the screen rather than wrapping', () => {
    const object = readFrameObject(
      fobj(SmushCodec.Uncompressed, SCREEN_WIDTH - 2, 0, 4, 1, [1, 2, 3, 4]),
    )!;
    const target = new Uint8Array(SCREEN_WIDTH * SCREEN_HEIGHT);

    drawFrameObject(object, target);
    expect(target[SCREEN_WIDTH - 2]).toBe(1);
    expect(target[SCREEN_WIDTH - 1]).toBe(2);
    // The wrap that clipping prevents: row 1 column 0 must stay untouched.
    expect(target[SCREEN_WIDTH]).toBe(0);
  });

  it('reports an unimplemented codec rather than drawing garbage', () => {
    // Codecs 37 and 47 are the motion-compensated ones Full Throttle and The
    // Dig use for most of their video. An unhandled codec that leaves the
    // previous frame up looks like a stalled video, which is much harder to
    // diagnose than a named number.
    const object = readFrameObject(fobj(SmushCodec.DeltaGlyphs, 0, 0, 320, 200, [1, 2, 3]))!;
    const target = new Uint8Array(SCREEN_WIDTH * SCREEN_HEIGHT);

    expect(drawFrameObject(object, target)).toBe(false);
  });
});

describe('palette chunks', () => {
  it('reads 256 RGB triples', () => {
    expect(readPaletteChunk(new Uint8Array(0x300))).toHaveLength(0x300);
  });

  it('refuses a short palette rather than reading past it', () => {
    expect(readPaletteChunk(new Uint8Array(10))).toBeNull();
  });
});
