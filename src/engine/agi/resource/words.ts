/**
 * `WORDS.TOK`: the game's authored vocabulary.
 *
 * `CONTEXT.md` is firm that Parser input is "not a chat box: the vocabulary is
 * fixed and authored". This is that vocabulary, and its shape is the reason:
 * words are grouped into **synonym sets by number**, so `get`, `take` and `pick`
 * are one number and a script tests the number rather than the spelling.
 *
 * A plain file rather than an indexed resource, like `OBJECT` — so it is read
 * by name and does not go through the `*DIR` tables.
 */

import { readU16BE } from '../../util/ByteStream.js';

/** Words the parser drops: "the", "a", and whatever else the author listed. */
export const NOISE_GROUP = 0;

/**
 * The wildcard group every game's vocabulary defines.
 *
 * `said(1)` matches any single word, which is how a game accepts "look at
 * <anything>" and then decides what to say about it.
 */
export const ANY_WORD_GROUP = 1;

/**
 * "The rest of the line, whatever it is."
 *
 * A `said` ending in this matches however many words follow. Without it a game
 * fails to match half the phrases it accepts, which reads as the parser not
 * understanding rather than as an engine fault.
 */
export const REST_OF_LINE_GROUP = 9999;

export interface AgiVocabulary {
  /** Word text to its group number. Lower-cased, as AGI stores it. */
  readonly words: ReadonlyMap<string, number>;
  /** Every word in a group, for the editor and for diagnostics. */
  readonly groups: ReadonlyMap<number, readonly string[]>;
}

/**
 * Reads `WORDS.TOK`.
 *
 * The file opens with 26 big-endian 16-bit offsets, one per initial letter, and
 * a zero means that letter has no words. Big-endian, which is worth noting
 * because everything else in AGI is little-endian — read the wrong way, letter
 * "a"'s offset of 0x0034 becomes 0x3400 and the parse walks off the end.
 *
 * Each word is then:
 *
 *   - one byte: how many leading characters to reuse from the previous word,
 *     which is what makes the file small — "look", "look at", "looking" share
 *     a prefix and store only the difference
 *   - its remaining characters, each XORed with 0x7F, with the **last one's
 *     high bit set** in the stored byte to mark the end
 *   - two bytes, big-endian: the group number
 *
 * A section ends at a zero reuse-count byte, except for the first word of the
 * section, which legitimately has one. ScummVM tells them apart by checking
 * whether the *previous* word began with the section's own letter, and that is
 * mirrored here: fan-made games put digit-initial words at the front of the "a"
 * section, and a stricter reading loses them.
 */
export function readVocabulary(bytes: Uint8Array): AgiVocabulary {
  const words = new Map<string, number>();
  const groups = new Map<number, string[]>();

  if (bytes.length < 52) {
    throw new Error(
      `WORDS.TOK is ${bytes.length} bytes, which is shorter than its own ` +
        `52-byte letter index.`,
    );
  }

  /** The word being built, kept across sections so a prefix can be reused. */
  const buffer: number[] = [];

  for (let letter = 0; letter < 26; letter++) {
    const offset = readU16BE(bytes, letter * 2);
    if (offset === 0) continue;
    if (offset >= bytes.length) continue;

    let at = offset;
    const sectionLetter = 'a'.charCodeAt(0) + letter;

    for (;;) {
      if (at >= bytes.length) break;
      const reuse = bytes[at++];

      // The section terminator, told apart from a legitimate zero reuse-count
      // by whether the previous word belonged to this section.
      if (reuse === 0 && buffer[0] === sectionLetter) break;
      // A reuse count longer than the word it reuses from is malformed, and
      // continuing would read a prefix that is not there.
      if (reuse > buffer.length) break;

      buffer.length = reuse;
      let stored: number;
      do {
        if (at >= bytes.length) break;
        stored = bytes[at++];
        buffer.push((stored ^ 0x7f) & 0x7f);
        // Sixty-three characters is longer than any AGI word, and the cap is
        // what stops a malformed file building a string without bound.
      } while ((stored & 0x80) === 0 && buffer.length < 63);

      if (at + 1 >= bytes.length) break;
      const group = readU16BE(bytes, at);
      at += 2;

      const text = String.fromCharCode(...buffer);
      if (text.length === 0) continue;
      words.set(text, group);
      const existing = groups.get(group);
      if (existing) existing.push(text);
      else groups.set(group, [text]);
    }
  }

  return { words, groups };
}

/** What the parser made of a line the player typed. */
export interface ParsedInput {
  /** The group numbers, noise words dropped. */
  readonly groups: number[];
  /** The words as typed, for a "you don't know that word" message. */
  readonly spoken: string[];
  /**
   * The first word the vocabulary did not contain, if any.
   *
   * AGI's own response is "I don't know the word ...", and the *position* is
   * what `V.WORD_NOT_FOUND` holds — so a script can say which word it was.
   */
  readonly unknownWord: string | null;
  readonly unknownIndex: number;
}

/**
 * Resolves a typed line against the vocabulary.
 *
 * Noise words are dropped per the game's own vocabulary rather than a list of
 * ours: whether "at" is noise is the author's decision, recorded as group 0,
 * and a hardcoded stop-word list would drop words a game needs.
 *
 * Matching is longest-first, because AGI vocabularies contain multi-word
 * entries — "pick up" is one word to the parser, and matching "pick" first
 * would leave "up" as an unknown word.
 */
export function parseInput(vocabulary: AgiVocabulary, line: string): ParsedInput {
  // Punctuation is separator, not content: AGI's own parser treats anything
  // that is not a letter or a digit as a break.
  const tokens = line
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);

  const groups: number[] = [];
  const spoken: string[] = [];
  let unknownWord: string | null = null;
  let unknownIndex = 0;

  let at = 0;
  while (at < tokens.length) {
    // Longest match first, up to the longest multi-word entry a vocabulary
    // plausibly holds.
    let matched = false;
    for (let length = Math.min(5, tokens.length - at); length >= 1; length--) {
      const phrase = tokens.slice(at, at + length).join(' ');
      const group = vocabulary.words.get(phrase);
      if (group === undefined) continue;

      spoken.push(phrase);
      // Group 0 is a noise word the author asked to be discarded, so it is not
      // a word the script ever sees.
      if (group !== NOISE_GROUP) groups.push(group);
      at += length;
      matched = true;
      break;
    }

    if (matched) continue;

    unknownWord = tokens[at];
    // The position, which is what the reserved variable holds — one-based,
    // counting the words the parser did accept.
    unknownIndex = groups.length + 1;
    spoken.push(tokens[at]);
    break;
  }

  return { groups, spoken, unknownWord, unknownIndex };
}

/** AGI's own wording, so an unknown word reads as the game rather than as us. */
export function unknownWordMessage(word: string): string {
  return `I don't know the word "${word}".`;
}
