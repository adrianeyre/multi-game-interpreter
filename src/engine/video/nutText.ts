import { SCREEN_WIDTH } from '../gfx/Screen.js';
import type { NutFont } from './nut.js';
import { SMUSH_TEXT_FLAG, type SmushTextCue } from './smush.js';

/**
 * Drawing a SMUSH subtitle with a `.NUT` font.
 *
 * The two halves existed and nothing joined them: the container carries the
 * line and the rectangle it belongs in, and `nut.ts` reads the glyphs. This is
 * the join.
 *
 * Deliberately not `gfx/Charset`'s text drawing. That measures and draws a
 * `CHAR` resource, where a glyph is a fixed-pitch cel in the room's palette; a
 * `.NUT` glyph carries its own offsets and its own transparent colour, and the
 * pixels are palette indices the font chose. Sharing the layout code would mean
 * one of the two formats being described in the other's terms.
 *
 * (`SmushFont::drawString` and `NutRenderer::drawChar`.)
 */

/** What the original defaults to, and what `^c` overrides. */
const DEFAULT_COLOUR = 15;

/** A run of text with the colour and font it asked for. */
interface Segment {
  text: string;
  colour: number;
  font: number;
}

/**
 * Splits a line on its escape codes.
 *
 * `^cNNN` sets a colour and `^fN` a font, and they appear mid-line — a
 * character's name in one colour and their words in another. Read as literal
 * text they show up on screen as stray carets and digits, which is how a
 * subtitle system announces it is not reading its own control codes.
 */
export function parseTextSegments(line: string, skipEscapes = false): Segment[] {
  if (skipEscapes) return [{ text: line, colour: DEFAULT_COLOUR, font: 0 }];

  const segments: Segment[] = [];
  let colour = DEFAULT_COLOUR;
  let font = 0;
  let text = '';

  const flush = () => {
    if (text !== '') segments.push({ text, colour, font });
    text = '';
  };

  for (let i = 0; i < line.length; i++) {
    if (line[i] !== '^') {
      text += line[i];
      continue;
    }

    const code = line[i + 1];
    if (code === 'c' && /^\d\d\d/.test(line.slice(i + 2, i + 5))) {
      flush();
      colour = Number(line.slice(i + 2, i + 5));
      i += 4;
      continue;
    }
    if (code === 'f' && /^\d/.test(line.slice(i + 2, i + 3))) {
      flush();
      font = Number(line[i + 2]);
      i += 2;
      continue;
    }
    // A caret that is not an escape is a caret. The original passes it through
    // rather than dropping it, and a dropped character is a misspelled line.
    text += line[i];
  }

  flush();
  return segments.length > 0 ? segments : [{ text: '', colour, font }];
}

/** How wide a run of text is, in pixels, with a given font. */
export function measureText(font: NutFont, text: string): number {
  let width = 0;
  for (const character of text) {
    const glyph = font.glyphs[character.charCodeAt(0)];
    if (glyph) width += glyph.width + glyph.xOffset;
  }
  return width;
}

/**
 * Breaks a line into lines no wider than `limit`.
 *
 * On spaces only. Breaking mid-word would fit more text and read as a rendering
 * fault, and the original does not do it.
 */
export function wrapText(font: NutFont, text: string, limit: number): string[] {
  if (limit <= 0) return [text];

  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const candidate = line === '' ? word : `${line} ${word}`;
    if (line !== '' && measureText(font, candidate) > limit) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line !== '') lines.push(line);
  return lines.length > 0 ? lines : [''];
}

/** One glyph, at a pixel position, clipped to the screen and the cue's box. */
function drawGlyph(
  font: NutFont,
  code: number,
  x: number,
  y: number,
  target: Uint8Array,
  clip: { left: number; top: number; right: number; bottom: number },
): number {
  const glyph = font.glyphs[code];
  if (!glyph) return 0;

  const originX = x + glyph.xOffset;
  const originY = y + glyph.yOffset;

  for (let row = 0; row < glyph.height; row++) {
    const destY = originY + row;
    if (destY < clip.top || destY >= clip.bottom) continue;

    for (let column = 0; column < glyph.width; column++) {
      const pixel = glyph.pixels[row * glyph.width + column];
      // The glyph's own transparent colour, not zero: a `.NUT` picks it per
      // glyph, and treating zero as transparent everywhere punches holes in
      // any font whose outline is colour 0.
      if (pixel === glyph.transparency) continue;

      const destX = originX + column;
      if (destX < clip.left || destX >= clip.right) continue;
      target[destY * SCREEN_WIDTH + destX] = pixel;
    }
  }

  return glyph.width + glyph.xOffset;
}

/**
 * Draws one cue's line into the framebuffer.
 *
 * `fonts` is indexed as the `^f` escape indexes it, and a cue asking for a font
 * that is not loaded falls back to font 0 rather than drawing nothing — a line
 * in the wrong face is legible and a missing line is not.
 */
export function drawTextCue(
  cue: SmushTextCue,
  line: string,
  fonts: ReadonlyArray<NutFont | null>,
  target: Uint8Array,
): boolean {
  const primary = fonts[0] ?? fonts.find((font) => font !== null) ?? null;
  if (!primary) return false;

  const clip = {
    left: Math.max(0, cue.left),
    top: Math.max(0, cue.top),
    right: Math.min(SCREEN_WIDTH, cue.left + (cue.width || SCREEN_WIDTH)),
    bottom: Math.min(target.length / SCREEN_WIDTH, cue.top + (cue.height || 200)),
  };

  const centred = (cue.flags & SMUSH_TEXT_FLAG.Centre) !== 0;
  const segments = parseTextSegments(line, (cue.flags & SMUSH_TEXT_FLAG.SkipEscapes) !== 0);
  const plain = segments.map((segment) => segment.text).join('');

  const wrapped =
    (cue.flags & SMUSH_TEXT_FLAG.WordWrap) !== 0
      ? wrapText(primary, plain, clip.right - clip.left)
      : [plain];

  let y = cue.y;
  for (const row of wrapped) {
    const width = measureText(primary, row);
    // A centred cue's x is the centre of the line, not its left edge. Read as a
    // left edge, every centred subtitle sits half a line too far right.
    let x = centred ? cue.x - (width >> 1) : cue.x;

    for (const character of row) {
      const font = fonts[fontFor(segments, row, character)] ?? primary;
      x += drawGlyph(font, character.charCodeAt(0), x, y, target, clip);
    }
    y += primary.height;
  }
  return true;
}

/**
 * Which font a character in a wrapped row belongs to.
 *
 * Approximate on purpose, and the approximation is named: wrapping happens on
 * the joined text, so a per-character mapping back to its segment would need
 * the wrap to carry segment boundaries through it. The first segment's font is
 * used, which is right for every line that does not change font mid-sentence.
 */
function fontFor(segments: Segment[], _row: string, _character: string): number {
  return segments[0]?.font ?? 0;
}
