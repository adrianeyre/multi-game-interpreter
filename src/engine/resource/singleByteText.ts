/**
 * Writing text back out in the single-byte encoding it was read in.
 *
 * `TextDecoder` will decode any of the legacy single-byte encodings; nothing in
 * the platform will *encode* one, because `TextEncoder` is UTF-8 and only
 * UTF-8. Every family that keeps its strings as bytes therefore has to build
 * the reverse map itself, and the obvious way to build it is wrong.
 *
 * The obvious way is "the byte is the code point", and it fails on the very
 * first label anyone reaches for: `TextDecoder('latin1')` is a WHATWG *alias
 * for windows-1252*, not for ISO 8859-1. So the shipped byte 0x83 decodes to
 * U+0192 and 0x85 to U+2026, both above 0xFF, and a byte-wise writer replaces
 * them with '?'. Broken Sword's own `TEXT.CLU` came back from a round trip
 * that changed nothing differing in 488 bytes across 28 resources for exactly
 * that reason.
 *
 * Asking the decoder instead — decode 0x00 to 0xFF once, invert the answer —
 * is exact for every single-byte encoding, needs no table to be typed out
 * (ADR 0029), and stays exact if a platform's tables are ever corrected. A
 * byte that decodes to U+FFFD is unmapped in that encoding and is left out of
 * the map, so it cannot claim a code point some other byte owns.
 *
 * This lives beside `DataSource` and `zip` rather than in any one family's
 * tree: it is about the platform's encodings, not about any game, and both
 * Broken Swords, Sky and Lure all read strings the same way (ADR 0036 — a
 * shared *utility* is not a shared record).
 */

/** What a code point the encoding cannot hold is written as. */
export const SINGLE_BYTE_REPLACEMENT = 0x3f;

const tables = new Map<string, Map<number, number>>();

/**
 * The byte each code point came from, for one single-byte encoding.
 *
 * Built once per encoding and cached. An unknown label falls back to Latin-1
 * the same way the readers do, so a project carrying a typo re-exports the
 * bytes it imported rather than throwing at save time.
 */
export function singleByteTable(encoding: string): ReadonlyMap<number, number> {
  const cached = tables.get(encoding);
  if (cached) return cached;

  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(encoding);
  } catch {
    decoder = new TextDecoder('latin1');
  }

  const table = new Map<number, number>();
  const one = new Uint8Array(1);
  for (let byte = 0; byte <= 0xff; byte++) {
    one[0] = byte;
    const decoded = decoder.decode(one);
    if (decoded.length !== 1) continue;
    const code = decoded.charCodeAt(0);
    if (code === 0xfffd) continue;
    if (!table.has(code)) table.set(code, byte);
  }
  tables.set(encoding, table);
  return table;
}

/**
 * One string as bytes, in the encoding it will be read back with.
 *
 * One byte per UTF-16 unit, so the result is always `text.length` bytes and a
 * caller can size a record before encoding it. A code point the encoding
 * cannot hold — including either half of a surrogate pair, which no single-byte
 * encoding holds — is written as '?'. That is the one lossy case, and it is a
 * character an author typed rather than one the game shipped.
 */
export function encodeSingleByte(text: string, encoding = 'latin1'): Uint8Array {
  const table = singleByteTable(encoding);
  const bytes = new Uint8Array(text.length);
  for (let at = 0; at < text.length; at++) {
    bytes[at] = table.get(text.charCodeAt(at)) ?? SINGLE_BYTE_REPLACEMENT;
  }
  return bytes;
}
