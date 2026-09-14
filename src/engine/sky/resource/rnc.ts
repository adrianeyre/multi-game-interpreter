/**
 * RNC ProPack method 1, which is what Beneath a Steel Sky's compressed
 * resources arrive in.
 *
 * Not a Sky format — it is Rob Northen's general-purpose packer, sold to a
 * dozen studios — so this is written against the format rather than against
 * Sky, and it is placed here only because Sky is the one family in this project
 * that meets it.
 *
 * ## The codec is identified from the bytes, never assumed
 *
 * Every resource carries `RNC\x01` at its own start, so nothing here has to be
 * told what a resource holds: `looksRncPacked` reads the marker and the caller
 * decompresses or passes the bytes through. #252 asks for exactly this, and it
 * matters because ~14% of the floppy release's resources and ~6% of the CD's
 * are stored rather than packed, with no index field distinguishing them.
 *
 * ## Why this can be trusted before anything draws with it
 *
 * The 18-byte header carries a CRC of the packed bytes *and* a CRC of the
 * unpacked ones. So a decompressor is checkable against real shipped data
 * without an interpreter, a renderer, or a person looking at a picture — which
 * is the escape from Tier 1's trap in
 * `docs/processes/verifying-version-support.md` that this family is otherwise
 * short of.
 *
 * Measured over the two shipped releases: **5,907 of 5,907 packed resources
 * decompress to their declared length with the declared CRC** — 1,139 in the
 * floppy release and 4,768 in the CD one. That is every compressed byte
 * Revolution shipped, not a sample.
 *
 * ## The two-halves bit reader is the whole of the difficulty
 *
 * The stream interleaves Huffman-coded bits with **raw literal bytes taken from
 * the byte stream**, which is why the reader keeps a 16-bit lookahead half
 * (`high`) behind the 16 bits it is serving from (`low`): after a literal run
 * the byte cursor has moved, and the bits still owed to the caller have to be
 * refilled from wherever it landed. A reader that models the stream as one flat
 * bit buffer decodes the first block correctly and then drifts — which is worth
 * saying plainly, because that is what this decoder did before it was fixed,
 * and the first block looked entirely convincing.
 *
 * Transcribed from ScummVM's `Common::RncDecoder` (GPL, as this project is),
 * the same relationship this project's SCI Kernel tables have to theirs.
 */

/** `RNC\x01`. Method 2 exists and Sky does not use it; see `looksRncPacked`. */
const SIGNATURE = [0x52, 0x4e, 0x43, 0x01] as const;

/** Signature, two lengths, two CRCs, leeway, block count. */
export const RNC_HEADER_BYTES = 18;

/** A match is never shorter than this, so the length code carries `n - 2`. */
const MIN_MATCH = 2;

export class RncError extends Error {}

/**
 * True when these bytes begin an RNC ProPack method 1 stream.
 *
 * Deliberately narrow: method 2 shares the first three bytes and is a different
 * algorithm, so a method 2 stream answers `false` here and is refused loudly by
 * `rncUnpack` rather than being fed to the wrong decoder.
 */
export function looksRncPacked(bytes: Uint8Array, at = 0): boolean {
  if (at + RNC_HEADER_BYTES > bytes.length) return false;
  return SIGNATURE.every((byte, i) => bytes[at + i] === byte);
}

/** What the header declares, read without decompressing anything. */
export interface RncHeader {
  readonly unpackedLength: number;
  readonly packedLength: number;
  readonly unpackedCrc: number;
  readonly packedCrc: number;
  /** Overlap allowance for in-place unpacking. Carried, not used. */
  readonly leeway: number;
  readonly blocks: number;
}

export function readRncHeader(bytes: Uint8Array, at = 0): RncHeader {
  if (!looksRncPacked(bytes, at)) {
    throw new RncError(
      `These bytes do not begin with RNC ProPack method 1's marker, so they are not an ` +
        `RNC\\x01 stream. Check with looksRncPacked before unpacking: Sky stores roughly ` +
        `one resource in ten uncompressed, and those must be passed through untouched.`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    unpackedLength: view.getUint32(at + 4, false),
    packedLength: view.getUint32(at + 8, false),
    unpackedCrc: view.getUint16(at + 12, false),
    packedCrc: view.getUint16(at + 14, false),
    leeway: bytes[at + 16],
    blocks: bytes[at + 17],
  };
}

/**
 * The CRC-16 RNC checks its own work with: reflected, polynomial 0xA001.
 *
 * Computed a bit at a time rather than from a table. A 256-entry table is four
 * times faster and this runs once per resource at load, so the table would buy
 * nothing and cost the reader a page of numbers nobody can check by eye.
 */
export function rncCrc(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
  }
  return crc & 0xffff;
}

/**
 * The interleaved bit-and-byte reader.
 *
 * `low` serves the caller, `high` is the lookahead behind it, and `cursor` is
 * the byte the next literal run would start at. Keeping all three explicit is
 * what makes `takeLiterals` a two-line method instead of a comment apologising
 * for a magic re-priming step.
 */
class RncBitReader {
  private low: number;
  private high = 0;
  private available = 0;
  private cursor: number;
  private left: number;

  constructor(
    private readonly src: Uint8Array,
    at: number,
    packedLength: number,
  ) {
    this.cursor = at;
    this.left = packedLength;
    this.low = this.word(at);
  }

  private word(at: number): number {
    return ((this.src[at] ?? 0) | ((this.src[at + 1] ?? 0) << 8)) & 0xffff;
  }

  /** The next 16 bits without consuming them, which is how a code is matched. */
  peek(): number {
    return this.low;
  }

  bits(amount: number): number {
    let high = this.high;
    let low = this.low;
    let available = this.available;
    let wanted = amount;

    const taken = ((1 << wanted) - 1) & low;
    available -= wanted;

    if (available < 0) {
      available += wanted;
      const carried = (high << (16 - available)) & 0xffff;
      low = (low >>> available) | carried;
      this.cursor += 2;
      this.left -= 2;
      // The lookahead half is refilled rather than shifted: whatever was left
      // in it has just been carried into `low`. ScummVM shifts it first and
      // then overwrites it, which is a dead store rather than a step.
      high = this.refill(this.cursor);
      wanted -= available;
      available = 16 - wanted;
    }

    const carried = (high << (16 - wanted)) & 0xffff;
    this.high = (high >>> wanted) & 0xffff;
    this.low = ((low >>> wanted) | carried) & 0xffff;
    this.available = available;
    return taken;
  }

  /**
   * Copies raw bytes out of the stream and re-primes the bit halves after them.
   *
   * The re-priming is the part that has to be exactly right: the bits already
   * handed out of `low` are kept (`low & ((1 << available) - 1)`) and the rest
   * refilled from the new cursor, so a literal run does not cost the decoder
   * the partial word it was in the middle of.
   */
  takeLiterals(into: Uint8Array, at: number, count: number): void {
    for (let i = 0; i < count; i += 1) into[at + i] = this.src[this.cursor + i] ?? 0;
    this.cursor += count;
    this.left -= count;

    const a = this.refill(this.cursor);
    const b = this.refillAhead(this.cursor);
    this.low =
      ((this.low & ((1 << this.available) - 1)) | ((a << this.available) & 0xffff)) & 0xffff;
    this.high = (((a >>> (16 - this.available)) | (b << this.available)) & 0xffff) >>> 0;
  }

  /** Zero past the end rather than reading a neighbouring resource's bytes. */
  private refill(at: number): number {
    if (this.left <= 0) return 0;
    if (this.left === 1) return this.src[at] ?? 0;
    return this.word(at);
  }

  private refillAhead(at: number): number {
    if (this.left <= 2) return 0;
    if (this.left === 3) return this.src[at + 2] ?? 0;
    return this.word(at + 2);
  }
}

/** One decoded Huffman code: the mask it matches under, its bits, its value. */
interface RncCode {
  readonly mask: number;
  readonly code: number;
  readonly length: number;
  readonly value: number;
}

/**
 * Reads one of the three per-block Huffman tables.
 *
 * Canonical: five bits of code count, then four bits of length per code, and
 * the codes themselves follow from the lengths. Each code is mirrored because
 * the stream is read least-significant-bit first while the codes are assigned
 * most-significant-first — the same inversion `dcl.ts` calls out, for the same
 * reason: a decoder that forgets it produces plausible output and then drifts.
 */
function readTable(reader: RncBitReader): RncCode[] {
  const codes: RncCode[] = [];
  const count = reader.bits(5);
  if (count === 0) return codes;

  const lengths: number[] = [];
  for (let i = 0; i < count; i += 1) lengths.push(reader.bits(4) & 0xff);

  let next = 0;
  for (let length = 1; length < 17; length += 1) {
    for (let i = 0; i < count; i += 1) {
      if (lengths[i] !== length) continue;
      const forward = next >>> (16 - length);
      let mirrored = 0;
      for (let bit = 0; bit < length; bit += 1) {
        mirrored |= ((forward >>> bit) & 1) << (length - bit - 1);
      }
      codes.push({ mask: (1 << length) - 1, code: mirrored, length, value: i });
      next = (next + (1 << (16 - length))) & 0xffff;
    }
  }
  return codes;
}

/**
 * Reads one value through a table.
 *
 * A code's *value* is a bit width rather than a number whenever it is 2 or
 * more: the value stands for `1 << (n - 1)` with `n - 1` further bits below it.
 * That is what lets one 13-entry table cover match lengths from 2 to 4,097,
 * and it is why a run of 3,000 identical bytes in a background image is
 * expressible at all.
 */
function readValue(reader: RncBitReader, table: readonly RncCode[]): number {
  const peeked = reader.peek();
  const found = table.find((code) => (code.mask & peeked) === code.code);
  if (!found) {
    throw new RncError(
      `No Huffman code in this block's table matches the next bits. The stream is corrupt, ` +
        `or the resource's declared length sent the reader past its own data.`,
    );
  }
  reader.bits(found.length);

  let value = found.value;
  if (value >= 2) {
    value -= 1;
    value = reader.bits(value) | (1 << value);
  }
  return value;
}

/**
 * Unpacks an RNC method 1 stream, checking both CRCs.
 *
 * Refuses rather than returning something partial, and says which check failed.
 * A packed-CRC failure means the bytes reaching here are wrong — a bad index
 * read, most likely; an unpacked-CRC failure means this decoder is wrong, and
 * those are worth telling apart in a message rather than in a debugger.
 */
export function rncUnpack(bytes: Uint8Array, at = 0): Uint8Array {
  const header = readRncHeader(bytes, at);
  const packedAt = at + RNC_HEADER_BYTES;

  if (packedAt + header.packedLength > bytes.length) {
    throw new RncError(
      `This RNC stream declares ${header.packedLength} packed bytes but only ` +
        `${bytes.length - packedAt} are present. The resource is truncated.`,
    );
  }

  const packed = bytes.subarray(packedAt, packedAt + header.packedLength);
  if (rncCrc(packed) !== header.packedCrc) {
    throw new RncError(
      `This RNC stream's packed bytes do not match the CRC in its own header, so the bytes ` +
        `reaching the decompressor are not the ones that were compressed. Suspect the index ` +
        `read rather than the decompressor.`,
    );
  }

  const out = new Uint8Array(header.unpackedLength);
  const reader = new RncBitReader(bytes, packedAt, header.packedLength);
  let written = 0;

  reader.bits(2);
  for (let block = 0; block < header.blocks; block += 1) {
    const literals = readTable(reader);
    const offsets = readTable(reader);
    const lengths = readTable(reader);

    let pairs = reader.bits(16);
    do {
      const run = readValue(reader, literals);
      if (run > 0) {
        if (written + run > out.length) {
          throw new RncError(
            `A literal run overruns the declared unpacked length of ${out.length} bytes.`,
          );
        }
        reader.takeLiterals(out, written, run);
        written += run;
      }

      // The last pair of a block is a literal run with no match after it, which
      // is how a block ends on a byte the compressor could not match.
      if (pairs > 1) {
        const distance = readValue(reader, offsets) + 1;
        let length = readValue(reader, lengths) + MIN_MATCH;
        if (distance > written) {
          throw new RncError(
            `A match reaches ${distance} bytes back with only ${written} decoded, which no ` +
              `valid stream does. The reader has lost the bit stream's position.`,
          );
        }
        if (written + length > out.length) {
          throw new RncError(
            `A match overruns the declared unpacked length of ${out.length} bytes.`,
          );
        }
        let from = written - distance;
        while (length-- > 0) out[written++] = out[from++];
      }
      pairs -= 1;
    } while (pairs > 0);
  }

  if (written !== header.unpackedLength) {
    throw new RncError(
      `This RNC stream declares ${header.unpackedLength} unpacked bytes and produced ` +
        `${written}. The decompressor stopped early rather than guessing at the rest.`,
    );
  }
  if (rncCrc(out) !== header.unpackedCrc) {
    throw new RncError(
      `This RNC stream unpacked to ${written} bytes whose CRC disagrees with the one in its ` +
        `header. The length is right and the content is not, which points at the ` +
        `decompressor rather than at the file.`,
    );
  }
  return out;
}
