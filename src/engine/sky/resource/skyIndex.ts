/**
 * Reads Beneath a Steel Sky's resource index, `sky.dnr`.
 *
 * The shape is established rather than assumed, which matters because this
 * project's own rule (`docs/processes/verifying-version-support.md`) is that a
 * fixture encoding *our reading* of a format will happily agree with an engine
 * that shares the misreading. So the arithmetic is written down:
 *
 * | Release | File size | Leading dword | (size - 4) / dword |
 * | ------- | --------- | ------------- | ------------------ |
 * | floppy  | 11,564    | 1,445         | 8.0000             |
 * | CD      | 40,780    | 5,097         | 8.0000             |
 *
 * A four-byte little-endian entry count, then that many fixed eight-byte
 * entries, with nothing left over on either release. Two releases of very
 * different sizes both landing exactly on eight is what makes this a reading of
 * the format rather than a coincidence that fits one file.
 *
 * **The eight bytes now have names, and the names are measurements.** When this
 * file was first written they deliberately had none, because a field can only
 * be checked by seeing whether it addresses real data and there was no
 * `sky.dsk` reader to check against. There is now (#252), and the checks it
 * makes possible are strong enough to name every bit: with the reading below,
 * 6,542 entries across two releases all land inside their file, **none overlap
 * any other**, and the last resource of each ends on its file's final byte. See
 * `SkyIndexEntry` for the field-by-field evidence.
 *
 * `sky.cpt` is not read *here* — it holds Compacts rather than resources — but
 * it is read (`skyCompacts.ts`), which is ADR 0024's first amendment rather
 * than a relaxation of anything: for the 2003 freeware Release that file is
 * source-derived and part of the release. This sentence used to say "or
 * anywhere", and that was wrong when it was written.
 */

/** The header is a single little-endian `uint32` entry count. */
const HEADER_BYTES = 4;

/** Established from the arithmetic above, on both shipped releases. */
export const SKY_INDEX_ENTRY_BYTES = 8;

/**
 * One index entry.
 *
 * The four raw words are still exposed, and `raw` still carries the bytes, so a
 * re-emitter can write back what it did not interpret — `CONTEXT.md`'s
 * **Preserved bytes**. What has changed since this file was written is that the
 * fields now have names, and the names were earned rather than guessed. Each
 * one is the measurement that settled it, over both shipped releases:
 *
 * | Field | Bits | What established it |
 * | --- | --- | --- |
 * | `id` | 0–15 | The number scripts ask for; the game scans for it linearly |
 * | `offset` | 16–38 | With `offsetInUnits`, every resource lands inside the file, none overlap, and the last ends **exactly** at the final byte on both releases |
 * | `offsetInUnits` | 39 | Without it 148 floppy entries address past the end of an 8.8 MB file |
 * | `size` | 40–61 | `offset + size` reaches the next resource's offset exactly |
 * | `excludesHeader` | 62 | The 22-byte prefix is left out of the unpacked result; checked against the RNC header's own declared length, 5,899 of 5,899 |
 * | `stored` | 63 | The resource is not to be unpacked even if it carries a packer's marker |
 *
 * The last row is the one worth reading twice. `stored` is a **directive, not a
 * description**: four entries per release set it and still carry an `RNC\x01`
 * marker, and the game does not unpack those. A reader that treated the bit as
 * a description of the bytes would unpack them and be wrong in a way that looks
 * like a corrupt file rather than like a misread flag.
 */
export interface SkyIndexEntry {
  readonly words: readonly [number, number, number, number];
  readonly raw: Uint8Array;
  /** The number a script asks for. */
  readonly id: number;
  /** Where the resource starts in `sky.dsk`, already scaled if it was in units. */
  readonly offset: number;
  /** True when the stored offset counts 16-byte units rather than bytes. */
  readonly offsetInUnits: boolean;
  /** Bytes occupied in `sky.dsk`, packed size included. */
  readonly size: number;
  /** The unpacked result excludes the 22-byte prefix. */
  readonly excludesHeader: boolean;
  /** The game is told not to unpack this one, whatever its bytes look like. */
  readonly stored: boolean;
}

/**
 * How much an offset is multiplied by when `offsetInUnits` is set.
 *
 * 16 for every Release this project has seen. ScummVM uses 8 for one 1994
 * floppy build (its v0.0331) and 16 for everything else, and tells the two
 * apart by `sky.dsk`'s length — so `skyRelease` carries the unit and this
 * constant is the default rather than the rule.
 */
export const SKY_OFFSET_UNIT = 16;

export interface SkyIndex {
  readonly entries: readonly SkyIndexEntry[];
  /** The count the file declares, which is checked rather than trusted. */
  readonly declaredCount: number;
}

/**
 * Thrown rather than returning a partial index.
 *
 * `AdventureEngine` requires a load to refuse rather than half-apply, and an
 * index is the one structure where a partial read is most likely to look fine:
 * a truncated file still yields entries, they are simply the wrong ones.
 */
export class SkyIndexError extends Error {}

/**
 * Parses `sky.dnr`, or throws with something a person can act on.
 *
 * The size check is the whole of the validation and it is a strong one: the
 * declared count and the file length have to agree exactly. A dump that is
 * truncated, padded, or not an index at all fails it, which is why nothing
 * downstream needs to re-check.
 */
export function parseSkyIndex(bytes: Uint8Array, offsetUnit = SKY_OFFSET_UNIT): SkyIndex {
  if (bytes.length < HEADER_BYTES) {
    throw new SkyIndexError(
      `sky.dnr is ${bytes.length} bytes, which is too short to hold even its own entry count. ` +
        `This is not a Beneath a Steel Sky index.`,
    );
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const declaredCount = view.getUint32(0, true);
  const body = bytes.length - HEADER_BYTES;
  const expected = declaredCount * SKY_INDEX_ENTRY_BYTES;

  if (declaredCount === 0) {
    throw new SkyIndexError(`sky.dnr declares no entries, so it addresses nothing in sky.dsk.`);
  }

  if (body !== expected) {
    throw new SkyIndexError(
      `sky.dnr declares ${declaredCount} entries, which needs ${expected} bytes after its ` +
        `4-byte header, but the file has ${body}. The two must agree exactly: an index whose ` +
        `length disagrees with its own count is truncated or is not an index. ` +
        `(The shipped releases hold 1,445 entries at 11,564 bytes and 5,097 at 40,780.)`,
    );
  }

  const entries: SkyIndexEntry[] = [];
  for (let i = 0; i < declaredCount; i += 1) {
    const at = HEADER_BYTES + i * SKY_INDEX_ENTRY_BYTES;
    // Two 24-bit little-endian fields, read a byte at a time rather than as
    // overlapping 32-bit words. The overlapping read is what the game's own
    // code does and it works, but it reads a byte belonging to the *next*
    // entry, which makes the last entry a special case nobody remembers.
    const addressing = bytes[at + 2] | (bytes[at + 3] << 8) | (bytes[at + 4] << 16);
    const sizing = bytes[at + 5] | (bytes[at + 6] << 8) | (bytes[at + 7] << 16);
    const offsetInUnits = ((addressing >> 23) & 1) === 1;
    const stored = ((sizing >> 23) & 1) === 1;

    entries.push({
      words: [
        view.getUint16(at, true),
        view.getUint16(at + 2, true),
        view.getUint16(at + 4, true),
        view.getUint16(at + 6, true),
      ],
      raw: bytes.subarray(at, at + SKY_INDEX_ENTRY_BYTES),
      id: view.getUint16(at, true),
      offset: offsetInUnits ? (addressing & 0x7fffff) * offsetUnit : addressing & 0x7fffff,
      offsetInUnits,
      size: sizing & 0x3fffff,
      excludesHeader: ((sizing >> 22) & 1) === 1,
      stored,
    });
  }

  return { entries, declaredCount };
}

/**
 * Writes an index back out, byte-identically for anything unmodified.
 *
 * The round trip is the property worth having before any of the fields are
 * understood: it is what lets an export rewrite the entries it changed and
 * carry the rest through untouched (ADR 0010's principle).
 */
export function writeSkyIndex(index: SkyIndex): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES + index.entries.length * SKY_INDEX_ENTRY_BYTES);
  const view = new DataView(out.buffer);
  view.setUint32(0, index.entries.length, true);
  index.entries.forEach((entry, i) => {
    out.set(entry.raw, HEADER_BYTES + i * SKY_INDEX_ENTRY_BYTES);
  });
  return out;
}
