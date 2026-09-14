/**
 * Which way a loaded release lays its text out.
 *
 * ADR 0028 is the reason this file exists and the reason it is shaped this way.
 * Language is deliberately **not** on an AGOS Target — a German `GAMEPC`
 * decodes byte for byte like an English one — but the Hebrew release of Simon 1
 * is laid out right to left, and ScummVM handles that with language checks in
 * its drawing code. ADR 0028 lifted the one liftable part out instead: **Text
 * direction** is a property the loaded release declares, read by the renderer,
 * with left-to-right as the degenerate case rather than the
 * default-with-an-exception.
 *
 * "Declares" needs a mechanism, and this is it. An AGOS release is built per
 * language rather than assembled from language resources, so the declaration is
 * in the words themselves: the string pool inside `GAMEPC`.
 *
 * ## Why counting Hebrew bytes is not enough on its own
 *
 * The obvious test — are there bytes in the Hebrew range of code page 862? —
 * is wrong, and wrong in a way that would misdraw a real release rather than
 * merely fail. Hebrew's letters sit at 0x80 to 0x9A, and so do code page 437's
 * accented Latin ones: `ü` is 0x81, `ä` is 0x84, `ö` is 0x94. A German release
 * would test positive and be drawn backwards.
 *
 * What separates them is proportion rather than presence. In a German release
 * the accented letters are a garnish on text that is overwhelmingly ASCII; in a
 * Hebrew one the ASCII letters are the garnish — a stray English word, a file
 * name — and the high bytes are the language. So the test is whether the
 * high-range letters **outnumber** the ASCII ones, which no accented Latin
 * release comes close to and every Hebrew one does comfortably.
 *
 * The evidence is reported alongside the answer, because a wrong direction is
 * the kind of fault that looks like a broken renderer, and a person who can see
 * the two counts can tell instantly which it was.
 */

import type { TextDirection } from './textLayout.js';

/** Hebrew's letters in code page 862, which is what a Hebrew DOS release uses. */
const HEBREW_FIRST = 0x80;
const HEBREW_LAST = 0x9a;

/** Below this many high-range letters, a pool is not making a claim either way. */
const MINIMUM_EVIDENCE = 32;

export interface TextDirectionEvidence {
  readonly direction: TextDirection;
  /** Letters in the range a Hebrew release uses. */
  readonly hebrewRange: number;
  /** Plain ASCII letters. */
  readonly latin: number;
}

/**
 * Reads the direction out of a release's own string pool.
 *
 * Takes the raw bytes rather than the split strings: the pool is decoded as
 * latin-1 so that a byte survives as a code point, and reading the bytes says
 * that plainly instead of relying on the reader's decoding staying that way.
 */
export function readTextDirection(pool: Uint8Array): TextDirectionEvidence {
  let hebrewRange = 0;
  let latin = 0;
  for (const byte of pool) {
    if (byte >= HEBREW_FIRST && byte <= HEBREW_LAST) hebrewRange += 1;
    else if ((byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a)) latin += 1;
  }

  const rightToLeft = hebrewRange >= MINIMUM_EVIDENCE && hebrewRange > latin;
  return { direction: rightToLeft ? 'rtl' : 'ltr', hebrewRange, latin };
}

/** The sentence a status line says about a release's direction. */
export function describeTextDirection(evidence: TextDirectionEvidence): string {
  return evidence.direction === 'rtl'
    ? `text runs right to left (${evidence.hebrewRange} Hebrew-range letters against ${evidence.latin} Latin)`
    : 'text runs left to right';
}
