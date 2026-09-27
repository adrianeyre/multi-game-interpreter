/**
 * BOMP images: run-length encoded, one line at a time.
 *
 * AKOS uses this for its codec 5 cels, and v6 on for the `BOMP` images a
 * script can stamp over the frame; both are drawn through {@link drawBomp}. It is a different encoding from the strip
 * codecs `BitmapCodec` handles for room backgrounds — those are column-major
 * and bit-packed; this is row-major and byte-oriented.
 *
 * Each line is a little-endian 16-bit byte count followed by that many bytes of
 * control stream. The count exists so a reader can find the next line without
 * decoding this one: decoding itself is driven by the output width, not by the
 * input length. That distinction matters — a decoder that stops when the input
 * runs out rather than when the line is full produces silently short lines on
 * any image whose last run is clipped.
 *
 * Within a line each control byte carries a count in its top seven bits, biased
 * by one, and a mode in bit 0:
 *
 *     code & 1        a run: the next byte repeats (code >> 1) + 1 times
 *     !(code & 1)     a literal: the next (code >> 1) + 1 bytes are pixels
 *
 * so a count is 1..128 and never zero, which is what stops a malformed stream
 * looping.
 */

import type { Screen } from '../Screen.js';
import { BIG_COSTUME_SCALE_TABLE } from '../scaleTable.js';
import { shadePixel, type ShadowRule } from '../ShadowPalette.js';

/**
 * Decodes one BOMP line into `out`, which must be `width` long.
 *
 * By default colour 0 is transparent: a run of it advances without writing, and
 * a literal writes only its non-zero bytes, so whatever is already in `out`
 * shows through. That is how a costume is drawn over a room rather than as a
 * rectangle of background.
 *
 * `writeZeros` writes them instead, which is what a blast object wants. The
 * encoding says nothing about transparency either way — it is the caller that
 * decides which index shows through, and the two callers disagree: a costume
 * cel treats 0 as transparent, while an object blasted over the frame treats
 * 255 as transparent and 0 as a colour to paint. (`bompDecodeLine`'s `setZero`
 * in ScummVM's `bomp.cpp`, which defaults to true and is left at that by both
 * `decompressBomp` and `drawBomp`.)
 */
export function decodeBompLine(
  source: Uint8Array,
  at: number,
  out: Uint8Array,
  width: number,
  writeZeros = false,
): void {
  let remaining = width;
  let read = at;
  let write = 0;

  while (remaining > 0 && read < source.length) {
    const code = source[read++];
    const count = Math.min((code >> 1) + 1, remaining);
    remaining -= count;

    if (code & 1) {
      const color = source[read++];
      if (writeZeros || color !== 0) out.fill(color, write, write + count);
      write += count;
    } else {
      for (let i = 0; i < count; i++) {
        const color = source[read + i];
        if (writeZeros || color !== 0) out[write + i] = color;
      }
      read += count;
      write += count;
    }
  }
}

/**
 * Decodes a whole BOMP image to one byte per pixel, row-major.
 *
 * Zero means transparent in the result, as it does in the stream, unless
 * `writeZeros` says to paint it — see {@link decodeBompLine} for which caller
 * wants which.
 */
export function decodeBomp(
  source: Uint8Array,
  width: number,
  height: number,
  writeZeros = false,
): Uint8Array {
  const out = new Uint8Array(width * height);
  let at = 0;

  for (let y = 0; y < height; y++) {
    if (at + 2 > source.length) break;
    const lineLength = source[at] | (source[at + 1] << 8);
    decodeBompLine(source, at + 2, out.subarray(y * width, (y + 1) * width), width, writeZeros);
    at += lineLength + 2;
  }

  return out;
}

/**
 * Which rows or columns of a BOMP survive at a given scale.
 *
 * Scaling a blast object is done by dropping rows and columns, not by
 * resampling, and which ones go is decided by comparing the scale against an
 * ordered dither — so a half-size picture keeps every other pixel in a spread
 * pattern rather than losing one half of itself. The survivors close up against
 * the picture's top-left corner. The window into the table starts at
 * `256 - size / 2`, which is what makes a tall image drop from the same pattern
 * as a short one rather than from a different part of it.
 *
 * The result is one entry per index, `true` for a row or column that is drawn.
 *
 * Two things the original does are deliberately not here. It reads the table
 * eight entries at a time and returns a count of the survivors among all of
 * them, which for a size that is not a multiple of eight includes up to seven
 * indices past the end of the picture; it then corrects exactly one of those
 * and clips the drawing to the count. Since the count can only come out at or
 * above the number of real survivors, clipping to it either does nothing or
 * blits the uninitialised tail of its line buffer — so neither the count nor
 * the correction to it is reproduced, and the drawing stops at the last row and
 * column this says to keep. (`setupBompScale` in ScummVM's `bomp.cpp`.)
 */
export function bompScaleMask(size: number, scale: number): boolean[] {
  // The original reads its eight entries in this order within each group,
  // which is a byte-order artefact of the assembly it was translated from.
  const offsets = [3, 2, 1, 0, 7, 6, 5, 4];
  const start = 256 - (size >> 1);
  const groups = Math.ceil(size / 8);
  const masks = new Uint8Array(groups);

  for (let group = 0; group < groups; group++) {
    let mask = 0;
    for (let i = 0; i < 8; i++) {
      mask <<= 1;
      if (scale < BIG_COSTUME_SCALE_TABLE[start + group * 8 + offsets[i]]) mask |= 1;
    }
    masks[group] = mask;
  }

  const kept: boolean[] = [];
  for (let index = 0; index < size; index++) {
    kept.push((masks[index >> 3] & (0x80 >> (index & 7))) === 0);
  }
  return kept;
}

/**
 * The colour a BOMP draw treats as transparent.
 *
 * Not zero, which is what the byte-RLE costume codecs use: `drawBomp` decodes
 * with zeros written and then compares each pixel against 255 on its way to
 * the screen. Getting this the wrong way round leaves a black rectangle behind
 * the picture and drops whatever the artwork drew in white.
 */
export const BOMP_TRANSPARENT = 255;

/** A decoded BOMP picture: row-major, one byte per pixel, 255 transparent. */
export interface BompImage {
  pixels: Uint8Array;
  width: number;
  height: number;
}

export interface BompDrawOptions {
  /** Screen position of the picture's top-left corner. */
  x: number;
  y: number;
  /** 1..255 per axis, 255 meaning full size. */
  scaleX?: number;
  scaleY?: number;
  /** Drawn right-to-left, for an AKOS cel facing the other way. */
  mirror?: boolean;
  /**
   * How each pixel is shaded against the screen, or absent to paint it.
   *
   * Only modes 0, 1 and 3 exist here — `bompApplyShadow` errors on any other,
   * so a caller is expected to have settled that before drawing.
   */
  shadow?: ShadowRule;
  /**
   * A colour map applied after scaling and masking (`bompApplyActorPalette`).
   * Index 255 always maps to itself, so a transparent pixel stays one.
   */
  actorPalette?: Uint8Array;
  /** Whether the room's z-plane hides the screen pixel at (x, y). */
  isMasked?: (x: number, y: number) => boolean;
  /** Clipping band in screen rows. */
  clipTop?: number;
  clipBottom?: number;
}

/**
 * Draws a BOMP picture to the screen (`drawBomp`).
 *
 * One routine for every BOMP draw the engine makes — AKOS codec 5 cels, the
 * run-major codec 16's lines, and blast objects — because the reference has
 * one, and the order of its steps is part of the result. For each line:
 *
 * 1. the line is taken, reversed if mirrored (`bompDecodeLineReverse`);
 * 2. rows and then columns the scale drops are removed, and the survivors
 *    close up against the top-left (`setupBompScale`, `bompScaleFuncX`);
 * 3. pixels a z-plane hides become transparent (`bompApplyMask`);
 * 4. the actor palette is applied (`bompApplyActorPalette`);
 * 5. what is left is painted or shaded against the screen
 *    (`bompApplyShadow`).
 *
 * So scaling and shading compose here exactly as they do in the original:
 * a scaled picture shades pixel for pixel like a full-size one. Whether a
 * caller *asks* for both is its own business — `drawBlastObject` does not.
 */
export function drawBomp(screen: Screen, image: BompImage, options: BompDrawOptions): void {
  const { pixels, width, height } = image;
  const {
    x,
    y,
    scaleX = 255,
    scaleY = 255,
    mirror = false,
    shadow,
    actorPalette,
    isMasked,
    clipTop = 0,
    clipBottom = screen.height,
  } = options;

  const columns = scaleX === 255 ? null : bompScaleMask(width, scaleX);
  const rows = scaleY === 255 ? null : bompScaleMask(height, scaleY);
  const shading = shadow && shadow.mode !== 0 ? shadow : undefined;

  let destRow = 0;
  for (let row = 0; row < height; row++) {
    if (rows && !rows[row]) continue;
    const destY = y + destRow++;
    if (destY < clipTop || destY >= clipBottom) continue;

    const line = row * width;
    let destColumn = 0;
    for (let column = 0; column < width; column++) {
      if (columns && !columns[column]) continue;
      const destX = x + destColumn++;

      let colour = pixels[line + (mirror ? width - 1 - column : column)];
      if (isMasked?.(destX, destY)) colour = BOMP_TRANSPARENT;
      if (actorPalette && colour !== BOMP_TRANSPARENT) colour = actorPalette[colour];
      if (colour === BOMP_TRANSPARENT) continue;

      if (shading) colour = shadePixel(shading, colour, screen.getPixel(destX, destY)).colour;
      screen.putPixel(destX, destY, colour);
    }
  }
}
