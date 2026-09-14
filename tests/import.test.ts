import { describe, expect, it } from 'vitest';
import { computePlacement, quantise, type RgbaImage } from '../src/editor/importImage.js';
import {
  TRANSPARENT_INDEX,
  createImage,
  encodeObjectImages,
  encodeSmap,
} from '../src/authoring/ImageEncoder.js';
import { defaultPalette } from '../src/authoring/palette.js';
import { decodeStrip } from '../src/engine/gfx/BitmapCodec.js';
import { readChunkHeader } from '../src/engine/resource/Chunk.js';

/** Builds an RGBA buffer from a per-pixel colour function. */
function rgba(
  width: number,
  height: number,
  at: (x: number, y: number) => [number, number, number, number],
): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = at(x, y);
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  return { width, height, data };
}

describe('fit modes', () => {
  it('stretches to exactly fill the target', () => {
    expect(computePlacement(100, 50, 320, 144, 'stretch')).toEqual({
      x: 0,
      y: 0,
      width: 320,
      height: 144,
    });
  });

  it('keeps the original size when asked not to scale', () => {
    expect(computePlacement(100, 50, 320, 144, 'none')).toEqual({
      x: 0,
      y: 0,
      width: 100,
      height: 50,
    });
  });

  it('fits the whole image inside, centred, preserving the aspect ratio', () => {
    const placement = computePlacement(100, 100, 320, 144, 'contain');
    expect(placement.width).toBe(144);
    expect(placement.height).toBe(144);
    expect(placement.width / placement.height).toBeCloseTo(1);
    // Centred horizontally, flush vertically.
    expect(placement.x).toBe(88);
    expect(placement.y).toBe(0);
  });

  it('fills the target when covering, overflowing the long axis', () => {
    const placement = computePlacement(100, 100, 320, 144, 'cover');
    expect(placement.width).toBe(320);
    expect(placement.height).toBe(320);
    // Overflow is split evenly, so the middle of the image is kept.
    expect(placement.y).toBeLessThan(0);
  });
});

describe('quantisation', () => {
  const palette = defaultPalette();

  it('maps an exact palette colour to its own index', () => {
    // Palette entry 12 is bright red (255, 85, 85).
    const source = rgba(2, 2, () => [255, 85, 85, 255]);
    const result = quantise(source, { palette });
    expect([...result.pixels]).toEqual([12, 12, 12, 12]);
  });

  it('maps a near miss to the closest entry', () => {
    const source = rgba(1, 1, () => [254, 84, 86, 255]);
    expect(quantise(source, { palette }).pixels[0]).toBe(12);
  });

  it('keeps the image dimensions', () => {
    const result = quantise(
      rgba(7, 3, () => [0, 0, 0, 255]),
      { palette },
    );
    expect(result.width).toBe(7);
    expect(result.height).toBe(3);
  });

  it('leaves transparent pixels transparent when a threshold is set', () => {
    const source = rgba(2, 1, (x) => (x === 0 ? [255, 0, 0, 0] : [255, 0, 0, 255]));
    const result = quantise(source, { palette, alphaThreshold: 128 });
    expect(result.pixels[0]).toBe(TRANSPARENT_INDEX);
    expect(result.pixels[1]).not.toBe(TRANSPARENT_INDEX);
  });

  it('ignores alpha entirely when no threshold is set', () => {
    // Room backgrounds have no transparency, so every pixel must get a colour.
    const source = rgba(1, 1, () => [255, 85, 85, 0]);
    expect(quantise(source, { palette }).pixels[0]).toBe(12);
  });

  it('mixes neighbouring palette entries to approximate a colour it lacks', () => {
    // (25, 25, 25) falls between two palette entries and matches neither. Flat
    // quantisation snaps every pixel to the same wrong colour; dithering mixes
    // two entries so the area averages out closer to the intended shade.
    const source = rgba(16, 16, () => [25, 25, 25, 255]);

    const flat = new Set(quantise(source, { palette, dither: false }).pixels);
    const dithered = new Set(quantise(source, { palette, dither: true }).pixels);

    expect(flat.size).toBe(1);
    expect(dithered.size).toBeGreaterThan(1);
  });

  it('keeps the dithered average closer to the source than flat quantisation', () => {
    const target = 25;
    const source = rgba(16, 16, () => [target, target, target, 255]);

    const average = (pixels: Uint8Array): number => {
      let total = 0;
      for (const index of pixels) total += palette[index][0];
      return total / pixels.length;
    };

    const flatError = Math.abs(average(quantise(source, { palette }).pixels) - target);
    const ditheredError = Math.abs(
      average(quantise(source, { palette, dither: true }).pixels) - target,
    );
    expect(ditheredError).toBeLessThan(flatError);
  });

  it('does not let dithering push a pixel outside the palette', () => {
    const source = rgba(32, 32, (x, y) => [x * 8, y * 8, 128, 255]);
    const result = quantise(source, { palette, dither: true });
    for (const value of result.pixels) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(256);
    }
  });
});

describe('transparent object images', () => {
  it('writes codec 1 for an opaque image', () => {
    const bytes = new Uint8Array(encodeSmap(createImage(8, 2, 5)));
    const offset = bytes[8] | (bytes[9] << 8) | (bytes[10] << 16) | (bytes[11] << 24);
    expect(bytes[offset]).toBe(1);
  });

  it('writes codec 149 when transparency is asked for', () => {
    const bytes = new Uint8Array(encodeSmap(createImage(8, 2, 5), { transparent: true }));
    const offset = bytes[8] | (bytes[9] << 8) | (bytes[10] << 16) | (bytes[11] << 24);
    expect(bytes[offset]).toBe(149);
  });

  it('encodes object states transparently, so they are not opaque rectangles', () => {
    const image = createImage(8, 2, TRANSPARENT_INDEX);
    image.pixels[0] = 14;

    const [state] = encodeObjectImages([image]);
    const bytes = new Uint8Array(state);
    expect(readChunkHeader(bytes, 0).tag).toBe('IM01');

    const smap = bytes.subarray(8);
    const offset = smap[8] | (smap[9] << 8) | (smap[10] << 16) | (smap[11] << 24);

    // Decode over a background and check the transparent pixels survive.
    const destination = new Uint8Array(8 * 2).fill(99);
    decodeStrip(smap, offset, {
      dst: destination,
      dstOffset: 0,
      dstStride: 8,
      height: 2,
      transparentColor: TRANSPARENT_INDEX,
    });

    expect(destination[0]).toBe(14);
    expect(destination[1]).toBe(99);
    expect(destination[9]).toBe(99);
  });
});
