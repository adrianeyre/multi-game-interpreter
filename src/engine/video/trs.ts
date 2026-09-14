/**
 * `.trs`: the string table a SMUSH subtitle can name its line from.
 *
 * A frame carries text one of two ways. `TEXT` holds the words, and `TRES`
 * holds a number — an id into a table that lives outside the `.SAN`, beside the
 * game, named after the video that uses it. So a cutscene's words can be
 * missing for a reason that has nothing to do with the video decoding
 * correctly, which is why this is read rather than left to look like a decoder
 * fault.
 *
 * Two forms, and the difference is only whether the bytes are obscured. A plain
 * `.trs` is text. The Dig's shared table is an `ETRS` file: sixteen bytes of
 * header, then the same text with every byte exclusive-ored against 0xCC — not
 * encryption, and treated as a container variation rather than as a format.
 *
 * **Ids are explicit, not positional.** Each record states its own number, so
 * the order records appear in the file says nothing, and a missing id is a
 * missing line rather than an off-by-one through the whole table.
 *
 * (`SmushPlayer::readString`, `getStrings` and `StringResourceImpl::init`.)
 */

/** `ETRS`, big-endian, at the start of an obscured table. */
const ETRS_TAG = 0x45545253;

/** How much of an `ETRS` file is header rather than text. */
const ETRS_HEADER_LENGTH = 16;

/** Every byte of an `ETRS` payload is exclusive-ored against this. */
const ETRS_XOR = 0xcc;

/**
 * The original's cap, kept rather than raised.
 *
 * Not a performance limit — it is the size of the array the interpreter reads
 * into, so a file with more records than this is a file no release ever
 * shipped, and reading it whole would be inventing behaviour.
 */
export const MAX_SMUSH_STRINGS = 200;

/** The `.trs` a video's subtitles would be in: `FOO.SAN` becomes `FOO.trs`. */
export function stringTableNameFor(videoName: string): string | null {
  const dot = videoName.lastIndexOf('.');
  if (dot <= 0) return null;
  return `${videoName.slice(0, dot)}.trs`;
}

/**
 * Reads a string table, or null when the bytes are not one.
 *
 * `encoded` says whether an `ETRS` header is expected. Passed in rather than
 * inferred from the tag alone, because the two call sites differ: a video's own
 * `.trs` is plain and The Dig's shared table is obscured, and a file that
 * claims `ETRS` where plain text was asked for is a mismatched pair of files
 * rather than something to decode anyway.
 */
export function readSmushStrings(bytes: Uint8Array, encoded = false): Map<number, string> | null {
  let text = bytes;

  if (encoded) {
    if (bytes.length <= ETRS_HEADER_LENGTH) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    if (view.getUint32(0, false) !== ETRS_TAG) return null;

    text = new Uint8Array(bytes.length - ETRS_HEADER_LENGTH);
    for (let i = 0; i < text.length; i++) text[i] = bytes[i + ETRS_HEADER_LENGTH] ^ ETRS_XOR;
  }

  return parseStringRecords(new TextDecoder('latin1').decode(text));
}

/**
 * Splits a table's text into numbered records.
 *
 * Each record opens with a `#` line ending in its id, and its text runs to a
 * blank line. Three spellings of that blank line exist across releases — a
 * carriage-return pair, a bare newline pair, and a single pair followed
 * immediately by the next `#`, which is what the Russian Full Throttle release
 * writes. All three are accepted, because a terminator this does not recognise
 * swallows every record after it into one.
 */
function parseStringRecords(text: string): Map<number, string> | null {
  const strings = new Map<number, string>();
  let at = text.indexOf('#');

  while (at >= 0 && strings.size < MAX_SMUSH_STRINGS) {
    const lineEnd = text.indexOf('\n', at);
    if (lineEnd < 0) break;

    const id = trailingNumber(text.slice(at, lineEnd));

    let start = lineEnd + 1;
    while (start < text.length && (text[start] === '\n' || text[start] === '\r')) start++;

    const { end, resumeAt } = findRecordEnd(text, start);
    if (id !== null) strings.set(id, foldContinuations(text.slice(start, end)));

    at = text.indexOf('#', resumeAt);
  }

  return strings.size > 0 ? strings : null;
}

/**
 * The number a `#` line ends with.
 *
 * Read from the end backwards, as the original does, because what precedes the
 * digits varies — a name, a comment, a tag — and only the digits are the id.
 */
function trailingNumber(line: string): number | null {
  const match = /(\d+)\s*$/.exec(line.replace(/\r$/, ''));
  return match ? Number(match[1]) : null;
}

function findRecordEnd(text: string, start: number): { end: number; resumeAt: number } {
  for (let i = start; i < text.length; i++) {
    if (text.startsWith('\r\n\r\n', i)) return { end: i, resumeAt: i + 4 };
    if (text.startsWith('\n\n', i)) return { end: i, resumeAt: i + 2 };
    if (text.startsWith('\r\n#', i)) return { end: i, resumeAt: i + 2 };
  }
  return { end: text.length, resumeAt: text.length };
}

/**
 * Joins a record's continuation lines.
 *
 * A line beginning `//` continues the one before it, and the break between them
 * becomes a space rather than disappearing — without which two words run
 * together at every line break in a long subtitle.
 */
function foldContinuations(record: string): string {
  return record.replace(/\r?\n\/\//g, ' ').replace(/\r\n/g, '\n');
}
