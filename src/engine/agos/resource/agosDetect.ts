/**
 * Recognising AGOS game data, and working out which Target it is.
 *
 * ## What the files can settle, and what they cannot
 *
 * File names get most of the way. Simon 2 ships `GAME32` or `GSPTR30` beside a
 * `SIMON2.GME`; Simon 1 ships `GAMEPC` beside a `SIMON.GME`; The Feeble Files
 * ships `GAME22` or `GAME33`. What they cannot settle is Elvira 1 from Elvira 2
 * from Waxworks: all three ship a bare `GAMEPC` and nothing else distinguishes
 * them by name.
 *
 * So the probe finishes the job structurally, and the check it uses is the one
 * ADR 0029 already relies on: read the whole game under a candidate Version and
 * require it to decode *and re-emit byte for byte*. Item records differ in
 * layout between those three, Elvira 1 reads 16-bit opcodes where the others
 * read bytes, and a whole-game round trip under the wrong candidate fails
 * almost immediately.
 *
 * ## Why this is a measurement rather than the guess ADR 0013 rejected
 *
 * ADR 0013 rejected "decoding under each candidate table and keeping whichever
 * fits" for AGI, and the difference is worth being precise about rather than
 * hoping nobody notices.
 *
 * AGI's rejected version was: dozens of candidate interpreter builds, judged by
 * per-resource plausibility, on bytecode whose instruction boundaries have no
 * end marker to disagree with. Nothing constrains a wrong answer.
 *
 * Here it is three candidates, judged by whether an entire game — every item
 * record, every Subroutine, every line terminator — decodes and writes back
 * identically. A wrong candidate has to survive thousands of independent
 * opportunities to disagree. That is `CONTEXT.md`'s **Structural agreement**
 * used as evidence rather than as a check, and this file admits it as
 * identification only when **exactly one** candidate survives. Two survivors is
 * reported as narrowed, not resolved: the game may still be played, and it is
 * refused for editing.
 */

import type { DataSource } from '../../resource/DataSource.js';
import type { AgosReleaseKind, AgosTarget, AgosVersion } from '../agosVersion.js';
import { readGamePc, writeGamePc } from './gamePc.js';

/** The base file a Version ships its item tree and bytecode in. */
const BASE_FILES: Record<string, readonly AgosVersion[]> = {
  gamepc: ['Elvira1', 'Elvira2', 'Waxworks', 'Simon1'],
  gsptr30: ['Simon2'],
  game32: ['Simon2'],
  game22: ['Feeble'],
  game33: ['Feeble'],
  gdemo: ['Simon1'],
  demo: ['Elvira1', 'Waxworks'],
};

/** Archives that name a Version outright. */
const ARCHIVE_FILES: Record<string, AgosVersion> = {
  'simon.gme': 'Simon1',
  'simon2.gme': 'Simon2',
};

/**
 * Files that mean a release carries recorded speech.
 *
 * The release kind is on the Target because it changes two opcodes' lengths
 * (ADR 0027's amendment), so this is not cosmetic: get it wrong and every
 * instruction after the first `BT`/`BTS` in a Subroutine is read at the wrong
 * offset. Re-encoded speech from ScummVM's tools counts, because ADR 0028
 * admits GOG, Steam and 25th Anniversary data.
 */
const SPEECH_EXTENSIONS = ['.voc', '.wav', '.mp3', '.ogg', '.fla', '.flac'];
const SPEECH_STEMS = ['simon', 'simon2', 'effects', 'voices', 'speech'];

function baseName(name: string): string {
  return (name.replace(/\\/g, '/').split('/').pop() ?? name).toLowerCase();
}

/**
 * Whether these files are AGOS data.
 *
 * Positive evidence only, as `loadEngine.ts` requires: a base file this family
 * owns, or one of its archives. "Not SCUMM" is not evidence of anything.
 */
export function looksLikeAgos(fileNames: string[]): boolean {
  const names = new Set(fileNames.map(baseName));
  for (const name of Object.keys(ARCHIVE_FILES)) if (names.has(name)) return true;
  for (const name of Object.keys(BASE_FILES)) {
    // `demo` alone is too weak: half the freeware on the internet is called
    // that. It counts only beside something else this family ships.
    if (names.has(name) && (name !== 'demo' || names.has('tbllist'))) return true;
  }
  return false;
}

export interface AgosFileEvidence {
  readonly baseFile?: string;
  readonly archiveFile?: string;
  readonly candidates: readonly AgosVersion[];
  readonly releaseKind: AgosReleaseKind;
}

/** What the file names alone say. */
export function agosFileEvidence(fileNames: string[]): AgosFileEvidence {
  const byBase = new Map(fileNames.map((name) => [baseName(name), name]));

  let baseFile: string | undefined;
  let candidates: AgosVersion[] = [];
  for (const [name, versions] of Object.entries(BASE_FILES)) {
    const actual = byBase.get(name);
    if (!actual) continue;
    baseFile = actual;
    candidates = [...versions];
    break;
  }

  let archiveFile: string | undefined;
  for (const [name, version] of Object.entries(ARCHIVE_FILES)) {
    const actual = byBase.get(name);
    if (!actual) continue;
    archiveFile = actual;
    // An archive names its Version outright, which is stronger than a base file
    // shared by four Versions.
    candidates = candidates.length > 0 ? candidates.filter((each) => each === version) : [version];
    if (candidates.length === 0) candidates = [version];
    break;
  }

  const talkie = [...byBase.keys()].some((name) => {
    const dot = name.lastIndexOf('.');
    if (dot < 0) return false;
    const stem = name.slice(0, dot);
    return SPEECH_EXTENSIONS.includes(name.slice(dot)) && SPEECH_STEMS.includes(stem);
  });

  return {
    ...(baseFile ? { baseFile } : {}),
    ...(archiveFile ? { archiveFile } : {}),
    candidates,
    releaseKind: talkie ? 'talkie' : 'floppy',
  };
}

export type AgosIdentification =
  /** The files named one Version and nothing had to be inferred. */
  | 'file-names'
  /** Exactly one candidate read the whole game and wrote it back byte for byte. */
  | 'structural'
  /** More than one candidate survived. Plays; refused for editing (ADR 0029). */
  | 'narrowed'
  /**
   * A candidate read the runtime database but the file holds more than that.
   *
   * Found by sweeping the only obtainable Elvira 1 and Waxworks data (#291).
   * Both demos are a `GAMEPC` with a **table of opcode names appended** —
   * `Abort`, `AddVerb`, `AddNoun` — which is a development build's symbols
   * rather than anything the runtime reads. The item tree, the strings and the
   * Subroutines all decode; the bytes after them are not modelled, so the file
   * does not re-emit whole.
   *
   * Plays, and is refused for editing by ADR 0030's rule that a region of this
   * file which cannot be parsed makes the *whole game* uneditable. Refusing to
   * **load** it as well was this project being stricter than its own ADRs:
   * ADR 0013 settled that a game whose Version can only be guessed "**plays** on
   * that guess and is **refused for editing**", and this is that case.
   */
  | 'partial';

export interface AgosDetection {
  readonly target: AgosTarget;
  readonly identification: AgosIdentification;
  /** Every Version still standing, which is one unless the identification is narrowed. */
  readonly candidates: readonly AgosVersion[];
  readonly baseFile: string;
}

/**
 * Works out the Target, reading the game's own bytes where names are not enough.
 *
 * Returns the surviving candidates as well as the chosen Target, because
 * `narrowed` is a real outcome rather than a failure and the caller has to be
 * able to say so.
 */
export async function detectAgosGame(
  source: DataSource,
  platform: 'dos' | 'windows' = 'dos',
): Promise<AgosDetection> {
  const evidence = agosFileEvidence(source.list());
  if (!evidence.baseFile) throw new Error('No AGOS base file (gamepc, game32, game22) is present.');
  if (evidence.candidates.length === 0) throw new Error('No AGOS Version claims these files.');

  const data = await source.read(evidence.baseFile);
  if (!data) throw new Error(`AGOS base file ${evidence.baseFile} could not be read.`);
  const survivors: AgosVersion[] = [];
  for (const version of evidence.candidates) {
    const target: AgosTarget = {
      family: 'AGOS',
      version,
      releaseKind: evidence.releaseKind,
      platform,
    };
    if (readsWholeGame(data, target)) survivors.push(version);
  }

  if (evidence.candidates.length === 1) {
    return {
      target: {
        family: 'AGOS',
        version: evidence.candidates[0]!,
        releaseKind: evidence.releaseKind,
        platform,
      },
      identification: 'file-names',
      candidates: evidence.candidates,
      baseFile: evidence.baseFile,
    };
  }

  if (survivors.length === 0) {
    // Nothing round-tripped. Before giving up, ask the weaker question — did
    // any candidate *read* the game? — because a file with something appended
    // to it is a readable game with an unmodelled tail rather than an
    // unreadable one, and the two deserve different answers.
    const readable = evidence.candidates.filter((version) =>
      readsGame(data, { family: 'AGOS', version, releaseKind: evidence.releaseKind, platform }),
    );
    if (readable.length === 0) {
      throw new Error(
        `No AGOS Version read ${evidence.baseFile} whole. Candidates tried: ${evidence.candidates.join(', ')}.`,
      );
    }
    return {
      target: {
        family: 'AGOS',
        version: readable[0]!,
        releaseKind: evidence.releaseKind,
        platform,
      },
      identification: 'partial',
      candidates: readable,
      baseFile: evidence.baseFile,
    };
  }

  return {
    target: {
      family: 'AGOS',
      version: survivors[0]!,
      releaseKind: evidence.releaseKind,
      platform,
    },
    identification: survivors.length === 1 ? 'structural' : 'narrowed',
    candidates: survivors,
    baseFile: evidence.baseFile,
  };
}

/**
 * Whether a game reads under this Target at all, without asking it to re-emit.
 *
 * The weaker half of `readsWholeGame`, and it exists because the two failures
 * mean different things. A read that throws is a Target that cannot explain the
 * bytes. A read that succeeds and a re-emission that is short is a Target that
 * explained every byte it was given and was not given all of them — which is
 * what a demo build with its symbol table appended looks like (#291).
 */
export function readsGame(data: Uint8Array, target: AgosTarget): boolean {
  try {
    readGamePc(data, target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a whole game reads under this Target and writes back identically.
 *
 * Both halves matter. A read that succeeds proves the layout was survivable; a
 * write that differs proves the model of it is incomplete, and an incomplete
 * model is exactly what a wrong Version produces when it happens to survive the
 * read.
 */
export function readsWholeGame(data: Uint8Array, target: AgosTarget): boolean {
  try {
    const game = readGamePc(data, target);
    const rebuilt = writeGamePc(game, target);
    if (rebuilt.length !== data.length) return false;
    for (let index = 0; index < data.length; index += 1) {
      if (rebuilt[index] !== data[index]) return false;
    }
    return true;
  } catch {
    return false;
  }
}
