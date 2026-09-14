import { describe, expect, it } from 'vitest';
import { decode32ColourSprite } from '../src/engine/agos/gfx/agosImage.js';

/**
 * Simon 1's third pixel encoding.
 *
 * The one that was missing rather than wrong, and the reason a room drew as
 * regular vertical stripes with the previous screen showing between them: a
 * backdrop packs **five** bits per pixel and was being read as four.
 */
describe('the thirty-two colour encoding', () => {
  it('unpacks eight pixels out of five bytes', () => {
    // Chosen so every pixel is a different value and the two that straddle the
    // fifth byte are not zero: 1..8 packed five bits each, big-endian.
    const values = [1, 2, 3, 4, 5, 6, 7, 8];
    let bits = 0n;
    for (const value of values) bits = (bits << 5n) | BigInt(value);
    const packed = new Uint8Array(5);
    for (let index = 4; index >= 0; index -= 1) {
      packed[index] = Number(bits & 0xffn);
      bits >>= 8n;
    }

    const image = decode32ColourSprite(packed, 8, 1, { compressed: true, opaque: true });

    expect(image.width).toBe(8);
    expect([...image.pixels]).toEqual(values);
  });

  it('uses the whole five-bit range rather than four', () => {
    // 31 is representable in five bits and not in four, so a four-bit decode
    // cannot produce it however the bytes are read.
    const values = [31, 0, 31, 0, 31, 0, 31, 0];
    let bits = 0n;
    for (const value of values) bits = (bits << 5n) | BigInt(value);
    const packed = new Uint8Array(5);
    for (let index = 4; index >= 0; index -= 1) {
      packed[index] = Number(bits & 0xffn);
      bits >>= 8n;
    }

    const image = decode32ColourSprite(packed, 8, 1, { compressed: true, opaque: true });

    expect([...image.pixels]).toEqual(values);
  });

  it('treats colour zero as transparent unless the draw says otherwise', () => {
    const packed = new Uint8Array(5);
    const image = decode32ColourSprite(packed, 8, 1, { compressed: true });

    // Nothing written, rather than eight zeroes written over what was there.
    expect([...image.pixels]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('reads the uncompressed form as a byte a pixel', () => {
    const source = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);

    const image = decode32ColourSprite(source, 4, 2, { opaque: true });

    expect(image.width).toBe(4);
    expect([...image.pixels]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('does not read past a row that is not a whole number of groups', () => {
    // Twelve pixels is a group and a half. The reference's loop runs whole
    // groups only, so the last four pixels of each row are left unwritten
    // rather than assembled out of the next row's bytes.
    const source = new Uint8Array(10).fill(0xff);

    const image = decode32ColourSprite(source, 12, 1, { compressed: true, opaque: true });

    expect([...image.pixels.subarray(0, 8)]).toEqual([31, 31, 31, 31, 31, 31, 31, 31]);
    expect([...image.pixels.subarray(8)]).toEqual([0, 0, 0, 0]);
  });
});
