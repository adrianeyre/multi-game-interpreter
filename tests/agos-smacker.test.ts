import { describe, expect, it } from 'vitest';
import { Smacker, looksLikeSmacker } from '../src/engine/agos/video/smacker.js';
import { buildSmacker, type SmackerBlock } from './fixtureSmacker.js';

/** The 4x4 block at (blockX, blockY) of a decoded frame, row-major. */
function block(pixels: Uint8Array, width: number, blockX: number, blockY: number): number[] {
  const out: number[] = [];
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      out.push(pixels[(blockY * 4 + row) * width + blockX * 4 + column] ?? 0);
    }
  }
  return out;
}

const fill = (colour: number): SmackerBlock => ({ kind: 'fill', colour });
const skip = (): SmackerBlock => ({ kind: 'skip' });

describe('the Smacker container', () => {
  it('is recognised by its signature and nothing else is', () => {
    const file = buildSmacker({ width: 8, height: 8, frames: [{ blocks: [skip()] }] });

    expect(looksLikeSmacker(file)).toBe(true);
    expect(looksLikeSmacker(new Uint8Array(200))).toBe(false);
    expect(looksLikeSmacker(Uint8Array.from([0x44, 0x45, 0x58, 0x41]))).toBe(false);
  });

  it('reads what the header says without decoding a frame', () => {
    const file = buildSmacker({
      width: 16,
      height: 8,
      frameRateMs: 40,
      frames: [{ blocks: [skip()] }, { blocks: [skip()] }, { blocks: [skip()] }],
    });

    const film = Smacker.open(file);

    expect(film?.info.version).toBe(2);
    expect(film?.info.width).toBe(16);
    expect(film?.info.height).toBe(8);
    expect(film?.info.frameCount).toBe(3);
    expect(film?.info.frameSeconds).toBeCloseTo(0.04);
  });

  it('shows a Y-doubled file at twice the height it decodes', () => {
    const file = buildSmacker({
      width: 8,
      height: 8,
      doubled: true,
      frames: [{ blocks: [skip(), skip(), skip(), skip()] }],
    });

    const film = Smacker.open(file);

    expect(film?.info.height).toBe(8);
    expect(film?.info.displayHeight).toBe(16);
  });

  it('answers null for bytes that are not a Smacker file', () => {
    expect(Smacker.open(new Uint8Array(8))).toBeNull();
  });
});

describe('Smacker block kinds', () => {
  it('paints a fill block as one colour across its sixteen pixels', () => {
    const file = buildSmacker({
      width: 8,
      height: 8,
      frames: [{ blocks: [fill(5), fill(6), fill(7), fill(8)] }],
    });

    const frame = Smacker.open(file)?.nextFrame();

    expect(block(frame!.pixels, 8, 0, 0)).toEqual(Array(16).fill(5));
    expect(block(frame!.pixels, 8, 1, 0)).toEqual(Array(16).fill(6));
    expect(block(frame!.pixels, 8, 0, 1)).toEqual(Array(16).fill(7));
    expect(block(frame!.pixels, 8, 1, 1)).toEqual(Array(16).fill(8));
  });

  it('paints a full block as exactly the pixels it was given', () => {
    // Sixteen distinct values, so a decoder that transposed a row or swapped
    // the halves of one could not produce them.
    const pixels = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
    const file = buildSmacker({
      width: 4,
      height: 4,
      frames: [{ blocks: [{ kind: 'full', pixels }] }],
    });

    const frame = Smacker.open(file)?.nextFrame();

    expect([...frame!.pixels]).toEqual(pixels);
  });

  it('paints a mono block by its mask, low colour for a clear bit', () => {
    // Two blocks rather than one, so the colour and mask trees carry two
    // symbols each and the frame is a real bitstream rather than a degenerate
    // one that would pass whatever the decoder did with it.
    const file = buildSmacker({
      width: 8,
      height: 4,
      frames: [
        {
          blocks: [
            // The mask is read four bits per row, low bit leftmost: the top row
            // picks high, low, high, low and the rows below pick low.
            { kind: 'mono', low: 3, high: 9, map: 0b0101 },
            // And here the third row picks high all the way across.
            { kind: 'mono', low: 4, high: 6, map: 0b1111_0000_0000 },
          ],
        },
      ],
    });

    const frame = Smacker.open(file)?.nextFrame();
    const pixels = frame!.pixels;

    expect([...pixels.subarray(0, 4)]).toEqual([9, 3, 9, 3]);
    expect([...pixels.subarray(8, 12)]).toEqual([3, 3, 3, 3]);
    expect([...pixels.subarray(4, 8)]).toEqual([4, 4, 4, 4]);
    expect([...pixels.subarray(20, 24)]).toEqual([6, 6, 6, 6]);
  });

  it('leaves the previous frame alone where a block is skipped', () => {
    const file = buildSmacker({
      width: 8,
      height: 8,
      frames: [
        { blocks: [fill(2), fill(3), fill(4), fill(5)] },
        { blocks: [skip(), fill(9), skip(), skip()] },
      ],
    });

    const film = Smacker.open(file)!;
    film.nextFrame();
    const second = film.nextFrame();

    // A difference frame is a difference: three quarters of it is the frame
    // before, which only holds because the reader keeps a canvas.
    expect(block(second!.pixels, 8, 0, 0)).toEqual(Array(16).fill(2));
    expect(block(second!.pixels, 8, 1, 0)).toEqual(Array(16).fill(9));
    expect(block(second!.pixels, 8, 0, 1)).toEqual(Array(16).fill(4));
    expect(block(second!.pixels, 8, 1, 1)).toEqual(Array(16).fill(5));
  });

  it('reads a Smacker 4 full block, which spends bits saying how it is written', () => {
    const pixels = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
    const file = buildSmacker({
      width: 4,
      height: 4,
      version: '4',
      frames: [{ blocks: [{ kind: 'full', pixels }] }],
    });

    const film = Smacker.open(file);

    expect(film?.info.version).toBe(4);
    expect([...film!.nextFrame()!.pixels]).toEqual(pixels);
  });

  it('runs out of frames rather than looping', () => {
    const file = buildSmacker({ width: 4, height: 4, frames: [{ blocks: [fill(1)] }] });

    const film = Smacker.open(file)!;

    expect(film.nextFrame()).not.toBeNull();
    expect(film.nextFrame()).toBeNull();
  });
});

describe('the Smacker palette', () => {
  it('widens six-bit components through the format’s own table', () => {
    const file = buildSmacker({
      width: 4,
      height: 4,
      frames: [{ blocks: [fill(0)], palette: [[0x3f, 0x00, 0x20]] }],
    });

    const frame = Smacker.open(file)?.nextFrame();

    // 0x3f is full brightness. Multiplying by four would give 0xfc, which is a
    // picture very slightly dark in its brightest colours — the fault class
    // that looks like nothing at all.
    expect(frame?.paletteChanged).toBe(true);
    expect([...frame!.palette.subarray(0, 3)]).toEqual([0xff, 0x00, 0x82]);
  });

  it('says a frame did not change the palette rather than handing back a copy', () => {
    const file = buildSmacker({ width: 4, height: 4, frames: [{ blocks: [fill(0)] }] });

    expect(Smacker.open(file)?.nextFrame()?.paletteChanged).toBe(false);
  });
});

describe('Smacker audio', () => {
  it('decodes an uncompressed track to samples in the mixer’s range', () => {
    const file = buildSmacker({
      width: 4,
      height: 4,
      audioRate: 22_050,
      frames: [{ blocks: [fill(0)], audio: Uint8Array.from([0, 128, 255]) }],
    });

    const frame = Smacker.open(file)?.nextFrame();

    expect(frame?.audio).toHaveLength(1);
    expect(frame?.audio[0]?.sampleRate).toBe(22_050);
    expect(frame?.audio[0]?.channels).toBe(1);
    expect([...frame!.audio[0]!.samples]).toEqual([-1, 0, 127 / 128]);
  });

  it('carries no audio for a frame that has none', () => {
    const file = buildSmacker({
      width: 4,
      height: 4,
      audioRate: 22_050,
      frames: [{ blocks: [fill(0)] }],
    });

    expect(Smacker.open(file)?.nextFrame()?.audio).toHaveLength(0);
  });
});
