import { OF_OWNER_ROOM_V7 } from '../constants.js';
import { ByteStream } from '../util/ByteStream.js';
import {
  CHUNK_HEADER_SIZE,
  SMALL_CHUNKS,
  chunkFormatFor,
  findChunk,
  iterateChunks,
  readChunkHeader,
  readSmallChunkHeader,
  type ChunkFormat,
} from './Chunk.js';
import type { DataSource } from './DataSource.js';
import { BufferVolumeReader } from './VolumeReader.js';
import { containerFile, type DetectedGame } from './GameDetector.js';
import { LoadProgressTracker, formatBytes, plural } from './progress.js';
import { decryptCopy, decryptRange } from './xor.js';

/** The four bytes a data file has to open with, decrypted. */
const CONTAINER_TAG = 'LECF';

/**
 * The name the container is filed under in `volumes`.
 *
 * One name rather than the file's own, because a v4 install's several `.LEC`
 * disks are concatenated into one addressable space before anything indexes
 * into it — the offsets in the directories are into that space, not into any
 * one file on disk. Calling it by the file it came from would be a lie for
 * every release that shipped on more than one.
 */
const CONTAINER_VOLUME = 'container';

/**
 * The data file's opening tag, decrypted with the key detection settled on.
 */
function containerTag(raw: Uint8Array, xorKey: number): string {
  if (raw.length < CHUNK_HEADER_SIZE) return '';
  const head = decryptCopy(raw.subarray(0, 4), xorKey);
  return String.fromCharCode(head[0], head[1], head[2], head[3]);
}

/** True if the data file opens with the `LECF` container. */
function looksLikeDataFile(raw: Uint8Array, xorKey: number): boolean {
  return containerTag(raw, xorKey) === CONTAINER_TAG;
}

/** A tag is only worth quoting back if it is four readable characters. */
function isPrintableTag(tag: string): boolean {
  return tag.length === 4 && [...tag].every((c) => c >= ' ' && c <= '~');
}

/**
 * Why a data file this engine cannot read is not the XOR key's fault.
 *
 * The message this replaced named the key as the likely cause and printed the
 * decoded bytes as text:
 *
 *   Data file KQ4SG.001 does not start with LECF (got '%i½'). The XOR key
 *   (0x69) may be wrong for this release.
 *
 * Both halves misled. The key is now proven against the index before anything
 * gets this far — detection refuses when no candidate key yields a known block
 * tag — so by the time a wrong container tag turns up, the key is the one thing
 * that has evidence behind it. And `'%i½'` is arbitrary bytes rendered as
 * text: mojibake that tells the reader nothing and reads as a crash. A tag is
 * quoted back only when it is four printable characters, i.e. when it could
 * plausibly be a tag from a format somebody could name.
 *
 * First line first: only the opening line reaches the status line.
 */
function describeWrongContainer(tag: string, game: DetectedGame): string {
  const found = isPrintableTag(tag)
    ? `It opens with '${tag}' instead of ${CONTAINER_TAG}.`
    : `It does not open with ${CONTAINER_TAG}, or with anything readable as a tag at all.`;

  return (
    `${containerFile(game)} is not SCUMM game data.\n\n` +
    `${found} A SCUMM data file is one ${CONTAINER_TAG} container holding every ` +
    `room, script and costume in the game.\n\n` +
    `The index ${game.indexFile} did decode to a SCUMM index with XOR ` +
    `0x${game.xorKey.toString(16)}, so the key is not the problem — this file is ` +
    `a different format, or belongs to a different game than the index beside it. ` +
    `Check that the whole game directory was selected and that ${containerFile(game)} ` +
    `is not truncated.`
  );
}

/** One of v7's two 50-byte `MAXS` strings, trimmed of its padding. */
function readVersionString(stream: ByteStream): string {
  let text = '';
  for (let i = 0; i < 50; i++) {
    const ch = stream.readU8();
    if (ch !== 0) text += String.fromCharCode(ch);
  }
  return text.trim();
}

export type ResourceType = 'room' | 'script' | 'costume' | 'charset' | 'sound';

const EXPECTED_TAG: Record<ResourceType, string> = {
  room: 'ROOM',
  script: 'SCRP',
  costume: 'COST',
  charset: 'CHAR',
  sound: 'SOUN',
};

/** The same five, as v2-v4 tag them. Two characters, and not abbreviations. */
const OLD_EXPECTED_TAG: Record<ResourceType, string> = {
  room: 'RO',
  script: 'SC',
  costume: 'CO',
  charset: 'CH',
  sound: 'SO',
};

/**
 * Which charset a pre-v5 charset file holds.
 *
 * v4 names them `900 + n` and v3 names them `99 - n`, so `901.LFL` is charset
 * **1** and `99.LFL` is charset **0**. Neither is the file's position in a
 * sorted list, which is what this replaced: an install shipping 901 through
 * 904 and no 900 put its first file at index 0, and every charset in the game
 * came out one too low — the game asked for the font it wanted and got the one
 * before it.
 */
function charsetNumberOf(name: string): number | null {
  const base = (name.replace(/\\/g, '/').split('/').pop() ?? name).toLowerCase();
  const wide = /^9(\d{2})\.lfl$/.exec(base);
  if (wide) return Number(wide[1]);
  const narrow = /^(9[0-9])\.lfl$/.exec(base);
  if (narrow) return 99 - Number(narrow[1]);
  return null;
}

/** `01.LFL` -> 1, and anything that is not a numbered room file -> null. */
function roomNumberOf(name: string): number | null {
  const base = (name.replace(/\\/g, '/').split('/').pop() ?? name).toLowerCase();
  const match = /^(\d{1,3})\.lfl$/.exec(base);
  return match ? Number(match[1]) : null;
}

/** One entry of a resource directory (DROO, DSCR, DCOS, DCHR, DSOU). */
interface DirectoryEntry {
  /** Room (== disk block) the resource lives in. */
  roomNo: number;
  /** Offset of the resource, relative to that block's base. */
  offset: number;
}

/** A script array the index declares, from `AARY`. */
export interface ArrayDeclaration {
  /** Variable number the array is addressed by. */
  variable: number;
  dim1: number;
  dim2: number;
  kind: 'int' | 'bit';
}

/** `AARY`'s type field for a bit array; every other value is an integer array. */
const V6_BIT_ARRAY = 4;

/** Bytes v8 spends on an object's name in the global object table. */
const V8_OBJECT_NAME_BYTES = 40;

/** Owner occupies the low nibble of the packed owner/state byte. */
const OF_OWNER_MASK = 0x0f;

/** State occupies the high nibble of the same byte. */
const OF_STATE_SHIFT = 4;

export interface GameLimits {
  numVariables: number;
  numBitVariables: number;
  numLocalObjects: number;
  numCharsets: number;
  numInventory: number;
  numGlobalObjects: number;
  numRooms: number;
  numScripts: number;
  numCostumes: number;
  numSounds: number;
  numVerbs: number;
  numActors: number;
  numGlobalScripts: number;
}

const V5_DEFAULT_LIMITS: GameLimits = {
  numVariables: 800,
  numBitVariables: 2048,
  numLocalObjects: 200,
  numCharsets: 9,
  numInventory: 80,
  numGlobalObjects: 1000,
  numRooms: 100,
  numScripts: 200,
  numCostumes: 150,
  numSounds: 100,
  numVerbs: 100,
  numActors: 13,
  numGlobalScripts: 200,
};

/**
 * Owns the decrypted game files and turns resource ids into byte ranges.
 *
 * Everything is held in memory. A v5 game is 6-10 MB decrypted, which is
 * nothing for a browser, and it removes an entire class of async plumbing from
 * the hot path: the script VM can ask for a costume synchronously mid-frame.
 */
/** "2.1 MB of 5.4 MB", or just the amount when the size is unknown. */
function describeRead(loaded: number, total: number | undefined): string {
  return total ? `${formatBytes(loaded)} of ${formatBytes(total)}` : formatBytes(loaded);
}

export class ResourceManager {
  readonly game: DetectedGame;
  /** Decrypted index file (`*.000`). */
  index!: Uint8Array;

  /**
   * The container, held by the one thing that owns game bytes (ADR 0021).
   *
   * A SCUMM release is small enough to hold whole and has to be — a script asks
   * for a costume in the middle of a frame and cannot await — so this is a
   * `BufferVolumeReader` and `data` below is the buffer it serves. The seam is
   * still worth having here: it is the same interface SCI's Volumes arrive
   * through, so there is one answer in the project to "where do a game's bytes
   * come from" rather than one per family.
   */
  readonly volumes = new BufferVolumeReader('container');

  /**
   * Decrypted data file (`*.001`), for the walking.
   *
   * The container is a chunk tree, so finding a resource means reading a header
   * to learn where the next one is; that is a walk over the buffer rather than
   * a sequence of ranges anybody could name in advance. `getResource` hands out
   * its slices through `volumes` — the addressing goes through the seam, the
   * walking uses the bytes the seam is serving.
   */
  get data(): Uint8Array {
    return this.volumes.whole(CONTAINER_VOLUME);
  }

  set data(bytes: Uint8Array) {
    this.volumes.set(CONTAINER_VOLUME, bytes);
  }

  /**
   * Where each data file starts and ends inside `data`, in the order read.
   *
   * `data` is one buffer for every layout, because everything above this layer
   * addresses a resource as a room and an offset from it and a room lives in
   * exactly one file. An *export* is the one caller that needs the seams back:
   * a v4 install is written as `000.LFL` plus its disks and a v3 install as an
   * index plus fifty-odd room files, and neither is one blob however
   * conveniently it was read as one.
   *
   * A single entry for `lecf-container`, where the file and the buffer are the
   * same thing.
   */
  readonly dataFileRanges: Array<{ name: string; start: number; length: number }> = [];

  readonly limits: GameLimits = { ...V5_DEFAULT_LIMITS };

  /**
   * Arrays the index asks for up front, from `AARY`. Empty for v5, which has
   * no such block.
   */
  readonly arrayDeclarations: ArrayDeclaration[] = [];

  /** Per-type directories, indexed by resource id. */
  private readonly directories = new Map<ResourceType, DirectoryEntry[]>();

  /** Room number -> base offset in the data file, taken from LOFF. */
  private readonly roomBase = new Map<number, number>();

  /** Room number -> offset of that room's LFLF chunk header. */
  private readonly roomLflf = new Map<number, number>();

  /** Class flags per global object, from DOBJ. */
  classData: Uint32Array = new Uint32Array(0);
  objectOwner: Uint8Array = new Uint8Array(0);
  objectState: Uint8Array = new Uint8Array(0);

  /**
   * Which room each global object belongs to. v7 only; empty before it.
   *
   * v5 and v6 answer this by searching the rooms; v7 writes it down, which is
   * the column it added to `DOBJ` in place of the owner it dropped.
   */
  objectRoom: Uint8Array = new Uint8Array(0);

  /**
   * Names for iMUSE Digital's audio cues, from `ANAM`. v7 only.
   *
   * Read here because the index is where they live; used by the bundle reader,
   * which addresses a `.BUN` entry by name rather than by number.
   */
  readonly audioNames: string[] = [];

  /**
   * The two strings v7's `MAXS` opens with: an engine build and a data build.
   *
   * Kept because they identify the *release*, which is the thing an export has
   * to match a re-supplied folder against, and because they are the cheapest
   * evidence that a v7 index was read at the right offset at all.
   */
  engineVersionString = '';
  dataVersionString = '';

  /** Room names from RNAM, for debugging and the room picker. */
  readonly roomNames = new Map<number, string>();

  /**
   * v8's object names, mapped back to the ids they belong to.
   *
   * Empty before v8, and load-bearing at it: a v8 `IMHD` carries a name where
   * every earlier Version's carries an object id, so without this table an
   * image block cannot be matched to its object at all.
   */
  readonly objectNames = new Map<string, number>();

  /**
   * Offsets in LOFF are relative to a per-release base. Detected once on the
   * first successful lookup and reused, rather than guessed per resource.
   */
  private offsetBias: number | null = null;

  constructor(game: DetectedGame) {
    this.game = game;
  }

  static async load(
    source: DataSource,
    game: DetectedGame,
    progress: LoadProgressTracker = new LoadProgressTracker(),
  ): Promise<ResourceManager> {
    const manager = new ResourceManager(game);

    progress.report('reading-index', `Reading ${game.indexFile}…`, 0);
    const rawIndex = await source.read(game.indexFile, (loaded, total) =>
      progress.report(
        'reading-index',
        `Reading ${game.indexFile} (${describeRead(loaded, total)})`,
        total ? loaded / total : 0.5,
      ),
    );
    if (!rawIndex) throw new Error(`Cannot read index file ${game.indexFile}`);
    manager.index = decryptCopy(rawIndex, game.xorKey);

    progress.report('parsing-index', 'Reading the resource directories…', 0.2);
    await progress.yieldToUi();
    if (game.layout === 'lec-disks') manager.parseOldIndex();
    else if (game.layout === 'lfl-rooms') manager.parseLflIndex();
    else manager.parseIndex();
    progress.report('parsing-index', manager.describeDirectories());

    if (game.layout === 'lec-disks') {
      await manager.loadLecDisks(source, progress);
      progress.report('parsing-container', `Mapped ${plural(manager.roomCount, 'room')}`);
      await manager.loadOldCharsets(source);
      return manager;
    }

    if (game.layout === 'lfl-rooms') {
      await manager.loadLflRooms(source, progress);
      progress.report('parsing-container', `Mapped ${plural(manager.roomCount, 'room')}`);
      await manager.loadOldCharsets(source);
      return manager;
    }

    const dataFile = containerFile(game);
    progress.report('reading-data', `Reading ${dataFile}…`, 0);
    const rawData = await source.read(dataFile, (loaded, total) =>
      progress.report(
        'reading-data',
        `Reading ${dataFile} (${describeRead(loaded, total)})`,
        total ? loaded / total : 0.5,
      ),
    );
    if (!rawData) throw new Error(`Cannot read data file ${dataFile}`);
    // Eight bytes, before the decrypt rather than after it. This check used to
    // live in parseContainer, which meant a file that was never SCUMM data got
    // read in full and XOR-decrypted end to end — 148 MB of it for Full
    // Throttle — with every stage before it reading as progress.
    if (!looksLikeDataFile(rawData, game.xorKey)) {
      throw new Error(describeWrongContainer(containerTag(rawData, game.xorKey), game));
    }
    manager.data = await manager.decryptData(rawData, progress);
    manager.dataFileRanges.push({ name: dataFile, start: 0, length: manager.data.length });
    progress.report('parsing-container', `Mapping the rooms in ${dataFile}…`, 0.2);
    await progress.yieldToUi();
    manager.parseContainer();
    progress.report('parsing-container', `Mapped ${plural(manager.roomCount, 'room')}`);

    return manager;
  }

  /**
   * The chunk header shape this game's resources use.
   *
   * v4 and earlier write a little-endian size then a two character tag; v5 and
   * later a four character tag then a big-endian size (`Chunk.ts`).
   */
  get chunks(): ChunkFormat {
    return chunkFormatFor(this.game.version);
  }

  /**
   * Reads a v4 install: `000.LFL` for the index, `DISKnn.LEC` for the data.
   *
   * The disks are concatenated into one buffer and every offset recorded
   * against that buffer, rather than kept as a list of files with per-file
   * offsets. The reason is that everything above this layer addresses a
   * resource as "a room number and an offset from that room", and a room lives
   * in exactly one disk — so once the room's base is absolute, nothing else has
   * to learn that v4 has more than one file. Four floppy containers come to
   * about four megabytes, which is smaller than the single container a v5 game
   * loads whole.
   *
   * The charsets are *not* in here: v4 keeps them in `901.LFL` … `904.LFL`,
   * unencrypted, and `loadOldCharsets` reads them separately.
   */
  private async loadLecDisks(source: DataSource, progress: LoadProgressTracker): Promise<void> {
    const pieces: Uint8Array[] = [];
    const bases: number[] = [];
    let total = 0;

    for (const name of this.game.dataFiles) {
      progress.report('reading-data', `Reading ${name}…`, 0);
      const raw = await source.read(name);
      if (!raw) throw new Error(`Cannot read data file ${name}`);
      const decrypted = decryptCopy(raw, this.game.dataXorKey);
      bases.push(total);
      pieces.push(decrypted);
      this.dataFileRanges.push({ name, start: total, length: decrypted.length });
      total += decrypted.length;
    }

    const data = new Uint8Array(total);
    for (let i = 0; i < pieces.length; i++) data.set(pieces[i], bases[i]);
    this.data = data;

    progress.report('parsing-container', 'Mapping the rooms in the disk containers…', 0.5);
    await progress.yieldToUi();

    for (let disk = 0; disk < pieces.length; disk++) {
      this.parseLecDisk(bases[disk], pieces[disk].length, this.game.dataFiles[disk]);
    }
  }

  /**
   * One `DISKnn.LEC`: an `LE` container whose `FO` block lists its rooms.
   *
   * `FO` is a one byte count and then a room number and a 32-bit offset each,
   * pointing at that room's `LF` block *within this file*. ScummVM reaches it
   * by seeking to byte 12, which is the same place by a shorter route: six
   * bytes of `LE` header and six of `FO`.
   */
  private parseLecDisk(base: number, length: number, name: string): void {
    const container = readSmallChunkHeader(this.data, base);
    if (container.tag !== 'LE') {
      throw new Error(
        `${name} is not a SCUMM v4 disk container.\n\n` +
          `It opens with '${container.tag}' instead of LE. A v4 game keeps its ` +
          `rooms in one LE container per disk, with the index in 000.LFL beside ` +
          `them. Check that the whole game directory was selected and that the ` +
          `file is not truncated.`,
      );
    }

    const directory = findChunk(this.data, container.dataOffset, 'FO', base + length, SMALL_CHUNKS);
    if (!directory) return;

    const stream = new ByteStream(this.data, directory.dataOffset);
    const count = stream.readU8();
    for (let i = 0; i < count; i++) {
      const room = stream.readU8();
      const offset = stream.readU32LE();
      // A room listed at offset zero is one this disk does not actually hold.
      if (offset === 0) continue;
      this.roomLflf.set(room, base + offset);
      this.roomBase.set(room, base + offset);
    }
  }

  /**
   * Reads a v2 or v3 install: `00.LFL` and one file per room.
   *
   * No container at all, which is the whole of what makes this layout its own
   * axis. A v4 game has one `LE` per disk with an `FO` table inside it saying
   * where each room starts; here a room *is* a file, named by its number, and
   * a resource's offset is simply an offset into that file.
   *
   * Concatenated into one buffer with each room's base recorded absolutely,
   * for the reason the v4 reader does the same: everything above this layer
   * addresses a resource as a room and an offset from it, so once the room's
   * base is absolute nothing else has to learn how many files there are. A v3
   * install is a few megabytes across fifty-odd files.
   *
   * The file's name is the room number, so a room the index lists and the
   * folder does not hold is simply absent — and absent is the honest answer,
   * because there is no directory that could have said otherwise.
   */
  private async loadLflRooms(source: DataSource, progress: LoadProgressTracker): Promise<void> {
    const pieces: Uint8Array[] = [];
    const bases: number[] = [];
    let total = 0;

    for (const name of this.game.dataFiles) {
      const raw = await source.read(name);
      if (!raw) continue;
      const room = roomNumberOf(name);
      if (room === null) continue;

      const decrypted = decryptCopy(raw, this.game.dataXorKey);
      bases.push(total);
      pieces.push(decrypted);
      this.dataFileRanges.push({ name, start: total, length: decrypted.length });
      this.roomLflf.set(room, total);
      this.roomBase.set(room, total);
      total += decrypted.length;

      if (pieces.length % 16 === 0) {
        progress.report('reading-data', `Reading room files (${pieces.length})…`, 0.5);
        await progress.yieldToUi();
      }
    }

    const data = new Uint8Array(total);
    for (let i = 0; i < pieces.length; i++) data.set(pieces[i], bases[i]);
    this.data = data;
  }

  /**
   * The v2 and v3 index: a magic word, an object table, four directories.
   *
   * No block structure — the file is one record, walked in order, and its shape
   * is the only thing that says which Version wrote it. v2 spends one byte per
   * global object and v3 spends four, which is what `GameDetector` decides on;
   * by the time this runs the answer is already known and is used rather than
   * worked out again.
   *
   * The directories are narrower than v4's in two ways: a one byte count where
   * v4 has two, and sixteen bit offsets where v4 has thirty-two. The room
   * directory has no room-number column at all, because a room's number is its
   * file's name. (`ScummEngine_v3old::readResTypeList`.)
   */
  private parseLflIndex(): void {
    const stream = new ByteStream(this.index, 0);
    stream.readU16LE(); // magic, already checked by detection

    const objects = stream.readU16LE();
    this.limits.numGlobalObjects = objects;
    this.classData = new Uint32Array(objects);
    this.objectOwner = new Uint8Array(objects);
    this.objectState = new Uint8Array(objects);

    if (this.game.version >= 3) {
      // Three class bytes and a packed owner/state byte, as v4 stores it.
      for (let i = 0; i < objects; i++) {
        const low = stream.readU8();
        const mid = stream.readU8();
        const high = stream.readU8();
        this.classData[i] = (low | (mid << 8) | (high << 16)) >>> 0;
        const packed = stream.readU8();
        this.objectOwner[i] = packed & OF_OWNER_MASK;
        this.objectState[i] = packed >> OF_STATE_SHIFT;
      }
    } else {
      // v2 keeps no classes in the index at all: one packed byte per object.
      for (let i = 0; i < objects; i++) {
        const packed = stream.readU8();
        this.objectOwner[i] = packed & OF_OWNER_MASK;
        this.objectState[i] = packed >> OF_STATE_SHIFT;
      }
    }

    // Rooms, costumes, scripts, sounds — in that order, always four of them.
    this.directories.set('room', this.parseLflDirectory(stream, true));
    this.directories.set('costume', this.parseLflDirectory(stream, false));
    this.directories.set('script', this.parseLflDirectory(stream, false));
    this.directories.set('sound', this.parseLflDirectory(stream, false));

    const limits = this.limits;
    limits.numRooms = this.directories.get('room')?.length ?? limits.numRooms;
    limits.numScripts = this.directories.get('script')?.length ?? limits.numScripts;
    limits.numSounds = this.directories.get('sound')?.length ?? limits.numSounds;
    limits.numCostumes = this.directories.get('costume')?.length ?? limits.numCostumes;
    limits.numCharsets = Math.max(limits.numCharsets, this.game.charsetFiles.length);
  }

  /**
   * One v2/v3 directory: a count, room numbers (or none), then the offsets.
   *
   * The room directory's numbers are skipped rather than read, because a room
   * is a file named after itself and the column carries nothing. Reading it as
   * a column of room numbers and then reading the offsets would be off by
   * `count` bytes for every directory after it.
   */
  private parseLflDirectory(stream: ByteStream, isRooms: boolean): DirectoryEntry[] {
    const count = stream.readU8();
    const rooms = new Array<number>(count);
    for (let i = 0; i < count; i++) {
      // The room directory has a room-number column like the others and it
      // carries nothing — a room is a file named after itself — so ScummVM
      // *seeks past* it rather than reading it. Not reading it at all is a
      // different thing: the offsets then come out of the middle of the column
      // and every directory after this one starts `count` bytes early.
      const stored = stream.readU8();
      rooms[i] = isRooms ? i : stored;
    }

    const entries = new Array<DirectoryEntry>(count);
    for (let i = 0; i < count; i++) {
      const offset = stream.readU16LE();
      // 0xFFFF is the "not present" value, as 0xFFFFFFFF is in v4 and later.
      entries[i] = { roomNo: rooms[i], offset: offset === 0xffff ? 0xffffffff : offset };
    }
    return entries;
  }

  /**
   * v4's charsets, which live outside the containers in `9nn.LFL`.
   *
   * Unencrypted, unlike the disks beside them: `ScummEngine::getEncByte`
   * returns 0 for room 0 and for anything numbered 900 and up, and 0x69 for
   * everything else. A single key for the whole install decrypts three of its
   * files into noise.
   *
   * Each file is a 32-bit size and then the charset, and ScummVM reads
   * `size + 11` bytes — the size field counts from eleven bytes in. Kept whole
   * so the charset reader sees exactly what a v5 `CHAR` chunk's payload is.
   */
  private async loadOldCharsets(source: DataSource): Promise<void> {
    for (const name of this.game.charsetFiles) {
      const raw = await source.read(name);
      if (!raw) continue;
      this.charsetFileData.push({ name, data: raw });
      const id = charsetNumberOf(name);
      if (id !== null) this.oldCharsets.set(id, raw);
    }
  }

  /** v2-v4 charsets, by number, read from their own files. */
  private readonly oldCharsets = new Map<number, Uint8Array>();

  /**
   * The same files by name, exactly as they were read.
   *
   * Kept beside the by-number map because an export needs the *install* and
   * the engine needs the *charset*. Writing a v4 game back out produced
   * `000.LFL` and `DISK01.LEC` and stopped, so an exported Loom CD was an
   * install missing four of its six files — it loaded, and then could not draw
   * a letter. Held as read rather than decrypted, since these are copied
   * through untouched and a v4 charset is not encrypted the way the disks
   * beside it are.
   */
  readonly charsetFileData: Array<{ name: string; data: Uint8Array }> = [];

  /**
   * The v4 index: blocks of a little-endian size and a two character tag.
   *
   * Different from v5's in every particular that matters. The directories are
   * *interleaved* — a room number and an offset per entry — where v5 stores two
   * columns; the offsets are relative to the room's `RO` block rather than to
   * its container block; and the room directory's "room number" column is
   * really the **disk number**, which is how a four-floppy release says which
   * `DISKnn.LEC` to look in. (`ScummEngine_v4::readIndexFile`.)
   */
  private parseOldIndex(): void {
    for (const chunk of iterateChunks(this.index, 0, this.index.length, SMALL_CHUNKS)) {
      const stream = new ByteStream(this.index, chunk.dataOffset);
      switch (chunk.tag) {
        case 'RN':
          this.parseRoomNames(stream, chunk.dataOffset + chunk.dataSize);
          break;
        case '0R':
          this.directories.set('room', this.parseOldDirectory(stream));
          break;
        case '0S':
          this.directories.set('script', this.parseOldDirectory(stream));
          break;
        case '0N':
          this.directories.set('sound', this.parseOldDirectory(stream));
          break;
        case '0C':
          this.directories.set('costume', this.parseOldDirectory(stream));
          break;
        case '0O':
          this.parseOldGlobalObjects(stream);
          break;
        default:
          break;
      }
    }

    const limits = this.limits;
    limits.numRooms = this.directories.get('room')?.length ?? limits.numRooms;
    limits.numScripts = this.directories.get('script')?.length ?? limits.numScripts;
    limits.numSounds = this.directories.get('sound')?.length ?? limits.numSounds;
    limits.numCostumes = this.directories.get('costume')?.length ?? limits.numCostumes;
    limits.numCharsets = Math.max(limits.numCharsets, this.game.charsetFiles.length);
  }

  /** A v4 directory: a count, then a room number and an offset per entry. */
  private parseOldDirectory(stream: ByteStream): DirectoryEntry[] {
    const count = stream.readU16LE();
    const entries = new Array<DirectoryEntry>(count);
    for (let i = 0; i < count; i++) {
      entries[i] = { roomNo: stream.readU8(), offset: stream.readU32LE() };
    }
    return entries;
  }

  /**
   * v4's global object table, which is interleaved where v5's is columnar.
   *
   * Three class bytes and then a packed owner/state byte, per object, in one
   * record. v5 stores the same information as two columns — every owner/state
   * byte, then every 32-bit class field — and reading v5's layout this way is
   * the `DOBJ` fault this codebase already met once: every object comes back
   * owned by the room with a class field of 0x0f0f0f, which is plausible and
   * wrong. Here the interleaved reading is the right one.
   * (`ScummEngine::readGlobalObjects`.)
   */
  private parseOldGlobalObjects(stream: ByteStream): void {
    const count = stream.readU16LE();
    this.limits.numGlobalObjects = count;
    this.classData = new Uint32Array(count);
    this.objectOwner = new Uint8Array(count);
    this.objectState = new Uint8Array(count);

    for (let i = 0; i < count; i++) {
      const low = stream.readU8();
      const mid = stream.readU8();
      const high = stream.readU8();
      this.classData[i] = (low | (mid << 8) | (high << 16)) >>> 0;
      const packed = stream.readU8();
      this.objectOwner[i] = packed & OF_OWNER_MASK;
      this.objectState[i] = packed >> OF_STATE_SHIFT;
    }
  }

  /**
   * Decrypts the data file a megabyte at a time.
   *
   * Into a new buffer, not in place: a source may hand out a buffer it keeps
   * (both the in-memory and HTTP sources cache theirs), and decrypting that
   * would leave it XORed for the next load. Slicing keeps the tab responsive —
   * one pass over 6-10 MB is a visible freeze the player cannot tell from a
   * hang — and when nobody is watching it is one pass with no added latency.
   */
  private async decryptData(raw: Uint8Array, progress: LoadProgressTracker): Promise<Uint8Array> {
    const key = this.game.xorKey;

    // A zero key is not a cheap decrypt, it is no decrypt: every byte would be
    // XORed with 0 into a buffer the same size as the input. v7 data files are
    // stored plain, and Full Throttle's is ~148 MB, so the copy this skips is
    // the difference between one and two of them resident at once.
    //
    // Safe to alias the source only because nothing writes into the returned
    // buffer: the comment below explains why the copy exists for a real key —
    // a source may hand out a buffer it caches, and decrypting in place would
    // leave it XORed for the next load. Returning it untouched cannot.
    if (key === 0) return raw;

    const out = new Uint8Array(raw.length);

    if (!progress.enabled) {
      decryptRange(out, raw, key, 0, raw.length);
      return out;
    }

    const slice = 1024 * 1024;
    for (let at = 0; at < raw.length; at += slice) {
      decryptRange(out, raw, key, at, at + slice);
      const done = Math.min(raw.length, at + slice);
      progress.report(
        'decrypting',
        `Decrypting ${containerFile(this.game)} (${formatBytes(done)} of ${formatBytes(raw.length)})`,
        done / raw.length,
      );
      await progress.yieldToUi();
    }
    return out;
  }

  /** Number of rooms found in the container. */
  get roomCount(): number {
    return this.roomLflf.size;
  }

  /** "Indexed 1000 objects, 99 rooms, 200 scripts, 150 costumes, 100 sounds". */
  describeDirectories(): string {
    const counts = [plural(this.limits.numGlobalObjects, 'object')];
    for (const type of ['room', 'script', 'costume', 'sound'] as const) {
      const entries = this.directories.get(type);
      if (entries) counts.push(plural(entries.length, type));
    }
    return `Indexed ${counts.join(', ')}`;
  }

  // ---------------------------------------------------------------- index --

  private parseIndex(): void {
    for (const chunk of iterateChunks(this.index, 0)) {
      const stream = new ByteStream(this.index, chunk.dataOffset);
      switch (chunk.tag) {
        case 'RNAM':
          this.parseRoomNames(stream, chunk.dataOffset + chunk.dataSize);
          break;
        case 'MAXS':
          this.parseMaxs(stream, chunk.size);
          break;
        case 'DROO':
          this.directories.set('room', this.parseDirectory(stream));
          break;
        case 'DSCR':
          this.directories.set('script', this.parseDirectory(stream));
          break;
        case 'DCOS':
          this.directories.set('costume', this.parseDirectory(stream));
          break;
        case 'DCHR':
          this.directories.set('charset', this.parseDirectory(stream));
          break;
        case 'DSOU':
          this.directories.set('sound', this.parseDirectory(stream));
          break;
        case 'DOBJ':
          this.parseGlobalObjects(stream);
          break;
        case 'ANAM':
          this.parseAudioNames(stream);
          break;
        case 'AARY':
          this.parseArrayDeclarations(stream, chunk.dataOffset + chunk.dataSize);
          break;
        default:
          // Unknown index blocks are skipped; releases add their own.
          break;
      }
    }
  }

  private parseRoomNames(stream: ByteStream, end: number): void {
    while (stream.position < end) {
      const room = stream.readU8();
      if (room === 0) break;
      let name = '';
      for (let i = 0; i < 9; i++) {
        const ch = stream.readU8() ^ 0xff;
        if (ch !== 0) name += String.fromCharCode(ch);
      }
      this.roomNames.set(room, name.trim());
    }
  }

  private parseMaxs(stream: ByteStream, blockSize: number): void {
    const limits = this.limits;
    if (blockSize === 176) {
      // v8. Two 50-byte version strings as v7 has, and then *seventeen 32-bit*
      // counts where v7 writes fifteen 16-bit ones — so the block is not v7's
      // with fields appended, it is the same information at twice the width in
      // a different order. Reading it as v7's puts the low half of the
      // variable count where the whole bit-variable count belongs and every
      // field after it one place out. (`ScummEngine_v8::readMAXS`.)
      this.engineVersionString = readVersionString(stream);
      this.dataVersionString = readVersionString(stream);
      limits.numVariables = stream.readU32LE();
      limits.numBitVariables = stream.readU32LE();
      stream.readU32LE(); // 40, read and discarded by ScummVM too
      limits.numScripts = stream.readU32LE();
      limits.numSounds = stream.readU32LE();
      limits.numCharsets = stream.readU32LE();
      limits.numCostumes = stream.readU32LE();
      limits.numRooms = stream.readU32LE();
      stream.readU32LE(); // 80
      limits.numGlobalObjects = stream.readU32LE();
      stream.readU32LE(); // 60
      limits.numLocalObjects = stream.readU32LE();
      stream.readU32LE(); // numNewNames
      stream.readU32LE(); // numFlObject
      limits.numInventory = stream.readU32LE();
      stream.readU32LE(); // numArray
      limits.numVerbs = stream.readU32LE();
      // v8 numbers its scripts far beyond anything before it, which is the
      // other half of "32-bit script numbering": a script number is no longer
      // bounded by the directory's size.
      limits.numGlobalScripts = 2000;
      return;
    }
    if (blockSize === 138) {
      // v7 (Full Throttle, The Dig). Two 50-byte version strings first — an
      // engine string and a data-file string — then fifteen counts in an order
      // that is v7's own: it is not v6's list with fields appended, and reading
      // it as though it were puts the global object count where the verb count
      // should be. (`ScummEngine_v7::readMAXS`.)
      this.engineVersionString = readVersionString(stream);
      this.dataVersionString = readVersionString(stream);
      limits.numVariables = stream.readU16LE();
      limits.numBitVariables = stream.readU16LE();
      stream.readU16LE(); // read and discarded by ScummVM too
      limits.numGlobalObjects = stream.readU16LE();
      limits.numLocalObjects = stream.readU16LE();
      stream.readU16LE(); // numNewNames
      limits.numVerbs = stream.readU16LE();
      stream.readU16LE(); // numFlObject
      limits.numInventory = stream.readU16LE();
      stream.readU16LE(); // numArray
      limits.numRooms = stream.readU16LE();
      limits.numScripts = stream.readU16LE();
      limits.numSounds = stream.readU16LE();
      limits.numCharsets = stream.readU16LE();
      limits.numCostumes = stream.readU16LE();
      return;
    }
    if (blockSize === 38) {
      // v6 (Day of the Tentacle, Sam & Max)
      limits.numVariables = stream.readU16LE();
      stream.readU16LE();
      limits.numBitVariables = stream.readU16LE();
      limits.numLocalObjects = stream.readU16LE();
      stream.readU16LE(); // numArray
      stream.readU16LE();
      limits.numVerbs = stream.readU16LE();
      stream.readU16LE(); // numFlObject
      limits.numInventory = stream.readU16LE();
      limits.numRooms = stream.readU16LE();
      limits.numScripts = stream.readU16LE();
      limits.numSounds = stream.readU16LE();
      limits.numCharsets = stream.readU16LE();
      limits.numCostumes = stream.readU16LE();
      limits.numGlobalObjects = stream.readU16LE();
    } else {
      // v5 (Monkey Island 2, Indiana Jones and the Fate of Atlantis)
      limits.numVariables = stream.readU16LE();
      stream.readU16LE(); // always 16
      limits.numBitVariables = stream.readU16LE();
      limits.numLocalObjects = stream.readU16LE();
      stream.readU16LE(); // always 50
      limits.numCharsets = stream.readU16LE();
      stream.readU16LE(); // always 100
      stream.readU16LE(); // always 50
      limits.numInventory = stream.readU16LE();
    }
  }

  /**
   * A resource directory: a count, then that many room numbers, then that many
   * 32-bit offsets. The two arrays are stored separately, not interleaved.
   */
  private parseDirectory(stream: ByteStream): DirectoryEntry[] {
    // v8 counts its entries in thirty-two bits where every earlier Version
    // uses sixteen. Two bytes at the front of every directory in the index,
    // and reading the narrow form takes the count's high half as the first two
    // room numbers — which is not a crash, it is a directory whose every entry
    // is shifted by two.
    const count = this.game.version >= 8 ? stream.readU32LE() : stream.readU16LE();
    const rooms = new Array<number>(count);
    for (let i = 0; i < count; i++) rooms[i] = stream.readU8();
    const entries = new Array<DirectoryEntry>(count);
    for (let i = 0; i < count; i++) {
      entries[i] = { roomNo: rooms[i], offset: stream.readU32LE() };
    }
    return entries;
  }

  /**
   * `ANAM`: the names iMUSE Digital addresses its bundle entries by.
   *
   * A count, then nine bytes of name each. New in v7 and easily mistaken for a
   * table of *object* names, which it is not — those are still `OBNA` inside
   * each object's `OBCD`, as in v5 and v6.
   * (`ScummEngine_v7::readIndexBlock`, which hands it to `setAudioNames`.)
   */
  private parseAudioNames(stream: ByteStream): void {
    const count = stream.readU16LE();
    for (let i = 0; i < count; i++) {
      let name = '';
      for (let c = 0; c < 9; c++) {
        const ch = stream.readU8();
        if (ch !== 0) name += String.fromCharCode(ch);
      }
      this.audioNames.push(name.trim());
    }
  }

  /**
   * The global object table: who owns each object, its state, and its classes.
   *
   * v5 and v6 store it identically, and column-wise: every owner/state byte
   * for every object, then every class field as a full 32 bits
   * (`ScummEngine::readGlobalObjects`). v7 is the one that differs, dropping
   * the owner column and adding a room one.
   *
   * Read as one interleaved record per object instead — three class bytes then
   * an owner/state byte, which is what this used to do — nothing fails. The
   * owner column is a long run of `OF_OWNER_ROOM`, so every object comes out
   * owned by the room and *present*, with a class field of 0x0f0f0f: class 32
   * unreadable, and classes 1 to 4, 9 to 12 and 17 to 20 all falsely set. The
   * symptom is a room that renders and cannot be played, so the layout is
   * worth checking against the block's own arithmetic: Atlantis's `DOBJ` is
   * five bytes per object, not four.
   */
  private parseGlobalObjects(stream: ByteStream): void {
    const count = this.game.version >= 8 ? stream.readU32LE() : stream.readU16LE();
    this.limits.numGlobalObjects = count;
    this.classData = new Uint32Array(count);
    this.objectOwner = new Uint8Array(count);
    this.objectState = new Uint8Array(count);

    if (this.game.version >= 8) {
      // v8 writes a *record* per object rather than columns, and the record
      // opens with a forty byte name. That name is not decoration: v8's `IMHD`
      // carries a name where v7's carries an object id, so this table is the
      // only thing that can turn an image block back into the object it
      // belongs to. (`ScummEngine_v8::readGlobalObjects`.)
      this.objectRoom = new Uint8Array(count);
      for (let i = 0; i < count; i++) {
        let name = '';
        for (let c = 0; c < V8_OBJECT_NAME_BYTES; c++) {
          const ch = stream.readU8();
          if (ch !== 0) name += String.fromCharCode(ch);
        }
        this.objectNames.set(name.trim(), i);
        this.objectState[i] = stream.readU8();
        this.objectRoom[i] = stream.readU8();
        this.classData[i] = stream.readU32LE() >>> 0;
      }
      this.objectOwner.fill(OF_OWNER_ROOM_V7);
      return;
    }

    if (this.game.version >= 7) {
      // Three columns, not v6's two, and no owner column at all: a state byte
      // per object, then the room each object lives in, then the class field.
      // ScummVM fills the owner table with 0xFF afterwards, which is why there
      // is nothing to read for it. Take v6's branch here and every object's
      // state is read as its owner and its room as its state.
      // (`ScummEngine_v7::readGlobalObjects`.)
      this.objectRoom = new Uint8Array(count);
      for (let i = 0; i < count; i++) this.objectState[i] = stream.readU8();
      for (let i = 0; i < count; i++) this.objectRoom[i] = stream.readU8();
      for (let i = 0; i < count; i++) this.classData[i] = stream.readU32LE() >>> 0;
      this.objectOwner.fill(OF_OWNER_ROOM_V7);
      return;
    }

    // v5 and v6 agree: every owner/state byte, then every 32-bit class field.
    for (let i = 0; i < count; i++) {
      const packed = stream.readU8();
      this.objectOwner[i] = packed & OF_OWNER_MASK;
      this.objectState[i] = packed >> OF_STATE_SHIFT;
    }
    for (let i = 0; i < count; i++) this.classData[i] = stream.readU32LE() >>> 0;
  }

  /**
   * `AARY`: the script arrays the game wants to exist before anything runs.
   *
   * Four 16-bit fields per entry — variable number, then the two dimensions,
   * then a type — ending at a zero variable number. Type 4 means a bit array
   * and everything else is an integer array, which is the whole of the type
   * information the format carries (`ScummEngine_v6::readArrayFromIndexFile`).
   *
   * Recorded rather than acted on: the script engine that allocates these does
   * not exist yet, and dropping them silently would make an array read return
   * zero from a variable a script had every right to expect.
   */
  private parseArrayDeclarations(stream: ByteStream, end: number): void {
    while (stream.position + 8 <= end) {
      const variable = stream.readU16LE();
      if (variable === 0) break;
      const dim2 = stream.readU16LE();
      const dim1 = stream.readU16LE();
      const type = stream.readU16LE();
      this.arrayDeclarations.push({
        variable,
        dim1,
        dim2,
        kind: type === V6_BIT_ARRAY ? 'bit' : 'int',
      });
    }
  }

  // ------------------------------------------------------------ container --

  /**
   * Walks LECF once to record where each room's LFLF block starts, and reads
   * LOFF for the base offsets the directories are relative to.
   */
  private parseContainer(): void {
    const lecf = readChunkHeader(this.data, 0);
    if (lecf.tag !== 'LECF') {
      throw new Error(describeWrongContainer(lecf.tag, this.game));
    }

    const loff = findChunk(this.data, lecf.dataOffset, 'LOFF', lecf.dataOffset + lecf.dataSize);
    if (loff) {
      const stream = new ByteStream(this.data, loff.dataOffset);
      const count = stream.readU8();
      for (let i = 0; i < count; i++) {
        const room = stream.readU8();
        this.roomBase.set(room, stream.readU32LE());
      }
    }

    // Independently record every LFLF so a missing or damaged LOFF is not fatal
    // and so room resources can be found by structure rather than by offset.
    let roomIndex = 0;
    for (const chunk of iterateChunks(
      this.data,
      lecf.dataOffset,
      lecf.dataOffset + lecf.dataSize,
    )) {
      if (chunk.tag !== 'LFLF') continue;
      const room = findChunk(
        this.data,
        chunk.dataOffset,
        'ROOM',
        chunk.dataOffset + chunk.dataSize,
      );
      const roomNumber = this.roomNumberForOffset(chunk.offset, room?.offset) ?? roomIndex;
      this.roomLflf.set(roomNumber, chunk.offset);
      roomIndex++;
    }
  }

  /** Matches an LFLF back to its LOFF entry by either candidate convention. */
  private roomNumberForOffset(lflfOffset: number, roomOffset?: number): number | undefined {
    for (const [room, base] of this.roomBase) {
      if (base === lflfOffset || base === roomOffset) return room;
    }
    return undefined;
  }

  // ------------------------------------------------------------ resources --

  /**
   * Resolves a resource to a view over the data file, including its 8 byte
   * chunk header (matching what the rest of the engine expects to parse).
   */
  /**
   * The block tag a resource of this type carries.
   *
   * Costumes are the one type whose tag changes with the version: v6 replaced
   * the classic `COST` format with `AKOS` outright. Everything else keeps its
   * tag, which is why this is a single exception rather than a table per
   * version.
   *
   * Getting this wrong does not fail loudly — the lookup falls through to a
   * scan of the room, finds nothing with the tag it wants, and reports the
   * costume as missing. Which reads as "this game has no costumes" rather than
   * "this engine asked for the wrong tag".
   */
  private expectedTags(type: ResourceType): string[] {
    // v4 writes two character tags, and they are not abbreviations of v5's:
    // `SO` is a sound and `SC` a script, where v5 has `SOUN` and `SCRP`.
    if (this.game.version < 5) return [OLD_EXPECTED_TAG[type]];
    // Costumes come in two formats and the *version* does not decide which. It
    // was read as "v6 and later means AKOS", which is wrong by one version:
    // ScummVM sets its new-costume flag in the v7 constructor, so Day of the
    // Tentacle and Sam & Max carry plain `COST` costumes like a v5 game. The
    // fixture built AKOS ones, so every test agreed with the wrong reading and
    // no costume in a real v6 game resolved at all.
    //
    // Both are accepted rather than either being chosen, because a release
    // says which it has and the reader can simply look.
    if (type === 'costume') return ['COST', 'AKOS'];
    return [EXPECTED_TAG[type]];
  }

  /**
   * Every `type:id` a caller asked for and this manager could not resolve.
   *
   * Recorded rather than logged, because the interesting number is the *set*
   * over a whole run: one missing sound is a note and forty of them is a
   * directory read at the wrong width. `getResource` already returns null for
   * all of them and every caller already copes, so nothing here changes what
   * the engine does — it only makes the sweep able to count what it saw.
   */
  readonly unresolved = new Set<string>();

  getResource(type: ResourceType, id: number): Uint8Array | null {
    const found = this.findResource(type, id);
    if (!found) this.unresolved.add(`${type} ${id}`);
    return found;
  }

  private findResource(type: ResourceType, id: number): Uint8Array | null {
    if (type === 'room') return this.getRoom(id);
    // v4 keeps its charsets in their own files rather than in the containers,
    // so there is no directory entry to resolve and nothing to search for.
    if (type === 'charset' && this.oldCharsets.size > 0) {
      return this.oldCharsets.get(id) ?? null;
    }

    const directory = this.directories.get(type);
    const entry = directory?.[id];
    if (!entry || entry.offset === 0xffffffff) return null;

    const base = this.roomBase.get(entry.roomNo);
    if (base === undefined) return null;

    for (const expected of this.expectedTags(type)) {
      const found = this.resolveAt(base + entry.offset, expected);
      if (found) return found;
    }

    // Fall back to structure: scan the room's LFLF for the resource. Slower,
    // but it keeps an unusual release playable instead of crashing.
    for (const expected of this.expectedTags(type)) {
      const found = this.scanLflfFor(entry.roomNo, expected, id, directory!);
      if (found) return found;
    }
    return null;
  }

  /**
   * Reads a chunk header at `offset` and returns the chunk if the tag matches.
   *
   * Releases differ over whether directory offsets are relative to the LFLF
   * header or to the ROOM chunk inside it, an 8 byte difference. The bias is
   * detected once from the first resource that resolves cleanly.
   */
  private resolveAt(offset: number, expectedTag: string): Uint8Array | null {
    const format = this.chunks;
    const header = format.headerSize;
    // v4's own bias is a fixed 8 — six bytes of `LF` header and the two byte
    // room number after it — because its directory offsets are measured from
    // the `RO` block rather than from the container block around it. It is in
    // the trial list rather than special-cased because the trial settles on it
    // at the first resource and then stops trying.
    const biases = this.offsetBias !== null ? [this.offsetBias] : [0, 8, -8];
    for (const bias of biases) {
      const at = offset + bias;
      if (at < 0 || at + header > this.data.length) continue;
      const chunk = format.read(this.data, at);
      if (chunk.tag !== expectedTag) continue;
      if (chunk.size < header || at + chunk.size > this.data.length) continue;
      this.offsetBias = bias;
      return this.volumes.readSync(CONTAINER_VOLUME, at, chunk.size);
    }
    return null;
  }

  /**
   * Last-resort lookup: find the nth chunk of the given tag inside a room's
   * LFLF, where n is this resource's rank among ids stored in the same room.
   */
  private scanLflfFor(
    roomNo: number,
    tag: string,
    id: number,
    directory: DirectoryEntry[],
  ): Uint8Array | null {
    const lflfOffset = this.roomLflf.get(roomNo);
    if (lflfOffset === undefined) return null;
    const lflf = readChunkHeader(this.data, lflfOffset);

    const siblings = directory
      .map((entry, index) => ({ entry, index }))
      .filter((item) => item.entry.roomNo === roomNo)
      .sort((a, b) => a.entry.offset - b.entry.offset);
    const rank = siblings.findIndex((item) => item.index === id);
    if (rank < 0) return null;

    let seen = 0;
    for (const chunk of iterateChunks(
      this.data,
      lflf.dataOffset,
      lflf.dataOffset + lflf.dataSize,
    )) {
      if (chunk.tag !== tag) continue;
      if (seen === rank) return this.volumes.readSync(CONTAINER_VOLUME, chunk.offset, chunk.size);
      seen++;
    }
    return null;
  }

  /** The ROOM chunk for a room number, including its header. */
  getRoom(room: number): Uint8Array | null {
    const lflfOffset = this.roomLflf.get(room) ?? this.roomBase.get(room);
    if (lflfOffset === undefined) return null;

    if (this.game.version < 5) {
      // `LF` is six bytes of header and then the room number as a word, and
      // the `RO` block starts straight after it. Found by structure rather
      // than by that arithmetic, so a release that puts something else in
      // front of it is still read.
      const container = readSmallChunkHeader(this.data, lflfOffset);
      if (container.tag === 'RO') {
        return this.volumes.readSync(CONTAINER_VOLUME, container.offset, container.size);
      }
      if (container.tag !== 'LF') return null;
      const found = findChunk(
        this.data,
        container.dataOffset + 2,
        'RO',
        lflfOffset + container.size,
        SMALL_CHUNKS,
      );
      return found ? this.volumes.readSync(CONTAINER_VOLUME, found.offset, found.size) : null;
    }

    const outer = readChunkHeader(this.data, lflfOffset);
    if (outer.tag === 'ROOM') {
      return this.volumes.readSync(CONTAINER_VOLUME, outer.offset, outer.size);
    }
    if (outer.tag !== 'LFLF') return null;

    const room$ = findChunk(this.data, outer.dataOffset, 'ROOM', outer.dataOffset + outer.dataSize);
    if (!room$) return null;
    return this.volumes.readSync(CONTAINER_VOLUME, room$.offset, room$.size);
  }

  /**
   * The `RMSC` block beside a v8 room's `ROOM`, or null at every other Version.
   *
   * v8 is the only Version that splits a room in two — pictures in `ROOM`,
   * code in `RMSC`, both inside the same `LFLF`. The index has a directory for
   * it (`DRSC`), and this finds it structurally instead, for the reason
   * `getRoom` does: a release that lays its `LFLF` out slightly differently is
   * still read, and an offset that is wrong by a header is not.
   */
  getRoomScripts(room: number): Uint8Array | null {
    if (this.game.version < 8) return null;

    const lflfOffset = this.roomLflf.get(room) ?? this.roomBase.get(room);
    if (lflfOffset === undefined) return null;

    const outer = readChunkHeader(this.data, lflfOffset);
    if (outer.tag !== 'LFLF') return null;

    const found = findChunk(this.data, outer.dataOffset, 'RMSC', outer.dataOffset + outer.dataSize);
    return found ? this.data.subarray(found.offset, found.offset + found.size) : null;
  }

  /**
   * The buffers and tables a `Room` needs beyond its own resource.
   *
   * Empty for every Version before v8, so a caller passes it unconditionally
   * rather than asking the version first — which is the point: the four places
   * that build a `Room` should not each have to learn what v8 does differently.
   */
  roomSources(room: number): { scripts?: Uint8Array; objectNames?: ReadonlyMap<string, number> } {
    if (this.game.version < 8) return {};
    const scripts = this.getRoomScripts(room);
    return {
      ...(scripts ? { scripts } : {}),
      objectNames: this.objectNames,
    };
  }

  getScript(id: number): Uint8Array | null {
    return this.getResource('script', id);
  }

  getCostume(id: number): Uint8Array | null {
    return this.getResource('costume', id);
  }

  getCharset(id: number): Uint8Array | null {
    return this.getResource('charset', id);
  }

  getSound(id: number): Uint8Array | null {
    return this.getResource('sound', id);
  }

  /** Rooms that actually exist in the data file, in ascending order. */
  listRooms(): number[] {
    return [...this.roomLflf.keys()].sort((a, b) => a - b);
  }

  /**
   * Ids of a directory's entries that actually resolve to a resource.
   *
   * A directory has a slot for every id the game was built with, most of them
   * empty, so the raw count is not a list of what exists. Callers that walk the
   * whole game — the importer, mainly — want the ones that are really there.
   */
  listResources(type: ResourceType): number[] {
    const directory = this.directories.get(type);
    if (!directory) return [];

    const ids: number[] = [];
    for (let id = 0; id < directory.length; id++) {
      const entry = directory[id];
      if (!entry || entry.offset === 0xffffffff) continue;
      ids.push(id);
    }
    return ids;
  }

  listScripts(): number[] {
    return this.listResources('script');
  }

  listCostumes(): number[] {
    return this.listResources('costume');
  }

  listSounds(): number[] {
    return this.listResources('sound');
  }

  /** Number of entries in a directory, for bounds checks. */
  count(type: ResourceType): number {
    return this.directories.get(type)?.length ?? 0;
  }
}
