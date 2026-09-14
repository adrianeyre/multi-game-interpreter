/**
 * Broken Sword II's mouse and luggage sprites, which are neither of the two
 * sprite compressions the rest of the game uses.
 *
 * A `MOUSE_FILE` is a six-byte header, then one 32-bit offset per frame, then
 * the frames themselves (`mouse.h:75-88`, `Mouse::setMouseAnim`). The frames
 * are run-length coded against a *threshold* rather than against a flag byte:
 * a byte above 183 is one pixel of that colour, and a byte of 183 or less is
 * that many transparent pixels (`Mouse::decompressMouse`). Which works because
 * the cursor palette lives in the top of the range and nothing below it is ever
 * drawn — so there is no escape byte to get out of step with, and a frame
 * either decodes or runs out, which is what {@link Sword2MouseFrame.ok} says.
 *
 * Pure, like `sword2Decode.ts`, for the same two reasons: the editor may want a
 * cursor without an engine and the tests want one without either.
 *
 * The hotspot is **signed** — the luggage's is -8,-8 on every object in the
 * demo, which is what makes the bundle hang below and to the right of the
 * pointer rather than sit on it.
 */

import { RES_HEADER_SIZE } from '../resource/sword2Headers.js';

/** `MOUSE_ANIM_HEADER_SIZE` (`mouse.h:75`). */
export const SWORD2_MOUSE_ANIM_HEADER_SIZE = 6;

/**
 * The highest byte value that still means "skip" rather than "draw".
 *
 * `Mouse::decompressMouse`'s own `> 183`, kept as a named constant because the
 * number is a property of the cursor palette and not an arbitrary one.
 */
export const SWORD2_MOUSE_RUN_MAX = 183;

/** A parsed `MOUSE_FILE` header, with the frame data still packed. */
export interface Sword2MouseAnim {
  /** `runTimeComp` — which compression the frames use. 4 on the PC. */
  readonly compression: number;
  readonly frames: number;
  /** Signed, and usually negative: where the pointer sits inside the image. */
  readonly hotspotX: number;
  readonly hotspotY: number;
  readonly width: number;
  readonly height: number;
  /** The resource, and where in it this animation starts. */
  readonly bytes: Uint8Array;
  readonly at: number;
}

/** One decoded frame: `width * height` indices, zero transparent. */
export interface Sword2MouseFrame {
  readonly pixels: Uint8Array;
  readonly width: number;
  readonly height: number;
  /** Carried through from the header, because a frame is drawn *by* its hotspot. */
  readonly hotspotX: number;
  readonly hotspotY: number;
  /** False when the source ran out before the frame was full. */
  readonly ok: boolean;
}

/**
 * Reads a `MOUSE_FILE`'s header, or null when there is not one there.
 *
 * `at` defaults past the standard resource header, because that is where
 * `Mouse::setLuggage` starts reading (`mouse.cpp:1117`).
 */
export function parseSword2MouseAnim(
  bytes: Uint8Array,
  at: number = RES_HEADER_SIZE,
): Sword2MouseAnim | null {
  if (at + SWORD2_MOUSE_ANIM_HEADER_SIZE > bytes.length) return null;
  const frames = bytes[at + 1]!;
  const width = bytes[at + 4]!;
  const height = bytes[at + 5]!;
  if (frames === 0 || width === 0 || height === 0) return null;
  // The offset table has to be inside the resource, or the first frame read
  // would be somewhere else's bytes rather than a short frame.
  if (at + SWORD2_MOUSE_ANIM_HEADER_SIZE + frames * 4 > bytes.length) return null;
  return {
    compression: bytes[at]!,
    frames,
    hotspotX: (bytes[at + 2]! << 24) >> 24,
    hotspotY: (bytes[at + 3]! << 24) >> 24,
    width,
    height,
    bytes,
    at,
  };
}

/**
 * Decodes one frame, or null when the frame number is not one of them.
 *
 * The offsets are counted from the start of the animation rather than from the
 * start of the frame data, which is what `comp + offset - MOUSE_ANIM_HEADER_SIZE`
 * works out to once `comp` has been stepped past the header.
 */
export function decodeSword2MouseFrame(
  anim: Sword2MouseAnim,
  frame: number,
): Sword2MouseFrame | null {
  if (frame < 0 || frame >= anim.frames) return null;
  const table = anim.at + SWORD2_MOUSE_ANIM_HEADER_SIZE + frame * 4;
  const view = new DataView(anim.bytes.buffer, anim.bytes.byteOffset, anim.bytes.byteLength);
  let from = anim.at + view.getUint32(table, true);
  const size = anim.width * anim.height;
  const pixels = new Uint8Array(size);
  let written = 0;
  let x = 0;
  let y = 0;
  while (written < size) {
    if (from >= anim.bytes.length) break;
    const byte = anim.bytes[from]!;
    from += 1;
    if (byte > SWORD2_MOUSE_RUN_MAX) {
      pixels[y * anim.width + x] = byte;
      x += 1;
      if (x >= anim.width) {
        x = 0;
        y += 1;
      }
      written += 1;
    } else {
      // A run of zero would spin forever on a corrupt resource; the original
      // cannot hit it because its own encoder never writes one.
      if (byte === 0) break;
      x += byte;
      while (x >= anim.width) {
        y += 1;
        x -= anim.width;
      }
      written += byte;
    }
  }
  return {
    pixels,
    width: anim.width,
    height: anim.height,
    hotspotX: anim.hotspotX,
    hotspotY: anim.hotspotY,
    ok: written === size,
  };
}
