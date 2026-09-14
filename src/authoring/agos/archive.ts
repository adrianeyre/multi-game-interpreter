/**
 * Writing an AGOS resource archive back out.
 *
 * The half of export ADR 0030 requires and that did not exist: it wants the
 * rebuilt base file *and* the rebuilt archive produced together, "either both
 * or neither", and `exportAgosProject` wrote only `GAMEPC`. So a painted image
 * survived in a saved project and could not reach a game folder.
 *
 * ## The inverse of the reader, and nothing cleverer
 *
 * `readAgosArchive` reads a table of 32-bit offsets whose own byte length is
 * the first word, and takes an entry to run from its offset **to the next
 * higher non-zero offset**. Two consequences fall straight out of that and
 * shape everything here.
 *
 * Entries have to be written in increasing offset order, because their lengths
 * are implied by their neighbours rather than stored. And a zero offset means
 * *absent* — an entry number the archive skips — so the numbering is sparse and
 * has to stay sparse: closing a gap would renumber every entry above it, and an
 * entry number is what a script asks for.
 *
 * ## Entry 0 is required, because word 0 does double duty
 *
 * The first word is the table's byte length *and* entry 0's offset, because
 * entry 0's data begins immediately after the table. That is not a guess: Simon
 * 1's CD demo archive reports 1700 for word 0 — 425 entries of four bytes — and
 * entry 0 occupying 1700 to 2700, with entry 1 starting at exactly 2700.
 *
 * So an archive **without** an entry 0 cannot be expressed: whatever value word
 * 0 holds, the reader will take it as entry 0's offset. An input that omits it
 * is refused rather than written into an archive that reads back differently
 * from what was handed over — which is exactly how this was found, by a
 * byte-identity test on an unedited archive growing by two bytes.
 *
 * ## Why the round trip is the test that matters
 *
 * Because the lengths are implied, an off-by-one in the table does not corrupt
 * the entry it belongs to — it corrupts the *previous* one, by moving where it
 * ends. So the property worth asserting is that reading back what was written
 * yields the same entries, which is what `agos-archive.test.ts` does.
 */

import { readAgosArchive } from '../../engine/agos/resource/gameArchive.js';
import { applyPaintedImages, type PaintedImage } from './paint.js';
import { exportAgosProject, type AgosProject } from './project.js';

/** A raw-offset slot carries no bytes; this is what stands in for its data. */
const EMPTY = new Uint8Array(0);

/** One entry to write, at the number a script will ask for it by. */
export interface ArchiveInput {
  readonly number: number;
  readonly data: Uint8Array;
  /**
   * Another entry number this one is the *same resource* as.
   *
   * The archive aliases: two numbers can carry the same offset, and Simon 1's
   * `simon.gme` does it six times. The reader derives a length from the next
   * offset above, so an alias reads back as a second copy of the same bytes —
   * and a writer that took that at face value emitted both, which grew an
   * unedited Simon 1 archive by 9,436 bytes and broke the byte identity ADR
   * 0030 rests on. Stated rather than inferred from the bytes being equal: two
   * resources that happen to hold the same bytes are not the same resource, and
   * merging them would be the writer inventing structure the game did not have.
   */
  readonly sameAs?: number;
  /**
   * A literal offset to write into this slot, for a table entry that names no
   * data.
   *
   * Simon 2's archive has a slot whose offset points a gigabyte past the file
   * (`ArchiveEntry.preserved`). It is not a resource and there is nothing to
   * lay out for it, but the count still has to include it or word 0 changes and
   * every entry shifts. So the reader hands its offset straight through and the
   * writer stamps it back into the table without contributing any bytes —
   * ADR 0035's preserved region, expressed as an offset rather than as content.
   * `data` is ignored when this is set.
   */
  readonly rawOffset?: number;
}

/**
 * Builds an archive from its entries.
 *
 * The table is sized by the highest entry number rather than by how many
 * entries there are, because the numbering is sparse and the table is indexed
 * by number. An absent number gets a zero offset, which is how the reader
 * already spells "nothing here".
 */
export function writeAgosArchive(entries: readonly ArchiveInput[]): Uint8Array {
  if (entries.length === 0) throw new Error('an archive with no entries has no offset table');

  const byNumber = new Map<number, Uint8Array>();
  const aliases = new Map<number, number>();
  const rawOffsets = new Map<number, number>();
  for (const entry of entries) {
    if (entry.number < 0 || !Number.isInteger(entry.number)) {
      throw new Error(`entry number ${entry.number} is not a slot`);
    }
    if (byNumber.has(entry.number)) {
      throw new Error(`entry ${entry.number} was given twice`);
    }
    byNumber.set(entry.number, entry.data);
    if (entry.sameAs !== undefined) aliases.set(entry.number, entry.sameAs);
    if (entry.rawOffset !== undefined) rawOffsets.set(entry.number, entry.rawOffset);
  }

  for (const [number, target] of aliases) {
    if (!byNumber.has(target)) {
      throw new Error(`entry ${number} claims to be entry ${target}, which is not here`);
    }
    if (aliases.has(target)) {
      // One hop only. A chain would need resolving before offsets are laid out
      // and there is no archive that has one, so it is refused rather than
      // supported on speculation.
      throw new Error(`entry ${number} aliases ${target}, which is itself an alias`);
    }
  }

  if (!byNumber.has(0)) {
    // Not a tidiness check. Word 0 is both the table length and entry 0's
    // offset, so an archive with no entry 0 reads back with whatever follows
    // the table *as* entry 0.
    throw new Error('an archive must have an entry 0: word 0 is also its offset');
  }

  const highest = Math.max(...byNumber.keys());
  const count = highest + 1;
  const tableBytes = count * 4;

  // An alias contributes no bytes: it points at another entry's offset. Nor
  // does a raw-offset slot: it names data that is not in the file at all.
  const total = [...byNumber.entries()].reduce(
    (sum, [number, each]) =>
      aliases.has(number) || rawOffsets.has(number) ? sum : sum + each.length,
    tableBytes,
  );
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);

  // The first word is the table's own byte length, which is how the reader
  // learns the count before it can read any offset.
  view.setUint32(0, tableBytes, true);

  // In increasing number order, which is also increasing offset order — the
  // reader derives a length from the next offset, so the two orders cannot
  // disagree.
  const offsetOf = new Map<number, number>();
  let at = tableBytes;
  for (let number = 0; number < count; number += 1) {
    const data = byNumber.get(number);
    if (!data) {
      // Absent. Left as a zero offset, and *not* closed up: closing a gap
      // renumbers everything above it, and a number is what a script asks for.
      if (number > 0) view.setUint32(number * 4, 0, true);
      continue;
    }
    if (aliases.has(number)) continue;
    // A preserved slot: stamp its literal offset and lay out nothing. It names
    // data outside the file, so there is no running position to give it.
    if (rawOffsets.has(number)) {
      if (number > 0) view.setUint32(number * 4, rawOffsets.get(number)!, true);
      continue;
    }
    offsetOf.set(number, at);
    if (number > 0) view.setUint32(number * 4, at, true);
    out.set(data, at);
    at += data.length;
  }

  // The aliases last, once every referent has an offset — an alias may name a
  // higher number than itself, and the original archives do.
  for (const [number, target] of aliases) {
    const offset = offsetOf.get(target);
    if (offset === undefined) throw new Error(`entry ${target} was never laid out`);
    if (number === 0) {
      // Word 0 is the table length as well as entry 0's offset, so entry 0
      // cannot be moved to sit on top of another entry.
      throw new Error('entry 0 cannot be an alias: word 0 is also the table length');
    }
    view.setUint32(number * 4, offset, true);
  }
  return out;
}

/**
 * An archive with every painted image applied.
 *
 * A zone's two resources sit at `zone * 2` and `zone * 2 + 1` — scripts then
 * pixels — which is arithmetic rather than a lookup, so the pixels an image
 * belongs to are found by number. Zones nobody painted are copied through
 * untouched, which is what keeps an export of an unedited game byte-identical.
 */
export function exportAgosArchive(
  original: Uint8Array,
  painted: readonly PaintedImage[],
): Uint8Array {
  const archive = readAgosArchive(original);
  const zones = new Set(painted.map((each) => each.zone));

  /*
   * Which entries are the same resource under two numbers.
   *
   * The archive aliases — Simon 1's does it six times — and the reader has no
   * way to say so, because it derives a length from the next offset and an
   * alias therefore reads back as an ordinary second copy. The offsets are
   * where the fact lives, so it is recovered here and stated to the writer;
   * without it an unedited Simon 1 archive comes back 9,436 bytes longer than
   * it went in.
   */
  const firstAt = new Map<number, number>();
  const sameAs = new Map<number, number>();
  for (const entry of archive.entries) {
    const first = firstAt.get(entry.offset);
    if (first === undefined) firstAt.set(entry.offset, entry.number);
    else sameAs.set(entry.number, first);
  }

  // Odd numbers are pixel resources; a zone's is `zone * 2 + 1`.
  const isPainted = (number: number): boolean => number % 2 === 1 && zones.has((number - 1) / 2);

  /*
   * An alias survives only while both of its numbers still mean the same bytes.
   *
   * Asked of the *pair* rather than of the entry being written, because the
   * alias is recorded on one side and the paint may land on the other: dropping
   * it only where the paint landed left the other number still pointing at the
   * painted offset, which is the silent repaint this exists to prevent.
   */
  const aliasSurvives = (number: number, first: number): boolean =>
    !isPainted(number) && !isPainted(first);

  const entries: ArchiveInput[] = archive.entries.map((entry) => {
    // A preserved slot names no data (its offset points past the file), so it
    // is handed straight back as its literal offset rather than read. Done
    // before the read below, which returns undefined for exactly these.
    if (entry.preserved) {
      return { number: entry.number, data: EMPTY, rawOffset: entry.offset };
    }
    const data = archive.read(entry.number);
    if (!data) throw new Error(`entry ${entry.number} could not be read back`);
    const first = sameAs.get(entry.number);
    const alias = first !== undefined && aliasSurvives(entry.number, first) ? first : undefined;

    if (!isPainted(entry.number)) return { number: entry.number, data, sameAs: alias };
    return {
      number: entry.number,
      data: applyPaintedImages(data, (entry.number - 1) / 2, painted),
    };
  });

  return writeAgosArchive(entries);
}

/** The two artefacts an AGOS export produces, or neither. */
export interface AgosExport {
  /** The rebuilt base file. */
  readonly gamePc: Uint8Array;
  /** The rebuilt resource archive, with every painted image applied. */
  readonly archive: Uint8Array;
}

/**
 * Exports a Project as both of its files, or as neither.
 *
 * ADR 0030 is explicit that this is **one operation**: "a Subroutine moved
 * between them, or a string index that no longer resolves, is a game that
 * loads and then misbehaves", so export "either produces both or produces
 * neither". Until now only the base file could be written, which is the
 * weaker half of that promise and quietly the more dangerous one — a folder
 * with a rebuilt `GAMEPC` and its original archive is exactly the mismatch the
 * ADR warns about.
 *
 * Both are built before either is returned. That is what makes the guarantee
 * real rather than stated: a failure in the archive half leaves the caller with
 * nothing to write, instead of a base file already on disk and an archive that
 * threw.
 *
 * The original archive is a **parameter** rather than something held, on
 * ADR 0010's re-supply path: the Project keeps the author's intent and asks for
 * the game folder again at export, because a zone resource is far past the size
 * at which keeping originals is reliable.
 *
 * The paint intent is a parameter too, and for a duller reason: there are two
 * `AgosProject` types, the engine-side one this exporter reads and the
 * editor-side one the intent is recorded on. Taking the list explicitly beats
 * duplicating the field onto both, where the two copies would eventually
 * disagree about which is authoritative.
 */
export function exportAgosGame(
  project: AgosProject,
  originalArchive: Uint8Array,
  painted: readonly PaintedImage[] = [],
): AgosExport {
  // Refused here as well as inside `exportAgosProject`, so the archive half is
  // never built for a game that cannot be written. The message is that
  // function's, so the two cannot drift.
  const gamePc = exportAgosProject(project);
  const archive = exportAgosArchive(originalArchive, painted);
  return { gamePc, archive };
}
