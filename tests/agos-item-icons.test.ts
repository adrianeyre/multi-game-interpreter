import { describe, expect, it } from 'vitest';
import {
  decodeItemIcon,
  iconsAreKnownFor,
  interfacePalette,
  itemIconNumber,
} from '../src/editor/agos/itemIcons.js';
import { renderIndexedImage } from '../src/editor/agos/imageFiles.js';
import type { AgosItem } from '../src/engine/agos/world/itemTree.js';

/**
 * An item's inventory icon, as a file.
 *
 * The mapping is the part worth pinning: "which picture belongs to this item"
 * is the question that had no established answer, and a wrong answer here is
 * not a broken export — it is a *plausible* export of some other item's
 * picture, which an author has no way to notice. So the flag, the bit counting
 * and the two geometries each get their own assertion.
 */

/** An item carrying an object sub-structure with the given mask and values. */
function objectItem(mask: number, values: readonly number[]): AgosItem {
  return {
    adjective: 0,
    noun: 0,
    state: 0,
    next: 0,
    child: 0,
    parent: 0,
    trailing: [0],
    classFlags: 0,
    childrenLead: 1,
    children: [{ type: 2, header: [mask], values }],
  } as unknown as AgosItem;
}

describe('which items have a picture', () => {
  it('reads the icon number as the value the icon bit sized', () => {
    // Bits 1, 4 and 6 set, so the record holds three values in that order and
    // bit 4 — `kOFIcon` — is the second of them. Indexing `values[4]` instead
    // would read past the end; indexing `values[1]` by accident is the bug
    // this counts bits to avoid.
    const item = objectItem(0b0101_0010, [11, 17, 23]);
    expect(itemIconNumber(item)).toBe(17);
  });

  it('says null rather than zero when the item carries no icon flag', () => {
    // Icon 0 is a real entry in `ICON.DAT`, so "no icon" cannot be zero — half
    // of each retail game's items would otherwise export whichever picture
    // happens to sit first in the file.
    expect(itemIconNumber(objectItem(0b0000_0010, [11]))).toBeNull();
  });

  it('says null for an item with no object sub-structure at all', () => {
    const room = {
      adjective: 0,
      noun: 0,
      state: 0,
      next: 0,
      child: 0,
      parent: 0,
      trailing: [0],
      classFlags: 0,
      childrenLead: 1,
      children: [{ type: 1, header: [0, 0], values: [] }],
    } as unknown as AgosItem;
    expect(itemIconNumber(room)).toBeNull();
  });

  it('offers icons only for the two Versions whose file layout has been read', () => {
    expect(iconsAreKnownFor('Simon1')).toBe(true);
    expect(iconsAreKnownFor('Simon2')).toBe(true);
    // Waxworks inherits the same *mapping* and a different file layout, so the
    // number would be right and the picture would be nonsense.
    expect(iconsAreKnownFor('Waxworks')).toBe(false);
    expect(decodeItemIcon(new Uint8Array(64), 0, 'Waxworks')).toContain('Simon 1 and Simon 2');
  });
});

/**
 * An RLE stream that fills a cell with one repeated nibble pair.
 *
 * A negative count is the repeat branch, and `reps = -k` runs `k + 1` times —
 * two pixels each — so the runs are sized to land exactly on the cell's last
 * column rather than relying on the decoder to stop short.
 */
function filledStream(iterations: number, pair: number): number[] {
  const bytes: number[] = [];
  let left = iterations;
  while (left > 0) {
    const step = Math.min(left, 128);
    bytes.push((256 - (step - 1)) & 0xff, pair);
    left -= step;
  }
  return bytes;
}

describe('decoding an icon out of ICON.DAT', () => {
  it('reads Simon 1’s one offset per icon into a 24 by 24 cell', () => {
    // `AGOSEngine_Simon1::drawIcon` (`icons.cpp:235`): `icon * 2`, one LE16
    // offset, one pass at base 224 over 24 columns of 12 double-steps.
    const stream = filledStream(24 * 12, 0x12);
    const file = Uint8Array.from([4, 0, 0, 0, ...stream]);

    const icon = decodeItemIcon(file, 0, 'Simon1');
    expect(typeof icon).not.toBe('string');
    if (typeof icon === 'string') return;

    expect([icon.width, icon.height]).toEqual([24, 24]);
    // A nibble ORed with the base, which is the whole reason an icon can only
    // ever use palette entries 208..239.
    expect(icon.pixels[0]).toBe(0xe1);
    expect(icon.pixels[24]).toBe(0xe2);
    expect([...icon.pixels].every((each) => each >= 208 && each <= 239)).toBe(true);
  });

  it('runs Simon 2’s second pass over the same cell at the second base', () => {
    // `AGOSEngine_Simon2::drawIcon` (`icons.cpp:209`): two offsets at `icon *
    // 4`, two passes at 224 then 208. The second pass's zero nibbles are
    // transparent, so what it leaves alone keeps the first pass's colour —
    // which is how the two halves of an icon's palette compose.
    const first = filledStream(20 * 10, 0x12);
    const second = filledStream(20 * 10, 0x03);
    const table = [8, 0, (8 + first.length) & 0xff, (8 + first.length) >> 8, 0, 0, 0, 0];
    const file = Uint8Array.from([...table, ...first, ...second]);

    const icon = decodeItemIcon(file, 0, 'Simon2');
    expect(typeof icon).not.toBe('string');
    if (typeof icon === 'string') return;

    expect([icon.width, icon.height]).toEqual([20, 20]);
    // Row 0 is the first pass's, untouched by the second: nibble 1 | 224.
    expect(icon.pixels[0]).toBe(0xe1);
    // Row 1 is where the second pass wrote: nibble 3 | 208.
    expect(icon.pixels[20]).toBe(0xd3);
  });

  it('says the table has no such entry rather than reading past it', () => {
    expect(decodeItemIcon(Uint8Array.of(0, 0), 40, 'Simon1')).toContain('no entry 40');
  });
});

/**
 * A zone whose one script loads palette group 13 — base 208, which is where an
 * icon's colours live — out of bank 1.
 *
 * Bank 1 rather than bank 0 because `readVgaPaletteBank` reads from `6 + bank *
 * 96`, and bank 0 would overlap the resource's own header and script.
 */
function zoneLoadingIconColours(): { scripts: Uint8Array; pixels: Uint8Array } {
  const scripts = new Uint8Array(150);
  const view = new DataView(scripts.buffer);
  const word = (at: number, value: number): void => view.setUint16(at, value, false);

  word(2, 1); // one image entry
  word(10, 18); // the image table, at the end of the nine-word header
  word(18, 1); // image 1 …
  word(24, 26); // … whose script is at offset 26
  word(26, 22); // SET_PALETTE
  word(28, 13); // group 13, which lands at palette index 13 * 16 = 208
  word(30, 1); // bank 1
  word(32, 0); // RET

  // Six-bit VGA components at `6 + 1 * 96`, sixteen colours of three.
  for (let index = 0; index < 48; index += 1) scripts[102 + index] = index + 1;

  return { scripts, pixels: new Uint8Array(16) };
}

describe('the colours an icon is drawn in', () => {
  it('takes them from the scripts that set the interface up', () => {
    const { scripts, pixels } = zoneLoadingIconColours();
    const palette = interfacePalette({ scripts, pixels, version: 'Simon1' });

    expect(typeof palette).not.toBe('string');
    if (typeof palette === 'string') return;

    // Entry 208 is the first colour of group 13, six bits widened to eight.
    expect([palette[208 * 3], palette[208 * 3 + 1], palette[208 * 3 + 2]]).toEqual([4, 8, 12]);
    // And the range an icon uses is filled rather than left black, which was
    // the state that made an icon export impossible to offer honestly.
    expect(palette.slice(208 * 3, 224 * 3).some((each) => each !== 0)).toBe(true);
  });

  it('says so rather than returning black when the resource cannot be read', () => {
    const refused = interfacePalette({
      scripts: Uint8Array.of(1, 2, 3),
      pixels: new Uint8Array(0),
      version: 'Simon1',
    });
    expect(typeof refused).toBe('string');
  });

  it('paints an icon in those colours, transparent where it painted nothing', () => {
    const { scripts, pixels } = zoneLoadingIconColours();
    const palette = interfacePalette({ scripts, pixels, version: 'Simon1' });
    if (typeof palette === 'string') throw new Error(palette);

    const rendered = renderIndexedImage(
      { width: 2, height: 1, pixels: Uint8Array.of(0, 208) },
      palette,
      { transparentZero: true },
    );

    // Untouched by the decompressor, so it is the panel showing through rather
    // than black — an icon is mostly that.
    expect(rendered.rgba[3]).toBe(0);
    expect([...rendered.rgba.slice(4, 8)]).toEqual([4, 8, 12, 255]);
  });
});
