import { describe, expect, it } from 'vitest';
import { readDigLanguageBundle } from '../src/engine/script/v7/language.js';
import {
  findReferences,
  importStrings,
  isEdited,
  writeDigLanguageBundle,
} from '../src/authoring/languageStrings.js';

const bytes = (text: string) => new TextEncoder().encode(text);
const read = (text: string) => readDigLanguageBundle(bytes(text), 'LANGUAGE.BND').bundle;

/**
 * A v7 game's text as editable Project content (ADR 0009).
 *
 * Scoped to The Dig. Full Throttle ships no bundle, so its words are the
 * fallbacks inside its instructions and editing them is ADR 0005 instruction
 * editing, which already works — the correction is recorded on #112.
 */
describe('importing a bundle as project content', () => {
  it('keeps each line with the text it came in as', () => {
    const strings = importStrings(read('@NEW\n007/faint light\n008/glowing crystal\n'));

    expect(strings.entries).toHaveLength(2);
    expect(strings.entries[0]).toEqual({
      tag: 'NEW.007',
      text: 'faint light',
      original: 'faint light',
    });
  });

  it('records which file it came from, so export writes back the one it read', () => {
    expect(importStrings(read('@A\n001/x\n')).source).toBe('LANGUAGE.BND');
  });

  it('knows an edited entry from an untouched one', () => {
    const strings = importStrings(read('@A\n001/before\n'));
    expect(isEdited(strings.entries[0])).toBe(false);

    strings.entries[0].text = 'after';
    expect(isEdited(strings.entries[0])).toBe(true);
  });
});

describe('showing an edit’s reach before it is committed', () => {
  it('finds every script that references a tag', () => {
    // The property that makes this issue need care: one string can be
    // referenced from many scripts, so editing it changes every place it
    // appears. That is not true of Preserved bytes or of Actions.
    const references = findReferences(
      new Map([
        ['script 2', [{ text: 'talkActor(1, "/NEW.007/faint light")' }]],
        ['script 9', [{ text: 'printLine("/NEW.007/faint light")' }]],
        ['script 12', [{ text: 'talkActor(2, "/NEW.008/other")' }]],
      ]),
    );

    expect(references.get('NEW.007')).toEqual(['script 2', 'script 9']);
    expect(references.get('NEW.008')).toEqual(['script 12']);
  });

  it('counts a script once however many times it uses a tag', () => {
    const references = findReferences(
      new Map([['script 2', [{ text: '/A.001/x' }, { text: '/A.001/x' }]]]),
    );
    expect(references.get('A.001')).toEqual(['script 2']);
  });

  it('matches a tag whatever case the script writes it in', () => {
    const references = findReferences(new Map([['script 2', [{ text: '/new.007/x' }]]]));
    expect(references.get('NEW.007')).toEqual(['script 2']);
  });

  it('does not treat an ordinary slash in dialogue as a tag', () => {
    const references = findReferences(
      new Map([['script 2', [{ text: 'talkActor(1, "and/or something")' }]]]),
    );
    expect(references.size).toBe(0);
  });
});

describe('writing the bundle back', () => {
  it('round-trips an untouched bundle to the same lines', () => {
    // The reason `original` is kept: nothing edited must produce a file with
    // the same lines, not merely one that parses.
    const source = '@NEW\n007/faint light\n008/glowing crystal\n';
    const written = writeDigLanguageBundle(importStrings(read(source)));
    const reread = readDigLanguageBundle(written, 'LANGUAGE.BND').bundle;

    expect(reread.lines.get('NEW.007')).toBe('faint light');
    expect(reread.lines.get('NEW.008')).toBe('glowing crystal');
  });

  it('moves only the entry that was edited', () => {
    const strings = importStrings(read('@NEW\n007/faint light\n008/glowing crystal\n'));
    strings.entries[0].text = 'a dim glow';

    const reread = readDigLanguageBundle(writeDigLanguageBundle(strings), 'LANGUAGE.BND').bundle;

    expect(reread.lines.get('NEW.007')).toBe('a dim glow');
    expect(reread.lines.get('NEW.008')).toBe('glowing crystal');
  });

  it('keeps entries grouped under the base tag the file uses', () => {
    const strings = importStrings(read('@ONE\n001/first\n@TWO\n001/second\n'));
    const written = new TextDecoder().decode(writeDigLanguageBundle(strings));

    expect(written).toContain('@ONE');
    expect(written).toContain('@TWO');
  });

  it('round-trips an encoded bundle as plain text', () => {
    // The `e` marker is not re-emitted: it stops a player reading the script in
    // a text editor and costs the game nothing, and writing an encoded file
    // this reader could not read back would be the worse failure.
    const encoded = [...'secret'].map((c) => String.fromCharCode(c.charCodeAt(0) ^ 0x13)).join('');
    const strings = importStrings(read(`e\n@A\n001/${encoded}\n`));

    const reread = readDigLanguageBundle(writeDigLanguageBundle(strings), 'x').bundle;
    expect(reread.lines.get('A.001')).toBe('secret');
  });

  it('refuses rather than dropping a tag it cannot rebuild', () => {
    // A dropped line is missing dialogue, which the ADR names as the worse of
    // the two export failures — a game full of blanks rather than one that
    // fails to load.
    const strings = importStrings(read('@A\n001/kept\n'));
    strings.entries.push({ tag: 'NODOT', text: 'x', original: 'x' });

    expect(() => writeDigLanguageBundle(strings)).toThrow(/missing dialogue/);
  });
});
