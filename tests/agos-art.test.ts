/**
 * A game's art, as something a surface can list.
 *
 * The pixels are not in `GAMEPC` — they live in the zones a `ZoneSource` reads
 * — so a project built from the base file alone has no art, and that absence is
 * a fact about the *caller* rather than about the game. Most of what is checked
 * here is that the two are told apart, and that a zone which is present but
 * unreadable is named rather than shown as empty.
 */
import { describe, expect, it } from 'vitest';
import { readAgosArt } from '../src/authoring/agos/images.js';
import type { ZoneSource } from '../src/engine/agos/resource/zoneSource.js';

/** A zone source holding whatever the test hands it, and nothing else. */
function sourceOf(zones: Record<number, { scripts: Uint8Array; pixels: Uint8Array }>): ZoneSource {
  return {
    layout: 'packed',
    zone: (number) => zones[number],
  };
}

describe('reading a game with no zones', () => {
  it('reports no zones rather than throwing', () => {
    const art = readAgosArt(sourceOf({}), { maxZone: 8 });

    expect(art.zones).toEqual([]);
    expect(art.images).toEqual([]);
  });
});

describe('a zone whose graphics resource cannot be read', () => {
  it('is named rather than silently dropped', () => {
    // A zone present in the archive and unreadable is either a packaging we
    // read wrongly or a game we have not seen. A shorter list would look like
    // a game with less art.
    const art = readAgosArt(
      sourceOf({ 3: { scripts: new Uint8Array(2), pixels: new Uint8Array(2) } }),
      { maxZone: 8 },
    );

    expect(art.zones).toContain(3);
    expect(art.unreadableZones).toContain(3);
  });

  it('still counts the zone as present, because it answered', () => {
    const art = readAgosArt(
      sourceOf({ 3: { scripts: new Uint8Array(2), pixels: new Uint8Array(2) } }),
      { maxZone: 8 },
    );

    // Present and unreadable are different claims, and both are made.
    expect(art.zones).toEqual([3]);
    expect(art.images).toEqual([]);
  });
});

describe('the zone range is a parameter', () => {
  it('does not look past the range it was given', () => {
    // "How many zones can a game have" is a property of the packaging, not of
    // this reader, so the bound is passed in rather than assumed.
    const zones = { 20: { scripts: new Uint8Array(2), pixels: new Uint8Array(2) } };

    expect(readAgosArt(sourceOf(zones), { maxZone: 5 }).zones).toEqual([]);
    expect(readAgosArt(sourceOf(zones), { maxZone: 25 }).zones).toEqual([20]);
  });
});

/**
 * Which table an image comes from.
 *
 * A zone has two resources and each has a table. The **script** table's ids are
 * the numbers a game asks for — 300, 401, 600 in Simon 1, global and sparse.
 * The **pixel** table has an eight-byte entry per image at `id * 8`, and those
 * ids are small and dense.
 *
 * They were being read as one: the script table's ids were looked up in the
 * pixel table. On Simon 1 that reads entry 300 of a hundred-entry table, which
 * is whatever pixel data sits at byte 2400 — so the list came back with sizes
 * like 43370x181 and every image decoded to a black rectangle. Nothing threw.
 */
describe('a zone whose two tables use different numbering', () => {
  /**
   * A zone whose script ids are in the hundreds and whose pixel table has three
   * dense entries, which is the shape a real Simon 1 zone has.
   */
  function mismatchedZone(): { scripts: Uint8Array; pixels: Uint8Array } {
    // Two images in the pixel table, at ids 1 and 2, with pixels after it.
    const table = 3 * 8;
    const pixels = new Uint8Array(table + 8);
    const view = new DataView(pixels.buffer);
    for (const [id, offset] of [
      [1, table],
      [2, table + 4],
    ] as const) {
      const at = id * 8;
      view.setUint32(at, offset, false);
      pixels[at + 4] = 0x80;
      pixels[at + 5] = 2; // rows
      view.setUint16(at + 6, 4, false); // four pixels wide
    }

    // A script file whose one image entry claims id 300 — far past the pixel
    // table's three slots.
    return { scripts: scriptFileNaming(300), pixels };
  }

  /**
   * A graphics script resource with one image entry, under the id given.
   *
   * Nine header words, then an eight-byte entry: id, colour, a word the reader
   * skips, and the offset of the script that draws it. The header's own fields
   * are counts and table offsets, which is why they are written out rather than
   * copied from a blob — the point of this fixture is that the id in it is not
   * the id the pixel table uses.
   */
  function scriptFileNaming(id: number): Uint8Array {
    const out = new Uint8Array(26);
    const view = new DataView(out.buffer);
    const word = (at: number, value: number): void => view.setUint16(at, value, false);
    word(0, 0); // the header pointer, which points at the header at zero
    word(2, 1); // one image
    word(6, 0); // no animations
    word(10, 18); // the image table starts after the header
    word(14, 0);
    word(18, id);
    word(20, 0); // colour
    word(24, 0); // the script's offset, which nothing here runs
    return out;
  }

  it('lists the pixel table’s images rather than the script table’s ids', () => {
    const zone = mismatchedZone();
    const art = readAgosArt(
      {
        layout: 'packed',
        zone: (number) => (number === 0 ? zone : undefined),
      },
      { maxZone: 1 },
    );

    // Two images, numbered 1 and 2, and not one numbered 300.
    expect(art.images.map((each) => each.id)).toEqual([1, 2]);
    expect(art.images.every((each) => each.width === 4 && each.height === 2)).toBe(true);
  });

  it('stops the table where the first image’s pixels begin, since nothing counts it', () => {
    const zone = mismatchedZone();
    const art = readAgosArt(
      {
        layout: 'packed',
        zone: (number) => (number === 0 ? zone : undefined),
      },
      { maxZone: 1 },
    );

    // Slot 3 exists in the 24 bytes before the pixels but names no offset, so
    // it is a hole rather than an image.
    expect(art.images).toHaveLength(2);
  });
});
