/**
 * `Said`: whether the line the player typed is the sentence a script names.
 *
 * SCI0's rooms do not read the typed line. They ask, one handler after another,
 * `(Said 'look/door')` — and the first to be told yes claims the event. So the
 * interpreter owes the game two things: a reading of the *spec* the script
 * compiled into its `said` block, and a judgement of the parsed line against
 * it. Both are here; `Parse` in `SciKernel.ts` feeds the second.
 *
 * **The spec is Sierra's and is read exactly.** A said block is a run of
 * two-byte word groups and one-byte operators, ended by 0xff, and its grammar
 * is ScummVM's `said.cpp` (`parseSpec` down to `parseWord`, fetched
 * 2026-09-27): up to three parts — the verb, `/` the thing acted on, `/` the
 * thing it is done with — each an alternation of words (`,`), grouped with
 * `(` `)`, made optional with `[` `]`, and qualified with `<` by the words that
 * modify it. `>` at the end says "and anything else", which matches without
 * claiming the event so a later handler can still see it.
 *
 * **The matching is ScummVM's three answers, not a yes or no.** Every
 * comparison says "matches", "does not match" or "the sentence says nothing
 * here", and the third is what `[ ]` turns into a match. That is what lets
 * `'eat[/!*]'` accept "eat" and refuse "eat ladder": a part the sentence lacks
 * is silence, and `!*` is the word that turns a part's *presence* into a
 * refusal. The test file checks this against the worked examples at the foot
 * of `said.cpp`, which are ScummVM's own record of how Sierra's matcher
 * behaves.
 *
 * **What is not Sierra's is the sentence.** Sierra's parser builds a tree with
 * the GNF grammar in `vocab.900`, and this engine does not read that grammar.
 * The sentence here is built from word classes instead (`buildSentence`): the
 * first verb is the verb, a noun is the object and then the indirect object,
 * adjectives qualify the noun they precede, a preposition or adverb before any
 * noun qualifies the verb, and a preposition after the object introduces the
 * indirect one. That is the shape every example in `said.cpp` reduces to, and
 * it is named here because a sentence the grammar would read differently —
 * "depth correct", where ICEMAN's grammar hangs a noun off another — is a
 * sentence this matcher can misjudge.
 */

import { SCI_WORD_CLASS, type SciParsedWord } from '../resource/sciVocabulary.js';

/** `*` in a spec: any word at all. */
export const SAID_ANY = 0xfff;
/** `!*` in a spec: no word — the part must be absent. */
export const SAID_NONE = 0xffe;

/** The operators, as the byte a said block stores them in. */
export const SAID_OP = {
  comma: 0xf0,
  amp: 0xf1,
  slash: 0xf2,
  open: 0xf3,
  close: 0xf4,
  bracketOpen: 0xf5,
  bracketClose: 0xf6,
  hash: 0xf7,
  lt: 0xf8,
  gt: 0xf9,
  end: 0xff,
} as const;

/** One part of a sentence: the word, and the words qualifying it. */
export interface SaidPhrase {
  groups: number[];
  modifiers: SaidPhrase[];
}

/** A typed line as `Said` sees it: up to three parts, any of them absent. */
export interface SaidSentence {
  verb: SaidPhrase | null;
  object: SaidPhrase | null;
  indirect: SaidPhrase | null;
}

type SaidEntry = { word: number } | { expr: SaidExpr; optional: boolean };

interface SaidExpr {
  /** Alternatives, any one of which will do. */
  list: SaidEntry[] | null;
  /** What must qualify the word, with `<`. */
  ref: SaidRef | null;
}

interface SaidRef {
  list: SaidEntry[];
  /** A further `<`, which must hold as well. */
  next: SaidRef | null;
  optional: boolean;
}

interface SaidPart {
  /** Null for a bare `/`, which constrains nothing. */
  expr: SaidExpr | null;
  optional: boolean;
}

export interface SaidSpec {
  verb: SaidExpr | null;
  object: SaidPart | null;
  indirect: SaidPart | null;
  /** A trailing `>`: matches without claiming, so the event travels on. */
  partial: boolean;
}

/** Sierra's own cap on a spec's length (`MAX_SAID_TOKENS`). */
const MAX_TOKENS = 128;

/** A token: a word group below 0x1000, or an operator byte shifted clear of them. */
const op = (byte: number): number => 0x10000 | byte;

/**
 * Reads a said block into tokens, stopping at 0xff.
 *
 * A byte below 0xf0 is the high half of a two-byte word group; anything from
 * 0xf0 up is one operator. Null when the block runs past Sierra's cap without
 * ending, which is a block this has misread rather than a long spec.
 */
function tokenise(read: (index: number) => number, length: number): number[] | null {
  const tokens: number[] = [];
  let at = 0;
  while (at < length && tokens.length < MAX_TOKENS) {
    const byte = read(at++);
    if (byte >= 0xf0) {
      tokens.push(op(byte));
      if (byte === SAID_OP.end) return tokens;
    } else {
      tokens.push(((byte << 8) | read(at++)) & 0xfff);
    }
  }
  return null;
}

/**
 * The spec's grammar, as recursive descent that rolls back on failure.
 *
 * Rolling back is Sierra's, and it matters at one place: `[` opens both an
 * optional *part* (`[/door]`) and an optional *entry* (`[!*]`), and which it
 * is can only be told by trying one and falling back to the other.
 */
class SpecReader {
  at = 0;
  constructor(private readonly tokens: readonly number[]) {}

  private peek(): number {
    return this.tokens[this.at] ?? op(SAID_OP.end);
  }

  private take(byte: number): boolean {
    if (this.peek() !== op(byte)) return false;
    this.at++;
    return true;
  }

  spec(): SaidSpec | null {
    const verb = this.expr();
    const object = this.part();
    const indirect = object ? this.part() : null;
    if (!verb && !object) return null;
    const partial = this.take(SAID_OP.gt);
    if (this.peek() !== op(SAID_OP.end)) return null;
    return {
      verb,
      object: object && (object.expr || object.optional) ? object : null,
      indirect: indirect && (indirect.expr || indirect.optional) ? indirect : null,
      partial,
    };
  }

  private part(): SaidPart | null {
    const start = this.at;
    if (this.take(SAID_OP.slash)) {
      const expr = this.expr();
      if (expr) return { expr, optional: false };
      this.at = start;
    }
    if (this.take(SAID_OP.bracketOpen)) {
      const inner = this.part();
      if (inner && this.take(SAID_OP.bracketClose)) return { expr: inner.expr, optional: true };
      this.at = start;
    }
    // A bare slash: the part is there and says nothing about the sentence.
    if (this.take(SAID_OP.slash)) return { expr: null, optional: false };
    this.at = start;
    return null;
  }

  private expr(): SaidExpr | null {
    const list = this.list();
    const ref = this.ref();
    return list || ref ? { list, ref } : null;
  }

  private ref(): SaidRef | null {
    const start = this.at;
    if (this.take(SAID_OP.lt)) {
      const list = this.list();
      if (list) return { list, next: this.ref(), optional: false };
      this.at = start;
    }
    if (this.take(SAID_OP.bracketOpen)) {
      const inner = this.ref();
      if (inner && this.take(SAID_OP.bracketClose)) return { ...inner, optional: true };
      this.at = start;
    }
    return null;
  }

  private list(): SaidEntry[] | null {
    const first = this.entry();
    if (!first) return null;
    const entries = [first];
    for (;;) {
      const start = this.at;
      if (!this.take(SAID_OP.comma)) break;
      const next = this.entry();
      if (!next) {
        this.at = start;
        break;
      }
      entries.push(next);
    }
    return entries;
  }

  private entry(): SaidEntry | null {
    const start = this.at;
    for (const [open, close, optional] of [
      [SAID_OP.bracketOpen, SAID_OP.bracketClose, true],
      [SAID_OP.open, SAID_OP.close, false],
    ] as const) {
      if (this.take(open)) {
        const expr = this.expr();
        if (expr && this.take(close)) return { expr, optional };
        this.at = start;
        return null;
      }
    }
    const token = this.peek();
    if (token & 0x10000) return null;
    this.at++;
    return { word: token };
  }
}

/** A said block's spec, or null when it does not parse as one. */
export function readSaidSpec(read: (index: number) => number, length: number): SaidSpec | null {
  const tokens = tokenise(read, length);
  return tokens ? new SpecReader(tokens).spec() : null;
}

/** Matches, does not match, or the sentence says nothing here. */
type Verdict = 1 | 0 | -1;

function matchEntry(phrase: SaidPhrase | null, entry: SaidEntry): Verdict {
  if ('expr' in entry) {
    const verdict = matchExpr(phrase, entry.expr);
    return entry.optional && verdict === 0 ? 1 : verdict;
  }
  if (!phrase) return 0;
  if (entry.word === SAID_ANY) return 1;
  if (entry.word === SAID_NONE) return -1;
  return phrase.groups.includes(entry.word) ? 1 : -1;
}

/** Alternatives: the first that matches, or what the last one said. */
function matchList(phrase: SaidPhrase | null, entries: readonly SaidEntry[]): Verdict {
  let verdict: Verdict = 0;
  for (const entry of entries) {
    verdict = matchEntry(phrase, entry);
    if (verdict === 1) return 1;
  }
  return verdict;
}

/**
 * `<`: some word qualifying this one must match.
 *
 * A phrase with nothing qualifying it is silence, not refusal — which is why
 * `'use/device[<electronic]'` accepts "use device" and refuses "use green
 * device". Among several qualifiers a match wins and a mismatch outranks
 * silence, as ScummVM's `scanParseChildren` has it.
 */
function matchRef(phrase: SaidPhrase | null, ref: SaidRef): Verdict {
  let verdict: Verdict = 0;
  for (const modifier of phrase?.modifiers ?? []) {
    const one = matchList(modifier, ref.list);
    if (one !== 0) verdict = one;
    if (verdict === 1) break;
  }
  if (verdict === 1 && ref.next) verdict = matchRef(phrase, ref.next);
  return ref.optional && verdict === 0 ? 1 : verdict;
}

/** Both halves must hold, and the first that does not is the answer. */
function matchExpr(phrase: SaidPhrase | null, expr: SaidExpr): Verdict {
  if (expr.list) {
    const verdict = matchList(phrase, expr.list);
    if (verdict !== 1) return verdict;
  }
  return expr.ref ? matchRef(phrase, expr.ref) : 1;
}

function matchPart(phrase: SaidPhrase | null, part: SaidPart | null): boolean {
  if (!part?.expr) return true;
  const verdict = matchExpr(phrase, part.expr);
  return verdict === 1 || (part.optional && verdict === 0);
}

/**
 * Whether a sentence is the one a spec names, and whether to claim it.
 *
 * Parts of the sentence the spec does not mention are not held against it —
 * `'look'` accepts "look at the door" — which is ScummVM's reading and the
 * reason Sierra's rooms order their handlers most specific first.
 */
export function matchSaid(sentence: SaidSentence, spec: SaidSpec): 'no' | 'partial' | 'full' {
  if (spec.verb && matchExpr(sentence.verb, spec.verb) !== 1) return 'no';
  if (!matchPart(sentence.object, spec.object)) return 'no';
  if (!matchPart(sentence.indirect, spec.indirect)) return 'no';
  return spec.partial ? 'partial' : 'full';
}

const is = (word: SciParsedWord, wordClass: number): boolean => (word.wordClass & wordClass) !== 0;
const NOUNISH = SCI_WORD_CLASS.noun | SCI_WORD_CLASS.pronoun | SCI_WORD_CLASS.number;

/**
 * A parsed line, arranged into verb, object and indirect object.
 *
 * **This is the part that is not Sierra's**, and the file's header says why.
 * A word may carry several classes — "open" is a verb and an adjective — so
 * each is read by where it stands: a verb only while no verb and no noun have
 * been seen, an adjective only when a noun follows it.
 */
export function buildSentence(words: readonly SciParsedWord[]): SaidSentence {
  const sentence: SaidSentence = { verb: null, object: null, indirect: null };
  let pending: SaidPhrase[] = [];
  let last: SaidPhrase | null = null;
  let towardIndirect = false;
  const phrase = (word: SciParsedWord): SaidPhrase => ({ groups: [word.group], modifiers: [] });

  words.forEach((word, index) => {
    const next = words[index + 1];
    const seenNoun = sentence.object !== null || sentence.indirect !== null;

    if (!sentence.verb && !seenNoun && pending.length === 0 && is(word, SCI_WORD_CLASS.verb)) {
      sentence.verb = phrase(word);
      last = sentence.verb;
      return;
    }
    if (is(word, SCI_WORD_CLASS.adjective) && next && is(next, NOUNISH)) {
      pending.push(phrase(word));
      return;
    }
    if (is(word, NOUNISH)) {
      const noun = { groups: [word.group], modifiers: pending };
      pending = [];
      if (!sentence.object && !towardIndirect) sentence.object = noun;
      else if (!sentence.indirect) sentence.indirect = noun;
      else sentence.indirect.modifiers.push(noun);
      last = noun;
      return;
    }
    if (is(word, SCI_WORD_CLASS.preposition | SCI_WORD_CLASS.adverb)) {
      // Before any noun it says how the verb is done — "climb up"; after the
      // object it also opens the indirect one — "put washer on shaft".
      if (sentence.verb) sentence.verb.modifiers.push(phrase(word));
      if (seenNoun && is(word, SCI_WORD_CLASS.preposition)) towardIndirect = true;
      return;
    }
    // An adjective with no noun after it qualifies whatever it follows.
    const held: SaidPhrase | null = last;
    if (held) held.modifiers.push(phrase(word));
    else pending.push(phrase(word));
  });

  // Qualifiers left waiting for a noun that never came belong to the verb.
  if (pending.length > 0 && sentence.verb) sentence.verb.modifiers.push(...pending);
  return sentence;
}
