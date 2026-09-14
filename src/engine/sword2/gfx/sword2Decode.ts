/**
 * Broken Sword II's two sprite compressions, and its parallax layout.
 *
 * Pure functions, like `swordDecode.ts` and for the same reasons: the editor
 * needs them without the engine, and the tests need them without either.
 *
 * ## Both schemes are the same shape
 *
 * RLE256 and RLE16 are **alternating flat and raw blocks**, each introduced by
 * a length byte, with neither block optional and a zero length meaning "no
 * block of that kind here". That pairing never varies, which is what makes the
 * decoders short and what makes a misread length unrecoverable — there is no
 * resynchronisation point.
 *
 * They differ in one thing: RLE16's *raw* block holds **two pixels per byte**,
 * each nibble an index into a sixteen-entry colour table that sits between the
 * animation's CDT entries and its frames. Its flat block does not — a flat run
 * is one byte for the whole run either way.
 *
 * The nibble order is high-then-low on the PC and low-then-high on the
 * PlayStation, which is why `highNibbleFirst` is a parameter rather than a
 * constant: getting it wrong produces a sprite that is recognisable and wrong,
 * with every pair of pixels swapped.
 *
 * ## Why the decoders report rather than throw
 *
 * The original returns 1 for "overran the buffer" and 0 for "fine", and the
 * caller *keeps going* with whatever was decoded. That is kept: a frame that
 * decodes partly is better than a frame that does not draw, and the caller is
 * told so it can say something on the status line.
 */

/** How a decode finished. */
export interface Sword2DecodeResult {
  /** True when the whole buffer was filled without overrunning. */
  readonly ok: boolean;
  /** Bytes written, which is how much of the frame is real. */
  readonly written: number;
}

/**
 * RLE256: alternating flat and raw blocks of whole bytes.
 *
 * The loop is unbounded in the original and ends when the destination is full;
 * a source-length guard is added here, because a truncated resource would
 * otherwise read past its own slice into the next one.
 */
export function decompressRLE256(
  src: Uint8Array,
  dst: Uint8Array,
  decompSize = dst.length,
): Sword2DecodeResult {
  const end = Math.min(decompSize, dst.length);
  let at = 0;
  let to = 0;

  for (;;) {
    if (at >= src.length) return { ok: to === end, written: to };

    // A flat block: a length, then the colour to repeat.
    let header = src[at++];
    if (header) {
      if (to + header > end) return { ok: false, written: to };
      dst.fill(src[at++] ?? 0, to, to + header);
      to += header;
      if (to === end) return { ok: true, written: to };
    }

    if (at >= src.length) return { ok: to === end, written: to };

    // A raw block: a length, then that many pixels.
    header = src[at++];
    if (header) {
      if (to + header > end) return { ok: false, written: to };
      dst.set(src.subarray(at, at + header), to);
      at += header;
      to += header;
      if (to === end) return { ok: true, written: to };
    }
  }
}

/**
 * Expands a raw RLE16 block: two pixels a byte, through a colour table.
 *
 * `blockSize` is a count of **pixels**, not of bytes, which is the trap. An
 * odd count's final byte contributes one pixel from its first nibble only.
 */
export function unwindRaw16(
  dst: Uint8Array,
  to: number,
  src: Uint8Array,
  at: number,
  blockSize: number,
  colourTable: Uint8Array,
  highNibbleFirst = true,
): void {
  let remaining = blockSize;
  let source = at;
  let target = to;
  while (remaining > 1) {
    const byte = src[source++] ?? 0;
    const high = colourTable[byte >> 4] ?? 0;
    const low = colourTable[byte & 0x0f] ?? 0;
    if (highNibbleFirst) {
      dst[target++] = high;
      dst[target++] = low;
    } else {
      dst[target++] = low;
      dst[target++] = high;
    }
    remaining -= 2;
  }
  if (remaining) {
    // The odd final pixel always comes from the high nibble, on both platforms.
    dst[target] = colourTable[(src[source] ?? 0) >> 4] ?? 0;
  }
}

/** RLE16: as RLE256, but raw blocks are nibble pairs through a colour table. */
export function decompressRLE16(
  src: Uint8Array,
  dst: Uint8Array,
  colourTable: Uint8Array,
  decompSize = dst.length,
  highNibbleFirst = true,
): Sword2DecodeResult {
  const end = Math.min(decompSize, dst.length);
  let at = 0;
  let to = 0;

  for (;;) {
    if (at >= src.length) return { ok: to >= end, written: to };

    let header = src[at++];
    if (header) {
      if (to + header > end) return { ok: false, written: to };
      dst.fill(src[at++] ?? 0, to, to + header);
      to += header;
      if (to === end) return { ok: true, written: to };
    }

    if (at >= src.length) return { ok: to >= end, written: to };

    header = src[at++];
    if (header) {
      if (to + header > end) return { ok: false, written: to };
      unwindRaw16(dst, to, src, at, header, colourTable, highNibbleFirst);
      to += header;
      // Pixels, so bytes is half of them rounded up.
      at += (header + 1) >> 1;
      if (to >= end) return { ok: true, written: to };
    }
  }
}

/**
 * Decodes one frame into a `width * height` buffer.
 *
 * Zero is transparent throughout this family, so the buffer starts cleared and
 * a partial decode leaves transparency rather than stale pixels.
 */
export function decodeSword2Frame(
  data: Uint8Array,
  compression: number,
  width: number,
  height: number,
  colourTable?: Uint8Array,
  highNibbleFirst = true,
): { pixels: Uint8Array; ok: boolean } {
  const pixels = new Uint8Array(width * height);
  if (compression === 0) {
    pixels.set(data.subarray(0, Math.min(data.length, pixels.length)));
    return { pixels, ok: data.length >= pixels.length };
  }
  if (compression === 2) {
    if (!colourTable) return { pixels, ok: false };
    const result = decompressRLE16(data, pixels, colourTable, pixels.length, highNibbleFirst);
    return { pixels, ok: result.ok };
  }
  const result = decompressRLE256(data, pixels, pixels.length);
  return { pixels, ok: result.ok };
}

/**
 * A parallax layer: a size, one offset per **row**, then per-row packets.
 *
 * ```text
 * uint16   w
 * uint16   h
 * uint32[] rowOffset    h of them, from the layer's own start; 0 is an empty row
 * …                     per row: uint16 packets, uint16 x, then the packets
 * ```
 *
 * `initializeBackgroundLayer` (`render.cpp:465-533`) is the whole format. A row
 * with `packets == 0` is `w` raw bytes; otherwise the packets alternate,
 * starting with a literal — a count byte and that many pixels — and then a
 * count of transparent pixels to skip. A zero-length literal is how a row that
 * begins with a gap starts on the skip instead.
 *
 * This is per row and Sword1's is per sixteen-pixel column strip. Reading one
 * with the other's layout is not a near miss: the row offsets are read as strip
 * offsets, land in the middle of packet data, and the layer decodes to
 * horizontal noise that still fills the screen — which is why the probe's
 * screenshots looked like a picture that had merely gone wrong rather than like
 * a format that was never right.
 *
 * Decoded here, once, rather than at every blit: the original does the same,
 * unpacking a layer into a chunk at initialisation and cutting it into blocks.
 */
export interface Sword2Parallax {
  readonly width: number;
  readonly height: number;
  /** `width * height` palette indices, where 0 is transparent. */
  readonly pixels: Uint8Array;
}

export function parseSword2Parallax(bytes: Uint8Array, at = 0): Sword2Parallax | null {
  if (at + 4 > bytes.length) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint16(at, true);
  const height = view.getUint16(at + 2, true);
  if (width === 0 || height === 0) return null;
  if (at + 4 + height * 4 > bytes.length) return null;

  const pixels = new Uint8Array(width * height);
  for (let row = 0; row < height; row++) {
    const rowOffset = view.getUint32(at + 4 + row * 4, true);
    // A row nothing was drawn on. `continue`, not `break`: the gaps are
    // interior, and a foreground parallax is mostly gaps.
    if (rowOffset === 0) continue;
    let from = at + rowOffset;
    if (from + 4 > bytes.length) break;
    const packets = view.getUint16(from, true);
    let column = view.getUint16(from + 2, true);
    from += 4;
    const to = row * width;

    if (packets === 0) {
      if (from + width > bytes.length) break;
      pixels.set(bytes.subarray(from, from + width), to);
      continue;
    }

    let zeros = false;
    for (let packet = 0; packet < packets && from < bytes.length; packet++) {
      if (zeros) {
        column += bytes[from++];
        zeros = false;
      } else if (bytes[from] === 0) {
        from++;
        zeros = true;
      } else {
        const count = bytes[from++];
        const run = Math.min(count, width - column, bytes.length - from);
        if (run > 0) pixels.set(bytes.subarray(from, from + run), to + column);
        from += count;
        column += count;
        zeros = true;
      }
    }
  }
  return { width, height, pixels };
}
