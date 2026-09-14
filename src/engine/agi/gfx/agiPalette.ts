/**
 * AGI's sixteen colours, and the priority bands baked into a Picture.
 *
 * `src/engine/gfx/Palette.ts` holds 256 entries and narrows to sixteen without
 * changing, which is what ADR 0011 predicted — so this file supplies the values
 * rather than a second palette class.
 */

import type { Palette } from '../../gfx/Palette.js';

/**
 * The standard EGA sixteen, as AGI's interpreter programmed the DAC.
 *
 * These are the full 8-bit values rather than the 6-bit ones a VGA palette
 * chunk holds, so `Palette.normaliseDepth` must not be applied to them: it
 * scales a palette whose entries all fit in six bits, and 0xAA does not.
 */
export const AGI_EGA_PALETTE: ReadonlyArray<readonly [number, number, number]> = [
  [0x00, 0x00, 0x00], // 0  black
  [0x00, 0x00, 0xaa], // 1  blue
  [0x00, 0xaa, 0x00], // 2  green
  [0x00, 0xaa, 0xaa], // 3  cyan
  [0xaa, 0x00, 0x00], // 4  red
  [0xaa, 0x00, 0xaa], // 5  magenta
  [0xaa, 0x55, 0x00], // 6  brown
  [0xaa, 0xaa, 0xaa], // 7  light grey
  [0x55, 0x55, 0x55], // 8  dark grey
  [0x55, 0x55, 0xff], // 9  bright blue
  [0x55, 0xff, 0x55], // 10 bright green
  [0x55, 0xff, 0xff], // 11 bright cyan
  [0xff, 0x55, 0x55], // 12 bright red
  [0xff, 0x55, 0xff], // 13 bright magenta
  [0xff, 0xff, 0x55], // 14 yellow
  [0xff, 0xff, 0xff], // 15 white
];

/** Loads the sixteen EGA colours into the shared palette, leaving the rest black. */
export function applyAgiPalette(palette: Palette): void {
  for (const [index, [red, green, blue]] of AGI_EGA_PALETTE.entries()) {
    palette.setColor(index, red, green, blue);
  }
  palette.markDirty();
}

/**
 * The colour a Picture's visual buffer starts as, and the one a fill spreads
 * over.
 *
 * White is the "nothing has been drawn here" sentinel, which is why a fill in
 * white is a no-op rather than a fill: there would be no way to tell where it
 * had reached.
 */
export const VISUAL_EMPTY = 15;

/** The priority a Picture's priority buffer starts as, and a fill's sentinel. */
export const PRIORITY_EMPTY = 4;

/** A Picture is stored 160 wide and doubled to 320 on output. */
export const PICTURE_WIDTH = 160;

/**
 * The rows of screen a Picture occupies.
 *
 * AGI's 320x200 display is three bands: a status line of one 8-pixel text row,
 * the picture, and up to three text rows at the bottom for the Parser input
 * line and its responses. 8 + 168 + 24 = 200.
 */
export const PICTURE_HEIGHT = 168;

/** The screen row the picture's first row is drawn at. */
export const PICTURE_TOP = 8;

/**
 * Priority band for a picture row, under AGI's default banding.
 *
 * The arithmetic, spelled out because a band off by one row produces a picture
 * that is plausible and wrong (#127):
 *
 * The 168 picture rows are cut into **fourteen** strips of twelve rows each
 * (14 x 12 = 168), numbered 1 to 14 from the top. Priorities 1, 2 and 3 are not
 * usable as bands — they are reserved for objects that must draw in front of or
 * behind everything — so the first four strips all clamp to 4. That makes the
 * usable bands 4 through 14, and the top 48 rows (four strips) share band 4.
 *
 *   band(y) = max(4, floor(y / 12) + 1)
 *
 * `+ 1` because the strips are numbered from one, not zero: row 0 is in strip 1
 * and row 12 is in strip 2. Dropping it shifts every band up by one strip,
 * which puts everything one row-band too far forward.
 *
 * Fifteen is not a band either. It is the value an object takes to be drawn in
 * front of everything, so `CONTEXT.md`'s "fifteen horizontal strips" is one
 * more than the number of strips a row can fall in.
 */
export function defaultPriorityForRow(y: number): number {
  const band = Math.floor(y / 12) + 1;
  return band < PRIORITY_EMPTY ? PRIORITY_EMPTY : Math.min(14, band);
}

/**
 * The priority band table, honouring `set.pri.base` when a game has set it.
 *
 * `set.pri.base` moves the horizon: every row above `base` is band 4 and the
 * rows below it spread bands 5 to 14 evenly. Gold Rush and a few others use it
 * to make a tall room's foreground behave, and a game that sets it and is
 * rendered with the default table has its whole depth ordering wrong from that
 * point on.
 */
export function priorityTable(base = 0): Uint8Array {
  const table = new Uint8Array(PICTURE_HEIGHT);
  if (base <= 0) {
    for (let y = 0; y < PICTURE_HEIGHT; y++) table[y] = defaultPriorityForRow(y);
    return table;
  }

  for (let y = 0; y < PICTURE_HEIGHT; y++) {
    table[y] =
      y < base
        ? PRIORITY_EMPTY
        : Math.min(14, Math.floor(((y - base) * 10) / (PICTURE_HEIGHT - base)) + 5);
  }
  return table;
}
