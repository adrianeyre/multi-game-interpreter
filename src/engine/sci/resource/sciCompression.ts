/**
 * Every compression method a SCI resource can arrive in.
 *
 * A resource header carries its own method number, and what that number *means*
 * depends on the Version — number 1 is LZW at SCI0 and SCI01 and Huffman from
 * SCI1 on, with number 2 the other way round. So the mapping is a function of
 * the Version rather than a table, and getting it backwards yields a
 * full-length output of plausible bytes rather than an error.
 *
 * Transcribed from ScummVM's `engines/sci/resource/decompressor.cpp` and
 * `Resource::readResourceInfo`, not from what this project's own reader
 * expects. `docs/processes/verifying-version-support.md` is explicit that a
 * fixture written the other way round means the fixture and the engine agree
 * with each other and disagree with the game.
 *
 * **An unknown method reports itself.** It does not fall through to a raw copy,
 * because a raw copy of compressed bytes is a resource of the right length made
 * of noise, and every report about engine state downstream of it looks correct.
 */

import { LsbBitReader, MsbBitReader } from './BitReader.js';
import { decompressDcl } from './dcl.js';
import { atLeast, type SciVersion } from '../sciVersion.js';

export type SciCompression =
  | 'none'
  /** SCI0's LZW: 9-to-12-bit codes, LSB-first, table limit 512. */
  | 'lzw'
  /** Huffman over a node table the resource carries in its own header. */
  | 'huffman'
  /** SCI01 and SCI1's LZW: MSB-first, and it grows the code width one code early. */
  | 'lzw1'
  /** `lzw1`, then a View is rebuilt out of the result. */
  | 'lzw1-view'
  /** `lzw1`, then a Picture is rebuilt out of the result. */
  | 'lzw1-pic'
  /** PKWARE DCL implode, from SCI1.1. */
  | 'dcl'
  /** STACpack/LZS, SCI32 only. */
  | 'stacpack';

/**
 * What a header's method number means at a given Version.
 *
 * Returns null for a number this project does not know, which the caller turns
 * into a message naming the number and the Version — SCI's characteristic
 * failure is silent and this is one of the places it would be.
 */
export function compressionFor(method: number, version: SciVersion): SciCompression | null {
  switch (method) {
    case 0:
      return 'none';
    case 1:
      // The swap. `getSciVersion() <= SCI_VERSION_01 ? kCompLZW : kCompHuffman`.
      return atLeast(version, 'sci1-ega-only') ? 'huffman' : 'lzw';
    case 2:
      return atLeast(version, 'sci1-ega-only') ? 'lzw1' : 'huffman';
    case 3:
      return 'lzw1-view';
    case 4:
      return 'lzw1-pic';
    case 18:
    case 19:
    case 20:
      return 'dcl';
    case 32:
      return 'stacpack';
    default:
      return null;
  }
}

/** Thrown rather than returned, because there is no safe partial answer. */
export class SciCompressionError extends Error {}

/**
 * Decompresses one resource body.
 *
 * `unpackedSize` comes from the resource's own header and is the length the
 * output must reach. A short result is an error rather than a truncated
 * resource: everything above reads a resource by structure, so a short one
 * parses as a different resource instead of failing.
 */
export function decompressSci(
  method: SciCompression,
  packed: Uint8Array,
  unpackedSize: number,
): Uint8Array {
  switch (method) {
    case 'none':
      return packed.subarray(0, unpackedSize);
    case 'lzw':
      return lzw(packed, unpackedSize, false);
    case 'lzw1':
      return lzw(packed, unpackedSize, true);
    case 'lzw1-view':
      return unpackView(lzw(packed, unpackedSize, true, true), unpackedSize);
    case 'lzw1-pic':
      return unpackPic(lzw(packed, unpackedSize, true, true), unpackedSize);
    case 'huffman':
      return huffman(packed, unpackedSize);
    case 'dcl':
      return decompressDcl(packed, unpackedSize);
    case 'stacpack':
      return lzs(packed, unpackedSize);
  }
}

// ------------------------------------------------------------------- LZW ---

/**
 * SCI's LZW, both variants.
 *
 * `early` selects SCI01/SCI1's reading: MSB-first bits, and a code width that
 * grows one code before the table is full. The dictionary is two parallel
 * arrays of offsets and lengths into the *output*, which is how Sierra's own
 * decoder worked and why an entry's length is "bytes written since the entry
 * started, plus one" — the plus one is the next byte, not yet emitted.
 *
 * `loose` allows the terminator to arrive before `unpackedSize` is reached,
 * which is correct for the View and Picture variants: there `unpackedSize`
 * describes the *rebuilt* resource, not the LZW output.
 */
function lzw(packed: Uint8Array, unpackedSize: number, early: boolean, loose = false): Uint8Array {
  const out = new Uint8Array(unpackedSize);
  const reader = early ? new MsbBitReader(packed) : new LsbBitReader(packed);
  const offsets = new Uint16Array(4096);
  const lengths = new Uint16Array(4096);

  let width = 9;
  let size = 258;
  let limit = early ? 511 : 512;
  let wrote = 0;
  let done = false;

  while (wrote < unpackedSize) {
    const code = reader.take(width);
    if (code >= size) {
      throw new SciCompressionError(
        `LZW code 0x${code.toString(16)} is past the end of a dictionary of ${size} entries, ` +
          `so the bit order or the code width is being read wrongly.`,
      );
    }
    if (code === 257) {
      done = true;
      break;
    }
    if (code === 256) {
      width = 9;
      size = 258;
      limit = early ? 511 : 512;
      continue;
    }

    const started = wrote;
    if (code <= 255) {
      out[wrote++] = code;
    } else {
      const from = offsets[code];
      const length = lengths[code];
      for (let i = 0; i < length && wrote < unpackedSize; i++) out[wrote++] = out[from + i];
    }

    if (size < 4096) {
      if (size === limit && width < 12) {
        width++;
        limit = 1 << width;
        if (early) limit--;
      }
      offsets[size] = started;
      lengths[size] = wrote - started + 1;
      size++;
    }

    if (reader.exhausted && wrote < unpackedSize) break;
  }

  if (!done && wrote !== unpackedSize && !loose) {
    throw new SciCompressionError(
      `LZW produced ${wrote} of ${unpackedSize} bytes and never reached its terminator.`,
    );
  }

  // **`loose` returns what was written, not the buffer it was written into.**
  //
  // For the View and Picture variants `unpackedSize` describes the *rebuilt*
  // resource and not this stream, so the buffer is routinely a few hundred
  // bytes longer than the stream — Space Quest 1's Pictures run 280 to 340
  // bytes short of theirs. The rebuild then reads its trailing block from the
  // *end of the buffer*, which is that many bytes of zero padding, and its
  // run-length stream runs on into the same padding.
  //
  // The arithmetic says so exactly: for the Christmas Card 1990's first
  // Picture, a run-length stream bounded by the buffer gives 6,062 control
  // bytes against 29,740 literals, which is 35,802 output bytes where the cel
  // declares 35,538. Bounded by what LZW actually wrote it is 5,798 and 29,740,
  // which is 35,538 to the byte.
  return loose ? out.subarray(0, wrote) : out;
}

// --------------------------------------------------------------- Huffman ---

/**
 * Huffman over a node table the resource carries in front of its own data.
 *
 * Three bytes of header — a node count, a terminator symbol, and then two bytes
 * per node — and the tree is walked a single MSB bit at a time. A node's second
 * byte is two nibbles of *node-pair delta*, and a zero nibble on the 1 branch
 * means "the next eight bits are a literal", which is how bytes the tree has no
 * code for still get through.
 */
function huffman(packed: Uint8Array, unpackedSize: number): Uint8Array {
  if (packed.length < 2) {
    throw new SciCompressionError('A Huffman resource is shorter than its own header.');
  }
  const nodeCount = packed[0];
  const terminator = packed[1] | 0x100;
  const nodes = packed.subarray(2, 2 + nodeCount * 2);
  const reader = new MsbBitReader(packed.subarray(2 + nodeCount * 2));

  const out = new Uint8Array(unpackedSize);
  let wrote = 0;

  while (wrote < unpackedSize) {
    let at = 0;
    let value: number;
    for (;;) {
      const branch = nodes[at + 1];
      if (branch === 0) {
        value = nodes[at] | (nodes[at + 1] << 8);
        break;
      }
      let next: number;
      if (reader.take(1) === 1) {
        next = branch & 0x0f;
        if (next === 0) {
          value = reader.byte() | 0x100;
          break;
        }
      } else {
        next = branch >> 4;
        // **A zero step on this side is not a leaf, it is a node pointing at
        // itself.** Nothing advances, the bit reader runs dry, an exhausted
        // reader answers zero to every question, and the loop takes that same
        // branch forever. Found by pointing this at Castle of Dr. Brain: the
        // compression-era probe reads a sound resource under the *wrong* codec
        // on purpose — that is the whole probe — and one of them hung the
        // detector rather than failing, so the game never identified at all.
        //
        // Refused rather than clamped, because on this path a malformed tree is
        // the expected outcome half the time and the caller is asking which
        // codec fails.
        if (next === 0) {
          throw new SciCompressionError('A Huffman node steps nowhere, so its tree is not a tree.');
        }
      }
      at += next << 1;
      if (at + 1 >= nodes.length) {
        throw new SciCompressionError('A Huffman code walked outside its own node table.');
      }
      // A code that runs past the end of the bit stream is a code this data
      // does not contain. Without this, a tree that happens to keep stepping
      // reads zeroes off the end for as long as the tree is deep.
      if (reader.exhausted) {
        throw new SciCompressionError('A Huffman code ran past the end of its own bit stream.');
      }
    }

    if (value === terminator) break;
    out[wrote++] = value & 0xff;
    if (reader.exhausted && wrote < unpackedSize) break;
  }

  if (wrote !== unpackedSize) {
    throw new SciCompressionError(
      `Huffman produced ${wrote} of ${unpackedSize} bytes before its terminator.`,
    );
  }
  return out;
}

// ------------------------------------------------------- STACpack (LZS) ---

/**
 * STACpack, which SCI32 uses for everything.
 *
 * MSB-first throughout. A back-reference's length comes from a two-level 2-bit
 * prefix with a nibble tail, and `0xf` in the tail is a continuation rather
 * than a length — so a run of them is a long match, and stopping at the first
 * one truncates every large repeat in the resource.
 *
 * The copy is byte-at-a-time out of the output being written, deliberately: an
 * overlapping match (offset shorter than length) is how a repeating pattern is
 * encoded, and a block move would replicate the wrong bytes.
 */
export function lzs(packed: Uint8Array, unpackedSize: number): Uint8Array {
  const out = new Uint8Array(unpackedSize);
  const reader = new MsbBitReader(packed);
  let wrote = 0;

  while (wrote < unpackedSize) {
    if (reader.take(1) === 0) {
      out[wrote++] = reader.byte();
      if (reader.exhausted && wrote < unpackedSize) break;
      continue;
    }

    let offset: number;
    if (reader.take(1) === 1) {
      offset = reader.take(7);
      // A seven-bit offset of zero is the end of the stream, not an offset.
      if (offset === 0) break;
    } else {
      offset = reader.take(11);
    }

    const length = lzsLength(reader);
    const from = wrote - offset;
    if (from < 0) {
      throw new SciCompressionError(
        `STACpack asked for ${offset} bytes back from offset ${wrote}, which is before the start.`,
      );
    }
    for (let i = 0; i < length && wrote < unpackedSize; i++) out[wrote] = out[wrote++ - offset];
    if (reader.exhausted && wrote < unpackedSize) break;
  }

  if (wrote !== unpackedSize) {
    throw new SciCompressionError(`STACpack produced ${wrote} of ${unpackedSize} bytes.`);
  }
  return out;
}

function lzsLength(reader: MsbBitReader): number {
  const first = reader.take(2);
  if (first < 3) return first + 2;
  const second = reader.take(2);
  if (second < 3) return second + 5;

  let length = 8;
  for (;;) {
    const nibble = reader.take(4);
    length += nibble;
    if (nibble !== 0xf) return length;
  }
}

// ------------------------------------------------ View and Pic rebuilding ---

/**
 * The two-stream RLE both post-passes share.
 *
 * Two input streams — control bytes and pixels — and the control byte is
 * written to the output as well as interpreted, because it is part of the cel
 * the interpreter will later read. That is the part that reads as a bug and is
 * not one.
 */
function decodeRle(
  rle: Uint8Array,
  rleAt: number,
  pixels: Uint8Array,
  pixelAt: number,
  dest: Uint8Array,
  destAt: number,
  decodedSize: number,
): { rleAt: number; pixelAt: number } {
  let pos = 0;
  while (pos < decodedSize) {
    const control = rle[rleAt++];
    dest[destAt + pos] = control;
    pos++;
    const kind = control & 0xc0;
    if (kind <= 0x40) {
      for (let i = 0; i < control && pos < decodedSize; i++) {
        dest[destAt + pos] = pixels[pixelAt++];
        pos++;
      }
    } else if (kind === 0x80) {
      dest[destAt + pos] = pixels[pixelAt++];
      pos++;
    }
  }
  return { rleAt, pixelAt };
}

/** The same accounting with nothing written, to find where the next cel starts. */
function skipRle(rle: Uint8Array, rleAt: number, decodedSize: number): number {
  let pos = 0;
  while (pos < decodedSize) {
    const control = rle[rleAt++];
    pos++;
    const kind = control & 0xc0;
    if (kind <= 0x40) pos += control;
    else if (kind === 0x80) pos++;
  }
  return rleAt;
}

function u16(bytes: Uint8Array, at: number): number {
  return bytes[at] | (bytes[at + 1] << 8);
}

/**
 * Rebuilds a View out of the LZW output.
 *
 * Sierra stored a View for these releases as a compact description — loop
 * headers, cel lengths, an RLE stream and a pixel stream apart from it — and
 * the interpreter expanded it into the ordinary View layout before reading it.
 * So this is not decompression: it is the second half of the format, and a
 * reader that skips it gets a View whose loop table points into the middle of
 * its own cel data.
 *
 * Mirrored loops consume no source data and reuse the previous loop's offset,
 * which is where a View's mirroring actually lives.
 */
function unpackView(src: Uint8Array, unpackedSize: number): Uint8Array {
  const dest = new Uint8Array(unpackedSize);
  let seeker = 0;

  const celLengthsAt = u16(src, seeker) + 2;
  seeker += 2;
  const loopCount = src[seeker++];
  const loopHeaderCount = src[seeker++];
  const mirrorMask = u16(src, seeker);
  seeker += 2;
  const version = u16(src, seeker);
  seeker += 2;
  const paletteOffset = u16(src, seeker);
  seeker += 2;
  const celHeaderCount = u16(src, seeker);
  seeker += 2;

  const celCountsAt = seeker;
  seeker += loopHeaderCount;

  const celDecodedLengths: number[] = [];
  for (let i = 0; i < celHeaderCount; i++) {
    celDecodedLengths.push(u16(src, celLengthsAt + i * 2));
  }
  let rleAt = celLengthsAt + celHeaderCount * 2;
  let pixelAt = rleAt;
  for (const length of celDecodedLengths) pixelAt = skipRle(src, pixelAt, length);

  let writer = 0;
  dest[writer++] = loopCount;
  // 0x80 rather than 0: the flags byte of a VGA View with RLE cels, which is
  // what this rebuild produces regardless of how the source stored it.
  dest[writer++] = 0x80;
  dest[writer] = mirrorMask & 0xff;
  dest[writer + 1] = mirrorMask >> 8;
  dest[writer + 2] = version & 0xff;
  dest[writer + 3] = version >> 8;
  dest[writer + 4] = paletteOffset & 0xff;
  dest[writer + 5] = paletteOffset >> 8;
  writer += 6;

  let loopOffsets = writer;
  writer += 2 * loopCount;

  let celTableIndex = 0;
  let loopTableIndex = 0;
  for (let loop = 0; loop < loopCount; loop++) {
    if (mirrorMask & (1 << loop)) {
      dest[loopOffsets] = dest[loopOffsets - 2];
      dest[loopOffsets + 1] = dest[loopOffsets - 1];
    } else {
      dest[loopOffsets] = writer & 0xff;
      dest[loopOffsets + 1] = writer >> 8;

      const celCount = src[celCountsAt + loopTableIndex];
      dest[writer++] = celCount;
      dest[writer++] = 0;
      dest[writer++] = 0;
      dest[writer++] = 0;

      let celOffset = writer - 0 + 2 * celCount;
      const celTable = writer;
      writer += 2 * celCount;
      for (let cel = 0; cel < celCount; cel++) {
        dest[celTable + cel * 2] = celOffset & 0xff;
        dest[celTable + cel * 2 + 1] = celOffset >> 8;
        celOffset += 8 + celDecodedLengths[celTableIndex + cel];
      }

      for (let cel = 0; cel < celCount; cel++) {
        for (let i = 0; i < 7; i++) dest[writer++] = src[seeker++];
        dest[writer++] = 0;
        const decodedSize = celDecodedLengths[celTableIndex + cel];
        const after = decodeRle(src, rleAt, src, pixelAt, dest, writer, decodedSize);
        rleAt = after.rleAt;
        pixelAt = after.pixelAt;
        writer += decodedSize;
      }
      celTableIndex += src[celCountsAt + loopTableIndex];
      loopTableIndex++;
    }
    loopOffsets += 2;
  }

  if (paletteOffset !== 0) {
    dest[writer++] = 0x50;
    dest[writer++] = 0x41;
    dest[writer++] = 0x4c;
    for (let i = 0; i < 256; i++) dest[writer++] = i;
    // Four bytes taken from *before* the palette, which Sierra's own writer did
    // and the interpreter ignores. Reproduced rather than zeroed so an export
    // can put the resource back as it arrived.
    for (let i = 0; i < 4 + 1024; i++) dest[writer++] = src[seeker - 4 + i];
  }

  return dest;
}

/** The size of the set-palette instruction `unpackPic` emits first. */
const PIC_SET_PALETTE_SIZE = 1286;

/**
 * Rebuilds a Picture out of the LZW output.
 *
 * A Picture of this generation is vector operations with one embedded View cel
 * in the middle of them, and the compressed form hoists that cel out. So the
 * rebuild writes a set-palette instruction, the operations before the cel, the
 * cel as an embedded-view instruction, and then the operations after it — and
 * the last of those are copied to the *end* of the output rather than to the
 * cursor, because that is where the offsets inside the Picture expect them.
 */
function unpackPic(src: Uint8Array, unpackedSize: number): Uint8Array {
  const dest = new Uint8Array(unpackedSize);
  let seeker = 0;
  let writer = 0;

  dest[writer++] = 0xfe;
  dest[writer++] = 0x02;
  for (let i = 0; i < 256; i++) dest[writer++] = i;
  for (let i = 0; i < 4; i++) dest[writer++] = 0;

  const viewCelSize = u16(src, seeker);
  seeker += 2;
  const viewOpPos = u16(src, seeker);
  seeker += 2;
  const viewPixelDataSize = u16(src, seeker);
  seeker += 2;
  const viewHeader = src.subarray(seeker, seeker + 7);
  seeker += 7;

  for (let i = 0; i < 1024; i++) dest[writer++] = src[seeker++];

  if (viewOpPos !== PIC_SET_PALETTE_SIZE) {
    const before = viewOpPos - PIC_SET_PALETTE_SIZE;
    for (let i = 0; i < before; i++) dest[writer++] = src[seeker++];
  }

  const postViewDataPosition = viewOpPos + 15 + viewCelSize;

  dest[writer++] = 0xfe;
  dest[writer++] = 0x01;
  dest[writer++] = 0;
  dest[writer++] = 0;
  dest[writer++] = 0;
  const celSize = 8 + viewCelSize;
  dest[writer++] = celSize & 0xff;
  dest[writer++] = celSize >> 8;
  for (const byte of viewHeader) dest[writer++] = byte;
  dest[writer++] = 0;

  decodeRle(src, seeker + viewPixelDataSize, src, seeker, dest, writer, viewCelSize);

  // The trailing operations go to `postViewDataPosition` rather than to the
  // cursor. That is not a shortcut: a Picture's own instructions carry offsets
  // into the expanded resource, so the tail belongs at the end of the buffer
  // whether or not the cel decoded to exactly the length that would put it
  // there. Which is why the cursor is finished with here and not advanced.
  if (postViewDataPosition !== unpackedSize) {
    const trailing = unpackedSize - postViewDataPosition;
    const from = src.length - trailing;
    for (let i = 0; i < trailing; i++) dest[postViewDataPosition + i] = src[from + i];
  }

  return dest;
}
