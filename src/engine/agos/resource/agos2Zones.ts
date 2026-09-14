/**
 * The AGOS 2 graphics packaging.
 *
 * The third layout, after the packed archive and the loose numbered files (ADR
 * 0030 gives each a reader rather than teaching one to be all three). The
 * Feeble Files and the Puzzle Pack keep every graphics resource in one large
 * `graphics.vga`, addressed through a separate index file, and **zlib-deflated
 * where deflating helped**.
 *
 * Two details decide whether this reads a game or garbage:
 *
 * - The index entry is four little-endian words, in the order **offset,
 *   uncompressed size, compressed size, file** — not the offset/size/size order
 *   a reader would guess, and swapping the two sizes produces a decompression
 *   that fails on a good file.
 * - **Entries are twelve bytes apart and sixteen bytes long**, so consecutive
 *   entries overlap by a word: an entry's `file` is the next entry's `offset`.
 *   That is what the reference does rather than a misreading of it, and the
 *   field is unused on the platforms in scope — but a reader that strides by
 *   sixteen is reading every entry after the first from the wrong place.
 * - A resource whose two sizes are **equal is not compressed**. There is no
 *   flag; the equality is the flag. Feeding such a resource to an inflater
 *   fails on data that is perfectly good.
 *
 * The entry for a zone's resource is at `zone * 3 + type`, where type 1 is the
 * scripts and 2 the pixels — the same pairing as the packed layout, spaced
 * three apart rather than two because AGOS 2 has a third resource kind.
 */

import type { DataSource } from '../../resource/DataSource.js';
import type { ZoneResources, ZoneSource } from './zoneSource.js';

/** One entry in the index: where a resource is and how big it is both ways. */
export interface Agos2Entry {
  readonly offset: number;
  readonly uncompressedSize: number;
  readonly compressedSize: number;
  readonly file: number;
}

const ENTRY_BYTES = 12;

function readU32LE(data: Uint8Array, at: number): number {
  return (
    (data[at] ?? 0) +
    (data[at + 1] ?? 0) * 0x100 +
    (data[at + 2] ?? 0) * 0x10000 +
    (data[at + 3] ?? 0) * 0x1000000
  );
}

/** Reads one entry, or null when the index does not reach that far. */
export function readAgos2Entry(index: Uint8Array, number: number): Agos2Entry | null {
  const at = number * ENTRY_BYTES;
  // Twelve to step, sixteen to read: the last word overlaps the next entry.
  if (at + ENTRY_BYTES > index.length) return null;
  return {
    offset: readU32LE(index, at),
    uncompressedSize: readU32LE(index, at + 4),
    compressedSize: readU32LE(index, at + 8),
    file: readU32LE(index, at + 12),
  };
}

/**
 * Inflates a resource, or returns it as it is.
 *
 * Equal sizes mean stored rather than deflated — there is no flag, the equality
 * is the flag — so an inflater is only reached where one is wanted. Uses the
 * platform's own `DecompressionStream`, which both the browser and Node have,
 * rather than carrying an inflater this project would have to maintain.
 */
export async function inflateAgos2(
  data: Uint8Array,
  entry: Agos2Entry,
): Promise<Uint8Array | null> {
  const slice = data.subarray(entry.offset, entry.offset + entry.compressedSize);
  if (entry.compressedSize === entry.uncompressedSize) return slice;
  if (typeof DecompressionStream === 'undefined') return null;

  // A copy, because a Blob wants a buffer of its own rather than a view into
  // one that may be shared.
  const stream = new Blob([slice.slice()]).stream().pipeThrough(new DecompressionStream('deflate'));
  const inflated = new Uint8Array(await new Response(stream).arrayBuffer());
  // A size that disagrees with the index means the entry and the data are not
  // describing the same resource, which is worth failing on rather than
  // returning a short buffer that reads as a truncated image.
  if (inflated.length !== entry.uncompressedSize) return null;
  return inflated;
}

function baseName(name: string): string {
  return (name.replace(/\\/g, '/').split('/').pop() ?? name).toLowerCase();
}

/**
 * Reads every zone out of an AGOS 2 install, ahead of time.
 *
 * Ahead of time for the reason the other layouts are: rendering happens inside
 * a frame, and inflating cannot happen there. The cost is bounded because a
 * zone is only read if its index entry says it exists.
 */
export async function readAgos2Zones(
  source: DataSource,
  maxZones = 512,
): Promise<ZoneSource | null> {
  const names = source.list();
  const indexName = names.find(
    (name) => baseName(name) === 'graphics.vga.idx' || baseName(name) === 'gfxindex.dat',
  );
  const dataName = names.find((name) => baseName(name) === 'graphics.vga');
  if (!indexName || !dataName) return null;

  const index = await source.read(indexName);
  const data = await source.read(dataName);
  if (!index || !data) return null;

  const zones = new Map<number, ZoneResources>();
  for (let zone = 0; zone < maxZones; zone += 1) {
    const scriptsEntry = readAgos2Entry(index, zone * 3 + 1);
    const pixelsEntry = readAgos2Entry(index, zone * 3 + 2);
    if (!scriptsEntry || !pixelsEntry) break;
    if (scriptsEntry.uncompressedSize === 0 || pixelsEntry.uncompressedSize === 0) continue;

    const scripts = await inflateAgos2(data, scriptsEntry);
    const pixels = await inflateAgos2(data, pixelsEntry);
    // A zone missing either half is dropped rather than half-loaded, as in the
    // loose layout: the engine should see "no such zone", not a broken one.
    if (scripts && pixels) zones.set(zone, { scripts, pixels });
  }

  if (zones.size === 0) return null;
  return {
    layout: 'agos2',
    zone: (number) => zones.get(number),
  };
}
