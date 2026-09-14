/**
 * Beneath a Steel Sky's resource layer: `sky.dnr` addressing `sky.dsk`.
 *
 * This is the half of #252 that could not be written when `skyIndex.ts` was —
 * the index parsed, and nothing turned an entry into bytes. Eight hypotheses
 * about the addressing had been eliminated by measurement and the surviving
 * explanation put the answer in `SKY.EXE`, which neither freeware release
 * ships.
 *
 * **The answer turned out to be checkable without the executable**, because the
 * data checks itself three ways over:
 *
 * 1. Under the reading in `skyIndex.ts`, all 6,542 entries across both shipped
 *    releases land inside their file, **none overlaps another**, and the last
 *    resource of each ends on its file's final byte — 8,830,435 and 72,395,713.
 * 2. Every `RNC\x01` marker in either file sits at an entry's `offset + 22`,
 *    and every entry the index calls packed has one. Neither file has a single
 *    unaccounted marker.
 * 3. Each packed resource carries a CRC of its own unpacked bytes, so the
 *    decompressor is checkable against real shipped data with nothing drawn:
 *    **5,907 of 5,907 packed resources unpack to their declared length with the
 *    declared CRC.**
 *
 * A wrong reading fails (1) in the first hundred entries. This is stronger
 * evidence than reading the routine would have been, and it is the reason
 * `docs/architectural-decision-record/0024` gains a fourth amendment rather
 * than the Sky half of the backlog staying blocked on a disc.
 *
 * ## What still needs the executable
 *
 * Nothing, as it turned out — and the sentence that stood here saying otherwise
 * was wrong twice over. It read: "The Compact table (#253). ADR 0024 is
 * unamended in that respect and this file changes nothing about it: `sky.cpt`
 * is not read here, or anywhere, even though the CD release ships one."
 *
 * ADR 0024's **first** amendment accepts `sky.cpt` for the 2003 freeware
 * Release, on the grounds that Revolution gave ScummVM the game's original
 * source and the file is derived from that rather than from a reading of a
 * binary. `skyCompacts.ts` reads it, and #253 is answered for the release this
 * project can actually fetch. What still needs an original disc is the
 * *original* Releases' Compacts, which live in `SKY.EXE` — refused by name
 * rather than attempted, since no such release is available to check a reader
 * against.
 */

import { parseSkyIndex, SkyIndexError, type SkyIndex, type SkyIndexEntry } from './skyIndex.js';
import { looksRncPacked, rncUnpack, RncError } from './rnc.js';

/**
 * The prefix every resource carries before its own data.
 *
 * Twenty-two bytes, eleven little-endian words. Two of them are read here and
 * the rest are carried untouched, because two are all that anything so far has
 * been able to check:
 *
 * - **word 0**, whose bit 7 says the resource is packed and whose top eight
 *   bits carry the high bits of the unpacked length;
 * - **word 6**, which carries the low sixteen.
 *
 * That reading is not assumed: for all 5,899 resources the index calls packed
 * across both releases, the length it computes equals the one the RNC stream
 * declares about itself — exactly, with no exceptions and no fudge for the
 * header's own 22 bytes, which `excludesHeader` accounts for.
 *
 * The other nine words are a sprite's geometry, and this file does not name
 * them. A renderer (#256) is what can check such a name, by drawing with it.
 */
export const SKY_RESOURCE_HEADER_BYTES = 22;

/** Word 0's bit 7. Set when the game will unpack the resource. */
const HEADER_FLAG_PACKED = 1 << 7;

/**
 * A Release, identified the way the game's own interpreter identifies one.
 *
 * Entry count first, then `sky.dsk`'s length to break the one tie — two 1994
 * floppy builds ship 1,445 entries and differ in nothing else visible from
 * here, and they differ in the **unit an offset counts**, which is not a
 * difference a reader may get wrong quietly. Transcribed from ScummVM's
 * `Disk::determineGameVersion`, which is where the tie-break comes from.
 */
export interface SkyReleaseInfo {
  /** Revolution's own build number, as ScummVM reports it: v0.0`build`. */
  readonly build: number;
  /** What a Target would call this: 'demo', 'floppy' or 'cd'. */
  readonly release: 'demo' | 'floppy' | 'cd';
  /** The multiplier for an offset stored in units. */
  readonly offsetUnit: number;
  readonly description: string;
}

const RELEASES: ReadonlyMap<number, (dataLength: number) => SkyReleaseInfo> = new Map([
  [232, () => info(272, 'demo', 16, 'German floppy demo')],
  [243, () => info(109, 'demo', 16, 'PC Gamer demo')],
  [247, () => info(267, 'demo', 16, 'English floppy demo')],
  [1404, () => info(288, 'floppy', 16, 'floppy')],
  [1413, () => info(303, 'floppy', 16, 'floppy')],
  [
    1445,
    (dataLength: number) =>
      dataLength === 8_830_435
        ? info(348, 'floppy', 16, 'floppy, the freeware release')
        : info(331, 'floppy', 8, 'floppy, the build whose offsets count 8-byte units'),
  ],
  [1711, () => info(365, 'demo', 16, 'CD demo')],
  [5099, () => info(368, 'cd', 16, 'CD')],
  [5097, () => info(372, 'cd', 16, 'CD, the freeware release')],
]);

function info(
  build: number,
  release: 'demo' | 'floppy' | 'cd',
  offsetUnit: number,
  description: string,
): SkyReleaseInfo {
  return { build, release, offsetUnit, description };
}

/**
 * Something the reader could not do, named so it can be shown rather than
 * logged.
 *
 * `CONTEXT.md` gives the Unrecovered count a target of zero and this is what
 * counts towards it for Sky. Both shipped releases produce a count of zero —
 * but a count of zero that nothing computes is a claim, not a measurement, so
 * the machinery exists regardless.
 */
export interface SkyResourceNote {
  readonly id: number;
  readonly reason: string;
}

export class SkyResourceError extends Error {}

/**
 * The reader.
 *
 * Holds `sky.dsk` rather than copying out of it: the CD release's data file is
 * 69 MB and a browser tab that duplicated it would be paying for the privilege
 * of never reading most of it. Resources are cut out on demand, and unpacked
 * ones are cached, because the same background is asked for on every entry to a
 * room.
 */
/** What the index says about a resource, which is what deciding to unpack needs. */
export interface SkyResourcePacking {
  /** Only for the error message, so a caller can say which resource failed. */
  readonly id: number;
  /** The index's own flag: the unpacked result excludes the 22-byte prefix. */
  readonly excludesHeader: boolean;
  /** The index's own flag: stored, so the packer's marker is data. */
  readonly stored: boolean;
}

/**
 * Unpacks one resource's container bytes, or returns them unchanged.
 *
 * A free function rather than a method because there are now two callers and
 * only one of them has a `SkyResources`: the editor carries Sky's sprites
 * **packed** — 1.58 MB against 15.50 MB unpacked — and unpacks one when it is
 * opened, at which point it has bytes and two flags and no reader.
 *
 * Reimplementing it there would have duplicated the two subtleties this has:
 * that Sky packs *after* the 22-byte prefix, so the marker is at offset 22 and
 * not 0; and that the prefix is part of the result unless the index says
 * otherwise, carried across rather than regenerated because nine of its eleven
 * words have no established meaning and writing a value for a word nobody has
 * read is the guess this family's readers refuse.
 */
export function unpackSkyResource(raw: Uint8Array, packing: SkyResourcePacking): Uint8Array {
  if (raw.length < SKY_RESOURCE_HEADER_BYTES) return raw;
  const flag = raw[0] | (raw[1] << 8);
  const packed = (flag & HEADER_FLAG_PACKED) !== 0;
  if (packing.stored || !packed || !looksRncPacked(raw, SKY_RESOURCE_HEADER_BYTES)) return raw;

  let unpacked: Uint8Array;
  try {
    unpacked = rncUnpack(raw, SKY_RESOURCE_HEADER_BYTES);
  } catch (error) {
    const detail = error instanceof RncError ? error.message : String(error);
    throw new SkyResourceError(`Resource ${packing.id} could not be unpacked. ${detail}`);
  }

  if (packing.excludesHeader) return unpacked;

  const out = new Uint8Array(SKY_RESOURCE_HEADER_BYTES + unpacked.length);
  out.set(raw.subarray(0, SKY_RESOURCE_HEADER_BYTES), 0);
  out.set(unpacked, SKY_RESOURCE_HEADER_BYTES);
  return out;
}

export class SkyResources {
  private readonly cache = new Map<number, Uint8Array>();

  private constructor(
    readonly index: SkyIndex,
    private readonly data: Uint8Array,
    readonly releaseInfo: SkyReleaseInfo,
    readonly notes: readonly SkyResourceNote[],
  ) {}

  /**
   * Opens a pair of files, or refuses with something a person can act on.
   *
   * Validation happens **here**, once, over the whole index, rather than being
   * rediscovered by whichever room first asks for a broken resource. A dump
   * that is missing bytes is worth knowing about before a player has walked
   * into it.
   */
  static open(indexBytes: Uint8Array, dataBytes: Uint8Array): SkyResources {
    let declaredCount: number;
    try {
      declaredCount = parseSkyIndex(indexBytes).declaredCount;
    } catch (error) {
      if (error instanceof SkyIndexError) throw new SkyResourceError(error.message);
      throw error;
    }

    const release = RELEASES.get(declaredCount);
    if (!release) {
      throw new SkyResourceError(
        `This sky.dnr holds ${declaredCount} entries, which matches no Beneath a Steel Sky ` +
          `release this project knows. The count identifies the release and the release ` +
          `decides whether an offset counts 8-byte or 16-byte units, so reading on would ` +
          `address the wrong bytes rather than fail. Known counts: ` +
          `${[...RELEASES.keys()].sort((a, b) => a - b).join(', ')}.`,
      );
    }
    const releaseInfo = release(dataBytes.length);
    const index = parseSkyIndex(indexBytes, releaseInfo.offsetUnit);

    const notes: SkyResourceNote[] = [];
    const seen = new Map<number, SkyIndexEntry>();
    for (const entry of index.entries) {
      if (entry.offset + entry.size > dataBytes.length) {
        notes.push({
          id: entry.id,
          reason:
            `addresses ${entry.size} bytes at ${entry.offset}, past the end of a ` +
            `${dataBytes.length}-byte sky.dsk`,
        });
        continue;
      }
      const earlier = seen.get(entry.id);
      if (earlier && earlier.offset !== entry.offset) {
        notes.push({
          id: entry.id,
          reason:
            `appears twice, at ${earlier.offset} and ${entry.offset}; the first wins, ` +
            `which is what the game's own linear scan does`,
        });
        continue;
      }
      if (!earlier) seen.set(entry.id, entry);

      // Visible rather than silent: a handful of entries per release are marked
      // stored and carry a packer's marker anyway. The game does not unpack
      // them and neither does this, but a reader that never mentioned it would
      // leave somebody to discover it inside a renderer.
      if (entry.stored && looksRncPacked(dataBytes, entry.offset + SKY_RESOURCE_HEADER_BYTES)) {
        notes.push({
          id: entry.id,
          reason:
            `is marked stored yet begins with a packer's marker, so it is passed through ` +
            `unpacked — which is what the game does with it`,
        });
      }
    }

    return new SkyResources(index, dataBytes, releaseInfo, notes);
  }

  /** Every resource id the index addresses, in the order the file lists them. */
  ids(): number[] {
    const out: number[] = [];
    const seen = new Set<number>();
    for (const entry of this.index.entries) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      out.push(entry.id);
    }
    return out;
  }

  /**
   * The entry for an id.
   *
   * First match wins, which is the game's own behaviour: it scans the table
   * linearly and stops. Sorting or hashing would be faster and would answer
   * differently for the duplicate ids each release carries.
   */
  entry(id: number): SkyIndexEntry | null {
    return this.index.entries.find((candidate) => candidate.id === id) ?? null;
  }

  /** The resource exactly as it sits in `sky.dsk`, packed if it is packed. */
  rawBytes(id: number): Uint8Array {
    const entry = this.requireEntry(id);
    return this.data.subarray(entry.offset, entry.offset + entry.size);
  }

  /**
   * The resource, unpacked when it is packed.
   *
   * The decision is made from the bytes and the index together, never from
   * either alone: the index has to say the resource is not stored, word 0 of
   * the prefix has to say it is packed, and an `RNC\x01` marker has to actually
   * be there. Twenty-six entries per release satisfy the first two and not the
   * third — the game passes those through, and so does this.
   */
  read(id: number): Uint8Array {
    const cached = this.cache.get(id);
    if (cached) return cached;

    const entry = this.requireEntry(id);
    const raw = this.rawBytes(id);
    const result = this.unpackIfPacked(entry.id, raw, entry.excludesHeader, entry.stored);
    this.cache.set(id, result);
    return result;
  }

  private unpackIfPacked(
    id: number,
    raw: Uint8Array,
    excludesHeader: boolean,
    stored: boolean,
  ): Uint8Array {
    return unpackSkyResource(raw, { id, excludesHeader, stored });
  }

  private requireEntry(id: number): SkyIndexEntry {
    const entry = this.entry(id);
    if (!entry) {
      throw new SkyResourceError(
        `sky.dnr does not address resource ${id}, so sky.dsk is not asked for it. ` +
          `This index holds ${this.index.declaredCount} entries.`,
      );
    }
    return entry;
  }

  /**
   * What the load log says.
   *
   * The type breakdown #252 asks for is packed against stored, because that is
   * the only classification the index itself makes. What a resource *is* — a
   * background, a sprite, a script — is a question for whatever reads it, and
   * answering it here would mean guessing from a size.
   */
  describe(): string {
    const total = this.index.entries.length;
    let packed = 0;
    for (const entry of this.index.entries) {
      if (
        !entry.stored &&
        entry.offset + entry.size <= this.data.length &&
        looksRncPacked(this.data, entry.offset + SKY_RESOURCE_HEADER_BYTES)
      ) {
        packed += 1;
      }
    }
    const lines = [
      `Beneath a Steel Sky, ${this.releaseInfo.description} (v0.0${this.releaseInfo.build}).`,
      `${total} index entries, ${packed} RNC ProPack packed, ${total - packed} stored.`,
    ];
    if (this.notes.length === 0) {
      lines.push('Nothing unreadable.');
    } else {
      lines.push(`${this.notes.length} unreadable or unusual:`);
      for (const note of this.notes) lines.push(`  ${note.id}: ${note.reason}`);
    }
    return lines.join('\n');
  }
}
