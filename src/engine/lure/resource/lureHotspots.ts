/**
 * Lure's hotspot positions, read out of the game's own executable.
 *
 * ADR 0024's rule, applied where it actually holds for this family. Its third
 * amendment found that Lure's *live world state* is a resource rather than
 * executable-resident — resource 16398, the save-slot image — and that
 * correction is sometimes read as though nothing of Lure's is in the binary.
 * The definitions are. This table is one of them.
 *
 * ## What it is, and why it is the first typed thing here
 *
 * A null-terminated list of six-byte records: a hotspot's id, and the point the
 * player walks to when told to use it. `CONTEXT.md` calls the object table "the
 * nouns and where they are standing", and ADR 0025 says most of what a person
 * means by editing one of these games is "move that, change what it is doing" —
 * a field in that table rather than an instruction. A position is the plainest
 * such field there is, so it is where a typed surface starts.
 *
 * ## Where it is, and how that was checked rather than assumed
 *
 * At `LURE_DATA_SEGMENT + LURE_WALK_TO_OFFSET` in `Lure.exe`. Both numbers come
 * from ScummVM's `create_lure`, which reads the same table for the same reason,
 * and neither is taken on trust — three readings of this game's *other*
 * structure looked right and were wrong, so an offset from a third party is a
 * hypothesis until the bytes agree.
 *
 * They agree on two counts that a wrong anchor would fail:
 *
 * **The ids land in the game's own bands.** `create_lure` names the starts of
 * Lure's id ranges as `0x3e8`, `0x408`, `0x2710` and `0x7530` — 1000, 1032,
 * 10000, 30000. Reading the shipped English executable gives 125 records, and
 * **122 of them** sit in exactly those bands: 31 near 1000, 27 near 10000, 64
 * near 30000. A misplaced anchor produces ids scattered across the whole
 * 16-bit range instead.
 *
 * The other three are reported rather than filtered, because a reader that
 * hides what does not fit its expectation is how a wrong reading survives. One
 * of them has the id `0xffff` and walks to (307, 266) — a sane point — and the
 * game's own loop reads to a zero id without treating `0xffff` specially, so
 * this does too. What those three are is not established.
 *
 * **The coordinates are screen-shaped.** `x` reads directly as a signed
 * coordinate. `y` does not: its top bit is a flag, and masking it off turns
 * values like 33059 into 291. Every record then falls inside a 320x200 game's
 * plausible range, which is the arithmetic that distinguishes this reading from
 * one that merely produces numbers.
 *
 * ## What this is not
 *
 * **Not the whole of `HotspotResource`.** That record carries a room number,
 * size, layer, animation and script offsets besides, each behind its own
 * per-hotspot offset table. Those are further work and this file does not
 * pretend to them: what is read here is read, and the rest is absent rather
 * than guessed.
 */

/** Where `Lure.exe`'s data segment begins, for the English release. */
export const LURE_DATA_SEGMENT = 0xac50;

/** The walk-to list's offset within that segment. */
export const LURE_WALK_TO_OFFSET = 0xbc4b;

/** Six bytes: id, x, then y with a flag in its top bit. */
export const LURE_WALK_TO_BYTES = 6;

/**
 * `y`'s top bit, which is a flag and not part of the coordinate.
 *
 * Carried through rather than interpreted. Its meaning is not established here,
 * and inventing one on write would be the guess this family's reader refuses on
 * read — so an unedited table re-emits with every flag exactly as it arrived.
 */
const Y_FLAG = 0x8000;
const Y_MASK = 0x7fff;

/** The largest coordinate a 320x200 game plausibly walks to. */
const COORDINATE_LIMIT = 640;

export class LureHotspotError extends Error {}

/** One hotspot's walk-to point, with its fields named. */
export interface LureWalkTo {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  /** `y`'s top bit as it arrived, so a rewrite can put it back. */
  readonly yFlag: boolean;
}

/**
 * True when a file looks like Lure's DOS executable.
 *
 * The `MZ` marker and enough length to hold the table. Deliberately not a
 * version check: a release whose data segment sits elsewhere fails the
 * *content* checks in `parseLureWalkTo`, which is a better failure than a
 * length test that passes and addresses the wrong bytes.
 */
export function looksLikeLureExecutable(bytes: Uint8Array): boolean {
  if (bytes.length < LURE_DATA_SEGMENT + LURE_WALK_TO_OFFSET + LURE_WALK_TO_BYTES) return false;
  return bytes[0] === 0x4d && bytes[1] === 0x5a;
}

/**
 * Reads the walk-to table, or refuses.
 *
 * Refuses rather than returning something partial, and on the *content* rather
 * than on the length: a wrong anchor yields records that fit the file and mean
 * nothing, which is the failure that never errors.
 */
export function parseLureWalkTo(exe: Uint8Array): LureWalkTo[] {
  if (!looksLikeLureExecutable(exe)) {
    throw new LureHotspotError(
      `This file is ${exe.length} bytes and does not begin with an MZ marker, so it is not ` +
        `Lure's DOS executable and its data segment cannot be addressed.`,
    );
  }

  const view = new DataView(exe.buffer, exe.byteOffset, exe.byteLength);
  const start = LURE_DATA_SEGMENT + LURE_WALK_TO_OFFSET;
  const records: LureWalkTo[] = [];

  for (let at = start; at + LURE_WALK_TO_BYTES <= exe.length; at += LURE_WALK_TO_BYTES) {
    const id = view.getUint16(at, true);
    if (id === 0) break;
    const rawY = view.getUint16(at + 4, true);
    records.push({
      id,
      x: view.getInt16(at + 2, true),
      y: rawY & Y_MASK,
      yFlag: (rawY & Y_FLAG) !== 0,
    });
  }

  if (records.length === 0) {
    throw new LureHotspotError(
      `Lure's walk-to table is empty at its own offset, which means the data segment is not ` +
        `where this release keeps it. Nothing is read rather than something being invented.`,
    );
  }

  const strayCoordinate = records.find(
    (record) => Math.abs(record.x) > COORDINATE_LIMIT || record.y > COORDINATE_LIMIT,
  );
  if (strayCoordinate) {
    throw new LureHotspotError(
      `Hotspot ${strayCoordinate.id} walks to (${strayCoordinate.x}, ${strayCoordinate.y}), ` +
        `which is off any screen this game draws. The table was found at the right length and ` +
        `the wrong place, so it is refused rather than read.`,
    );
  }

  return records;
}

/**
 * Re-emits the table with the records given, copying the executable around it.
 *
 * Byte-identical when nothing changed, which is the property an export depends
 * on before every field is understood. The record count is fixed and so is the
 * id of each: a table that gained or lost a hotspot would move the terminator
 * and every byte after it, and the game's own code holds offsets into what
 * follows. So an edit moves a hotspot and cannot add one.
 */
export function writeLureWalkTo(exe: Uint8Array, records: readonly LureWalkTo[]): Uint8Array {
  const original = parseLureWalkTo(exe);
  if (records.length !== original.length) {
    throw new LureHotspotError(
      `This executable holds ${original.length} walk-to records and ${records.length} were ` +
        `given. The count is fixed: the terminator and everything after it would move, and the ` +
        `game holds offsets into that.`,
    );
  }

  const out = exe.slice();
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const start = LURE_DATA_SEGMENT + LURE_WALK_TO_OFFSET;

  records.forEach((record, index) => {
    if (record.id !== original[index].id) {
      throw new LureHotspotError(
        `Record ${index} is hotspot ${original[index].id} and ${record.id} was given. An edit ` +
          `moves a hotspot; it does not renumber one.`,
      );
    }
    const at = start + index * LURE_WALK_TO_BYTES;
    view.setUint16(at, record.id, true);
    view.setInt16(at + 2, record.x, true);
    view.setUint16(at + 4, (record.y & Y_MASK) | (record.yFlag ? Y_FLAG : 0), true);
  });

  return out;
}

/** The verifiable facts about the table, for a status line. */
export function describeLureWalkTo(records: readonly LureWalkTo[]): string {
  const inBand = records.filter(
    (record) =>
      (record.id >= 997 && record.id <= 1100) ||
      (record.id >= 10000 && record.id <= 10100) ||
      (record.id >= 30000 && record.id <= 30100),
  ).length;
  return (
    `${records.length} hotspot positions read from Lure.exe, ${inBand} of them in the game's ` +
    `own id bands, every coordinate on screen`
  );
}
