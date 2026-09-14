/**
 * SCI's resource layer: one map over N Volumes, addressed by offset.
 *
 * The third resource layer in this project and the first that cannot hold its
 * data. SCUMM keeps its container in memory and AGI its volumes, both because
 * a script asks for something mid-frame and neither can await; SCI32 cannot,
 * because Phantasmagoria is seven discs (ADR 0021). So this reads through
 * `VolumeReader` and keeps what it has decoded, which is a different bargain:
 * the *decoded* resources of a room are small even when the volumes are not.
 */

import type { DataSource } from '../../resource/DataSource.js';
import { SourceVolumeReader, type VolumeReader } from '../../resource/VolumeReader.js';
import { LoadProgressTracker } from '../../resource/progress.js';
import { atLeast, describeSciVersion, type SciVersion } from '../sciVersion.js';
import {
  compressionFor,
  decompressSci,
  SciCompressionError,
  type SciCompression,
} from './sciCompression.js';
import {
  detectMapVersion,
  isDirectoryMap,
  readSci0Map,
  readSci1Map,
  type SciMapEntry,
  type SciMapVersion,
} from './resourceMap.js';
import type { SciLayout } from './sciDetect.js';
import { sciResourceType, type SciResourceType } from './sciResourceTypes.js';

/** How a resource header is laid out, which is a property of the map's era. */
export type HeaderShape = 'sci0' | 'sci1-late' | 'sci11' | 'sci32';

/**
 * Exported because the packer is this reader's inverse and must agree with it
 * about which shape a map version implies. A second copy of this switch in
 * `packSciGame.ts` is a second place for "SCI1.1's packed size does not carry
 * SCI0's `+ 4`" to be got right, and the two would agree until one of them was
 * edited.
 */
export function headerShapeFor(mapVersion: SciMapVersion): HeaderShape {
  switch (mapVersion) {
    case 'sci0-sci1-early':
    case 'sci1-middle':
    case 'kq5-fm-towns':
      return 'sci0';
    case 'sci1-late':
      return 'sci1-late';
    case 'sci11':
      return 'sci11';
    case 'sci2':
    case 'sci3':
      return 'sci32';
  }
}

/** A resource's own header, as it sits at the front of its bytes in a Volume. */
export interface SciResourceHeader {
  type: SciResourceType | null;
  number: number;
  /** Bytes of compressed body following the header. */
  packed: number;
  /** Bytes the body decompresses to. */
  unpacked: number;
  /** The method number as written, before it is interpreted. */
  method: number;
  /** Bytes the header itself occupies. */
  size: number;
}

/**
 * Reads a resource header.
 *
 * Four shapes, and the differences are small and consequential in the same
 * breath: the packed size at SCI0 through SCI1 late **includes the four bytes
 * of header that follow the id** and SCI1.1's does not, so reading one with the
 * other's rule reads four bytes too many or too few off the end of every
 * compressed body in the game.
 */
export function readSciResourceHeader(bytes: Uint8Array, shape: HeaderShape): SciResourceHeader {
  const u16 = (at: number): number => bytes[at] | (bytes[at + 1] << 8);
  const u32 = (at: number): number =>
    (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;

  if (shape === 'sci0') {
    const id = u16(0);
    return {
      type: sciResourceType(id >> 11),
      number: id & 0x7ff,
      packed: u16(2) - 4,
      unpacked: u16(4),
      method: u16(6),
      size: 8,
    };
  }
  if (shape === 'sci1-late') {
    return {
      type: sciResourceType(bytes[0]),
      number: u16(1),
      packed: u16(3) - 4,
      unpacked: u16(5),
      method: u16(7),
      size: 9,
    };
  }
  if (shape === 'sci11') {
    return {
      type: sciResourceType(bytes[0]),
      number: u16(1),
      packed: u16(3),
      unpacked: u16(5),
      method: u16(7),
      size: 9,
    };
  }
  const packed = u32(3);
  const unpacked = u32(7);
  return {
    type: sciResourceType(bytes[0]),
    number: u16(1),
    packed,
    unpacked,
    // SCI3 writes the field and does not mean it, so the method is derived from
    // whether the sizes differ. ScummVM does the same and says why: the field
    // "exists in the file" and "is ignored". A reader that trusts it decodes
    // uncompressed SCI3 resources through STACpack and gets noise.
    method: u16(11),
    size: 13,
  };
}

/** The largest header any shape has, which is what a read must fetch first. */
const MAX_HEADER = 13;

export interface SciLoadOptions {
  onLog?: (message: string) => void;
  progress?: LoadProgressTracker;
}

/** A resource this reader could not produce, and why. */
export interface SciUnreadable {
  type: SciResourceType;
  number: number;
  reason: string;
}

/**
 * Shorter than this and a uniform resource is plausibly just empty.
 *
 * A heap with no locals and a string table with no strings are both a handful
 * of zero bytes, and refusing those would break games that ship them.
 */
const NOISE_FLOOR = 64;

/** Exported for the test, which is the only caller outside this file. */
export const isOneRepeatedByteForTest = (bytes: Uint8Array): boolean => isOneRepeatedByte(bytes);

function isOneRepeatedByte(bytes: Uint8Array): boolean {
  const first = bytes[0];
  for (const byte of bytes) if (byte !== first) return false;
  return true;
}

export class SciResources {
  readonly layout: SciLayout;
  readonly mapVersion: SciMapVersion;
  /**
   * The Version, which decides what a compression method number means.
   *
   * Mutable, because the probes that narrow it (ADR 0020) read resources — so
   * the reader exists before the Version is known, on the map's bucket, and the
   * probes sharpen it. The only thing the Version changes down here is the
   * meaning of method numbers 1 and 2, which no probe reads.
   */
  version: SciVersion;

  private readonly volumes: VolumeReader;
  private readonly entries = new Map<string, SciMapEntry>();
  private readonly byType = new Map<SciResourceType, number[]>();
  private readonly cache = new Map<string, Uint8Array>();
  private readonly shape: HeaderShape;
  private readonly log: (message: string) => void;
  /**
   * Method numbers already reported, so a game with two hundred resources in a
   * method this project does not know says so once rather than two hundred
   * times.
   */
  private readonly reportedMethods = new Set<number>();

  /** Resources that could not be read, for the sweep and the editor's refusal. */
  readonly unreadable: SciUnreadable[] = [];

  /**
   * The Volume reader itself, for files that are *played* rather than held.
   *
   * A video is not a resource. `CONTEXT.md` is firm that SMUSH is "played by
   * the Engine rather than decoded to a resource", and SEQ, VMD and DUK are the
   * same case: they have no entry in the map, no number, and nothing a Project
   * reconstructs. So they cannot be fetched through `read`, and what they need
   * is the read-by-offset seam (ADR 0021) pointed at a file name instead.
   *
   * Exposed rather than wrapped in a `readVideo` of its own, because the
   * resource layer has no business knowing what a video is.
   */
  get files(): VolumeReader {
    return this.volumes;
  }

  private constructor(
    layout: SciLayout,
    mapVersion: SciMapVersion,
    version: SciVersion,
    volumes: VolumeReader,
    log: (message: string) => void,
  ) {
    this.layout = layout;
    this.mapVersion = mapVersion;
    this.version = version;
    this.volumes = volumes;
    this.shape = headerShapeFor(mapVersion);
    this.log = log;
  }

  static async load(
    source: DataSource,
    layout: SciLayout,
    mapVersion: SciMapVersion,
    version: SciVersion,
    map: Uint8Array,
    options: SciLoadOptions = {},
  ): Promise<SciResources> {
    const log = options.onLog ?? ((): void => undefined);
    const resources = new SciResources(
      layout,
      mapVersion,
      version,
      new SourceVolumeReader(source),
      log,
    );

    const entries = isDirectoryMap(mapVersion)
      ? readSci1Map(map, mapVersion)
      : readSci0Map(map, mapVersion);

    // A release that ships one map per disc carries the map's own number into
    // every entry's volume, because the entry's field is a number within that
    // disc. Ignoring it reads disc two's resources out of disc one.
    const mapNumber = layout.numberedMaps ? volumeNumberOf(layout.mapFile) : 0;

    for (const entry of entries) {
      const volume = layout.numberedMaps ? entry.volume + mapNumber : entry.volume;
      const key = `${entry.type}:${entry.number}`;
      resources.entries.set(key, { ...entry, volume });
      const list = resources.byType.get(entry.type) ?? [];
      list.push(entry.number);
      resources.byType.set(entry.type, list);
    }
    log(
      `Read ${entries.length} resources from ${layout.mapFile} ` +
        `(${mapVersion} map, ${layout.volumes.size} volume${layout.volumes.size === 1 ? '' : 's'})`,
    );

    await resources.loadAlternate(source, log);
    for (const list of resources.byType.values()) list.sort((a, b) => a - b);
    return resources;
  }

  /**
   * The alternate pack's entries, for the types the main map has not got.
   *
   * `ALTRES.MAP` and `ALTRES.000` are a second map and volume in the same two
   * shapes as the first, and Sierra's interpreter opens them by name (see
   * `SciLayout.alternate`). Read here rather than by a caller because the
   * entry table is the thing that has to end up complete: everything above
   * this class asks `read(type, number)` and has no idea, and should have no
   * idea, which file on disc an entry came from.
   *
   * **The main map wins.** Where both packs hold the same type and number, the
   * one this project already read is kept — a release whose main map is
   * complete is read exactly as it was before, so the pack can only ever add
   * resources and never move one. King's Quest VII's main map holds no MESSAGE
   * resource at all, so for that game the two rules agree; the conservative one
   * is chosen because no second release is here to say which Sierra meant.
   *
   * A pack that cannot be read is a log line and not a throw. The main pair is
   * the game; the alternate is an addition, and a release that boots without it
   * should still boot.
   */
  private async loadAlternate(source: DataSource, log: (message: string) => void): Promise<void> {
    const alternate = this.layout.alternate;
    if (!alternate) return;

    const map = await source.read(alternate.mapFile);
    if (!map) {
      log(`${alternate.mapFile} is named by the layout but could not be read, so it is skipped.`);
      return;
    }
    // Detected on its own bytes rather than assumed to match the main map's.
    // The two are separate files and nothing says a release has to write them
    // in the same shape — King's Quest VII writes both as SCI32 directory maps,
    // and that is a measurement rather than a premise.
    const mapVersion = detectMapVersion(map, () => true);
    if (!mapVersion || !isDirectoryMap(mapVersion)) {
      log(`${alternate.mapFile} is not a resource map this reader knows, so it is skipped.`);
      return;
    }

    let added = 0;
    for (const entry of readSci1Map(map, mapVersion)) {
      const key = `${entry.type}:${entry.number}`;
      if (this.entries.has(key)) continue;
      this.entries.set(key, { ...entry, volume: alternate.volume });
      const list = this.byType.get(entry.type) ?? [];
      list.push(entry.number);
      this.byType.set(entry.type, list);
      added++;
    }
    log(
      `Read ${added} more resources from ${alternate.mapFile} ` +
        `(${mapVersion} map), which the main map has not got.`,
    );
  }

  /** Resource numbers of a type, in order. */
  list(type: SciResourceType): number[] {
    return [...(this.byType.get(type) ?? [])];
  }

  count(type: SciResourceType): number {
    return this.byType.get(type)?.length ?? 0;
  }

  has(type: SciResourceType, number: number): boolean {
    return this.entries.has(`${type}:${number}`);
  }

  /** Every type this game actually ships, for the log. */
  types(): SciResourceType[] {
    return [...this.byType.keys()];
  }

  /**
   * Reads one resource, decompressed.
   *
   * Async all the way down, because a SCI32 Volume is not in memory and cannot
   * be. Callers that need a resource synchronously — the PMachine, mid-send —
   * ask for it in advance through `preload`, which is the arrangement ADR 0021
   * pushes onto this family in exchange for a game that fits in a tab.
   */
  async read(type: SciResourceType, number: number): Promise<Uint8Array | null> {
    const key = `${type}:${number}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const entry = this.entries.get(key);
    if (!entry) return null;

    const file = this.layout.volumes.get(entry.volume);
    if (!file) {
      this.refuse(type, number, `volume ${entry.volume} is not present in this install`);
      return null;
    }

    const head = await this.volumes.read(file, entry.offset, MAX_HEADER);
    if (head.length < this.headerSize) {
      this.refuse(type, number, `offset ${entry.offset} is past the end of ${file}`);
      return null;
    }

    const header = readSciResourceHeader(head, this.shape);
    const method =
      this.shape === 'sci32' && this.version === 'sci3'
        ? header.packed !== header.unpacked
          ? 32
          : 0
        : header.method;

    const compression = compressionFor(method, this.version);
    if (!compression) {
      // Loud, by name and number. SCI's characteristic failure is silent, and
      // a resource of the right length made of noise is worse than none.
      if (!this.reportedMethods.has(method)) {
        this.reportedMethods.add(method);
        this.log(
          `Compression method ${method} is not one this engine knows at ` +
            `${describeSciVersion(this.version)}, so ${type} ${number} and anything else ` +
            `stored that way cannot be read. It is not being copied through: ` +
            `compressed bytes read as a resource are noise of the right length.`,
        );
      }
      this.refuse(type, number, `compression method ${method} is unknown`);
      return null;
    }

    const body = await this.volumes.read(file, entry.offset + header.size, header.packed);
    let bytes: Uint8Array;
    try {
      bytes = decompressSci(compression, body, header.unpacked);
    } catch (error) {
      const why = error instanceof SciCompressionError ? error.message : String(error);
      this.refuse(type, number, why);
      return null;
    }

    // **A resource that is one byte repeated is noise, whatever its length.**
    //
    // This layer already refuses a compression method it does not know, on the
    // stated grounds that "compressed bytes read as a resource are noise of the
    // right length". A decoder that *fills* rather than throwing produces the
    // same thing from a method it does know, and nothing downstream can tell:
    // Leisure Suit Larry 1's script 998 came back as 3,894 bytes of `0x0c`, its
    // four classes registered as none, and the game halted three sends later
    // reporting a Selector that "is neither a method nor a property".
    //
    // The floor of 64 bytes is so a legitimately empty resource — a heap with
    // no locals, a zero-length string table — is not refused for being short
    // and uniform.
    if (bytes.length >= NOISE_FLOOR && isOneRepeatedByte(bytes)) {
      this.refuse(
        type,
        number,
        `decompressed to ${bytes.length} bytes of 0x${bytes[0].toString(16).padStart(2, '0')} ` +
          `and nothing else, which is a decoder filling rather than failing`,
      );
      return null;
    }

    this.cache.set(key, bytes);
    return bytes;
  }

  /**
   * Reads several resources and keeps them, so a synchronous caller can have
   * them.
   *
   * The whole of what SCI's streaming costs the layers above: a room's Views
   * and Pictures are asked for at the room change rather than at the blit.
   */
  async preload(wanted: Iterable<[SciResourceType, number]>): Promise<void> {
    for (const [type, number] of wanted) await this.read(type, number);
  }

  /** A resource already read, or null. Never fetches. */
  peek(type: SciResourceType, number: number): Uint8Array | null {
    return this.cache.get(`${type}:${number}`) ?? null;
  }

  /** Every resource of a type, read. For the sweep, the editor and the probes. */
  async readAll(type: SciResourceType): Promise<Map<number, Uint8Array>> {
    const all = new Map<number, Uint8Array>();
    for (const number of this.list(type)) {
      const bytes = await this.read(type, number);
      if (bytes) all.set(number, bytes);
    }
    return all;
  }

  private get headerSize(): number {
    return this.shape === 'sci0' ? 8 : this.shape === 'sci32' ? 13 : 9;
  }

  private refuse(type: SciResourceType, number: number, reason: string): void {
    this.unreadable.push({ type, number, reason });
  }

  /** Counts per type, which is the first thing that says the map read correctly. */
  describeContents(): string {
    const parts = this.types().map((type) => `${this.count(type)} ${type}`);
    return parts.join(', ');
  }

  /** True when this game's Script resources have a heap resource beside them. */
  get hasHeaps(): boolean {
    return this.count('heap') > 0;
  }

  /** True when SCI2's compositor applies rather than the priority buffer. */
  get isSci32(): boolean {
    return atLeast(this.version, 'sci2');
  }

  /**
   * A resource's header and its still-compressed body.
   *
   * For the probes, which need to try decoding the same bytes two ways — and
   * therefore need them before this class has decided which way is right (ADR
   * 0020). Nothing else should want this: a caller that reads a resource wants
   * the resource.
   */
  async readRaw(
    type: SciResourceType,
    number: number,
  ): Promise<{ header: SciResourceHeader; body: Uint8Array } | null> {
    const entry = this.entries.get(`${type}:${number}`);
    if (!entry) return null;
    const file = this.layout.volumes.get(entry.volume);
    if (!file) return null;

    const head = await this.volumes.read(file, entry.offset, MAX_HEADER);
    if (head.length < this.headerSize) return null;
    const header = readSciResourceHeader(head, this.shape);
    const body = await this.volumes.read(file, entry.offset + header.size, header.packed);
    return { header, body };
  }

  /** The method a resource is stored with, without decompressing it. */
  async methodOf(type: SciResourceType, number: number): Promise<SciCompression | null> {
    const entry = this.entries.get(`${type}:${number}`);
    if (!entry) return null;
    const file = this.layout.volumes.get(entry.volume);
    if (!file) return null;
    const head = await this.volumes.read(file, entry.offset, MAX_HEADER);
    if (head.length < this.headerSize) return null;
    return compressionFor(readSciResourceHeader(head, this.shape).method, this.version);
  }
}

/** `RESMAP.003` -> 3. */
function volumeNumberOf(name: string): number {
  const match = /\.(\d{3})$/.exec(name);
  return match ? Number(match[1]) : 0;
}
