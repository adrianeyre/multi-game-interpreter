import { chunk, u16le, u32le } from './encode.js';
import {
  FONT_FIRST_CHAR,
  FONT_GLYPH_HEIGHT,
  FONT_GLYPH_WIDTH,
  FONT_LAST_CHAR,
  FONT_ROWS,
} from './font.js';

const NUM_CHARS = 256;
/** Offsets inside a CHAR resource are relative to byte 29 of the chunk. */
const FONT_BASE = 29;

export interface CharsetOptions {
  /** Extra pixels of space after each glyph. */
  letterSpacing?: number;
  /** Palette indices for colour values 1..15. Value 1 is the text colour. */
  colorMap?: number[];
}

/**
 * Builds a `CHAR` resource from the built-in font.
 *
 * The layout the engine expects:
 *
 *   0   'CHAR' + big-endian size
 *   8   little-endian size, magic word
 *   14  15 byte colour map
 *   29  bits per pixel, line height, glyph count
 *   33  glyph offset table, one 32 bit offset per glyph, relative to byte 29
 *
 * Glyphs are 1 bit per pixel, which is what the games' dialogue fonts use.
 */
export function buildCharset(options: CharsetOptions = {}): number[] {
  const letterSpacing = options.letterSpacing ?? 1;

  const header = [1, FONT_GLYPH_HEIGHT + 1, ...u16le(NUM_CHARS)];
  const tableSize = NUM_CHARS * 4;

  const glyphs: number[] = [];
  const offsets = new Array<number>(NUM_CHARS).fill(0);

  for (let code = FONT_FIRST_CHAR; code <= FONT_LAST_CHAR; code++) {
    const rowBase = (code - FONT_FIRST_CHAR) * FONT_GLYPH_HEIGHT;

    // Glyph header: width, height, x bearing, y bearing. The width recorded
    // here is the drawn width; the engine adds the bearing to get the advance,
    // which is where letter spacing comes from.
    const glyph: number[] = [FONT_GLYPH_WIDTH, FONT_GLYPH_HEIGHT, letterSpacing, 1];

    // Each row is FONT_GLYPH_WIDTH bits, packed MSB first, continuing across
    // row boundaries — the bit stream is not byte-aligned per row.
    const bits: number[] = [];
    for (let row = 0; row < FONT_GLYPH_HEIGHT; row++) {
      const rowBits = FONT_ROWS[rowBase + row];
      for (let x = 0; x < FONT_GLYPH_WIDTH; x++) {
        bits.push((rowBits >> (7 - x)) & 1);
      }
    }
    for (let i = 0; i < bits.length; i += 8) {
      let byte = 0;
      for (let b = 0; b < 8; b++) byte = (byte << 1) | (bits[i + b] ?? 0);
      glyph.push(byte);
    }

    offsets[code] = header.length + tableSize + glyphs.length;
    glyphs.push(...glyph);
  }

  const table: number[] = [];
  for (const offset of offsets) table.push(...u32le(offset));

  // Bytes 8..28 of the chunk: a little-endian size, the magic word, then the
  // 15 entry colour map.
  const colorMap = options.colorMap ?? new Array(15).fill(15);
  const preamble: number[] = [...u32le(0), 0x3c, 0x36, ...colorMap.slice(0, 15)];
  while (preamble.length < FONT_BASE - 8) preamble.push(15);

  return chunk('CHAR', [...preamble, ...header, ...table, ...glyphs]);
}

/** Advance width of a string in the built-in font, for laying out verbs. */
export function measureText(text: string, letterSpacing = 1): number {
  let width = 0;
  for (const character of text) {
    const code = character.charCodeAt(0);
    if (code < FONT_FIRST_CHAR || code > FONT_LAST_CHAR) continue;
    width += FONT_GLYPH_WIDTH + letterSpacing;
  }
  return width;
}

export { FONT_GLYPH_HEIGHT, FONT_GLYPH_WIDTH };
