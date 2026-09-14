/**
 * Drawing and measuring text with a SCI `font` resource.
 *
 * `TextSize` used to answer `0:0`, and that is the half of this that changes
 * what a game *believes* rather than only what it draws: a script asks how wide
 * a string is and then centres a window on the answer, sizes a button to it, or
 * decides how many lines fit. Zero does not make text invisible — it makes
 * every window one pixel wide and every layout wrong, with nothing to notice it.
 */

import { describe, expect, it } from 'vitest';

import { drawSciText, measureSciText, sciTextWidth } from '../src/engine/sci/gfx/SciText.js';
import type { SciFontResource } from '../src/engine/sci/gfx/SciFont.js';

/** A font where every character is a solid block, so widths are countable. */
function blockFont(width: number, height: number, lineHeight = height): SciFontResource {
  const glyphs = [];
  for (let index = 0; index < 128; index++) {
    glyphs.push({ width, height, pixels: new Uint8Array(width * height).fill(1) });
  }
  // A space that is blank, because a line break has to fall on one.
  glyphs[32] = { width, height, pixels: new Uint8Array(width * height) };
  return { lineHeight, glyphs };
}

describe('measuring text', () => {
  it('adds up the widths the font declares, character by character', () => {
    expect(sciTextWidth(blockFont(4, 6), 'abc')).toBe(12);
  });

  it('measures an unbroken line when no width is given', () => {
    const metrics = measureSciText(blockFont(4, 6, 8), 'abcdef');
    expect(metrics).toMatchObject({ width: 24, height: 8, lines: ['abcdef'] });
  });

  it('breaks at the last space that fits, and counts the lines in line heights', () => {
    const metrics = measureSciText(blockFont(4, 6, 8), 'aa bb cc', 20);
    expect(metrics.lines).toEqual(['aa bb', 'cc']);
    expect(metrics.height).toBe(16);
  });

  /**
   * A game that asks for a narrow window and gets a hyphenated word has been
   * given something it did not ask for and cannot detect, so a word wider than
   * the limit goes on its own line whole.
   */
  it('does not break inside a word that is wider than the limit', () => {
    const metrics = measureSciText(blockFont(4, 6), 'a bbbbbbbb', 12);
    expect(metrics.lines).toEqual(['a', 'bbbbbbbb']);
  });

  it('breaks on a newline whatever the width', () => {
    expect(measureSciText(blockFont(4, 6), 'a\nb').lines).toEqual(['a', 'b']);
  });
});

describe('drawing text', () => {
  it('stamps the glyph pixels in the colour it was given', () => {
    const target = new Uint8Array(8 * 8);
    drawSciText(target, 8, 8, blockFont(2, 2), 'a', { x: 1, y: 1, colour: 7 });
    expect([...target.slice(8 + 1, 8 + 3)]).toEqual([7, 7]);
    expect([...target.slice(16 + 1, 16 + 3)]).toEqual([7, 7]);
    // And nothing outside the glyph.
    expect(target[0]).toBe(0);
  });

  /**
   * A pixel the glyph does not ink leaves what is underneath, unless a
   * background is asked for — which is the difference between a line of
   * dialogue in a window and one over a room.
   */
  it('leaves what is underneath where the glyph is blank', () => {
    const target = new Uint8Array(8 * 8).fill(3);
    drawSciText(target, 8, 8, blockFont(2, 2), ' ', { x: 0, y: 0, colour: 7 });
    expect(target[0]).toBe(3);

    const opaque = new Uint8Array(8 * 8).fill(3);
    drawSciText(opaque, 8, 8, blockFont(2, 2), ' ', { x: 0, y: 0, colour: 7, background: 1 });
    expect(opaque[0]).toBe(1);
  });

  /**
   * Clipped rather than wrapped: a script that positions text off-screen has
   * made a mistake, and moving it somewhere visible hides that.
   */
  it('clips at the edge of the buffer rather than wrapping', () => {
    const target = new Uint8Array(8 * 8);
    drawSciText(target, 8, 8, blockFont(2, 2), 'a', { x: 7, y: 0, colour: 7 });
    expect(target[7]).toBe(7);
    // The second column of the glyph is off the right edge, and must not appear
    // at the start of the next row.
    expect(target[8]).toBe(0);
  });

  it('draws the same lines it measured', () => {
    const target = new Uint8Array(40 * 40);
    const metrics = drawSciText(target, 40, 40, blockFont(4, 6, 8), 'aa bb cc', {
      x: 0,
      y: 0,
      colour: 5,
      maxWidth: 20,
    });
    expect(metrics.lines).toEqual(measureSciText(blockFont(4, 6, 8), 'aa bb cc', 20).lines);
    // The second line was drawn a line height down.
    expect(target[8 * 40]).toBe(5);
  });
});
