import { describe, expect, it } from 'vitest';
import {
  decodeColumnStrip,
  decodeCompressedSprite,
  decodeRowStrip,
  decodeSprite,
} from '../src/engine/agos/gfx/agosImage.js';

describe('the run-length form that walks down columns', () => {
  /**
   * The direction is the point. A decoder that fills rows produces a picture
   * that is recognisably the right image and completely wrong, which is the
   * hardest kind of graphics bug to see in a screenshot.
   */
  it('fills a column before moving to the next one', () => {
    // One run of four pixels of colour 7, then four of colour 3.
    const decoded = decodeColumnStrip(Uint8Array.of(3, 7, 3, 3), 4);

    // Row 0 holds one pixel of each column, so the two runs appear side by side
    // rather than one after the other — which is the whole difference.
    expect([...decoded.pixels.slice(0, 8)]).toEqual([7, 3, 0, 0, 0, 0, 0, 0]);
    expect(decoded.pixels[8]).toBe(7);
    expect(decoded.pixels[1]).toBe(3);
  });

  it('copies literal bytes when the run length is negative', () => {
    // -3 means "the next three bytes are pixels", not a repeat.
    const decoded = decodeColumnStrip(Uint8Array.of(0xfd, 1, 2, 3), 4);

    expect(decoded.pixels[0]).toBe(1);
    expect(decoded.pixels[8]).toBe(2);
    expect(decoded.pixels[16]).toBe(3);
  });

  it('stops at the end of the eighth column rather than running on', () => {
    const decoded = decodeColumnStrip(new Uint8Array(200).fill(0), 2);

    expect(decoded.width).toBe(8);
    expect(decoded.height).toBe(2);
  });
});

describe('the run-length form that walks along rows', () => {
  it('fills a row before moving down', () => {
    const decoded = decodeRowStrip(Uint8Array.of(3, 9), 4);

    expect([...decoded.pixels.slice(0, 4)]).toEqual([9, 9, 9, 9]);
    expect(decoded.pixels[4]).toBe(0);
    expect(decoded.height).toBe(8);
  });
});

describe('the sprite form', () => {
  it('unpacks two pixels from each byte, high nibble on the left', () => {
    const decoded = decodeSprite(Uint8Array.of(0x12, 0x34), 2, 1, { opaque: true });

    expect([...decoded.pixels]).toEqual([1, 2, 3, 4]);
    // Width is given in bytes and the bitmap is twice that in pixels, which is
    // the format's own unit kept rather than converted at the boundary.
    expect(decoded.width).toBe(4);
  });

  it('treats colour zero as transparent unless told otherwise', () => {
    const transparent = decodeSprite(Uint8Array.of(0x05), 1, 1);
    const opaque = decodeSprite(Uint8Array.of(0x05), 1, 1, { opaque: true });

    // Both write the 5; only the opaque one writes the 0 over what was there.
    expect([...transparent.pixels]).toEqual([0, 5]);
    expect([...opaque.pixels]).toEqual([0, 5]);
    expect(transparent.pixels).toHaveLength(2);
    expect(opaque.pixels).toHaveLength(2);
  });
});

describe('the compressed sprite form', () => {
  /**
   * The one AGOS encoding that cannot be decoded a piece at a time: a run may
   * end mid-column and carry into the next. A decoder that restarts per column
   * loses exactly the runs that straddle a boundary, and produces an image that
   * is right down the left edge and progressively wrong across — which is why
   * this test spans one.
   */
  it('carries a run across a column boundary', () => {
    // One run of six bytes of 0x11, spanning a 1-byte-wide, 4-high image and
    // into the next column of a 2-wide one.
    const decoded = decodeCompressedSprite(Uint8Array.of(5, 0x11), 2, 3, { opaque: true });

    expect([...decoded.pixels]).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
  });

  it('reads a negative run as literal bytes', () => {
    const decoded = decodeCompressedSprite(Uint8Array.of(0xfe, 0x12, 0x34), 1, 2, { opaque: true });

    expect([...decoded.pixels]).toEqual([1, 2, 3, 4]);
  });

  it('keeps colour zero transparent unless told otherwise', () => {
    const decoded = decodeCompressedSprite(Uint8Array.of(0xff, 0x05), 1, 1);

    expect([...decoded.pixels]).toEqual([0, 5]);
  });
});
