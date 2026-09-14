/**
 * Reading a game's bulk data by offset instead of whole.
 *
 * Decided in ADR 0021. Every family this project supports addresses its data by
 * offset — a SCUMM `LECF` container through `LOFF`, an AGI volume through a
 * three-byte directory entry, a SCI Volume through `RESOURCE.MAP` — and until
 * now every one of them got those offsets by materialising the whole file
 * first. That was correct for what was supported: the README calls Sam & Max's
 * talkie "thirteen megabytes" and treats that as large.
 *
 * SCI32 is not a larger version of that problem. Phantasmagoria shipped on
 * seven discs and Gabriel Knight 2 on six; King's Quest VII, Lighthouse and
 * RAMA run to hundreds of megabytes each, nearly all of it video and audio.
 * Buffering that into `Uint8Array`s in a browser tab does not run slowly, it
 * fails to allocate — so the seam lands before the family that needs it rather
 * than being retrofitted underneath it afterwards.
 *
 * **Nothing here is a cache.** There is no eviction, no budget and no policy;
 * it is one question — *the bytes of this volume, from here, this many* — asked
 * of whatever holds them. A caller that wants to keep what it read keeps it.
 */

import { readRangeFrom, type DataSource } from './DataSource.js';

/**
 * Where a family's resource layer gets bytes.
 *
 * `volume` is a file name rather than a number, because the three families
 * disagree about what a volume is called and agree about nothing else:
 * `MONKEY2.001`, `VOL.3`, `RESOURCE.000`. Passing the name through means this
 * interface never has to know which family is asking.
 *
 * A read that runs past the end of the volume returns what is there rather
 * than throwing, matching `DataSource.readRange`. A volume that is not present
 * at all returns an empty array — the caller's own index said it was there, so
 * an absent volume is a broken install and belongs in that caller's message
 * about its own game, not in an exception from here.
 */
export interface VolumeReader {
  read(volume: string, offset: number, length: number): Promise<Uint8Array>;
  /** For messages: where these volumes came from. */
  readonly label: string;
}

/**
 * A `VolumeReader` whose bytes are already in memory.
 *
 * The distinction is not decoration. A SCUMM script asks for a costume in the
 * middle of a frame and an AGI room change loads a Picture and several Views
 * synchronously; neither can await, and ADR 0010 chose to hold those files
 * whole for exactly that reason. A browser `File` cannot be read synchronously
 * at all, so the two cannot be one type without either making every SCUMM
 * resource read async or pretending a `File` can answer immediately.
 *
 * So the split is honest rather than convenient: families whose data is small
 * enough to hold hold it and get `readSync`; families whose data is not — SCI32
 * — get the async half and arrange to have asked in time.
 */
export interface SyncVolumeReader extends VolumeReader {
  readSync(volume: string, offset: number, length: number): Uint8Array;
}

const EMPTY = new Uint8Array(0);

/**
 * Serves volumes this process already holds.
 *
 * What SCUMM and AGI use. The bytes handed in are the ones each family had
 * anyway — a decrypted `LECF` container, a decompressed AGI volume — so going
 * through here costs a map lookup and changes no behaviour, which is the whole
 * of what this refactor claims for the two existing families.
 */
export class BufferVolumeReader implements SyncVolumeReader {
  readonly label: string;
  private readonly buffers = new Map<string, Uint8Array>();

  constructor(label = 'memory', entries: Iterable<[string, Uint8Array]> = []) {
    this.label = label;
    for (const [name, bytes] of entries) this.set(name, bytes);
  }

  set(volume: string, bytes: Uint8Array): void {
    this.buffers.set(key(volume), bytes);
  }

  has(volume: string): boolean {
    return this.buffers.has(key(volume));
  }

  /**
   * The whole of a volume, for a caller that has to walk it rather than index
   * into it.
   *
   * SCUMM's container is a chunk tree: finding a room means reading a header,
   * following it to a directory and following that to a block, and none of
   * those offsets is known before the one before it is read. A walker like that
   * wants the buffer, not a thousand reads of eight bytes — so it asks for it
   * here, from the same owner that serves the slices, rather than keeping a
   * second reference to the same bytes beside this one.
   */
  whole(volume: string): Uint8Array {
    return this.buffers.get(key(volume)) ?? EMPTY;
  }

  readSync(volume: string, offset: number, length: number): Uint8Array {
    const bytes = this.buffers.get(key(volume));
    if (!bytes) return EMPTY;
    const start = Math.max(0, Math.min(offset, bytes.length));
    return bytes.subarray(start, Math.min(start + Math.max(0, length), bytes.length));
  }

  async read(volume: string, offset: number, length: number): Promise<Uint8Array> {
    return this.readSync(volume, offset, length);
  }
}

/**
 * Serves volumes straight out of a `DataSource`, reading only what is asked
 * for.
 *
 * The browser case is `FileListDataSource`, whose `readRange` is `File.slice`
 * — the file is never materialised, and a seven-disc game costs one slice per
 * resource rather than a failed allocation. The Node case is
 * `FileHandleDataSource` in `src/hosting/openGame.ts`, over an open handle.
 * Both arrive here as the same interface, which is the point of putting the
 * seam on `DataSource` rather than on either of them.
 *
 * `readRangeFrom` falls back to reading whole and slicing for a source that
 * cannot do better, so a caller never asks whether ranges are available. That
 * fallback costs what it always cost; what changes is that the sources which
 * can avoid it now do.
 */
export class SourceVolumeReader implements VolumeReader {
  readonly label: string;
  private readonly source: DataSource;

  constructor(source: DataSource) {
    this.source = source;
    this.label = source.label;
  }

  async read(volume: string, offset: number, length: number): Promise<Uint8Array> {
    const start = Math.max(0, offset);
    const bytes = await readRangeFrom(this.source, volume, start, start + Math.max(0, length));
    return bytes ?? EMPTY;
  }
}

/**
 * Names are matched the way `DataSource` matches them, and for the same reason:
 * SCUMM releases are inconsistent about case and a directory picker gives paths
 * where a script gives base names.
 */
function key(volume: string): string {
  const path = volume
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '')
    .toLowerCase();
  return path.split('/').pop() ?? path;
}
