/**
 * Changing a Sky Compact.
 *
 * One edit only, and it is the one ADR 0025 says the object table is for:
 * changing a field's **value**. Where an object stands, what mode it is in, which
 * frame it shows — each is a word in a record, and each is edited by writing that
 * word.
 *
 * ## The shape may not change
 *
 * A record's word count is fixed. `writeSkyCompacts` refuses a replacement of a
 * different length (ADR 0024): a record that grew would move every record after
 * it and invalidate the ids the game's own scripts hold. So these functions
 * change a value at an existing index and never add or remove a word — the same
 * "change a value, never the count" invariant AGOS's `editItemChildValue` keeps
 * for the same kind of reason.
 *
 * Every edit returns a **new** record rather than mutating one, so the editor
 * never holds a half-edited record that no file corresponds to.
 */

import { wordsFromBase64, wordsToBase64 } from './project.js';
import type { SkyProjectRecord } from '../project.js';

/**
 * Sets one word of a record to a value, returning a new record.
 *
 * Refuses an index outside the record: a word past the end is a shape change
 * wearing a value edit's clothes, and the writer would reject it later anyway —
 * refusing here names the record and the index instead of failing at export.
 */
export function editCompactWord(
  record: SkyProjectRecord,
  wordIndex: number,
  value: number,
): SkyProjectRecord {
  const words = wordsFromBase64(record.wordsBase64);
  if (wordIndex < 0 || wordIndex >= words.length) {
    throw new Error(
      `Compact ${record.name} has ${words.length} words, so there is no word ${wordIndex}. ` +
        `A record's shape is fixed: values may change, the word count may not (ADR 0024).`,
    );
  }
  const next = words.slice();
  next[wordIndex] = value & 0xffff;
  return { ...record, wordsBase64: wordsToBase64(next) };
}

/** The words of a record, decoded — for showing a field grid or writing back. */
export function compactWords(record: SkyProjectRecord): Uint16Array {
  return wordsFromBase64(record.wordsBase64);
}
