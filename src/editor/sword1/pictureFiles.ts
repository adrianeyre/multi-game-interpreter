/**
 * A Broken Sword picture as pixels, as a file, and as something writable.
 *
 * Split from `Sword1Editor` for the reason `imageExport.ts` gives: the editing
 * canvas draws a cursor and a grid over the art and none of that belongs in a
 * saved picture, so what is rendered here is the artwork at its true size.
 * Pure functions returning plain records, which is also what makes them
 * testable — jsdom has no 2D canvas, so the half worth checking is the half
 * that decides *what* to draw and whether it can be written back.
 *
 * ## The family's four kinds of picture are four different formats
 *
 * - A **background** resource's bytes *are* the room's pixels, uncompressed and
 *   with no header at all. Writing one back is a copy.
 * - A **parallax** has a 20-byte header, a row offset table and rows of
 *   `(skip, copy, bytes)` triples; `encodeSwordParallax` writes the whole layer
 *   because a row that changes length moves every row after it.
 * - A **sprite** is a frame table and frames, each frame carrying its own
 *   compression tag — RLE7, RLE0, Tony or none. `swordEncode.ts` writes all
 *   four, and `npm run sweep:sword` reports 7113 of the demo's 7113 frames
 *   re-encoding byte-identically, so a replaced frame sits in a resource whose
 *   other frames are still the bytes Revolution shipped.
 * - A **mask layer** is a bag of 16x8 blocks in storage order, and a separate
 *   `Grid` resource says which block goes where. The importer carries the grid
 *   with the mask (140.7 KB for a whole demo install), so the blocks are laid
 *   out over a room-sized picture here rather than drawn 4,000-deep in the
 *   order they happened to be stored. A mask whose grid is not in the install
 *   still cannot be drawn, and `sword1PictureRefusal` says which grid is
 *   missing rather than saying "unsupported".
 *
 * Every compression in this family can now be written, **HIF** included — and
 * HIF carries a smaller claim than the rest: no PC release uses it, so there is
 * no shipped stream to be byte-identical to and it is held to the pixels the
 * existing decoder reads back instead. `swordHifClaim` is that sentence, and
 * `docs/editor-parity.md` §10b is the measurement. `swordEncodeRefusal` refuses
 * nothing now and is kept because the surface still asks.
 */

import { fromBase64 } from '../../authoring/base64.js';
import type { Sword1Project, Sword1ProjectPicture } from '../../authoring/sword1/project.js';
import { formatResourceId } from '../../engine/sword1/resource/rif.js';
import {
  sword1SpriteFrames,
  SWORD1_HEADER_SIZE,
  SWORD1_PARALLAX_HEADER_SIZE,
} from '../../engine/sword1/resource/swordDefs.js';
import {
  compressionOf,
  decodeSwordFrame,
  decodeSwordParallaxRow,
  parseSwordParallax,
  type SwordCompression,
} from '../../engine/sword1/gfx/swordDecode.js';
import { swordEncodeRefusal } from '../../engine/sword1/gfx/swordEncode.js';
import { composeSwordMask, parseSwordGrid } from '../../engine/sword1/gfx/swordMask.js';
import type { RenderedImage } from '../imageExport.js';
import { sword1ScreenPalette } from './screenScene.js';

/** One drawable unit of a picture resource: a sprite frame, or the whole thing. */
export interface Sword1PictureFrame {
  readonly index: number;
  readonly width: number;
  readonly height: number;
  /** A sprite frame's hotspot. Zero for everything else. */
  readonly offsetX: number;
  readonly offsetY: number;
  /** `null` where the format carries no compression tag. */
  readonly compression: SwordCompression | null;
  /** What to call it in a picker. */
  readonly label: string;
}

/** Eight-bit pixels at a known size, which is what every route here returns. */
export interface Sword1PicturePixels {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

/** What a picture's frames are, which is one frame for everything but a sprite. */
export function sword1PictureFrames(picture: Sword1ProjectPicture): Sword1PictureFrame[] {
  if (picture.kind !== 'sprite') {
    return [
      {
        index: 0,
        width: picture.width,
        height: picture.height,
        offsetX: 0,
        offsetY: 0,
        compression: null,
        label: `${picture.width}x${picture.height}`,
      },
    ];
  }
  return sword1SpriteFrames(fromBase64(picture.bytesBase64)).map((frame) => ({
    index: frame.index,
    width: frame.header.width,
    height: frame.header.height,
    offsetX: frame.header.offsetX,
    offsetY: frame.header.offsetY,
    compression: compressionOf(frame.header.runTimeComp),
    label:
      `Frame ${frame.index} — ${frame.header.width}x${frame.header.height}, ` +
      `${frame.header.runTimeComp.trim() || 'none'}`,
  }));
}

/**
 * One frame's pixels, or null when this project cannot produce them.
 *
 * Null rather than a throw, because "the cluster this lives in is on the other
 * disc" is an ordinary state of a demo install and not an error.
 */
export function sword1PicturePixels(
  picture: Sword1ProjectPicture,
  frameIndex = 0,
): Sword1PicturePixels | null {
  const bytes = fromBase64(picture.bytesBase64);
  if (bytes.length === 0) return null;

  if (picture.kind === 'background') {
    const pixels = new Uint8Array(picture.width * picture.height);
    if (bytes.length < pixels.length) return null;
    pixels.set(bytes.subarray(0, pixels.length));
    return { width: picture.width, height: picture.height, pixels };
  }

  if (picture.kind === 'parallax') {
    let parallax;
    try {
      parallax = parseSwordParallax(bytes);
    } catch {
      return null;
    }
    const pixels = new Uint8Array(parallax.width * parallax.height);
    for (let row = 0; row < parallax.height; row++) {
      const strip = decodeSwordParallaxRow(bytes, parallax, row);
      if (strip) pixels.set(strip, row * parallax.width);
    }
    return { width: parallax.width, height: parallax.height, pixels };
  }

  if (picture.kind === 'mask') {
    if (!picture.grid) return null;
    const grid = parseSwordGrid(fromBase64(picture.grid.bytesBase64), picture.grid.pitch);
    if (grid.rows === 0) return null;
    // The blocks start past the resource's 20-byte header; the grid's cells,
    // confusingly, start 28 bytes into *its* resource. See `swordMask.ts`.
    return {
      width: picture.width,
      height: picture.height,
      pixels: composeSwordMask(
        bytes.subarray(SWORD1_HEADER_SIZE),
        grid,
        picture.width,
        picture.height,
      ),
    };
  }

  if (picture.kind !== 'sprite') return null;

  const frame = sword1SpriteFrames(bytes).find((candidate) => candidate.index === frameIndex);
  if (!frame) return null;
  try {
    const pixels = decodeSwordFrame(
      frame.data,
      compressionOf(frame.header.runTimeComp),
      frame.header.compSize,
      frame.header.width,
      frame.header.height,
    );
    return { width: frame.header.width, height: frame.header.height, pixels };
  } catch {
    return null;
  }
}

/**
 * The colours to show a picture in.
 *
 * A screen that uses it, where the room table says so — the same two palette
 * halves the renderer widens, so the file and the canvas agree by construction.
 * A sprite that no room names falls back to the project's first screen, which
 * is a guess and is labelled as one on the surface.
 */
export function sword1PicturePalette(
  sword1: Sword1Project,
  picture: Sword1ProjectPicture,
): number[][] {
  const screen = picture.screens[0];
  const room =
    (screen !== undefined ? sword1.rooms.find((one) => one.screen === screen) : undefined) ??
    sword1.rooms[0];
  return room ? sword1ScreenPalette(sword1, room) : Array.from({ length: 256 }, () => [0, 0, 0]);
}

/**
 * A frame as RGBA, with colour zero left transparent.
 *
 * Index 0 is Broken Sword's transparency — not 255, which is SCUMM's — so a
 * sprite written out opaque would paint whatever sits at index 0 across
 * everything the sprite does not cover. A background has no transparent pixel
 * to worry about, and passing `transparentZero: false` for one is what keeps
 * its blacks black.
 */
export function sword1PictureImage(
  pixels: Sword1PicturePixels,
  palette: number[][],
  options: { transparentZero?: boolean } = {},
): RenderedImage {
  const transparent = options.transparentZero ?? true;
  const rgba = new Uint8ClampedArray(pixels.width * pixels.height * 4);
  for (let at = 0; at < pixels.width * pixels.height; at++) {
    const index = pixels.pixels[at] ?? 0;
    if (index === 0 && transparent) continue;
    const entry = palette[index] ?? [0, 0, 0];
    rgba[at * 4] = entry[0] ?? 0;
    rgba[at * 4 + 1] = entry[1] ?? 0;
    rgba[at * 4 + 2] = entry[2] ?? 0;
    rgba[at * 4 + 3] = 255;
  }
  return { width: pixels.width, height: pixels.height, rgba };
}

/** Whether a picture's own transparency applies: a background is opaque. */
export function sword1PictureIsTransparent(picture: Sword1ProjectPicture): boolean {
  return picture.kind !== 'background';
}

/**
 * Why a frame cannot be written back, or null when it can.
 *
 * The sentence an author reads instead of a disabled button with no
 * explanation, and it names the format rather than saying "unsupported".
 */
export function sword1PictureRefusal(picture: Sword1ProjectPicture, frameIndex = 0): string | null {
  if (picture.kind === 'mask' && !picture.grid) {
    return (
      'A mask layer is a bag of 16x8 blocks, and the Grid resource that says where each block ' +
      `goes is not in this install, so ${formatResourceId(picture.resource)} has no rectangle ` +
      'to draw or replace. Its bytes are uncompressed and preserved exactly.'
    );
  }
  const bytes = fromBase64(picture.bytesBase64);
  if (bytes.length === 0) {
    return (
      `${formatResourceId(picture.resource)} has no bytes in this project — importing takes ` +
      `pictures largest-first until a budget runs out — so there is nothing to replace.`
    );
  }
  if (picture.kind === 'background') {
    return bytes.length >= picture.width * picture.height
      ? null
      : `${formatResourceId(picture.resource)} holds ${bytes.length} bytes and the room table ` +
          `says it is ${picture.width}x${picture.height}, which needs ` +
          `${picture.width * picture.height}. One of the two is wrong for this release, so ` +
          `writing pixels back could truncate the resource.`;
  }
  if (picture.kind === 'parallax') {
    return bytes.length >= SWORD1_PARALLAX_HEADER_SIZE
      ? null
      : `${formatResourceId(picture.resource)} is too short to be a parallax layer.`;
  }

  if (picture.kind === 'mask') {
    const grid = picture.grid;
    if (!grid) return 'This mask layer has no grid.';
    const cells = parseSwordGrid(fromBase64(grid.bytesBase64), grid.pitch);
    if (cells.rows === 0) {
      return (
        `${formatResourceId(grid.resource)} holds no whole rows of ${grid.pitch} cells, so it ` +
        `cannot place ${formatResourceId(picture.resource)}'s blocks.`
      );
    }
    return null;
  }

  const frame = sword1SpriteFrames(bytes).find((candidate) => candidate.index === frameIndex);
  if (!frame) return `This sprite has no frame ${frameIndex}.`;
  return swordEncodeRefusal(compressionOf(frame.header.runTimeComp));
}

/** A filename stem that survives being typed. */
export function sword1Slug(name: string): string {
  return (
    name
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'game'
  );
}

/** "broken-sword-sprite-0x01010001-frame3.png" — which resource, which frame. */
export function sword1PictureFilename(
  gameName: string,
  picture: Sword1ProjectPicture,
  frameIndex = 0,
): string {
  const id = `0x${picture.resource.toString(16).toUpperCase().padStart(8, '0')}`;
  const frame = picture.kind === 'sprite' ? `-frame${frameIndex}` : '';
  return `${sword1Slug(gameName)}-${picture.kind}-${id}${frame}.png`;
}
