import { describe, expect, it } from 'vitest';
import {
  MAX_SMUSH_STRINGS,
  readSmushStrings,
  stringTableNameFor,
} from '../src/engine/video/trs.js';

const bytes = (text: string) => new TextEncoder().encode(text);

/** An `ETRS` file: sixteen bytes of header, then text against 0xCC. */
function etrs(text: string) {
  const payload = bytes(text);
  const out = new Uint8Array(16 + payload.length);
  out.set(bytes('ETRS'), 0);
  for (let i = 0; i < payload.length; i++) out[16 + i] = payload[i] ^ 0xcc;
  return out;
}

/**
 * The `.trs` table a `TRES` subtitle names its line from.
 *
 * Tier 1, and the format facts come from `StringResourceImpl::init`. What these
 * establish is that the three terminators real releases use are all read, and
 * that ids are taken from the records rather than from their order — the two
 * ways this can go wrong quietly rather than loudly.
 */
describe('finding the table for a video', () => {
  it('names it after the video, whatever the extension’s case', () => {
    expect(stringTableNameFor('INTRO.SAN')).toBe('INTRO.trs');
    expect(stringTableNameFor('jumpgorg.san')).toBe('jumpgorg.trs');
  });

  it('refuses a name with nothing to replace', () => {
    expect(stringTableNameFor('INTRO')).toBeNull();
  });
});

describe('reading a plain table', () => {
  it('takes each record’s id from the record, not from its position', () => {
    // Ids are explicit, so order says nothing — and a table read positionally
    // would be off by one through everything after the first gap.
    const strings = readSmushStrings(bytes('#42\r\nsecond\r\n\r\n#7\r\nfirst\r\n\r\n'))!;

    expect(strings.get(42)).toBe('second');
    expect(strings.get(7)).toBe('first');
  });

  it('reads the id from the end of the line, past whatever precedes it', () => {
    // What comes before the digits varies by release — a name, a comment, a
    // tag — and only the digits are the id.
    const strings = readSmushStrings(bytes('#DIALOGUE 13\r\na line\r\n\r\n'))!;
    expect(strings.get(13)).toBe('a line');
  });

  it('accepts a bare newline pair as a terminator', () => {
    // What the Steam Mac release of The Dig writes.
    expect(readSmushStrings(bytes('#1\nfirst\n\n#2\nsecond\n\n'))!.get(2)).toBe('second');
  });

  it('accepts one pair followed straight by the next record', () => {
    // What the Russian Full Throttle release writes. A terminator this did not
    // recognise would swallow every record after it into one.
    const strings = readSmushStrings(bytes('#1\r\nfirst\r\n#2\r\nsecond\r\n\r\n'))!;

    expect(strings.get(1)).toBe('first');
    expect(strings.get(2)).toBe('second');
  });

  it('joins a continuation line with a space, not with nothing', () => {
    // Without the space, two words run together at every line break in a long
    // subtitle — which reads as a typo rather than as a parsing fault.
    const strings = readSmushStrings(bytes('#1\r\nget on\r\n//the bike\r\n\r\n'))!;
    expect(strings.get(1)).toBe('get on the bike');
  });

  it('keeps a record that runs to the end of the file', () => {
    expect(readSmushStrings(bytes('#1\r\nlast line'))!.get(1)).toBe('last line');
  });

  it('reports nothing rather than an empty table for a file with no records', () => {
    expect(readSmushStrings(bytes('not a table at all'))).toBeNull();
  });

  it('stops at the cap the original reads into', () => {
    let text = '';
    for (let i = 0; i < MAX_SMUSH_STRINGS + 20; i++) text += `#${i}\r\nline\r\n\r\n`;
    expect(readSmushStrings(bytes(text))!.size).toBe(MAX_SMUSH_STRINGS);
  });
});

describe('reading The Dig’s shared table', () => {
  it('strips the header and undoes the obscuring', () => {
    expect(readSmushStrings(etrs('#3\r\nfaint light\r\n\r\n'), true)!.get(3)).toBe('faint light');
  });

  it('refuses a plain file when an ETRS one was asked for', () => {
    // A mismatched pair of files rather than something to decode anyway: read
    // as ETRS, plain text comes back as sixteen bytes short and inverted.
    expect(readSmushStrings(bytes('#1\r\nplain\r\n\r\n'), true)).toBeNull();
  });

  it('refuses a file too short to hold a header', () => {
    expect(readSmushStrings(bytes('ETRS'), true)).toBeNull();
  });
});
