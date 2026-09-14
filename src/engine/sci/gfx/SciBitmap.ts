/**
 * SCI32's bitmaps, which are how a SCI2 game draws text at all.
 *
 * SCI16 drew a string straight onto the screen through `Display`. **SCI32 does
 * not**: a script builds a *bitmap*, renders text into it, hangs it on a screen
 * item and lets the compositor put it on a Plane. So a SCI32 game with no
 * bitmaps has no text — not mis-positioned text, none — and King's Quest VII
 * sits waiting for a click on a menu it believes it has drawn.
 *
 * Held here rather than on the heap because a bitmap is pixels with a header
 * rather than a script-visible array: a game passes the handle around and never
 * reads inside it except through this call's own sub-functions.
 */

import { drawSciText } from './SciText.js';
import type { SciFontResource } from './SciFont.js';

export interface SciBitmapData {
  width: number;
  height: number;
  /** One byte per pixel, indexing the palette, `skip` where nothing is drawn. */
  pixels: Uint8Array;
  /** Where the bitmap's own origin sits, which `BitmapSetOrigin` moves. */
  originX: number;
  originY: number;
  /** The index meaning "leave what is underneath", as the creating call set it. */
  skip: number;
}

/**
 * The bitmaps a session has made, by handle.
 *
 * Handles start at one because nought is SCI's "no bitmap" and a script tests
 * for it — the same error channel `FOpen` uses, and for the same reason.
 */
export class SciBitmaps {
  private readonly held = new Map<number, SciBitmapData>();

  private next = 1;

  get count(): number {
    return this.held.size;
  }

  create(width: number, height: number, skip: number, fill: number): number {
    // Clamped rather than refused: a script asking for a bitmap of no size is
    // asking for one nothing will show, which is not a reason to stop it.
    const w = Math.max(0, Math.min(width, 4096));
    const h = Math.max(0, Math.min(height, 4096));
    const pixels = new Uint8Array(w * h);
    pixels.fill(fill);

    const handle = this.next++;
    this.held.set(handle, { width: w, height: h, pixels, originX: 0, originY: 0, skip });
    return handle;
  }

  get(handle: number): SciBitmapData | null {
    return this.held.get(handle) ?? null;
  }

  destroy(handle: number): void {
    this.held.delete(handle);
  }

  setOrigin(handle: number, x: number, y: number): void {
    const bitmap = this.held.get(handle);
    if (!bitmap) return;
    bitmap.originX = x;
    bitmap.originY = y;
  }

  /** Fills a rectangle, which `BitmapDrawColor` does. */
  fill(
    handle: number,
    left: number,
    top: number,
    right: number,
    bottom: number,
    colour: number,
  ): void {
    const bitmap = this.held.get(handle);
    if (!bitmap) return;
    for (let y = Math.max(0, top); y < Math.min(bottom, bitmap.height); y++) {
      for (let x = Math.max(0, left); x < Math.min(right, bitmap.width); x++) {
        bitmap.pixels[y * bitmap.width + x] = colour;
      }
    }
  }

  /**
   * Renders text into a bitmap with the font the script named.
   *
   * `drawSciText` is the same renderer SCI16's `Display` goes through — the
   * glyphs and the line breaking do not change between the two, only where the
   * pixels land. Sharing it is what keeps a SCI32 menu and a SCI0 window
   * breaking lines the same way.
   */
  drawText(
    handle: number,
    font: SciFontResource,
    text: string,
    options: {
      x: number;
      y: number;
      colour: number;
      background?: number | null;
      maxWidth?: number;
    },
  ): void {
    const bitmap = this.held.get(handle);
    if (!bitmap) return;
    drawSciText(bitmap.pixels, bitmap.width, bitmap.height, font, text, options);
  }

  /** For the stall report: what a session made and never got on screen. */
  describe(): string {
    if (this.held.size === 0) return 'no bitmaps made';
    const withPixels = [...this.held.values()].filter((bitmap) =>
      bitmap.pixels.some((pixel) => pixel !== bitmap.skip),
    ).length;
    return `${this.held.size} bitmaps made, ${withPixels} with something drawn in them`;
  }
}
