/**
 * Editing a SCI palette colour by colour (`docs/editor-parity.md` row 24).
 *
 * The other three families answer this row Yes; SCI answered No with its
 * palettes sitting unopened in **Carried through**. The writer here patches the
 * three bytes each colour was read from and touches nothing else, which is the
 * same decision `writeSciView` and `writeSciCursor` already make — so an
 * unedited write is byte-identical **by construction** rather than by care.
 *
 * These hold that construction: the round trip, the blast radius of one edit,
 * and the two ways a caller can be wrong about which colours a resource holds.
 */

import { describe, expect, it } from 'vitest';

import {
  applySciPalette,
  readSciPalette,
  writeSciPalette,
} from '../src/engine/sci/gfx/sciPalette.js';
import { Palette } from '../src/engine/gfx/Palette.js';

/**
 * A palette resource in Sierra's shape: 37 bytes of header with the start index
 * at 25, the count at 29 and the used-flag marker at 32, then four bytes an
 * entry — a used flag and a triple.
 */
function palette(
  colours: ReadonlyArray<[number, number, number]>,
  { start = 0, used = true, tail = [0xde, 0xad] } = {},
): Uint8Array {
  const bytes = new Uint8Array(37 + colours.length * (used ? 4 : 3) + tail.length);
  // Header bytes this reader does not understand, kept deliberately non-zero so
  // a writer that rebuilt the resource would show up as a difference.
  for (let i = 0; i < 25; i++) bytes[i] = 0x40 + i;
  bytes[25] = start;
  bytes[29] = colours.length & 0xff;
  bytes[30] = (colours.length >> 8) & 0xff;
  bytes[32] = used ? 0 : 1;
  bytes[33] = 0x5a;
  colours.forEach(([r, g, b], i) => {
    const at = 37 + i * (used ? 4 : 3);
    if (used) bytes[at] = i % 3 === 0 ? 0 : 1;
    bytes[at + (used ? 1 : 0)] = r;
    bytes[at + (used ? 2 : 1)] = g;
    bytes[at + (used ? 3 : 2)] = b;
  });
  bytes.set(tail, bytes.length - tail.length);
  return bytes;
}

describe('a palette resource is patched, never re-laid out', () => {
  it('writes back what it read and changes not one byte', () => {
    for (const used of [true, false]) {
      const bytes = palette(
        [
          [10, 20, 30],
          [40, 50, 60],
          [70, 80, 90],
        ],
        { start: 5, used },
      );
      const back = writeSciPalette(bytes, readSciPalette(bytes));
      expect([...back], `used flags: ${used}`).toEqual([...bytes]);
    }
  });

  it('changes only the colour named, and only its three bytes', () => {
    const bytes = palette([
      [10, 20, 30],
      [40, 50, 60],
      [70, 80, 90],
    ]);
    const entries = readSciPalette(bytes);
    const back = writeSciPalette(bytes, [{ index: entries[1].index, r: 1, g: 2, b: 3 }]);

    expect(readSciPalette(back)).toEqual([
      // The fixture clears every third entry's used flag, and the writer
      // leaves every flag alone.
      { index: 0, r: 10, g: 20, b: 30, used: false },
      { index: 1, r: 1, g: 2, b: 3, used: true },
      { index: 2, r: 70, g: 80, b: 90, used: true },
    ]);
    // Exactly three bytes differ, and the tail past the table is untouched.
    const differing = [...back].filter((value, at) => value !== bytes[at]);
    expect(differing).toHaveLength(3);
    expect([...back.slice(-2)]).toEqual([0xde, 0xad]);
  });

  /**
   * A palette's range is part of its structure. Widening one here would move
   * every byte after it, so an index the resource has not got is skipped.
   */
  it('skips an index this resource does not hold rather than growing it', () => {
    const bytes = palette([[10, 20, 30]], { start: 5 });
    const back = writeSciPalette(bytes, [{ index: 200, r: 1, g: 2, b: 3 }]);
    expect([...back]).toEqual([...bytes]);
    expect(back.length).toBe(bytes.length);
  });

  /**
   * The used flag says whether Sierra's own `set` submits the colour, not
   * whether the colour is in the resource — 88% of the entries King's Quest
   * VII's Views declare are marked unused, and an editor that refused them
   * would be refusing to edit most of the palette a game ships.
   */
  it('edits an entry Sierra marked unused, and leaves the flag alone', () => {
    const bytes = palette([
      [10, 20, 30],
      [40, 50, 60],
    ]);
    expect(bytes[37]).toBe(0); // entry 0's used flag, as the fixture set it
    const back = writeSciPalette(bytes, [{ index: 0, r: 7, g: 8, b: 9 }]);
    expect(back[37]).toBe(0);
    expect(readSciPalette(back)[0]).toEqual({ index: 0, r: 7, g: 8, b: 9, used: false });
  });

  it('clamps a colour outside a byte rather than wrapping it', () => {
    const bytes = palette([[10, 20, 30]]);
    const back = writeSciPalette(bytes, [{ index: 0, r: -5, g: 300, b: 128 }]);
    expect(readSciPalette(back)[0]).toEqual({ index: 0, r: 0, g: 255, b: 128, used: false });
  });

  it('answers a resource too short to hold a table with the bytes it was given', () => {
    const stub = new Uint8Array(12).fill(3);
    expect([...writeSciPalette(stub, [{ index: 0, r: 1, g: 2, b: 3 }])]).toEqual([...stub]);
  });
});

/**
 * The other half of the used flag, and the half that is not about editing.
 *
 * `GfxPalette32::mergePalette` copies an entry only when it is used, and
 * SCI16's `GfxPalette::set` tests the same bit. A reader that dropped the flag
 * and an apply that submitted the whole declared range was King's Quest VII's
 * first gameplay room rendering as a black frame: the scenery composited
 * correctly in indices 104 to 235, and one View loaded into the room declares
 * 72 to 255 and means 22 of them.
 */
describe('a palette merge submits the entries the resource says it means', () => {
  it('leaves a colour an unused entry names alone, and takes a used one', () => {
    const screen = new Palette();
    screen.setColor(0, 9, 9, 9);
    screen.setColor(1, 9, 9, 9);
    screen.setColor(2, 9, 9, 9);

    applySciPalette(screen, [
      { index: 0, r: 1, g: 2, b: 3, used: true },
      { index: 1, r: 4, g: 5, b: 6, used: false },
      // No flag at all: a vector Picture's own palette operation and a video
      // frame both name exactly what they set.
      { index: 2, r: 7, g: 8, b: 9 },
    ]);

    expect(screen.getColor(0)).toEqual([1, 2, 3]);
    expect(screen.getColor(1)).toEqual([9, 9, 9]);
    expect(screen.getColor(2)).toEqual([7, 8, 9]);
  });

  /**
   * The shape that actually bit: a resource declaring a wide range with most
   * of it zero and unused, submitted over a range something else had filled.
   */
  it('does not black a range a wide mostly-unused resource merely covers', () => {
    const screen = new Palette();
    for (let index = 104; index <= 235; index++) screen.setColor(index, 200, 100, 50);

    const wide = [];
    for (let index = 72; index <= 255; index++) {
      wide.push({ index, r: 0, g: 0, b: 0, used: index >= 72 && index < 94 });
    }
    applySciPalette(screen, wide);

    expect(screen.getColor(104)).toEqual([200, 100, 50]);
    expect(screen.getColor(235)).toEqual([200, 100, 50]);
    expect(screen.getColor(80)).toEqual([0, 0, 0]);
  });
});
