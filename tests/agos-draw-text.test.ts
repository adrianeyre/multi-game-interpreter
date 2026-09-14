import { describe, expect, it } from 'vitest';
import { drawTextRun, type Glyph } from '../src/engine/agos/gfx/drawText.js';

/**
 * A three-by-three font with two characters in it.
 *
 * Synthetic on purpose. AGOS keeps its real font in the interpreter
 * executable rather than in the data a player owns, so a test that waited for
 * the real one would never run — and the property being tested here is the
 * *direction*, which no particular font changes.
 */
const GLYPHS: Record<string, Glyph> = {
  a: { width: 3, height: 3, pixels: Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0, 0]) },
  b: { width: 3, height: 3, pixels: Uint8Array.from([0, 0, 1, 0, 0, 0, 0, 0, 0]) },
};

const font = (character: string): Glyph | undefined => GLYPHS[character];

function target(width = 12, height = 4) {
  return { width, height, pixels: new Uint8Array(width * height) };
}

/** Which columns of the top row have ink in them. */
function inkedColumns(surface: { width: number; pixels: Uint8Array }): number[] {
  const columns: number[] = [];
  for (let column = 0; column < surface.width; column += 1) {
    if (surface.pixels[column] !== 0) columns.push(column);
  }
  return columns;
}

describe('drawing a line of text', () => {
  it('puts the first character at the left going left to right', () => {
    const surface = target();

    const result = drawTextRun(surface, 'ab', font, { x: 0, y: 0, colour: 7 });

    expect(result.drawn).toBe(2);
    // 'a' inks its own column 0, 'b' inks its column 2 — three columns along.
    expect(inkedColumns(surface)).toEqual([0, 5]);
  });

  it('puts the first character at the right going right to left', () => {
    const surface = target();

    drawTextRun(surface, 'ab', font, { x: 0, y: 0, colour: 7, direction: 'rtl', boxWidth: 12 });

    // The same two glyphs, filling the same box from the other end: 'a' inks
    // the left column of its cell and 'b' the right, so their cells are at 9
    // and 6 and their ink lands at 9 and 8.
    expect(inkedColumns(surface)).toEqual([8, 9]);
  });

  it('draws in the colour it was given', () => {
    const surface = target();

    drawTextRun(surface, 'a', font, { x: 0, y: 0, colour: 3 });

    expect(surface.pixels[0]).toBe(3);
  });

  it('reports a character the font lacks rather than substituting one', () => {
    const surface = target();

    const result = drawTextRun(surface, 'axb', font, { x: 0, y: 0, colour: 1 });

    // A font that lacks a character is a fact about the font. Drawing a box in
    // its place turns that fact into a rendering artefact nobody can trace.
    expect(result.missing).toEqual(['x']);
    expect(result.drawn).toBe(2);
  });

  it('clips at the edges rather than writing past them', () => {
    const surface = target(4, 4);

    expect(() => drawTextRun(surface, 'aaaa', font, { x: 2, y: 3, colour: 1 })).not.toThrow();
    expect(surface.pixels).toHaveLength(16);
  });
});
