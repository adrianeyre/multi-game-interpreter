import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { inflateAgos2, readAgos2Entry } from '../src/engine/agos/resource/agos2Zones.js';
import { readZoneSource, zoneLayoutFor } from '../src/engine/agos/resource/zoneSource.js';

function u32le(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff];
}

/**
 * An index entry, twelve bytes.
 *
 * Sixteen are *read* — the fourth word overlaps the next entry's first, which
 * is what the reference does — so a table is built by concatenating these and
 * the `file` field of one entry is the `offset` of the next.
 */
function entry(offset: number, uncompressed: number, compressed: number): number[] {
  return [...u32le(offset), ...u32le(uncompressed), ...u32le(compressed)];
}

describe('the AGOS 2 index', () => {
  /**
   * The order of the two sizes is the detail that decides whether this reads a
   * game or garbage: **uncompressed comes first**, not the offset/size/size a
   * reader would guess. Swapping them produces a decompression that fails on a
   * perfectly good file.
   */
  it('reads offset, uncompressed size, compressed size, file — in that order', () => {
    const index = Uint8Array.from([...entry(0, 0, 0), ...entry(100, 4096, 512), ...entry(7, 0, 0)]);

    expect(readAgos2Entry(index, 1)).toEqual({
      offset: 100,
      uncompressedSize: 4096,
      compressedSize: 512,
      // The overlap: this entry's fourth word is the next entry's offset.
      file: 7,
    });
  });

  it('answers nothing for an entry beyond the end rather than reading zeroes', () => {
    expect(readAgos2Entry(new Uint8Array(12), 5)).toBeNull();
  });
});

describe('inflating an AGOS 2 resource', () => {
  it('returns a stored resource untouched, because equal sizes are the flag', async () => {
    const data = Uint8Array.from([9, 8, 7, 6, 5]);
    const stored = { offset: 1, uncompressedSize: 3, compressedSize: 3, file: 0 };

    // There is no compression flag: the equality of the two sizes is it, and an
    // inflater fed this would fail on data that is perfectly good.
    expect(await inflateAgos2(data, stored)).toEqual(Uint8Array.of(8, 7, 6));
  });

  it('inflates a deflated one', async () => {
    const original = Uint8Array.from(Array.from({ length: 64 }, (_, index) => index & 0xff));
    const deflated = new Uint8Array(deflateSync(original));
    const data = new Uint8Array(8 + deflated.length);
    data.set(deflated, 8);

    const inflated = await inflateAgos2(data, {
      offset: 8,
      uncompressedSize: original.length,
      compressedSize: deflated.length,
      file: 0,
    });

    expect(inflated).toEqual(original);
  });

  it('refuses a resource whose inflated size disagrees with its index entry', async () => {
    const deflated = new Uint8Array(deflateSync(Uint8Array.from([1, 2, 3])));
    const data = new Uint8Array(deflated.length);
    data.set(deflated, 0);

    // The entry and the data are not describing the same resource, and a short
    // buffer would read as a truncated image rather than as a fault.
    expect(
      await inflateAgos2(data, {
        offset: 0,
        uncompressedSize: 99,
        compressedSize: deflated.length,
        file: 0,
      }),
    ).toBeNull();
  });
});

describe('the third packaging takes its place beside the other two', () => {
  it('routes each Version to the layout it ships', () => {
    expect(zoneLayoutFor('Simon1')).toBe('packed');
    expect(zoneLayoutFor('Waxworks')).toBe('old-bundle');
    expect(zoneLayoutFor('Feeble')).toBe('agos2');
    expect(zoneLayoutFor('PuzzlePack')).toBe('agos2');
  });

  it('reads a zone out of graphics.vga through its index', async () => {
    const scripts = Uint8Array.from([1, 2, 3, 4]);
    const pixels = Uint8Array.from([5, 6, 7, 8]);
    const data = new Uint8Array(16);
    data.set(scripts, 0);
    data.set(pixels, 8);

    // Zone 0's scripts are entry 1 and its pixels entry 2: three apart rather
    // than two, because AGOS 2 has a third resource kind.
    const index = Uint8Array.from([
      ...entry(0, 0, 0),
      ...entry(0, 4, 4),
      ...entry(8, 4, 4),
      ...entry(0, 0, 0),
    ]);

    const source = new MemoryDataSource('feeble');
    source.set('graphics.vga', data);
    source.set('graphics.vga.idx', index);

    const zones = await readZoneSource(source, 'Feeble');

    expect(zones.layout).toBe('agos2');
    expect(zones.zone(0)?.scripts).toEqual(scripts);
    expect(zones.zone(0)?.pixels).toEqual(pixels);
  });

  it('says an install with no graphics has none rather than failing to load', async () => {
    const zones = await readZoneSource(new MemoryDataSource('bare'), 'Feeble');

    expect(zones.layout).toBe('none');
  });
});
