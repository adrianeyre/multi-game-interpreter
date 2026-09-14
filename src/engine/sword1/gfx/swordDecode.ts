/**
 * Broken Sword's four sprite compressions, and its parallax layout.
 *
 * ## Which decoder, and how a frame says so
 *
 * A frame header's four-byte `runTimeComp` tag is the selector, and the test is
 * on individual *characters* rather than on the whole tag — which looks sloppy
 * and is exactly right, because the tag is `"RLE7"`, `"RLE0"` or `"BIN0"`-ish
 * and Revolution changed the prefix between builds:
 *
 * - `runTimeComp[3] === '7'` -> RLE7. The common one.
 * - `runTimeComp[3] === '0'` -> RLE0. Transparency-run encoded.
 * - `runTimeComp[1] === 'I'` -> "Tony", the later scheme (`"BIN?"` / `"xIx"`).
 * - anything else -> the frame is raw pixels.
 * - the PlayStation conversion -> HIF, regardless of the tag.
 *
 * Testing the whole tag instead is the bug that reads a shipped sprite as raw
 * pixels: it draws, at the right size, as noise.
 *
 * ## Why these are pure functions
 *
 * The editor needs them without the engine — a sprite surface decodes a frame
 * to show it — and the tests need them without either. So nothing here touches
 * a resource manager, a palette or a screen: bytes in, pixels out. The same
 * split `skyGraphic.ts` and `lureDecode.ts` have.
 */

/** Raised when compressed data runs off its buffer, which means a wrong decoder. */
export class SwordDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SwordDecodeError';
  }
}

/**
 * RLE7: a byte over 127, or zero, is a literal; anything else is a run length.
 *
 * The asymmetry is the point and it is easy to get wrong. `code === 0` is a
 * *literal zero* — a transparent pixel — not a zero-length run, and treating it
 * as a run consumes a byte that belongs to the next code and desynchronises the
 * rest of the frame. `code` in 1..127 means `code + 1` copies of the next byte,
 * so the shortest run is two.
 *
 * The name is the encoding's: seven bits of run length.
 */
export function decompressRLE7(src: Uint8Array, compSize: number, out: Uint8Array): number {
  const end = Math.min(compSize, src.length);
  let at = 0;
  let to = 0;
  while (at < end) {
    const code = src[at++];
    if (code > 127 || code === 0) {
      if (to >= out.length) throw new SwordDecodeError('RLE7 data overruns the frame buffer');
      out[to++] = code;
      continue;
    }
    const run = code + 1;
    const value = src[at++] ?? 0;
    if (to + run > out.length) throw new SwordDecodeError('an RLE7 run overruns the frame buffer');
    out.fill(value, to, to + run);
    to += run;
  }
  return to;
}

/**
 * RLE0: a non-zero byte is a literal, zero introduces a run of transparency.
 *
 * The mirror image of RLE7 — this one compresses the *background* rather than
 * flat colour, which is what a sprite on a transparent field mostly is.
 */
export function decompressRLE0(src: Uint8Array, compSize: number, out: Uint8Array): number {
  const end = Math.min(compSize, src.length);
  let at = 0;
  let to = 0;
  while (at < end) {
    const colour = src[at++];
    if (colour !== 0) {
      if (to >= out.length) throw new SwordDecodeError('RLE0 data overruns the frame buffer');
      out[to++] = colour;
      continue;
    }
    const skip = src[at++] ?? 0;
    if (to + skip > out.length)
      throw new SwordDecodeError('an RLE0 skip overruns the frame buffer');
    out.fill(0, to, to + skip);
    to += skip;
  }
  return to;
}

/**
 * "Tony": alternating flat runs and literal blocks, neither optional.
 *
 * Each pair is a run count with its colour, then a literal count with its
 * bytes. A zero run count means "no flat part here", and the literal part is
 * read anyway — the pair structure never varies, which is what makes this one
 * cheap to decode and impossible to resynchronise if a count is misread.
 *
 * ScummVM calls it after the compressed data by the person who wrote it; the
 * name is kept because a reader matching this against `screen.cpp` needs it.
 */
export function decompressTony(src: Uint8Array, compSize: number, out: Uint8Array): number {
  const end = Math.min(compSize, src.length);
  let at = 0;
  let to = 0;
  while (at < end) {
    const flat = src[at++];
    if (flat) {
      const value = src[at++] ?? 0;
      if (to + flat > out.length) {
        throw new SwordDecodeError('a Tony flat run overruns the frame buffer');
      }
      out.fill(value, to, to + flat);
      to += flat;
    }
    if (at < end) {
      const literal = src[at++];
      if (to + literal > out.length) {
        throw new SwordDecodeError('a Tony literal block overruns the frame buffer');
      }
      out.set(src.subarray(at, at + literal), to);
      at += literal;
      to += literal;
    }
  }
  return to;
}

/**
 * HIF — the PlayStation conversion's LZ-style scheme.
 *
 * Eight flags per control byte, most significant first. A clear flag copies one
 * literal; a set flag reads a **big-endian** info word whose top nibble is a
 * repeat count less two and whose low twelve bits are a back-reference distance
 * less one. `0xFFFF` ends the stream.
 *
 * Two details are the whole of getting this right. The word is big-endian in a
 * format that is otherwise little-endian, because the encoder was written on a
 * big-endian machine. And the back-copy is byte at a time from a moving source,
 * so a distance of one *is* a run — replacing it with a block copy breaks every
 * flat area.
 */
export function decompressHIF(src: Uint8Array, out: Uint8Array): number {
  let at = 0;
  let to = 0;
  for (;;) {
    if (at >= src.length) return to;
    let control = src[at++];
    for (let bit = 0; bit < 8; bit++) {
      if (control & 0x80) {
        if (at + 1 >= src.length) return to;
        const info = (src[at] << 8) | src[at + 1];
        at += 2;
        if (info === 0xffff) return to;
        const repeat = (info >> 12) + 2;
        const distance = (info & 0xfff) + 1;
        // `<= repeat` and not `< repeat`: ScummVM's loop is
        // `while (repeat_count >= 0)` after `+ 2`, so it copies `repeat + 1`
        // bytes. Off by one here is a sprite that shears one pixel per match.
        for (let copy = 0; copy <= repeat; copy++) {
          const from = to - distance;
          if (from < 0 || to >= out.length) return to;
          out[to++] = out[from];
        }
      } else {
        if (at >= src.length || to >= out.length) return to;
        out[to++] = src[at++];
      }
      control = (control << 1) & 0xff;
    }
  }
}

/** Which decoder a frame's tag selects. `raw` means the bytes are pixels. */
export type SwordCompression = 'rle7' | 'rle0' | 'tony' | 'hif' | 'raw';

/**
 * Reads the tag the way `Screen::processImage` does: by character, in order.
 *
 * `psx` short-circuits everything, because the conversion recompressed every
 * sprite with HIF and left the original tags in place — so a PlayStation frame
 * claiming `RLE7` is not RLE7, and believing the tag draws noise.
 */
export function compressionOf(runTimeComp: string, psx = false): SwordCompression {
  if (psx) return 'hif';
  if (runTimeComp[3] === '7') return 'rle7';
  if (runTimeComp[3] === '0') return 'rle0';
  if (runTimeComp[1] === 'I') return 'tony';
  return 'raw';
}

/**
 * Decodes one frame's pixels into a `width * height` buffer.
 *
 * Zero is transparent throughout this family, so the buffer starts cleared and
 * a decoder that stops short leaves transparency rather than stale pixels from
 * the last frame — which is what a shared scratch buffer would otherwise show.
 */
export function decodeSwordFrame(
  data: Uint8Array,
  compression: SwordCompression,
  compSize: number,
  width: number,
  height: number,
): Uint8Array {
  const out = new Uint8Array(width * height);
  switch (compression) {
    case 'rle7':
      decompressRLE7(data, compSize, out);
      return out;
    case 'rle0':
      decompressRLE0(data, compSize, out);
      return out;
    case 'tony':
      decompressTony(data, compSize, out);
      return out;
    case 'hif':
      decompressHIF(data, out);
      return out;
    case 'raw':
      out.set(data.subarray(0, Math.min(data.length, out.length)));
      return out;
  }
}

/**
 * Scales a sprite down by `scale/256`, nearest-neighbour, then stipples shadows.
 *
 * `Screen::fastShrink`'s arithmetic, kept exactly. Three details are visible on
 * every frame George walks and all three are easy to "improve" wrongly:
 *
 * - The accumulator is **8.8**, not 16.16: `step` is `0x10000 / scale` and every
 *   read is `>> 8`. Treating it as 16.16 samples the first source pixel for
 *   every output pixel, which is a solid block of one colour.
 * - It starts at **half a step**, not zero, so the sample lands in the middle of
 *   each source cell rather than on its left edge.
 * - Colour 200 is **stippled to transparent** on alternate pixels afterwards.
 *   That is the game's shadow: a solid 200 area becomes a checkerboard, which is
 *   how a shrunk mega casts one without an alpha channel.
 */
export function fastShrink(
  src: Uint8Array,
  width: number,
  height: number,
  scale: number,
  out: Uint8Array,
): { width: number; height: number } {
  const outWidth = (width * scale) >> 8;
  const outHeight = (height * scale) >> 8;
  if (outWidth <= 0 || outHeight <= 0) return { width: 0, height: 0 };

  const step = Math.floor(0x10000 / Math.max(1, scale));
  const columns = new Uint8Array(Math.max(1, outWidth));
  let column = step >> 1;
  for (let at = 0; at < outWidth; at++) {
    columns[at] = (column >> 8) & 0xff;
    column += step;
  }

  let newRow = step >> 1;
  let oldRow = 0;
  let sourceAt = 0;
  let to = 0;
  for (let row = 0; row < outHeight; row++) {
    while (oldRow < newRow >> 8) {
      oldRow++;
      sourceAt += width;
    }
    for (let at = 0; at < outWidth; at++) out[to + at] = src[sourceAt + columns[at]] ?? 0;
    to += outWidth;
    newRow += step;
  }

  // The shadow stipple: colour 200 on every other pixel, offset by the row, so
  // a flat shadow becomes a checkerboard rather than a solid block.
  for (let row = 0; row < outHeight; row++) {
    for (let at = row & 1; at < outWidth; at += 2) {
      const position = row * outWidth + at;
      if (out[position] === 200) out[position] = 0;
    }
  }

  return { width: outWidth, height: outHeight };
}

/**
 * A parallax layer: a header, a **row** offset table, and run-encoded rows.
 *
 * ```text
 * char[16] type            "PARALLAX"-ish; read, never assumed
 * uint16   sizeX
 * uint16   sizeY
 * uint32[] rowOffset       sizeY of them, from the start of the resource
 * …                        per row: (skip, copyLength, copyLength bytes) repeated
 * ```
 *
 * Row-major with one offset per row, which is what lets the renderer start at
 * an arbitrary scroll offset: it walks the row's runs discarding `paraScrlX`
 * pixels and then copies the rest. There is **no run count** — a row's list
 * ends when the accumulated x reaches the width, so a decoder that expects a
 * count reads the first skip as one and desynchronises immediately.
 *
 * A parallax is always at least screen-sized (`sizeX >= 640`, `sizeY >= 400`);
 * ScummVM asserts it, and this parser refuses rather than asserting because a
 * resource that fails the test is a resource being read as the wrong kind.
 */
export interface SwordParallax {
  readonly width: number;
  readonly height: number;
  /** Byte offset of each row's run list, from the start of the resource. */
  readonly rows: readonly number[];
}

export function parseSwordParallax(bytes: Uint8Array, big = false): SwordParallax {
  if (bytes.length < 20) {
    throw new SwordDecodeError(
      `A parallax resource is ${bytes.length} bytes, too short for its own 20-byte header.`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint16(16, !big);
  const height = view.getUint16(18, !big);
  if (width === 0 || height === 0) {
    throw new SwordDecodeError(`A parallax resource declares ${width}x${height}, which is empty.`);
  }
  if (20 + height * 4 > bytes.length) {
    throw new SwordDecodeError(
      `A parallax resource declares ${height} rows, whose offset table does not fit in its ` +
        `${bytes.length} bytes. This resource is probably not a parallax.`,
    );
  }
  const rows: number[] = [];
  for (let row = 0; row < height; row++) rows.push(view.getUint32(20 + row * 4, !big));
  return { width, height, rows };
}

/**
 * Decodes one parallax row into a `width`-wide strip. Zero is transparent.
 *
 * Null for a row the resource does not hold, which is normal: a parallax is
 * sparse by construction and a zero offset is how it says the row is empty.
 */
export function decodeSwordParallaxRow(
  bytes: Uint8Array,
  parallax: SwordParallax,
  row: number,
): Uint8Array | null {
  const offset = parallax.rows[row];
  if (offset === undefined || offset === 0 || offset >= bytes.length) return null;
  const strip = new Uint8Array(parallax.width);
  let at = offset;
  let x = 0;
  while (x < parallax.width && at < bytes.length) {
    const skip = bytes[at++];
    x += skip;
    if (x >= parallax.width || at >= bytes.length) break;
    const copy = bytes[at++];
    if (copy === 0) {
      // Neither a skip nor a copy moved x, so the row's runs cannot advance and
      // the list is malformed. Stopping is the only safe answer: continuing
      // spins, and ScummVM's loop relies on the encoder never emitting this.
      if (skip === 0) break;
      continue;
    }
    const take = Math.min(copy, parallax.width - x, bytes.length - at);
    strip.set(bytes.subarray(at, at + take), x);
    at += copy;
    x += copy;
  }
  return strip;
}
