/**
 * Broken Sword's two interpreter tables, found where they actually ship.
 *
 * ## The claim this file exists to retire
 *
 * Every page in this project has said the same thing about Broken Sword's room
 * table: editable here, and **not writable back**, because "it lived in
 * Revolution's interpreter rather than in the game's files". The first half of
 * that sentence is right and the second half was never tested. The interpreter
 * is in the install — `SWORD.EXE` sits beside `CLUSTERS/`, with `RUNSWORD.EXE`
 * and `WINSWORD.EXE` next to it — so "there is nowhere to write it" was an
 * assumption about a file nobody had opened.
 *
 * Both tables are in there, and they are in there in two different shapes,
 * which is why this file has two finders rather than one.
 *
 * ## The room table is data
 *
 * `RoomDef` is fifteen 32-bit words — `totalLayers`, `sizeX`, `sizeY`,
 * `gridWidth`, four layers, three grids, two palettes, two parallax — laid out
 * as an array of 100. It is found by *voting*: each screen whose first four
 * words are distinctive proposes the base its own position implies, and the
 * base most of them agree on is the table. Voting rather than searching for one
 * known screen, because a Release's table is not the built-in one — the demo's
 * differs from it on six screens, which is exactly the kind of difference a
 * finder anchored on a single literal would be defeated by.
 *
 * ## The start table is code
 *
 * `SWORD1_START_DATA`'s placements are not in the executable as a struct at
 * all. Revolution's `GEORGE_POS` is a macro that *assigns*, so the compiler
 * emitted four `mov dword ptr [address], immediate` instructions per placement:
 *
 * ```
 * C7 05 <x address>         <x>     ; mov [startX], 481
 * C7 05 <x address + 4>     <y>     ; mov [startY], 413
 * C7 05 <x address + 12>    <dir>   ; mov [startDir], 4
 * C7 05 <x address + 8>     <place> ; mov [startPlace], 0x10000
 * ```
 *
 * Forty bytes, four immediates, at +6, +16, +26 and +36. A search for the
 * table as *bytes* — which is what an earlier run did — finds nothing, and
 * "nothing" is what it reported: there is no struct to find. Grouping the runs
 * by the address they write to and taking the address most of them share is
 * what finds it, and it is also what proves the four writes belong to one
 * placement rather than to four unrelated variables.
 *
 * ## What this does not do
 *
 * It does not disassemble, relocate, or understand the executable in any other
 * way. A patch here writes four bytes over four bytes at an offset a decode
 * gave back — the file's length never changes, so nothing in it moves, and an
 * executable no edit names comes out of an export as the bytes it went in as.
 * That is the same principle the cluster writer follows, applied to a file
 * whose layout this project deliberately does not model.
 */

import { SWORD1_ROOMS, type Sword1RoomDef } from '../../engine/sword1/resource/swordRooms.js';

/** Words per `RoomDef`, and the bytes that makes it. */
export const SWORD1_ROOM_DEF_WORDS = 15;
export const SWORD1_ROOM_DEF_BYTES = SWORD1_ROOM_DEF_WORDS * 4;

/** Bytes of one `mov dword ptr [absolute], immediate`, and of one placement. */
const MOV_BYTES = 10;
const PLACEMENT_BYTES = MOV_BYTES * 4;

/**
 * Where each field of a placement is written, as an offset from the struct.
 *
 * The order the instructions come in is not the order the struct declares:
 * the compiler emits x, y, **direction**, place, writing +0, +4, +12, +8. Both
 * orders are here because the first is how the bytes are recognised and the
 * second is what they mean.
 */
const PLACEMENT_WRITE_ORDER = [0, 4, 12, 8] as const;

/** One `GEORGE_POS` placement, decoded out of the code that performs it. */
export interface Sword1StartPlacement {
  /** Its ordinal in the executable, which is how a project addresses it. */
  readonly index: number;
  /** File offset of the four-instruction run. */
  readonly at: number;
  /** The compact the player is placed on: `section * 0x10000 + index`. */
  readonly place: number;
  readonly x: number;
  readonly y: number;
  readonly direction: number;
}

/** The start table, as the executable holds it. */
export interface Sword1StartTable {
  /** The absolute address of the placement struct the writes target. */
  readonly address: number;
  readonly placements: readonly Sword1StartPlacement[];
}

/** The room table, as the executable holds it. */
export interface Sword1RoomTable {
  /** File offset of screen 0's `RoomDef`. */
  readonly at: number;
  /** Screens the file holds, which every release so far makes 100. */
  readonly rooms: readonly Sword1RoomDef[];
  /** How many of them are word for word the built-in table's. */
  readonly agreeing: number;
}

/** One executable of an install, and which of the two tables it holds. */
export interface Sword1Executable {
  /** The file's name as the folder has it, e.g. `SWORD.EXE`. */
  readonly file: string;
  readonly bytes: Uint8Array;
  readonly rooms: Sword1RoomTable | null;
  readonly starts: Sword1StartTable | null;
}

/** A single 32-bit write an export made, so a diff can be predicted. */
export interface Sword1ExecutableEdit {
  /** What was changed, in the words the editor would use. */
  readonly what: string;
  /** File offset of the four bytes. */
  readonly at: number;
  readonly from: number;
  readonly to: number;
}

function readWord(bytes: Uint8Array, at: number): number {
  return (
    (bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16) | (bytes[at + 3]! << 24)) >>> 0
  );
}

function readSigned(bytes: Uint8Array, at: number): number {
  return readWord(bytes, at) | 0;
}

function writeWord(bytes: Uint8Array, at: number, value: number): void {
  bytes[at] = value & 0xff;
  bytes[at + 1] = (value >>> 8) & 0xff;
  bytes[at + 2] = (value >>> 16) & 0xff;
  bytes[at + 3] = (value >>> 24) & 0xff;
}

/** A `RoomDef`'s fifteen words, in the order the struct declares them. */
function roomWords(room: Sword1RoomDef): number[] {
  return [
    room.totalLayers,
    room.sizeX,
    room.sizeY,
    room.gridWidth,
    ...[0, 1, 2, 3].map((index) => room.layers[index] ?? 0),
    ...[0, 1, 2].map((index) => room.grids[index] ?? 0),
    ...[0, 1].map((index) => room.palettes[index] ?? 0),
    ...[0, 1].map((index) => room.parallax[index] ?? 0),
  ];
}

/** The inverse: fifteen words back into the shape the project carries. */
function roomFromWords(words: readonly number[]): Sword1RoomDef {
  return {
    totalLayers: words[0]!,
    sizeX: words[1]!,
    sizeY: words[2]!,
    gridWidth: words[3]!,
    layers: [words[4]!, words[5]!, words[6]!, words[7]!],
    grids: [words[8]!, words[9]!, words[10]!],
    palettes: [words[11]!, words[12]!],
    parallax: [words[13]!, words[14]!],
  };
}

/**
 * Finds the room table by asking every screen where it would have to start.
 *
 * A screen whose first four words appear at file offset `o` implies the table
 * begins at `o - screen * 60`. Screens agreeing on one answer is the signal;
 * an accidental run of four words matching some screen's header is the noise,
 * and it never agrees with anything. The threshold is deliberately far below
 * 100: a Release whose table differs from the built-in one on a dozen screens
 * should still be found, and being found is what lets those differences be
 * *read* rather than assumed away.
 */
export function findSword1RoomTable(bytes: Uint8Array): Sword1RoomTable | null {
  const votes = new Map<number, number>();
  for (let screen = 1; screen < SWORD1_ROOMS.length; screen += 1) {
    const room = SWORD1_ROOMS[screen]!;
    if (room.sizeX === 0 || room.sizeY === 0) continue;
    const header = [room.totalLayers, room.sizeX, room.sizeY, room.gridWidth];
    for (let at = 0; at + SWORD1_ROOM_DEF_BYTES <= bytes.length; at += 4) {
      let same = true;
      for (let word = 0; word < header.length && same; word += 1) {
        same = readWord(bytes, at + word * 4) === header[word]!;
      }
      if (!same) continue;
      const base = at - screen * SWORD1_ROOM_DEF_BYTES;
      if (base < 0 || base + SWORD1_ROOMS.length * SWORD1_ROOM_DEF_BYTES > bytes.length) continue;
      votes.set(base, (votes.get(base) ?? 0) + 1);
    }
  }

  let at = -1;
  let best = 0;
  for (const [base, count] of votes) {
    if (count > best) {
      best = count;
      at = base;
    }
  }
  // Twenty screens agreeing is far past coincidence and far below the ~94 a
  // shipped executable gives, which leaves room for a Release that differs.
  if (at < 0 || best < 20) return null;

  const rooms: Sword1RoomDef[] = [];
  let agreeing = 0;
  for (let screen = 0; screen < SWORD1_ROOMS.length; screen += 1) {
    const start = at + screen * SWORD1_ROOM_DEF_BYTES;
    const words = Array.from({ length: SWORD1_ROOM_DEF_WORDS }, (_, word) =>
      readWord(bytes, start + word * 4),
    );
    rooms.push(roomFromWords(words));
    const want = roomWords(SWORD1_ROOMS[screen]!);
    if (want.every((value, word) => value >>> 0 === words[word]!)) agreeing += 1;
  }
  return { at, rooms, agreeing };
}

/**
 * Finds the start placements by grouping the code that performs them.
 *
 * Every candidate is four `mov dword ptr [abs], imm` in a row whose four
 * addresses are one base and that base plus 4, 12 and 8 — the shape
 * `GEORGE_POS` expands to. Four such runs could in principle write to four
 * different structs, so the base they share is the evidence: the address most
 * of the runs in the file agree on is the placement struct, and the runs
 * writing to anything else are not placements.
 */
export function findSword1StartTable(bytes: Uint8Array): Sword1StartTable | null {
  const runs = new Map<number, number[]>();
  for (let at = 0; at + PLACEMENT_BYTES <= bytes.length; at += 1) {
    if (bytes[at] !== 0xc7 || bytes[at + 1] !== 0x05) continue;
    const address = readWord(bytes, at + 2);
    let shaped = true;
    for (let field = 1; field < PLACEMENT_WRITE_ORDER.length && shaped; field += 1) {
      const instruction = at + field * MOV_BYTES;
      shaped =
        bytes[instruction] === 0xc7 &&
        bytes[instruction + 1] === 0x05 &&
        readWord(bytes, instruction + 2) === (address + PLACEMENT_WRITE_ORDER[field]!) >>> 0;
    }
    if (!shaped) continue;
    const list = runs.get(address) ?? [];
    list.push(at);
    runs.set(address, list);
  }

  let address = -1;
  let best: number[] = [];
  for (const [candidate, list] of runs) {
    if (list.length > best.length) {
      best = list;
      address = candidate;
    }
  }
  // Eight placements is already more than any four-word coincidence produces;
  // a shipped executable has fifty-odd.
  if (address < 0 || best.length < 8) return null;

  const placements = best
    .sort((left, right) => left - right)
    .map((at, index) => ({
      index,
      at,
      x: readSigned(bytes, at + 6),
      y: readSigned(bytes, at + 16),
      direction: readSigned(bytes, at + 26),
      place: readSigned(bytes, at + 36),
    }));
  return { address, placements };
}

/**
 * The executables in an install's file list, in the order a reader should try.
 *
 * Named rather than pattern-matched on `.exe` alone, because an install folder
 * may hold an installer or a setup program that is not the interpreter, and
 * searching a stranger's executable for a room table is how a false positive
 * gets written back. `SWORD.EXE` first because it is the DOS interpreter the
 * game runs from and the one whose tables agree most closely with the install
 * beside it.
 */
export const SWORD1_EXECUTABLE_NAMES = ['SWORD.EXE', 'WINSWORD.EXE', 'RUNSWORD.EXE'] as const;

/** Those of {@link SWORD1_EXECUTABLE_NAMES} a file list holds, in their own case. */
export function sword1ExecutableFilesIn(names: readonly string[]): string[] {
  const found: string[] = [];
  for (const wanted of SWORD1_EXECUTABLE_NAMES) {
    const match = names.find((name) => {
      const stem = name.split(/[/\\]/).pop() ?? name;
      return stem.toUpperCase() === wanted;
    });
    if (match !== undefined) found.push(match);
  }
  return found;
}

/** Reads an executable's two tables, either or both of which may be absent. */
export function readSword1Executable(file: string, bytes: Uint8Array): Sword1Executable {
  return {
    file,
    bytes,
    rooms: findSword1RoomTable(bytes),
    starts: findSword1StartTable(bytes),
  };
}

/** A room table's fields, named for an edit report. */
const ROOM_FIELD_NAMES = [
  'totalLayers',
  'sizeX',
  'sizeY',
  'gridWidth',
  'layer 0',
  'layer 1',
  'layer 2',
  'layer 3',
  'grid 0',
  'grid 1',
  'grid 2',
  'palette 0',
  'palette 1',
  'parallax 0',
  'parallax 1',
] as const;

/** What a caller wants written into an executable. */
export interface Sword1ExecutableEdits {
  /**
   * Screens, each naming its own number.
   *
   * By number rather than by position, because a project's room list is not
   * the table: it drops the screens whose size is zero, and a list indexed by
   * position would write screen 12's definition over screen 11.
   */
  readonly rooms?: readonly { readonly screen: number; readonly room: Sword1RoomDef }[];
  /** Placements, addressed by the ordinal a decode gave them. */
  readonly startPositions?: readonly {
    readonly index: number;
    readonly place: number;
    readonly x: number;
    readonly y: number;
    readonly direction: number;
  }[];
}

/**
 * Writes the fields that differ, and nothing else.
 *
 * Differ from *the executable*, not from the built-in tables: a Release whose
 * room table is not the built-in one must come back byte-identical when nobody
 * edited it, which is only true if what is compared against is what the file
 * holds. The edits are returned rather than merely applied so that a caller can
 * say which bytes a diff should show before it runs the diff.
 *
 * A placement whose `place` no longer matches the one at that ordinal is
 * refused: the ordinal addresses a run of code, and writing a placement into
 * the wrong one puts the player in a room the edit never named.
 */
export function patchSword1Executable(
  executable: Sword1Executable,
  edits: Sword1ExecutableEdits,
): { data: Uint8Array; edits: readonly Sword1ExecutableEdit[] } {
  const data = Uint8Array.from(executable.bytes);
  const made: Sword1ExecutableEdit[] = [];

  const table = executable.rooms;
  if (table && edits.rooms) {
    for (const { screen, room } of edits.rooms) {
      if (screen < 0 || screen >= table.rooms.length) continue;
      const want = roomWords(room);
      const start = table.at + screen * SWORD1_ROOM_DEF_BYTES;
      want.forEach((value, word) => {
        const at = start + word * 4;
        const from = readWord(data, at);
        if (from === value >>> 0) return;
        writeWord(data, at, value);
        made.push({
          what: `screen ${screen}'s ${ROOM_FIELD_NAMES[word]}`,
          at,
          from,
          to: value >>> 0,
        });
      });
    }
  }

  const starts = executable.starts;
  if (starts && edits.startPositions) {
    for (const wanted of edits.startPositions) {
      const placement = starts.placements[wanted.index];
      if (!placement) continue;
      if (placement.place !== wanted.place) {
        throw new Error(
          `Start position ${wanted.index} places the player on compact ` +
            `${placement.place} in ${executable.file} and this edit names ${wanted.place}. ` +
            `The ordinal addresses one run of code, so writing the second into the first ` +
            `would move a placement this edit never mentioned.`,
        );
      }
      const fields: Array<[string, number, number]> = [
        ['x', placement.at + 6, wanted.x],
        ['y', placement.at + 16, wanted.y],
        ['direction', placement.at + 26, wanted.direction],
      ];
      for (const [name, at, value] of fields) {
        const from = readWord(data, at);
        if (from === value >>> 0) continue;
        writeWord(data, at, value);
        made.push({
          what: `start position ${wanted.index}'s ${name}`,
          at,
          from,
          to: value >>> 0,
        });
      }
    }
  }

  return { data, edits: made };
}

/** A one-line account of what an executable holds, for a report or a log. */
export function describeSword1Executable(executable: Sword1Executable): string {
  const parts: string[] = [];
  parts.push(
    executable.rooms
      ? `a ${executable.rooms.rooms.length}-screen room table at 0x${executable.rooms.at.toString(16)} ` +
          `(${executable.rooms.agreeing} of ${executable.rooms.rooms.length} screens word for word ` +
          `the built-in table's)`
      : 'no room table',
  );
  parts.push(
    executable.starts
      ? `${executable.starts.placements.length} start placements writing to ` +
          `0x${executable.starts.address.toString(16)}`
      : 'no start placements',
  );
  return `${executable.file}: ${parts.join('; ')}`;
}
