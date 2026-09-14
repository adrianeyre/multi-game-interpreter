/**
 * Everything about a game that must be known before a byte of it can be read.
 *
 * `CONTEXT.md` calls this a **Target**, and the emphasis on *inseparable* is the
 * whole point: a family without a version and a version without a family are
 * both meaningless, and `{engine: 'agi', version: 6}` is not a thing that
 * exists. ADR 0004 gave a project two numbers — the project format version and
 * the SCUMM version — and ADR 0012 turns the second of those into this pair.
 *
 * The two arms are **not symmetrical**, and that asymmetry is the decision. A
 * SCUMM Version fixes the instruction encoding. An AGI major version does not:
 * it fixes only the resource layout. What fixes AGI's encoding is the
 * Interpreter version and the platform, so those are what the AGI arm carries
 * and the major is derived (`agiMajor`).
 */

import type { SciIdentification, SciPlatform, SciVersion } from '../engine/sci/sciVersion.js';
import { describeSciVersion, SCI_PLATFORMS, SCI_VERSIONS } from '../engine/sci/sciVersion.js';

/**
 * The SCUMM versions with an interpreter and an assembler behind them.
 *
 * The whole of `ScummVersion`, and deliberately the same set: a Version that
 * plays and cannot be tagged is a Version whose projects acquire a neighbour's
 * number, which is the mis-tag ADR 0012 exists to prevent. What differs
 * between them is not whether a Target may name them but which writer an
 * export reaches for, and that is decided by the Resource layout rather than
 * by this union.
 */
export type ScummVersionTarget = 2 | 3 | 4 | 5 | 6 | 7 | 8;

export const SCUMM_VERSION_TARGETS: readonly ScummVersionTarget[] = [2, 3, 4, 5, 6, 7, 8];

/**
 * The platforms an AGI release shipped on that change how its bytecode decodes.
 *
 * Not cosmetic. On Apple IIgs `hide.mouse` and `show.mouse` take a different
 * number of arguments and `discard.sound` is not even the same opcode number;
 * on Amiga and Atari ST, three titles disagree with everyone else about
 * `adj.ego.move.to.x.y`. A Target that leaves the platform out is a guess about
 * how to decode (`CONTEXT.md`).
 */
export type AgiPlatform = 'dos' | 'amiga' | 'atari-st' | 'apple-ii-gs' | 'macintosh';

export const AGI_PLATFORMS: readonly AgiPlatform[] = [
  'dos',
  'amiga',
  'atari-st',
  'apple-ii-gs',
  'macintosh',
];

/**
 * The build of Sierra's interpreter a game shipped against, as ScummVM writes
 * it: `0x2089` for 2.089, `0x2917` for 2.917, `0x3149` for 3.002.149.
 *
 * The top nibble is the major and the rest is the build, which is what makes
 * `>= 0x3000` the whole of the AGI v3 test. Held as a number rather than a
 * string so those comparisons are comparisons rather than parses.
 */
export type InterpreterVersion = number;

/**
 * The interpreter version assumed when a game's own could not be identified.
 *
 * 2.917 is the most common AGI v2 build and the one whose arity table matches
 * the most releases, so a game that lands here usually plays correctly. It is
 * still a guess: per ADR 0013 a game on this default **plays** and is
 * **refused for editing**, because a wrong arity on an opcode no script calls
 * costs nothing to play and everything to edit.
 */
export const DEFAULT_AGI_INTERPRETER: InterpreterVersion = 0x2917;

/**
 * How an AGI Target's interpreter version was established.
 *
 * Carried with the Target rather than worked out again later, because ADR 0013
 * makes the editing decision turn on it: the Unrecovered count is meaningless
 * without knowing whether the table that produced it was read or guessed.
 */
export type InterpreterIdentification =
  /** Read from the game's own `agidata.ovl`, which is the authoritative table. */
  | 'agidata'
  /** Matched a known release by hashing the shipped interpreter. */
  | 'interpreter-hash'
  /** Read from the version string a v3 game keeps in its volumes. */
  | 'volume-header'
  /**
   * Stated by the person doing the editing, for a dump that ships no
   * interpreter.
   *
   * ADR 0013 refuses to edit on a *guess*, and this is not one: the engine is
   * not inferring a version from evidence it does not have, a person is
   * asserting one they know. The two fail differently, which is the whole
   * reason they are different values here. A wrong guess is the engine's fault
   * and silent — nothing on screen distinguishes it from a right one. A wrong
   * declaration is the author's, made deliberately, against a warning, and is
   * recorded in the project so the mistake is visible afterwards rather than
   * inferred from a tree that reads oddly.
   *
   * Many dumps in circulation carry only `LOGDIR`/`VOL.n`/`OBJECT`/`WORDS.TOK`
   * and no interpreter at all, and for those there is no evidence to read and
   * never will be. Without this they are permanently uneditable however much
   * their owner knows about them.
   */
  | 'declared'
  /**
   * Narrowed to one candidate by decoding the game's own bytecode.
   *
   * ADR 0013 refuses to edit on a guess, and set the bar as *reading* a version
   * out of the game. This clears it a second way, the way ADR 0020 does for
   * SCI: a DOS AGI v2 game admits exactly three arity tables — below 2.089,
   * exactly 2.089, and above it — and a table that is wrong for a game is not
   * quietly wrong. Every Logic is decoded under each candidate and one is kept
   * only if every byte of every code section decoded, no opcode was unknown,
   * and every `if` and `goto` landed on an instruction boundary.
   *
   * **A probe that leaves two candidates is not this value.** It reports the
   * narrowing and stays a `fallback`, because "one of these two" is still a
   * guess between them.
   *
   * King's Quest III used to be the example of exactly that and is now the
   * example of getting past it, which is worth keeping in the order it
   * happened. The probe ruled out the pre-2.089 table on five unknown opcodes,
   * seven truncated Logics and twenty jumps into the middle of an instruction —
   * and left 2.089 and 2.917 both standing, because they differ only in `quit`'s
   * arity and its operand byte decodes as a valid instruction either way. Both
   * readings were internally consistent, every jump landed in both, and the game
   * stayed uneditable.
   *
   * What separated them was **where a Logic ends**. Sierra's compiler ends every
   * one on `return` and the interpreter needs it, since a Logic that runs off
   * its code section would execute its own message table. Under 2.917 all 125
   * Logics end on `return`; under 2.089 logic 98 does not. 125 of 125 against
   * 124 of 125 is the whole difference, and it is enough — so this copy is
   * `bytecode-probe` and editable with nothing declared.
   */
  | 'bytecode-probe'
  /** Nothing identified it; `DEFAULT_AGI_INTERPRETER` was assumed. */
  | 'fallback';

/**
 * The interpreter builds whose arity tables `opcodeSetFor` tells apart.
 *
 * Offered when a person declares a version, so the choice is between tables
 * that actually differ rather than between version strings. Anything narrower
 * hides a table someone needs; anything wider offers a distinction this
 * codebase does not make.
 */
export const DECLARABLE_INTERPRETERS: readonly InterpreterVersion[] = [
  0x2089, 0x2272, 0x2440, 0x2917, 0x3086, 0x3149,
];

/**
 * How a SCUMM game's Version was established.
 *
 * The same distinction `InterpreterIdentification` draws for AGI and for the
 * same reason (ADR 0013): a Version arrived at by guess is safe to *play* on
 * and not safe to edit on. It matters on the Classic side in particular, where
 * v2 and v3 share a filename shape — decode a v2 script with v3's table and
 * every boundary after the first renumbered instruction is wrong, and
 * re-emitting with the same wrong table writes that misreading back byte for
 * byte, so the round-trip check passes while the structure is nonsense.
 */
export type ScummIdentification = 'index-structure' | 'known-release' | 'guess';

import { AGOS_VERSIONS } from '../engine/agos/agosVersion.js';
import type { AgosPlatform, AgosReleaseKind, AgosVersion } from '../engine/agos/agosVersion.js';
import type { AgosIdentification } from '../engine/agos/resource/agosDetect.js';

export type { AgosPlatform, AgosReleaseKind, AgosVersion, AgosIdentification };

/**
 * One packaging of Beneath a Steel Sky.
 *
 * `CONTEXT.md` calls this a **Release**, and the Sky arm carries one where the
 * other three arms carry a Version — because Sky has no Version axis. There is
 * one game and one engine lineage under it, and calling these Versions would
 * put one word in the glossary doing two jobs in two families, which is the
 * ambiguity the "never bare v3" rule exists to prevent (ADR 0023).
 */
export type SkyRelease = 'demo' | 'floppy' | 'cd';

export const SKY_RELEASES: readonly SkyRelease[] = ['demo', 'floppy', 'cd'];

/** One packaging of Lure of the Temptress. Its own axis, per ADR 0026. */
export type LureRelease = 'demo' | 'floppy';

export const LURE_RELEASES: readonly LureRelease[] = ['demo', 'floppy'];

/**
 * The platforms a Virtual Theatre release shipped on that this project reads.
 *
 * `dos` only, following `SciPlatform`'s precedent exactly: "adding one later is
 * a value and a resource-layer implementation, not a change of shape."
 *
 * The refusal is sharper here than it is for SCI, and
 * `.out-of-scope/virtual-theatre-non-dos-releases.md` has the reason. ADR 0024
 * reads each game's object table out of its **DOS executable**; an Amiga or
 * Atari ST release has no such file, so supporting one means a second extractor
 * against a second binary format to recover a table this project can already
 * recover.
 */
export type SkyPlatform = 'dos';

export const SKY_PLATFORMS: readonly SkyPlatform[] = ['dos'];

export type LurePlatform = 'dos';

export const LURE_PLATFORMS: readonly LurePlatform[] = ['dos'];

import type { Sword1Identification, Sword1Release } from '../engine/sword1/resource/swordDetect.js';
import { SWORD1_RELEASES } from '../engine/sword1/resource/swordDetect.js';
import type {
  Sword2Identification,
  Sword2Release,
} from '../engine/sword2/resource/sword2Detect.js';
import { SWORD2_RELEASES } from '../engine/sword2/resource/sword2Detect.js';

export type { Sword1Identification, Sword1Release, Sword2Identification, Sword2Release };
export { SWORD1_RELEASES, SWORD2_RELEASES };

/**
 * The platforms the two Broken Sword families read.
 *
 * `dos` only, following `SkyPlatform`'s precedent word for word: "adding one
 * later is a value and a resource-layer implementation, not a change of shape".
 *
 * The refusal is *softer* here than it is for the Virtual Theatre families, and
 * the difference is worth stating. ADR 0024 refuses their non-DOS releases
 * because their object tables live in a DOS executable that an Amiga release
 * does not have. Broken Sword needs no executable at all — its cluster index is
 * self-describing — so the Macintosh and PlayStation releases are *readable*
 * here and the resource layer already handles their byte order and their
 * compression. What they are not is a Target value yet, because nothing has
 * been checked against one.
 */
export type Sword1Platform = 'dos';

export const SWORD1_PLATFORMS: readonly Sword1Platform[] = ['dos'];

export type Sword2Platform = 'dos';

export const SWORD2_PLATFORMS: readonly Sword2Platform[] = ['dos'];

export type Target =
  | {
      engine: 'scumm';
      version: ScummVersionTarget;
      /**
       * How `version` was arrived at. Absent means it was not recorded, which
       * is read as positively identified — every Version this project supports
       * is decided from the index's own structure, so the absence of a note is
       * the historical case rather than a doubt.
       */
      identification?: ScummIdentification;
    }
  | {
      engine: 'agi';
      interpreter: InterpreterVersion;
      platform: AgiPlatform;
      /**
       * How `interpreter` was arrived at. Absent means it was not recorded,
       * which is treated as `fallback` — the cautious reading.
       */
      identification?: InterpreterIdentification;
      /**
       * The game's own short id, when it is one of the titles whose arity
       * table disagrees with its interpreter version.
       *
       * ADR 0012's arm does not list this and the corrections to #123 and #126
       * show why it has to be here anyway: `adj.ego.move.to.x.y` takes two
       * arguments in Gold Rush and both Manhunters on Amiga and Atari ST and
       * none anywhere else. A Target is everything that must be known before a
       * byte can be read, and for those three titles that includes which title
       * it is.
       */
      gameId?: string;
    }
  | {
      engine: 'sci';
      /**
       * The Version, at the granularity where decoding changes (ADR 0016).
       *
       * Never a catalogue bucket: `SCI1` names three Versions and `SCI2.1`
       * another three, and `CONTEXT.md` is firm that writing the bucket where a
       * Version is meant is how three different things get one branch.
       */
      version: SciVersion;
      platform: SciPlatform;
      /**
       * How `version` was arrived at (ADR 0020). Absent is read as `guess`,
       * which is the cautious reading — SCI stamps its version nowhere, so the
       * absence of a note is not evidence that anything identified it.
       */
      identification?: SciIdentification;
    }
  | {
      engine: 'agos';
      /**
       * The Version, which for AGOS is a title rather than a number (ADR 0027).
       *
       * Adventure Soft never versioned the engine, so the seams where decoding
       * changes are the games themselves.
       */
      version: AgosVersion;
      /**
       * Whether the release carries recorded speech.
       *
       * On the Target because it changes decoding, not because it changes which
       * files ship: Simon 1 and Simon 2 each decode two opcodes differently
       * between their floppy and talkie releases. ADR 0027's tripwire fired on
       * exactly this, and the amendment there is why the field exists.
       */
      releaseKind: AgosReleaseKind;
      platform: AgosPlatform;
      /**
       * How `version` was arrived at. Absent is read as `narrowed`, the
       * cautious reading, because AGOS stamps its Version nowhere either.
       */
      identification?: AgosIdentification;
    }
  | {
      /**
       * Beneath a Steel Sky (ADR 0023).
       *
       * Named `sky` rather than `virtual-theatre` deliberately: Virtual Theatre
       * is Revolution's name for a lineage and it covers **two** interpreters,
       * so it is not a family name. `CONTEXT.md` keeps it as the word for the
       * pair and as an _Avoid_ against either family's name.
       *
       * No `identification` field. The other three arms carry one because their
       * version can be arrived at by guess, and ADR 0013's rule is that a guess
       * plays and does not edit. Sky has nothing to guess at: the Release is
       * not a decoding decision in the way a Version is, and if it turns out to
       * be one, this arm gains the field rather than the Release becoming a
       * Version.
       */
      engine: 'sky';
      release: SkyRelease;
      platform: SkyPlatform;
    }
  | {
      /** Lure of the Temptress — a fifth family, not a Sky Release (ADR 0026). */
      engine: 'lure';
      release: LureRelease;
      platform: LurePlatform;
    }
  | {
      /**
       * Broken Sword: The Shadow of the Templars (ADR 0036).
       *
       * A Release rather than a Version, for the reason ADR 0023 gives about
       * Sky: one game, one engine lineage. What varies is the packaging.
       *
       * Unlike Sky's and Lure's arms this one **carries an
       * `identification`**, and the reason is a real difference rather than
       * tidiness: Broken Sword's demo and its retail release ship different
       * numbers of script variables and renumber their sound samples, so the
       * Release is a decoding decision here in the way it is not there. ADR
       * 0013's rule then applies — a Release arrived at by guess plays and does
       * not edit — which is why `fallback` exists as a value.
       */
      engine: 'sword1';
      release: Sword1Release;
      platform: Sword1Platform;
      identification?: Sword1Identification;
    }
  | {
      /**
       * Broken Sword II: The Smoking Mirror (ADR 0036).
       *
       * A separate family from `sword1`, not a Release of it. They share a
       * publisher and a naming scheme and share **no bytecode, no resource
       * layout and no renderer** — which is `CONTEXT.md`'s whole test for an
       * Engine family, failed on all three counts.
       */
      engine: 'sword2';
      release: Sword2Release;
      platform: Sword2Platform;
      identification?: Sword2Identification;
    };

/**
 * The AGI major version, which governs resource packaging and nothing else.
 *
 * Derived, never stored (ADR 0012). v2 has four `*DIR` files and uncompressed
 * volumes; v3 has one combined `<GAMEID>DIR` and volumes whose resources may be
 * LZW-compressed. The instruction encoding is shared between them, which is why
 * one script engine covers both.
 */
export function agiMajor(interpreter: InterpreterVersion): 2 | 3 {
  return interpreter >= 0x3000 ? 3 : 2;
}

/** `0x3149` -> `"3.002.149"`, `0x2917` -> `"2.917"`. */
export function formatInterpreterVersion(interpreter: InterpreterVersion): string {
  const major = interpreter >> 12;
  const build = interpreter & 0x0fff;
  const digits = build.toString(16).padStart(3, '0');
  // v3 builds are written `3.002.149` by Sierra and everyone since; v2 builds
  // are written `2.917`. The middle group is always `002` for the v3 releases
  // this engine sees, so it is spelled rather than stored.
  return major >= 3 ? `${major}.002.${digits}` : `${major}.${digits}`;
}

/** "SCUMM v6", "AGI v2 (2.917)", "AGOS Simon1 (talkie)" — never a bare version. */
export function describeTarget(target: Target): string {
  if (target.engine === 'scumm') return `SCUMM v${target.version}`;
  if (target.engine === 'sci') return describeSciVersion(target.version);
  // An AGOS Version is a title, and the release kind is written with it because
  // decoding depends on both (ADR 0023's amendment).
  if (target.engine === 'agos') {
    const platform = target.platform === 'dos' ? '' : `, ${target.platform}`;
    return `AGOS ${target.version} (${target.releaseKind}${platform})`;
  }
  // Always family-qualified, like every other arm: "Sky" and "Lure" are the
  // family names, and a bare "floppy" names a Release of either.
  if (target.engine === 'sky') return `Sky (${target.release})`;
  if (target.engine === 'lure') return `Lure (${target.release})`;
  // Family-qualified like every other arm. "Sword1" and "Sword2" are the family
  // names — ScummVM's, and the ones `docs/scummvm-parity-roadmap.md` queued
  // them under — and a bare "cd" names a Release of either.
  if (target.engine === 'sword1') return `Sword1 (${target.release})`;
  if (target.engine === 'sword2') return `Sword2 (${target.release})`;
  const platform = target.platform === 'dos' ? '' : `, ${target.platform}`;
  return `AGI v${agiMajor(target.interpreter)} (${formatInterpreterVersion(
    target.interpreter,
  )}${platform})`;
}

/** True when both Targets name the same engine, version and encoding. */
export function sameTarget(a: Target, b: Target): boolean {
  if (a.engine !== b.engine) return false;
  if (a.engine === 'scumm' && b.engine === 'scumm') return a.version === b.version;
  if (a.engine === 'agi' && b.engine === 'agi') {
    return a.interpreter === b.interpreter && a.platform === b.platform;
  }
  if (a.engine === 'sci' && b.engine === 'sci') {
    return a.version === b.version && a.platform === b.platform;
  }
  if (a.engine === 'agos' && b.engine === 'agos') {
    // The release kind is part of the comparison for the same reason it is part
    // of the Target: two releases of one game decode differently, so treating
    // them as the same Target is how an edit lands in a misread structure.
    return a.version === b.version && a.releaseKind === b.releaseKind && a.platform === b.platform;
  }
  if (a.engine === 'sky' && b.engine === 'sky') {
    return a.release === b.release && a.platform === b.platform;
  }
  if (a.engine === 'lure' && b.engine === 'lure') {
    return a.release === b.release && a.platform === b.platform;
  }
  // The Release is part of the comparison for the same reason it is part of the
  // Target: Broken Sword's demo decodes differently from its retail release, so
  // treating them as one Target is how an edit lands in a misread structure.
  if (a.engine === 'sword1' && b.engine === 'sword1') {
    return a.release === b.release && a.platform === b.platform;
  }
  if (a.engine === 'sword2' && b.engine === 'sword2') {
    return a.release === b.release && a.platform === b.platform;
  }
  return false;
}

/**
 * A Target read back from JSON, or null when the value is not one.
 *
 * Returns null rather than defaulting, and every caller is expected to treat
 * that as a refusal. `{engine: 'scumm', version: 5}` is a plausible-looking
 * *wrong* answer for an AGI project in precisely the way `5` was for a v7 one
 * (#123), and that mis-tag has already happened once in this codebase: a
 * project holding v7 instructions was silently built with the v5 assembler.
 * Failing loudly is the lesson.
 */
export function parseTarget(raw: unknown): Target | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = raw as Partial<Target> & Record<string, unknown>;

  if (value.engine === 'scumm') {
    const version = value.version;
    if (!SCUMM_VERSION_TARGETS.includes(version as ScummVersionTarget)) return null;
    const target: Target = { engine: 'scumm', version: version as ScummVersionTarget };
    if (typeof value.identification === 'string') {
      target.identification = value.identification as ScummIdentification;
    }
    return target;
  }

  if (value.engine === 'agi') {
    const interpreter = value.interpreter;
    const platform = value.platform;
    if (typeof interpreter !== 'number' || !Number.isInteger(interpreter)) return null;
    // Below 0x2000 is the DOS booter and Apple II band, which this project
    // does not read (`.out-of-scope/agi-booter-and-apple-ii.md`). Above 0x4000
    // is not a version Sierra shipped. Either way it is not a Target this
    // engine can decode with, so it is refused rather than clamped.
    if (interpreter < 0x2000 || interpreter >= 0x4000) return null;
    if (!AGI_PLATFORMS.includes(platform as AgiPlatform)) return null;

    const target: Target = {
      engine: 'agi',
      interpreter,
      platform: platform as AgiPlatform,
    };
    if (typeof value.identification === 'string') {
      target.identification = value.identification as InterpreterIdentification;
    }
    if (typeof value.gameId === 'string') target.gameId = value.gameId;
    return target;
  }

  if (value.engine === 'agos') {
    const version = value.version;
    const releaseKind = value.releaseKind;
    const platform = value.platform;
    if (!AGOS_VERSIONS.includes(version as AgosVersion)) return null;
    // A missing release kind is refused rather than defaulted to floppy. It
    // decides two opcodes' lengths, so guessing it writes an author's edit into
    // a structure that was misread — the thing ADR 0025 exists to prevent.
    if (releaseKind !== 'floppy' && releaseKind !== 'talkie') return null;
    if (platform !== 'dos' && platform !== 'windows') return null;

    const target: Target = {
      engine: 'agos',
      version: version as AgosVersion,
      releaseKind,
      platform,
    };
    if (typeof value.identification === 'string') {
      target.identification = value.identification as AgosIdentification;
    }
    return target;
  }

  if (value.engine === 'sci') {
    const version = value.version;
    const platform = value.platform;
    if (!SCI_VERSIONS.includes(version as SciVersion)) return null;
    if (!SCI_PLATFORMS.includes(platform as SciPlatform)) return null;

    const target: Target = {
      engine: 'sci',
      version: version as SciVersion,
      platform: platform as SciPlatform,
    };
    if (typeof value.identification === 'string') {
      target.identification = value.identification as SciIdentification;
    }
    return target;
  }

  if (value.engine === 'sky') {
    const release = value.release;
    const platform = value.platform;
    if (!SKY_RELEASES.includes(release as SkyRelease)) return null;
    if (!SKY_PLATFORMS.includes(platform as SkyPlatform)) return null;
    return {
      engine: 'sky',
      release: release as SkyRelease,
      platform: platform as SkyPlatform,
    };
  }

  if (value.engine === 'lure') {
    const release = value.release;
    const platform = value.platform;
    if (!LURE_RELEASES.includes(release as LureRelease)) return null;
    if (!LURE_PLATFORMS.includes(platform as LurePlatform)) return null;
    return {
      engine: 'lure',
      release: release as LureRelease,
      platform: platform as LurePlatform,
    };
  }

  if (value.engine === 'sword1') {
    const release = value.release;
    const platform = value.platform;
    if (!SWORD1_RELEASES.includes(release as Sword1Release)) return null;
    if (!SWORD1_PLATFORMS.includes(platform as Sword1Platform)) return null;
    const target: Target = {
      engine: 'sword1',
      release: release as Sword1Release,
      platform: platform as Sword1Platform,
    };
    if (typeof value.identification === 'string') {
      target.identification = value.identification as Sword1Identification;
    }
    return target;
  }

  if (value.engine === 'sword2') {
    const release = value.release;
    const platform = value.platform;
    if (!SWORD2_RELEASES.includes(release as Sword2Release)) return null;
    if (!SWORD2_PLATFORMS.includes(platform as Sword2Platform)) return null;
    const target: Target = {
      engine: 'sword2',
      release: release as Sword2Release,
      platform: platform as Sword2Platform,
    };
    if (typeof value.identification === 'string') {
      target.identification = value.identification as Sword2Identification;
    }
    return target;
  }

  return null;
}

/**
 * Whether this Target has an assembler behind it.
 *
 * ADR 0004 said one assembler per version and now reads "per Target". An AGI
 * Target has one — the Logic emitter — but only once its interpreter version is
 * positively identified, which is what `canEditTarget` adds on top of this.
 */
export function hasAssembler(target: Target): boolean {
  // Sky and Lure are absent on purpose rather than by oversight. ADR 0025 gives
  // both an assembler in principle — the object table is the editable surface
  // and export patches it back — but neither extractor exists yet, and a
  // Target claiming an assembler it does not have is the mis-tag this whole
  // module was written to prevent. This flips when #253 and #262 land.
  return target.engine === 'scumm' || target.engine === 'agi' || target.engine === 'sci';
}

/**
 * Whether a Target may be offered for editing, and why not when it may not.
 *
 * ADR 0013: an AGI game whose interpreter version fell back to a guess still
 * **plays** on that guess and is **refused for editing**. Decode a Logic with
 * the wrong arity table and every boundary after the first mismatch is wrong;
 * re-emit with the same wrong table and it writes that misreading back byte for
 * byte. The check passes, the tree is nonsense, and the author edits it
 * believing otherwise.
 */
export function describeUneditableTarget(target: Target): string | null {
  if (target.engine === 'scumm') {
    if (target.identification !== 'guess') return null;

    return (
      `This game's SCUMM version could not be read from its index, so it is ` +
      `assumed to be v${target.version} for play and cannot be edited.\n\n` +
      `v2 and v3 share a filename shape — an index called 00.LFL and one file ` +
      `per room — and are told apart by the width of one column inside the ` +
      `index. When that reading does not add up, the Version is a guess. ` +
      `Decoding a script with the wrong Version's opcode table misreads every ` +
      `boundary after the first renumbered instruction, and re-emitting with ` +
      `the same wrong table writes that misreading back byte for byte, so the ` +
      `round-trip check passes while the structure is wrong. Playing on a ` +
      `guess costs nothing; editing on one costs the author's work (ADR 0013).`
    );
  }
  if (target.engine === 'sci') {
    // `probe`, `map-structure`, `known-release` and `declared` all pass. Only
    // `guess` — and an absent note, which is read as one — refuses.
    if (target.identification && target.identification !== 'guess') return null;

    return (
      `This game's SCI Version could not be narrowed past a guess, so it is ` +
      `assumed to be ${describeSciVersion(target.version)} for play and cannot be ` +
      `edited.\n\n` +
      `SCI stamps its Version nowhere. A resource map's structure separates SCI0, ` +
      `SCI1 middle, SCI1 late, SCI1.1 and SCI32 and no further, and the finer ` +
      `seams — where the Kernel table, the View format and the Script resource's ` +
      `layout actually move — are read from the game's own resources by probe ` +
      `(ADR 0020). When the probes leave more than one Version standing, the ` +
      `earliest is used to play on.\n\n` +
      `Decoding with the wrong Version's Kernel table produces a game that runs ` +
      `and does the wrong things, and re-emitting with the same wrong table ` +
      `writes that misreading back byte for byte, so the round-trip check passes ` +
      `while the structure is wrong. Playing on a guess costs nothing; editing on ` +
      `one costs the author's work (ADR 0013).`
    );
  }
  if (target.engine !== 'agi') return null;
  // `declared` passes here as the other positive identifications do. It is not
  // the guess the ADR rejects: a person stated it, deliberately and against a
  // warning, and the Target records that they did.
  if (target.identification && target.identification !== 'fallback') return null;

  return (
    `This game's AGI interpreter version could not be identified, so it is ` +
    `assumed to be ${formatInterpreterVersion(DEFAULT_AGI_INTERPRETER)} for play ` +
    `and cannot be edited.\n\n` +
    `An AGI instruction's argument count is not in the bytecode — it comes from ` +
    `a table that varies by interpreter build and platform. Decoding with the ` +
    `wrong table misreads every instruction boundary after the first mismatch, ` +
    `and re-emitting with the same wrong table writes that misreading back byte ` +
    `for byte, so the round-trip check passes while the structure is wrong. ` +
    `Playing on a guess costs nothing; editing on one costs the author's work ` +
    `(ADR 0013).\n\n` +
    `Include the game's AGIDATA.OVL, or its original interpreter executable, ` +
    `for the version to be read rather than assumed.`
  );
}
