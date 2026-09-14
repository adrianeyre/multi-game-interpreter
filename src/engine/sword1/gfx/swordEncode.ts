/**
 * The inverses of `swordDecode.ts`: pixels back into Broken Sword's formats.
 *
 * A decoder alone makes pictures *viewable*. Writing one back needs the other
 * direction, and the standard this project holds an encoder to is stricter than
 * "it decodes to the same pixels": re-encoding a shipped frame must produce the
 * **byte-identical** original. Anything less and an export of an unmodified
 * game stops being a copy of it, and the diff that proves the export correct
 * stops existing.
 *
 * That bar was met by measurement rather than by reading the format's
 * documentation, because there is none. `npm run sweep:sword` re-encodes every
 * frame of an install and counts; against the PC demo it reports 7113 of 7113,
 * and the rules below are what it took to get there. Each is a real decision
 * the original tool made that the decoder cannot see, so each is written down
 * here rather than left implicit in the code.
 *
 * ## RLE7
 *
 * - A run of exactly two is emitted as a **run**, not as two literals. Both
 *   decode alike and both cost two bytes; the original picked the run.
 * - Runs cap at **128** (`code` 127 means 128 copies), and a remainder of one
 *   is emitted as a *literal*, never as `code 0` — which is a literal zero and
 *   would write the wrong colour. Where that remainder cannot be a literal the
 *   split moves back one so the tail is two.
 * - **One frame in the format cannot be written.** A lone pixel whose colour is
 *   in 1..127 has no encoding: literals are 0 and 128..255, and a run is at
 *   least two. Shipped frames never contain one — a decoder cannot produce one
 *   — but an imported picture can, so `compressRLE7` answers `null` and the
 *   caller re-tags the frame `NONE`.
 *
 * ## RLE0
 *
 * Non-zero bytes are literals and a zero run is `(0, length)` capped at 255.
 * There is nothing to choose here, which is why it was right first time.
 *
 * ## Tony (`"JIM "`)
 *
 * Alternating blocks: a flat run, then literals. The flat block is emitted even
 * when it is one pixel long, the literal block runs until a run of **four** or
 * more (below four a run costs more as a run than as literals), both cap at
 * 255, and a literal block filled to exactly 255 **truncates a run** to reach
 * the cap rather than stopping short of it. No trailing empty literal header is
 * written when the frame ends on a flat block.
 *
 * ## Parallax rows
 *
 * A row is `(skip, copyLength, copyLength bytes)` repeated, with no run count —
 * the row ends when the accumulated x reaches the width. A row that ends in
 * transparency still writes the pair, with a copy length of zero that the
 * reader never looks at: it breaks the moment x reaches the width. Measuring
 * this against the *decoder's* walk says the byte is not there, and measuring
 * it against the next row's offset says it is — 325 of one layer's 400 rows
 * carry it, and the 75 that do not are the rows that end on a copy instead.
 *
 * ## HIF
 *
 * The one scheme here held to a different standard, stated rather than quietly
 * swapped. HIF is LZ77 with a 4096-byte window, so an encoder chooses *which*
 * earlier match to point at, and two tools with different match-finders write
 * different bytes from the same pixels. Revolution's choices are not something
 * measurement can recover from the output, so `compressHIF` does not claim to
 * reproduce them and is not held to byte identity.
 *
 * What it is held to is that the **existing decoder reads back the pixels that
 * went in**, which is a proof this project can actually run — `npm run
 * sweep:sword` encodes every decoded frame of an install as HIF, decodes it
 * again with `decompressHIF`, and counts pixel differences. That is the test;
 * byte identity is not, and no claim of it is made anywhere.
 *
 * Two rules come from the decoder rather than from any documentation of the
 * format. A match is `(length - 3) << 12 | (distance - 1)` big-endian, so
 * lengths run 3..18 and distances 1..4096 — and length 18 at distance 4096 is
 * the word `0xFFFF`, which ends the stream, so that one pair is written a byte
 * shorter instead. And a match may overlap what it copies, because the decoder
 * copies a byte at a time from a moving source: distance 1 is a run, and the
 * match-finder is allowed to find one.
 *
 * It matters only for the PlayStation conversion, which is the release no
 * install reachable from this project is. So the encoder is written against the
 * decoder, and `docs/editor-parity.md` §Na says what that does and does not
 * establish.
 */

import type { SwordCompression } from './swordDecode.js';
import { SWORD1_PARALLAX_HEADER_SIZE } from '../resource/swordDefs.js';

/** Raised when pixels cannot be written in the format asked for. */
export class SwordEncodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SwordEncodeError';
  }
}

/** The tag a frame header carries for each compression, as the demos write it. */
export const SWORD_COMPRESSION_TAGS: Readonly<Record<SwordCompression, string>> = {
  rle7: 'RLE7',
  rle0: 'RLE0',
  tony: 'JIM ',
  raw: 'NONE',
  // The conversion left the original tags in place and selected HIF by
  // platform, so there is no tag that means HIF. `compressionOf` agrees:
  // nothing it reads returns `hif` without `psx`.
  hif: 'NONE',
};

/**
 * Why this compression cannot be written, or null when it can.
 *
 * Nothing refuses now. HIF used to, and the refusal was about the wrong
 * property: it said a re-encode would not reproduce the original bytes, which
 * is true and is not what a frame needs. `compressHIF` writes a stream
 * `decompressHIF` reads back pixel for pixel, and where the bytes differ from
 * Revolution's the frame is still the frame. The one thing this must not do is
 * be read as byte identity, which is why `swordHifClaim` says the difference in
 * a sentence the editor can show.
 */
export function swordEncodeRefusal(_compression: SwordCompression): string | null {
  return null;
}

/** What a HIF re-encode is and is not, for a surface that has to say it. */
export function swordHifClaim(): string {
  return (
    'HIF, the PlayStation conversion’s LZ77 scheme, is written here against the decoder ' +
    'rather than against Revolution’s encoder: an LZ match-finder chooses between equally ' +
    'valid matches, so the bytes are this project’s and the pixels are the frame’s. ' +
    '`npm run sweep:sword` decodes every frame it writes and counts the pixels that differ.'
  );
}

// HIF's three numbers, all of them read off `decompressHIF` rather than off a
// specification: a match is at least three bytes because two cost as much as
// two literals and one flag, at most eighteen because the length lives in a
// nibble plus three, and reaches back at most 4,096 because the distance lives
// in twelve bits plus one.
const HIF_MIN_MATCH = 3;
const HIF_MAX_MATCH = 18;
const HIF_WINDOW = 4096;
/** How many earlier positions with the same three bytes to weigh. */
const HIF_CHAIN = 64;

/**
 * Pixels as a HIF stream: valid, and not Revolution's bytes.
 *
 * A greedy match-finder over hash chains — the earliest three bytes are hashed,
 * each position remembers the previous position with the same hash, and the
 * chain is walked back for the longest match inside the window. Greedy rather
 * than optimal because the standard being met is that the decoder reads the
 * pixels back, and a lazy or optimal parse would only make the stream smaller.
 */
export function compressHIF(pixels: Uint8Array): Uint8Array {
  const out: number[] = [];
  let controlAt = -1;
  let bits = 8;
  /** One flag, most significant first, opening a new control byte every eight. */
  const flag = (set: boolean): void => {
    if (bits === 8) {
      controlAt = out.length;
      out.push(0);
      bits = 0;
    }
    if (set) out[controlAt] |= 0x80 >> bits;
    bits++;
  };

  const end = pixels.length;
  const head = new Int32Array(1 << 16).fill(-1);
  const prev = new Int32Array(Math.max(1, end)).fill(-1);
  const hashAt = (at: number): number =>
    ((pixels[at] << 10) ^ (pixels[at + 1] << 5) ^ pixels[at + 2]) & 0xffff;
  const remember = (at: number): void => {
    if (at + HIF_MIN_MATCH > end) return;
    const key = hashAt(at);
    prev[at] = head[key];
    head[key] = at;
  };

  let at = 0;
  while (at < end) {
    let bestLength = 0;
    let bestDistance = 0;
    if (at + HIF_MIN_MATCH <= end) {
      const limit = Math.min(HIF_MAX_MATCH, end - at);
      let candidate = head[hashAt(at)];
      for (let tried = 0; tried < HIF_CHAIN && candidate >= 0; tried++) {
        const distance = at - candidate;
        if (distance > HIF_WINDOW) break;
        let length = 0;
        // A byte at a time from a moving source, which is how the decoder
        // copies: a match may run past where it started and repeat itself.
        while (length < limit && pixels[candidate + length] === pixels[at + length]) length++;
        if (length > bestLength) {
          bestLength = length;
          bestDistance = distance;
          if (length === limit) break;
        }
        candidate = prev[candidate];
      }
    }

    // `0xFFFF` ends the stream, so the one match it would encode — eighteen
    // bytes from 4,096 back — is written a byte shorter. Never silently: this
    // is the only place the encoder declines what it found, and the frame is
    // the same either way.
    if (bestLength === HIF_MAX_MATCH && bestDistance === HIF_WINDOW) bestLength--;

    if (bestLength >= HIF_MIN_MATCH) {
      const info = ((bestLength - HIF_MIN_MATCH) << 12) | (bestDistance - 1);
      flag(true);
      out.push((info >> 8) & 0xff, info & 0xff);
      for (let step = 0; step < bestLength; step++) remember(at + step);
      at += bestLength;
      continue;
    }
    flag(false);
    out.push(pixels[at]);
    remember(at);
    at++;
  }

  // The terminator, which the decoder needs whenever the pixels it is filling
  // are longer than what was written — a frame of transparency at the end
  // would otherwise be read out of whatever follows the stream.
  flag(true);
  out.push(0xff, 0xff);
  return Uint8Array.from(out);
}

/** How long the run of equal bytes starting at `at` is. */
function runLength(pixels: Uint8Array, at: number, end: number): number {
  const value = pixels[at];
  let length = 1;
  while (at + length < end && pixels[at + length] === value) length++;
  return length;
}

/**
 * RLE7, or null where the pixels contain a lone 1..127 colour.
 *
 * Null is not a failure of this function: it is the format declining, and the
 * caller's answer is to write the frame raw rather than to lose a pixel.
 */
export function compressRLE7(pixels: Uint8Array): Uint8Array | null {
  const out: number[] = [];
  const end = pixels.length;
  let at = 0;
  while (at < end) {
    const value = pixels[at];
    const literal = value === 0 || value > 127;
    let length = runLength(pixels, at, end);
    if (literal && length === 1) {
      out.push(value);
      at++;
      continue;
    }
    if (!literal && length === 1) return null;
    while (length > 0) {
      if (length === 1) {
        if (!literal) return null;
        out.push(value);
        at++;
        break;
      }
      let take = Math.min(length, 128);
      // A tail of one that cannot be a literal is a tail that cannot be
      // written, so give it back a pixel and let it be a run of two.
      if (length - take === 1 && !literal) take--;
      out.push(take - 1, value);
      length -= take;
      at += take;
    }
  }
  return Uint8Array.from(out);
}

/** RLE0: literals, with a zero run written as `(0, length)`. */
export function compressRLE0(pixels: Uint8Array): Uint8Array {
  const out: number[] = [];
  const end = pixels.length;
  let at = 0;
  while (at < end) {
    if (pixels[at] !== 0) {
      out.push(pixels[at]);
      at++;
      continue;
    }
    let length = runLength(pixels, at, end);
    while (length > 0) {
      const take = Math.min(length, 255);
      out.push(0, take);
      length -= take;
      at += take;
    }
  }
  return Uint8Array.from(out);
}

/**
 * Tony (`"JIM "`), and Broken Sword II's two schemes, which are the same shape.
 *
 * `threshold` is the run length at which a run becomes cheaper than literals,
 * and it moves with what a literal costs: four when a literal is a byte, seven
 * when two literals share one. `nibble` maps a colour to its four-bit index for
 * the second case, and null writes bytes. `trailing` emits an empty literal
 * header after a frame-final flat block, which Sword1 does not do and Broken
 * Sword II's row-based scheme does.
 *
 * Exported because `sword2Encode.ts` calls it: this is one algorithm with three
 * parameter sets, and ADR 0036 forbids the two families sharing a *record*, not
 * sharing a run-length loop.
 */
export function compressTony(
  pixels: Uint8Array,
  options: {
    readonly threshold?: number;
    readonly nibble?: ((value: number) => number) | null;
    readonly highNibbleFirst?: boolean;
    readonly trailing?: boolean;
  } = {},
): Uint8Array {
  const threshold = options.threshold ?? 4;
  const nibble = options.nibble ?? null;
  const highNibbleFirst = options.highNibbleFirst ?? true;
  const trailing = options.trailing ?? false;
  const out: number[] = [];
  const end = pixels.length;
  let at = 0;
  while (at < end) {
    const flat = Math.min(runLength(pixels, at, end), 255);
    out.push(flat, pixels[at]);
    at += flat;
    if (at >= end && !trailing) break;
    const start = at;
    while (at < end && at - start < 255) {
      const run = runLength(pixels, at, end);
      if (run >= threshold) break;
      // Truncating the run at the cap rather than stopping before it is what
      // the original did: a literal block reads 255, never 253 with a run
      // sitting one byte short of the boundary.
      at = Math.min(at + run, start + 255);
    }
    pushLiterals(out, pixels, start, at, nibble, highNibbleFirst);
  }
  return Uint8Array.from(out);
}

/** A literal block: its length, then its bytes or its packed nibble pairs. */
export function pushLiterals(
  out: number[],
  pixels: Uint8Array,
  start: number,
  end: number,
  nibble: ((value: number) => number) | null,
  highNibbleFirst = true,
): void {
  const count = end - start;
  out.push(count);
  if (!nibble) {
    for (let at = start; at < end; at++) out.push(pixels[at]);
    return;
  }
  // An odd count's last byte carries one pixel and a zero the decoder never
  // reads, which is how `unwindRaw16` reads it back. Which half holds which
  // pixel is the platform's, not the format's: the PlayStation swapped them.
  for (let at = 0; at < count; at += 2) {
    const first = nibble(pixels[start + at]);
    const second = at + 1 < count ? nibble(pixels[start + at + 1]) : 0;
    out.push(highNibbleFirst ? (first << 4) | second : (second << 4) | first);
  }
}

/** A frame's bytes, the compression they are in, and why it changed if it did. */
export interface SwordEncodedFrame {
  readonly bytes: Uint8Array;
  readonly compression: SwordCompression;
  /** The four-byte tag to write into the frame header. */
  readonly tag: string;
  /** Why the compression is not the one asked for, or null when it is. */
  readonly retagged: string | null;
}

/**
 * Writes one frame's pixels back in the compression it came in.
 *
 * The frame header carries its own `runTimeComp`, so a frame that cannot be
 * written in its original scheme can be written raw and re-tagged without
 * touching any other frame in the sprite. That is the escape hatch RLE7 needs
 * and it costs only size.
 */
export function encodeSwordFrame(
  pixels: Uint8Array,
  compression: SwordCompression,
): SwordEncodedFrame {
  const refusal = swordEncodeRefusal(compression);
  if (refusal) throw new SwordEncodeError(refusal);
  const raw = (retagged: string | null): SwordEncodedFrame => ({
    bytes: Uint8Array.from(pixels),
    compression: 'raw',
    tag: SWORD_COMPRESSION_TAGS.raw,
    retagged,
  });
  switch (compression) {
    case 'rle7': {
      const bytes = compressRLE7(pixels);
      return bytes
        ? { bytes, compression: 'rle7', tag: SWORD_COMPRESSION_TAGS.rle7, retagged: null }
        : raw(
            'a single pixel of a colour between 1 and 127 has no RLE7 encoding, so this ' +
              'frame is written as raw pixels',
          );
    }
    case 'rle0':
      return {
        bytes: compressRLE0(pixels),
        compression: 'rle0',
        tag: SWORD_COMPRESSION_TAGS.rle0,
        retagged: null,
      };
    case 'tony':
      return {
        bytes: compressTony(pixels),
        compression: 'tony',
        tag: SWORD_COMPRESSION_TAGS.tony,
        retagged: null,
      };
    case 'hif':
      // Written, and tagged `NONE` all the same: the tag in a frame header
      // never meant HIF — the conversion selected it by platform and left the
      // original tags in place — so there is nothing to write that would say
      // so. A PC install reads it as raw pixels, which is what `raw` is for.
      return {
        bytes: compressHIF(pixels),
        compression: 'hif',
        tag: SWORD_COMPRESSION_TAGS.hif,
        retagged: null,
      };
    case 'raw':
      return raw(null);
    default:
      throw new SwordEncodeError(`no encoder for ${compression as string}`);
  }
}

/**
 * One parallax row: alternating skips and copies, ending on whichever it does.
 *
 * Null for a row with no visible pixel, which is how the layer says the row is
 * empty — the offset table writes a zero rather than pointing at an encoding
 * of nothing.
 */
export function compressSwordParallaxRow(pixels: Uint8Array): Uint8Array | null {
  const width = pixels.length;
  if (!pixels.some((pixel) => pixel !== 0)) return null;
  const out: number[] = [];
  let at = 0;
  while (at < width) {
    let skip = 0;
    while (at < width && pixels[at] === 0 && skip < 255) {
      skip++;
      at++;
    }
    if (at >= width) {
      // The copy length here is a byte the reader never looks at, and the
      // original writes it anyway.
      out.push(skip, 0);
      break;
    }
    const start = at;
    while (at < width && pixels[at] !== 0 && at - start < 255) at++;
    out.push(skip, at - start);
    for (let pixel = start; pixel < at; pixel++) out.push(pixels[pixel]);
  }
  return Uint8Array.from(out);
}

/**
 * A whole parallax layer: its 20-byte header, its row table, and its rows.
 *
 * `type` is carried through rather than written from a constant because the
 * decoder reads the tag instead of assuming it, and an export that rewrote
 * `"PARALLAX"` as something else would be an export that changed a byte it did
 * not have to.
 */
export function encodeSwordParallax(
  pixels: Uint8Array,
  width: number,
  height: number,
  type: Uint8Array,
  big = false,
): Uint8Array {
  const rows = Array.from({ length: height }, (_, row) =>
    compressSwordParallaxRow(pixels.subarray(row * width, (row + 1) * width)),
  );
  const tableAt = SWORD1_PARALLAX_HEADER_SIZE;
  let offset = tableAt + height * 4;
  const bodies: Uint8Array[] = [];
  const offsets: number[] = [];
  for (const row of rows) {
    if (!row) {
      offsets.push(0);
      continue;
    }
    offsets.push(offset);
    bodies.push(row);
    offset += row.length;
  }

  const out = new Uint8Array(offset);
  out.set(type.subarray(0, 16));
  const view = new DataView(out.buffer);
  view.setUint16(16, width, !big);
  view.setUint16(18, height, !big);
  for (let row = 0; row < height; row++) view.setUint32(tableAt + row * 4, offsets[row], !big);
  let to = tableAt + height * 4;
  for (const body of bodies) {
    out.set(body, to);
    to += body.length;
  }
  return out;
}
