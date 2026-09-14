/**
 * Recognising AGI game data, and working out what Target it is.
 *
 * A sibling of `src/engine/resource/GameDetector.ts`, not an extension of it.
 * The two share no bytes: SCUMM opens with a chunk tag or a little-endian size,
 * and AGI has no container at all — just index files beside numbered volumes.
 */

import { readU16LE } from '../../util/ByteStream.js';
import type { DataSource } from '../../resource/DataSource.js';
import {
  agiMajor,
  DEFAULT_AGI_INTERPRETER,
  formatInterpreterVersion,
  type AgiPlatform,
  type InterpreterIdentification,
  type Target,
} from '../../../authoring/target.js';

/** The four AGI v2 index files, in the order AGI v3 packs them into one. */
export const AGI_DIR_NAMES = ['logdir', 'picdir', 'viewdir', 'snddir'] as const;

export type AgiDirName = (typeof AGI_DIR_NAMES)[number];

function baseName(name: string): string {
  return (name.replace(/\\/g, '/').split('/').pop() ?? name).toLowerCase();
}

/**
 * How a game's files are laid out, which is the whole of what the major decides.
 *
 * `v2` has the four `*DIR` files above and volumes called `VOL.n`. `v3` has one
 * `<GAMEID>DIR` holding the same four tables at offsets given by an eight-byte
 * header, and volumes called `<GAMEID>VOL.n` whose resources may be
 * LZW-compressed.
 */
export interface AgiLayout {
  major: 2 | 3;
  /** The `<GAMEID>` prefix v3 puts on its files; empty for v2. */
  prefix: string;
  /** File name per directory, or the one combined file for v3. */
  dirFiles: Map<AgiDirName, string>;
  combinedDir?: string;
  /** Volume number to file name. */
  volumes: Map<number, string>;
}

/**
 * The layout these files are in, or null when they are not AGI data.
 *
 * v2 is asked about first because its marker file names are exact, where v3's
 * are a pattern — and `logdir` itself matches the v3 pattern `<prefix>dir` with
 * a prefix of "log". Asking in the other order would read a v2 game as a v3 one
 * with a game id of "log" and then look for `LOGVOL.0`, which is not there.
 */
export function agiLayout(fileNames: string[]): AgiLayout | null {
  const byBase = new Map<string, string>();
  for (const name of fileNames) byBase.set(baseName(name), name);

  const v2Dirs = new Map<AgiDirName, string>();
  for (const dir of AGI_DIR_NAMES) {
    const found = byBase.get(dir);
    if (found) v2Dirs.set(dir, found);
  }
  if (v2Dirs.size > 0) {
    return { major: 2, prefix: '', dirFiles: v2Dirs, volumes: volumesFor(byBase, '') };
  }

  // v3: `<prefix>dir` with at least one `<prefix>vol.n` beside it. Both halves
  // are required, because a lone `*dir` is not evidence — `AUTOEXEC.DIR` from a
  // badly extracted archive would otherwise be read as a game index.
  for (const [base, original] of byBase) {
    const match = /^(.+)dir$/.exec(base);
    if (!match) continue;
    const prefix = match[1];
    const volumes = volumesFor(byBase, prefix);
    if (volumes.size === 0) continue;
    return { major: 3, prefix, dirFiles: new Map(), combinedDir: original, volumes };
  }

  return null;
}

/** `VOL.0`, `KQ4VOL.1` — the volumes belonging to one prefix. */
function volumesFor(byBase: Map<string, string>, prefix: string): Map<number, string> {
  const volumes = new Map<number, string>();
  const pattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}vol\\.(\\d+)$`);
  for (const [base, original] of byBase) {
    const match = pattern.exec(base);
    if (match) volumes.set(Number(match[1]), original);
  }
  return volumes;
}

/**
 * True when these file names are AGI game data.
 *
 * Positive evidence only: a `LOGDIR` or a `<GAMEID>DIR` beside its volumes is
 * something no SCUMM release ships. `GameDetector` learned the cost of the
 * other kind from a King's Quest IV dump named `KQ4SG.000`, which had exactly
 * the shape of a SCUMM index pair and none of the contents.
 */
export function looksLikeAgi(fileNames: string[]): boolean {
  return agiLayout(fileNames) !== null;
}

/**
 * The interpreter version, and how it was established.
 *
 * ADR 0013 makes the editing decision turn on the second half, so it is carried
 * rather than worked out again: reading a version from the game's own
 * `AGIDATA.OVL` is a fact, and assuming 2.917 because nothing said otherwise is
 * a guess, and the Unrecovered count means different things under each.
 *
 * Three sources, best first:
 *
 * 1. `AGIDATA.OVL` — the game's own argument-count table, which is what the
 *    interpreter actually reads. Sierra put a version string in it.
 * 2. The interpreter executable's version string, where the release shipped one.
 * 3. Nothing, in which case the default is assumed and said so.
 *
 * Deliberately *not* MD5 hashing a table of known releases, which is what
 * ScummVM does. That is the right choice for a project with a maintained
 * detection database and the wrong one here: a hash table is a list of games
 * someone has already seen, and the fan-made games this engine is verified
 * against are not on it. Reading the version out of the game answers for a game
 * nobody has catalogued.
 */
export interface IdentifiedInterpreter {
  interpreter: number;
  identification: InterpreterIdentification;
  /** The evidence, for the log — "AGIDATA.OVL says 2.917". */
  note: string;
}

/** `2.917` / `3.002.149` in any surrounding text, as a Target number. */
export function parseInterpreterString(text: string): number | null {
  // Sierra wrote v2 builds as `2.917` and v3 builds as `3.002.149`. The middle
  // group is always `002` for the v3 releases, so it is skipped rather than
  // stored — `agiMajor` and `formatInterpreterVersion` agree on that shape.
  //
  // The build digits are carried across as *hex* digits in both cases, which
  // looks wrong and is not: every implementation since Sierra compares these as
  // `0x2917` and `0x3149`, because those read back as the version a person
  // would say out loud. Reading them as decimal gives 0x395 for 2.917, which
  // then compares as an earlier build than 2.089 and picks the wrong arity
  // table — a wrong answer with no symptom until an instruction is misread.
  const v3 = /\b3\.(\d{3})\.(\d{3})\b/.exec(text);
  if (v3) {
    const build = Number.parseInt(v3[2], 16);
    return Number.isNaN(build) ? null : 0x3000 | (build & 0x0fff);
  }

  const v2 = /\b2\.(\d{3})\b/.exec(text);
  if (v2) {
    const build = Number.parseInt(v2[1], 16);
    return Number.isNaN(build) ? null : 0x2000 | (build & 0x0fff);
  }
  return null;
}

/** Printable ASCII runs in a binary, so a version string can be found in one. */
function asciiRuns(bytes: Uint8Array, minLength = 4): string {
  let out = '';
  let run = '';
  for (const byte of bytes) {
    if (byte >= 0x20 && byte < 0x7f) {
      run += String.fromCharCode(byte);
      continue;
    }
    if (run.length >= minLength) out += `${run}\n`;
    run = '';
  }
  if (run.length >= minLength) out += run;
  return out;
}

/**
 * Files that carry a version string, best evidence first.
 *
 * ADR 0013 admits two positive identifications — reading the game's own
 * `agidata.ovl`, or the interpreter it shipped with — so what belongs here is
 * every name Sierra actually used for those, and nothing else. A wider net
 * (any `.exe` in the folder) would let an unpacker, an installer or a fan-made
 * launcher name a version, and a version read off the wrong binary is a guess
 * wearing the word "identified", which is worse than the honest fallback.
 *
 * The bare `agi` matters and is easy to miss. Sierra shipped the v2 interpreter
 * as an extensionless `AGI` loaded by `SIERRA.COM`, and the Amiga releases do
 * the same — this file already says so, in `detectPlatform`. A pattern that
 * required an extension therefore skipped the interpreter in a great many DOS
 * releases and reported that none was found.
 */
const VERSION_FILES: Array<{ name: RegExp; how: InterpreterIdentification }> = [
  // The authoritative arity table, and it ships with the game (ADR 0013).
  { name: /^agidata\.ovl$/i, how: 'agidata' },
  // The interpreter itself, which is the next best thing.
  { name: /^(agi|sierra)(\.(exe|com|ovl))?$/i, how: 'interpreter-hash' },
];

/** Every file that could carry the version, so a miss can say what it read. */
function versionCandidates(source: DataSource): Array<{
  name: string;
  how: InterpreterIdentification;
}> {
  const found: Array<{ name: string; how: InterpreterIdentification }> = [];
  for (const candidate of VERSION_FILES) {
    for (const file of source.list()) {
      if (candidate.name.test(baseName(file))) found.push({ name: file, how: candidate.how });
    }
  }
  return found;
}

export async function identifyInterpreter(
  source: DataSource,
  layout: AgiLayout,
): Promise<IdentifiedInterpreter> {
  const candidates = versionCandidates(source);

  for (const candidate of candidates) {
    const bytes = await source.read(candidate.name);
    if (!bytes) continue;
    const found = parseInterpreterString(asciiRuns(bytes));
    if (found === null) continue;
    return {
      interpreter: found,
      identification: candidate.how,
      note: `${baseName(candidate.name).toUpperCase()} names interpreter ${found.toString(16)}`,
    };
  }

  /**
   * What the fallback note says it looked at.
   *
   * "No AGIDATA.OVL or interpreter executable was found" is the wrong sentence
   * when one *was* found and had no version string in it: the reader goes
   * looking for a file that is already sitting in the folder. The two cases
   * need different answers because they have different fixes.
   */
  const searched =
    candidates.length > 0
      ? `${candidates.map((file) => baseName(file.name).toUpperCase()).join(', ')} carried no ` +
        `version string`
      : `No AGIDATA.OVL or interpreter executable was found`;

  // A v3 game at least tells us it is a v3 game, which is a real narrowing:
  // it rules out every v2 arity difference. Still a fallback, because the
  // build within v3 is what decides `hide.mouse`'s arity.
  if (layout.major === 3) {
    return {
      interpreter: 0x3149,
      identification: 'fallback',
      note: `${searched}, and the combined index says AGI v3, so 3.002.149 is assumed`,
    };
  }

  return {
    interpreter: DEFAULT_AGI_INTERPRETER,
    identification: 'fallback',
    note:
      `${searched}, so interpreter 2.917 is assumed — the most common AGI v2 ` +
      `build. The game plays on that assumption and cannot be edited (ADR 0013)`,
  };
}

/**
 * The platform, from the files that are only present on one.
 *
 * DOS unless something says otherwise, because DOS is what a `VOL.n` beside a
 * `LOGDIR` almost always is. The non-DOS releases change how bytecode decodes
 * (ADR 0012), so guessing DOS wrongly is a real fault — but the ports rename or
 * add files, which is what this reads.
 */
export function detectPlatform(fileNames: string[]): AgiPlatform {
  const bases = new Set(fileNames.map(baseName));
  // The Amiga releases ship the interpreter as `agi` with no extension and add
  // an icon file; the Atari ST ones ship a `.prg`.
  if ([...bases].some((name) => name.endsWith('.info'))) return 'amiga';
  if ([...bases].some((name) => name.endsWith('.prg') || name.endsWith('.tos'))) {
    return 'atari-st';
  }
  // Apple IIgs releases keep their sound in a separate resource fork and ship
  // a `*.system` loader.
  if ([...bases].some((name) => name.endsWith('.system'))) return 'apple-ii-gs';
  return 'dos';
}

export interface DetectedAgiGame {
  readonly id: string;
  readonly target: Target;
  readonly layout: AgiLayout;
  /** How the interpreter version was arrived at, for the log. */
  readonly interpreterNote: string;
}

/**
 * Everything that has to be known about an AGI game before a byte is read.
 *
 * Reports a Target rather than a bare version (#124), because a bare AGI
 * version says nothing about the encoding.
 */
/**
 * A version stated by the person editing, rather than read from the game.
 *
 * Carried into detection rather than patched onto the Target afterwards,
 * because the interpreter decides the arity table and the arity table decides
 * how every Logic decodes. A declaration applied late would leave resources
 * already read under the assumed table, which is the misreading ADR 0013 is
 * about — arrived at by a different route.
 */
export interface DeclaredInterpreter {
  interpreter: number;
  platform: AgiPlatform;
}

export async function detectAgiGame(
  source: DataSource,
  declared?: DeclaredInterpreter,
): Promise<DetectedAgiGame> {
  const names = source.list();
  const layout = agiLayout(names);
  if (!layout) {
    throw new Error(
      `No AGI index found in ${source.label}. An AGI v2 game has LOGDIR, ` +
        `PICDIR, VIEWDIR and SNDDIR beside VOL.0; an AGI v3 game has one ` +
        `<GAMEID>DIR beside <GAMEID>VOL.0.`,
    );
  }

  // Read anyway when a version has been declared, so the log can say what the
  // game itself offered — a declaration that contradicts a readable
  // AGIDATA.OVL is worth seeing rather than silently overriding.
  const identified = await identifyInterpreter(source, layout);
  const platform = detectPlatform(names);
  // v3 names its files after the game, which is where the id comes from. v2
  // names them `LOGDIR` and `VOL.0` and carries its id only inside the
  // interpreter, so the source's own label is the honest answer there.
  const id = layout.prefix || stemOf(source.label) || 'agi';

  if (declared) {
    /**
     * A declared build whose major contradicts the packaging in front of it is
     * refused here, rather than allowed to fail later as a corrupt resource.
     *
     * `agiMajor` derives the major from the interpreter (ADR 0012), and the
     * major governs packaging: v2 has four `*DIR` files and uncompressed
     * volumes, v3 has one combined index and volumes whose entries may be
     * LZW-compressed. Declaring 2.917 over v3 packaging asks a v2 reader for a
     * v3 resource, and what comes back is not an error at the boundary — it is
     * a plausible-looking size read out of the wrong header width, so the
     * failure surfaces several layers down as `This Logic claims 255 messages,
     * whose offset table would end at 515 in a 13 byte resource`.
     *
     * That message sends whoever reads it looking for a fault in the message
     * reader. It cost an afternoon exactly once, during the run that added
     * `bin/agi-reexport.ts`, where the same mispairing was read as evidence
     * that AGI v3 games could not be exported — they can, and the tool was
     * holding the wrong table.
     *
     * ADR 0013's rule is why a refusal rather than a correction: a declaration
     * is a person stating something they know, so the honest response to one
     * that cannot be true is to say so and stop, not to quietly substitute the
     * build this code would have preferred.
     */
    if (agiMajor(declared.interpreter) !== layout.major) {
      throw new Error(
        `Interpreter ${formatInterpreterVersion(declared.interpreter)} is an AGI v` +
          `${agiMajor(declared.interpreter)} build, and ${source.label} is packaged as AGI v` +
          `${layout.major}. An AGI major fixes how resources are packaged, so a v` +
          `${agiMajor(declared.interpreter)} reader cannot read a v${layout.major} volume — ` +
          `declare a v${layout.major} build instead.`,
      );
    }

    return {
      id,
      layout,
      interpreterNote:
        `Interpreter ${formatInterpreterVersion(declared.interpreter)} on ` +
        `${declared.platform} was declared rather than read from the game. ` +
        `(${identified.note})`,
      target: {
        engine: 'agi',
        interpreter: declared.interpreter,
        platform: declared.platform,
        identification: 'declared',
        gameId: id,
      },
    };
  }

  return {
    id,
    layout,
    interpreterNote: identified.note,
    target: {
      engine: 'agi',
      interpreter: identified.interpreter,
      platform,
      identification: identified.identification,
      gameId: id,
    },
  };
}

function stemOf(label: string): string {
  const base = (label.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '').toLowerCase();
  return base.replace(/\.(zip|agi)$/, '').replace(/[^a-z0-9]+/g, '') || '';
}

/**
 * The four table offsets in an AGI v3 combined index.
 *
 * An eight-byte header of four little-endian 16-bit offsets, in the order
 * logdir, picdir, viewdir, snddir. The first is always 8, the header being
 * fixed-size — which is a useful check that this is the file it claims to be.
 */
export function readCombinedDirHeader(bytes: Uint8Array): number[] {
  if (bytes.length < 8) {
    throw new Error(
      `The combined AGI v3 index is ${bytes.length} bytes, which is shorter ` +
        `than its own eight-byte header.`,
    );
  }
  const offsets = [0, 1, 2, 3].map((index) => readU16LE(bytes, index * 2));
  if (offsets[0] !== 8) {
    throw new Error(
      `The combined AGI v3 index puts its first table at ${offsets[0]} rather ` +
        `than 8. The header is a fixed eight bytes, so the LOGDIR always ` +
        `starts immediately after it — this file is not the index it is named as.`,
    );
  }
  return offsets;
}
