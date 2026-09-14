/**
 * Drawing and measuring text with a SCI `font` resource.
 *
 * There was nothing here before: `TextSize` answered `0:0` and `Display` drew
 * nothing, so a SCI game's entire interface — every window, every line of
 * dialogue, every menu — was invisible while the scripts behind it ran
 * correctly. That is the fault class `verifying-version-support.md` names, seen
 * from its worst end: the game is doing exactly the right thing and the screen
 * is empty.
 *
 * **`TextSize` is the half that changes what a game believes.** A script asks
 * how wide a string is and then centres a window on the answer, sizes a button
 * to it, or decides how many lines fit. Answering zero does not make the text
 * invisible — it makes every window one pixel wide and every layout wrong, and
 * the script has no way to know. So measurement is implemented before drawing
 * is, and it is measured from the font rather than estimated.
 *
 * Line breaking is Sierra's: a newline breaks, and a width breaks at the last
 * space that fits. A word longer than the width is not broken, because a game
 * that asks for a 20-pixel-wide window and gets a hyphenated word has been
 * given something it did not ask for and cannot detect.
 */

import type { SciFontResource } from './SciFont.js';

export interface SciTextMetrics {
  width: number;
  height: number;
  /** The lines as they would be drawn, so drawing and measuring cannot disagree. */
  lines: string[];
}

/** How wide one line is in a font, in pixels. */
export function sciTextWidth(font: SciFontResource, text: string): number {
  let width = 0;
  for (const character of text) {
    width += font.glyphs[character.charCodeAt(0)]?.width ?? 0;
  }
  return width;
}

/**
 * Measures a string, breaking it to `maxWidth` where one is given.
 *
 * `maxWidth` of zero means "do not break", which is what a script passes when
 * it wants the natural width of a single line.
 */
export function measureSciText(font: SciFontResource, text: string, maxWidth = 0): SciTextMetrics {
  const lines: string[] = [];

  for (const paragraph of text.split('\n')) {
    if (maxWidth <= 0) {
      lines.push(paragraph);
      continue;
    }

    let line = '';
    for (const word of paragraph.split(' ')) {
      const candidate = line === '' ? word : `${line} ${word}`;
      if (line !== '' && sciTextWidth(font, candidate) > maxWidth) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    lines.push(line);
  }

  return {
    width: Math.max(0, ...lines.map((line) => sciTextWidth(font, line))),
    height: lines.length * font.lineHeight,
    lines,
  };
}

/**
 * Draws text into an 8-bit buffer.
 *
 * `colour` is a palette index and `background` is one too, or null to leave
 * what is underneath — which is the difference between a line of dialogue in a
 * window and one over a room.
 *
 * Clipped rather than wrapped at the buffer's edge: a script that positions
 * text off-screen has made a mistake this should not hide by moving it.
 */
export function drawSciText(
  target: Uint8Array,
  targetWidth: number,
  targetHeight: number,
  font: SciFontResource,
  text: string,
  options: {
    x: number;
    y: number;
    colour: number;
    background?: number | null;
    maxWidth?: number;
  },
): SciTextMetrics {
  const metrics = measureSciText(font, text, options.maxWidth ?? 0);
  const background = options.background ?? null;

  let y = options.y;
  for (const line of metrics.lines) {
    let x = options.x;
    for (const character of line) {
      const glyph = font.glyphs[character.charCodeAt(0)];
      if (!glyph) continue;
      for (let row = 0; row < glyph.height; row++) {
        const destinationY = y + row;
        if (destinationY < 0 || destinationY >= targetHeight) continue;
        for (let column = 0; column < glyph.width; column++) {
          const destinationX = x + column;
          if (destinationX < 0 || destinationX >= targetWidth) continue;
          const inked = glyph.pixels[row * glyph.width + column] === 1;
          if (inked) target[destinationY * targetWidth + destinationX] = options.colour;
          else if (background !== null) {
            target[destinationY * targetWidth + destinationX] = background;
          }
        }
      }
      x += glyph.width;
    }
    y += font.lineHeight;
  }

  return metrics;
}
