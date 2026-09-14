import { createImage, type IndexedImage } from './ImageEncoder.js';

/**
 * Drawing helpers for authored art.
 *
 * A game needs pixels before it needs anything else, and requiring an external
 * paint program to see a first room would put the whole toolchain behind a
 * dependency. These cover enough to build real scenes, and pixel art can be
 * written inline as text.
 */

export { createImage };
export type { IndexedImage };

export function fill(image: IndexedImage, color: number): IndexedImage {
  image.pixels.fill(color);
  return image;
}

export function rect(
  image: IndexedImage,
  x: number,
  y: number,
  width: number,
  height: number,
  color: number,
): IndexedImage {
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(image.width, x + width);
  const y1 = Math.min(image.height, y + height);
  for (let row = y0; row < y1; row++) {
    image.pixels.fill(color, row * image.width + x0, row * image.width + x1);
  }
  return image;
}

export function outline(
  image: IndexedImage,
  x: number,
  y: number,
  width: number,
  height: number,
  color: number,
): IndexedImage {
  rect(image, x, y, width, 1, color);
  rect(image, x, y + height - 1, width, 1, color);
  rect(image, x, y, 1, height, color);
  rect(image, x + width - 1, y, 1, height, color);
  return image;
}

/** A vertical gradient between two palette indices, useful for skies. */
export function verticalGradient(
  image: IndexedImage,
  y: number,
  height: number,
  fromColor: number,
  toColor: number,
): IndexedImage {
  for (let row = 0; row < height; row++) {
    const t = height <= 1 ? 0 : row / (height - 1);
    const color = Math.round(fromColor + (toColor - fromColor) * t);
    rect(image, 0, y + row, image.width, 1, color);
  }
  return image;
}

export function setPixel(image: IndexedImage, x: number, y: number, color: number): void {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;
  image.pixels[y * image.width + x] = color;
}

export function getPixel(image: IndexedImage, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return 0;
  return image.pixels[y * image.width + x];
}

/** Copies `source` onto `target`, skipping pixels equal to `transparent`. */
export function blit(
  target: IndexedImage,
  source: IndexedImage,
  x: number,
  y: number,
  transparent = 0,
): IndexedImage {
  for (let row = 0; row < source.height; row++) {
    for (let column = 0; column < source.width; column++) {
      const color = source.pixels[row * source.width + column];
      if (color === transparent) continue;
      setPixel(target, x + column, y + row, color);
    }
  }
  return target;
}

/**
 * Builds an image from text art.
 *
 * Each line is a row; each character maps to a palette index through `key`.
 * Characters missing from the key become 0, which is transparent in costumes.
 *
 * ```ts
 * const lamp = pixels(
 *   `
 *   .###.
 *   #...#
 *   .###.
 *   `,
 *   { '#': 14, '.': 0 },
 * );
 * ```
 */
export function pixels(art: string, key: Record<string, number>): IndexedImage {
  const lines = art
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) return createImage(1, 1, 0);

  const width = Math.max(...lines.map((line) => line.length));
  const image = createImage(width, lines.length, 0);

  for (let row = 0; row < lines.length; row++) {
    const line = lines[row];
    for (let column = 0; column < line.length; column++) {
      image.pixels[row * width + column] = key[line[column]] ?? 0;
    }
  }

  return image;
}

/**
 * Builds a 1-bit occlusion mask from text art, for scenery actors walk behind.
 *
 * Any character other than `.` or a space marks an occluding pixel.
 */
export function mask(art: string, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  const lines = art
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (let row = 0; row < Math.min(lines.length, height); row++) {
    const line = lines[row];
    for (let column = 0; column < Math.min(line.length, width); column++) {
      const character = line[column];
      if (character !== '.' && character !== ' ') out[row * width + column] = 1;
    }
  }
  return out;
}

/** A rectangular occlusion mask, the common case. */
export function maskRect(
  width: number,
  height: number,
  regions: Array<{ x: number; y: number; width: number; height: number }>,
): Uint8Array {
  const out = new Uint8Array(width * height);
  for (const region of regions) {
    for (let row = region.y; row < region.y + region.height; row++) {
      if (row < 0 || row >= height) continue;
      for (let column = region.x; column < region.x + region.width; column++) {
        if (column < 0 || column >= width) continue;
        out[row * width + column] = 1;
      }
    }
  }
  return out;
}

/** Scatters `count` pixels of `color` deterministically, for texture. */
export function speckle(
  image: IndexedImage,
  x: number,
  y: number,
  width: number,
  height: number,
  color: number,
  count: number,
  seed = 1,
): IndexedImage {
  // A small xorshift keeps builds reproducible; Math.random would make every
  // compile produce a different file.
  let state = seed >>> 0 || 1;
  const next = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0xffffffff;
  };

  for (let i = 0; i < count; i++) {
    setPixel(image, x + Math.floor(next() * width), y + Math.floor(next() * height), color);
  }
  return image;
}
