/**
 * Beneath a Steel Sky's Compact table — the game's world, as named records.
 *
 * A Compact is one object in the game: where it is, what it looks like, which
 * script runs it, what it says when you point at it. There is no world without
 * them (ADR 0024), which is why a dump missing them cannot boot rather than
 * booting oddly.
 *
 * ## Where these come from, and the correction that matters
 *
 * **`sky.cpt` is read here, and that is the decision ADR 0024's first amendment
 * took** — a correction to what this project said for several months, including
 * in the file next door and in the pull request that added it.
 *
 * The short version: Revolution did not merely permit redistribution in 2003,
 * they gave ScummVM Beneath a Steel Sky's **original source code**, and the
 * freeware release was built with their support. So `sky.cpt` is not another
 * implementation's reading of a binary — it is source-derived and shipped as
 * part of that Release. The objection this ADR was built on ("a Target built on
 * `sky.cpt` would be derived from ScummVM's reading of the game rather than
 * from the game") does not apply to it, and the amendment says so in terms:
 *
 * - **Sky, 2003 freeware Release** — `sky.cpt` is accepted.
 * - **Sky, original 1994 floppy or CD** — extract from `SKY.EXE`.
 * - **Sky freeware floppy** — ships neither, and must be refused with a message
 *   saying exactly that.
 *
 * This file implements the first and the third. The second is refused by name
 * rather than attempted: no `SKY.EXE` is available to this project, so an
 * extractor for it could not be checked against anything, and an unchecked
 * extractor for the structure the whole world lives in is worse than an honest
 * refusal. #246 is the spike that would settle its shape.
 *
 * ## Why the reading can be trusted
 *
 * The file describes its own extent at every level, and all of it agrees on the
 * shipped release:
 *
 * - The section lengths consume the file **exactly** — 419,427 bytes, ending on
 *   the last byte of the per-Version reset data with nothing over.
 * - The compact data consumes its declared word count exactly: 148,603 words
 *   across 3,258 records in 9 lists.
 * - The name pool is consumed exactly: 42,395 bytes, one NUL-terminated name
 *   per non-empty record and one per alias, with nothing left.
 * - Every record's type is one of the seven the format defines. **Nothing is
 *   Unrecovered.**
 *
 * A wrong reading of any section length desynchronises the next one and fails
 * one of those, which is what makes them checks rather than observations.
 */

/** The file this reader is for, named for the messages. */
export const SKY_COMPACT_FILE = 'sky.cpt';

/** The freeware release's `sky.cpt`, whose size ScummVM also pins exactly. */
export const SKY_COMPACT_FREEWARE_BYTES = 419_427;

export class SkyCompactError extends Error {}

/**
 * The seven kinds of record the table holds.
 *
 * Only the first two have a field layout. The rest are arrays the game indexes
 * by number — a route buffer, an animation sequence — and inventing names for
 * their slots would be the guess this family's readers refuse. They are held as
 * words and reported as such.
 */
export type SkyCompactType =
  | 'compact'
  | 'turnTable'
  | 'animSequence'
  | 'miscBinary'
  | 'getToTable'
  | 'routeBuffer'
  | 'mainList';

const TYPE_BY_NUMBER: ReadonlyMap<number, SkyCompactType> = new Map([
  [1, 'compact'],
  [2, 'turnTable'],
  [3, 'animSequence'],
  [4, 'miscBinary'],
  [5, 'getToTable'],
  [6, 'routeBuffer'],
  [7, 'mainList'],
]);

/**
 * A Compact's fields, in the order they sit in the record.
 *
 * Every one is a 16-bit word, and the order is the record: field *n* is word
 * *n*. Names are the game's own, as carried in the source Revolution released —
 * `spWidth_xx` keeps its odd suffix for that reason, rather than being tidied
 * into something that would no longer match anything a person can look up.
 *
 * A record may be **shorter than this list**, and 200-odd of them are: `joey`
 * is 97 words, `joey_park` is 29. So naming stops where the record stops rather
 * than reading past it, which is the difference between a short record and a
 * corrupt one.
 */
export const SKY_COMPACT_FIELDS: readonly string[] = [
  'logic',
  'status',
  'sync',
  'screen',
  'place',
  'getToTableId',
  'xcood',
  'ycood',
  'frame',
  'cursorText',
  'mouseOn',
  'mouseOff',
  'mouseClick',
  'mouseRelX',
  'mouseRelY',
  'mouseSizeX',
  'mouseSizeY',
  'actionScript',
  'upFlag',
  'downFlag',
  'getToFlag',
  'flag',
  'mood',
  'grafixProgId',
  'grafixProgPos',
  'offset',
  'mode',
  'baseSub',
  'baseSub_off',
  'actionSub',
  'actionSub_off',
  'getToSub',
  'getToSub_off',
  'extraSub',
  'extraSub_off',
  'dir',
  'stopScript',
  'miniBump',
  'leaving',
  'atWatch',
  'atWas',
  'alt',
  'request',
  'spWidth_xx',
  'spColor',
  'spTextId',
  'spTime',
  'arAnimIndex',
  'turnProgId',
  'turnProgPos',
  'waitingFor',
  'arTargetX',
  'arTargetY',
  'animScratchId',
  'megaSet',
];

/**
 * The fields the original structure kept in 32 bits.
 *
 * The file stores every field as one 16-bit word, and so does this reader — but
 * a script's `push_offset` operand is a **byte offset into the original
 * structure**, where these four were four bytes wide. So the operand cannot be
 * halved to get a word index; it has to be mapped.
 */
const SKY_WIDE_FIELDS: ReadonlySet<string> = new Set([
  'getToTableId',
  'grafixProgId',
  'turnProgId',
  'animScratchId',
]);

/** Built once: byte offset in the original structure to word index here. */
const FIELD_AT_BYTE = ((): ReadonlyMap<number, { index: number; name: string }> => {
  const map = new Map<number, { index: number; name: string }>();
  let byteOffset = 0;
  SKY_COMPACT_FIELDS.forEach((name, index) => {
    // `grafixProgPos` and `turnProgPos` are the second halves of the wide
    // fields before them, so they take no byte offset of their own: the wide
    // field already claimed four bytes for the pair.
    if (name === 'grafixProgPos' || name === 'turnProgPos') return;
    map.set(byteOffset, { index, name });
    byteOffset += SKY_WIDE_FIELDS.has(name) ? 4 : 2;
  });
  return map;
})();

/**
 * Resolves a script's `push_offset` operand to a field of the record.
 *
 * Returns null for an offset that is not a field's first byte — which the
 * shipped game never produces, and which is refused rather than rounded down,
 * because rounding would silently read the field before the one asked for.
 *
 * ## Measured, over every script in the game
 *
 * The shipped bytecode uses **22 distinct offsets**, every one of them even,
 * the largest 82, and every one landing on a field's first byte:
 *
 * `status`, `sync`, `screen`, `place`, `xcood`, `ycood`, `frame`,
 * `cursorText`, `mouseOn`, `mouseClick`, `mouseRelX`, `mouseRelY`,
 * `mouseSizeX`, `mouseSizeY`, `actionScript`, `upFlag`, `downFlag`,
 * `getToFlag`, `flag`, `dir`, `atWatch`, `atWas`.
 *
 * Two things follow, and both remove a hazard rather than describe one:
 *
 * 1. **No script indexes past the Compact's own fields.** ScummVM's equivalent
 *    reaches into the current animation set and then into *that* set's turn
 *    table — a different record entirely — and nothing in the shipped game asks
 *    for it. So an engine does not need that indirection to run this game, and
 *    would be writing it untested if it did.
 * 2. **No script lands on a wide field's second half.** ScummVM's offset table
 *    maps those to offset 0, which is the `logic` field — a shim that would be
 *    a real fault if anything used it. Nothing does.
 */
export function skyCompactFieldAt(byteOffset: number): { index: number; name: string } | null {
  return FIELD_AT_BYTE.get(byteOffset) ?? null;
}

/** A walking character's set of animations, appended to a Compact. */
export const SKY_MEGA_SET_FIELDS: readonly string[] = [
  'gridWidth',
  'colOffset',
  'colWidth',
  'lastChr',
  'animUpId',
  'animDownId',
  'animLeftId',
  'animRightId',
  'standUpId',
  'standDownId',
  'standLeftId',
  'standRightId',
  'standTalkId',
  'turnTableId',
];

/** Five directions, five frames each. A `turnTable` record is exactly this. */
export const SKY_TURN_TABLE_FIELDS: readonly string[] = [
  'turnTableUp',
  'turnTableDown',
  'turnTableLeft',
  'turnTableRight',
  'turnTableTalk',
];

const TURN_TABLE_STEPS = 5;

/** One record: its identity, its type, its named fields and its own words. */
export interface SkyCompactRecord {
  /** `(list << 12) | index`, which is how a script names one. */
  readonly id: number;
  readonly list: number;
  readonly index: number;
  readonly name: string;
  readonly type: SkyCompactType;
  /**
   * Every word of the record, in order.
   *
   * **Preserved bytes.** A record may hold more words than this reader names,
   * and an export writes these back rather than regenerating them from the
   * fields — so a word nobody has read is carried rather than invented.
   */
  readonly words: Uint16Array;
  /** Named fields, for the two types that have a layout. Empty otherwise. */
  readonly fields: ReadonlyMap<string, number>;
  /** A walking character's animation sets, in order. Empty for most records. */
  readonly megaSets: readonly ReadonlyMap<string, number>[];
  /** Five frames per direction, for a `turnTable`. Empty otherwise. */
  readonly turns: ReadonlyMap<string, readonly number[]>;
}

/** A record that is a second name for another one, rather than a record. */
export interface SkyCompactAlias {
  readonly id: number;
  readonly name: string;
  readonly targetId: number;
}

/** Something the reader could not turn into a record. Target: zero. */
export interface SkyCompactNote {
  readonly id: number;
  readonly reason: string;
}

/**
 * A Release's starting world, as a base state plus that Release's own changes.
 *
 * The Compacts define what an object *is*; this says where everything stands
 * when a new game begins, and it differs per Release — seven of them are
 * carried, from v0.0288 to v0.0372. Both freeware releases are among them
 * (348 and 372), which is what makes this checkable here at all.
 *
 * Kept separate from the records on purpose. A player's saved game is the same
 * shape as this, so #258's round trip is this structure's round trip, and
 * folding it into the records would hide that.
 */
export interface SkyResetState {
  /** Revolution's build number: v0.0`build`. */
  readonly build: number;
  /** The starting state, with this build's changes already applied. */
  readonly words: Uint16Array;
  /** How many words this build changed from the shared base. */
  readonly changed: number;
}

export interface SkyCompacts {
  readonly records: readonly SkyCompactRecord[];
  readonly aliases: readonly SkyCompactAlias[];
  /** The ids a saved game has to carry, which the file lists for itself. */
  readonly saveIds: readonly number[];
  /** Empty slots per list, which the format uses rather than compacting ids. */
  readonly emptySlots: number;
  /** The starting state per Release, one entry per build the file carries. */
  readonly resetStates: readonly SkyResetState[];
  readonly notes: readonly SkyCompactNote[];
  /** Everything after the compact data, carried for a byte-identical write. */
  readonly trailer: Uint8Array;
  /** The offsets a writer needs to put edited words back in place. */
  readonly layout: SkyCompactLayout;
}

/** Where each record's words sit in the file, so a write can substitute them. */
export interface SkyCompactLayout {
  readonly wordOffsets: ReadonlyMap<number, number>;
  readonly sourceLength: number;
}

/**
 * Reads `sky.cpt` into records.
 *
 * Refuses rather than returning a partial table: a Compact table read half way
 * yields objects that exist and are in the wrong places, which is the failure
 * that looks like a game bug for a week.
 */
export function parseSkyCompacts(bytes: Uint8Array): SkyCompacts {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;

  const u16 = (): number => {
    if (at + 2 > bytes.length) {
      throw new SkyCompactError(
        `${SKY_COMPACT_FILE} ends in the middle of a section header, at byte ${at} of ` +
          `${bytes.length}. The file is truncated.`,
      );
    }
    const value = view.getUint16(at, true);
    at += 2;
    return value;
  };
  const u32 = (): number => {
    if (at + 4 > bytes.length) {
      throw new SkyCompactError(
        `${SKY_COMPACT_FILE} ends in the middle of a section length, at byte ${at} of ` +
          `${bytes.length}. The file is truncated.`,
      );
    }
    const value = view.getUint32(at, true);
    at += 4;
    return value;
  };

  const fileVersion = u16();
  if (fileVersion !== 0) {
    throw new SkyCompactError(
      `${SKY_COMPACT_FILE} declares version ${fileVersion} and only version 0 has ever ` +
        `existed. This is not a Compact table this project can read.`,
    );
  }

  const listCount = u16();
  const listLengths: number[] = [];
  for (let i = 0; i < listCount; i += 1) listLengths.push(u16());

  const declaredWords = u32();
  const sourceWords = u32();
  const sourceAt = at;
  at += sourceWords * 2;
  const asciiLength = u32();
  const asciiAt = at;
  at += asciiLength;
  if (at > bytes.length) {
    throw new SkyCompactError(
      `${SKY_COMPACT_FILE} declares ${sourceWords} words of compact data and ${asciiLength} ` +
        `bytes of names, which together run past the end of a ${bytes.length}-byte file.`,
    );
  }

  const records: SkyCompactRecord[] = [];
  const notes: SkyCompactNote[] = [];
  const wordOffsets = new Map<number, number>();
  let emptySlots = 0;
  let words = 0;
  let source = sourceAt;
  let ascii = asciiAt;

  const readName = (): string => {
    const start = ascii;
    while (ascii < asciiAt + asciiLength && bytes[ascii] !== 0) ascii += 1;
    const name = String.fromCharCode(...bytes.subarray(start, ascii));
    ascii += 1;
    return name;
  };

  for (let list = 0; list < listCount; list += 1) {
    for (let index = 0; index < listLengths[list]; index += 1) {
      const size = view.getUint16(source, true);
      source += 2;
      if (size === 0) {
        // Not a gap in the data: the format keeps a slot so that ids stay put.
        // Compacting them would renumber every compact after the hole, and the
        // scripts hold those numbers.
        emptySlots += 1;
        continue;
      }

      const typeNumber = view.getUint16(source, true);
      source += 2;
      const id = (list << 12) | index;
      const name = readName();
      const type = TYPE_BY_NUMBER.get(typeNumber);

      if (source + size * 2 > sourceAt + sourceWords * 2) {
        throw new SkyCompactError(
          `Compact ${name} (${id.toString(16)}) claims ${size} words, which runs past the ` +
            `end of the compact data. A section length has been misread — nothing after ` +
            `this point would be in the right place.`,
        );
      }

      const recordWords = new Uint16Array(size);
      for (let w = 0; w < size; w += 1) recordWords[w] = view.getUint16(source + w * 2, true);
      wordOffsets.set(id, source);
      source += size * 2;
      words += size;

      if (!type) {
        // Reported rather than dropped: an unknown type still has its words,
        // and an export must be able to write them back untouched.
        notes.push({
          id,
          reason: `${name} has type ${typeNumber}, which the format does not define`,
        });
      }

      records.push({
        id,
        list,
        index,
        name,
        type: type ?? 'miscBinary',
        words: recordWords,
        fields: type === 'compact' ? nameFields(recordWords) : new Map(),
        megaSets: type === 'compact' ? readMegaSets(recordWords) : [],
        turns: type === 'turnTable' ? readTurns(recordWords) : new Map(),
      });
    }
  }

  if (words !== declaredWords) {
    throw new SkyCompactError(
      `${SKY_COMPACT_FILE} declares ${declaredWords} words of compact data and its records ` +
        `account for ${words}. The two must agree exactly: a table that disagrees with its ` +
        `own length has been misread somewhere earlier.`,
    );
  }

  at = sourceAt + sourceWords * 2 + 4 + asciiLength;
  const aliasCount = u16();
  const aliases: SkyCompactAlias[] = [];
  for (let i = 0; i < aliasCount; i += 1) {
    const id = u16();
    const targetId = u16();
    aliases.push({ id, targetId, name: '' });
  }
  // Alias names continue the same pool, after every record's name — which is
  // why they are read here rather than beside their ids.
  const named = aliases.map((alias) => ({ ...alias, name: readName() }));

  if (ascii !== asciiAt + asciiLength) {
    throw new SkyCompactError(
      `${SKY_COMPACT_FILE}'s name pool is ${asciiLength} bytes and the records and aliases ` +
        `consumed ${ascii - asciiAt}. A name pool that does not come out even means a record ` +
        `was skipped or read twice.`,
    );
  }

  const diffCount = u16();
  const diffWords = u16();
  at += diffWords * 2;
  void diffCount;

  const saveIdCount = u16();
  const saveIds: number[] = [];
  for (let i = 0; i < saveIdCount; i += 1) saveIds.push(u16());

  // The starting state, and then one patch list per Release. Each patch list is
  // read whether or not anything wants it, because skipping to the one that
  // matters means trusting a length rather than checking it — and the check is
  // that the last one ends on the file's last byte.
  const baseWordCount = u16();
  const baseWords = new Uint16Array(baseWordCount);
  for (let i = 0; i < baseWordCount; i += 1) baseWords[i] = u16();

  const resetStates: SkyResetState[] = [];
  const buildCount = u16();
  for (let i = 0; i < buildCount; i += 1) {
    const build = u16();
    const changed = u16();
    const words = baseWords.slice();
    for (let change = 0; change < changed; change += 1) {
      const where = u16();
      const what = u16();
      if (where >= words.length) {
        notes.push({
          id: build,
          reason:
            `v0.0${build}'s starting state changes word ${where}, past the end of a ` +
            `${words.length}-word state`,
        });
        continue;
      }
      words[where] = what;
    }
    resetStates.push({ build, words, changed });
  }

  if (at !== bytes.length) {
    throw new SkyCompactError(
      `${SKY_COMPACT_FILE} has ${bytes.length - at} bytes after its last Release's starting ` +
        `state, and should have none. Every section length in this file is checked by the ` +
        `next one, and this is the last check: something above has been misread.`,
    );
  }

  return {
    records,
    aliases: named,
    saveIds,
    emptySlots,
    resetStates,
    notes,
    // Everything from the alias table onwards, carried whole. None of it is
    // edited by this project, and regenerating a section nobody edits is how a
    // writer stops being byte-identical.
    trailer: bytes.subarray(sourceAt + sourceWords * 2 + 4 + asciiLength),
    layout: { wordOffsets, sourceLength: bytes.length },
  };
}

/** Names as many fields as the record actually holds, and no more. */
function nameFields(words: Uint16Array): Map<string, number> {
  const fields = new Map<string, number>();
  const count = Math.min(words.length, SKY_COMPACT_FIELDS.length);
  for (let i = 0; i < count; i += 1) fields.set(SKY_COMPACT_FIELDS[i], words[i]);
  return fields;
}

/**
 * The animation sets appended after the Compact's own fields.
 *
 * Whole ones only. A trailing part-set would mean the record's length disagreed
 * with its shape, and naming half of one would put a `standTalkId` where the
 * game keeps something else.
 */
function readMegaSets(words: Uint16Array): Map<string, number>[] {
  const sets: Map<string, number>[] = [];
  let at = SKY_COMPACT_FIELDS.length;
  while (at + SKY_MEGA_SET_FIELDS.length <= words.length) {
    const set = new Map<string, number>();
    SKY_MEGA_SET_FIELDS.forEach((name, i) => set.set(name, words[at + i]));
    sets.push(set);
    at += SKY_MEGA_SET_FIELDS.length;
  }
  return sets;
}

function readTurns(words: Uint16Array): Map<string, readonly number[]> {
  const turns = new Map<string, readonly number[]>();
  SKY_TURN_TABLE_FIELDS.forEach((name, i) => {
    const at = i * TURN_TABLE_STEPS;
    if (at + TURN_TABLE_STEPS <= words.length) {
      turns.set(name, Array.from(words.subarray(at, at + TURN_TABLE_STEPS)));
    }
  });
  return turns;
}

/**
 * Writes the table back, substituting the records given and copying the rest.
 *
 * Byte-identical when nothing is replaced. Replacement is by id and **must
 * preserve the record's word count**: a record that grew would move every
 * record after it and invalidate the ids the game's own scripts hold, which is
 * ADR 0024's size rule and the reason an editor refuses a shape change before
 * attempting it rather than after.
 */
export function writeSkyCompacts(
  original: Uint8Array,
  compacts: SkyCompacts,
  replacements: ReadonlyMap<number, Uint16Array> = new Map(),
): Uint8Array {
  if (original.length !== compacts.layout.sourceLength) {
    throw new SkyCompactError(
      `This ${original.length}-byte file is not the ${compacts.layout.sourceLength}-byte one ` +
        `these compacts were read from, so the offsets they carry do not address it.`,
    );
  }

  const out = original.slice();
  const view = new DataView(out.buffer);

  for (const [id, words] of replacements) {
    const at = compacts.layout.wordOffsets.get(id);
    if (at === undefined) {
      throw new SkyCompactError(
        `This table holds no compact ${id.toString(16)}, so it cannot be replaced.`,
      );
    }
    const existing = compacts.records.find((record) => record.id === id);
    if (existing && existing.words.length !== words.length) {
      throw new SkyCompactError(
        `Compact ${existing.name} is ${existing.words.length} words and the replacement is ` +
          `${words.length}. Values may change; the shape may not. A record that changed ` +
          `length would move every record after it and invalidate the ids the game's own ` +
          `scripts hold (ADR 0024).`,
      );
    }
    words.forEach((word, i) => view.setUint16(at + i * 2, word, true));
  }

  return out;
}

/**
 * Why a folder cannot supply Compacts, in terms a player can act on.
 *
 * Returns null when it can. The message names the file rather than describing
 * the problem in the abstract, because "resources only" dumps circulate for
 * every engine and this is the family where they are useless: with no Compacts
 * there is no world, so the game cannot boot at all (ADR 0024).
 */
export function describeMissingCompacts(fileNames: readonly string[]): string | null {
  const present = new Set(
    fileNames.map((name) => (name.replace(/\\/g, '/').split('/').pop() ?? name).toLowerCase()),
  );

  if (present.has('sky.cpt')) return null;

  if (present.has('sky.exe')) {
    return (
      `This looks like an original Beneath a Steel Sky release: it ships SKY.EXE, which is ` +
      `where those Releases keep the Compact table. Reading it out of the executable is not ` +
      `implemented, and an unchecked reading of the structure the whole game world lives in ` +
      `would be worse than this message. A release to check such a reader against is ` +
      `fetchable — ScummVM's demo mirror carries DOS demos that ship SKY.EXE — so what is ` +
      `missing here is the work and not the data (#246, #252). The 2003 freeware CD ` +
      `release, which ships sky.cpt instead, is the one that works today.`
    );
  }

  return (
    `This folder has no Compact table, so Beneath a Steel Sky cannot start: the Compacts are ` +
    `the game's objects, and with none of them there is no world to draw. The 2003 freeware ` +
    `CD release ships sky.cpt beside sky.dnr and sky.dsk; the freeware floppy release ships ` +
    `neither that nor SKY.EXE, and cannot be played here for that reason.`
  );
}
