/**
 * How long an inline v6 message is.
 *
 * v6 puts a line's text in the code stream, NUL-terminated, with control codes
 * embedded in it — and the instruction after the string starts wherever the
 * string ends, so this measurement decides whether everything after a talking
 * instruction is read as code or as the middle of a sentence.
 *
 * The codes are introduced by 0xFF (or 0xFE). Four of them — 1, 2, 3 and 8 —
 * carry nothing; every other one carries **two** bytes. That includes code 10,
 * the speech code, which looks like an exception and is not: it stores two
 * 32-bit values as four 16-bit fields with `FF 0A` marker pairs between them,
 * so walking it two bytes at a time lands on each marker in turn and arrives at
 * the same place as treating it as one sixteen-byte sequence.
 *
 * Shared between the interpreter and the reader on purpose. They have to agree
 * exactly: a reader that measured a string differently from the engine would
 * re-emit an edited script that the engine then read as something else.
 */

/** Codes that carry no payload. Every other code carries two bytes. */
const BARE_CODES = new Set([1, 2, 3, 8]);

const ESCAPE = 0xff;
const ESCAPE_ALT = 0xfe;
const PAYLOAD_BYTES = 2;

/**
 * Bytes from `at` up to and including the terminator, or null when there is
 * none before the end of the code.
 *
 * Null rather than a best guess: an unterminated string means the program
 * counter is not where the reader thinks it is, and inventing a length hides
 * that behind text that happens to decode.
 */
export function measureV6Message(code: Uint8Array, at: number): number | null {
  let cursor = at;

  while (cursor < code.length) {
    const byte = code[cursor++];
    if (byte === 0) return cursor - at;
    if (byte !== ESCAPE && byte !== ESCAPE_ALT) continue;

    if (cursor >= code.length) return null;
    const control = code[cursor++];
    if (BARE_CODES.has(control)) continue;
    cursor += PAYLOAD_BYTES;
  }

  return null;
}
