/**
 * A Broken Sword II picture as pixels, as a file, and as something writable.
 *
 * The counterpart of `sword1/pictureFiles.ts` against a different layout, and a
 * separate file for ADR 0036's reason: these two families share a *widget* and
 * a codec, never a record. Sword 1 keeps a background in a resource whose bytes
 * are the pixels and its sprites in resources of their own; Sword II keeps nine
 * things in one screen resource, and its sprites are animations whose frames
 * each carry a placement as well as a size.
 *
 * ## What can be written back, and what that cost
 *
 * `sword2Encode.ts` writes all three of the family's schemes — the row-clipped
 * `FAST_256` writer, RLE256 and RLE16 — and `npm run sweep:sword` reports
 * 14085 of the demo's 14088 frames and 17 of 17 parallax layers coming back
 * byte-identical. The three exceptions are ties the format allows rather than
 * wrong pixels: two 1x1 frames and one frame whose sixteen-entry colour table
 * repeats a colour, and all three decode identically either way.
 *
 * A screen's layers are writable too, and that is the part with a cost worth
 * knowing: a layer whose re-encoded length changes moves every block after it
 * in the resource, so `replaceSword2ScreenLayer` rewrites the multi-screen
 * header's offsets and the mask table's offsets with it.
 */

import { fromBase64 } from '../../authoring/base64.js';
import type { Sword2Project, Sword2ProjectAnimation } from '../../authoring/sword2/project.js';
import {
  decodeSword2Frame,
  parseSword2Parallax,
  type Sword2Parallax,
} from '../../engine/sword2/gfx/sword2Decode.js';
import {
  sword2Animation,
  sword2ScreenLayerOffsets,
  Sword2AnimCompression,
  SWORD2_LAYER_SLOTS,
} from '../../engine/sword2/resource/sword2Headers.js';
import type { RenderedImage } from '../imageExport.js';
import { sword2ScreenPalette } from './screenScene.js';

/** One frame of an animation, as a picker needs to describe it. */
export interface Sword2PictureFrame {
  readonly index: number;
  readonly width: number;
  readonly height: number;
  /** The CDT placement, which is relative to the mega's feet when OFFSET is set. */
  readonly x: number;
  readonly y: number;
  readonly frameType: number;
  /** 0 none, 1 RLE256, 2 RLE16 — per frame, because `FAST_256` overrides. */
  readonly compression: number;
  readonly label: string;
}

/** Eight-bit pixels at a known size. */
export interface Sword2PicturePixels {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

/** One screen layer's pixels, or null where the slot is empty or will not decode. */
export function sword2ScreenLayerPixels(
  sword2: Sword2Project,
  resource: number,
  slot: number,
): Sword2Parallax | null {
  const screen = sword2.screens.find((candidate) => candidate.resource === resource);
  if (!screen?.bytesBase64) return null;
  const bytes = fromBase64(screen.bytesBase64);
  const at = sword2ScreenLayerOffsets(bytes)[slot];
  return at === null || at === undefined ? null : parseSword2Parallax(bytes, at);
}

/** What an animation's frames are, walked from the resource rather than counted. */
export function sword2PictureFrames(animation: Sword2ProjectAnimation): Sword2PictureFrame[] {
  const walked = sword2Animation(fromBase64(animation.bytesBase64));
  if (!walked) return [];
  return walked.frames.map((frame) => ({
    index: frame.index,
    width: frame.header.width,
    height: frame.header.height,
    x: frame.cdt.x,
    y: frame.cdt.y,
    frameType: frame.cdt.frameType,
    compression: frame.compression,
    label:
      `Frame ${frame.index} — ${frame.header.width}x${frame.header.height}, ` +
      `${compressionName(frame.compression)}`,
  }));
}

/** "RLE256" and the rest, said the same way everywhere on the surface. */
export function compressionName(compression: number): string {
  return compression === Sword2AnimCompression.NONE
    ? 'uncompressed'
    : compression === Sword2AnimCompression.RLE256
      ? 'RLE256'
      : 'RLE16';
}

/** One animation frame's pixels, or null when it will not decode. */
export function sword2PicturePixels(
  animation: Sword2ProjectAnimation,
  frameIndex: number,
): Sword2PicturePixels | null {
  const walked = sword2Animation(fromBase64(animation.bytesBase64));
  const frame = walked?.frames.find((candidate) => candidate.index === frameIndex);
  if (!walked || !frame) return null;
  const decoded = decodeSword2Frame(
    frame.data,
    frame.compression,
    frame.header.width,
    frame.header.height,
    walked.colourTable ?? undefined,
  );
  if (!decoded.ok) return null;
  return { width: frame.header.width, height: frame.header.height, pixels: decoded.pixels };
}

/**
 * Pixels as RGBA, with colour zero left transparent.
 *
 * Index 0 is this family's transparency as it is Sword 1's, and not 255 the way
 * SCUMM's is — an animation frame written out opaque paints index 0 across
 * everything the sprite does not cover.
 */
export function sword2PictureImage(
  pixels: Sword2PicturePixels,
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

/**
 * The colours to show an animation in.
 *
 * A guess, and the surface says so: an animation carries no palette, and which
 * screen it is drawn on is decided at run time by whichever script placed the
 * mega. The project's first screen is the least surprising default.
 */
export function sword2PicturePalette(sword2: Sword2Project, screen?: number): number[][] {
  const resource = screen ?? sword2.screens[0]?.resource;
  return resource === undefined
    ? Array.from({ length: 256 }, () => [0, 0, 0])
    : sword2ScreenPalette(sword2, resource);
}

/**
 * Which palette indices a replaced frame may use.
 *
 * Null for every frame but an RLE16 one, which means "1 to 255, the whole
 * palette". An RLE16 frame draws its literals through a sixteen-entry table
 * that lives in the resource between the frame table and the frames, so a
 * colour outside that table cannot be written at all — `encodeSword2Frame`
 * refuses rather than writing a wrong pixel, and an import that quantised
 * against 255 colours would hit that refusal on nearly every picture. Handing
 * the table's own colours to the quantiser instead turns the refusal into a
 * choice of nearest colour, which is what an author expects from an import.
 *
 * The table is returned whole, colour zero included where it is in it, because
 * whether zero is in it decides something else: the encoder writes a frame's
 * literals through the table, so an RLE16 frame whose table has no zero cannot
 * carry a transparent pixel and an import must not make one.
 */
export function sword2FrameColours(
  animation: Sword2ProjectAnimation,
  frameIndex: number,
): number[] | null {
  const walked = sword2Animation(fromBase64(animation.bytesBase64));
  const frame = walked?.frames.find((candidate) => candidate.index === frameIndex);
  if (!walked || !frame) return null;
  if (frame.compression !== Sword2AnimCompression.RLE16 || !walked.colourTable) return null;
  return [...new Set(Array.from(walked.colourTable))];
}

/**
 * Why an animation frame cannot be written back, or null when it can.
 *
 * The one refusal this family has is an RLE16 frame carrying a colour that its
 * animation's sixteen-entry table does not hold, which cannot happen to a
 * decoded frame and can happen to imported artwork. Naming it is the point:
 * "unsupported" would leave an author guessing at which of three schemes.
 */
export function sword2PictureRefusal(
  animation: Sword2ProjectAnimation,
  frameIndex: number,
): string | null {
  const walked = sword2Animation(fromBase64(animation.bytesBase64));
  if (!walked) return 'This animation resource will not walk, so there is nothing to replace.';
  const frame = walked.frames.find((candidate) => candidate.index === frameIndex);
  if (!frame) return `This animation has no frame ${frameIndex}.`;
  return null;
}

/** A filename stem that survives being typed. */
export function sword2Slug(name: string): string {
  return (
    name
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'game'
  );
}

/** "broken-sword-ii-anim1234-frame7.png" — which resource, which frame. */
export function sword2AnimationFilename(
  gameName: string,
  resource: number,
  frameIndex: number,
): string {
  return `${sword2Slug(gameName)}-anim${resource}-frame${frameIndex}.png`;
}

/** "broken-sword-ii-screen22-background.png" — which screen, which layer. */
export function sword2ScreenFilename(gameName: string, resource: number, slot: number): string {
  const label = (SWORD2_LAYER_SLOTS[slot] ?? `layer${slot}`).replace(/ /g, '-');
  return `${sword2Slug(gameName)}-screen${resource}-${label}.png`;
}
