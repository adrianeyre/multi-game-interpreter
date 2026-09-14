/**
 * Decoding AGOS pixels.
 *
 * Three encodings, and which one a resource uses is declared by the release
 * rather than branched on by Version — ADR 0030's split between packaging (a
 * reader each) and encoding (one decoder, told what it is looking at).
 *
 * **The run-length forms fill eight lines at a time.** A byte is a run length
 * read as a signed value: zero or positive means *repeat the next byte* that
 * many times plus one, negative means *copy* that many following bytes
 * literally. What makes it AGOS's rather than anyone else's is the direction —
 * the run walks **down** a column and wraps to the top of the next one, eight
 * columns to a strip, so a decoder that fills rows produces a picture that is
 * recognisably the right image and completely wrong.
 *
 * **The sprite form packs two pixels per byte**, high nibble first, and colour
 * zero is transparent unless the caller says otherwise. Sprites are also stored
 * column-major, for the same reason: AGOS drew them a column at a time.
 *
 * Nothing here composites, clips or palettes. Those belong to a renderer that
 * does not exist yet, and this is the part of it that can be written and
 * checked on its own.
 */

import { DRAW_FLAGS } from './vgaImages.js';

/** A decoded bitmap: 8-bit palette indices, row-major, `width` per row. */
export interface IndexedBitmap {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

function bitmap(width: number, height: number): IndexedBitmap {
  return { width, height, pixels: new Uint8Array(width * height) };
}

/**
 * The run-length form that walks down columns, eight columns to a strip.
 *
 * `height` is the strip's height; the strip is always eight columns wide, which
 * is why it is not a parameter. Decoding stops when the eighth column's last
 * pixel is written, so trailing bytes in the source are ignored rather than
 * treated as an error — the format lets a strip end mid-run.
 */
export function decodeColumnStrip(source: Uint8Array, height: number): IndexedBitmap {
  const out = bitmap(8, height);
  let read = 0;
  let column = 0;
  let row = 0;

  const put = (value: number): boolean => {
    out.pixels[row * 8 + column] = value;
    row += 1;
    if (row === height) {
      row = 0;
      column += 1;
      if (column === 8) return true;
    }
    return false;
  };

  while (read < source.length) {
    // Signed: the sign is the whole of the difference between a run and a copy.
    const runLength = (source[read++]! << 24) >> 24;
    if (runLength >= 0) {
      const colour = source[read++] ?? 0;
      for (let count = 0; count <= runLength; count += 1) {
        if (put(colour)) return out;
      }
    } else {
      for (let count = runLength; count !== 0; count += 1) {
        if (put(source[read++] ?? 0)) return out;
      }
    }
  }
  return out;
}

/**
 * A wide backdrop, assembled from its column-offset table.
 *
 * Simon 2 and The Feeble Files store a room wider than the screen not as one
 * long run but as a **table of offsets, one per eight-pixel column**, each
 * pointing at that column's {@link decodeColumnStrip}. The reference draws only
 * the forty columns under the scroll window each frame (`horizontalScroll`);
 * here the whole image is decoded once into a bitmap and the scroll offset is
 * applied when it is blitted, which is the same picture reached the way the
 * rest of this engine's draw path already works.
 *
 * `offset` is where the table starts in the pixel resource, `width` the image's
 * pixel width — so `width / 8` columns, each a four-byte big-endian offset from
 * its own slot to the column's pixels. (`readOffset` supplies the endianness:
 * big-endian for Simon 2, little for Feeble.)
 */
export function decodeWideImage(
  pixels: Uint8Array,
  offset: number,
  width: number,
  height: number,
  readOffset: (data: Uint8Array, at: number) => number,
): IndexedBitmap {
  const out = bitmap(width, height);
  const columns = Math.floor(width / 8);
  for (let column = 0; column < columns; column += 1) {
    const slot = offset + column * 4;
    const strip = decodeColumnStrip(pixels.subarray(slot + readOffset(pixels, slot)), height);
    const originX = column * 8;
    for (let row = 0; row < height; row += 1) {
      for (let dx = 0; dx < 8; dx += 1) {
        out.pixels[row * width + originX + dx] = strip.pixels[row * 8 + dx] ?? 0;
      }
    }
  }
  return out;
}

/**
 * The run-length form that walks along rows, eight rows to a strip.
 *
 * The same encoding turned ninety degrees, used where AGOS 2 stores an image
 * row-major. Kept as its own function rather than as a flag on the one above,
 * because the wrapping is the whole of the loop and a flag would put a branch
 * inside the hottest part of it for no reader's benefit.
 */
export function decodeRowStrip(source: Uint8Array, width: number): IndexedBitmap {
  const out = bitmap(width, 8);
  let read = 0;
  let column = 0;
  let row = 0;

  const put = (value: number): boolean => {
    out.pixels[row * width + column] = value;
    column += 1;
    if (column === width) {
      column = 0;
      row += 1;
      if (row === 8) return true;
    }
    return false;
  };

  while (read < source.length) {
    const runLength = (source[read++]! << 24) >> 24;
    if (runLength >= 0) {
      const colour = source[read++] ?? 0;
      for (let count = 0; count <= runLength; count += 1) {
        if (put(colour)) return out;
      }
    } else {
      for (let count = runLength; count !== 0; count += 1) {
        if (put(source[read++] ?? 0)) return out;
      }
    }
  }
  return out;
}

/**
 * The uncompressed sprite form: two pixels per byte, column-major.
 *
 * `width` is in **bytes**, so the bitmap is twice that in pixels — the source's
 * own unit, kept rather than converted, because every offset in the format is
 * expressed in it and converting at the boundary is where an off-by-two comes
 * from.
 *
 * Colour zero is transparent, which is why a caller that wants a solid image
 * has to say so: the same bytes mean different pictures depending on the flag,
 * and defaulting either way would be a guess about the resource.
 */
/**
 * Packs an indexed bitmap back into the uncompressed sprite form.
 *
 * The exact inverse of {@link decodeSprite}, and the encoder a paint surface
 * needs: without it an image could be decoded and looked at but never written
 * back, which is the difference between inspecting a game's art and editing it.
 *
 * ## Why only the uncompressed form
 *
 * A compressed image's runs cross column boundaries and the same bitmap has
 * many valid encodings, so a re-encode would produce *different bytes for the
 * same picture*. That matters more here than it would elsewhere: ADR 0030
 * guarantees a resource re-emits as the bytes it arrived as, and an encoder
 * that repacked an untouched compressed image would break byte-identity for
 * any game whose art had merely been opened. So compressed images are refused
 * by name rather than round-tripped through a lossy path — see
 * {@link encodeSpriteRefusal}.
 *
 * ## Why width is in bytes
 *
 * Because the format's unit is a byte holding two pixels, and a bitmap of odd
 * pixel width has no representation in it. Taking `widthBytes` rather than a
 * pixel width makes that impossible to express instead of wrong at runtime: a
 * caller has already decided how many bytes a row occupies, which is what the
 * image entry records.
 */
export function encodeSprite(
  source: IndexedBitmap,
  widthBytes: number,
  height: number,
): Uint8Array {
  if (source.width !== widthBytes * 2) {
    throw new Error(`a ${widthBytes}-byte row holds ${widthBytes * 2} pixels, not ${source.width}`);
  }
  if (source.height !== height) {
    throw new Error(`expected ${height} rows, got ${source.height}`);
  }

  const out = new Uint8Array(widthBytes * height);
  for (let row = 0; row < height; row += 1) {
    for (let byte = 0; byte < widthBytes; byte += 1) {
      const left = source.pixels[row * source.width + byte * 2] ?? 0;
      const right = source.pixels[row * source.width + byte * 2 + 1] ?? 0;
      // Four bits each, so anything above 15 is not a colour this form can
      // hold. Masking would write a different colour and look like it worked.
      if (left > 15 || right > 15) {
        throw new Error(`colour ${Math.max(left, right)} does not fit four bits`);
      }
      out[row * widthBytes + byte] = (left << 4) | right;
    }
  }
  return out;
}

/**
 * Whether a pixel entry's own bytes are run-length coded.
 *
 * **The entry's high bit says so, and the draw flags do not always.** The
 * renderer learned this the hard way and folds one into the other before it
 * decodes (`VgaMachine.paint`): an entry with `0x80` set is compressed
 * whatever the script asked for, and read as raw nibbles it comes out as noise.
 *
 * Here as a named rule rather than a bit test spelled out at each site, because
 * there are three sites now — the renderer, the editor's canvas and the paint
 * write-back — and the editor's used to test `DRAW_FLAGS.compressed` instead.
 * That is a *script* flag; Simon 1's pixel entries carry `0x80` and nothing
 * else, so every one of its images decoded down the wrong path.
 *
 * The script bits are still honoured, because a caller that has them has more
 * information than one that does not.
 */
export function isCompressedEntry(flags: number): boolean {
  return (flags & (0x80 | DRAW_FLAGS.compressed | DRAW_FLAGS.compressedFlip)) !== 0;
}

/**
 * Why an image cannot be written back, or null when it can.
 *
 * A predicate a surface asks *before* offering to paint, so the refusal is a
 * disabled control with a reason rather than an error after the author has
 * done the work.
 *
 * ## It used to refuse every compressed image, and that was the wrong reason
 *
 * The argument was byte identity: a compressed bitmap has many valid encodings,
 * so a re-encode produces different bytes for the same picture, and ADR 0030
 * guarantees a resource re-emits as the bytes it arrived as.
 *
 * The guarantee is real and the inference from it was not. What ADR 0030
 * protects is an image that was **merely opened** — and nothing re-encodes one
 * of those. Paint is recorded per image as intent, and `applyPaintedImages`
 * rewrites only the images an author actually painted; every other image in the
 * zone is copied through untouched. So the choice was never "byte identity or
 * compressed painting". It was "compressed painting or none", and on Simon 1 —
 * whose sprites are compressed almost throughout — that meant an Art tab which
 * showed a game's art and refused to change any of it.
 *
 * `encodeCompressedSprite` is the inverse the refusal stood in for, and
 * `paintImage` verifies every encode by decoding it again before it writes. So
 * nothing here refuses a form this file can round-trip, and what remains are
 * the ones it cannot: an entry whose pixels are not a four-bit sprite at all.
 */
export function encodeSpriteRefusal(flags: number): string | null {
  if ((flags & DRAW_FLAGS.masked) !== 0) {
    // A masked draw takes its shape from a second resource, so the pixels an
    // entry points at are half of the picture. Painting them would edit
    // something the author cannot see the whole of.
    return 'this image is drawn through a mask, so its pixels are only half of the picture';
  }
  return null;
}

/**
 * How many bytes of a compressed stream one image occupies.
 *
 * The entry gives an offset and never a length — the decoder simply stops when
 * it has produced `widthBytes * height` pixels — so this walks the same control
 * stream and reports where it stopped. A painted image is written back into
 * that budget where it fits, which is what keeps every *other* image in the
 * zone at the offset its entry already names.
 */
export function compressedSpriteLength(
  source: Uint8Array,
  widthBytes: number,
  height: number,
): number {
  let read = 0;
  let run = -0x80;
  let literal = false;

  for (let column = 0; column < widthBytes; column += 1) {
    let remaining = height;
    while (remaining > 0) {
      if (run === -0x80) {
        run = ((source[read++] ?? 0) << 24) >> 24;
        literal = run < 0;
        if (!literal) read += 1;
      }
      if (literal) {
        read += 1;
        run += 1;
        if (run === 0) run = -0x80;
      } else {
        run -= 1;
        if (run < 0) run = -0x80;
      }
      remaining -= 1;
    }
  }
  return read;
}

/**
 * Packs an indexed bitmap into the compressed sprite form.
 *
 * The exact inverse of {@link decodeCompressedSprite}, over the same continuous
 * byte stream: the bitmap is flattened column-major — a column of source bytes
 * is two pixels wide on screen — and that stream is run-length coded. Runs
 * cross column boundaries here for the same reason they do when decoding, which
 * is why the stream is built whole before any control byte is written.
 *
 * ## The two control words, and where their limits come from
 *
 * A control byte is signed. A **negative** one introduces that many literal
 * bytes, one to 127 of them — 128 is unavailable because `-0x80` is the
 * decoder's "no run in progress" sentinel. A **non-negative** one is a repeat,
 * and emits `control + 1` copies of the byte after it, so one to 128.
 *
 * ## Why a two-byte run is coded as a repeat
 *
 * A repeat of two costs two bytes; the same pair as literals costs three. A run
 * of one is the other way round, so it is left in the literal accumulator. That
 * is the whole of the size heuristic, and it is deliberately not cleverer: what
 * matters is that the picture round-trips, and `paintImage` has somewhere to
 * put an encoding that came out longer than the one it replaces.
 */
export function encodeCompressedSprite(
  source: IndexedBitmap,
  widthBytes: number,
  height: number,
): Uint8Array {
  if (source.width !== widthBytes * 2) {
    throw new Error(`a ${widthBytes}-byte row holds ${widthBytes * 2} pixels, not ${source.width}`);
  }
  if (source.height !== height) {
    throw new Error(`expected ${height} rows, got ${source.height}`);
  }

  // Column-major, which is the order the decoder consumes and therefore the
  // only order the runs can be measured in.
  const stream = new Uint8Array(widthBytes * height);
  let at = 0;
  for (let column = 0; column < widthBytes; column += 1) {
    for (let row = 0; row < height; row += 1) {
      const left = source.pixels[row * source.width + column * 2] ?? 0;
      const right = source.pixels[row * source.width + column * 2 + 1] ?? 0;
      if (left > 15 || right > 15) {
        throw new Error(`colour ${Math.max(left, right)} does not fit four bits`);
      }
      stream[at++] = (left << 4) | right;
    }
  }

  const out: number[] = [];
  const literals: number[] = [];
  const flushLiterals = (): void => {
    while (literals.length > 0) {
      const take = literals.splice(0, 127);
      // Negative, as a byte: the decoder reads it back with a sign extension.
      out.push(256 - take.length, ...take);
    }
  };

  let index = 0;
  while (index < stream.length) {
    let run = 1;
    while (index + run < stream.length && stream[index + run] === stream[index] && run < 128) {
      run += 1;
    }

    if (run >= 2) {
      flushLiterals();
      out.push(run - 1, stream[index]!);
      index += run;
      continue;
    }

    literals.push(stream[index]!);
    index += 1;
    if (literals.length === 127) flushLiterals();
  }
  flushLiterals();

  return Uint8Array.from(out);
}

export function decodeSprite(
  source: Uint8Array,
  width: number,
  height: number,
  options: { opaque?: boolean } = {},
): IndexedBitmap {
  const out = bitmap(width * 2, height);
  const opaque = options.opaque ?? false;

  for (let row = 0; row < height; row += 1) {
    for (let byte = 0; byte < width; byte += 1) {
      const value = source[row * width + byte] ?? 0;
      const left = value >> 4;
      const right = value & 15;
      if (opaque || left !== 0) out.pixels[row * width * 2 + byte * 2] = left;
      if (opaque || right !== 0) out.pixels[row * width * 2 + byte * 2 + 1] = right;
    }
  }
  return out;
}

/**
 * The compressed sprite form, whose runs cross column boundaries.
 *
 * This is the one AGOS encoding that cannot be decoded a piece at a time. A
 * column is a fixed number of *bytes*, but a run may end mid-column and carry
 * into the next one — the reference keeps the remaining run length in state
 * between columns and resumes it. So a decoder that restarts per column loses
 * exactly the runs that straddle a boundary, and produces an image that is
 * right down the left edge and progressively wrong across.
 *
 * Each depacked byte is two pixels, high nibble left, as in the uncompressed
 * form: a column of source bytes is two pixels wide on screen.
 */
export function decodeCompressedSprite(
  source: Uint8Array,
  widthBytes: number,
  height: number,
  options: { opaque?: boolean } = {},
): IndexedBitmap {
  const out = bitmap(widthBytes * 2, height);
  const opaque = options.opaque ?? false;

  let read = 0;
  // -0x80 means "no run in progress", which is the reference's own sentinel
  // rather than a flag beside the counter.
  let run = -0x80;
  let colour = 0;
  let literal = false;

  for (let column = 0; column < widthBytes; column += 1) {
    let remaining = height;
    let row = 0;
    while (remaining > 0) {
      if (run === -0x80) {
        run = ((source[read++] ?? 0) << 24) >> 24;
        literal = run < 0;
        if (!literal) colour = source[read++] ?? 0;
      }

      const value = literal ? (source[read++] ?? 0) : colour;
      const left = value >> 4;
      const right = value & 15;
      if (opaque || left !== 0) out.pixels[row * widthBytes * 2 + column * 2] = left;
      if (opaque || right !== 0) out.pixels[row * widthBytes * 2 + column * 2 + 1] = right;
      row += 1;
      remaining -= 1;

      if (literal) {
        run += 1;
        if (run === 0) run = -0x80;
      } else {
        run -= 1;
        if (run < 0) run = -0x80;
      }
    }
  }
  return out;
}

/**
 * Simon 1's **thirty-two colour** encoding, which is neither of the other two.
 *
 * A third encoding in one family, and the one this project drew as noise for
 * want of knowing it existed. Simon 1's *backdrops* — a room's picture and the
 * verb panel — are not four-bit sprites: they pack **five bits per pixel**,
 * eight pixels into five bytes, and index the palette directly rather than
 * through a sixteen-colour bank.
 *
 * ```
 * AAAAAAAA BBBBBBBB CCCCCCCC DDDDDDDD EEEEEEEE
 * aaaaabbb bbcccccd ddddeeee efffffgg ggghhhhh
 * ```
 *
 * ## What chooses it, which is not a flag in the image
 *
 * The reference switches on where the draw came from: a draw made while a
 * window's picture is being put up, with palette bank zero, is thirty-two
 * colour; everything else is a sprite. So one image entry could decode two ways
 * and nothing in the entry says which — the caller's situation does. That is
 * why `VgaMachine` carries the mode rather than this function guessing at it.
 *
 * Decoding a backdrop as four-bit nibbles is what made Simon 1's rooms draw as
 * regular vertical stripes with the previous screen showing between them: five
 * bits read as four goes out of step inside the first byte and back into step
 * every forty, which produces a striped picture rather than a broken one.
 */
export function decode32ColourSprite(
  source: Uint8Array,
  width: number,
  height: number,
  options: { opaque?: boolean; compressed?: boolean } = {},
): IndexedBitmap {
  const out = bitmap(width, height);
  const opaque = options.opaque ?? false;
  const compressed = options.compressed ?? false;

  if (!compressed) {
    // A byte a pixel, and the row stride is the pixel width.
    for (let row = 0; row < height; row += 1) {
      for (let column = 0; column < width; column += 1) {
        const value = source[row * width + column] ?? 0;
        if (opaque || value !== 0) out.pixels[row * width + column] = value;
      }
    }
    return out;
  }

  // Five bytes to eight pixels, row by row.
  const groupsPerRow = Math.floor(width / 8);
  let read = 0;
  for (let row = 0; row < height; row += 1) {
    for (let group = 0; group < groupsPerRow; group += 1) {
      const a = source[read] ?? 0;
      const b = source[read + 1] ?? 0;
      const c = source[read + 2] ?? 0;
      const d = source[read + 3] ?? 0;
      const e = source[read + 4] ?? 0;
      read += 5;

      // The first six come out of the first four bytes as a 32-bit window; the
      // last two straddle the fifth. The reference shifts that window left by
      // eight and lets the top byte fall off a `uint32`, which is the same as
      // reading the pair out of `d` and `e` alone.
      const high = ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
      const tail = (d << 8) | e;
      const colours = [
        (high >>> 27) & 31,
        (high >>> 22) & 31,
        (high >>> 17) & 31,
        (high >>> 12) & 31,
        (high >>> 7) & 31,
        (high >>> 2) & 31,
        (tail >>> 5) & 31,
        e & 31,
      ];

      const at = row * width + group * 8;
      for (let index = 0; index < 8; index += 1) {
        const colour = colours[index] ?? 0;
        if (opaque || colour !== 0) out.pixels[at + index] = colour;
      }
    }
  }
  return out;
}
