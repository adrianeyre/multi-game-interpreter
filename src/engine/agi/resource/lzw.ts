/**
 * AGI v3's compression: adaptive LZW, and the separate scheme for Pictures.
 *
 * v3 changed resource *packaging* and nothing else — the instruction encoding
 * is shared with v2 — so this file is the whole of what "AGI v3" means beyond a
 * different index (#132).
 */

/** Codes 0-255 are literals; 256 resets the table and 257 ends the resource. */
const RESET_CODE = 256;
const END_CODE = 257;

/**
 * The widest code this decoder will read.
 *
 * ScummVM's `setBits` returns early when asked for 12, so its width never
 * actually reaches `MAXBITS` and is effectively capped at 11. Mirrored here
 * rather than "fixed", because the cap is part of the behaviour real games were
 * compressed against: a wider code would read bits the encoder never wrote.
 */
const MAX_CODE_BITS = 11;

/** Room for every code either side can name, so a walk cannot index past it. */
const TABLE_SIZE = 1 << 12;

/**
 * A cursor that reads codes of a growing bit width, least-significant first.
 *
 * AGI packs codes low bits first within each byte, which is the opposite of the
 * order a big-endian reading would produce — and the failure mode of getting it
 * wrong is not an error but a stream of plausible-looking wrong bytes.
 */
class BitReader {
  private readonly data: Uint8Array;
  private position = 0;
  private bitBuffer = 0;
  private bitCount = 0;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  /**
   * The next `bits`-wide code, or the end code once the input runs out.
   *
   * Answering with the end code rather than null is what lets the caller be one
   * loop with one exit: a truncated stream and a properly terminated one both
   * stop in the same place, which is the behaviour a malformed resource needs.
   */
  read(bits: number): number {
    while (this.bitCount < bits) {
      if (this.position >= this.data.length) {
        if (this.bitCount === 0) return END_CODE;
        break;
      }
      this.bitBuffer |= this.data[this.position++] << this.bitCount;
      this.bitCount += 8;
    }
    const value = this.bitBuffer & ((1 << bits) - 1);
    this.bitBuffer >>>= bits;
    this.bitCount = Math.max(0, this.bitCount - bits);
    return value;
  }
}

/**
 * Decompresses a LOGIC, VIEW or SOUND resource.
 *
 * Adaptive LZW: codes start nine bits wide and grow as the dictionary fills,
 * 256 clears the table and drops back to nine bits, and 257 ends the resource.
 *
 * **The bookkeeping is transcribed from ScummVM's `lzw.cpp` rather than derived
 * from the format description, and the two do not agree.** The width grows when
 * the next free code exceeds `(1 << bits) - 2` — two below the power of two, not
 * one — and the check sits *before* the new entry is stored rather than after.
 * That is one code earlier than a naive reading gives, and being one code out
 * does not produce an error: it produces a stream of plausible-looking wrong
 * bytes, because every code after the divergence is read at the wrong width.
 *
 * The other transcribed oddity is that `next` starts at **257** and not 258.
 * Every compressed resource opens with a reset code, which the pre-loop reads
 * as the *previous* code; the first real iteration therefore defines an entry
 * with a meaningless prefix — and it defines it at 257, which is the end code's
 * slot and is never used as a prefix. So the garbage is harmless, and starting
 * at 258 instead would shift every subsequent entry number by one.
 *
 * `expectedLength` is the uncompressed size from the volume header, and it is a
 * bound rather than a hint: a stream that would produce more than that is
 * truncated at it, because the alternative is a malformed resource growing
 * until the tab runs out of memory.
 */
export function lzwDecompress(compressed: Uint8Array, expectedLength: number): Uint8Array {
  const out = new Uint8Array(expectedLength);
  let written = 0;

  const reader = new BitReader(compressed);
  // Each entry is a prefix code plus one appended byte, which is how LZW
  // dictionaries are built — two flat arrays rather than strings, so a long
  // entry costs a walk rather than a concatenation per code.
  const prefix = new Int32Array(TABLE_SIZE);
  const appended = new Uint8Array(TABLE_SIZE);
  const stack = new Uint8Array(TABLE_SIZE);

  let bits = 9;
  let maxCode = (1 << bits) - 2;
  let next = 257;

  let previous = reader.read(bits);
  let firstByte = previous & 0xff;
  let code = reader.read(bits);

  /**
   * Walks an entry back to its first byte, filling `stack` in reverse.
   *
   * Returns the depth. The byte at `depth - 1` is the entry's *first* byte,
   * which is both what gets written first and what the next dictionary entry
   * appends.
   */
  const expand = (from: number, at: number): number => {
    let walk = from;
    let depth = at;
    while (walk > 0xff && depth < TABLE_SIZE) {
      stack[depth++] = appended[walk];
      walk = prefix[walk];
    }
    if (depth < TABLE_SIZE) stack[depth++] = walk & 0xff;
    return depth;
  };

  while (written < expectedLength && code !== END_CODE) {
    if (code === RESET_CODE) {
      // A reset drops back to nine bits and starts the dictionary again at 258
      // — not 257, which is only the pre-loop's value.
      next = 258;
      bits = 9;
      maxCode = (1 << bits) - 2;
      previous = reader.read(bits);
      firstByte = previous & 0xff;
      out[written++] = firstByte;
      code = reader.read(bits);
      continue;
    }

    // A code at or past the next free index is LZW's legitimate special case:
    // the encoder emitted an entry it was defining in the same step, so it
    // means "the previous entry, then its own first byte".
    let depth: number;
    if (code >= next) {
      stack[0] = firstByte;
      depth = expand(previous, 1);
    } else {
      depth = expand(code, 0);
    }

    firstByte = stack[depth - 1];
    for (let i = depth - 1; i >= 0 && written < expectedLength; i--) out[written++] = stack[i];

    if (next > maxCode && bits < MAX_CODE_BITS) {
      bits++;
      maxCode = (1 << bits) - 2;
    }
    if (next < TABLE_SIZE) {
      prefix[next] = previous;
      appended[next] = firstByte;
      next++;
    }

    previous = code;
    code = reader.read(bits);
  }

  return written === expectedLength ? out : out.subarray(0, written);
}

/**
 * Un-nibbles a v3 PICTURE resource.
 *
 * Pictures are not LZW-compressed. They are the same draw-command stream a v2
 * Picture holds, with one change: because there are only sixteen colours, the
 * argument to `set visual colour` (0xF0) and `set priority colour` (0xF2) is
 * packed into a *nibble* rather than a byte. Everything after such an opcode is
 * therefore off the byte boundary by four bits, and stays that way until the
 * next one.
 *
 * The spec's own example, which is the clearest statement of it:
 *
 *   plain:      F0 06 F8 12 45 F0 07 F2 05 F8 14 67
 *   as stored:  F0 6F 81 24 5F 07 F2 5F 81 46 7
 *
 * This is the part of v3 "most likely to be got wrong" (#132), and the reason
 * is that getting it wrong produces a picture rather than an error: the stream
 * stays a valid-looking sequence of commands and draws the wrong thing.
 *
 * Note the volume header does not say a Picture is nibble-packed by comparing
 * lengths — the compressed and uncompressed sizes differ, which for any other
 * resource would mean LZW. What distinguishes it is the **top bit of byte 2**
 * of the header, which is why that bit is masked off before the byte is read as
 * a volume number.
 */
export function unpackPicture(packed: Uint8Array, expectedLength: number): Uint8Array {
  const out = new Uint8Array(expectedLength);
  let written = 0;

  // Position measured in nibbles, so stepping over a colour argument is +1 and
  // reading an ordinary byte is +2 from wherever it left off.
  let nibble = 0;
  const totalNibbles = packed.length * 2;

  const readNibble = (): number => {
    const byte = packed[nibble >> 1];
    const value = (nibble & 1) === 0 ? byte >> 4 : byte & 0x0f;
    nibble++;
    return value;
  };

  while (nibble + 1 < totalNibbles && written < expectedLength) {
    const code = (readNibble() << 4) | readNibble();
    out[written++] = code;

    if (code === 0xf0 || code === 0xf2) {
      if (nibble >= totalNibbles || written >= expectedLength) break;
      out[written++] = readNibble();
    }
  }

  return written === expectedLength ? out : out.subarray(0, written);
}
