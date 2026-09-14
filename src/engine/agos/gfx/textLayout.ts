/**
 * Where the glyphs of a line go.
 *
 * `CONTEXT.md`'s **Text direction** made a promise this file keeps: a release
 * declares which way its text runs, and the renderer lays a run out in that
 * direction with left-to-right as the *degenerate case* rather than the
 * default-with-an-exception. ADR 0028 put the property on the release rather
 * than in the Target for exactly this reason — nothing above has to know that
 * Hebrew Simon exists.
 *
 * Layout only. Which pixels a glyph is made of is a font's business — `drawText.ts`
 * puts them there and `agosFont.ts` finds them — and this decides where each
 * glyph starts, which is the half the direction actually changes. The split is
 * what let the direction be tested before this family had a font at all.
 *
 * The test worth writing against this is not "does Hebrew work" — it is that a
 * left-to-right run and a right-to-left run of the same text occupy the same
 * box and place their first character at opposite ends of it.
 */

/** Which way a run of text is laid out. */
export type TextDirection = 'ltr' | 'rtl';

/** One glyph's place in a laid-out run. */
export interface GlyphPosition {
  /** Index into the original string, so the caller knows which glyph this is. */
  readonly index: number;
  readonly x: number;
  readonly y: number;
}

export interface TextLayoutOptions {
  /** Where the run's box starts. */
  readonly x: number;
  readonly y: number;
  /** How wide each glyph is. A fixed width, which is what these games use. */
  readonly glyphWidth: number;
  /** The direction the release declares. */
  readonly direction?: TextDirection;
  /**
   * How wide the box is, for a right-to-left run.
   *
   * A right-to-left run starts at the right edge, so it needs to know where
   * that is. Left to right does not, which is why this is optional and why a
   * missing width with `rtl` is an error rather than a guess: guessing would
   * put the whole line somewhere plausible and wrong.
   */
  readonly boxWidth?: number;
}

/**
 * Lays a run out, one glyph at a time.
 *
 * The order of the returned positions follows the string, not the screen: the
 * caller draws glyph *i* of the text at position *i* whichever direction it is
 * going. Reversing the string instead would break every caller that wants to
 * know which character it just drew.
 */
export function layoutTextRun(text: string, options: TextLayoutOptions): GlyphPosition[] {
  const direction = options.direction ?? 'ltr';

  if (direction === 'rtl' && options.boxWidth === undefined) {
    throw new Error('a right-to-left run needs the width of the box it is laid out in');
  }

  const positions: GlyphPosition[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const offset = index * options.glyphWidth;
    const x =
      direction === 'ltr'
        ? options.x + offset
        : options.x + (options.boxWidth ?? 0) - options.glyphWidth - offset;
    positions.push({ index, x, y: options.y });
  }
  return positions;
}

/**
 * How wide a run will be.
 *
 * Direction does not change it, which is the point: the two directions fill the
 * same box from opposite ends.
 */
export function textRunWidth(text: string, glyphWidth: number): number {
  return text.length * glyphWidth;
}
