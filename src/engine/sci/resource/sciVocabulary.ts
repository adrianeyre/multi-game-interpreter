/**
 * `vocab.000`: the words a SCI0 game's parser knows.
 *
 * SCI0's input is a typed line matched against the game's own vocabulary, and
 * the vocabulary is a *resource* — which is why `CONTEXT.md` says language is
 * not part of a SCI Target: the parser vocabulary being language-specific looks
 * like a counterexample and is not one, because `vocab.000` arrives with the
 * game.
 *
 * **Words are stored prefix-compressed**, which is the thing to get right: each
 * entry begins with how many characters it shares with the entry before it, so
 * a reader that ignores that field produces a vocabulary of suffixes — `ook`
 * for `look` — and every parse fails without anything erroring.
 */

/** What a word means to the parser. */
export interface SciWord {
  word: string;
  /** The word class: noun, verb, preposition and so on, as a bit mask. */
  wordClass: number;
  /** Words meaning the same thing share a group, which is what `said` matches. */
  group: number;
}

/** The parser's word classes, as SCI's own scripts test them. */
export const SCI_WORD_CLASS = {
  number: 0x001,
  special: 0x080,
  preposition: 0x020,
  article: 0x040,
  adjective: 0x008,
  pronoun: 0x010,
  noun: 0x004,
  auxiliary: 0x100,
  adverb: 0x200,
  verb: 0x002,
} as const;

/**
 * Reads `vocab.000`.
 *
 * Twenty-six 16-bit offsets — one per initial letter — and then the words. A
 * letter with no words has an offset of zero, which is not an offset and has to
 * be told apart from a word at the start of the resource.
 */
export function readSciVocabulary(resource: Uint8Array): SciWord[] {
  const words: SciWord[] = [];
  if (resource.length < 52) return words;

  // **A letter's run ends where the next letter's begins.**
  //
  // Reading to a 0xff terminator alone is not enough, because not every
  // letter's run carries one — so a letter without one ran on into the letter
  // after it, and the letter after that, and every word from there to the end
  // of the resource was read again once per letter before it. Space Quest III
  // reported 16,884 words out of 9,985 bytes, which is 0.59 bytes a word and
  // cannot happen: an entry is a shared count, at least one character and three
  // bytes of class and group, so five bytes is the floor. The count being
  // impossible is what found this; nothing failed, and `kParse` had thirteen
  // copies of most of the vocabulary to match against.
  const starts = [...new Array(26).keys()]
    .map((letter) => resource[letter * 2] | (resource[letter * 2 + 1] << 8))
    .filter((offset) => offset > 0 && offset < resource.length)
    .sort((a, b) => a - b);

  for (let letter = 0; letter < 26; letter++) {
    let at = resource[letter * 2] | (resource[letter * 2 + 1] << 8);
    if (at === 0 || at >= resource.length) continue;
    const end = starts.find((offset) => offset > at) ?? resource.length;

    // Each letter's run ends at the next letter's offset, when the next entry's
    // shared-prefix count would read past it, or at a terminator byte.
    let previous = '';
    while (at < end) {
      const shared = resource[at++];
      if (shared === 0xff) break;

      let word = previous.slice(0, shared);
      // Characters, with the high bit set on the last one — so the length is
      // in the data rather than in a count, and a word runs to wherever that
      // bit appears.
      while (at < end) {
        const byte = resource[at++];
        word += String.fromCharCode(byte & 0x7f);
        if (byte & 0x80) break;
      }
      if (at + 3 > end) break;

      // Three bytes: the class in the top twelve bits and the group in the
      // bottom twelve, packed across them.
      const packed = (resource[at] << 16) | (resource[at + 1] << 8) | resource[at + 2];
      at += 3;

      words.push({ word, wordClass: packed >> 12, group: packed & 0xfff });
      previous = word;

      // The next entry belongs to this letter only while it starts with it.
      if (at < end && resource[at] === 0xff) break;
    }
  }
  return words;
}

/** Words by their text, for the parse. */
export function vocabularyIndex(words: readonly SciWord[]): Map<string, SciWord> {
  const index = new Map<string, SciWord>();
  for (const word of words) if (!index.has(word.word)) index.set(word.word, word);
  return index;
}

/**
 * Parses a typed line into the groups a `said` will match.
 *
 * SCI's parse is not a syntax tree here: a `said` spec matches a sequence of
 * *groups*, so what a line reduces to is the groups of the words in it, with
 * the words the parser does not know reported rather than skipped. A parser
 * that silently drops an unknown word answers "I don't understand" to a
 * sentence it half-understood, which is the difference between a game that
 * teaches its own vocabulary and one that seems arbitrary.
 */
export function parseSciLine(
  line: string,
  index: Map<string, SciWord>,
): { groups: number[]; unknown: string[] } {
  const groups: number[] = [];
  const unknown: string[] = [];

  for (const raw of line.toLowerCase().split(/[^a-z0-9']+/)) {
    if (raw === '') continue;
    const word = index.get(raw);
    if (!word) {
      unknown.push(raw);
      continue;
    }
    // Articles carry no meaning to a `said` and are dropped by the parser
    // rather than by the game's scripts.
    if (word.wordClass & SCI_WORD_CLASS.article) continue;
    groups.push(word.group);
  }
  return { groups, unknown };
}

/**
 * Emits `vocab.000` (#220, #224).
 *
 * The shared-prefix compression is what makes this more than a list: each word
 * stores how many leading characters it shares with the one before it, so the
 * words within a letter must be **sorted** for the compression to mean
 * anything — and a writer that emitted them in the order an editor happened to
 * hold them would produce a vocabulary that parses to different words than it
 * was given, with nothing failing.
 *
 * So they are sorted here, per letter, and the prefix count is computed against
 * the word actually written before rather than against the word that used to
 * be there.
 *
 * A word beginning with anything but a-z has no letter bucket to go in and is
 * dropped, with the count returned so a caller can say so rather than silently
 * shipping a smaller vocabulary.
 */
export function writeSciVocabulary(words: readonly SciWord[]): {
  bytes: Uint8Array;
  dropped: string[];
} {
  const buckets = new Map<number, SciWord[]>();
  const dropped: string[] = [];

  for (const word of words) {
    const letter = word.word.charCodeAt(0) - 97;
    if (letter < 0 || letter > 25) {
      dropped.push(word.word);
      continue;
    }
    const bucket = buckets.get(letter) ?? [];
    bucket.push(word);
    buckets.set(letter, bucket);
  }

  const offsets = new Uint8Array(52);
  const body: number[] = [];

  for (let letter = 0; letter < 26; letter++) {
    const bucket = buckets.get(letter);
    if (!bucket || bucket.length === 0) continue;
    bucket.sort((a, b) => (a.word < b.word ? -1 : a.word > b.word ? 1 : 0));

    const at = 52 + body.length;
    offsets[letter * 2] = at & 0xff;
    offsets[letter * 2 + 1] = at >> 8;

    for (const word of bucket) {
      // **Every word is written whole, sharing nothing with the one before.**
      //
      // The format allows a shared-prefix count and Sierra's own data uses it,
      // and a writer that computes one is correct only if it is correct for
      // every entry — a single count that is one too many turns the rest of
      // that letter into different words, silently. An attempt at it round-
      // tripped four of the five vocabularies in the corpus and lost 2,596 of
      // Space Quest III's 16,884 words, reading part of a class field as
      // characters.
      //
      // A count of zero is legal at any position and means exactly what it
      // says, so this form cannot desynchronise. It costs size and nothing
      // else: Space Quest III's `vocab.000` goes from 62,657 bytes to 90,072,
      // and byte-identity does not depend on it because a vocabulary nobody
      // edited is carried through rather than re-emitted (ADR 0010).
      body.push(0);
      const letters = [...word.word];
      for (const [index, character] of letters.entries()) {
        body.push((character.charCodeAt(0) & 0x7f) | (index === letters.length - 1 ? 0x80 : 0));
      }
      const packed = ((word.wordClass & 0xfff) << 12) | (word.group & 0xfff);
      body.push((packed >> 16) & 0xff, (packed >> 8) & 0xff, packed & 0xff);
    }
    body.push(0xff);
  }

  const bytes = new Uint8Array(52 + body.length);
  bytes.set(offsets, 0);
  bytes.set(body, 52);
  return { bytes, dropped };
}
