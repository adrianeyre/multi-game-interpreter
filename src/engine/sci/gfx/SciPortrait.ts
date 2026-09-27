/**
 * King's Quest VI's talking heads: the `.BIN` portrait files `kPortrait` draws.
 *
 * SCI1.1's Windows release of King's Quest VI shows a painted, lip-synced
 * head beside each line of speech. They are not resources: each actor is a
 * loose file, `actors/<name>.bin` or `<name>.bin`, holding its own palette, a
 * base bitmap and the mouth frames drawn over it, and a table that maps a
 * lip-sync ID to a run of frames.
 *
 * Read the way ScummVM's `Portrait::init` reads it (`engines/sci/graphics/
 * portrait.cpp`, fetched 2026-09-27), and returned rather than drawn — the
 * file is the file, and what the engine does with it is the engine's.
 *
 * ```
 * "WIN"  width:u16 height:u16 bitmaps:u16 ?:u16 lipSyncIds:u16 paletteSize:u32
 * palette: paletteSize bytes, BGR
 * bitmaps: 14-byte header (?:u16 width:u16 height:u16 stride:u16 ?:6) + stride*height
 * offsets: size:u32, 14 bytes of nothing, then 14 per bitmap (dx:u16 dy:u16 ...)
 * lip-sync IDs: size:u32, 4 per ID (length:u8 id:3)
 * lip-sync data: size:u32, per ID (ticks:u8 bitmap:u8)* 0xFF
 * ```
 */

export interface SciPortraitBitmap {
  width: number;
  height: number;
  /** Where this bitmap sits relative to the portrait's own origin, in hi-res pixels. */
  displaceX: number;
  displaceY: number;
  /** One byte per pixel, an index into the portrait's own palette. */
  pixels: Uint8Array;
}

export interface SciPortrait {
  width: number;
  height: number;
  /** The portrait's own colours, RGB, in its own index order. */
  palette: Array<[number, number, number]>;
  /** Bitmap 0 is the face; the rest are mouth frames drawn over it. */
  bitmaps: SciPortraitBitmap[];
  /** Lip-sync ID (two characters, packed high byte first) to (ticks, frame) pairs. */
  lipSync: Map<number, Array<{ ticks: number; bitmap: number }>>;
}

/** Reads a portrait file, or null when the bytes are not one. */
export function readSciPortrait(bytes: Uint8Array): SciPortrait | null {
  if (bytes.length < 17 || String.fromCharCode(bytes[0], bytes[1], bytes[2]) !== 'WIN') {
    return null;
  }
  const u16 = (at: number): number => (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
  const u32 = (at: number): number => (u16(at) | (u16(at + 2) << 16)) >>> 0;

  const width = u16(3);
  const height = u16(5);
  const bitmapCount = u16(7);
  const lipSyncIdCount = u16(11);
  // ScummVM reads the palette's size as a word at 13 and skips four bytes,
  // which is what "4 bytes paletteSize" in its own layout note means.
  const paletteSize = u16(13);

  let at = 17;
  const palette: Array<[number, number, number]> = [];
  for (let read = 0; read < paletteSize; read += 3) {
    palette.push([bytes[at + 2] ?? 0, bytes[at + 1] ?? 0, bytes[at] ?? 0]);
    at += 3;
  }

  const bitmaps: SciPortraitBitmap[] = [];
  for (let index = 0; index < bitmapCount; index++) {
    const bitmapWidth = u16(at + 2);
    const bitmapHeight = u16(at + 4);
    const stride = u16(at + 6);
    if (stride < bitmapWidth || at + 14 + stride * bitmapHeight > bytes.length) return null;
    const pixels = new Uint8Array(bitmapWidth * bitmapHeight);
    for (let y = 0; y < bitmapHeight; y++) {
      const from = at + 14 + y * stride;
      pixels.set(bytes.subarray(from, from + bitmapWidth), y * bitmapWidth);
    }
    bitmaps.push({ width: bitmapWidth, height: bitmapHeight, displaceX: 0, displaceY: 0, pixels });
    at += 14 + stride * bitmapHeight;
  }

  // The offset table's first entry is fourteen bytes of nothing, and each
  // bitmap's displacement follows at fourteen-byte strides.
  const offsetTableSize = u32(at);
  at += 4;
  for (let index = 0; index < bitmaps.length; index++) {
    const entry = at + 14 + index * 14;
    bitmaps[index].displaceX = u16(entry);
    bitmaps[index].displaceY = u16(entry + 2);
  }
  at += offsetTableSize;

  const idTableSize = u32(at);
  at += 4;
  const ids: number[] = [];
  for (let index = 0; index < lipSyncIdCount && index * 4 + 3 <= idTableSize; index++) {
    // The length byte is skipped and the ID is the two characters after it.
    ids.push(((bytes[at + index * 4 + 1] ?? 0) << 8) | (bytes[at + index * 4 + 2] ?? 0));
  }
  at += idTableSize;

  const dataSize = u32(at);
  at += 4;
  const lipSync = new Map<number, Array<{ ticks: number; bitmap: number }>>();
  let offset = 0;
  for (const id of ids) {
    const frames: Array<{ ticks: number; bitmap: number }> = [];
    while (offset < dataSize - 1) {
      const ticks = bytes[at + offset] ?? 0xff;
      offset++;
      if (ticks === 0xff) break;
      frames.push({ ticks, bitmap: bytes[at + offset] ?? 0 });
      offset++;
    }
    lipSync.set(id, frames);
  }

  return { width, height, palette, bitmaps, lipSync };
}

/**
 * A `rave` resource: King's Quest VI's lip-sync script for one line.
 *
 * ASCII, space-separated: a tick count, then a two-character lip-sync ID,
 * then a tick count, and so on (`Portrait::raveGetTicks` and `raveGetID`). A
 * count that is not digits reads as nought and leaves the ID to be read from
 * where it stands, which is ScummVM's reading and Sierra's.
 */
export function readSciRave(bytes: Uint8Array): Array<{ ticks: number; id: number }> {
  const out: Array<{ ticks: number; id: number }> = [];
  let at = 0;
  while (at < bytes.length) {
    // The ticks, up to a space; a non-digit means "no ticks, an ID is here".
    let ticks = 0;
    let scan = at;
    let numeric = true;
    while (scan < bytes.length) {
      const byte = bytes[scan++];
      if (byte === 0x20) break;
      if (byte >= 0x30 && byte <= 0x39) ticks = ticks * 10 + (byte - 0x30);
      else {
        numeric = false;
        break;
      }
    }
    if (numeric) at = scan;
    else ticks = 0;
    // The ID: its first character in the high byte and the rest or'd low.
    let id = 0;
    while (at < bytes.length) {
      const byte = bytes[at++];
      if (byte === 0x20) break;
      id = id === 0 ? byte << 8 : id | byte;
    }
    out.push({ ticks, id });
  }
  return out;
}

/**
 * When each mouth frame shows during a line, in ticks of the line's audio.
 *
 * `Portrait::doit`'s loop, unrolled: each rave step moves the line's clock on
 * by its ticks, and its lip-sync ID's frames follow from there — each frame's
 * own count less one ("1 means wait nought") — without moving the line's
 * clock, which is how ScummVM keeps them. Bitmap numbers in the data count
 * from one; these count from nought, and one that is not in the portrait is
 * dropped, as ScummVM warns and skips it.
 */
export function sciPortraitSchedule(
  portrait: SciPortrait,
  rave: ReadonlyArray<{ ticks: number; id: number }>,
): Array<{ at: number; bitmap: number }> {
  const schedule: Array<{ at: number; bitmap: number }> = [];
  let timer = 0;
  for (const step of rave) {
    timer += step.ticks;
    const frames = step.id ? portrait.lipSync.get(step.id) : undefined;
    if (!frames) continue;
    let within = timer;
    for (const frame of frames) {
      within += frame.ticks ? frame.ticks - 1 : 0;
      const bitmap = frame.bitmap - 1;
      if (bitmap >= 0 && bitmap < portrait.bitmaps.length) schedule.push({ at: within, bitmap });
    }
  }
  return schedule;
}
