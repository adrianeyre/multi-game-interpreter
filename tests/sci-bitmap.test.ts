/**
 * SCI32's bitmaps, which are how a SCI32 game draws text at all.
 *
 * SCI16 put a string on the screen through `Display`; SCI32 renders into a
 * bitmap and hangs it on a screen item. A game with no bitmaps has no text —
 * not text in the wrong place, none — which is what left King's Quest VII
 * waiting for a click on a menu it believed it had drawn.
 */

import { describe, expect, it } from 'vitest';

import { SciBitmaps } from '../src/engine/sci/gfx/SciBitmap.js';
import type { SciFontResource } from '../src/engine/sci/gfx/SciFont.js';

/** A font of one glyph: a solid 3x3 block for 'X', so a draw is visible. */
function blockFont(): SciFontResource {
  const glyphs: SciFontResource['glyphs'] = [];
  glyphs['X'.charCodeAt(0)] = {
    width: 3,
    height: 3,
    // One byte per pixel, 1 where the glyph is inked — the reader's own shape.
    pixels: Uint8Array.from([1, 1, 1, 1, 1, 1, 1, 1, 1]),
  };
  return { lineHeight: 3, glyphs };
}

describe('a bitmap a script can draw into', () => {
  it('hands back a handle that is never nought, because nought means failure', () => {
    const bitmaps = new SciBitmaps();
    // The same error channel `FOpen` uses, and the scripts test it the same way.
    expect(bitmaps.create(10, 10, 0, 0)).toBeGreaterThan(0);
    expect(bitmaps.create(10, 10, 0, 0)).toBeGreaterThan(0);
  });

  it('fills with the colour it was created with', () => {
    const bitmaps = new SciBitmaps();
    const handle = bitmaps.create(4, 2, 255, 7);
    expect([...bitmaps.get(handle)!.pixels]).toEqual([7, 7, 7, 7, 7, 7, 7, 7]);
  });

  it('fills a rectangle and leaves the rest alone', () => {
    const bitmaps = new SciBitmaps();
    const handle = bitmaps.create(4, 2, 255, 0);
    bitmaps.fill(handle, 1, 0, 3, 1, 9);
    expect([...bitmaps.get(handle)!.pixels]).toEqual([0, 9, 9, 0, 0, 0, 0, 0]);
  });

  it('clips a fill to the bitmap rather than writing past it', () => {
    const bitmaps = new SciBitmaps();
    const handle = bitmaps.create(2, 2, 255, 0);
    // A script asking to fill beyond the edge is asking for the part that fits.
    expect(() => bitmaps.fill(handle, -5, -5, 99, 99, 3)).not.toThrow();
    expect([...bitmaps.get(handle)!.pixels]).toEqual([3, 3, 3, 3]);
  });

  it('renders text with the shared renderer, so a glyph lands in the pixels', () => {
    const bitmaps = new SciBitmaps();
    const handle = bitmaps.create(8, 4, 255, 0);
    bitmaps.drawText(handle, blockFont(), 'X', { x: 0, y: 0, colour: 5 });
    // The 3x3 block is there, in the colour asked for — the point being that
    // the bitmap holds pixels rather than a promise of them.
    const pixels = bitmaps.get(handle)!.pixels;
    expect(pixels[0]).toBe(5);
    expect(pixels[2]).toBe(5);
    expect(pixels[8 * 2 + 2]).toBe(5);
    // And nothing past the glyph.
    expect(pixels[3]).toBe(0);
  });

  it('forgets a bitmap that was destroyed', () => {
    const bitmaps = new SciBitmaps();
    const handle = bitmaps.create(2, 2, 0, 0);
    bitmaps.destroy(handle);
    expect(bitmaps.get(handle)).toBeNull();
    expect(bitmaps.count).toBe(0);
  });

  it('moves its origin, which is what a script positions it by', () => {
    const bitmaps = new SciBitmaps();
    const handle = bitmaps.create(2, 2, 0, 0);
    bitmaps.setOrigin(handle, 4, -3);
    expect(bitmaps.get(handle)).toMatchObject({ originX: 4, originY: -3 });
  });

  it('says how many bitmaps have something in them, not just how many exist', () => {
    const bitmaps = new SciBitmaps();
    // A session that made ten empty bitmaps and drew into none is a session
    // whose menu is invisible, and the count alone would not show it.
    bitmaps.create(4, 4, 0, 0);
    const drawn = bitmaps.create(8, 4, 0, 0);
    bitmaps.drawText(drawn, blockFont(), 'X', { x: 0, y: 0, colour: 5 });
    expect(bitmaps.describe()).toMatch(/2 bitmaps made, 1 with something drawn/);
  });
});
