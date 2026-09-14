/**
 * A v7 game's displayable text, which lives outside its scripts.
 *
 * A v7 script names a line by tag rather than carrying its characters: the
 * string in the code stream is `/TAG/fallback`, and the words come from an
 * external bundle. So editing a v7 game's words is editing this file, not its
 * instructions (ADR 0009).
 *
 * **Which game ships which file is not what the epic assumed.** Reading
 * `ScummEngine_v7::loadLanguageBundle`:
 *
 * - **The Dig** ships `LANGUAGE.BND`, in the tagged format below.
 * - **The Curse of Monkey Island** ships `LANGUAGE.TAB` — and that is v8, not
 *   v7, so it is not this engine's problem yet. The format is here anyway
 *   because the two are read by one function and separating them later would
 *   mean reading it twice.
 * - **Full Throttle ships neither.** ScummVM returns without opening anything
 *   for any v7 game that is not The Dig. Its scripts still carry `/TAG/`
 *   markers, because the tag is extracted for every v7 game, so what displays
 *   is the fallback text after the tag.
 *
 * That last point matters for more than file handling: a missing bundle is
 * normal for Full Throttle and a broken install for The Dig, so "no bundle" is
 * not an error on its own.
 */

/** The XOR the `e` marker turns on for message text. Not applied to tags. */
const ENCODED_KEY = 0x13;

export interface LanguageBundle {
  /** Tag -> the line it names. Tags are upper case, as lookups are. */
  readonly lines: ReadonlyMap<string, string>;
  /** Which file this came from, for diagnostics and for #113's origin record. */
  readonly source: string;
}

/**
 * Reads The Dig's `LANGUAGE.BND`.
 *
 * Line-oriented text, not a binary table. Each line is one of:
 *
 * - `@TAG` — sets the base tag the numbered lines below it belong to.
 * - `<digits>/<text>` — an entry, whose full tag is `BASE.NNN`, three digits.
 * - `e` — everything after this point has its *message text* XORed with 0x13.
 * - `#n`, `!…`, `h`, `j`, `c` — a subtag count, a comment, and markers for
 *   Korean, Japanese and Chinese text. All skipped.
 *
 * An unrecognised line is an error in ScummVM. Here it is collected and
 * reported rather than thrown: a bundle with one odd line still has every other
 * line in it, and refusing the lot would take a game's whole script down with
 * it.
 */
export function readDigLanguageBundle(
  bytes: Uint8Array,
  source: string,
): { bundle: LanguageBundle; unreadable: string[] } {
  const lines = new Map<string, string>();
  const unreadable: string[] = [];

  let baseTag = '';
  let encoded = false;

  for (const raw of splitLines(bytes)) {
    if (raw.length === 0) continue;
    const marker = raw[0];

    if (marker === 0x21 /* ! */) continue;
    if (marker === 0x68 /* h */ || marker === 0x6a /* j */ || marker === 0x63 /* c */) continue;
    if (marker === 0x23 /* # */) continue;
    if (marker === 0x65 /* e */) {
      encoded = true;
      continue;
    }
    if (marker === 0x40 /* @ */) {
      baseTag = decodeAscii(raw.subarray(1), false);
      continue;
    }

    if (marker >= 0x30 && marker <= 0x39) {
      let cursor = 0;
      let index = 0;
      while (cursor < raw.length && raw[cursor] >= 0x30 && raw[cursor] <= 0x39) {
        index = index * 10 + (raw[cursor] - 0x30);
        cursor++;
      }
      if (raw[cursor] !== 0x2f /* / */) {
        unreadable.push(decodeAscii(raw, false));
        continue;
      }
      cursor++;

      // Only the message is encoded; the tag that names it never is, which is
      // what makes a lookup possible without decoding the whole file first.
      const text = decodeAscii(raw.subarray(cursor), encoded);
      lines.set(`${baseTag}.${String(index).padStart(3, '0')}`.toUpperCase(), text);
      continue;
    }

    unreadable.push(decodeAscii(raw, false));
  }

  return { bundle: { lines, source }, unreadable };
}

/**
 * Reads the eight-character-tag format, which The Curse of Monkey Island ships.
 *
 * Eight characters of tag, one space, then the line — with `\n` written as two
 * characters and meant as a newline. Present for completeness; no v7 game uses
 * it, and v8 is not supported.
 */
export function readTabLanguageBundle(bytes: Uint8Array, source: string): LanguageBundle {
  const lines = new Map<string, string>();

  for (const raw of splitLines(bytes)) {
    if (raw.length < 9) continue;
    const tag = decodeAscii(raw.subarray(0, 8), false).trim().toUpperCase();
    const text = decodeAscii(raw.subarray(9), false).replace(/\\n/g, '\n');
    if (tag) lines.set(tag, text);
  }

  return { lines, source };
}

/**
 * The line a `/TAG/fallback` string names, or the fallback when there is none.
 *
 * Returning the fallback rather than an empty string is what the original does,
 * and it is the difference between a missing translation and a missing line:
 * Full Throttle has no bundle at all and every one of its lines takes this
 * path.
 */
export function resolveLine(
  bundle: LanguageBundle | null,
  tag: string | null,
  fallback: string,
): string {
  if (!bundle || tag === null) return fallback;
  return bundle.lines.get(tag.toUpperCase()) ?? fallback;
}

/** Splits on CR, LF or any run of them, dropping the separators. */
function splitLines(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let start = 0;
  for (let i = 0; i <= bytes.length; i++) {
    const atEnd = i === bytes.length;
    if (atEnd || bytes[i] === 0x0a || bytes[i] === 0x0d) {
      if (i > start) out.push(bytes.subarray(start, i));
      start = i + 1;
    }
  }
  return out;
}

/** Latin-1, optionally XOR-decoded. The files are 8-bit text, not UTF-8. */
function decodeAscii(bytes: Uint8Array, encoded: boolean): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(encoded ? byte ^ ENCODED_KEY : byte);
  return text;
}
