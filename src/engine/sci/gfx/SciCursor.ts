/**
 * Cursors, which are resources — and neither sibling has this.
 *
 * SCUMM draws its cursor from a costume and AGI has one shape; SCI ships a
 * `cursor` resource per pointer and a script calls `kSetCursor` with its
 * number. So it is a small subsystem with a resource type behind it rather
 * than a property of the screen (#218).
 *
 * **Two formats behind one resource type.** SCI0 and SCI1 ship a fixed 16x16
 * bitmap with a two-bit-per-pixel mask; from SCI1.1 a cursor may instead be a
 * *View*, which is why `kSetCursor` takes different arguments there. Told apart
 * by size rather than by Version, because a release that disagrees with its
 * bucket should still get a pointer.
 */

import { readSciView, type SciCel } from './SciView.js';

/** A cursor, as the shell needs to draw one. */
export interface SciCursor {
  width: number;
  height: number;
  /** Where the click actually lands, relative to the top-left. */
  hotspotX: number;
  hotspotY: number;
  /**
   * One byte per pixel: 0 black, 1 white, 255 transparent.
   *
   * Three values rather than two, because a SCI cursor is drawn in black *and*
   * white over whatever is underneath — an arrow with a white body and a black
   * outline reads on both a dark room and a light one, and collapsing it to one
   * colour makes the pointer disappear over half the game.
   */
  pixels: Uint8Array;
}

/** The transparent index in a decoded cursor. */
export const CURSOR_TRANSPARENT = 0xff;

/** The fixed size every SCI0 and SCI1 cursor is. */
const CURSOR_SIZE = 16;

/**
 * Reads a SCI0 or SCI1 cursor resource.
 *
 * Four bytes of header — the hotspot — then two 32-byte planes: a *colour*
 * plane and a *mask* plane, each one bit per pixel, sixteen rows of two bytes.
 * The mask decides transparency and the colour decides black or white, and
 * reading them in the other order gives a cursor that is transparent where it
 * should be white.
 */
export function readSciCursor(resource: Uint8Array): SciCursor | null {
  if (resource.length < 4 + 64) return null;

  const hotspotY = resource[0] | (resource[1] << 8);
  const hotspotX = resource[2] | (resource[3] << 8);
  const pixels = new Uint8Array(CURSOR_SIZE * CURSOR_SIZE).fill(CURSOR_TRANSPARENT);

  for (let y = 0; y < CURSOR_SIZE; y++) {
    const colour = (resource[4 + y * 2] << 8) | resource[4 + y * 2 + 1];
    const mask = (resource[36 + y * 2] << 8) | resource[36 + y * 2 + 1];
    for (let x = 0; x < CURSOR_SIZE; x++) {
      const bit = 0x8000 >> x;
      // The mask bit says "leave what is underneath". Everything else is drawn,
      // in white where the colour bit is set and black where it is not.
      if (mask & bit) continue;
      pixels[y * CURSOR_SIZE + x] = colour & bit ? 1 : 0;
    }
  }

  return {
    width: CURSOR_SIZE,
    height: CURSOR_SIZE,
    // Clamped, because a resource read at the wrong offset produces a hotspot
    // of tens of thousands and a pointer that clicks off the screen.
    hotspotX: Math.min(hotspotX, CURSOR_SIZE - 1),
    hotspotY: Math.min(hotspotY, CURSOR_SIZE - 1),
    pixels,
  };
}

/**
 * Reads a SCI1.1 cursor, which is a View.
 *
 * From SCI1.1 `kSetCursor` may name a View, a loop and a cel instead of a
 * cursor resource — which is how a game gets a cursor larger than 16x16 and in
 * more than two colours. The cel's own transparency key becomes the cursor's,
 * so nothing has to translate between two ideas of "leave what is underneath".
 */
export function readSciViewCursor(
  resource: Uint8Array,
  loop: number,
  cel: number,
  hotspotX = 0,
  hotspotY = 0,
): SciCursor | null {
  const view = readSciView(resource);
  const found: SciCel | undefined = view.loops[loop]?.cels[cel];
  if (!found) return null;

  const pixels = new Uint8Array(found.width * found.height);
  for (let i = 0; i < pixels.length; i++) {
    pixels[i] = found.pixels[i] === found.clearKey ? CURSOR_TRANSPARENT : found.pixels[i];
  }

  return {
    width: found.width,
    height: found.height,
    hotspotX,
    hotspotY,
    pixels,
  };
}

/**
 * A CSS cursor a browser can show, as a data URI.
 *
 * The shell draws SCUMM's and AGI's cursors into the framebuffer, and SCI's
 * could be drawn the same way — but a cursor drawn into the framebuffer moves
 * at the game's frame rate rather than the pointer's, which on a game running
 * at ten cycles a second is a pointer that lags visibly behind the mouse. So
 * this hands the browser the image and lets it draw at the pointer's rate.
 */
export function cursorToDataUri(
  cursor: SciCursor,
  palette: (index: number) => [number, number, number],
): string {
  const rows: string[] = [];
  for (let y = 0; y < cursor.height; y++) {
    let row = '';
    for (let x = 0; x < cursor.width; x++) {
      const pixel = cursor.pixels[y * cursor.width + x];
      if (pixel === CURSOR_TRANSPARENT) {
        row += 'rgba(0,0,0,0) ';
        continue;
      }
      const [r, g, b] = palette(pixel);
      row += `rgb(${r},${g},${b}) `;
    }
    rows.push(row);
  }
  // Kept as an SVG rather than a PNG so this needs no encoder and no canvas —
  // a cursor is 256 pixels and the markup is smaller than the machinery.
  const squares = rows
    .flatMap((row, y) =>
      row
        .trim()
        .split(' ')
        .map((colour, x) =>
          colour === 'rgba(0,0,0,0)'
            ? ''
            : `<rect x="${x}" y="${y}" width="1" height="1" fill="${colour}"/>`,
        ),
    )
    .join('');

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${cursor.width}" ` +
    `height="${cursor.height}" shape-rendering="crispEdges">${squares}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${cursor.hotspotX} ${cursor.hotspotY}, auto`;
}

/**
 * Emits a SCI0 or SCI1 `cursor` resource (#220, #224).
 *
 * Two 16x16 bitplanes and a hotspot, which is the whole format: a colour plane
 * that says white or black, and a mask plane that says "leave what is
 * underneath". Writing them the other way round gives a cursor that is a solid
 * white square with the pointer punched out of it, which is a shape a person
 * notices immediately and no test would.
 *
 * SCI1.1's other kind of cursor is a View cel and is written by `writeSciView`
 * rather than here — the two share a Kernel call and nothing else.
 */
export function writeSciCursor(cursor: SciCursor): Uint8Array {
  const out = new Uint8Array(4 + CURSOR_SIZE * 4);
  out[0] = cursor.hotspotY & 0xff;
  out[1] = cursor.hotspotY >> 8;
  out[2] = cursor.hotspotX & 0xff;
  out[3] = cursor.hotspotX >> 8;

  for (let y = 0; y < CURSOR_SIZE; y++) {
    let colour = 0;
    let mask = 0;
    for (let x = 0; x < CURSOR_SIZE; x++) {
      const bit = 0x8000 >> x;
      const pixel = cursor.pixels[y * CURSOR_SIZE + x];
      if (pixel === CURSOR_TRANSPARENT) mask |= bit;
      else if (pixel === 1) colour |= bit;
    }
    out[4 + y * 2] = colour >> 8;
    out[4 + y * 2 + 1] = colour & 0xff;
    out[36 + y * 2] = mask >> 8;
    out[36 + y * 2 + 1] = mask & 0xff;
  }
  return out;
}
