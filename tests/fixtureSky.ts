/**
 * A synthetic `sky.dnr` and `sky.dsk` pair, built from the format.
 *
 * Built from the format rather than from what the reader accepts, which is the
 * distinction `docs/processes/verifying-version-support.md` draws and the trap
 * it names: "a fixture encodes our reading of the format. If that reading is
 * wrong, the fixture and the engine agree with each other and disagree with the
 * game." So the bytes below are laid out from the field table in
 * `skyIndex.ts` — a 4-byte count, 8-byte entries, two 24-bit fields with two
 * flag bits apiece — and never by asking the parser what it wanted.
 *
 * **What this fixture deliberately cannot cover is compression.** An RNC stream
 * is a compressor's output, so producing one here would mean writing an encoder
 * against this project's own reading of the bit interleave, and the fixture
 * would then agree with the decoder for exactly the wrong reason. Every
 * resource here is therefore stored, and the decompressor's evidence is real
 * shipped data instead: `npm run sweep:vt` checks all 5,907 packed resources
 * across both releases against the CRCs they carry.
 */

import { SKY_INDEX_ENTRY_BYTES } from '../src/engine/sky/resource/skyIndex.js';
import { SKY_RESOURCE_HEADER_BYTES } from '../src/engine/sky/resource/SkyResources.js';

export interface SkyFixtureEntry {
  readonly id: number;
  /** In bytes, already scaled — what the reader should end up with. */
  readonly offset: number;
  readonly size: number;
  readonly offsetInUnits: boolean;
  readonly stored: boolean;
  readonly excludesHeader: boolean;
  /** Prefix says packed, no marker follows. Real releases hold 26 of these. */
  readonly claimsPackedWithoutMarker: boolean;
}

/** The unit an offset counts when `offsetInUnits` is set, on this fixture. */
const UNIT = 16;

export const SKY_FIXTURE_ENTRIES: readonly SkyFixtureEntry[] = [
  {
    id: 1,
    offset: 0,
    size: 64,
    offsetInUnits: false,
    stored: true,
    excludesHeader: false,
    claimsPackedWithoutMarker: false,
  },
  {
    id: 2,
    offset: 64,
    size: 96,
    offsetInUnits: false,
    stored: false,
    excludesHeader: false,
    claimsPackedWithoutMarker: true,
  },
  {
    id: 3,
    offset: 256,
    size: 32,
    offsetInUnits: true,
    stored: true,
    excludesHeader: true,
    claimsPackedWithoutMarker: false,
  },
];

export interface SkyFixtureOptions {
  /** Must match a release the reader knows, unless the test wants a refusal. */
  readonly entryCount?: number;
  readonly dataLength?: number;
  /** Add an entry addressing past the end, to exercise the report. */
  readonly overrunLastEntry?: boolean;
}

/**
 * Writes one 8-byte entry from named fields.
 *
 * The bit layout is written out here, once, in the direction the format
 * describes: id, then a 24-bit offset with its unit flag on top, then a 22-bit
 * size with two flags above it.
 */
function writeEntry(into: Uint8Array, at: number, entry: SkyFixtureEntry): void {
  const stored = entry.offsetInUnits ? entry.offset / UNIT : entry.offset;
  const addressing = (stored & 0x7fffff) | (entry.offsetInUnits ? 1 << 23 : 0);
  const sizing =
    (entry.size & 0x3fffff) | (entry.excludesHeader ? 1 << 22 : 0) | (entry.stored ? 1 << 23 : 0);

  into[at] = entry.id & 0xff;
  into[at + 1] = (entry.id >> 8) & 0xff;
  into[at + 2] = addressing & 0xff;
  into[at + 3] = (addressing >> 8) & 0xff;
  into[at + 4] = (addressing >> 16) & 0xff;
  into[at + 5] = sizing & 0xff;
  into[at + 6] = (sizing >> 8) & 0xff;
  into[at + 7] = (sizing >> 16) & 0xff;
}

/**
 * The index and the data file, as a pair ready to spread into `open`.
 *
 * Padding entries all address the same zero-length resource: an index entry has
 * to be present for the count to match the release, and a padding entry that
 * addressed something different would be inventing content the format has no
 * reason to hold.
 */
export function buildSkyFixture(options: SkyFixtureOptions): [Uint8Array, Uint8Array] {
  // 1,404 is a real release's count (v0.0288) and needs no tie-break on the
  // data file's length, which keeps the common fixture small.
  const entryCount = options.entryCount ?? 1_404;
  const dataLength = options.dataLength ?? 4_096;

  const data = new Uint8Array(dataLength);
  // Deterministic, non-uniform content: a run of zeroes would let an off-by-one
  // offset pass a comparison it should fail.
  for (let i = 0; i < data.length; i += 1) data[i] = (i * 31 + 7) & 0xff;

  for (const entry of SKY_FIXTURE_ENTRIES) {
    if (entry.offset + entry.size > data.length) continue;
    // Word 0 of the prefix: bit 7 says the game will unpack this resource.
    const flag = entry.claimsPackedWithoutMarker ? 1 << 7 : 0;
    data[entry.offset] = flag & 0xff;
    data[entry.offset + 1] = (flag >> 8) & 0xff;
    // Whatever follows the prefix, it is not a marker: that is the point of
    // this case, and the byte is set explicitly so a later edit cannot make it
    // one by accident.
    if (entry.size > SKY_RESOURCE_HEADER_BYTES) {
      data[entry.offset + SKY_RESOURCE_HEADER_BYTES] = 0x00;
    }
  }

  const entries: SkyFixtureEntry[] = [...SKY_FIXTURE_ENTRIES];
  if (options.overrunLastEntry) {
    entries.push({
      id: 999,
      offset: dataLength - 8,
      size: 64,
      offsetInUnits: false,
      stored: true,
      excludesHeader: false,
      claimsPackedWithoutMarker: false,
    });
  }

  const index = new Uint8Array(4 + entryCount * SKY_INDEX_ENTRY_BYTES);
  const view = new DataView(index.buffer);
  view.setUint32(0, entryCount, true);

  for (let i = 0; i < entryCount; i += 1) {
    const at = 4 + i * SKY_INDEX_ENTRY_BYTES;
    const entry = entries[i];
    if (entry) {
      writeEntry(index, at, entry);
    } else {
      writeEntry(index, at, {
        id: 0x8000 + i,
        offset: 0,
        size: 0,
        offsetInUnits: false,
        stored: true,
        excludesHeader: false,
        claimsPackedWithoutMarker: false,
      });
    }
  }

  return [index, data];
}
