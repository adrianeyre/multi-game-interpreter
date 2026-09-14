/**
 * Drawing a line of text, in the direction the release declares.
 *
 * `textLayout.ts` decides where each glyph goes; this puts pixels there. The
 * two are separate because the direction is a layout question and the glyphs
 * are a font question.
 *
 * ## The font is not in the game
 *
 * AGOS keeps its font in the **interpreter executable**, not in the data files
 * a player owns — which is why this takes a `GlyphSource` rather than reading
 * one. A caller that has a font supplies it; a caller that does not gets
 * nothing drawn and a truthful answer about why, rather than a row of boxes
 * that looks like a rendering bug.
 *
 * Where a font comes from is `agosFont.ts`, which reads one out of an
 * interpreter executable beside the game (ADR 0032). This file stays ignorant
 * of that: the seam is what lets an editor preview with a substitute without
 * that becoming a second way for a game to be drawn.
 *
 * That also makes the direction testable without any font at all: a synthetic
 * three-by-five glyph set proves a right-to-left run lands where a
 * left-to-right one does not, which is the property ADR 0028 is about.
 */

import { layoutTextRun, type TextDirection } from './textLayout.js';

/** A bitmap for one character: 1 where ink goes, 0 where it does not. */
export interface Glyph {
  readonly width: number;
  readonly height: number;
  /** Row-major, one byte per pixel, non-zero meaning ink. */
  readonly pixels: Uint8Array;
}

/** Where glyphs come from. Returns undefined for a character the font lacks. */
export type GlyphSource = (character: string) => Glyph | undefined;

export interface DrawTextTarget {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

export interface DrawTextOptions {
  readonly x: number;
  readonly y: number;
  /** The palette index ink is drawn in. */
  readonly colour: number;
  readonly direction?: TextDirection;
  /** The width of the box, which a right-to-left run starts from the far end of. */
  readonly boxWidth?: number;
}

export interface DrawTextResult {
  /** How many characters were drawn. */
  readonly drawn: number;
  /** Characters the font had no glyph for, in the order they were met. */
  readonly missing: readonly string[];
}

/**
 * Draws a run and answers what it could not draw.
 *
 * Missing glyphs are **reported rather than substituted**. A font that lacks a
 * character is a fact about the font, and drawing a box or a space in its place
 * turns that fact into a rendering artefact nobody can trace back.
 */
export function drawTextRun(
  target: DrawTextTarget,
  text: string,
  glyphs: GlyphSource,
  options: DrawTextOptions,
): DrawTextResult {
  // Every glyph advances by the same width, which is what these games use. A
  // proportional font would need the advance per glyph, and the layout would
  // be the thing to change rather than this.
  const first = glyphs(text[0] ?? ' ');
  const glyphWidth = first?.width ?? 8;

  const positions = layoutTextRun(text, {
    x: options.x,
    y: options.y,
    glyphWidth,
    ...(options.direction ? { direction: options.direction } : {}),
    ...(options.boxWidth === undefined ? {} : { boxWidth: options.boxWidth }),
  });

  const missing: string[] = [];
  let drawn = 0;

  for (const position of positions) {
    const character = text[position.index] ?? '';
    const glyph = glyphs(character);
    if (!glyph) {
      missing.push(character);
      continue;
    }

    for (let row = 0; row < glyph.height; row += 1) {
      const targetRow = position.y + row;
      if (targetRow < 0 || targetRow >= target.height) continue;
      for (let column = 0; column < glyph.width; column += 1) {
        if ((glyph.pixels[row * glyph.width + column] ?? 0) === 0) continue;
        const targetColumn = position.x + column;
        if (targetColumn < 0 || targetColumn >= target.width) continue;
        target.pixels[targetRow * target.width + targetColumn] = options.colour;
      }
    }
    drawn += 1;
  }

  return { drawn, missing };
}
