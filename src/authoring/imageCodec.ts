import { fromBase64, toBase64 } from './base64.js';
import { createImage, type IndexedImage } from './ImageEncoder.js';

/**
 * Storage format for images inside a saved project.
 *
 * A 320x144 room is 46 KB of raw indices, and browsers give roughly 5 MB of
 * local storage for everything. Flat-shaded pixel art run-length encodes to a
 * tiny fraction of that, so projects stay well inside the budget and JSON
 * exports stay diffable-ish rather than being one enormous line.
 */
export interface StoredImage {
  width: number;
  height: number;
  /** Base64 of the run-length encoded pixel indices. */
  data: string;
}

/**
 * Run-length encodes as (count, value) pairs with counts capped at 255.
 *
 * Chosen over a smarter scheme because it is obviously correct and its worst
 * case — every pixel different — is only 2x, which even photographic art would
 * survive.
 */
function runLengthEncode(pixels: Uint8Array): Uint8Array {
  const out: number[] = [];
  let index = 0;
  while (index < pixels.length) {
    const value = pixels[index];
    let run = 1;
    while (index + run < pixels.length && pixels[index + run] === value && run < 255) run++;
    out.push(run, value);
    index += run;
  }
  return new Uint8Array(out);
}

function runLengthDecode(data: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected);
  let target = 0;
  for (let i = 0; i + 1 < data.length && target < expected; i += 2) {
    const run = data[i];
    const value = data[i + 1];
    for (let n = 0; n < run && target < expected; n++) out[target++] = value;
  }
  return out;
}

export function storeImage(image: IndexedImage): StoredImage {
  return {
    width: image.width,
    height: image.height,
    data: toBase64(runLengthEncode(image.pixels)),
  };
}

export function loadImage(stored: StoredImage): IndexedImage {
  const image = createImage(stored.width, stored.height, 0);
  image.pixels.set(runLengthDecode(fromBase64(stored.data), image.pixels.length));
  return image;
}

/** Packs a 1-bit mask the same way, for z-planes. */
export function storeMask(mask: Uint8Array, width: number, height: number): StoredImage {
  return { width, height, data: toBase64(runLengthEncode(mask)) };
}

export function loadMask(stored: StoredImage): Uint8Array {
  return runLengthDecode(fromBase64(stored.data), stored.width * stored.height);
}
