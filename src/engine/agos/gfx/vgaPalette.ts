/**
 * An AGOS palette bank.
 *
 * Colours live in the **script** resource rather than beside the pixels, and a
 * script picks a bank by number. That is why a room can change its colours
 * without any pixels moving: the bank changed, not the image.
 *
 * ## Two encodings, and Simon's is not the general one
 *
 * This file used to hold one reader — sixteen colours, each a big-endian word
 * of three four-bit components, from a table the resource's header points at.
 * That is the **old-bundle** encoding: Elvira 1, Elvira 2 and Waxworks.
 *
 * Simon 1 onwards replaced it, and the two disagree about everything except the
 * word "palette":
 *
 * |                | Old bundle          | Simon 1 onwards          |
 * | -------------- | ------------------- | ------------------------ |
 * | Table starts   | word at +6          | +6 itself                |
 * | Bytes per bank | 32                  | 96 (768 in AGOS 2)       |
 * | A colour is    | one `0RGB` word     | three bytes              |
 * | Widened by     | ×32 per nibble      | ×4 per byte              |
 * | Colours        | 16, always at 0     | 32 or 16, at `group×16`  |
 *
 * Reading Simon's banks with the old-bundle reader is what made the game draw
 * in black. Two bytes were taken where three belong, so every component came
 * out of the wrong byte and then out of the wrong *bank*; the top nibble of a
 * six-bit VGA component is usually zero, so the answer was black rather than
 * garish, and a black palette over correct pixels is indistinguishable from a
 * renderer that never drew.
 */

import type { VgaFileLayout } from './vgaFile.js';

/** Where the palette table sits in an old-bundle resource, per its own header. */
export function paletteTableOffset(scripts: Uint8Array): number {
  return ((scripts[6] ?? 0) << 8) | (scripts[7] ?? 0);
}

/** A bank of colours, and where in the 256-entry palette they belong. */
export interface VgaPaletteBank {
  /** The first palette index these colours occupy. */
  readonly base: number;
  /** RGB triples in 0..255. */
  readonly rgb: Uint8Array;
}

/**
 * Reads a palette bank.
 *
 * `group` is the first operand of `SET_PALETTE` and is not decoration: it says
 * both *how many* colours arrive and *where* they land. Group 0 brings
 * thirty-two — the room's own two banks in one go — and any other group brings
 * sixteen, sixteen indices up per group. That is how Simon addresses 256
 * colours with four-bit pixels: a cel's nibble picks a colour inside a bank and
 * the sprite's palette number picks the bank.
 */
export function readVgaPaletteBank(
  scripts: Uint8Array,
  group: number,
  bank: number,
  layout: VgaFileLayout = 'simon',
): VgaPaletteBank {
  if (layout === 'old-bundle') {
    const table = paletteTableOffset(scripts);
    const start = table + bank * 32;
    const rgb = new Uint8Array(16 * 3);
    for (let index = 0; index < 16; index += 1) {
      const at = start + index * 2;
      const colour = ((scripts[at] ?? 0) << 8) | (scripts[at + 1] ?? 0);
      // ×32 overshoots 255 for a top nibble, so it is clamped rather than
      // wrapped: a wrapped component turns a bright colour dark and reads as a
      // palette taken from the wrong offset.
      rgb[index * 3] = Math.min(255, ((colour & 0xf00) >> 8) * 32);
      rgb[index * 3 + 1] = Math.min(255, ((colour & 0x0f0) >> 4) * 32);
      rgb[index * 3 + 2] = Math.min(255, (colour & 0x00f) * 32);
    }
    return { base: 0, rgb };
  }

  const agos2 = layout === 'agos2';
  const count = agos2 ? 256 : group === 0 ? 32 : 16;
  const bankBytes = agos2 ? 768 : 96;
  const start = 6 + bank * bankBytes;
  const rgb = new Uint8Array(count * 3);
  for (let index = 0; index < count * 3; index += 1) {
    // Six-bit VGA components widened to eight, which is the same ×4 every
    // other family in this project does to a VGA palette.
    rgb[index] = Math.min(255, (scripts[start + index] ?? 0) * 4);
  }
  return { base: agos2 ? 0 : group * 16, rgb };
}

/**
 * The old-bundle reader, kept under its original name.
 *
 * Sixteen colours at index zero, which is what its one caller wants.
 */
export function readVgaPalette(scripts: Uint8Array, bank: number): Uint8Array {
  return readVgaPaletteBank(scripts, 0, bank, 'old-bundle').rgb;
}

/**
 * How many palette banks a zone's script resource holds.
 *
 * Nothing counts them, and nothing needs to at run time: a script names the
 * bank it wants and the reader goes to `6 + bank * 96`. An **editor** does need
 * to, because it has no script telling it which bank an image was drawn with —
 * so it offers the ones that are there and lets a person choose.
 *
 * The bound is the resource's own header block, which the palette table runs up
 * to: `readVgaFile` finds it through the pointer at the front, and a table that
 * overran it would be reading the header as colours. Clamped at zero for a
 * resource whose header sits before the table would even start, which is what a
 * zone holding something other than sprites looks like.
 */
export function countVgaPaletteBanks(headerAt: number, layout: VgaFileLayout = 'simon'): number {
  if (layout === 'old-bundle') return 0;
  const bankBytes = layout === 'agos2' ? 768 : 96;
  return Math.max(0, Math.floor((headerAt - 6) / bankBytes));
}

/**
 * A bank as the sixteen colours a four-bit pixel indexes.
 *
 * A table bank holds thirty-two, because `SET_PALETTE`'s group 0 loads two
 * screen banks in one go — so which half a sprite's nibble indexes depends on
 * the group the script asked for. Both halves are offered rather than guessed
 * at: the editor has no script to ask, and showing the wrong sixteen is how an
 * image comes out in colours the game never draws it in.
 */
export function readVgaPaletteHalf(
  scripts: Uint8Array,
  bank: number,
  half: 0 | 1,
  layout: VgaFileLayout = 'simon',
): number[][] {
  const full = readVgaPaletteBank(scripts, 0, bank, layout).rgb;
  const colours: number[][] = [];
  for (let index = 0; index < 16; index += 1) {
    const at = (half * 16 + index) * 3;
    colours.push([full[at] ?? 0, full[at + 1] ?? 0, full[at + 2] ?? 0]);
  }
  return colours;
}
