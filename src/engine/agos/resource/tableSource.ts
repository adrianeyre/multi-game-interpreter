/**
 * The Subroutines and the strings that are not in `GAMEPC`.
 *
 * ## Why this file has to exist for the game to start at all
 *
 * `CONTEXT.md` says a game's Subroutines "are split across its `GAMEPC` and its
 * table resources, and where one lives is a packaging fact rather than a
 * meaningful one". Reading only the first half is not a partial game: it is a
 * game that never runs a line. Simon 1's boot calls Subroutine 101 and queues
 * Subroutine 1, and **neither is in `GAMEPC`** — both sit in `TABLES01`. So the
 * whole engine executed nothing at all until this reader existed, and it
 * reported that honestly and looked for the fault everywhere else.
 *
 * ## Two indexes, both beside the game and neither in it
 *
 * - `TBLLIST` maps a Subroutine number to the table file holding it. A record
 *   is a NUL-terminated name and then (min, max) pairs, ending on a zero
 *   minimum; the list ends where a name would start with a zero byte.
 * - `STRIPPED.txt` does the same for **local strings** — the ones whose id has
 *   the top bit set. A record is a NUL-terminated name and one word, which is
 *   the id the *next* file starts at. So a file's range is the previous
 *   record's word to its own, and the first starts at `0x8000`.
 *
 * The two formats are deliberately not shared. They look similar and differ in
 * the one place it matters — pairs against a single bound — and a reader that
 * tried to be both would be right about one of them.
 *
 * ## Local strings are not an optimisation
 *
 * A string id below `0x8000` indexes the pool in `GAMEPC`; at or above it, the
 * id names a line in one of these files. Simon 1's talkie keeps most of what
 * the game *says* there, so an interpreter without this reads the world's item
 * names correctly and shows no dialogue.
 */

import type { DataSource } from '../../resource/DataSource.js';
import type { AgosArchive } from './gameArchive.js';
import { readSubroutineBlock, type AgosSubroutineBlock } from '../script/subroutines.js';
import { archiveBasesFor, type AgosTarget } from '../agosVersion.js';

/** Where local string ids begin. Below this an id indexes `GAMEPC`'s own pool. */
export const LOCAL_STRING_BASE = 0x8000;

/** One `TBLLIST` record: a file and the Subroutine numbers it holds. */
export interface TableListEntry {
  readonly file: string;
  readonly ranges: readonly { readonly min: number; readonly max: number }[];
}

/** One `STRIPPED.txt` record: a file and the half-open range of ids it holds. */
export interface TextListEntry {
  readonly file: string;
  readonly min: number;
  readonly max: number;
}

function readName(data: Uint8Array, at: number): { name: string; next: number } | undefined {
  if (at >= data.length || data[at] === 0) return undefined;
  let end = at;
  while (end < data.length && data[end] !== 0) end += 1;
  const name = String.fromCharCode(...data.subarray(at, end));
  return { name, next: end + 1 };
}

function readWord(data: Uint8Array, at: number): number {
  return ((data[at] ?? 0) << 8) | (data[at + 1] ?? 0);
}

/**
 * Reads `TBLLIST`.
 *
 * A trailing name whose ranges run off the end of the file is dropped rather
 * than half-read: a truncated index would answer confidently for the numbers it
 * did manage to read and silently lose the rest.
 */
export function readTableList(data: Uint8Array): TableListEntry[] {
  const entries: TableListEntry[] = [];
  let at = 0;
  for (;;) {
    const name = readName(data, at);
    if (!name) break;
    at = name.next;
    const ranges: { min: number; max: number }[] = [];
    for (;;) {
      if (at + 1 >= data.length) return entries;
      const min = readWord(data, at);
      at += 2;
      if (min === 0) break;
      if (at + 1 >= data.length) return entries;
      const max = readWord(data, at);
      at += 2;
      ranges.push({ min, max });
    }
    entries.push({ file: name.name, ranges });
  }
  return entries;
}

/**
 * Reads `STRIPPED.txt`.
 *
 * The names carry a trailing space in every release seen — `"TEXT02 "` — and it
 * is kept rather than trimmed, because the number is parsed out of a fixed
 * position and the padding is what makes that position fixed.
 */
export function readTextList(data: Uint8Array): TextListEntry[] {
  const entries: TextListEntry[] = [];
  let at = 0;
  let min = LOCAL_STRING_BASE;
  for (;;) {
    const name = readName(data, at);
    if (!name) break;
    at = name.next;
    if (at + 1 >= data.length) break;
    const max = readWord(data, at);
    at += 2;
    entries.push({ file: name.name, min, max });
    min = max;
  }
  return entries;
}

/**
 * The number in a resource file's name.
 *
 * `TABLES01` and `TEXT02` both put it at the end, so the digits are taken from
 * the end rather than from a fixed column — which is also what makes a padded
 * `"TEXT02 "` work without trimming it first.
 */
function numberIn(file: string): number {
  const digits = /(\d+)\s*$/.exec(file);
  return digits ? Number(digits[1]) : 0;
}

/**
 * Where the Subroutines and strings that are not in `GAMEPC` come from.
 *
 * One interface over two packagings, the same split `zoneSource.ts` draws: the
 * Simons address these through the archive's offset table, and everything else
 * reads a file of the name beside the game.
 */
export interface TableSource {
  /** The `TBLLIST` records, for a report to say what was found. */
  readonly tables: readonly TableListEntry[];
  /** The `STRIPPED.txt` records. */
  readonly texts: readonly TextListEntry[];
  /**
   * The block of Subroutines holding this number, or nothing.
   *
   * Returns the whole block rather than the one Subroutine because that is what
   * the file holds and because the rest of it is about to be wanted: a table
   * file groups the Subroutines of one part of the game.
   */
  subroutinesFor(id: number): AgosSubroutineBlock | undefined;
  /** The local strings covering this id, keyed from the file's own first id. */
  stringsFor(id: number): { readonly min: number; readonly lines: readonly string[] } | undefined;
  /**
   * The sound-effect bank that belongs with the table holding this Subroutine.
   *
   * Simon 1's Windows release ships its effects as `SFXXXX02` … `SFXXXX29`,
   * **one file per `TABLES` file**, and the reference swaps the open one as it
   * loads a new part of the game — the effects a scene needs arrive with the
   * code for that scene. So which sound number 41 means depends on where the
   * game currently is, and a reader that opened one file for the whole game
   * would play the wrong door creak in nine rooms out of ten.
   *
   * Undefined for every other release, which keeps its effects in one place.
   */
  effectsFor(id: number): Uint8Array | undefined;
  /**
   * The number of the `TABLES` file holding this Subroutine, or nothing.
   *
   * Simon 2's effects are **not** files beside the game: they are in the
   * archive, and the reference indexes them by the table file's own number —
   * `_gameOffsetsPtr[atoi(filename + 6) - 1 + _soundIndexBase]` in
   * `subroutine.cpp:379`, run at the moment a `TABLES` file is loaded. So the
   * Engine needs the number rather than the bytes, and reads the bank through
   * `ZoneSource.sound` with it. Same fact as {@link effectsFor}, arriving by
   * the other of the two routes AGOS uses for everything.
   */
  tableNumberFor(id: number): number | undefined;
}

/** A game whose Subroutines are all in `GAMEPC`, which is what a bare dump is. */
export const noTables: TableSource = {
  tables: [],
  texts: [],
  subroutinesFor: () => undefined,
  stringsFor: () => undefined,
  effectsFor: () => undefined,
  tableNumberFor: () => undefined,
};

/**
 * Splits a text resource into its lines.
 *
 * NUL-separated, and the count is the range rather than a field — so a file
 * with fewer lines than its range claims yields the ones it has instead of
 * inventing empties, and one with more keeps them (a range is where the *next*
 * file starts, not a promise about this one's length).
 */
function splitStrings(bytes: Uint8Array): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let at = 0; at <= bytes.length; at += 1) {
    if (at === bytes.length || bytes[at] === 0) {
      if (at > start || at < bytes.length) {
        lines.push(String.fromCharCode(...bytes.subarray(start, at)));
      }
      start = at + 1;
    }
  }
  return lines;
}

/**
 * Reads whichever packaging these files use, or answers `noTables`.
 *
 * Both indexes are optional and independently so: a release can ship `TBLLIST`
 * and no `STRIPPED.txt`, and a bare `GAMEPC` dump ships neither. Nothing here
 * is an error, because a game with no table files is a game whose Subroutines
 * are all in `GAMEPC` and that is a real shape.
 */
export async function readTableSource(
  source: DataSource,
  target: AgosTarget,
  archive: AgosArchive | undefined,
): Promise<TableSource> {
  const find = (want: string): string | undefined =>
    source
      .list()
      .find((name) => (name.replace(/\\/g, '/').split('/').pop() ?? name).toLowerCase() === want);

  const tableListName = find('tbllist');
  const textListName = find('stripped.txt');
  const tableListBytes = tableListName ? await source.read(tableListName) : null;
  const textListBytes = textListName ? await source.read(textListName) : null;

  const tables = tableListBytes ? readTableList(tableListBytes) : [];
  const texts = textListBytes ? readTextList(textListBytes) : [];
  if (tables.length === 0 && texts.length === 0) return noTables;

  const bases = archiveBasesFor(target.version);

  /**
   * The bytes of one named resource.
   *
   * Two routes, chosen by whether this Version packs. The archive route is
   * arithmetic over the offset table — `TABLES01` is the table base and each
   * later file is one entry along — and the loose route is a file of that name
   * beside the game. Simon 1's floppy demo is the loose case with the same
   * `TBLLIST`, which is why the two live behind one call.
   */
  const readResource = async (
    file: string,
    base: number | undefined,
  ): Promise<Uint8Array | null> => {
    if (archive && base !== undefined) {
      return archive.read(base + numberIn(file) - 1) ?? null;
    }
    const beside = find(file.trim().toLowerCase());
    return beside ? await source.read(beside) : null;
  };

  // Read ahead of time rather than on demand, for `zoneSource.ts`'s reason: a
  // Subroutine is called inside a frame and a frame cannot wait on a file read.
  // The cost is bounded — Simon 1's thirty table files are 50KB of bytecode
  // between them, which is what `_tableMemSize` in the original says too.
  const blocks = new Map<string, AgosSubroutineBlock>();
  for (const entry of tables) {
    const bytes = await readResource(entry.file, bases?.tables);
    if (!bytes) continue;
    try {
      blocks.set(entry.file, readSubroutineBlock(bytes, target).block);
    } catch {
      // A table that will not decode is left out rather than allowed to throw
      // past a game's load. The Subroutines in it then answer "no such one",
      // which the interpreter already reports; a throw here would lose the
      // other twenty-nine files as well.
    }
  }

  /**
   * The per-table effect banks, where the release ships them.
   *
   * Read beside the game rather than out of the archive, because that is where
   * this release puts them: `TABLES07`'s effects are the file `SFXXXX07`. Files
   * 1 and 30 are skipped in the reference and are simply absent here, which
   * needs no special case — a name that is not there yields nothing.
   */
  const effects = new Map<string, Uint8Array>();
  for (const entry of tables) {
    const number = numberIn(entry.file);
    if (number === 0) continue;
    const name = find(`sfxxxx${String(number).padStart(2, '0')}`);
    if (!name) continue;
    const bytes = await source.read(name);
    if (bytes && bytes.length > 8) effects.set(entry.file, bytes);
  }

  const strings = new Map<string, string[]>();
  for (const entry of texts) {
    const bytes = await readResource(entry.file, bases?.text);
    if (!bytes) continue;
    strings.set(entry.file, splitStrings(bytes));
  }

  return {
    tables,
    texts,
    subroutinesFor(id) {
      for (const entry of tables) {
        if (!entry.ranges.some((range) => id >= range.min && id <= range.max)) continue;
        const block = blocks.get(entry.file);
        if (block) return block;
      }
      return undefined;
    },
    effectsFor(id) {
      for (const entry of tables) {
        if (!entry.ranges.some((range) => id >= range.min && id <= range.max)) continue;
        const bytes = effects.get(entry.file);
        if (bytes) return bytes;
      }
      return undefined;
    },
    tableNumberFor(id) {
      for (const entry of tables) {
        if (!entry.ranges.some((range) => id >= range.min && id <= range.max)) continue;
        const number = numberIn(entry.file);
        if (number > 0) return number;
      }
      return undefined;
    },
    stringsFor(id) {
      for (const entry of texts) {
        if (id < entry.min || id >= entry.max) continue;
        const lines = strings.get(entry.file);
        if (lines) return { min: entry.min, lines };
      }
      return undefined;
    },
  };
}
