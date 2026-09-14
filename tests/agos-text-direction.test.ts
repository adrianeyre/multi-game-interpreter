import { describe, expect, it } from 'vitest';
import { layoutTextRun, textRunWidth } from '../src/engine/agos/gfx/textLayout.js';
import { describeTextDirection, readTextDirection } from '../src/engine/agos/gfx/textDirection.js';

/**
 * ADR 0028 put Text direction on the release rather than in the Target, so that
 * nothing above the renderer has to know Hebrew Simon exists. These are the
 * tests that keep that promise honest.
 *
 * The claim worth testing is not "does Hebrew work". It is that the two
 * directions fill the **same box from opposite ends**, and that left-to-right is
 * the degenerate case rather than the default with an exception bolted on.
 */
describe('laying out a run of text', () => {
  it('puts the first glyph at the left edge going left to right', () => {
    const positions = layoutTextRun('abc', { x: 10, y: 4, glyphWidth: 8 });

    expect(positions.map((each) => each.x)).toEqual([10, 18, 26]);
    expect(positions.every((each) => each.y === 4)).toBe(true);
  });

  it('puts the first glyph at the right edge going right to left', () => {
    const positions = layoutTextRun('abc', {
      x: 10,
      y: 4,
      glyphWidth: 8,
      direction: 'rtl',
      boxWidth: 40,
    });

    // The box runs 10..50; the first character sits at its right-hand end.
    expect(positions.map((each) => each.x)).toEqual([42, 34, 26]);
  });

  it('fills the same box either way', () => {
    const ltr = layoutTextRun('abcd', { x: 0, y: 0, glyphWidth: 6 });
    const rtl = layoutTextRun('abcd', {
      x: 0,
      y: 0,
      glyphWidth: 6,
      direction: 'rtl',
      boxWidth: 24,
    });

    const extent = (positions: { x: number }[]): [number, number] => [
      Math.min(...positions.map((each) => each.x)),
      Math.max(...positions.map((each) => each.x)),
    ];

    expect(extent(ltr)).toEqual(extent(rtl));
    expect(textRunWidth('abcd', 6)).toBe(24);
  });

  it('returns positions in the order of the string, not of the screen', () => {
    const positions = layoutTextRun('xyz', {
      x: 0,
      y: 0,
      glyphWidth: 4,
      direction: 'rtl',
      boxWidth: 12,
    });

    // Glyph i of the text is at position i whichever way the run goes.
    // Reversing the string instead would break every caller that wants to know
    // which character it just drew.
    expect(positions.map((each) => each.index)).toEqual([0, 1, 2]);
  });

  it('refuses a right-to-left run with no box rather than putting it somewhere plausible', () => {
    expect(() => layoutTextRun('abc', { x: 0, y: 0, glyphWidth: 8, direction: 'rtl' })).toThrow(
      /needs the width of the box/,
    );
  });
});

/** A string pool as `GAMEPC` carries one: bytes, NUL-separated. */
function pool(...lines: string[]): Uint8Array {
  const bytes: number[] = [];
  for (const line of lines) {
    for (const character of line) bytes.push(character.charCodeAt(0) & 0xff);
    bytes.push(0);
  }
  return Uint8Array.from(bytes);
}

/** A line of Hebrew as code page 862 spells it: letters between 0x80 and 0x9A. */
function hebrew(length: number): string {
  let line = '';
  for (let index = 0; index < length; index += 1) {
    line += String.fromCharCode(0x80 + (index % 27));
  }
  return line;
}

describe('reading the direction out of a release', () => {
  it('says left to right for an English release', () => {
    const evidence = readTextDirection(pool('Take the lamp', 'You cannot do that'));

    expect(evidence.direction).toBe('ltr');
    expect(describeTextDirection(evidence)).toBe('text runs left to right');
  });

  it('says right to left for a Hebrew release', () => {
    const evidence = readTextDirection(pool(hebrew(60), hebrew(60)));

    expect(evidence.direction).toBe('rtl');
    expect(describeTextDirection(evidence)).toContain('right to left');
  });

  it('does not mistake a German release for a Hebrew one', () => {
    // The trap this test exists for: code page 437's accented Latin letters sit
    // in the same byte range as code page 862's Hebrew ones, so a reader that
    // asked "are there high bytes" would lay German out backwards. What
    // separates them is proportion — the accents are a garnish on ASCII.
    // Written as code page 437 bytes rather than as source text, because that
    // is what a German `GAMEPC` holds: ü is 0x81, ä is 0x84, ö is 0x94.
    const german = pool(
      'Nimm die Lampe und \u0094ffne die T\u0081r',
      'Das kannst du nicht tun, \u0081berhaupt nicht',
      'Gr\u0094\u0094e, Schl\u0081ssel, B\u0084r, T\u0081re, H\u0094hle',
    );

    const evidence = readTextDirection(german);

    expect(evidence.direction).toBe('ltr');
    expect(evidence.hebrewRange).toBeGreaterThan(0);
    expect(evidence.latin).toBeGreaterThan(evidence.hebrewRange);
  });

  it('does not claim a direction from a handful of high bytes', () => {
    // Below the evidence floor nothing is claimed either way, and the
    // degenerate case is left to right (ADR 0028).
    expect(readTextDirection(pool(hebrew(4))).direction).toBe('ltr');
  });
});
