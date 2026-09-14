import { describe, expect, it } from 'vitest';
import {
  readDigLanguageBundle,
  readTabLanguageBundle,
  resolveLine,
} from '../src/engine/script/v7/language.js';
import { v7MessageFallback, v7MessageKey } from '../src/engine/script/v7/message.js';

const bytes = (text: string) => new TextEncoder().encode(text);

/**
 * Reading a v7 game's text.
 *
 * The format facts come from `ScummEngine_v7::loadLanguageBundle`, and two of
 * them contradict what this epic was planned on: The Dig ships `LANGUAGE.BND`
 * rather than Full Throttle, and Full Throttle ships no bundle at all.
 */
describe('The Dig’s LANGUAGE.BND', () => {
  it('builds a tag from the base tag and a three-digit index', () => {
    const { bundle } = readDigLanguageBundle(
      bytes('@NEW\n007/faint light\n008/glowing crystal\n'),
      'LANGUAGE.BND',
    );

    expect(bundle.lines.get('NEW.007')).toBe('faint light');
    expect(bundle.lines.get('NEW.008')).toBe('glowing crystal');
  });

  it('pads the index to three digits, so 7 and 007 are the same entry', () => {
    const { bundle } = readDigLanguageBundle(bytes('@BOOK\n7/a line\n'), 'LANGUAGE.BND');
    expect(bundle.lines.get('BOOK.007')).toBe('a line');
  });

  it('carries the base tag down the lines beneath it', () => {
    const { bundle } = readDigLanguageBundle(
      bytes('@ONE\n001/first\n@TWO\n001/second\n'),
      'LANGUAGE.BND',
    );

    expect(bundle.lines.get('ONE.001')).toBe('first');
    expect(bundle.lines.get('TWO.001')).toBe('second');
  });

  it('skips the markers that are not entries', () => {
    // `#` is a subtag count, `!` a comment, and h/j/c mark Korean, Japanese and
    // Chinese text. None is an entry and none is an error.
    const { bundle, unreadable } = readDigLanguageBundle(
      bytes('!something\nh\nj\nc\n@TAG\n#3\n001/kept\n'),
      'LANGUAGE.BND',
    );

    expect(bundle.lines.size).toBe(1);
    expect(bundle.lines.get('TAG.001')).toBe('kept');
    expect(unreadable).toHaveLength(0);
  });

  it('decodes message text after an `e` marker, but not the tags', () => {
    // The `e` line turns on a 0x13 XOR over the message only. Decoding the tag
    // too would make every lookup miss.
    const encoded = [...'encoded']
      .map((ch) => String.fromCharCode(ch.charCodeAt(0) ^ 0x13))
      .join('');
    const { bundle } = readDigLanguageBundle(bytes(`e\n@TAG\n001/${encoded}\n`), 'LANGUAGE.BND');

    expect(bundle.lines.get('TAG.001')).toBe('encoded');
  });

  it('collects a line it cannot read instead of refusing the file', () => {
    // ScummVM errors here. One odd line should not take a game's whole script
    // down with it — but it must be visible, because a half-read bundle shows
    // up as missing dialogue.
    const { bundle, unreadable } = readDigLanguageBundle(
      bytes('@TAG\n001/kept\nnonsense\n'),
      'LANGUAGE.BND',
    );

    expect(bundle.lines.get('TAG.001')).toBe('kept');
    expect(unreadable).toEqual(['nonsense']);
  });
});

describe('the eight-character tag format', () => {
  it('reads a tag, a space, and the line', () => {
    const bundle = readTabLanguageBundle(bytes('GUYBRUSH Look behind you!\n'), 'LANGUAGE.TAB');
    expect(bundle.lines.get('GUYBRUSH')).toBe('Look behind you!');
  });

  it('turns a written \\n into a newline', () => {
    const bundle = readTabLanguageBundle(bytes('TAG00001 one\\ntwo\n'), 'LANGUAGE.TAB');
    expect(bundle.lines.get('TAG00001')).toBe('one\ntwo');
  });
});

describe('resolving a line a script names', () => {
  const { bundle } = readDigLanguageBundle(bytes('@NEW\n007/faint light\n'), 'LANGUAGE.BND');

  it('gives the bundle’s line when the tag is known', () => {
    const text = '/NEW.007/some fallback';
    expect(resolveLine(bundle, v7MessageKey(text), v7MessageFallback(text))).toBe('faint light');
  });

  it('gives the fallback when the tag is unknown', () => {
    const text = '/NEW.999/some fallback';
    expect(resolveLine(bundle, v7MessageKey(text), v7MessageFallback(text))).toBe('some fallback');
  });

  it('gives the fallback when there is no bundle at all', () => {
    // Full Throttle's normal case, not an error: it ships no bundle, and every
    // line displays the text carried beside its tag.
    const text = '/FT.001/Hey, Ben.';
    expect(resolveLine(null, v7MessageKey(text), v7MessageFallback(text))).toBe('Hey, Ben.');
  });

  it('matches a tag regardless of the case a script writes it in', () => {
    const text = '/new.007/fallback';
    expect(resolveLine(bundle, v7MessageKey(text), v7MessageFallback(text))).toBe('faint light');
  });
});
