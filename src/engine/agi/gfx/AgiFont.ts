/**
 * An 8x8 text font for AGI's status line, messages and Parser input line.
 *
 * `src/engine/gfx/Charset.ts` is SCUMM's text layout and is not reused: a SCUMM
 * game ships its own character set as a resource, so `Charset` reads one out of
 * game data. AGI's font lives in the **interpreter**, not in the game files —
 * which is the whole reason this file exists at all, and the reason it cannot be
 * read from a game the way a SCUMM charset can.
 *
 * **This font is ours, not Sierra's.** Shipping Sierra's would mean either
 * transcribing it from another project or extracting it from an interpreter
 * binary, and neither is something to do from memory: a glyph table that is
 * *nearly* right produces text that looks subtly wrong everywhere, and there is
 * no test that catches it. What is here is a legible 8x8 set in the same metrics
 * — eight pixels by eight, forty columns across the 320-pixel display, 25 rows
 * down — so every layout AGI's own text commands describe lands in the right
 * place.
 *
 * Reading the authentic font out of a shipped interpreter, where a game
 * includes one, would be a strict improvement and is left as one.
 */

/**
 * Glyph rows for ASCII 32 to 126, eight bytes each.
 *
 * One byte per row, most significant bit leftmost, so bit 7 of the first byte
 * is a glyph's top-left pixel. Written as hex because ninety-five glyphs of
 * eight numbers each is unreadable as an array either way, and this at least
 * lines up in columns.
 */
const GLYPHS_HEX =
  '0000000000000000' + // space
  '1818181818001800' + // !
  '6c6c480000000000' + // "
  '36367f367f363600' + // #
  '0c3f683e0b7e1800' + // $
  '0063660c18336300' + // %
  '1c361c6e3b336e00' + // &
  '1818300000000000' + // '
  '0c18303030180c00' + // (
  '30180c0c0c183000' + // )
  '00663cff3c660000' + // *
  '0018187e18180000' + // +
  '0000000000181830' + // ,
  '0000007e00000000' + // -
  '0000000000181800' + // .
  '03060c183060c000' + // /
  '3e636f7b63633e00' + // 0
  '1838181818187e00' + // 1
  '3e63031e30637f00' + // 2
  '3e63031e03633e00' + // 3
  '060e1e367f060600' + // 4
  '7f607e0303633e00' + // 5
  '1e30607e63633e00' + // 6
  '7f63060c18181800' + // 7
  '3e63633e63633e00' + // 8
  '3e63633f03063c00' + // 9
  '0018180000181800' + // :
  '0018180000181830' + // ;
  '0c18306030180c00' + // <
  '0000007e007e0000' + // =
  '30180c060c183000' + // >
  '3e63060c18001800' + // ?
  '3e636f6b6f603e00' + // @
  '1c3663637f636300' + // A
  '7e33333e33337e00' + // B
  '1e33606060331e00' + // C
  '7c36333333367c00' + // D
  '7f33303c30337f00' + // E
  '7f33303c30307800' + // F
  '1e33606f63331d00' + // G
  '6363637f63636300' + // H
  '7e18181818187e00' + // I
  '0f06060666663c00' + // J
  '63666c786c666300' + // K
  '7830303030337f00' + // L
  '63777f6b63636300' + // M
  '63737b6f67636300' + // N
  '3e63636363633e00' + // O
  '7e33333e30307800' + // P
  '3e6363636b6e3b00' + // Q
  '7e33333e3c367300' + // R
  '3e63603e03633e00' + // S
  '7e5a181818183c00' + // T
  '6363636363633e00' + // U
  '6363636363361c00' + // V
  '6363636b7f776300' + // W
  '63361c1c1c366300' + // X
  '6666663c18183c00' + // Y
  '7f63060c18337f00' + // Z
  '3c30303030303c00' + // [
  'c06030180c060300' + // backslash
  '3c0c0c0c0c0c3c00' + // ]
  '081c366300000000' + // ^
  '00000000000000ff' + // _
  '18180c0000000000' + // `
  '00003e033f633f00' + // a
  '60607e6363637e00' + // b
  '00003e6360633e00' + // c
  '03033f6363633f00' + // d
  '00003e637f603e00' + // e
  '0e187e1818181800' + // f
  '00003f63633f031e' + // g
  '60607e6363636300' + // h
  '1800381818183c00' + // i
  '06000e060606663c' + // j
  '6060666c786c6600' + // k
  '3818181818183c00' + // l
  '00007e6b6b6b6b00' + // m
  '00007e6363636300' + // n
  '00003e6363633e00' + // o
  '00007e63637e6060' + // p
  '00003f63633f0303' + // q
  '00006e3330307800' + // r
  '00003e603e033e00' + // s
  '18187e1818180e00' + // t
  '0000636363633f00' + // u
  '0000636363361c00' + // v
  '0000636b6b7f3600' + // w
  '000063361c366300' + // x
  '00006363633f031e' + // y
  '00007f061c307f00' + // z
  '0e18187018180e00' + // {
  '1818181818181800' + // |
  '7018180e18187000' + // }
  '00327e4c00000000'; // ~

export const GLYPH_WIDTH = 8;
export const GLYPH_HEIGHT = 8;

/** Forty columns across a 320-pixel display, and 25 rows down 200. */
export const TEXT_COLUMNS = 40;
export const TEXT_ROWS = 25;

const FIRST_CHARACTER = 32;
const LAST_CHARACTER = 126;

const GLYPHS = (() => {
  const count = LAST_CHARACTER - FIRST_CHARACTER + 1;
  const data = new Uint8Array(count * GLYPH_HEIGHT);
  for (let index = 0; index < data.length; index++) {
    data[index] = Number.parseInt(GLYPHS_HEX.slice(index * 2, index * 2 + 2), 16) || 0;
  }
  return data;
})();

/** The eight rows of one character's glyph. */
export function glyphRows(character: number): Uint8Array {
  if (character < FIRST_CHARACTER || character > LAST_CHARACTER) {
    // Anything outside printable ASCII draws as a blank rather than as
    // whatever byte happened to follow the table.
    return new Uint8Array(GLYPH_HEIGHT);
  }
  const at = (character - FIRST_CHARACTER) * GLYPH_HEIGHT;
  return GLYPHS.subarray(at, at + GLYPH_HEIGHT);
}

/**
 * Draws one character into a 320-wide framebuffer at a pixel position.
 *
 * `background` of -1 leaves the pixels behind the glyph alone, which is what
 * `display` does over a picture; a colour fills the whole 8x8 cell, which is
 * what a text window does.
 */
export function drawCharacter(
  target: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  character: number,
  foreground: number,
  background = -1,
): void {
  const rows = glyphRows(character);
  for (let row = 0; row < GLYPH_HEIGHT; row++) {
    const screenY = y + row;
    if (screenY < 0 || screenY >= height) continue;
    const bits = rows[row];

    for (let column = 0; column < GLYPH_WIDTH; column++) {
      const screenX = x + column;
      if (screenX < 0 || screenX >= width) continue;
      const lit = (bits & (0x80 >> column)) !== 0;
      if (!lit && background < 0) continue;
      target[screenY * width + screenX] = lit ? foreground : background;
    }
  }
}

/** Draws a string, one 8x8 cell per character, clipped at the right edge. */
export function drawText(
  target: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  text: string,
  foreground: number,
  background = -1,
): void {
  for (const [index, character] of [...text].entries()) {
    drawCharacter(
      target,
      width,
      height,
      x + index * GLYPH_WIDTH,
      y,
      character.charCodeAt(0),
      foreground,
      background,
    );
  }
}

/**
 * Wraps a message to a width in characters.
 *
 * AGI's own window sizing: it breaks on spaces and lets a word longer than the
 * line overflow rather than hyphenating, and an explicit newline in a message
 * is a break the author asked for.
 */
export function wrapMessage(text: string, columns: number): string[] {
  const lines: string[] = [];

  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(' ')) {
      if (line.length === 0) {
        line = word;
        continue;
      }
      if (line.length + 1 + word.length <= columns) {
        line += ` ${word}`;
        continue;
      }
      lines.push(line);
      line = word;
    }
    lines.push(line);
  }

  return lines;
}
