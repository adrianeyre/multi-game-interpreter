/**
 * Packing a bitmap back into the uncompressed sprite form.
 *
 * The encoder a paint surface needs: without it an AGOS image can be decoded
 * and looked at but never written back, which is the difference between
 * inspecting a game's art and editing it.
 *
 * The strongest thing to assert here is a **round trip**, because that is what
 * a paint surface actually does — decode, change some pixels, encode. A test
 * that only checked the packing arithmetic would pass against an encoder whose
 * nibble order was reversed, since it would be reversed consistently.
 */
import { describe, expect, it } from 'vitest';
import {
  compressedSpriteLength,
  decodeCompressedSprite,
  decodeSprite,
  encodeCompressedSprite,
  encodeSprite,
  encodeSpriteRefusal,
} from '../src/engine/agos/gfx/agosImage.js';
import { DRAW_FLAGS } from '../src/engine/agos/gfx/vgaImages.js';

describe('a decode and encode round trip', () => {
  it('returns the bytes it started from', () => {
    // Opaque, because a transparent decode drops colour 0 and the round trip
    // would then be testing the transparency rule rather than the packing.
    const bytes = new Uint8Array([0x12, 0x34, 0xab, 0xcd, 0x00, 0xff]);

    const decoded = decodeSprite(bytes, 3, 2, { opaque: true });
    const encoded = encodeSprite(decoded, 3, 2);

    expect([...encoded]).toEqual([...bytes]);
  });

  it('survives an edited pixel, which is the whole point', () => {
    const bytes = new Uint8Array([0x12, 0x34]);
    const decoded = decodeSprite(bytes, 2, 1, { opaque: true });

    // Paint the first pixel a different colour and pack it back.
    decoded.pixels[0] = 0xf;
    const encoded = encodeSprite(decoded, 2, 1);

    expect([...encoded]).toEqual([0xf2, 0x34]);
    // And reading it back gives the pixel that was painted.
    expect(decodeSprite(encoded, 2, 1, { opaque: true }).pixels[0]).toBe(0xf);
  });

  it('puts the left pixel in the high nibble', () => {
    // Stated separately from the round trip, which a consistently reversed
    // encoder would also pass.
    const decoded = decodeSprite(new Uint8Array([0x70]), 1, 1, { opaque: true });

    expect(decoded.pixels[0]).toBe(7);
    expect(decoded.pixels[1]).toBe(0);
  });
});

describe('what the encoder refuses', () => {
  it('rejects a bitmap whose width does not match the byte width', () => {
    // A row of an odd pixel width has no representation in a format whose unit
    // is two pixels, so this is impossible to express rather than wrong later.
    const decoded = decodeSprite(new Uint8Array([0x12]), 1, 1, { opaque: true });

    expect(() => encodeSprite(decoded, 2, 1)).toThrow(/holds 4 pixels, not 2/);
  });

  it('rejects a colour too large for four bits, rather than masking it', () => {
    // Masking would write a *different* colour and look like it worked.
    const decoded = decodeSprite(new Uint8Array([0x00]), 1, 1, { opaque: true });
    decoded.pixels[0] = 200;

    expect(() => encodeSprite(decoded, 1, 1)).toThrow(/does not fit four bits/);
  });

  it('rejects a row count that disagrees with the bitmap', () => {
    const decoded = decodeSprite(new Uint8Array([0x12, 0x34]), 1, 2, { opaque: true });

    expect(() => encodeSprite(decoded, 1, 1)).toThrow(/expected 1 rows/);
  });
});

describe('which images may be written back at all', () => {
  it('allows an uncompressed image', () => {
    expect(encodeSpriteRefusal(0)).toBeNull();
  });

  it('no longer refuses a compressed one, because there is an encoder for it now', () => {
    // The old refusal argued byte identity: a compressed bitmap has many valid
    // encodings, so a re-encode gives different bytes for the same picture.
    // True, and the wrong inference — what ADR 0030 protects is an image that
    // was merely *opened*, and nothing re-encodes one of those. On Simon 1,
    // whose sprites are compressed almost throughout, the refusal meant an Art
    // tab that showed a game's art and would change none of it.
    expect(encodeSpriteRefusal(DRAW_FLAGS.compressed)).toBeNull();
    expect(encodeSpriteRefusal(DRAW_FLAGS.compressedFlip)).toBeNull();
  });

  it('refuses an image drawn through a mask, whose pixels are half the picture', () => {
    expect(encodeSpriteRefusal(DRAW_FLAGS.masked)).toMatch(/mask/);
  });
});

/**
 * The compressed form, round-tripped.
 *
 * Asserted as a *picture* rather than as bytes throughout, because the form has
 * many valid encodings of one image — so "the bytes match" is neither necessary
 * nor sufficient, and the only question that matters is whether decoding what
 * was written gives back what went in.
 */
describe('packing a bitmap into the compressed sprite form', () => {
  function roundTrip(pixels: readonly number[], widthBytes: number, height: number): number[] {
    const source = {
      width: widthBytes * 2,
      height,
      pixels: Uint8Array.from(pixels),
    };
    const encoded = encodeCompressedSprite(source, widthBytes, height);
    return [...decodeCompressedSprite(encoded, widthBytes, height, { opaque: true }).pixels];
  }

  it('round-trips a flat image, which is one repeat run', () => {
    const flat = Array.from({ length: 16 }, () => 7);
    expect(roundTrip(flat, 4, 2)).toEqual(flat);
  });

  it('round-trips an image with no two neighbours alike, which is all literals', () => {
    const noisy = Array.from({ length: 16 }, (_, at) => at % 16);
    expect(roundTrip(noisy, 4, 2)).toEqual(noisy);
  });

  it('round-trips runs that cross a column boundary, which is the whole difficulty', () => {
    // A column is a fixed number of bytes but a run may end mid-column and
    // carry into the next one. An encoder that restarted per column would pass
    // every other test here and fail this one.
    const pixels = Array.from({ length: 6 * 2 * 4 }, () => 5);
    pixels[0] = 1;
    pixels[pixels.length - 1] = 2;
    expect(roundTrip(pixels, 6, 4)).toEqual(pixels);
  });

  it('round-trips a run longer than one control word can carry', () => {
    // A repeat holds 128 bytes and a literal 127, so anything longer has to be
    // split — and a split that loses a byte is invisible until it is decoded.
    const long = Array.from({ length: 8 * 2 * 40 }, () => 9);
    expect(roundTrip(long, 8, 40)).toEqual(long);
  });

  it('round-trips more than 127 literals in a row', () => {
    const pixels = Array.from({ length: 8 * 2 * 40 }, (_, at) => at % 15);
    expect(roundTrip(pixels, 8, 40)).toEqual(pixels);
  });

  it('reports how many bytes an encoding occupies, which the entry never says', () => {
    const source = {
      width: 4,
      height: 2,
      pixels: Uint8Array.from([1, 1, 1, 1, 1, 1, 1, 1]),
    };
    const encoded = encodeCompressedSprite(source, 2, 2);

    expect(compressedSpriteLength(encoded, 2, 2)).toBe(encoded.length);
  });

  it('refuses a colour that does not fit four bits rather than masking it', () => {
    const source = { width: 2, height: 1, pixels: Uint8Array.from([16, 0]) };

    expect(() => encodeCompressedSprite(source, 1, 1)).toThrow(/four bits/);
  });

  it('refuses a bitmap of the wrong shape', () => {
    const source = { width: 4, height: 1, pixels: Uint8Array.from([0, 0, 0, 0]) };

    expect(() => encodeCompressedSprite(source, 4, 1)).toThrow(/holds 8 pixels/);
  });
});
