/**
 * Decompressing the blocks inside a `.BUN` entry.
 *
 * A `COMP` entry is a table of blocks, each with its own codec number, and each
 * decompressing to a whole `BUNDLE_BLOCK_SIZE` except the last. The codecs
 * share one back end: codec 1 is the bit-stream decoder below, and codecs 2 and
 * 3 are that same output with one or two passes of delta accumulation over it.
 * Codec 0 is stored data.
 *
 * (`BundleCodecs::decompressCodec` and `compDecode`.)
 *
 * The ADPCM codecs (13 and 15) are deliberately absent: ScummVM's own comment
 * names them as the variants used in The Curse of Monkey Island, which is v8.
 * A codec this does not implement is reported by number rather than guessed at,
 * because audio decoded with the wrong codec is noise at the right length —
 * which passes every check except listening.
 */

/** Codecs this can decode. Anything else is named rather than attempted. */
export const BUNDLE_CODECS = [0, 1, 2, 3] as const;

/**
 * The bit-stream decoder codecs 1 to 3 share.
 *
 * A 16-bit mask supplies control bits a bit at a time, refilled from the stream
 * when it runs out. A set bit is a literal byte; a clear bit introduces a
 * back-reference, in one of two lengths.
 *
 * The back-reference offset is **negative** — it reaches into what has already
 * been written — and the copy is deliberately byte-at-a-time rather than a
 * block move, because a run may overlap its own output. That is how a short
 * repeat is encoded, and a block copy would read bytes that have not been
 * written yet.
 */
function decodeBitStream(src: Uint8Array, out: Uint8Array): number {
  let read = 0;
  let write = 0;

  if (src.length < 2) return 0;
  let mask = src[0] | (src[1] << 8);
  read += 2;
  let bitsLeft = 16;

  const nextBit = (): number => {
    const bit = mask & 1;
    mask >>= 1;
    if (--bitsLeft === 0) {
      mask = (src[read] ?? 0) | ((src[read + 1] ?? 0) << 8);
      read += 2;
      bitsLeft = 16;
    }
    return bit;
  };

  for (;;) {
    if (read > src.length + 2 || write >= out.length) return write;

    if (nextBit()) {
      out[write++] = src[read++] ?? 0;
      continue;
    }

    let offset: number;
    let size: number;

    if (!nextBit()) {
      // Short form: a two-bit length and a single offset byte.
      size = nextBit() << 1;
      size = (size | nextBit()) + 3;
      offset = (src[read++] ?? 0) | 0xffffff00;
    } else {
      // Long form: twelve bits of offset split across two bytes, four of
      // length — and a length of three escapes to an end marker.
      const low = src[read++] ?? 0;
      const packed = src[read++] ?? 0;
      offset = low | (0xfffff000 + ((packed & 0xf0) << 4));
      size = (packed & 0x0f) + 3;
      if (size === 3 && (src[read++] ?? 0) + 1 === 1) return write;
    }

    // Sign-extend the offset: it points backwards into the output.
    const from = write + (offset | 0);
    if (from < 0) return write;

    // One byte at a time: a run may overlap its own output, which is how a
    // short repeat is encoded.
    for (let i = 0; i < size && write < out.length; i++) {
      out[write] = out[from + i];
      write++;
    }
  }
}

/**
 * Decompresses one block.
 *
 * Returns null for a codec this does not implement, so the caller can name it
 * by number. Audio decoded with the wrong codec is noise at the right length,
 * which passes every check except listening.
 */
export function decompressBundleBlock(
  codec: number,
  input: Uint8Array,
  outputSize: number,
): Uint8Array | null {
  if (codec === 0) return input.slice(0, Math.min(input.length, outputSize));

  if (codec !== 1 && codec !== 2 && codec !== 3) return null;

  const out = new Uint8Array(outputSize);
  const written = decodeBitStream(input, out);
  const decoded = out.subarray(0, written);

  // Codecs 2 and 3 are codec 1's output with delta accumulation over it: each
  // byte is a difference from the one before, once for codec 2 and twice for
  // codec 3. Applying the wrong number of passes gives audio that is
  // recognisably the right sound and audibly wrong, rather than silence.
  if (codec === 3) {
    for (let i = 2; i < decoded.length; i++) decoded[i] = (decoded[i] + decoded[i - 1]) & 0xff;
  }
  if (codec === 2 || codec === 3) {
    for (let i = 1; i < decoded.length; i++) decoded[i] = (decoded[i] + decoded[i - 1]) & 0xff;
  }

  return decoded;
}
