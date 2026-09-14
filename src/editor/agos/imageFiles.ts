/**
 * What an AGOS surface hands over as a file.
 *
 * Split from `AgosEditor` for the reason `imageExport.ts` gives for the SCUMM
 * canvases: the editing surfaces draw a checkerboard for transparency, a
 * cursor, a grid and a selection over the art, and none of those belong in a
 * saved picture. These render the pixels and nothing else, at their true size,
 * so what is saved is the artwork rather than a screenshot of the tool.
 *
 * Pure functions returning RGBA, so the interesting half can be tested without
 * a canvas — the same shape `imageExport.ts` settled on, and the reason its
 * `writePng` is what actually writes them out here rather than a second copy.
 */

import type { RenderedImage } from '../imageExport.js';
import type { IndexedBitmap } from '../../engine/agos/gfx/agosImage.js';
import type { AgosPalette } from './AgosImageCanvas.js';

/**
 * A zone image as RGBA, in the colours the canvas is showing it in.
 *
 * The palette is the caller's because it is a *choice* rather than a fact: an
 * image's colours come from whichever bank the script that draws it loaded, and
 * this surface has no script to ask (see `AgosEditor.paletteFor`). Handing the
 * ramp of greys instead of the bank on screen is what made every exported
 * picture a grey one.
 *
 * `transparentZero` follows the entry's own `opaque` flag, the same way the
 * canvas does. An AGOS sprite is mostly index zero, so writing it out opaque
 * paints whatever colour sits at index 0 across everything the sprite does not
 * cover — which is the black-rectangle failure `transparentZeroFor` exists to
 * avoid, saved to disk.
 */
export function renderAgosImage(
  bitmap: IndexedBitmap,
  palette: AgosPalette,
  options: { transparentZero?: boolean } = {},
): RenderedImage {
  const transparent = options.transparentZero ?? false;
  const rgba = new Uint8ClampedArray(bitmap.width * bitmap.height * 4);
  for (let at = 0; at < bitmap.width * bitmap.height; at += 1) {
    const index = bitmap.pixels[at] ?? 0;
    if (index === 0 && transparent) continue;
    const entry = palette[index] ?? [0, 0, 0];
    rgba[at * 4] = entry[0] ?? 0;
    rgba[at * 4 + 1] = entry[1] ?? 0;
    rgba[at * 4 + 2] = entry[2] ?? 0;
    rgba[at * 4 + 3] = 255;
  }
  return { width: bitmap.width, height: bitmap.height, rgba };
}

/** A filename stem that survives being typed, out of a project's own name. */
export function agosSlug(name: string): string {
  return (
    name
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'game'
  );
}

/** "simon-the-sorcerer-zone2-image10.png" — which game, which zone, which image. */
export function agosImageFilename(gameName: string, zone: number, id: number): string {
  return `${agosSlug(gameName)}-zone${zone}-image${id}.png`;
}

/**
 * Eight-bit pixels as RGBA, against a 256-entry table of RGB triples.
 *
 * The other half of the family's art: a zone image is four-bit indices against
 * a bank chosen on the toolbar, but a room backdrop and an inventory icon are
 * both *eight*-bit against a whole palette their own script loaded. So the
 * palette is a flat `Uint8Array` here rather than the canvas's array of
 * triples — it is the shape `RoomBackdrop` and `interfacePalette` produce, and
 * converting it to talk to this would be a copy of 256 colours per save for no
 * gain.
 */
export function renderIndexedImage(
  bitmap: { readonly width: number; readonly height: number; readonly pixels: Uint8Array },
  palette: Uint8Array,
  options: { transparentZero?: boolean } = {},
): RenderedImage {
  const transparent = options.transparentZero ?? false;
  const rgba = new Uint8ClampedArray(bitmap.width * bitmap.height * 4);
  for (let at = 0; at < bitmap.width * bitmap.height; at += 1) {
    const index = bitmap.pixels[at] ?? 0;
    if (index === 0 && transparent) continue;
    const entry = index * 3;
    rgba[at * 4] = palette[entry] ?? 0;
    rgba[at * 4 + 1] = palette[entry + 1] ?? 0;
    rgba[at * 4 + 2] = palette[entry + 2] ?? 0;
    rgba[at * 4 + 3] = 255;
  }
  return { width: bitmap.width, height: bitmap.height, rgba };
}

/** "simon-room11.png" — which game, and which item is the room. */
export function agosRoomFilename(gameName: string, item: number): string {
  return `${agosSlug(gameName)}-room${item}.png`;
}

/**
 * "simon-item42-icon17.png" — which item, and which icon it turned out to be.
 *
 * Both numbers, because they are two different facts and an author checking the
 * export against the game needs each: the item is what they selected, and the
 * icon is the entry in `ICON.DAT` it resolved to. Several items can legitimately
 * share one icon.
 */
export function agosItemIconFilename(gameName: string, item: number, icon: number): string {
  return `${agosSlug(gameName)}-item${item}-icon${icon}.png`;
}
