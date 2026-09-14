/**
 * `RESOURCE.MAP`: one walker with a per-Version shape, not four readers.
 *
 * ADR 0016's reading of the family holds up in the map more clearly than
 * anywhere else. There are two *structures* — SCI0's flat list and SCI1's type
 * directory — and everything else is a field width or a bit position moving.
 * Writing four readers would put four copies of "a resource is a number, a
 * volume and an offset" in the project and let them drift.
 *
 * Every layout here is transcribed from ScummVM's `readResourceMapSCI0`,
 * `readResourceMapSCI1` and `detectMapVersion`
 * (`engines/sci/resource/resource.cpp`), and then checked against real maps
 * from the freely distributed Sierra demos — which is the order
 * `docs/processes/verifying-version-support.md` asks for, since a fixture
 * written from our own reading proves only that we are consistent.
 */

import { sciResourceType, type SciResourceType } from './sciResourceTypes.js';

/**
 * The map structures this project can tell apart.
 *
 * Deliberately fewer names than there are Versions: the map's own structure
 * separates SCI0/SCI1-early, SCI1-middle, SCI1-late, SCI1.1 and SCI32 and **no
 * further**. Everything finer is ADR 0020's probes over the game's own
 * resources, and pretending otherwise here is how a Version gets asserted from
 * evidence that cannot carry it.
 */
export type SciMapVersion =
  'sci0-sci1-early' | 'sci1-middle' | 'kq5-fm-towns' | 'sci1-late' | 'sci11' | 'sci2' | 'sci3';

/** Where one resource lives. */
export interface SciMapEntry {
  type: SciResourceType;
  number: number;
  /** Volume number; the file name is resolved by the layout. */
  volume: number;
  offset: number;
}

const SCI0_ENTRY = 6;
const SCI1_ENTRY = 6;
const SCI11_ENTRY = 5;
const KQ5FMT_ENTRY = 7;

function u16(bytes: Uint8Array, at: number): number {
  return bytes[at] | (bytes[at + 1] << 8);
}

function u32(bytes: Uint8Array, at: number): number {
  return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
}

/**
 * Reads the flat map: SCI0, SCI01 and early SCI1.
 *
 * Six bytes an entry — a packed id and a packed offset — terminated by six
 * bytes of `0xff`. The whole of the Version difference is where the volume
 * number sits inside the offset word: the top six bits up to SCI1 early, the
 * top four from SCI1 middle. The two readings disagree about the volume for
 * every resource in the game and agree about the offset for none of them, and
 * neither produces an error — the file simply resolves to the wrong place.
 *
 * `kq5-fm-towns` is the same map with the type lifted out into a byte of its
 * own, which is why it is here rather than in a reader of its own.
 */
export function readSci0Map(map: Uint8Array, version: SciMapVersion): SciMapEntry[] {
  const wide = version === 'sci1-middle';
  const shift = wide ? 28 : 26;
  const offsetMask = wide ? 0x0fffffff : 0x03ffffff;
  const width = version === 'kq5-fm-towns' ? KQ5FMT_ENTRY : SCI0_ENTRY;

  const entries: SciMapEntry[] = [];
  for (let at = 0; at + width <= map.length; at += width) {
    let type: SciResourceType | null;
    let number: number;
    let offset: number;

    if (version === 'kq5-fm-towns') {
      type = sciResourceType(map[at]);
      number = u16(map, at + 1);
      offset = u32(map, at + 3);
    } else {
      const id = u16(map, at);
      offset = u32(map, at + 2);
      type = sciResourceType(id >> 11);
      number = id & 0x7ff;
    }

    // Six bytes of 0xff. Checked on the offset word rather than on the whole
    // entry because that is the field ScummVM terminates on, and an id of
    // 0xffff is a legal-looking type 31 that this reader would otherwise
    // report as unknown at the end of every single game.
    if (offset === 0xffffffff) break;
    if (!type) continue;

    entries.push({ type, number, volume: offset >>> shift, offset: offset & offsetMask });
  }
  return entries;
}

/**
 * Reads the two-tier map: SCI1 late, SCI1.1 and SCI32.
 *
 * A directory of 3-byte records at the front — a type byte and the offset its
 * entries start at — then a block of entries per type. Sizes are back-computed
 * from the gap to the next directory offset, which is why the terminator
 * record has to point at the end of the file: it is what gives the last type
 * its length.
 *
 * The entry is where the Versions differ. SCI1.1's is five bytes with a 24-bit
 * offset that is then **doubled**, because SCI1.1 volumes are word-aligned;
 * SCI1 late's is six with the volume in the top nibble of a 32-bit field; and
 * SCI32's is six with no volume nibble at all, because a SCI32 map belongs to
 * one volume by its own file name.
 */
export function readSci1Map(map: Uint8Array, version: SciMapVersion): SciMapEntry[] {
  const width = version === 'sci11' ? SCI11_ENTRY : SCI1_ENTRY;
  const directory: Array<{ type: SciResourceType | null; offset: number }> = [];

  let at = 0;
  for (;;) {
    if (at + 3 > map.length) {
      throw new Error('The resource map ends inside its own type directory.');
    }
    const raw = map[at];
    const offset = u16(map, at + 1);
    at += 3;
    if ((raw & 0x1f) === 0x1f) {
      directory.push({ type: null, offset });
      break;
    }
    directory.push({ type: sciResourceType(raw & 0x1f), offset });
  }

  const entries: SciMapEntry[] = [];
  for (let i = 0; i < directory.length - 1; i++) {
    const { type, offset } = directory[i];
    const end = directory[i + 1].offset;
    if (!type) continue;
    for (let entry = offset; entry + width <= end && entry + width <= map.length; entry += width) {
      const number = u16(map, entry);
      let volume = 0;
      let position: number;

      if (version === 'sci11') {
        position = (map[entry + 2] | (map[entry + 3] << 8) | (map[entry + 4] << 16)) * 2;
      } else if (version === 'sci2' || version === 'sci3') {
        position = u32(map, entry + 2);
      } else {
        const packed = u32(map, entry + 2);
        volume = packed >>> 28;
        position = packed & 0x0fffffff;
      }

      entries.push({ type, number, volume, offset: position });
    }
  }
  return entries;
}

/** True for the map structures `readSci1Map` reads. */
export function isDirectoryMap(version: SciMapVersion): boolean {
  return version === 'sci1-late' || version === 'sci11' || version === 'sci2' || version === 'sci3';
}

/**
 * Which structure a map is in, from the map's own bytes.
 *
 * `volumeExists` answers whether a volume number is one the game actually
 * ships, and it is what separates SCI0/SCI1-early from SCI1-middle: the two
 * readings of the offset word are both well-formed, and the only thing that
 * says which is right is that one of them names volumes that are not there.
 * That is ADR 0020's whole method in miniature — structural evidence, not a
 * table of known releases.
 *
 * Returns null rather than guessing. A caller that cannot identify a map has
 * something that is not a SCI map, and saying so is more use than a Version.
 */
export function detectMapVersion(
  map: Uint8Array,
  volumeExists: (volume: number) => boolean,
): SciMapVersion | null {
  if (map.length < 6) return null;

  // SCI0 and SCI01 maps end in six bytes of 0xff; the FM-Towns variant ends in
  // seven, because its entries are a byte wider.
  if (u32(map, map.length - 4) === 0xffffffff) {
    if (
      map.length >= 7 &&
      map[map.length - 5] === 0xff &&
      map[map.length - 6] === 0xff &&
      map[map.length - 7] === 0xff
    ) {
      return 'kq5-fm-towns';
    }

    for (let at = 0; at + 6 <= map.length - 6; at += 6) {
      const offset = u32(map, at + 2);
      if (!volumeExists(offset >>> 26)) return 'sci1-middle';
    }
    return 'sci0-sci1-early';
  }

  // A directory map: 3-byte records, the last with type 0xff pointing at the
  // end of the file. The entry width falls out of the gaps between directory
  // offsets — divisible by six and not five is SCI1 late or SCI32, five and
  // not six is SCI1.1.
  let at = 0;
  let previousType = -1;
  let previousOffset = 0;
  let sci32 = false;
  let width = 0;

  for (;;) {
    if (at + 3 > map.length) return null;
    const type = map[at];
    const offset = u16(map, at + 1);
    at += 3;

    // SCI1 late ORs 0x80 into every directory type; SCI32 does not, which is
    // the only structural difference between the two maps.
    if (type !== 0xff && type < 0x80) sci32 = true;

    if (previousType !== -1) {
      const gap = offset - previousOffset;
      if (gap < 0 || offset > map.length) return null;
      if (gap > 0) {
        const bySix = gap % 6 === 0;
        const byFive = gap % 5 === 0;
        if (bySix && !byFive) width = width === 5 ? 0 : 6;
        else if (byFive && !bySix) width = width === 6 ? 0 : 5;
      }
    }

    previousType = type;
    previousOffset = offset;

    if (type === 0xff) {
      if (offset !== map.length) return null;
      break;
    }
  }

  if (sci32) return 'sci2';
  if (width === 5) return 'sci11';
  if (width === 6) return 'sci1-late';
  // Ambiguous widths happen when every gap is divisible by thirty. SCI1.1 is
  // the more common of the two by a wide margin, and the probes narrow it
  // afterwards on evidence that is not a coincidence about a multiple.
  return 'sci11';
}
