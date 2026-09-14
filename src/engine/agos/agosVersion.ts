/**
 * What has to be known about an AGOS game before a byte of it can be read.
 *
 * `CONTEXT.md` calls this a Target. For AGOS it is the family, the Version, the
 * release kind and the platform — and the third of those is the one this file
 * exists to explain.
 *
 * ## The Version is a title, and a title is not quite enough
 *
 * Adventure Soft never versioned the engine: no version stamp, no version line,
 * and no shipped interpreter to probe the way AGI's can be. What AGOS has is a
 * game-type split, so a Version here is a **title** rather than a number (ADR
 * 0027) — `Simon1`, `Feeble`, and so on, written with the family and never
 * bare.
 *
 * ADR 0027 recorded a tripwire against that decision: *if two releases of the
 * same game disagree about an opcode's length, the title is not the Version*.
 * They do. Simon 1's floppy and talkie releases decode opcodes 67 and 162 as
 * `BT`/`BBT` and `BTS`/`BBTS` respectively — the talkie carries a speech id the
 * floppy has no room for — and Simon 2 differs in the same two places. Those two
 * opcodes are the entire disagreement between the tables, which is what makes
 * this so easy to miss and so total when missed. So the title alone does not fix
 * the encoding, and a Target has to carry the **release kind** as well.
 *
 * That is AGI's shape rather than SCUMM's, and it is the second time this
 * project has met it: a family whose major says *almost* how its bytecode
 * decodes, with the rest coming from which build shipped. It is recorded here
 * rather than smoothed over, because a Target that leaves the release kind out
 * is not a Target — it is a guess about how to decode, and the guess is wrong
 * for exactly two opcodes out of 256, which is the hardest kind of wrong to
 * notice and misplaces every instruction after the first one it reaches.
 */

import type { AgosOpcodeTableName } from './script/opcodeArgTables.js';

/** The seven AGOS Versions, each a title (ADR 0027). */
export const AGOS_VERSIONS = [
  'Elvira1',
  'Elvira2',
  'Waxworks',
  'Simon1',
  'Simon2',
  'Feeble',
  'PuzzlePack',
] as const;

export type AgosVersion = (typeof AGOS_VERSIONS)[number];

/**
 * Whether a release carries recorded speech.
 *
 * Part of the Target because it changes instruction lengths, not because it
 * changes which files ship. `CONTEXT.md`'s **Talkie** is the same word for the
 * same releases; this is that fact promoted to something decoding depends on.
 */
export type AgosReleaseKind = 'floppy' | 'talkie';

/** The platforms in scope. Others are declined in `.out-of-scope/agos-non-dos-releases.md`. */
export type AgosPlatform = 'dos' | 'windows';

export interface AgosTarget {
  readonly family: 'AGOS';
  readonly version: AgosVersion;
  readonly releaseKind: AgosReleaseKind;
  readonly platform: AgosPlatform;
}

/**
 * The argument table a Target decodes with.
 *
 * Only Simon 1 and Simon 2 split on the release kind; every other Version has
 * one table, and asking for the talkie variant of a Version that has none is
 * answered with the one it has rather than with an error, because a Feeble
 * Files release genuinely is a talkie and genuinely has one table.
 */
export function opcodeTableFor(target: AgosTarget): AgosOpcodeTableName {
  const talkie = target.releaseKind === 'talkie';
  switch (target.version) {
    case 'Elvira1':
      return 'elvira1';
    case 'Elvira2':
      return 'elvira2';
    case 'Waxworks':
      return 'waxworks';
    case 'Simon1':
      return talkie ? 'simon1talkie' : 'simon1dos';
    case 'Simon2':
      return talkie ? 'simon2talkie' : 'simon2dos';
    case 'Feeble':
      return 'feeblefiles';
    case 'PuzzlePack':
      return 'puzzlepack';
  }
}

/**
 * Whether opcodes are 16 bits wide.
 *
 * Elvira 1 alone reads a word where every later Version reads a byte, and its
 * `B` operands are words too. A single flag rather than a family branch, because
 * it is one fact about one Version and the reader is otherwise identical.
 */
export function hasWideOpcodes(version: AgosVersion): boolean {
  return version === 'Elvira1';
}

/**
 * The end-of-line marker a subroutine line stops at.
 *
 * Elvira 1 terminates on the word 10000 and every later Version on the byte
 * 0xFF. This is what **Structural agreement** (`CONTEXT.md`) is measured
 * against: a wrong argument table walks past the marker instead of landing on
 * it, which is how a misdecode announces itself here rather than staying silent
 * as AGI's does.
 */
export function lineTerminator(version: AgosVersion): number {
  return hasWideOpcodes(version) ? 10_000 : 0xff;
}

/**
 * The opcode whose operand is read raw rather than through the table.
 *
 * Both are the "line has a condition" marker the interpreter handles itself:
 * 198 in Elvira 1, 87 everywhere else. Named because a reader that sends it
 * through the table decodes the next instruction at the wrong offset, and that
 * failure looks exactly like a wrong table.
 */
export function rawWordOpcode(version: AgosVersion): number {
  return hasWideOpcodes(version) ? 198 : 87;
}

/**
 * Whether decoded values are held little-endian **in memory**.
 *
 * Not a file-format question, and the distinction is worth the sentence because
 * getting it backwards would misread every game. Everything read out of a game's
 * files is big-endian in every Version — AGOS grew up on the Amiga and the
 * Atari ST and stayed big-endian on DOS. What AGOS 2 changes is the byte order
 * of the interpreter's own decoded copy, which ScummVM expresses by overriding
 * its memory helpers in the subclass. This project decodes to numbers, so the
 * flag exists to answer the question rather than to be consulted by the reader.
 */
export function holdsDecodedLittleEndian(version: AgosVersion): boolean {
  return version === 'Feeble' || version === 'PuzzlePack';
}

/** The AGOS 2 Versions, which differ in more than byte order (ADR 0027). */
export function isAgos2(version: AgosVersion): boolean {
  return version === 'Feeble' || version === 'PuzzlePack';
}

/**
 * Whether the idle loop drains a *second* queued-Subroutine channel.
 *
 * `hitarea_stuff_helper` (`input.cpp:375`) splits on the family: Simon 1,
 * Elvira 2 and Waxworks read one channel — variable 254 — while Simon 2, The
 * Feeble Files and the Puzzle Pack test `_variableArray[254] || [249]` and drain
 * both in `hitarea_stuff_helper_2`, variable 249 first. Simon 2's walk uses 249
 * as exactly that: when the actor reaches a junction the walk queues its
 * room-change Subroutine there, and an idle pass that never looked at 249 left
 * the actor standing on the junction with nothing to run the crossing. Gated
 * because 249 is an ordinary variable to the families that do not poll it, and
 * running whatever number it happened to hold as a Subroutine would misfire.
 */
export function pollsSecondSubroutineChannel(version: AgosVersion): boolean {
  return version === 'Simon2' || version === 'Feeble' || version === 'PuzzlePack';
}

/**
 * Where a packed archive keeps things that are not zones.
 *
 * `SIMON.GME` is one offset table over five quite different kinds of resource,
 * and nothing in the file says which range is which: the zones start at entry
 * zero and the rest sit at bases the interpreter carried. So these four numbers
 * are the archive's whole table of contents, and they are the reason a table
 * subroutine can be found at all.
 *
 * They are byte offsets into the table divided by four in Adventure Soft's own
 * source, and that spelling is kept here — `1576 / 4` says where the number
 * came from in a way `394` does not.
 *
 * **Only the two Simons have them**, because only the two Simons pack. Elvira,
 * Waxworks and Simon 1's floppy demo keep their tables and text as loose files
 * beside the game, and the AGOS 2 games keep everything in a deflated container
 * with an index of its own. Answering `undefined` for those is the reader's cue
 * to look beside the game rather than a gap.
 */
export interface AgosArchiveBases {
  /** Entry of `TABLES01`; entry of `TABLES`*n* is this plus *n* − 1. */
  readonly tables: number;
  /** Entry of `TEXT01`, indexed the same way. */
  readonly text: number;
  /** Entry of music track 0, indexed directly. */
  readonly music: number;
  /** Entry of sound-effect bank 0. Zero where the release keeps effects elsewhere. */
  readonly sound: number;
}

const SIMON1_BASES: AgosArchiveBases = {
  tables: 1576 / 4,
  text: 1460 / 4,
  music: 1316 / 4,
  sound: 0,
};

/**
 * Simon 2's bases, with the General MIDI music set rather than the MT-32 one.
 *
 * Simon 2 ships both, one after the other, and the interpreter chooses on which
 * device the player has. GM is the choice here because it is the set every
 * release carries; MT-32 is `(1128 + 612) / 4` and is a device selection this
 * project does not make yet.
 */
const SIMON2_BASES: AgosArchiveBases = {
  tables: 1580 / 4,
  text: 1500 / 4,
  music: 1128 / 4,
  sound: 1660 / 4,
};

export function archiveBasesFor(version: AgosVersion): AgosArchiveBases | undefined {
  if (version === 'Simon1') return SIMON1_BASES;
  if (version === 'Simon2') return SIMON2_BASES;
  return undefined;
}
