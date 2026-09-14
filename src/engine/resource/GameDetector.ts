import { readU16LE, readU32LE } from '../util/ByteStream.js';
import { iterateChunks } from './Chunk.js';
import type { DataSource } from './DataSource.js';
import { describeForeignEngine, identifyForeignEngine } from './engineSignatures.js';
import { LoadProgressTracker } from './progress.js';
import { CANDIDATE_XOR_KEYS, decryptCopy, detectXorKey, KNOWN_ROOT_TAGS } from './xor.js';

export type ScummVersion = 2 | 3 | 4 | 5 | 6 | 7 | 8;

/**
 * How a Published game's files are arranged (`CONTEXT.md`).
 *
 * The axis this type exists to make explicit. A Version fixes it, but it varies
 * *independently of the instruction encoding*: v4 and v5 share almost an
 * encoding and share no layout, and v6, v7 and v8 share a layout across two
 * different widths of directory entry. Reading it off the Version at each call
 * site is what produced a detector that could only ever find an index and a
 * data file, because that is what v5 has and v5 was written first.
 */
export type ResourceLayout =
  /** v2, v3: `00.LFL` and one file per room, `01.LFL` … `NN.LFL`. */
  | 'lfl-rooms'
  /** v4: `000.LFL` and `DISK01.LEC` … `DISK09.LEC`. */
  | 'lec-disks'
  /** v5-v8: `<NAME>.000` and one `LECF` container, `<NAME>.001`. */
  | 'lecf-container';

/**
 * How this game's Version was arrived at.
 *
 * The precedent is `target.ts`'s `InterpreterIdentification`, and it is
 * borrowed rather than reinvented for the reason ADR 0013 gives: the decision
 * about whether a game may be *edited* turns on whether its Target was read or
 * guessed, and that cannot be recovered later from the answer alone.
 */
export type VersionIdentification =
  /** Read out of the index's own structure. The only decisive answer. */
  | 'index-structure'
  /** The index matched a release this project has a recorded shape for. */
  | 'known-release'
  /**
   * Nothing separated it; the more likely Version was assumed.
   *
   * Plays. Refused for editing, per ADR 0013 — a Classic script decoded with
   * the wrong Version's opcode table misreads every boundary after the first
   * renumbered instruction and re-emits its own misreading byte for byte.
   */
  | 'guess';

export interface DetectedGame {
  /** File holding the resource directories (`MONKEY2.000`, `000.LFL`, `00.LFL`). */
  readonly indexFile: string;
  /**
   * Every file holding resources, in the order the layout wants them.
   *
   * A set rather than a single name, because only one of the three layouts has
   * exactly one. `lecf-container` has one; `lec-disks` has up to nine; and
   * `lfl-rooms` has one per room, which for Maniac Mansion is fifty-five.
   */
  readonly dataFiles: readonly string[];
  /**
   * The separate charset files the pre-v5 layouts keep outside the data.
   *
   * `901.LFL` … `904.LFL` for v4, `97.LFL` … `99.LFL` for v3 and v2. Listed
   * apart from `dataFiles` because they are not walked for resources: a
   * charset is asked for by number and read whole, which is why v4 encrypts
   * them differently from the containers beside them.
   */
  readonly charsetFiles: readonly string[];
  readonly layout: ResourceLayout;
  /** XOR key the index is encrypted with. */
  readonly xorKey: number;
  /**
   * XOR key the *data* files are encrypted with.
   *
   * The same as `xorKey` for every layout but one. v4 encrypts its containers
   * with 0x69 and leaves `000.LFL` and the `9nn.LFL` charsets in the clear,
   * which is a fact about the release rather than about the release's era, and
   * reading one key off the other silently decrypts the index twice.
   */
  readonly dataXorKey: number;
  readonly version: ScummVersion;
  /** Short id derived from the file stem, e.g. `monkey2`. */
  readonly id: string;
  /** Optional speech file (`MONSTER.SOU`). */
  readonly speechFile?: string;
  readonly identification: VersionIdentification;
}

/**
 * The one data file a `lecf-container` game has.
 *
 * A named accessor rather than `dataFiles[0]` at each call site, so the
 * assumption that there is exactly one is written down where it is made. The
 * two pre-v5 layouts have no such file and reading `[0]` on them would answer
 * with a room.
 */
export function containerFile(game: DetectedGame): string {
  return game.dataFiles[0];
}

/** `MONKEY2.000` -> `monkey2`. */
function stem(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? name;
  return base.replace(/\.[^.]*$/, '').toLowerCase();
}

function extension(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? name;
  const dot = base.lastIndexOf('.');
  return dot < 0 ? '' : base.slice(dot + 1).toLowerCase();
}

function baseName(name: string): string {
  return (name.replace(/\\/g, '/').split('/').pop() ?? name).toLowerCase();
}

/** The file in `names` with this base name, in its original case. */
function findFile(names: readonly string[], wanted: string): string | undefined {
  return names.find((name) => baseName(name) === wanted);
}

/**
 * Blocks in a pre-v5 index: a little-endian size — which includes the six byte
 * header — then a *two* character tag.
 *
 * v5 turned the header around: four character tag first, then a big-endian
 * size. The two layouts therefore share no bytes at all, which is what makes
 * telling them apart reliable rather than a guess.
 */
const OLD_INDEX_TAGS = new Set(['RN', '0R', '0S', '0N', '0C', '0O']);

/**
 * True if this index is the v4 block layout.
 *
 * Worth checking *before* looking for chunks, because the failure mode is
 * silent: a v4 index has no MAXS block anywhere, so scanning for one finds
 * nothing and falls through to whatever the default is. That default used to be
 * v5, and a v4 index parsed as v5 produces garbage directories rather than an
 * error — the game loads, boots, draws its first screen from a room it found by
 * luck, and then stops.
 *
 * `totalLength` is the length of the whole index, which the caller passes
 * separately when it only has the first few bytes decrypted.
 */
function looksLikeOldIndex(index: Uint8Array, totalLength = index.length): boolean {
  if (index.length < 6) return false;
  if (!OLD_INDEX_TAGS.has(String.fromCharCode(index[4], index[5]))) return false;

  // The tag alone is two bytes and could fall out of noise, so the size has to
  // agree with it: at least a header, and not past the end of the file.
  const size = readU32LE(index, 0);
  return size >= 6 && size <= totalLength;
}

/** Enough of the header for either index layout: a four byte tag, or six. */
const INDEX_HEAD_SIZE = 6;

/**
 * The XOR key this index is encrypted with, or `null` if it is not an index.
 *
 * Two layouts have to be recognised, and only the first is a tag. v5 and up
 * open with a four character block tag, which `detectXorKey` trials directly.
 * A v4 index opens with a little-endian *size* and puts its two character tag
 * at byte four, so the first four bytes are not a tag under any key and the tag
 * trial can never match one.
 *
 * That mattered once the trial stopped falling back to a default key: the
 * fallback was what made v4 detection work at all, and without this second
 * shape a Monkey Island 1 index would be reported as not being SCUMM data
 * rather than as the v4 game it is.
 */
function detectIndexKey(raw: Uint8Array): number | null {
  const byTag = detectXorKey(raw.subarray(0, 4));
  if (byTag !== null) return byTag;

  for (const key of CANDIDATE_XOR_KEYS) {
    const head = decryptCopy(raw.subarray(0, INDEX_HEAD_SIZE), key);
    if (looksLikeOldIndex(head, raw.length)) return key;
  }
  return null;
}

/**
 * MAXS block size -> the version that writes a block that size.
 *
 * MAXS is a fixed-size struct of resource limits, and every version changed
 * it, so its size names the version unambiguously — more reliable than
 * sniffing file names, which vary between the floppy, CD and re-release
 * packagings. Sizes include the eight byte chunk header, which is what
 * `Chunk.size` reports.
 *
 *   v5  26   nine 16-bit counts
 *   v6  38   fifteen 16-bit counts
 *   v7 138   two 50-byte version strings, then fifteen 16-bit counts
 *   v8 176   two 50-byte version strings, then seventeen 32-bit counts
 *
 * v7 and v8 are here because without them there was no branch that could ever
 * conclude either one. Full Throttle (`FT.LA0`) fell through to the v5 default
 * and was loaded — all 148 MB of it — before its v7 scripts were executed as
 * v5 bytecode, which produced an opcode cascade that read as an incomplete
 * opcode table rather than the wrong format entirely.
 *
 * The v7 and v8 sizes were first written as 140 and 180, from a count of the
 * fields rather than a reading of them: `ScummEngine_v7::readMAXS` performs
 * fifteen `readUint16LE` calls and `ScummEngine_v8::readMAXS` seventeen
 * `readUint32LE` ones. Neither entry could ever match, and both games reached
 * the same answer through the size fallback below — which was invisible while
 * both were refused, and stops being invisible the moment v7 is supported,
 * because a v8 game taking a v7 fallback is the exact fault this table exists
 * to prevent, one version along.
 */
const MAXS_SIZE_VERSIONS = new Map<number, ScummVersion>([
  [26, 5],
  [38, 6],
  [138, 7],
  [176, 8],
]);

/**
 * A MAXS block bigger than this is v7 or later, whatever its exact size.
 *
 * Comfortably above v6's 38 bytes — so a v5 or v6 release that padded its
 * block is still read as the version it is — and comfortably below v7's 138.
 */
const LATER_VERSION_MAXS_SIZE = 64;

/**
 * The largest MAXS this engine will call v7 on a guess.
 *
 * v7's block is 138 bytes and v8's is 176. Between them there is nothing, so a
 * block in that range is a v7 release whose block this reading is slightly
 * wrong about, and one at or above v8's size is not v7 at all.
 */
const LARGEST_V7_MAXS_SIZE = 160;

/** Works out the version of a `LECF`-layout game from its index. */
function versionFromContainerIndex(index: Uint8Array): {
  version: ScummVersion;
  identification: VersionIdentification;
} {
  for (const chunk of iterateChunks(index, 0)) {
    if (chunk.tag !== 'MAXS') continue;

    const known = MAXS_SIZE_VERSIONS.get(chunk.size);
    if (known) return { version: known, identification: 'index-structure' };

    // An unfamiliar size, but not an unbounded one. v5 and v6 write 26 and 38
    // byte blocks; v7 was the release that added two 50 byte version strings
    // and took MAXS past a hundred. So a block this much bigger than v6's is a
    // later version's struct whatever its exact size — but *which* later
    // version now decides whether a game runs or is refused, so the guess is
    // split at a size no release writes rather than answered with v7.
    if (chunk.size > LATER_VERSION_MAXS_SIZE) {
      return {
        version: chunk.size < LARGEST_V7_MAXS_SIZE ? 7 : 8,
        identification: 'guess',
      };
    }

    // Close to v5's own size: let the resource layer say what it actually
    // found rather than detection refusing on one unfamiliar number.
    return { version: 5, identification: 'guess' };
  }

  // No MAXS in a file that decoded to a known root tag: unrecognisable. v5 is
  // the version whose games are most likely to be to hand, so answer with it
  // and let the resource layer report what it actually found, rather than
  // refusing on a guess made from eight bytes.
  return { version: 5, identification: 'guess' };
}

/**
 * The magic word both `00.LFL` layouts open with.
 *
 * Shared by v2 and v3, which is the whole difficulty: it says "this is an
 * `LFL` index" and nothing about which of the two wrote it.
 */
const LFL_INDEX_MAGIC = 0x0100;

/**
 * Bytes per entry in the global object table — the one place v2 and v3 differ
 * before the reader has committed to a reading.
 *
 * v2 stores one byte per object, packing owner into the low nibble and state
 * into the high one. v3 stores four. Everything after that table is identical
 * in shape, so the *only* structural question is how wide this one is, and the
 * answer is decided by which width makes the rest of the file add up.
 */
const V2_OBJECT_ENTRY_BYTES = 1;
const V3_OBJECT_ENTRY_BYTES = 4;

/**
 * Where an `LFL` index ends if its object table has entries this wide, or -1.
 *
 * Walks the four resource directories that follow the object table. Each is a
 * one-byte count and then three bytes per resource — a room or owner number and
 * a sixteen-bit offset — so the whole file's length is fixed once the object
 * table's width is chosen.
 *
 * That is what makes v2 and v3 separable *structurally* rather than by a table
 * of known releases: pick the wrong width and the four counts are read out of
 * the middle of somebody else's data, and the total lands nowhere near the end
 * of the file. Only the right width walks to exactly the last byte.
 */
function lflIndexEnd(index: Uint8Array, objectEntryBytes: number): number {
  if (index.length < 4) return -1;
  if (readU16LE(index, 0) !== LFL_INDEX_MAGIC) return -1;

  const objectCount = readU16LE(index, 2);
  let at = 4 + objectCount * objectEntryBytes;

  // Rooms, costumes, scripts, sounds — in that order, and always four of them.
  for (let list = 0; list < 4; list++) {
    if (at >= index.length) return -1;
    const count = index[at];
    // 0xFF is the "too many" value ScummVM errors on; a count that large here
    // means the walk has left the directories and is reading data.
    if (count >= 0xff) return -1;
    at += 1 + count * 3;
  }

  return at;
}

/**
 * v2 or v3, decided from `00.LFL`, or null when neither reading fits.
 *
 * Returns the identification alongside, because a reading that fits *both*
 * widths is not an answer — it is two answers, and ADR 0013's rule is that a
 * game which reached its Target by guess plays and does not edit.
 */
function versionFromLflIndex(
  index: Uint8Array,
): { version: 2 | 3; identification: VersionIdentification } | null {
  const asV2 = lflIndexEnd(index, V2_OBJECT_ENTRY_BYTES);
  const asV3 = lflIndexEnd(index, V3_OBJECT_ENTRY_BYTES);

  const v2Fits = asV2 === index.length;
  const v3Fits = asV3 === index.length;

  if (v2Fits && !v3Fits) return { version: 2, identification: 'index-structure' };
  if (v3Fits && !v2Fits) return { version: 3, identification: 'index-structure' };
  if (v2Fits && v3Fits) {
    // Both widths walking to the same end would need the two readings to
    // differ by a multiple of three bytes across four counts read from
    // different places, which no release does. If it ever happens, it is not
    // an answer.
    return { version: 3, identification: 'guess' };
  }

  // Neither walks to the end. The magic word was right, so this is an `LFL`
  // index of some kind — a v1 or C64 release, or a dump with a trailing byte.
  // v3 is the more common of the two in circulation, and a guess is recorded
  // as one.
  if (readU16LE(index, 0) === LFL_INDEX_MAGIC) {
    return { version: 3, identification: 'guess' };
  }
  return null;
}

/**
 * The versions with an interpreter behind them.
 *
 * Every member of `ScummVersion`, which it has not always been: v2, v3 and v8
 * each spent time detected-and-refused while their readers were written, and
 * the refusal below is what a player got in the meantime. The list is kept
 * rather than deleted because the seam is the useful part — a Version added to
 * `ScummVersion` before its engine exists lands here first, which is what
 * stopped Full Throttle being loaded as v5 and run into a black screen.
 */
export const SUPPORTED_VERSIONS: readonly ScummVersion[] = [2, 3, 4, 5, 6, 7, 8];

/**
 * The version a refusal points the player at as something to try.
 *
 * v5 rather than the newest supported one, because it is the version whose
 * games are most likely to be to hand: the Fate of Atlantis demo is a free
 * download.
 */
export const SUPPORTED_VERSION = 5;

export function isSupportedVersion(version: ScummVersion): boolean {
  return SUPPORTED_VERSIONS.includes(version);
}

/** "v5 and v6", "v5, v6 and v7" — a list a person reads, not a join. */
function listVersions(versions: readonly ScummVersion[]): string {
  const names = versions.map((version) => `v${version}`);
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Why these files will not run, and what will.
 *
 * The alternative — and what this replaced — is loading them anyway. Detection
 * was already correct; nothing read the answer. A v6 game got all the way to
 * boot, where the v5 opcode set ran over v6 bytecode: no exception, no log
 * line, just scripts that decoded to nonsense and a screen that stayed black.
 * That is indistinguishable from a bug in a game that *is* supported, which
 * makes it worse than an error, not better.
 *
 * Unreachable while `SUPPORTED_VERSIONS` covers the whole union, and written
 * to stay correct without being edited when it stops being: it names the
 * version it found and the versions there are interpreters for, and nothing
 * about which ones those happen to be today.
 */
export function describeUnsupportedVersion(version: ScummVersion, indexFile: string): string {
  return (
    `${indexFile} is a SCUMM v${version} game. This engine implements ` +
    `SCUMM ${listVersions(SUPPORTED_VERSIONS)}.\n\n` +
    `Its files are read and its version identified, but there is no ` +
    `interpreter behind that number here — so it is refused rather than ` +
    `offered as something that works.\n\n` +
    `Monkey Island 2 (MONKEY2.000) and Indiana Jones and the Fate of Atlantis ` +
    `(ATLANTIS.000) are v${SUPPORTED_VERSION} and do run, as does Loom CD ` +
    `(000.LFL with DISK01.LEC). So does the Fate of Atlantis DOS demo, free ` +
    `from scummvm.org/demos.`
  );
}

/**
 * Why a file named like a SCUMM index does not contain one.
 *
 * Reached when every candidate XOR key leaves the first four bytes as
 * something that is not a block tag. The one thing detection had to go on was
 * the file name, and a name is not evidence — King's Quest IV dumped as
 * `KQ4SG.000` / `KQ4SG.001` has exactly the shape of a SCUMM pair and none of
 * the contents.
 *
 * First line first: only the opening line of a load failure reaches the status
 * line, so the plain verdict goes there and the reasoning follows in the log.
 */
function describeNotScummData(indexFile: string, label: string): string {
  const keys = CANDIDATE_XOR_KEYS.map((key) => `0x${key.toString(16)}`).join(', ');

  return (
    `${indexFile} is not SCUMM game data — it is only named like it.\n\n` +
    `A SCUMM index starts with one of ${KNOWN_ROOT_TAGS.join(', ')}, either in ` +
    `the clear or XORed with ${keys}, which is every key the releases use. None ` +
    `of them turn the start of this file into a tag, so there is nothing here to ` +
    `read as an index. Detection matched the index/data file naming and nothing ` +
    `else.\n\n` +
    `If ${label} came from a different adventure engine — Sierra's AGI or SCI, ` +
    `for instance — ScummVM may well run it, but this project implements SCUMM ` +
    `only. Monkey Island 2 (MONKEY2.000) and Indiana Jones and the Fate of ` +
    `Atlantis (ATLANTIS.000) do run here, as does the Fate of Atlantis DOS demo, ` +
    `free from scummvm.org/demos.`
  );
}

/**
 * The XOR key v4 encrypts its containers with, where the index is in the clear.
 *
 * ScummVM's `getEncByte` is the reference: at v4 the key is 0 for room 0 — the
 * index — and for every resource numbered 900 and up, which is the charsets,
 * and 0x69 for everything else. So a v4 install holds three files in the clear
 * and its disks encrypted, and one key for the whole set is wrong for some of
 * it whichever key is chosen.
 */
const V4_DATA_XOR_KEY = 0x69;

/** `DISK01.LEC` … `DISK09.LEC`, in disk order, for those that are present. */
function findLecDisks(names: readonly string[]): string[] {
  const disks: string[] = [];
  for (let disk = 1; disk <= 9; disk++) {
    const found = findFile(names, `disk0${disk}.lec`);
    if (found) disks.push(found);
  }
  return disks;
}

/** `901.LFL` … `904.LFL`, the v4 charsets, in charset order. */
function findV4Charsets(names: readonly string[]): string[] {
  const found: string[] = [];
  for (let charset = 0; charset <= 4; charset++) {
    const file = findFile(names, `90${charset}.lfl`);
    if (file) found.push(file);
  }
  return found;
}

/**
 * `01.LFL` … `99.LFL`, the per-room files, excluding the charsets at the top.
 *
 * The charsets are `99.LFL`, `98.LFL` and `97.LFL` — `99 - n` for charset `n`,
 * which is why they come off the top of the same numbering rather than out of a
 * separate range as v4's do.
 */
const V3_LOWEST_CHARSET_FILE = 97;

function findLflRooms(names: readonly string[]): string[] {
  const rooms: string[] = [];
  for (let room = 1; room < V3_LOWEST_CHARSET_FILE; room++) {
    const found = findFile(names, `${String(room).padStart(2, '0')}.lfl`);
    if (found) rooms.push(found);
  }
  return rooms;
}

function findV3Charsets(names: readonly string[]): string[] {
  const found: string[] = [];
  for (let file = 99; file >= V3_LOWEST_CHARSET_FILE; file--) {
    const name = findFile(names, `${file}.lfl`);
    if (name) found.push(name);
  }
  return found;
}

/**
 * Finds a game's files in a data source.
 *
 * Three layouts, and the discriminator between them is the *shape* of the index
 * file's name rather than a guess about what a release calls itself: three
 * digits (`000.LFL`) is a v4 install, two (`00.LFL`) is v2 or v3, and a stem
 * with a `.000`/`.LA0` extension is v5 and later. That is structural — the
 * digits are the room number the index occupies, and v4 needed a third one
 * because its rooms went past ninety-nine.
 */
export async function detectGame(
  source: DataSource,
  progress: LoadProgressTracker = new LoadProgressTracker(),
): Promise<DetectedGame> {
  const names = source.list();
  progress.report('detecting', `Looking for game data in ${source.label}…`, 0.2);

  // Data for another ScummVM engine is a common and confusing case: the files
  // are valid, just not ours. Say which engine they belong to.
  //
  // Asked first, not as a fallback for finding no index candidate. A marker
  // file the signature table recognises is positive evidence about which
  // engine owns the dump; a file *named* `.000` is evidence about nothing.
  const foreign = identifyForeignEngine(names);
  if (foreign) throw new Error(describeForeignEngine(foreign, names));

  const lecIndex = findFile(names, '000.lfl');
  if (lecIndex) return await detectLecDisks(source, names, lecIndex, progress);

  const lflIndex = findFile(names, '00.lfl');
  if (lflIndex) return await detectLflRooms(source, names, lflIndex, progress);

  return await detectContainer(source, names, progress);
}

/** v4: `000.LFL` in the clear, and up to nine `DISKnn.LEC` containers. */
async function detectLecDisks(
  source: DataSource,
  names: readonly string[],
  indexFile: string,
  progress: LoadProgressTracker,
): Promise<DetectedGame> {
  progress.report('detecting', `Checking ${indexFile}…`, 0.6);

  const disks = findLecDisks(names);
  if (disks.length === 0) {
    throw new Error(
      `${indexFile} is a SCUMM v4 index, but ${source.label} holds no DISKnn.LEC ` +
        `containers beside it. A v4 game is its index plus one file per disk — ` +
        `DISK01.LEC through DISK04.LEC for a floppy release, DISK01.LEC alone ` +
        `for a CD one. Make sure the whole game directory was selected.`,
    );
  }

  const rawIndex = await source.read(indexFile);
  if (!rawIndex) throw new Error(`Cannot read index file ${indexFile}`);

  const xorKey = detectIndexKey(rawIndex) ?? 0;
  const index = decryptCopy(rawIndex, xorKey);
  if (!looksLikeOldIndex(index)) {
    throw new Error(describeNotScummData(indexFile, source.label));
  }

  return finish(names, progress, {
    indexFile,
    dataFiles: disks,
    charsetFiles: findV4Charsets(names),
    layout: 'lec-disks',
    xorKey,
    dataXorKey: V4_DATA_XOR_KEY,
    version: 4,
    id: gameIdFrom(source, names),
    identification: 'index-structure',
  });
}

/** v2 and v3: `00.LFL` and one file per room. */
async function detectLflRooms(
  source: DataSource,
  names: readonly string[],
  indexFile: string,
  progress: LoadProgressTracker,
): Promise<DetectedGame> {
  progress.report('detecting', `Checking ${indexFile}…`, 0.6);

  const rooms = findLflRooms(names);
  if (rooms.length === 0) {
    throw new Error(
      `${indexFile} is a SCUMM index, but ${source.label} holds no room files ` +
        `beside it. A v2 or v3 game keeps every room in its own file, 01.LFL ` +
        `upwards, so an index on its own is an incomplete copy.`,
    );
  }

  const rawIndex = await source.read(indexFile);
  if (!rawIndex) throw new Error(`Cannot read index file ${indexFile}`);

  // Not `detectIndexKey`: an `LFL` index opens with a magic word rather than a
  // tag under any key, so the key is found by the same walk that decides the
  // Version — the reading that adds up is the reading whose key is right.
  let decided: { version: 2 | 3; identification: VersionIdentification } | null = null;
  let xorKey = 0;
  for (const key of CANDIDATE_XOR_KEYS) {
    const candidate = versionFromLflIndex(decryptCopy(rawIndex, key));
    if (!candidate) continue;
    decided = candidate;
    xorKey = key;
    if (candidate.identification === 'index-structure') break;
  }

  if (!decided) throw new Error(describeNotScummData(indexFile, source.label));

  return finish(names, progress, {
    indexFile,
    dataFiles: rooms,
    charsetFiles: findV3Charsets(names),
    layout: 'lfl-rooms',
    xorKey,
    dataXorKey: xorKey,
    version: decided.version,
    id: gameIdFrom(source, names),
    identification: decided.identification,
  });
}

/**
 * v5-v8: `<NAME>.000` and `<NAME>.001`, or the `.LA0`/`.LA1` extraction naming.
 *
 * The pair must share a stem so a directory containing two games does not
 * produce a mismatched pair.
 */
async function detectContainer(
  source: DataSource,
  names: readonly string[],
  progress: LoadProgressTracker,
): Promise<DetectedGame> {
  const indexCandidates = names.filter((name) => {
    const ext = extension(name);
    return ext === '000' || ext === 'la0';
  });

  if (indexCandidates.length === 0) {
    throw new Error(
      `No SCUMM game data found in ${source.label}. Looked for an index and ` +
        `container pair (*.000 with *.001, or *.LA0 with *.LA1), a v4 install ` +
        `(000.LFL with DISKnn.LEC) and a v2 or v3 one (00.LFL with 01.LFL ` +
        `upwards). Found: ${names.slice(0, 12).join(', ') || '(nothing)'}`,
    );
  }

  for (const indexFile of indexCandidates) {
    const id = stem(indexFile);
    const dataFile = names.find((name) => {
      const ext = extension(name);
      return stem(name) === id && (ext === '001' || ext === 'la1');
    });
    if (!dataFile) continue;

    progress.report('detecting', `Checking ${indexFile}…`, 0.6);
    const rawIndex = await source.read(indexFile);
    if (!rawIndex || rawIndex.length < 8) continue;

    // No key means no evidence this is an index at all, and a guessed key is
    // worse than none: it gets the whole file read and decrypted before some
    // later stage notices, and then blames the key it was handed.
    const xorKey = detectIndexKey(rawIndex);
    if (xorKey === null) throw new Error(describeNotScummData(indexFile, source.label));

    const index = decryptCopy(rawIndex, xorKey);

    // A v4 index that got itself named `<NAME>.000` rather than `000.LFL`. The
    // shape of the blocks is the evidence, and it outranks the file name.
    if (looksLikeOldIndex(index)) {
      const disks = findLecDisks(names);
      return finish(names, progress, {
        indexFile,
        dataFiles: disks.length > 0 ? disks : [dataFile],
        charsetFiles: findV4Charsets(names),
        layout: 'lec-disks',
        xorKey,
        dataXorKey: V4_DATA_XOR_KEY,
        version: 4,
        id,
        identification: 'index-structure',
      });
    }

    const { version, identification } = versionFromContainerIndex(index);
    return finish(names, progress, {
      indexFile,
      dataFiles: [dataFile],
      charsetFiles: [],
      layout: 'lecf-container',
      xorKey,
      dataXorKey: xorKey,
      version,
      id,
      identification,
    });
  }

  throw new Error(
    `Found an index file (${indexCandidates[0]}) but no matching data file ` +
      `(expected ${stem(indexCandidates[0])}.001). Make sure the whole game ` +
      `directory was selected, not just one file.`,
  );
}

/**
 * A short id for a game whose index file is named after its room number.
 *
 * `000.LFL` says nothing about which game it is, so the folder's own label is
 * the only name to hand. Falls back to the layout's own word rather than to
 * something that reads like a title.
 */
function gameIdFrom(source: DataSource, names: readonly string[]): string {
  const label = source.label
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part.length > 0)
    .pop();
  if (label && /^[\w.-]+$/.test(label)) return label.toLowerCase();
  return stem(names[0] ?? 'lfl');
}

/** The last two things every layout needs: the speech file, and a log line. */
function finish(
  names: readonly string[],
  progress: LoadProgressTracker,
  game: Omit<DetectedGame, 'speechFile'>,
): DetectedGame {
  const speechFile = names.find((name) => stem(name) === 'monster');
  const detected: DetectedGame = speechFile ? { ...game, speechFile } : game;

  // Before the resource layer touches it. Loading a version there is no
  // interpreter for succeeds at everything except running the game, and the
  // player sees a black screen rather than a reason.
  if (!isSupportedVersion(detected.version)) {
    throw new Error(describeUnsupportedVersion(detected.version, detected.indexFile));
  }

  progress.report('detecting', `Found SCUMM v${detected.version} game "${detected.id}"`);
  return detected;
}
