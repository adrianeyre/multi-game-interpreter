/**
 * PKWARE DCL "implode", which every SCI1.1 resource arrives in.
 *
 * Not a SCI format — it is the compressor Sierra licensed — so this is written
 * against the format rather than against SCI, and the tables are the canonical
 * ones rather than a transcription of anybody's tree. ScummVM's own
 * `DecompressorDCL` is a one-line delegation to `Common::decompressDCL` for the
 * same reason.
 *
 * ## Why the tables are bit lengths and not a tree
 *
 * The three Huffman codes here are canonical: a symbol's code follows from the
 * list of code *lengths* alone, so the tables below are run-length encoded
 * length lists — high nibble plus one is a repeat count, low nibble is the
 * length — and the codes are derived. That is 200 bytes of table instead of
 * around 670 lines of pre-built tree nodes, and, more to the point, a canonical
 * table is checkable: the Kraft sum of each one must be exactly 1, which the
 * tests assert. A transcribed tree can only be checked against the thing it was
 * transcribed from.
 *
 * ## The one thing that surprises
 *
 * DCL reads bits least-significant-first **and inverts each one** as it walks
 * the code. A decoder that does not invert produces a stream of plausible
 * literals for a while and then diverges, which is the worst possible failure
 * shape — so the inversion is spelled out at its one line rather than folded
 * into the bit reader, where it would look like a mistake.
 */

import { LsbBitReader } from './BitReader.js';

/** Longest code any of the three tables produces. */
const MAX_BITS = 13;

/**
 * A canonical Huffman code, as counts per length and symbols in code order.
 *
 * The same representation the reference decoder uses, because it makes
 * decoding a walk down the lengths rather than a walk through nodes — there is
 * no tree to get wrong.
 */
interface Canonical {
  /** How many symbols have each code length, indexed by length. */
  count: Int16Array;
  /** Symbols, ordered by code length and then by symbol number. */
  symbol: Int16Array;
}

/**
 * Builds a canonical code from a run-length encoded list of code lengths.
 *
 * Each byte is `(repeat - 1) << 4 | length`. Throws on a table whose Kraft sum
 * is not one, because such a table is not a complete code and every symbol
 * after the gap decodes to the wrong thing.
 */
function construct(rep: readonly number[], symbols: number): Canonical {
  const lengths = new Uint8Array(symbols);
  let at = 0;
  for (const packed of rep) {
    const repeat = (packed >> 4) + 1;
    const length = packed & 15;
    for (let i = 0; i < repeat; i++) lengths[at++] = length;
  }
  if (at !== symbols) {
    throw new Error(`A DCL code table described ${at} symbols where ${symbols} were expected.`);
  }

  const count = new Int16Array(MAX_BITS + 1);
  for (const length of lengths) count[length]++;

  let left = 1;
  for (let length = 1; length <= MAX_BITS; length++) {
    left <<= 1;
    left -= count[length];
    if (left < 0) throw new Error('A DCL code table is over-subscribed.');
  }

  const offsets = new Int16Array(MAX_BITS + 1);
  for (let length = 1; length < MAX_BITS; length++) {
    offsets[length + 1] = offsets[length] + count[length];
  }
  const symbol = new Int16Array(symbols);
  for (let s = 0; s < symbols; s++) {
    if (lengths[s] !== 0) symbol[offsets[lengths[s]]++] = s;
  }

  return { count, symbol };
}

/** Literal code, used only in the ASCII mode: 256 symbols. */
const LITERAL_LENGTHS = [
  11, 124, 8, 7, 28, 7, 188, 13, 76, 4, 10, 8, 12, 10, 12, 10, 8, 23, 8, 9, 7, 6, 7, 8, 7, 6, 55, 8,
  23, 24, 12, 11, 7, 9, 11, 12, 6, 7, 22, 5, 7, 24, 6, 11, 9, 6, 7, 22, 7, 11, 38, 7, 9, 8, 25, 11,
  8, 11, 9, 12, 8, 12, 5, 38, 5, 38, 5, 11, 7, 5, 6, 21, 6, 10, 53, 8, 7, 24, 10, 27, 44, 253, 253,
  253, 252, 252, 252, 13, 12, 45, 12, 45, 12, 61, 12, 45, 44, 173,
];

/** Length code: 16 symbols, selecting a base length and a count of extra bits. */
const LENGTH_LENGTHS = [2, 35, 36, 53, 38, 23];

/** Distance code: 64 symbols, each shifted by the dictionary size. */
const DISTANCE_LENGTHS = [2, 20, 53, 230, 247, 151, 248];

/** Base match length per length symbol. */
const LENGTH_BASE = [3, 2, 4, 5, 6, 7, 8, 9, 10, 12, 16, 24, 40, 72, 136, 264];

/** Extra bits read after each length symbol. */
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8];

/**
 * The length that means "no more data".
 *
 * 264 plus eight bits of extra, which is the largest the table can express — so
 * the terminator is the top of the range rather than a symbol of its own.
 */
const END_OF_STREAM = 519;

const literalCode = construct(LITERAL_LENGTHS, 256);
const lengthCode = construct(LENGTH_LENGTHS, 16);
const distanceCode = construct(DISTANCE_LENGTHS, 64);

/**
 * Reads one symbol.
 *
 * The inversion is the line that matters: DCL's codes are canonical over
 * *complemented* bits, so a decoder reading them straight walks a mirror image
 * of the intended code and diverges partway through the stream rather than at
 * the first symbol.
 */
function decode(reader: LsbBitReader, code: Canonical): number {
  let first = 0;
  let index = 0;
  let value = 0;

  for (let length = 1; length <= MAX_BITS; length++) {
    value |= reader.take(1) ^ 1;
    const count = code.count[length];
    if (value - count < first) return code.symbol[index + (value - first)];
    index += count;
    first = (first + count) << 1;
    value <<= 1;
  }
  throw new Error('A DCL code ran past thirteen bits without reaching a symbol.');
}

/**
 * Decompresses one DCL-imploded body.
 *
 * The two header bytes are read through the bit reader rather than off the
 * front of the buffer, which matters: DCL's own header is part of its bit
 * stream, and skipping two bytes instead leaves every subsequent code
 * misaligned by whatever the first flag bit was.
 */
export function decompressDcl(packed: Uint8Array, unpackedSize: number): Uint8Array {
  const reader = new LsbBitReader(packed);
  const mode = reader.byte();
  const dictionaryType = reader.byte();

  if (mode !== 0 && mode !== 1) {
    throw new Error(
      `A DCL resource declares literal mode ${mode}, which is neither binary (0) nor ASCII (1).`,
    );
  }
  if (dictionaryType < 4 || dictionaryType > 6) {
    throw new Error(
      `A DCL resource declares dictionary type ${dictionaryType}; only 4, 5 and 6 exist ` +
        `(1K, 2K and 4K).`,
    );
  }

  const out = new Uint8Array(unpackedSize);
  let wrote = 0;

  while (wrote < unpackedSize) {
    if (reader.take(1) === 1) {
      const lengthSymbol = decode(reader, lengthCode);
      const length = LENGTH_BASE[lengthSymbol] + reader.take(LENGTH_EXTRA[lengthSymbol]);
      if (length === END_OF_STREAM) break;

      // A two-byte match is addressed with two extra bits rather than the
      // dictionary's own width, because the nearest matches are the common
      // case and DCL spends fewer bits on them.
      const shift = length === 2 ? 2 : dictionaryType;
      const distance = ((decode(reader, distanceCode) << shift) | reader.take(shift)) + 1;

      if (distance > wrote) {
        throw new Error(
          `A DCL match reaches ${distance} bytes back from offset ${wrote}, which is before ` +
            `the start of the resource.`,
        );
      }
      for (let i = 0; i < length && wrote < unpackedSize; i++) {
        out[wrote] = out[wrote - distance];
        wrote++;
      }
    } else {
      out[wrote++] = mode === 1 ? decode(reader, literalCode) : reader.byte();
    }

    if (reader.exhausted && wrote < unpackedSize) break;
  }

  if (wrote !== unpackedSize) {
    throw new Error(`DCL produced ${wrote} of ${unpackedSize} bytes.`);
  }
  return out;
}

/** Exposed for the tests, which check each table is a complete code. */
export const DCL_TABLES = { literalCode, lengthCode, distanceCode } as const;
