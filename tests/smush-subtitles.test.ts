import { describe, expect, it } from 'vitest';
import {
  drawTextCue,
  measureText,
  parseTextSegments,
  wrapText,
} from '../src/engine/video/nutText.js';
import { SMUSH_TEXT_FLAG, type SmushTextCue } from '../src/engine/video/smush.js';
import { SCREEN_HEIGHT, SCREEN_WIDTH } from '../src/engine/gfx/Screen.js';
import type { NutFont, NutGlyph } from '../src/engine/video/nut.js';

/** A glyph that is a solid `size` block of one colour, transparent elsewhere. */
function block(size: number, colour: number): NutGlyph {
  return {
    width: size,
    height: size,
    xOffset: 0,
    yOffset: 0,
    transparency: 0,
    pixels: new Uint8Array(size * size).fill(colour),
  };
}

/** A font where every printable character is the same 4x4 block. */
function blockFont(size = 4, colour = 7): NutFont {
  const glyphs: NutGlyph[] = [];
  for (let code = 0; code < 128; code++) glyphs.push(block(size, colour));
  return { glyphs, height: size };
}

const cue = (over: Partial<SmushTextCue> = {}): SmushTextCue => ({
  x: 0,
  y: 0,
  flags: 0,
  left: 0,
  top: 0,
  width: SCREEN_WIDTH,
  height: SCREEN_HEIGHT,
  text: '',
  stringId: null,
  ...over,
});

const screen = () => new Uint8Array(SCREEN_WIDTH * SCREEN_HEIGHT);
const pixel = (target: Uint8Array, x: number, y: number) => target[y * SCREEN_WIDTH + x];

/**
 * Drawing a subtitle with a `.NUT` font.
 *
 * Tier 1 against a font built here, so what these establish is the layout
 * rules — escapes, centring, wrapping, clipping and transparency — rather than
 * that a real font's glyphs are read right, which `nut-font.test.ts` covers and
 * only a demo confirms.
 */
describe('the escape codes inside a line', () => {
  it('reads a colour change as an instruction, not as four characters', () => {
    // Read literally, `^c015` shows up on screen as a caret and three digits,
    // which is how a subtitle system announces it is not reading its own codes.
    const segments = parseTextSegments('^c015Ben^c001: get on the bike');

    expect(segments.map((s) => s.text)).toEqual(['Ben', ': get on the bike']);
    expect(segments.map((s) => s.colour)).toEqual([15, 1]);
  });

  it('reads a font change the same way', () => {
    expect(parseTextSegments('^f1TITLE').map((s) => s.font)).toEqual([1]);
  });

  it('keeps a caret that is not an escape, because a dropped one misspells', () => {
    expect(parseTextSegments('2^3').map((s) => s.text)).toEqual(['2^3']);
  });

  it('leaves the codes alone when the cue says to', () => {
    // Flag 0x80 means the game wants them literal.
    expect(parseTextSegments('^c015Ben', true)[0].text).toBe('^c015Ben');
  });
});

describe('fitting a line into the box the cue names', () => {
  it('measures a run by the glyphs it would draw', () => {
    expect(measureText(blockFont(4), 'abc')).toBe(12);
  });

  it('breaks on spaces rather than mid-word', () => {
    // Mid-word breaking fits more text and reads as a rendering fault.
    const lines = wrapText(blockFont(4), 'one two three', 32);
    expect(lines).toEqual(['one two', 'three']);
  });

  it('keeps a word that cannot fit rather than dropping it', () => {
    expect(wrapText(blockFont(4), 'unbreakable', 8)).toEqual(['unbreakable']);
  });
});

describe('drawing a cue', () => {
  it('puts the glyphs where the cue asked', () => {
    const target = screen();
    drawTextCue(cue({ x: 10, y: 20 }), 'a', [blockFont(4, 7)], target);

    expect(pixel(target, 10, 20)).toBe(7);
    expect(pixel(target, 13, 23)).toBe(7);
    expect(pixel(target, 14, 20)).toBe(0);
  });

  it('treats a centred cue’s x as the middle of the line, not its left edge', () => {
    // Read as a left edge, every centred subtitle sits half a line too far
    // right — which looks like a font problem rather than a layout one.
    const target = screen();
    drawTextCue(
      cue({ x: 100, y: 0, flags: SMUSH_TEXT_FLAG.Centre }),
      'aa',
      [blockFont(4, 7)],
      target,
    );

    expect(pixel(target, 96, 0)).toBe(7);
    expect(pixel(target, 103, 0)).toBe(7);
    expect(pixel(target, 104, 0)).toBe(0);
  });

  it('advances a wrapped line by the font’s height', () => {
    const target = screen();
    drawTextCue(
      cue({ x: 0, y: 0, flags: SMUSH_TEXT_FLAG.WordWrap, width: 32 }),
      'one two three',
      [blockFont(4, 7)],
      target,
    );

    expect(pixel(target, 0, 0)).toBe(7);
    expect(pixel(target, 0, 4)).toBe(7);
  });

  it('leaves the glyph’s own transparent colour alone, not colour zero', () => {
    // A `.NUT` picks transparency per glyph. Treating zero as transparent
    // everywhere punches holes in any font whose outline is colour 0.
    const font = blockFont(2, 0);
    font.glyphs[97] = {
      width: 2,
      height: 1,
      xOffset: 0,
      yOffset: 0,
      transparency: 9,
      pixels: new Uint8Array([0, 9]),
    };

    const target = screen().fill(5);
    drawTextCue(cue(), 'a', [font], target);

    expect(pixel(target, 0, 0)).toBe(0);
    expect(pixel(target, 1, 0)).toBe(5);
  });

  it('clips to the cue’s box rather than spilling across the screen', () => {
    const target = screen();
    drawTextCue(
      cue({ x: 0, y: 0, left: 0, top: 0, width: 6, height: 4 }),
      'aa',
      [blockFont(4, 7)],
      target,
    );

    expect(pixel(target, 5, 0)).toBe(7);
    // The second glyph starts at 4 and runs to 7; two of its columns are past
    // the box and must not be drawn.
    expect(pixel(target, 6, 0)).toBe(0);
  });

  it('falls back to a loaded font rather than drawing nothing', () => {
    // A line in the wrong face is legible; a missing line is not.
    const target = screen();
    expect(drawTextCue(cue(), 'a', [null, blockFont(4, 7)], target)).toBe(true);
    expect(pixel(target, 0, 0)).toBe(7);
  });

  it('says it drew nothing when no font is loaded at all', () => {
    expect(drawTextCue(cue(), 'a', [], screen())).toBe(false);
  });
});
