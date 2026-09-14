import { describe, expect, it } from 'vitest';
import {
  placeTextBloc,
  Sword2Text,
  Sword2TextJustification,
  sword2SpeechFontIds,
  SWORD2_ENGLISH_SPEECH_FONT_ID,
  SWORD2_FINNISH_SPEECH_FONT_ID,
  SWORD2_POLISH_SPEECH_FONT_ID,
  TEXT_MARGIN,
} from '../src/engine/sword2/gfx/Sword2Text.js';
import {
  Sword2Screen,
  SWORD2_SCREEN_HEIGHT,
  SWORD2_SCREEN_WIDTH,
} from '../src/engine/sword2/gfx/Sword2Screen.js';
import { Sword2Resources } from '../src/engine/sword2/resource/Sword2Resources.js';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { Sword2FileType } from '../src/engine/sword2/resource/sword2Headers.js';
import {
  buildSword2Fixture,
  buildSword2Font,
  buildSword2Globals,
  buildSword2RunList,
  buildSword2Screen,
  sword2Header,
  SWORD2_FONT_LETTER,
} from './fixtureSword.js';

/**
 * A font whose characters are 4 wide, except `A` (65) which is 10.
 *
 * Proportional on purpose: a renderer that assumed a fixed width would pass
 * every wrapping test with a font whose letters all measured the same.
 */
const WIDTHS = Array.from({ length: 96 }, (_, index) => (index === 65 - 32 ? 10 : 4));

const FIXTURE = buildSword2Fixture([
  {
    name: 'general.clu',
    resources: [
      { id: 0, bytes: sword2Header(Sword2FileType.MOUSE_FILE, 'unused', 0) },
      { id: 1, bytes: buildSword2Globals([0, 0, 0, 0]) },
      { id: 2, bytes: buildSword2RunList([]) },
    ],
  },
  {
    name: 'text.clu',
    resources: [
      { id: 341, bytes: buildSword2Font(WIDTHS) },
      { id: 956, bytes: buildSword2Font(WIDTHS) },
    ],
  },
]);

function source(skip: string[] = []): MemoryDataSource {
  const entries: Array<[string, Uint8Array]> = [
    ['resource.inf', FIXTURE.inf],
    ['resource.tab', FIXTURE.tab],
    ['cd.inf', FIXTURE.cdInf],
  ];
  for (const [name, bytes] of FIXTURE.clusters) {
    if (!skip.includes(name)) entries.push([name, bytes]);
  }
  return new MemoryDataSource('sword2 text fixture', entries);
}

async function resources(skip: string[] = []): Promise<Sword2Resources> {
  return Sword2Resources.create(source(skip));
}

/** A text renderer with speech spacing, which is what `fnISpeak` uses. */
function speechText(res: Sword2Resources, ids: readonly number[] = [341]): Sword2Text {
  const text = new Sword2Text(res, ids);
  text.useSpeechSpacing();
  return text;
}

describe('finding the font', () => {
  it('asks again after the cluster arrives, rather than answering once', async () => {
    const res = await resources();
    const text = speechText(res);
    // Nothing is resident yet, so there are no subtitles and the reason says so.
    expect(text.fontMissing).toMatch(/text\.clu/i);

    await res.loadCluster('text.clu');

    // The same getter, a moment later. Cached, this would still be a refusal
    // and the demo would play its whole first scene with nothing on screen.
    expect(text.fontMissing).toBeNull();
    expect(text.resolvedFontId).toBe(341);
    expect(text.lineHeight).toBe(8);
  });

  it('falls through to a candidate that is present', async () => {
    const res = await resources();
    await res.loadCluster('text.clu');
    const text = speechText(res, [4242, 956]);
    expect(text.fontMissing).toBeNull();
    expect(text.resolvedFontId).toBe(956);
  });

  it('names the last candidate when none of them is there', async () => {
    const res = await resources(['text.clu']);
    const text = speechText(res, [4242, 341]);
    expect(text.fontMissing).not.toBeNull();
  });
});

describe('which language’s font a release wants', () => {
  it('reads the word for “save”, because there is no language byte', () => {
    // `initializeFontResourceFlags` (`maketext.cpp:859-876`).
    expect(sword2SpeechFontIds('tallenna')[0]).toBe(SWORD2_FINNISH_SPEECH_FONT_ID);
    expect(sword2SpeechFontIds('zapisz')[0]).toBe(SWORD2_POLISH_SPEECH_FONT_ID);
    expect(sword2SpeechFontIds('save')[0]).toBe(SWORD2_ENGLISH_SPEECH_FONT_ID);
    expect(sword2SpeechFontIds(null)[0]).toBe(SWORD2_ENGLISH_SPEECH_FONT_ID);
  });

  it('keeps the other fonts behind the chosen one', () => {
    // Presence alone cannot decide it: the demo ships 341 *and* 956.
    expect(sword2SpeechFontIds('tallenna')).toContain(SWORD2_ENGLISH_SPEECH_FONT_ID);
    expect(new Set(sword2SpeechFontIds('zapisz')).size).toBe(4 - 1);
  });
});

describe('measuring a sentence', () => {
  it('advances by the character’s own width, less three for speech', async () => {
    const res = await resources();
    await res.loadCluster('text.clu');
    const text = speechText(res);
    expect(text.charWidth(66)).toBe(4);
    expect(text.charWidth(65)).toBe(10);
    // Below space is DUD (64), the chequered flag in the '@' slot.
    expect(text.charWidth(7)).toBe(text.charWidth(64));
  });

  it('breaks at a space and records that the space is not drawn', async () => {
    const res = await resources();
    await res.loadCluster('text.clu');
    const text = speechText(res);
    // "BB" is 4+4-3 = 5 wide; joining another word costs 4 + 2*-3 = -2 ...
    // so a limit that admits one word and not two forces the break.
    const lines = text.analyzeSentence('BBBBBBBB BBBBBBBB', 15);
    expect(lines).toHaveLength(2);
    expect(lines[0].skipSpace).toBe(true);
    expect(lines[0].length).toBe(8);
    expect(lines[1].length).toBe(8);
  });

  it('fills lines with a word that is wider than the whole line', async () => {
    const res = await resources();
    await res.loadCluster('text.clu');
    const text = speechText(res);
    const lines = text.analyzeSentence('BBBBBBBBBBBBBBBB', 10);
    expect(lines.length).toBeGreaterThan(1);
    // Every character is accounted for; nothing is silently dropped.
    expect(lines.reduce((total, line) => total + line.length, 0)).toBe(16);
  });
});

describe('building a text sprite', () => {
  it('paints the letter ink in the pen and the rest in the border', async () => {
    const res = await resources();
    await res.loadCluster('text.clu');
    const text = speechText(res);
    const sprite = text.makeTextSprite('B', 200, 5, 194);
    expect(sprite).not.toBeNull();
    const { width, height, pixels } = sprite!;
    expect(width).toBe(4);
    expect(height).toBe(8);
    // The fixture glyph is transparent at 0,0, border ink down its left edge,
    // and letter ink everywhere else.
    expect(pixels[0]).toBe(0);
    expect(pixels[width]).toBe(194);
    expect(pixels[1]).toBe(5);
  });

  it('does not let one letter’s border eat the letter before it', async () => {
    const res = await resources();
    await res.loadCluster('text.clu');
    const text = speechText(res);
    // Speech spacing is -3, so these two 4-wide glyphs overlap by three
    // pixels and the second one's border column lands inside the first.
    const sprite = text.makeTextSprite('BB', 200, 5, 194)!;
    const row = sprite.width; // row 1, clear of the transparent corner
    expect(sprite.width).toBe(5);
    // Column 1 is the first letter's body and stays the pen.
    expect(sprite.pixels[row + 1]).toBe(5);
    expect(Array.from(sprite.pixels.subarray(row, row + sprite.width))).toEqual([194, 5, 5, 5, 5]);
  });

  it('copies the glyph’s own colours when the pen is zero', async () => {
    const res = await resources();
    await res.loadCluster('text.clu');
    const text = speechText(res);
    const sprite = text.makeTextSprite('B', 200, 0)!;
    expect(sprite.pixels[sprite.width + 1]).toBe(SWORD2_FONT_LETTER);
  });

  it('stacks two lines with the speech font’s negative line spacing', async () => {
    const res = await resources();
    await res.loadCluster('text.clu');
    const text = speechText(res);
    const sprite = text.makeTextSprite('BBBBBBBB BBBBBBBB', 15, 5)!;
    // 8 tall each, less six where they meet.
    expect(sprite.height).toBe(8 * 2 - 6);
  });
});

describe('placing a text bloc', () => {
  const display = { width: SWORD2_SCREEN_WIDTH, height: SWORD2_SCREEN_HEIGHT };

  it('hangs a subtitle above the point it was given', () => {
    const placed = placeTextBloc(
      320,
      300,
      100,
      20,
      Sword2TextJustification.CENTER_OF_BASE,
      display,
    );
    expect(placed).toEqual({ x: 270, y: 280 });
  });

  it('pulls a line back inside the display rather than off it', () => {
    const placed = placeTextBloc(0, 10, 100, 20, Sword2TextJustification.CENTER_OF_BASE, display);
    expect(placed.x).toBe(TEXT_MARGIN);
    expect(placed.y).toBe(TEXT_MARGIN);

    const low = placeTextBloc(640, 1000, 100, 20, Sword2TextJustification.CENTER_OF_BASE, display);
    expect(low.x).toBe(display.width - TEXT_MARGIN - 100);
    // Measured against this project's 480, not ScummVM's 400 game area.
    expect(low.y).toBe(display.height - TEXT_MARGIN - 20);
  });

  it('leaves a debug line exactly where it was asked for', () => {
    expect(placeTextBloc(3, 4, 100, 20, Sword2TextJustification.NONE, display)).toEqual({
      x: 3,
      y: 4,
    });
  });
});

describe('text blocs on the screen', () => {
  /** A screen over a room of the given size, with no cluster behind it. */
  function screenWith(width = SWORD2_SCREEN_WIDTH, height = SWORD2_SCREEN_HEIGHT): Sword2Screen {
    const screen = new Sword2Screen({
      fetch: () => ({ bytes: buildSword2Screen('room', width, height) }),
      describeMissingResource: () => 'absent',
    } as never);
    screen.initBackground(1, false);
    return screen;
  }

  const sprite = { width: 2, height: 1, pixels: Uint8Array.from([0, 7]) };

  it('hands out a handle that stays valid when an earlier bloc is killed', () => {
    const screen = screenWith();
    const first = screen.addTextBloc(sprite, 0, 0);
    const second = screen.addTextBloc(sprite, 0, 0);
    expect(first).toBe(1);
    expect(second).toBe(2);
    screen.killTextBloc(first);
    expect(screen.textBlocCount).toBe(1);
    // The freed slot is a hole, so `second` still names the bloc it named.
    expect(screen.addTextBloc(sprite, 0, 0)).toBe(1);
    screen.killTextBloc(second);
    expect(screen.textBlocCount).toBe(1);
  });

  it('ignores a handle of zero, which is what a line that never showed has', () => {
    const screen = screenWith();
    screen.addTextBloc(sprite, 0, 0);
    screen.killTextBloc(0);
    screen.killTextBloc(99);
    expect(screen.textBlocCount).toBe(1);
  });

  it('draws in display coordinates, so scrolling does not carry it away', () => {
    const screen = screenWith(SWORD2_SCREEN_WIDTH * 2, SWORD2_SCREEN_HEIGHT);
    screen.setScroll(300, 0);
    screen.addTextBloc(sprite, 10, 5);

    const out = new Uint8Array(SWORD2_SCREEN_WIDTH * SWORD2_SCREEN_HEIGHT);
    screen.present(out);
    const at = 5 * SWORD2_SCREEN_WIDTH + 10;
    // Zero is transparent (RDSPR_TRANS); the ink lands at x+1.
    expect(out[at]).toBe(0);
    expect(out[at + 1]).toBe(7);
  });
});
