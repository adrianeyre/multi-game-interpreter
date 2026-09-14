import { describe, expect, it } from 'vitest';
import {
  parseSkyIndex,
  writeSkyIndex,
  SkyIndexError,
  SKY_INDEX_ENTRY_BYTES,
} from '../src/engine/sky/resource/skyIndex.js';

/**
 * A synthetic index, built from the format rather than from what the parser
 * happens to accept — the distinction `verifying-version-support.md` calls
 * Tier 1's trap.
 */
function buildIndex(entries: number[][]): Uint8Array {
  const out = new Uint8Array(4 + entries.length * SKY_INDEX_ENTRY_BYTES);
  const view = new DataView(out.buffer);
  view.setUint32(0, entries.length, true);
  entries.forEach((words, i) => {
    words.forEach((w, j) => view.setUint16(4 + i * SKY_INDEX_ENTRY_BYTES + j * 2, w, true));
  });
  return out;
}

describe('parseSkyIndex', () => {
  it('reads a 4-byte count followed by fixed 8-byte entries', () => {
    const index = parseSkyIndex(
      buildIndex([
        [0x1111, 0x2222, 0x3333, 0x4444],
        [0x5555, 0x6666, 0x7777, 0x8888],
      ]),
    );
    expect(index.declaredCount).toBe(2);
    expect(index.entries).toHaveLength(2);
    expect(index.entries[0].words).toEqual([0x1111, 0x2222, 0x3333, 0x4444]);
    expect(index.entries[1].words).toEqual([0x5555, 0x6666, 0x7777, 0x8888]);
  });

  /**
   * The arithmetic both shipped releases satisfy, asserted at their real sizes
   * so a change to the entry width fails here rather than in a renderer. The
   * numbers are file sizes and counts, not game content.
   */
  it.each([
    ['floppy', 1_445, 11_564],
    ['CD', 5_097, 40_780],
  ])('matches the %s release: %i entries in %i bytes', (_name, count, size) => {
    expect(4 + count * SKY_INDEX_ENTRY_BYTES).toBe(size);
    const index = parseSkyIndex(
      buildIndex(Array.from({ length: count }, (_, i) => [i & 0xffff, 0, 0, 0])),
    );
    expect(index.entries).toHaveLength(count);
  });

  // Refuses rather than half-applying: a truncated index still yields entries,
  // they are simply the wrong ones, which is the failure that never errors.
  it('refuses when the declared count disagrees with the file length', () => {
    const good = buildIndex([[1, 2, 3, 4]]);
    expect(() => parseSkyIndex(good.subarray(0, good.length - 1))).toThrow(SkyIndexError);

    const padded = new Uint8Array(good.length + 3);
    padded.set(good);
    expect(() => parseSkyIndex(padded)).toThrow(/must agree exactly/);
  });

  it('refuses a file too short to hold its own count, and one declaring none', () => {
    expect(() => parseSkyIndex(new Uint8Array(3))).toThrow(/too short/);
    expect(() => parseSkyIndex(buildIndex([]))).toThrow(/addresses nothing/);
  });

  // The property worth having before any field is understood: an export can
  // rewrite what it changed and carry the rest through untouched (ADR 0010).
  it('round-trips byte-identically', () => {
    const original = buildIndex([
      [0xeacf, 0x0000, 0x0000, 0x8003],
      [0xeace, 0x0300, 0x7700, 0x4009],
    ]);
    expect(writeSkyIndex(parseSkyIndex(original))).toEqual(original);
  });

  // The raw bytes stay reachable now that the fields have names, because the
  // writer works from them and nine of the prefix's words still have none.
  it('exposes entries as words and raw bytes as well as named fields', () => {
    const index = parseSkyIndex(buildIndex([[0xaabb, 0xccdd, 0xeeff, 0x0011]]));
    expect(index.entries[0].raw).toEqual(
      new Uint8Array([0xbb, 0xaa, 0xdd, 0xcc, 0xff, 0xee, 0x11, 0x00]),
    );
  });

  /**
   * The two 24-bit fields, at the two shipped releases' own first entries.
   *
   * These are index bytes rather than game content — the numbers say where a
   * resource sits, not what is in it — and they are the shape the addressing
   * was established from, so a change to the bit split fails here.
   */
  it('splits the entry into id, offset and size with their flags', () => {
    // id 60110, offset 768 in bytes, 2,423 bytes long, packed, header included.
    const index = parseSkyIndex(buildIndex([[0xeace, 0x0300, 0x7700, 0x4009]]));
    const entry = index.entries[0];
    expect(entry.id).toBe(60_110);
    expect(entry.offset).toBe(768);
    expect(entry.offsetInUnits).toBe(false);
    expect(entry.size).toBe(2423);
    expect(entry.excludesHeader).toBe(true);
    expect(entry.stored).toBe(false);
  });

  it('scales an offset by the unit when the entry says it counts units', () => {
    // The offset field's top bit set: its low 23 bits count units, not bytes.
    const entryWords: number[] = [0x0001, 0x0002, 0x1080, 0x0000];
    const raw = parseSkyIndex(buildIndex([entryWords]));
    expect(raw.entries[0].offsetInUnits).toBe(true);
    expect(raw.entries[0].offset).toBe(2 * 16);
    expect(raw.entries[0].size).toBe(0x10);

    // The one 1994 build that counts 8-byte units instead, which is why the
    // unit is a parameter rather than a constant.
    const eight = parseSkyIndex(buildIndex([entryWords]), 8);
    expect(eight.entries[0].offset).toBe(2 * 8);
  });
});
