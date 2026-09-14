/**
 * The inverses of `sword2Decode.ts`: pixels back into Broken Sword II's formats.
 *
 * Held to the same bar as `sword1/gfx/swordEncode.ts` — re-encoding a shipped
 * frame must produce the byte-identical original, and `npm run sweep:sword`
 * counts it — and the rules below are what the measurement turned up. Against
 * the PC demo it is 14085 of 14088 sprite frames and 17 of 17 parallax layers,
 * and the three exceptions are ties in the format rather than wrong pixels:
 * they decode identically.
 *
 * ## There are two encoders here, and the frame picks between them
 *
 * `Sword2FrameType.FAST_256` is not a variation on RLE256, it is a different
 * writer for the same reader:
 *
 * - **With the bit**: blocks are **clipped to the row**. A block never spans
 *   the end of a line, so the encoder restarts at every `width`. Its run
 *   threshold is two, colour zero is *always* written flat however short its
 *   run, and a trailing empty literal header is written at the end of a row
 *   that finishes on a flat block.
 *
 *   The rule that took longest to see: run detection **crosses the row
 *   boundary** while the block it emits does not. A row's final pixel becomes a
 *   flat block of one exactly when the next row starts with the same colour —
 *   which reads like a special case for row-final pixels and is really one
 *   unclipped `while` feeding one clipped `min`.
 *
 * - **Without it** (and for every RLE16 frame): the blocks run the length of
 *   the frame, ignoring rows, and the scheme is *the one Broken Sword uses for
 *   its `"JIM "` frames*. Not similar to it — the same, which is why
 *   `compressTony` is imported rather than copied. ADR 0036's rule is that
 *   these families share no record, no edit function and no editor; they share
 *   `swordAudio.ts` already, on the ground that sharing a codec is not sharing
 *   an engine, and a run-length loop with no state is the same case.
 *
 *   The threshold differs because the *cost* of a literal differs. RLE256
 *   spends a byte per literal pixel, so a run pays for its two-byte header at
 *   four; RLE16 packs two literals into a byte, so it does not pay until seven.
 *
 * ## Parallax rows are a third scheme again
 *
 * A row is a packet count, a start column, then alternating literal and skip
 * packets — and two numbers in it are not 255. **Both a literal and a skip cap
 * at 252**, split by a zero-length packet of the other kind, which is what the
 * decoder's "a zero-length literal is how a row that begins with a gap starts
 * on the skip instead" is really for. And a run of transparency becomes a skip
 * at **two** pixels, which is the point where the two encodings cost the same
 * rather than the point where skipping starts to save: a skip spends a byte on
 * itself and a byte on the literal length that restarts after it, so two zeros
 * are a tie and the original breaks the tie towards the skip. Measured on the
 * demo's seventeen layers, breaking at one zero gets 8 of them byte-identical
 * and breaking at three gets 9; breaking at two gets all 17.
 *
 * A row with no transparent pixel at all is written as `packets = 0` and
 * `width` raw bytes, which is what every background row is.
 *
 * ## The colour table is inverted lowest-index-first
 *
 * RLE16's sixteen-entry table can hold the same colour twice, so mapping a
 * colour back to an index is a choice. Building the map from index 15 down to 0
 * leaves the lowest index winning, and that is what the original wrote — the
 * one frame where it does not is `219`'s frame 37, whose table repeats a colour
 * and whose two encodings decode alike.
 */

import { compressTony, pushLiterals } from '../../sword1/gfx/swordEncode.js';
import { Sword2FrameType } from '../resource/sword2Headers.js';

/** Raised when pixels cannot be written in the format asked for. */
export class Sword2EncodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Sword2EncodeError';
  }
}

/** Colour to four-bit index, lowest index winning a repeated colour. */
export function invertSword2ColourTable(table: Uint8Array): Map<number, number> {
  const map = new Map<number, number>();
  for (let index = Math.min(15, table.length - 1); index >= 0; index--) {
    map.set(table[index], index);
  }
  return map;
}

/** How long the run of equal bytes starting at `at` is, rows ignored. */
function runLength(pixels: Uint8Array, at: number): number {
  const value = pixels[at];
  let length = 1;
  while (at + length < pixels.length && pixels[at + length] === value) length++;
  return length;
}

/**
 * The row-clipped writer, which is what `FAST_256` frames are written with.
 *
 * `nibble` is here because the shape admits it, not because a frame uses it:
 * the flag and RLE16 do not co-occur in either demo.
 */
export function compressSword2Rows(
  pixels: Uint8Array,
  width: number,
  height: number,
  options: {
    readonly threshold?: number;
    readonly nibble?: ((value: number) => number) | null;
    readonly highNibbleFirst?: boolean;
  } = {},
): Uint8Array {
  const threshold = options.threshold ?? 2;
  const nibble = options.nibble ?? null;
  const highNibbleFirst = options.highNibbleFirst ?? true;
  const out: number[] = [];
  // Transparency is flat whatever its run length: a lone zero costs two bytes
  // as a flat block and two as a literal block, and the original spent them on
  // the flat one.
  const flatten = (at: number): boolean => pixels[at] === 0 || runLength(pixels, at) >= threshold;

  for (let row = 0; row < height; row++) {
    const rowEnd = Math.min((row + 1) * width, pixels.length);
    let at = row * width;
    while (at < rowEnd) {
      if (flatten(at)) {
        const flat = Math.min(runLength(pixels, at), 255, rowEnd - at);
        out.push(flat, pixels[at]);
        at += flat;
      } else {
        out.push(0);
      }
      const start = at;
      while (at < rowEnd && at - start < 255 && !flatten(at)) at++;
      pushLiterals(out, pixels, start, at, nibble, highNibbleFirst);
    }
  }
  return Uint8Array.from(out);
}

/**
 * Writes one frame's pixels back.
 *
 * `compression` is the animation header's `runTimeComp` — 0 raw, 1 RLE256, 2
 * RLE16 — and `frameType` is the CDT entry's, whose `FAST_256` bit overrides
 * the first two the same way the decoder's does.
 */
export function encodeSword2Frame(
  pixels: Uint8Array,
  width: number,
  height: number,
  compression: number,
  frameType = 0,
  colourTable?: Uint8Array,
): Uint8Array {
  if (compression === 0) return Uint8Array.from(pixels);
  if ((frameType & Sword2FrameType.FAST_256) !== 0) {
    return compressSword2Rows(pixels, width, height);
  }
  if (compression === 2) {
    if (!colourTable) {
      throw new Sword2EncodeError('an RLE16 frame cannot be written without its colour table');
    }
    const map = invertSword2ColourTable(colourTable);
    for (const value of pixels) {
      if (!map.has(value)) {
        throw new Sword2EncodeError(
          `colour ${value} is not in this animation’s sixteen-entry table, so the frame ` +
            `cannot be written as RLE16`,
        );
      }
    }
    return compressTony(pixels, { threshold: 7, nibble: (value) => map.get(value) ?? 0 });
  }
  return compressTony(pixels, { threshold: 4 });
}

/** The cap on a parallax literal or skip. Not 255, and the difference shows. */
const PARALLAX_PACKET_MAX = 252;

/**
 * The run of transparency at which a skip becomes cheaper than literals.
 *
 * A skip spends one byte on itself and one on the literal length that has to
 * follow it, so two transparent pixels cost the same either way — and the
 * original resolves that tie towards the skip, which is why this is two and
 * not three.
 */
const PARALLAX_SKIP_THRESHOLD = 2;

/** One parallax row, or null for a row with nothing on it. */
export function compressSword2ParallaxRow(pixels: Uint8Array): Uint8Array | null {
  const width = pixels.length;
  let first = -1;
  let last = -1;
  let transparent = false;
  for (let at = 0; at < width; at++) {
    if (pixels[at] === 0) transparent = true;
    else {
      if (first < 0) first = at;
      last = at;
    }
  }
  if (first < 0) return null;

  // A row with nothing to skip is written flat, which is what a background is.
  if (!transparent) {
    const raw = new Uint8Array(4 + width);
    new DataView(raw.buffer).setUint16(0, 0, true);
    raw.set(pixels, 4);
    return raw;
  }

  const zeroRun = (at: number): number => {
    let run = 0;
    while (at + run <= last && pixels[at + run] === 0) run++;
    return run;
  };

  const body: number[] = [];
  let packets = 0;
  let at = first;
  let literal = true;
  while (at <= last) {
    if (literal) {
      let count = 0;
      while (at + count <= last && count < PARALLAX_PACKET_MAX) {
        if (pixels[at + count] === 0 && zeroRun(at + count) >= PARALLAX_SKIP_THRESHOLD) break;
        count++;
      }
      body.push(count);
      for (let pixel = 0; pixel < count; pixel++) body.push(pixels[at + pixel]);
      at += count;
    } else {
      let count = 0;
      while (at + count <= last && pixels[at + count] === 0 && count < PARALLAX_PACKET_MAX) count++;
      body.push(count);
      at += count;
    }
    packets++;
    literal = !literal;
  }

  const out = new Uint8Array(4 + body.length);
  const view = new DataView(out.buffer);
  view.setUint16(0, packets, true);
  view.setUint16(2, first, true);
  out.set(Uint8Array.from(body), 4);
  return out;
}

/** A whole parallax layer: its size, its row table, and its rows. */
export function encodeSword2Parallax(
  pixels: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const rows = Array.from({ length: height }, (_, row) =>
    compressSword2ParallaxRow(pixels.subarray(row * width, (row + 1) * width)),
  );
  let offset = 4 + height * 4;
  const offsets: number[] = [];
  for (const row of rows) {
    if (!row) {
      offsets.push(0);
      continue;
    }
    offsets.push(offset);
    offset += row.length;
  }

  const out = new Uint8Array(offset);
  const view = new DataView(out.buffer);
  view.setUint16(0, width, true);
  view.setUint16(2, height, true);
  for (let row = 0; row < height; row++) view.setUint32(4 + row * 4, offsets[row], true);
  let to = 4 + height * 4;
  for (const row of rows) {
    if (!row) continue;
    out.set(row, to);
    to += row.length;
  }
  return out;
}
