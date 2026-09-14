/**
 * Putting a game's words in the window it asked for.
 *
 * `drawText.ts` draws one run of glyphs; this decides which runs there are and
 * where each one goes. The two are separate because wrapping is a property of
 * the window and drawing is a property of the font, and this project got the
 * font last (ADR 0032).
 *
 * ## The window is the game's, not this renderer's
 *
 * An AGOS script defines its own windows (`o_defWindow`) and selects one
 * (`o_window`), and dialogue goes into whichever is selected. So nothing here
 * decides where text belongs — it is handed the rectangle the game declared,
 * and the fallback for a game that has not declared one yet is stated as a
 * fallback rather than dressed up as a layout.
 *
 * **The units are the games' own and are worth naming**, because they differ
 * per axis and per field: a window's `x`, `width` and `height` are counted in
 * character cells and only its `y` is in pixels. The reference writes
 * `window->x * 8`, `window->width * 8` and `window->height * 8` and leaves `y`
 * alone, four times over in `window.cpp`.
 *
 * `height` was read here as pixels, which made every text window six pixels
 * tall — one line's worth. A message too long for the window then had nowhere
 * to wrap to and drew on top of itself, and Simon 1's credits came out as four
 * sentences in one band. It is the kind of mistake that misplaces text without
 * corrupting anything, which is why the units are written down here where
 * somebody checking them against a real release can find them.
 *
 * ## Newest last, oldest dropped
 *
 * A window holds as many lines as it has room for, and a game says more than
 * that over its life. What a player needs is the most recent, so the oldest
 * scroll off the top — which is also what the originals do, and means a window
 * never grows past its own rectangle.
 */

import { drawTextRun, type DrawTextTarget, type GlyphSource } from './drawText.js';
import type { TextDirection } from './textLayout.js';

/** A window as an AGOS script declares it. */
export interface AgosWindow {
  /** In 8-pixel columns. */
  readonly x: number;
  /** In pixels. */
  readonly y: number;
  /** In 8-pixel columns. */
  readonly width: number;
  /**
   * In **rows**, not pixels.
   *
   * `o_defWindow`'s fifth operand, and the reference multiplies it by eight
   * wherever it needs a pixel height (`window->height * 8`, four times over in
   * `window.cpp`). Documented here as pixels and used as pixels, it made every
   * text window six pixels tall — so a wrapped line had nowhere to go but on
   * top of the line above it, and Simon 1's credits drew four sentences into one
   * band.
   */
  readonly height: number;
}

export interface DrawWindowOptions {
  readonly window: AgosWindow;
  readonly colour: number;
  readonly direction?: TextDirection;
  /** The glyph box, which is the font's height and eight wide. */
  readonly glyphWidth?: number;
  readonly lineHeight?: number;
}

export interface DrawWindowResult {
  readonly lines: number;
  /** Characters the font had no glyph for, without repeats. */
  readonly missing: readonly string[];
}

/**
 * Breaks a message into lines that fit a window's width.
 *
 * On spaces where it can and mid-word where it cannot, because a word longer
 * than the window is a real thing — a long item name in a narrow inventory
 * window — and dropping it would lose text the game meant to show.
 */
export function wrapText(text: string, columns: number): string[] {
  if (columns <= 0) return [];
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(' ')) {
      let rest = word;
      while (rest.length > columns) {
        if (line !== '') {
          lines.push(line);
          line = '';
        }
        lines.push(rest.slice(0, columns));
        rest = rest.slice(columns);
      }
      const joined = line === '' ? rest : `${line} ${rest}`;
      if (joined.length > columns) {
        lines.push(line);
        line = rest;
      } else {
        line = joined;
      }
    }
    lines.push(line);
  }
  return lines;
}

/**
 * Draws the messages a game has said into the window it selected.
 *
 * Returns what it drew and what it could not, for the same reason
 * `drawTextRun` does: a character the font lacks is a fact about the font, and
 * a caller that can name it can tell a font problem from a text one.
 */
export function drawTextWindow(
  target: DrawTextTarget,
  messages: readonly string[],
  glyphs: GlyphSource,
  options: DrawWindowOptions,
): DrawWindowResult {
  const glyphWidth = options.glyphWidth ?? 8;
  const lineHeight = options.lineHeight ?? 8;
  const { window } = options;

  const boxWidth = window.width * glyphWidth;
  const columns = Math.floor(boxWidth / glyphWidth);
  // Rows, because that is the unit `height` is in. Not `height / lineHeight`,
  // which asked how many lines fit in six *pixels* and answered nought or one.
  const rows = window.height;
  if (columns <= 0 || rows <= 0) return { lines: 0, missing: [] };

  const wrapped: string[] = [];
  for (const message of messages) wrapped.push(...wrapText(message, columns));
  const shown = wrapped.slice(Math.max(0, wrapped.length - rows));

  const missing = new Set<string>();
  let drawnLines = 0;
  for (let row = 0; row < shown.length; row += 1) {
    const result = drawTextRun(target, shown[row] ?? '', glyphs, {
      x: window.x * glyphWidth,
      y: window.y + row * lineHeight,
      colour: options.colour,
      ...(options.direction ? { direction: options.direction } : {}),
      boxWidth,
    });
    for (const character of result.missing) missing.add(character);
    drawnLines += 1;
  }

  return { lines: drawnLines, missing: [...missing] };
}
