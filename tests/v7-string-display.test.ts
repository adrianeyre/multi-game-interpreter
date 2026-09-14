import { describe, expect, it } from 'vitest';
import { findReferences } from '../src/authoring/languageStrings.js';

/**
 * Showing a line's words, and how far editing them reaches.
 *
 * The display logic in `ActionEditor` needs a DOM, so what is asserted here is
 * the part that decides what it says: which scripts share a tag. That is the
 * property the issue turns on — one string referenced from many scripts, where
 * Preserved bytes and `Action`s each belong to one place.
 */
describe('what the editor tells an author before they edit a line', () => {
  it('says nothing when a line is used once', () => {
    const references = findReferences(new Map([['script 2', [{ text: '/A.001/hello' }]]]));
    expect(references.get('A.001')).toHaveLength(1);
  });

  it('counts every script sharing a line, which is the warning’s content', () => {
    const references = findReferences(
      new Map([
        ['script 2', [{ text: '/A.001/hello' }]],
        ['script 3', [{ text: '/A.001/hello' }]],
        ['script 9', [{ text: '/A.001/hello' }]],
      ]),
    );

    // Three scripts share it, so the row reads "shared with 2 other scripts".
    expect(references.get('A.001')).toHaveLength(3);
  });

  it('keeps tags apart, so one shared line does not warn about another', () => {
    const references = findReferences(
      new Map([
        ['script 2', [{ text: '/A.001/x' }, { text: '/A.002/y' }]],
        ['script 3', [{ text: '/A.001/x' }]],
      ]),
    );

    expect(references.get('A.001')).toHaveLength(2);
    expect(references.get('A.002')).toHaveLength(1);
  });
});
