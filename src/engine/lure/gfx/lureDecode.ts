/**
 * Lure's picture decompressor.
 *
 * `lureDisk.ts` established that Lure's **palettes** are stored uncompressed —
 * 49 of them, 660 bytes each, every byte inside the 6-bit VGA range, which
 * neither compressed nor arbitrary data would satisfy. That finding is sound and
 * it was over-generalised into "Lure stores its resources uncompressed". Its
 * pictures are not: they carry their own scheme, and this is it.
 *
 * ## The scheme
 *
 * A resource opens with a **1 KB table** — 256 entries of four bytes, indexed by
 * the byte last written. Then a little-endian 32-bit offset at `0x400` names
 * where the *literal* stream begins, and the **bit** stream starts immediately
 * after that pointer at `0x404`. Two read pointers walk the resource at once,
 * which is why a single-cursor reading of this format cannot work.
 *
 * Each step reads bits until it selects one of six outcomes: the byte the table
 * gives at one of four positions for the current index, a run of one byte
 * repeated, or the end. A literal is taken from the literal stream and becomes
 * the next table index. So the table is a per-byte "what usually follows"
 * prediction and the bit stream says which prediction was right.
 *
 * Transcribed from ScummVM's `PictureDecoder::vgaDecode`, whose register names
 * are kept in the comments where they explain a step, because that routine is a
 * transliteration of 8086 code and reads as one.
 *
 * ## Why the output length is the check
 *
 * Nothing in a resource says it is a picture. What says so is that decoding it
 * produces exactly the bytes a screen takes — and that is a real test, because
 * a wrong decoder desynchronises within a few hundred bytes and stops at an
 * arbitrary length. A correct one over a fixed-format game's data yields a
 * handful of exact sizes rather than a scatter.
 */

/** The favourites table: 256 indices of four candidate bytes. */
const TABLE_BYTES = 0x400;

/** Where the literal stream's start offset is stored. */
const LITERAL_POINTER = 0x400;

/** Where the bit stream begins. */
const BIT_STREAM_START = 0x404;

export class LureDecodeError extends Error {}

/**
 * Decompresses a picture resource.
 *
 * `limit` bounds the output so a corrupt or misidentified resource cannot run
 * away; exceeding it is an error rather than a truncation, because something
 * that decoded to more than a screen was not the thing this was asked to read.
 */
export function decodeLurePicture(source: Uint8Array, limit: number): Uint8Array {
  if (source.length <= BIT_STREAM_START) {
    throw new LureDecodeError(
      `A compressed Lure picture carries a ${TABLE_BYTES}-byte table, a stream pointer and two ` +
        `streams, so it cannot be ${source.length} bytes.`,
    );
  }

  const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
  const out = new Uint8Array(limit);
  let written = 0;

  /** The literal stream. `DSSI` in the original. */
  let literalAt = view.getUint32(LITERAL_POINTER, true);
  /** The bit stream. `ESBX` in the original. */
  let bitAt = BIT_STREAM_START;

  if (literalAt >= source.length) {
    throw new LureDecodeError(
      `This resource says its literal stream starts at ${literalAt} and it is ` +
        `${source.length} bytes, so it is not a compressed picture.`,
    );
  }

  const literal = (): number => {
    // The original reads a zero one byte past the end rather than failing, and
    // a stream ending exactly on a boundary relies on it.
    if (literalAt > source.length) throw new LureDecodeError('The literal stream ran out.');
    return literalAt === source.length ? 0 : source[literalAt++];
  };

  const nextBitByte = (): number => {
    if (bitAt >= source.length) throw new LureDecodeError('The bit stream ran out.');
    return source[bitAt++];
  };

  let bits = nextBitByte();
  let bitsLeft = 9;

  /** `decrCtr`: spend a bit, reloading the byte when the ninth is asked for. */
  const spend = (): void => {
    bitsLeft -= 1;
    if (bitsLeft === 0) {
      bits = nextBitByte();
      bitsLeft = 8;
    }
  };

  /** `shlCarry`: the top bit, consumed. */
  const takeBit = (): boolean => {
    const set = (bits & 0x80) !== 0;
    bits = (bits << 1) & 0xff;
    return set;
  };

  const write = (value: number): void => {
    if (written >= limit) {
      throw new LureDecodeError(
        `The decoded picture passed ${limit} bytes, so this resource is not one.`,
      );
    }
    out[written++] = value;
  };

  const writeRun = (value: number, count: number): void => {
    if (written + count > limit) {
      throw new LureDecodeError(
        `A run of ${count} bytes would pass ${limit}, so this resource is not a picture.`,
      );
    }
    out.fill(value, written, written + count);
    written += count;
  };

  let running = true;
  while (running) {
    let value = literal();
    write(value);
    let index = value << 2;

    for (;;) {
      spend();
      if (takeBit()) {
        spend();
        if (takeBit()) {
          spend();
          // Three bits set: this run of predictions is over and the next byte
          // comes from the literal stream again.
          if (takeBit()) break;
          value = source[index + 3];
        } else {
          spend();
          value = takeBit() ? source[index + 2] : source[index + 1];
        }
      } else {
        spend();
        if (takeBit()) {
          // A run, or the end. `AL` is the current index's byte and `AH` the
          // count; a zero count means the stream is signalling rather than
          // repeating.
          value = index >> 2;
          const count = literal();
          if (count === 0) {
            const marker = literal();
            if (marker === 0) {
              running = false;
              break;
            }
            continue;
          }
          writeRun(value, count);
          continue;
        }
        value = source[index];
      }

      write(value);
      index = value << 2;
    }
  }

  return out.subarray(0, written);
}
