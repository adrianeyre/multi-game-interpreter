/**
 * How long an inline v7 message is, and what it refers to.
 *
 * v7 keeps v6's framing — a NUL-terminated string in the code stream, with
 * control codes introduced by 0xFF — so the measurement is the same walk and
 * lives here rather than being imported from v6, which the version boundary
 * rule forbids and which would be the wrong dependency anyway: the two agree
 * today by coincidence of the encoding, not by construction.
 *
 * What v7 changed is what the string *says*. A displayable line is not the
 * words: it is a tag wrapped in slashes, `/TAG/`, naming an entry in an
 * external language bundle, with the text after it as a fallback. An engine
 * that renders the raw string displays a tag where dialogue should be, which
 * reads as a missing translation rather than as a bug.
 *
 * The tag is extracted for **every** v7 game, which is not the same as every
 * v7 game having a bundle: ScummVM opens one only for The Dig
 * (`LANGUAGE.BND`), and Full Throttle ships none at all, so every Full Throttle
 * line resolves to its own fallback. `language.ts` has the detail.
 * (`ScummEngine_v7::translateText`, whose tag extraction is version-gated where
 * `loadLanguageBundle`'s file choice is game-gated.)
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
export function measureV7Message(code: Uint8Array, at: number): number | null {
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

/**
 * The language-bundle tag a v7 message names, or null when it names none.
 *
 * `/NEW.007/faint light` is a tag and a fallback; `faint light` on its own is a
 * literal, which happens in the places the original never tagged. Returning
 * null for the second is what lets the caller tell "this line has no entry" from
 * "this line was never meant to have one".
 */
export function v7MessageKey(text: string): string | null {
  if (!text.startsWith('/')) return null;
  const close = text.indexOf('/', 1);
  if (close <= 1) return null;
  // Upper case and at most twelve characters, which is what the lookup is
  // built from — a tag compared in the wrong case matches nothing and displays
  // the fallback, which looks like a missing translation rather than a bug.
  return text.slice(1, Math.min(close, 13)).toUpperCase();
}

/** What a v7 message shows when the bundle cannot answer: the text after the key. */
export function v7MessageFallback(text: string): string {
  if (!text.startsWith('/')) return text;
  const close = text.indexOf('/', 1);
  if (close < 0) return text;
  return text.slice(close + 1);
}
