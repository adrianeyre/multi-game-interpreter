/**
 * Broken Sword II's subtitles: the font, the line breaking, and the sprite.
 *
 * Sword1 has `SwordText` and this is its opposite number, not its sibling —
 * ADR 0036's rule, that a widget or a codec may cross between the two families
 * and a record may not, is why these are two files rather than one with a
 * parameter. The two renderers agree on the idea (a font is a sprite resource
 * whose frames are the characters, a sentence is broken into lines and stamped
 * into one sprite) and on almost no arithmetic:
 *
 * | | Sword1 | Sword2 |
 * | --- | --- | --- |
 * | Font resource | `GAME_FONT`, a Sword1 sprite | an *animation* resource, walked by `sword2Animation` |
 * | Character spacing | one `OVERLAP`, subtracted | `_charSpacing`, **added**, and negative for the speech font |
 * | Line spacing | none — lines butt | `_lineSpacing`, -6 for the speech font |
 * | Joining two words | `width(space) - 2 * overlap` | `width(space) + 2 * charSpacing` |
 * | A word wider than the line | gets its own line | fills lines and spills, tracked by `skipSpace` |
 * | The border colour | always `BORDER_COL` | a parameter, because a sequence needs a different pen |
 *
 * The `skipSpace` flag is the one that is easy to miss and impossible to fake:
 * `buildTextSprite` walks the sentence by *consuming* `line.length` characters
 * per line, so whether the space that broke the line was counted into that
 * length decides where every later line starts. `maketext.cpp:186-189` sets it
 * when a word spills, and `:468` skips the character.
 *
 * ## The font is an animation, and the frames are the characters
 *
 * `SpchFont` (341) is an ordinary animation resource: 224 frames, one per
 * character from space to 255, each 26 pixels tall and its own width. So a
 * character's width is a resource read rather than a table lookup, which is
 * what makes the font proportional, and `charHeight` is frame 0's height —
 * read from the font so that the Finnish and Polish fonts lay out correctly
 * rather than being assumed to match the English one.
 *
 * A character below space is drawn as frame 64 — `DUD`, the chequered flag that
 * sits in the `'@'` position. That is Revolution's fallback and it keeps a
 * control byte in a translated string from indexing off the end.
 *
 * ## Three inks, and why the border is conditional
 *
 * A glyph uses two ink values: `LETTER_COL` becomes the speaker's pen, and
 * everything else that is not transparent becomes the border pen. The border is
 * only written **where the destination is still empty**, and that is not an
 * optimisation: `_charSpacing` is -3 for the speech font, so characters
 * overlap by three pixels and the next character's border would otherwise eat
 * the previous character's body.
 *
 * A pen of zero means "copy the glyph's own colours", which is how the
 * multi-coloured control-panel fonts are drawn.
 */

import {
  Sword2AnimCompression,
  sword2Animation,
  type Sword2Animation,
} from '../resource/sword2Headers.js';
import type { Sword2Resources } from '../resource/Sword2Resources.js';
import { decodeSword2Frame } from './sword2Decode.js';

/**
 * The ink values a glyph uses.
 *
 * Palette indexes rather than small tags. The two PlayStation values exist
 * because that conversion recoloured the letter body; `copyCharRaw` treats all
 * three the same (`maketext.cpp:537-543`).
 */
export const LETTER_COL = 193;
export const LETTER_COL_PSX1 = 33;
export const LETTER_COL_PSX2 = 34;

/**
 * The default border pen.
 *
 * "should be black but note that we have to use a different pen number during
 * sequences" — `maketext.h:33`. So it is 194 and not 0, and it is a parameter.
 */
export const BORDER_PEN = 194;

/** Revolution's cap on lines in one text sprite. `maketext.cpp:58`. */
export const MAX_LINES = 30;

/** The first character the font carries, and the fallback for anything below it. */
const FIRST_CHAR = 32;
const DUD = 64;
const SPACE = 32;

/** The speech font's spacing. Hard-wired rather than part of the resource. */
export const SPEECH_LINE_SPACING = -6;
export const SPEECH_CHAR_SPACING = -3;
/** The console font's, which is the other way round. */
export const CONSOLE_LINE_SPACING = 0;
export const CONSOLE_CHAR_SPACING = 1;

/** One line of the broken-up sentence. `LineInfo`, `maketext.h:73`. */
export interface Sword2LineInfo {
  /** Width in pixels. */
  width: number;
  /** Length in characters. */
  length: number;
  /** Whether a space follows this line and must be stepped over. */
  skipSpace: boolean;
}

/** A rendered line of text: 8-bit palette indexes, zero transparent. */
export interface Sword2TextSprite {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

interface Glyph {
  width: number;
  height: number;
  pixels: Uint8Array;
}

/**
 * Where the font ids come from, when the answer is not yet known.
 *
 * A plain list is the ordinary case. A function is for the language test:
 * which font a release wants is decided by reading a *text* resource, and text
 * lives in a cluster that may not be resident when the engine is built. Asked
 * lazily, the question gets its right answer a few frames later instead of a
 * wrong one immediately.
 */
export type Sword2FontCandidates = number | readonly number[] | (() => readonly number[]);

export class Sword2Text {
  private readonly glyphs = new Map<number, Glyph | null>();
  private animation: Sword2Animation | null = null;
  private charHeight = 0;
  /** The candidate that fetched, once one has. Null until then. */
  private fontId: number | null = null;
  private readonly candidateSource: Sword2FontCandidates;

  private lineSpacing = SPEECH_LINE_SPACING;
  private charSpacing = SPEECH_CHAR_SPACING;
  private borderPen = BORDER_PEN;

  constructor(
    private readonly resources: Sword2Resources,
    fontId: Sword2FontCandidates,
  ) {
    this.candidateSource = fontId;
    if (Array.isArray(fontId) && fontId.length === 0) {
      throw new Error('Sword2Text needs at least one font id to try');
    }
  }

  /** The ids to try, this time round. Asked again on every failed probe. */
  private candidates(): readonly number[] {
    const source = this.candidateSource;
    if (typeof source === 'number') return [source];
    if (typeof source === 'function') return source();
    return source;
  }

  /**
   * Why there are no subtitles, or null when there are.
   *
   * A getter that re-probes rather than a field answered once, for the reason
   * `SwordText.fontMissing` records: clusters arrive asynchronously here, so
   * "the font is not resident" is true at construction and stops being true a
   * few frames later. Answered once and cached, a game whose font is right
   * there reports no subtitles for the whole session.
   */
  get fontMissing(): string | null {
    if (this.resolve()) return null;
    const candidates = this.candidates();
    const last = candidates[candidates.length - 1];
    if (last === undefined) return 'no font resource id to try';
    return this.resources.describeMissingResource(last);
  }

  /** The resource id the font actually came from, or null. */
  get resolvedFontId(): number | null {
    this.resolve();
    return this.fontId;
  }

  /**
   * Finds the first candidate that fetches and reads a font, and measures it.
   *
   * Chosen by *presence* rather than by a language flag, the same way Sword1
   * does it: a release's language is not established until its text is read,
   * and the Finnish and Polish fonts are simply extra resources when they ship.
   */
  private resolve(): boolean {
    if (this.fontId !== null) return true;
    for (const candidate of this.candidates()) {
      const resource = this.resources.fetch(candidate);
      if (!resource) continue;
      const animation = sword2Animation(resource.bytes);
      if (!animation || animation.frames.length === 0) continue;
      this.fontId = candidate;
      this.animation = animation;
      const first = this.glyph(SPACE);
      if (!first) {
        // The resource fetched and is not a font this reader understands.
        // Clearing the id rather than keeping it lets a later candidate be
        // tried, and keeps `fontMissing` describing the one that matters.
        this.fontId = null;
        this.animation = null;
        this.glyphs.clear();
        continue;
      }
      // Every character in a font is the same height, so the first one's is the
      // line height (`charHeight`, `maketext.cpp:521`).
      this.charHeight = first.height;
      return true;
    }
    return false;
  }

  /**
   * Picks the spacing for a font, the way `makeTextSprite` opens.
   *
   * Line and character spacing "are hard-wired, rather than being part of the
   * resource" (`maketext.cpp:147`), and which pair applies is decided by
   * comparing the requested font id against the speech and console ones.
   */
  useSpeechSpacing(): void {
    this.lineSpacing = SPEECH_LINE_SPACING;
    this.charSpacing = SPEECH_CHAR_SPACING;
  }

  useConsoleSpacing(): void {
    this.lineSpacing = CONSOLE_LINE_SPACING;
    this.charSpacing = CONSOLE_CHAR_SPACING;
  }

  /** The line height, which a sprite's height is built from. */
  get lineHeight(): number {
    this.resolve();
    return this.charHeight;
  }

  /** One character's glyph, decoded and cached. */
  private glyph(ch: number): Glyph | null {
    const code = ch < FIRST_CHAR ? DUD : ch;
    const cached = this.glyphs.get(code);
    if (cached !== undefined) return cached;

    // `resolve` calls this for the space character with `animation` already
    // set, so this is not the recursion it looks like.
    if (this.animation === null && !this.resolve()) return null;
    const animation = this.animation;
    if (!animation) return null;

    const frame = animation.frames[code - FIRST_CHAR];
    if (!frame) {
      this.glyphs.set(code, null);
      return null;
    }
    let decoded: { pixels: Uint8Array; ok: boolean };
    try {
      decoded = decodeSword2Frame(
        frame.data,
        frame.compression,
        frame.header.width,
        frame.header.height,
        animation.colourTable ?? undefined,
      );
    } catch {
      this.glyphs.set(code, null);
      return null;
    }
    // A glyph that decoded short is still drawn: `ok` means every pixel was
    // written, and a font frame that runs out mid-row produces a clipped
    // character rather than no line of subtitles at all.
    const glyph = {
      width: frame.header.width,
      height: frame.header.height,
      pixels: decoded.pixels,
    };
    this.glyphs.set(code, glyph);
    return glyph;
  }

  /** A character's advance, before spacing. Zero when the font is unreadable. */
  charWidth(ch: number): number {
    return this.glyph(ch)?.width ?? 0;
  }

  /**
   * Breaks a sentence into lines no wider than `maxWidth`. `analyzeSentence`.
   *
   * Two cases, and the second is the one worth reading. A word that fits is
   * appended with a joining space; a word **wider than the whole line** cannot
   * be, so it is filled across as many lines as it takes, character by
   * character. That branch exists in ScummVM for Chinese, which has no spaces,
   * and it is also what stops a long unbroken string from producing a sprite
   * one character wide and thirty lines tall.
   */
  analyzeSentence(text: string, maxWidth: number): Sword2LineInfo[] {
    // "NB. SPACE requires TWICE the '_charSpacing' to join a word to line".
    const joinWidth = this.charWidth(SPACE) + 2 * this.charSpacing;

    const lines: Sword2LineInfo[] = [{ width: 0, length: 0, skipSpace: false }];
    let lineNo = 0;
    let pos = 0;
    let firstWord = true;

    const codeAt = (at: number): number => (at < text.length ? text.charCodeAt(at) : 0);

    do {
      let wordWidth = 0;
      let wordLength = 0;
      while (pos + wordLength < text.length && codeAt(pos + wordLength) !== SPACE) {
        wordWidth += this.charWidth(codeAt(pos + wordLength)) + this.charSpacing;
        wordLength++;
      }
      pos += wordLength;
      // No character spacing after the word's last letter.
      wordWidth -= this.charSpacing;

      if (wordWidth > maxWidth) {
        // The word is wider than a whole line. Back up and fill.
        pos -= wordLength;
        if (!firstWord) {
          const oneMore = joinWidth + this.charWidth(codeAt(pos)) + this.charSpacing;
          if (lines[lineNo].width + oneMore <= maxWidth) {
            lines[lineNo].width += oneMore;
            lines[lineNo].length += 1 + oneMore;
            lines[lineNo].skipSpace = false;
          } else {
            lines[lineNo].skipSpace = true;
            lineNo++;
            if (lineNo >= MAX_LINES) break;
            lines[lineNo] = { width: wordWidth, length: wordLength, skipSpace: false };
          }
        }
        while (pos < text.length && codeAt(pos) !== SPACE) {
          const advance = this.charWidth(codeAt(pos)) + this.charSpacing;
          if (lines[lineNo].width + advance <= maxWidth) {
            lines[lineNo].width += advance;
            lines[lineNo].length += 1;
          } else {
            lines[lineNo].skipSpace = false;
            lineNo++;
            if (lineNo >= MAX_LINES) break;
            lines[lineNo] = { width: advance, length: 1, skipSpace: false };
          }
          pos++;
        }
        if (lineNo >= MAX_LINES) break;
        continue;
      }

      while (pos < text.length && codeAt(pos) === SPACE) pos++;

      if (firstWord) {
        lines[0] = { width: wordWidth, length: wordLength, skipSpace: false };
        firstWord = false;
      } else {
        const spaceNeeded = joinWidth + wordWidth;
        if (lines[lineNo].width + spaceNeeded <= maxWidth) {
          lines[lineNo].width += spaceNeeded;
          lines[lineNo].length += 1 + wordLength;
        } else {
          // The word spills to the next line, so the space that separated them
          // is not drawn — and must still be stepped over when the sprite is
          // built. That is what `skipSpace` is for.
          lines[lineNo].skipSpace = true;
          lineNo++;
          if (lineNo >= MAX_LINES) break;
          lines[lineNo] = { width: wordWidth, length: wordLength, skipSpace: false };
        }
      }
    } while (pos < text.length);

    return lines.slice(0, Math.min(lineNo + 1, MAX_LINES));
  }

  /**
   * Renders a sentence into a sprite, or null when the font is unreadable.
   *
   * `maxWidth` of zero or less reads as 400 — `formText`'s own default for a
   * speech object whose `width` was never set (`speech.cpp:163-165`).
   */
  makeTextSprite(
    text: string,
    maxWidth: number,
    pen: number,
    border: number = BORDER_PEN,
  ): Sword2TextSprite | null {
    if (!this.resolve()) return null;
    this.borderPen = border;
    const limit = maxWidth > 0 ? maxWidth : 400;
    const lines = this.analyzeSentence(text, limit);
    if (lines.length === 0) return null;

    const spriteWidth = Math.max(1, ...lines.map((line) => line.width));
    const spriteHeight = Math.max(
      1,
      this.charHeight * lines.length + this.lineSpacing * (lines.length - 1),
    );
    const pixels = new Uint8Array(spriteWidth * spriteHeight);

    let consumed = 0;
    let top = 0;
    for (const line of lines) {
      // Centre each line within the widest.
      let x = Math.floor((spriteWidth - line.width) / 2);
      for (let index = 0; index < line.length; index++) {
        const ch = text.charCodeAt(consumed + index);
        if (Number.isNaN(ch)) break;
        x += this.drawChar(ch, pixels, spriteWidth, spriteHeight, x, top, pen) + this.charSpacing;
      }
      consumed += line.length;
      if (line.skipSpace) consumed++;
      top += this.charHeight + this.lineSpacing;
    }

    return { width: spriteWidth, height: spriteHeight, pixels };
  }

  /** Stamps one glyph, returning its advance. Border only where empty. */
  private drawChar(
    ch: number,
    out: Uint8Array,
    pitch: number,
    rows: number,
    x: number,
    y: number,
    pen: number,
  ): number {
    const glyph = this.glyph(ch);
    if (!glyph) return 0;
    for (let row = 0; row < glyph.height; row++) {
      const destY = y + row;
      if (destY < 0 || destY >= rows) continue;
      const to = destY * pitch;
      for (let column = 0; column < glyph.width; column++) {
        const destX = x + column;
        if (destX < 0 || destX >= pitch) continue;
        const ink = glyph.pixels[row * glyph.width + column];
        if (pen === 0) {
          // "Pen is zero, so just copy character sprites directly into text
          // sprite without remapping colors." A multi-coloured font.
          out[to + destX] = ink;
          continue;
        }
        if (ink === 0) continue;
        if (ink === LETTER_COL || ink === LETTER_COL_PSX1 || ink === LETTER_COL_PSX2) {
          out[to + destX] = pen;
        } else if (!out[to + destX]) {
          out[to + destX] = this.borderPen;
        }
      }
    }
    return glyph.width;
  }
}

/**
 * Font resource ids, by language. `defs.h:174-191`.
 *
 * Nine numbers in a header, not a table a generator could extract from the
 * game data, so they are written here the way ADR 0029 allows: transcribed
 * constants with the reference named beside them.
 */
export const SWORD2_CONSOLE_FONT_ID = 340;
export const SWORD2_ENGLISH_SPEECH_FONT_ID = 341;
export const SWORD2_POLISH_SPEECH_FONT_ID = 955;
export const SWORD2_FINNISH_SPEECH_FONT_ID = 956;
export const SWORD2_ENGLISH_CONTROLS_FONT_ID = 2005;
export const SWORD2_FINNISH_CONTROLS_FONT_ID = 959;
export const SWORD2_POLISH_CONTROLS_FONT_ID = 3686;

/** The text resource `initializeFontResourceFlags` reads, and the line in it. */
export const SWORD2_TEXT_RES = 3258;
export const SWORD2_SAVE_LINE_NO = 1;

/**
 * The speech fonts to try, in order, given line 1 of text resource 3258.
 *
 * `initializeFontResourceFlags` (`maketext.cpp:859-876`) asks a release what
 * its word for "save" is: "tallenna" is Finnish, "zapisz" is Polish, anything
 * else is treated as English. It is a strange test and it is the one the game
 * ships with — there is no language byte anywhere in the data.
 *
 * Presence alone will not do here, which is why this exists at all. The demo
 * ships *both* 341 and 956, so "the first font id that fetches" picks by
 * whichever id was written first rather than by what the release is. The rest
 * of the list stays behind the chosen id as a fallback: a release missing its
 * own font is better off with the wrong letters than with no subtitles.
 */
export function sword2SpeechFontIds(saveLine: string | null): readonly number[] {
  const english = [
    SWORD2_ENGLISH_SPEECH_FONT_ID,
    SWORD2_FINNISH_SPEECH_FONT_ID,
    SWORD2_POLISH_SPEECH_FONT_ID,
  ];
  const word = saveLine?.trim().toLowerCase() ?? '';
  if (word === 'tallenna') return [SWORD2_FINNISH_SPEECH_FONT_ID, ...english];
  if (word === 'zapisz') return [SWORD2_POLISH_SPEECH_FONT_ID, ...english];
  return english;
}

/** Kept beside the decoder so a caller need not import the enum to read a font. */
export const SWORD2_FONT_UNCOMPRESSED = Sword2AnimCompression.NONE;

/**
 * Where a text sprite is anchored relative to the point it was given.
 *
 * `maketext.h:40-54`. Speech always uses `CENTER_OF_BASE`: the point is where
 * the speaker's mouth is, and the sprite hangs above it.
 */
export const Sword2TextJustification = {
  /** Top-left at the point, and no margin check. Debug text only. */
  NONE: 0,
  CENTER_OF_BASE: 1,
  CENTER_OF_TOP: 2,
  LEFT_OF_TOP: 3,
  RIGHT_OF_TOP: 4,
  LEFT_OF_BASE: 5,
  RIGHT_OF_BASE: 6,
  LEFT_OF_CENTER: 7,
  RIGHT_OF_CENTER: 8,
  CENTER_OF_CENTER: 9,
} as const;

/** How far a text sprite is kept from the edges of the display. */
export const TEXT_MARGIN = 12;

/**
 * Anchors a text sprite and pulls it back inside the display. `buildNewBloc`.
 *
 * `display` is this project's 640x480 and ScummVM's is 640x400 with a 40-pixel
 * menu bar above and below. The difference is the one `Sword2Screen.maxScrollY`
 * already records — this project draws the whole 480 of the room and overlays
 * the menus rather than reserving two strips — so the margin is measured
 * against what is actually on screen here. Using 400 would park every subtitle
 * 80 pixels above the bottom of a display that has nothing there.
 */
export function placeTextBloc(
  x: number,
  y: number,
  width: number,
  height: number,
  justification: number,
  display: { width: number; height: number },
): { x: number; y: number } {
  if (justification === Sword2TextJustification.NONE) return { x, y };

  let placedX = x;
  let placedY = y;
  switch (justification) {
    case Sword2TextJustification.CENTER_OF_BASE:
      placedX -= Math.trunc(width / 2);
      placedY -= height;
      break;
    case Sword2TextJustification.CENTER_OF_TOP:
      placedX -= Math.trunc(width / 2);
      break;
    case Sword2TextJustification.CENTER_OF_CENTER:
      placedX -= Math.trunc(width / 2);
      placedY -= Math.trunc(height / 2);
      break;
    case Sword2TextJustification.LEFT_OF_TOP:
      break;
    case Sword2TextJustification.RIGHT_OF_TOP:
      placedX -= width;
      break;
    case Sword2TextJustification.LEFT_OF_BASE:
      placedY -= height;
      break;
    case Sword2TextJustification.RIGHT_OF_BASE:
      placedX -= width;
      placedY -= height;
      break;
    case Sword2TextJustification.LEFT_OF_CENTER:
      placedY -= Math.trunc(height / 2);
      break;
    case Sword2TextJustification.RIGHT_OF_CENTER:
      placedX -= width;
      placedY -= Math.trunc(height / 2);
      break;
    default:
      break;
  }

  const left = TEXT_MARGIN;
  const right = display.width - TEXT_MARGIN - width;
  const top = TEXT_MARGIN;
  const bottom = display.height - TEXT_MARGIN - height;

  if (placedX < left) placedX = left;
  else if (placedX > right) placedX = right;
  if (placedY < top) placedY = top;
  else if (placedY > bottom) placedY = bottom;

  return { x: placedX, y: placedY };
}
