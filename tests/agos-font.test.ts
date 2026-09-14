import { describe, expect, it } from 'vitest';
import {
  findAgosFont,
  glyphsOf,
  interpreterCandidates,
  isKnownInterpreterName,
  scoreFontTable,
} from '../src/engine/agos/gfx/agosFont.js';
import { drawTextWindow, wrapText } from '../src/engine/agos/gfx/drawWindow.js';

/**
 * An 8x8 font table of the shape AGOS interpreters carry.
 *
 * Built rather than transcribed, for the reason ADR 0032 gives: the glyphs are
 * content and this project reads formats. What it reproduces is the *shape* a
 * real table has — a blank space, every printable filled, a right-hand gap so
 * letters do not touch, and a bottom row only descenders reach.
 */
function buildFontTable(first = 32, count = 96): Uint8Array {
  // Every row pattern leaves both outer columns clear, which is the property
  // the scan is looking for and the one a picture does not have.
  const rows = [0x7c, 0x42, 0x5a, 0x66, 0x3c, 0x24, 0x18, 0x7e];
  const table = new Uint8Array(count * 8);
  for (let index = 0; index < count; index += 1) {
    const character = first + index;
    if (character === 32) continue; // the space, which is blank
    for (let row = 0; row < 7; row += 1) {
      table[index * 8 + row] = rows[(character + row) % rows.length]!;
    }
    // Descenders on a few, so the bottom row is quiet but not empty.
    if (character % 11 === 0) table[index * 8 + 7] = 0x18;
  }
  return table;
}

/**
 * An executable with a font in it and plenty that is not one.
 *
 * The padding is chosen to be the things a naive scan would trip on: a run of
 * zeros long enough to look like blank glyphs, a solid block, a gradient that
 * is a picture rather than letters, and byte patterns with no column structure
 * at all.
 */
function buildExecutable(at: number): Uint8Array {
  const table = buildFontTable();
  const bytes = new Uint8Array(at + table.length + 4096);
  for (let index = 0; index < bytes.length; index += 1) {
    if (index < 512)
      bytes[index] = 0; // a zero run
    else if (index < 1024)
      bytes[index] = 0xff; // a solid block
    else if (index < 2048)
      bytes[index] = index & 0xff; // a gradient
    else bytes[index] = (index * 37 + 11) & 0xff; // no column structure
  }
  bytes.set(table, at);
  return bytes;
}

describe('finding an AGOS font in an interpreter executable', () => {
  it('finds the table and reads the glyph a character means', () => {
    const at = 3000;

    const font = findAgosFont(buildExecutable(at));

    expect(font?.at).toBe(at);
    expect(font?.width).toBe(8);
    expect(font?.height).toBe(8);
    // The space is blank, which is the anchor the whole scan hangs off.
    expect(font?.glyph(' ')?.pixels.every((pixel) => pixel === 0)).toBe(true);
    expect(font?.glyph('A')?.pixels.some((pixel) => pixel !== 0)).toBe(true);
  });

  it('reads a glyph as rows of pixels, most significant bit leftmost', () => {
    const bytes = new Uint8Array(96 * 8);
    // Character 33 gets one inked pixel, at the far left of its top row.
    bytes[8] = 0x80;

    const font = findAgosFont(bytes, { floor: 0, at: 0 });

    expect([...font!.glyph('!')!.pixels.subarray(0, 8)]).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('answers nothing for a character the table does not cover', () => {
    const font = findAgosFont(buildExecutable(3000));

    expect(font?.glyph('א')).toBeUndefined();
  });

  it('finds nothing in an executable with no font in it', () => {
    const bytes = new Uint8Array(8192);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 37 + 11) & 0xff;

    expect(findAgosFont(bytes)).toBeNull();
  });

  it('refuses a run of blank glyphs, which is the easiest false positive', () => {
    expect(scoreFontTable(new Uint8Array(96 * 8), 0, { height: 8, first: 32, count: 96 })).toBe(0);
  });

  it('refuses a solid block, which has no gap at either edge', () => {
    const solid = new Uint8Array(96 * 8).fill(0xff);
    solid.fill(0, 0, 8); // a blank space, so only the shape tests can reject it

    const score = scoreFontTable(solid, 0, { height: 8, first: 32, count: 96 });

    expect(score).toBeLessThan(0.55);
  });

  it('scores a font table above the floor and a picture below it', () => {
    const shape = { height: 8, first: 32, count: 96 };
    const picture = new Uint8Array(96 * 8);
    for (let index = 8; index < picture.length; index += 1) picture[index] = (index * 5) & 0xff;

    expect(scoreFontTable(buildFontTable(), 0, shape)).toBeGreaterThan(0.8);
    expect(scoreFontTable(picture, 0, shape)).toBeLessThan(0.55);
  });

  it('refuses a sparse table, whose glyphs are broken rather than drawn', () => {
    // What a Windows executable is full of and what outscored Simon 1's real
    // font before the stroke test existed: runs with the quiet edges and the
    // blank rows the scan rewards, whose ink is scattered down the box in
    // pieces instead of forming one letter.
    const shape = { height: 8, first: 32, count: 96 };
    const sparse = new Uint8Array(96 * 8);
    for (let index = 1; index < 96; index += 1) {
      sparse[index * 8] = 0x2c;
      sparse[index * 8 + 1] = 0x14;
      sparse[index * 8 + 2] = 0x02;
      sparse[index * 8 + 4] = 0x28 + (index & 6);
      sparse[index * 8 + 6] = 0x02;
    }

    expect(scoreFontTable(sparse, 0, shape)).toBeLessThan(0.55);
  });

  it('picks the font over a sparse table that outscores it on every other test', () => {
    // The Simon 1 case end to end: both are in the executable, and the letters
    // being unbroken is the only thing that tells them apart.
    const bytes = buildExecutable(3000);
    for (let index = 1; index < 96; index += 1) {
      const at = 6000 + index * 8;
      bytes[at] = 0x2c;
      bytes[at + 1] = 0x14;
      bytes[at + 2] = 0x02;
      bytes[at + 4] = 0x28;
      bytes[at + 6] = 0x02;
      bytes[at + 3] = 0;
      bytes[at + 5] = 0;
      bytes[at + 7] = 0;
    }
    bytes.fill(0, 6000, 6008);

    expect(findAgosFont(bytes)?.at).toBe(3000);
  });

  it('reads at an offset a person supplies rather than scanning', () => {
    const at = 3000;

    const font = findAgosFont(buildExecutable(at), { at });

    expect(font?.at).toBe(at);
    expect(font?.score).toBeGreaterThan(0.8);
  });

  it('tries the named interpreters before any other executable', () => {
    const candidates = interpreterCandidates(['RSPTRFLT.EXE', 'GAMEPC', 'SIMON.EXE']);

    // The named interpreter leads; an unknown-named executable is still tried,
    // because repackagings rename things; a non-executable is not.
    expect(candidates[0]).toBe('SIMON.EXE');
    expect(candidates).toContain('RSPTRFLT.EXE');
    expect(candidates).not.toContain('GAMEPC');
  });

  it('drops the extenders and installers that are never the interpreter', () => {
    // A best-score sweep of a Simon 2 folder picks DOS4GW.EXE — its page tables
    // have the quiet-edged columns the scan rewards — so the impostors are
    // struck out by name before shape is ever consulted.
    const candidates = interpreterCandidates([
      'DOS4GW.EXE',
      'INSTALL.EXE',
      'SETUP.EXE',
      'RSPTRFLT.EXE',
    ]);

    expect(candidates).toEqual(['RSPTRFLT.EXE']);
  });

  it('knows which names are an interpreter outright and which are not', () => {
    expect(isKnownInterpreterName('SIMON.EXE')).toBe(true);
    // Simon 1 and Simon 2's real interpreters are not named for the engine, so
    // neither is taken on its name — shape has to choose them.
    expect(isKnownInterpreterName('Simon1.exe')).toBe(false);
    expect(isKnownInterpreterName('RSPTRFLT.EXE')).toBe(false);
  });
});

describe('text a game asks to show, reaching the screen', () => {
  const font = findAgosFont(buildExecutable(3000))!;
  // Twenty columns and three **rows** — the units `AgosWindow` documents.
  const window = { x: 0, y: 0, width: 20, height: 3 };

  function surface(width = 160, height = 24) {
    return { width, height, pixels: new Uint8Array(width * height) };
  }

  /** Which columns of a row have ink in them. */
  function inked(target: { width: number; pixels: Uint8Array }, row: number): number[] {
    const columns: number[] = [];
    for (let column = 0; column < target.width; column += 1) {
      if (target.pixels[row * target.width + column] !== 0) columns.push(column);
    }
    return columns;
  }

  it('draws the words in the colour the script asked for', () => {
    const target = surface();

    const result = drawTextWindow(target, ['hello'], glyphsOf(font), { window, colour: 7 });

    expect(result.lines).toBe(1);
    expect(result.missing).toEqual([]);
    expect(target.pixels.some((pixel) => pixel === 7)).toBe(true);
  });

  it('lays a right-to-left release out from the other end of the same box', () => {
    const left = surface();
    const right = surface();

    drawTextWindow(left, ['hi'], glyphsOf(font), { window, colour: 1 });
    drawTextWindow(right, ['hi'], glyphsOf(font), { window, colour: 1, direction: 'rtl' });

    // ADR 0028's property, exercised end to end rather than only in layout: the
    // same two glyphs, the same box, filled from opposite ends.
    const leftInk = inked(left, 0);
    const rightInk = inked(right, 0);
    expect(leftInk.length).toBeGreaterThan(0);
    expect(Math.min(...leftInk)).toBeLessThan(8);
    expect(Math.max(...rightInk)).toBeGreaterThan(window.width * 8 - 9);
    expect(leftInk).not.toEqual(rightInk);
  });

  it('keeps the newest lines when a window has run out of room', () => {
    const target = surface(160, 16);
    // Two **rows**, which is the unit a window's height is in: the reference
    // multiplies it by eight wherever it wants pixels.
    const short = { x: 0, y: 0, width: 20, height: 2 };

    const result = drawTextWindow(target, ['one', 'two', 'three'], glyphsOf(font), {
      window: short,
      colour: 1,
    });

    expect(result.lines).toBe(2);
  });

  it('reports a character the font lacks rather than substituting one', () => {
    const target = surface();

    const result = drawTextWindow(target, ['aאb'], glyphsOf(font), { window, colour: 1 });

    expect(result.missing).toEqual(['א']);
  });
});

describe('wrapping a line to a window', () => {
  it('breaks on spaces where it can', () => {
    expect(wrapText('the quick brown fox', 10)).toEqual(['the quick', 'brown fox']);
  });

  it('breaks mid-word rather than losing a word wider than the window', () => {
    expect(wrapText('antidisestablishment', 8)).toEqual(['antidise', 'stablish', 'ment']);
  });

  it('keeps a newline the game put in', () => {
    expect(wrapText('one\ntwo', 10)).toEqual(['one', 'two']);
  });
});
