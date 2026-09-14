import { readU32LE } from '../util/ByteStream.js';
import type { RoomGraphics } from './RoomGraphics.js';
import type { Screen } from './Screen.js';
import { SCREEN_WIDTH } from './Screen.js';

/**
 * A SCUMM bitmap font (a `CHAR` resource).
 *
 * Layout, from the start of the chunk:
 *
 *   0   'CHAR' + big-endian size          (the standard chunk header)
 *   8   little-endian size, magic word
 *   14  15 byte colour map
 *   29  bits per pixel, line height, glyph count (16 bit)
 *   33  glyph offset table, one 32 bit offset per glyph
 *
 * Glyph offsets are relative to byte 29, so that is the base the renderer
 * keeps rather than the chunk start.
 *
 * **Before v5 the same font arrives eight bytes earlier.** A v2-v4 charset is
 * not a chunk inside the game data at all: it is a whole file, `901.LFL` for
 * v4 and `99.LFL` for v3, opening with its own little-endian size where v5 has
 * a four character tag and a big-endian one in front of that. Everything from
 * the magic word on is identical, so the only difference is the base — and it
 * is not a guess: all four Loom CD charsets read one or two bits per pixel,
 * heights of 8, 10, 8 and 15, and 256 glyphs at base 21, and nothing sensible
 * at base 29.
 */
export class Charset {
  readonly id: number;
  private readonly data: Uint8Array;
  /** Offset of byte 29 — the base all glyph offsets are relative to. */
  private readonly base: number;

  readonly bitsPerPixel: number;
  readonly fontHeight: number;
  readonly numChars: number;

  /** Palette indices for glyph colour values 0..15. */
  readonly colorMap = new Uint8Array(16);

  constructor(id: number, data: Uint8Array, version = 5) {
    this.id = id;
    this.data = data;
    // Three bases, and the two below v5 differ by the width of the size field
    // the file opens with: v4 writes a 32-bit one and v3 and v2 a 16-bit one,
    // and this engine hands the whole file over rather than the bytes past it.
    this.base = version >= 5 ? 29 : version === 4 ? 21 : 19;

    this.bitsPerPixel = data[this.base] ?? 1;
    this.fontHeight = data[this.base + 1] ?? 8;
    this.numChars = ((data[this.base + 3] ?? 0) << 8) | (data[this.base + 2] ?? 0);

    // Colour values above 1 come from the font's own map; value 1 is the
    // caller's text colour and is filled in per string.
    // The colour map sits fifteen bytes before the base in both layouts, so
    // it moves with it rather than being a second constant to keep in step.
    const colourMap = this.base - 15;
    for (let i = 0; i < 15; i++) this.colorMap[i + 1] = data[colourMap + i] ?? 15;
  }

  private glyphOffset(chr: number): number {
    if (chr < 0 || chr >= this.numChars) return 0;
    const offset = readU32LE(this.data, this.base + chr * 4 + 4);
    if (offset === 0 || this.base + offset >= this.data.length) return 0;
    return this.base + offset;
  }

  /** Advance width including the glyph's left bearing. */
  getCharWidth(chr: number): number {
    const offset = this.glyphOffset(chr);
    if (offset === 0) return 0;
    const width = this.data[offset];
    const bearing = (this.data[offset + 2] << 24) >> 24; // sign extend
    return width + bearing;
  }

  getStringWidth(text: string): number {
    let width = 0;
    for (let i = 0; i < text.length; i++) width += this.getCharWidth(text.charCodeAt(i));
    return width;
  }

  /**
   * Draws one glyph and returns how far to advance.
   *
   * `roomGraphics` and `zPlane` let text be clipped by scenery, which the
   * engine uses for speech that should appear behind foreground objects.
   */
  drawChar(
    screen: Screen,
    chr: number,
    x: number,
    y: number,
    color: number,
    roomGraphics?: RoomGraphics,
    roomOriginX = 0,
    roomOriginY = 0,
    zPlane = 0,
  ): number {
    const offset = this.glyphOffset(chr);
    if (offset === 0) return 0;

    const width = this.data[offset];
    const height = this.data[offset + 1];
    const offsX = (this.data[offset + 2] << 24) >> 24;
    const offsY = (this.data[offset + 3] << 24) >> 24;

    this.colorMap[1] = color;

    const bpp = this.bitsPerPixel;
    let bitPos = 0;
    let byteOffset = offset + 4;
    let bits = this.data[byteOffset++] ?? 0;

    const drawX = x + offsX;
    const drawY = y + offsY;

    for (let row = 0; row < height; row++) {
      for (let column = 0; column < width; column++) {
        const value = (bits >> (8 - bpp)) & 0xff;
        if (value !== 0) {
          const px = drawX + column;
          const py = drawY + row;
          const occluded =
            roomGraphics && zPlane > 0
              ? roomGraphics.isMasked(zPlane, px + roomOriginX, py - roomOriginY)
              : false;
          if (!occluded) screen.putPixel(px, py, this.colorMap[value & 0x0f]);
        }
        bits = (bits << bpp) & 0xff;
        bitPos += bpp;
        if (bitPos === 8) {
          bits = this.data[byteOffset++] ?? 0;
          bitPos = 0;
        }
      }
    }

    return width + offsX;
  }

  /** Draws a single line and returns the x position after the last glyph. */
  drawString(
    screen: Screen,
    text: string,
    x: number,
    y: number,
    color: number,
    roomGraphics?: RoomGraphics,
    roomOriginX = 0,
    roomOriginY = 0,
    zPlane = 0,
  ): number {
    let cursor = x;
    for (let i = 0; i < text.length; i++) {
      cursor += this.drawChar(
        screen,
        text.charCodeAt(i),
        cursor,
        y,
        color,
        roomGraphics,
        roomOriginX,
        roomOriginY,
        zPlane,
      );
    }
    return cursor;
  }
}

/**
 * Breaks a string into lines that fit `maxWidth`.
 *
 * SCUMM strings carry explicit newlines (0xFF 0x01 and 0xFF 0x02 escapes,
 * already decoded to '\n' by the string decoder), but long lines still need
 * wrapping because the games were authored against a specific font and the
 * text box is centred on the speaker.
 */
export function wrapText(charset: Charset, text: string, maxWidth: number): string[] {
  const lines: string[] = [];

  for (const paragraph of text.split('\n')) {
    if (paragraph === '') {
      lines.push('');
      continue;
    }
    let current = '';
    for (const word of paragraph.split(' ')) {
      const candidate = current === '' ? word : `${current} ${word}`;
      if (charset.getStringWidth(candidate) <= maxWidth || current === '') {
        current = candidate;
      } else {
        lines.push(current);
        current = word;
      }
    }
    if (current !== '') lines.push(current);
  }

  return lines;
}

/**
 * Positions a block of speech so it stays on screen and above the speaker.
 *
 * The original clamps to the text area rather than to the whole screen, which
 * is why dialogue never overlaps the verb panel even for actors standing at
 * the bottom of a room.
 */
export function layoutSpeech(
  charset: Charset,
  lines: string[],
  centreX: number,
  topY: number,
  minY: number,
  maxY: number,
): Array<{ text: string; x: number; y: number }> {
  const lineHeight = charset.fontHeight;
  const blockHeight = lines.length * lineHeight;

  let y = topY - blockHeight;
  if (y < minY) y = minY;
  if (y + blockHeight > maxY) y = Math.max(minY, maxY - blockHeight);

  return lines.map((line, index) => {
    const width = charset.getStringWidth(line);
    let x = centreX - (width >> 1);
    if (x < 0) x = 0;
    if (x + width > SCREEN_WIDTH) x = Math.max(0, SCREEN_WIDTH - width);
    return { text: line, x, y: y + index * lineHeight };
  });
}
