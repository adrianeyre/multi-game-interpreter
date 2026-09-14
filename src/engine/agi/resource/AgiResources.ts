/**
 * AGI's resource layer: four index tables over numbered volumes.
 *
 * A sibling of `src/engine/resource/ResourceManager.ts`, not an extension of
 * it. That one walks an `LFLF` chunk tree through an XOR decryption; this one
 * reads a flat table of three-byte entries and seeks into a volume. They share
 * the `DataSource` they read through and nothing else.
 *
 * Both AGI majors are here rather than in two classes, because v3 changes
 * packaging and only packaging: one combined index instead of four files, and
 * volumes whose resources may be compressed. The resource *numbering* either
 * produces is identical, which is what lets one script engine and one renderer
 * sit above this (ADR 0012).
 */

import { readU16LE } from '../../util/ByteStream.js';
import type { DataSource } from '../../resource/DataSource.js';
import { LoadProgressTracker } from '../../resource/progress.js';
import { agiMajor } from '../../../authoring/target.js';
import { AGI_DIR_NAMES, readCombinedDirHeader, type AgiDirName } from './agiDetect.js';
import type { DetectedAgiGame } from './agiDetect.js';
import { lzwDecompress, unpackPicture } from './lzw.js';
import { BufferVolumeReader } from '../../resource/VolumeReader.js';

export const AGI_RESOURCE_TYPES = ['logic', 'picture', 'view', 'sound'] as const;

export type AgiResourceType = (typeof AGI_RESOURCE_TYPES)[number];

/** Resource type to the index that holds it, in the order v3 packs them. */
const DIR_FOR_TYPE: Record<AgiResourceType, AgiDirName> = {
  logic: 'logdir',
  picture: 'picdir',
  view: 'viewdir',
  sound: 'snddir',
};

/** Where one resource lives: a volume number and an offset into it. */
export interface AgiResourceEntry {
  volume: number;
  offset: number;
}

/**
 * Marks a directory slot as holding nothing.
 *
 * Every AGI game's tables are sparse — a game with Logic 0, 1 and 99 has a
 * hundred entries and three resources — so this is the normal case rather than
 * an error, and it is the reason `count` and `list` are separate questions from
 * the table's length.
 */
const ABSENT = 0xffffff;

/** The two bytes every resource in a volume starts with. */
const VOLUME_SIGNATURE = 0x1234;

/**
 * Unpacks one three-byte directory entry.
 *
 * The first byte is `VVVVPPPP`: the volume number in the high nibble and the
 * top four bits of the offset in the low one, then two more bytes of offset.
 * Four bits of volume and twenty of offset, which is where AGI's one-megabyte
 * volume limit comes from.
 */
export function readDirEntry(bytes: Uint8Array, at: number): AgiResourceEntry | null {
  const packed = (bytes[at] << 16) | (bytes[at + 1] << 8) | bytes[at + 2];
  if (packed === ABSENT) return null;
  return {
    volume: bytes[at] >> 4,
    offset: ((bytes[at] & 0x0f) << 16) | (bytes[at + 1] << 8) | bytes[at + 2],
  };
}

/** Parses a whole directory table into entries by resource number. */
export function readDirTable(bytes: Uint8Array): Array<AgiResourceEntry | null> {
  const entries: Array<AgiResourceEntry | null> = [];
  for (let at = 0; at + 2 < bytes.length; at += 3) {
    entries.push(readDirEntry(bytes, at));
  }
  return entries;
}

export interface AgiLoadOptions {
  onLog?: (message: string) => void;
  progress?: LoadProgressTracker;
}

export class AgiResources {
  readonly game: DetectedAgiGame;
  /** The AGI major, derived from the Target's interpreter version (ADR 0012). */
  readonly major: 2 | 3;
  /**
   * The volumes, whole, in memory, behind ADR 0021's read seam.
   *
   * A script asks for a Logic mid-cycle and a room change loads a Picture and
   * several Views synchronously, so the bytes have to be to hand — the same
   * property ADR 0010 kept for SCUMM's container, and the reason this is a
   * `SyncVolumeReader` rather than the plain async one SCI's Volumes use. It
   * costs much less here: a complete AGI game is one to three megabytes, where
   * a v7 SCUMM release is a CD and a SCI32 release is seven of them.
   */
  private readonly volumeBytes = new BufferVolumeReader('AGI volumes');
  /** Volume number to the file it was read from, which is its name in `volumeBytes`. */
  private readonly volumes = new Map<number, string>();
  private readonly tables = new Map<AgiResourceType, Array<AgiResourceEntry | null>>();
  /**
   * Resources already read, keyed by type and number.
   *
   * Decompressing a v3 Logic is real work and a room's scripts are asked for
   * every cycle, so the result is kept. Bounded by the game's own resource
   * count, which is a few hundred entries.
   */
  private readonly cache = new Map<string, Uint8Array>();
  /**
   * Resources that arrived LZW-compressed, which changes how they read.
   *
   * A Logic's messages are obfuscated with "Avis Durgan" only when the
   * resource was stored *uncompressed* — ScummVM's own condition is
   * `~flags & RES_COMPRESSED`, the compression already having obscured them.
   * So the reader above this has to know, and getting it backwards turns every
   * message into noise or every message into gibberish depending on which way.
   */
  private readonly compressed = new Set<string>();

  private constructor(game: DetectedAgiGame) {
    this.game = game;
    this.major =
      game.target.engine === 'agi' ? agiMajor(game.target.interpreter) : game.layout.major;
  }

  static async load(
    source: DataSource,
    game: DetectedAgiGame,
    options: AgiLoadOptions = {},
  ): Promise<AgiResources> {
    const log = options.onLog ?? (() => undefined);
    const progress = options.progress ?? new LoadProgressTracker();
    const resources = new AgiResources(game);

    progress.report('parsing-index', `Reading the AGI v${resources.major} index…`, 0.2);
    await resources.readTables(source, log);

    progress.report('reading-data', 'Reading the AGI volumes…', 0.6);
    for (const [number, name] of game.layout.volumes) {
      const bytes = await source.read(name);
      if (!bytes) {
        throw new Error(
          `The index refers to volume ${number} (${name}) but it could not be ` +
            `read. Make sure the whole game directory was selected.`,
        );
      }
      resources.volumeBytes.set(name, bytes);
      resources.volumes.set(number, name);
    }

    // Every volume the index actually points into has to be present. Checked
    // here rather than at the first read, because the cause is almost always
    // that half a game folder was selected — and finding that out at load is a
    // message about the files, where finding it out mid-play is a message about
    // a resource.
    resources.requireReferencedVolumes();

    // Counts per type, which is what says whether the index was read correctly
    // at all: a misparsed table produces a plausible number of resources at
    // impossible offsets, and the counts are the first place that shows.
    const counts = AGI_RESOURCE_TYPES.map(
      (type) => `${resources.count(type)} ${type}${resources.count(type) === 1 ? '' : 's'}`,
    );
    log(
      `AGI v${resources.major} game "${game.id}": ${counts.join(', ')} across ` +
        `${resources.volumes.size} volume${resources.volumes.size === 1 ? '' : 's'}`,
    );
    log(game.interpreterNote);

    return resources;
  }

  private async readTables(source: DataSource, log: (message: string) => void): Promise<void> {
    const { layout } = this.game;

    if (layout.major === 3) {
      const name = layout.combinedDir!;
      const bytes = await source.read(name);
      if (!bytes) throw new Error(`The AGI v3 index ${name} could not be read.`);

      // Four little-endian 16-bit offsets, then the four tables back to back.
      // Each table's length is the gap to the next offset, and the last runs to
      // the end of the file — so a table's length is never written down and is
      // always the difference between two things that are.
      const offsets = readCombinedDirHeader(bytes);
      for (const [index, dir] of AGI_DIR_NAMES.entries()) {
        const start = offsets[index];
        const end = index + 1 < offsets.length ? offsets[index + 1] : bytes.length;
        if (start > bytes.length || end < start) {
          throw new Error(
            `The AGI v3 index ${name} puts its ${dir} table at ${start}..${end} ` +
              `in a ${bytes.length} byte file, which cannot be right.`,
          );
        }
        this.tables.set(typeForDir(dir), readDirTable(bytes.subarray(start, end)));
      }
      log(`Read the four index tables from the combined ${name}`);
      return;
    }

    for (const dir of AGI_DIR_NAMES) {
      const name = layout.dirFiles.get(dir);
      if (!name) {
        // A game missing one index is a game missing that whole resource type,
        // which is legitimate: some fan-made games ship no sound at all. An
        // empty table says so, where refusing the game would not.
        this.tables.set(typeForDir(dir), []);
        continue;
      }
      const bytes = await source.read(name);
      if (!bytes) throw new Error(`The AGI index ${name} could not be read.`);
      this.tables.set(typeForDir(dir), readDirTable(bytes));
    }
  }

  /**
   * Refuses a game whose index points into a volume it does not ship.
   *
   * A missing volume is not a missing resource: it is a set of files that was
   * only partly selected, and every resource in that volume will fail. Saying
   * so once, by number, beats failing per resource later.
   */
  private requireReferencedVolumes(): void {
    const missing = new Set<number>();
    for (const table of this.tables.values()) {
      for (const entry of table) {
        if (entry && !this.volumes.has(entry.volume)) missing.add(entry.volume);
      }
    }
    if (missing.size === 0) return;

    const wanted = [...missing].sort((a, b) => a - b).join(', ');
    const present = [...this.volumes.keys()].sort((a, b) => a - b).join(', ') || 'none';
    throw new Error(
      `This game's index points into volume ${wanted}, which is not here. ` +
        `Volumes present: ${present}. Make sure the whole game directory was ` +
        `selected rather than some of its files.`,
    );
  }

  /** Resource numbers of this type that the game actually has. */
  list(type: AgiResourceType): number[] {
    const table = this.tables.get(type) ?? [];
    const numbers: number[] = [];
    for (const [number, entry] of table.entries()) if (entry) numbers.push(number);
    return numbers;
  }

  count(type: AgiResourceType): number {
    return this.list(type).length;
  }

  has(type: AgiResourceType, number: number): boolean {
    // A hole in a sparse table reads as `undefined` and an absent entry reads
    // as `null`, and both mean the game has not got this resource.
    const entry = (this.tables.get(type) ?? [])[number];
    return entry !== null && entry !== undefined;
  }

  /** Where the index says a resource is, for diagnostics and for the editor. */
  entry(type: AgiResourceType, number: number): AgiResourceEntry | null {
    return (this.tables.get(type) ?? [])[number] ?? null;
  }

  /**
   * A resource's bytes, decompressed if it was compressed.
   *
   * Synchronous, because a Logic is asked for in the middle of a cycle and a
   * room change wants a Picture and its Views at once. The volumes are already
   * in memory for exactly that reason.
   */
  read(type: AgiResourceType, number: number): Uint8Array {
    const key = `${type}:${number}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const entry = this.entry(type, number);
    if (!entry) {
      throw new Error(
        `${type} ${number} is not in this game's ${DIR_FOR_TYPE[type].toUpperCase()}. ` +
          `It has ${this.count(type)} ${type} resources: ${describeNumbers(this.list(type))}.`,
      );
    }

    const name = this.volumes.get(entry.volume);
    if (name === undefined) {
      throw new Error(
        `${type} ${number} is in volume ${entry.volume}, which this game does ` +
          `not have. Volumes present: ${[...this.volumes.keys()].sort((a, b) => a - b).join(', ')}.`,
      );
    }

    const bytes = this.readFromVolume(name, this.volumeBytes.whole(name), entry, type, number);
    this.cache.set(key, bytes);
    return bytes;
  }

  /**
   * Reads one resource out of a volume, validating its header.
   *
   * The five-byte v2 header is a signature, a volume number and a length; v3's
   * is seven, with a second length and a flag. Both are checked rather than
   * skipped: a wrong offset lands in the middle of the previous resource, where
   * the length field is whatever byte happened to be there — so an unchecked
   * read produces a resource of an arbitrary size that parses to nonsense
   * rather than an error naming the resource (#124).
   */
  private readFromVolume(
    name: string,
    volume: Uint8Array,
    entry: AgiResourceEntry,
    type: AgiResourceType,
    number: number,
  ): Uint8Array {
    const headerSize = this.major === 3 ? 7 : 5;
    const at = entry.offset;

    if (at + headerSize > volume.length) {
      throw new Error(
        `${type} ${number} is at offset ${at} in volume ${entry.volume}, which ` +
          `is only ${volume.length} bytes. The index and the volumes disagree.`,
      );
    }

    const signature = (volume[at] << 8) | volume[at + 1];
    if (signature !== VOLUME_SIGNATURE) {
      throw new Error(
        `${type} ${number} should start with 0x12 0x34 at offset ${at} of volume ` +
          `${entry.volume} and starts with 0x${volume[at].toString(16).padStart(2, '0')} ` +
          `0x${volume[at + 1].toString(16).padStart(2, '0')}. Either the index ` +
          `points at the wrong place or the volume is not the one it names.`,
      );
    }

    // The volume number in the header is a cross-check on the index, and the
    // top bit of it is v3's "this is a Picture" flag rather than part of the
    // number — so it is masked before the two are compared.
    const headerVolume = volume[at + 2] & 0x7f;
    const pictureFlag = (volume[at + 2] & 0x80) !== 0;
    if (headerVolume !== entry.volume) {
      throw new Error(
        `${type} ${number} says it belongs to volume ${headerVolume} but was ` +
          `found in volume ${entry.volume}. The index is pointing into the ` +
          `wrong file.`,
      );
    }

    const length = readU16LE(volume, at + 3);
    const body = at + headerSize;

    if (this.major === 2) {
      if (body + length > volume.length) {
        throw new Error(
          `${type} ${number} claims ${length} bytes from offset ${body} of a ` +
            `${volume.length} byte volume, which runs past the end of it.`,
        );
      }
      return this.volumeBytes.readSync(name, body, length);
    }

    // v3: `length` is the uncompressed size and this second field is the stored
    // size. Equal means stored as-is, which happens per resource rather than
    // per game, so both paths are live in every v3 game.
    const stored = readU16LE(volume, at + 5);
    if (body + stored > volume.length) {
      throw new Error(
        `${type} ${number} claims ${stored} stored bytes from offset ${body} of ` +
          `a ${volume.length} byte volume, which runs past the end of it.`,
      );
    }
    const raw = this.volumeBytes.readSync(name, body, stored);

    if (stored === length) return raw;
    this.compressed.add(`${type}:${number}`);
    // A Picture is nibble-packed, not LZW-compressed, and the only thing that
    // says so is that flag bit — the lengths differ either way, so choosing by
    // length alone would run a Picture through the LZW decoder and get a
    // plausible-looking wrong picture rather than an error.
    if (pictureFlag) return unpackPicture(raw, length);
    return lzwDecompress(raw, length);
  }

  /**
   * Whether this resource was LZW-compressed in the volume it came from.
   *
   * Only a v3 game can answer yes, and only for some of its resources — the
   * flag is per resource, not per game. A Logic's message table is obfuscated
   * when the answer is no and plain when it is yes.
   */
  wasCompressed(type: AgiResourceType, number: number): boolean {
    // Reading it is what records it, so ask for the bytes first.
    if (!this.cache.has(`${type}:${number}`) && this.has(type, number)) {
      this.read(type, number);
    }
    return this.compressed.has(`${type}:${number}`);
  }

  /** Every resource of a type, read. For the disassembler and the editor. */
  readAll(type: AgiResourceType): Map<number, Uint8Array> {
    const all = new Map<number, Uint8Array>();
    for (const number of this.list(type)) all.set(number, this.read(type, number));
    return all;
  }
}

function typeForDir(dir: AgiDirName): AgiResourceType {
  for (const type of AGI_RESOURCE_TYPES) if (DIR_FOR_TYPE[type] === dir) return type;
  throw new Error(`No resource type for ${dir}`);
}

/** "0, 1, 2, 3 and 12 others" — a list a person reads, not 300 numbers. */
function describeNumbers(numbers: number[]): string {
  if (numbers.length === 0) return 'none';
  const shown = numbers.slice(0, 8).join(', ');
  const rest = numbers.length - 8;
  return rest > 0 ? `${shown} and ${rest} others` : shown;
}
