import { createImage, TRANSPARENT_INDEX, type IndexedImage } from '../authoring/ImageEncoder.js';
import { defaultPalette, nearestColor } from '../authoring/palette.js';

/**
 * Bringing outside artwork into a game.
 *
 * SCUMM is palette-indexed: every pixel is a number 0-255 into a 256 colour
 * table. A PNG is not, so importing means choosing, for each pixel, the closest
 * available colour — and living with the error that introduces.
 *
 * The decoding half is browser-only (it needs a canvas), so it is kept separate
 * from the quantisation, which is pure and testable.
 */

export interface RgbaImage {
  width: number;
  height: number;
  /** Four bytes per pixel. */
  data: Uint8ClampedArray;
}

export type FitMode = 'stretch' | 'contain' | 'cover' | 'none';

export interface ImportOptions {
  /** Target size. Omit to keep the source size. */
  width?: number;
  height?: number;
  fit?: FitMode;
  /** Spreads quantisation error into neighbouring pixels. */
  dither?: boolean;
  /** Palette to quantise against. Defaults to the game palette. */
  palette?: number[][];
  /**
   * Alpha at or below which a pixel becomes transparent.
   *
   * Only meaningful for object art; a room background has no transparency, so
   * leave it at 0 there and every pixel gets a colour.
   */
  alphaThreshold?: number;
}

/**
 * Decodes an image file to raw pixels, scaled to fit.
 *
 * Uses the browser's own decoder, so whatever it supports — PNG, JPEG, GIF,
 * WebP, AVIF — works without shipping a decoder of our own.
 */
export async function decodeImageFile(
  file: File | Blob,
  options: ImportOptions = {},
): Promise<RgbaImage> {
  const bitmap = await createImageBitmap(file);

  const targetWidth = options.width ?? bitmap.width;
  const targetHeight = options.height ?? bitmap.height;
  const fit = options.fit ?? 'contain';

  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;

  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Canvas 2D is unavailable');

  // Nearest-neighbour: pixel art scaled smoothly turns to mush, and a
  // photograph is going to be quantised to 256 colours regardless.
  context.imageSmoothingEnabled = false;

  const placement = computePlacement(bitmap.width, bitmap.height, targetWidth, targetHeight, fit);
  context.drawImage(bitmap, placement.x, placement.y, placement.width, placement.height);
  bitmap.close();

  const imageData = context.getImageData(0, 0, targetWidth, targetHeight);
  return { width: targetWidth, height: targetHeight, data: imageData.data };
}

/** Where the source lands inside the target, for each fit mode. */
export function computePlacement(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
  fit: FitMode,
): { x: number; y: number; width: number; height: number } {
  if (fit === 'stretch') {
    return { x: 0, y: 0, width: targetWidth, height: targetHeight };
  }
  if (fit === 'none') {
    return { x: 0, y: 0, width: sourceWidth, height: sourceHeight };
  }

  const scaleX = targetWidth / sourceWidth;
  const scaleY = targetHeight / sourceHeight;
  // `contain` fits the whole image inside; `cover` fills and overflows.
  const scale = fit === 'cover' ? Math.max(scaleX, scaleY) : Math.min(scaleX, scaleY);

  const width = Math.round(sourceWidth * scale);
  const height = Math.round(sourceHeight * scale);
  return {
    x: Math.round((targetWidth - width) / 2),
    y: Math.round((targetHeight - height) / 2),
    width,
    height,
  };
}

/**
 * Maps true-colour pixels onto palette indices.
 *
 * With dithering on, the error from each choice is pushed into the neighbours
 * that have not been decided yet (Floyd-Steinberg). That trades hard banding —
 * very visible on skies and gradients — for a fine stipple, which is what the
 * original artists did by hand.
 */
export function quantise(source: RgbaImage, options: ImportOptions = {}): IndexedImage {
  const palette = options.palette ?? defaultPalette();
  const alphaThreshold = options.alphaThreshold ?? 0;
  const out = createImage(source.width, source.height, 0);

  // A working copy in floats, so accumulated error does not clip at each step.
  const working = new Float32Array(source.width * source.height * 3);
  for (let i = 0, j = 0; i < source.data.length; i += 4, j += 3) {
    working[j] = source.data[i];
    working[j + 1] = source.data[i + 1];
    working[j + 2] = source.data[i + 2];
  }

  // Repeated nearest-colour searches over a 256 entry palette dominate the
  // cost, and photographs reuse colours heavily, so results are cached.
  const cache = new Map<number, number>();

  for (let y = 0; y < source.height; y++) {
    for (let x = 0; x < source.width; x++) {
      const pixel = y * source.width + x;

      if (alphaThreshold > 0 && source.data[pixel * 4 + 3] <= alphaThreshold) {
        out.pixels[pixel] = TRANSPARENT_INDEX;
        continue;
      }

      const base = pixel * 3;
      const r = clamp255(working[base]);
      const g = clamp255(working[base + 1]);
      const b = clamp255(working[base + 2]);

      const key = (r << 16) | (g << 8) | b;
      let index = cache.get(key);
      if (index === undefined) {
        index = nearestColor(palette, r, g, b);
        cache.set(key, index);
      }
      out.pixels[pixel] = index;

      if (!options.dither) continue;

      const chosen = palette[index] ?? [0, 0, 0];
      const errorR = r - chosen[0];
      const errorG = g - chosen[1];
      const errorB = b - chosen[2];

      // Floyd-Steinberg weights: 7/16 right, 3/16 below-left, 5/16 below,
      // 1/16 below-right.
      spread(working, source, x + 1, y, errorR, errorG, errorB, 7 / 16);
      spread(working, source, x - 1, y + 1, errorR, errorG, errorB, 3 / 16);
      spread(working, source, x, y + 1, errorR, errorG, errorB, 5 / 16);
      spread(working, source, x + 1, y + 1, errorR, errorG, errorB, 1 / 16);
    }
  }

  return out;
}

function spread(
  working: Float32Array,
  source: RgbaImage,
  x: number,
  y: number,
  errorR: number,
  errorG: number,
  errorB: number,
  weight: number,
): void {
  if (x < 0 || y < 0 || x >= source.width || y >= source.height) return;
  const base = (y * source.width + x) * 3;
  working[base] += errorR * weight;
  working[base + 1] += errorG * weight;
  working[base + 2] += errorB * weight;
}

function clamp255(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

/** Decodes and quantises in one step. */
export async function importImage(
  file: File | Blob,
  options: ImportOptions = {},
): Promise<IndexedImage> {
  return quantise(await decodeImageFile(file, options), options);
}

/** Opens a file picker and returns the chosen file, or null if cancelled. */
export function pickImageFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null));
    // A cancelled picker fires no event in most browsers, so the promise is
    // resolved by the window regaining focus instead of hanging forever.
    window.addEventListener(
      'focus',
      () => setTimeout(() => resolve(input.files?.[0] ?? null), 300),
      { once: true },
    );
    input.click();
  });
}

/**
 * Imports a picture as a costume cel.
 *
 * A costume does not index the game palette directly: it has its own table of
 * up to 31 colours, and pixels index that. So an import has to choose which
 * colours the costume should hold as well as which one each pixel gets.
 *
 * The colours are picked by frequency — the most used first — which keeps the
 * subject's colours and loses the stray ones at the edges of a photograph.
 */
export interface CostumeImport {
  /** Pixels as costume colour indices; 0 is transparent. */
  image: IndexedImage;
  /** Game palette index for each costume colour, from slot 1 upwards. */
  palette: number[];
}

export async function importCostumeCel(
  file: File | Blob,
  options: ImportOptions & { maxColors?: number } = {},
): Promise<CostumeImport> {
  const maxColors = Math.max(1, Math.min(31, options.maxColors ?? 31));

  const source = await decodeImageFile(file, { ...options, fit: options.fit ?? 'none' });
  const indexed = quantise(source, { ...options, alphaThreshold: options.alphaThreshold ?? 128 });

  const counts = new Map<number, number>();
  for (const value of indexed.pixels) {
    if (value === TRANSPARENT_INDEX) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  const chosen = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxColors)
    .map(([index]) => index);

  // Anything that did not make the cut maps to the nearest colour that did,
  // rather than disappearing.
  const gamePalette = options.palette ?? defaultPalette();
  const chosenRgb = chosen.map((index) => gamePalette[index] ?? [0, 0, 0]);
  const remap = new Map<number, number>();
  for (const [index] of counts) {
    const slot = chosen.indexOf(index);
    if (slot >= 0) {
      remap.set(index, slot + 1);
      continue;
    }
    const [r, g, b] = gamePalette[index] ?? [0, 0, 0];
    remap.set(index, nearestColor(chosenRgb, r, g, b) + 1);
  }

  const image = createImage(indexed.width, indexed.height, 0);
  for (let i = 0; i < indexed.pixels.length; i++) {
    const value = indexed.pixels[i];
    image.pixels[i] = value === TRANSPARENT_INDEX ? 0 : (remap.get(value) ?? 0);
  }

  return { image, palette: chosen };
}
