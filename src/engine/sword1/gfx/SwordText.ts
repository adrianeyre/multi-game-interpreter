/**
 * Broken Sword's subtitles: the font, the line breaking, and the sprite.
 *
 * A text line becomes a **sprite**, drawn through the same path as every other
 * sprite, which is why `SwordScreen` has a text branch and not a text renderer:
 * a subtitle is an object with `TYPE_TEXT` whose graphics come from here.
 *
 * ## The font is a sprite resource
 *
 * `GAME_FONT` is an ordinary sprite resource whose frames are the characters,
 * starting at space. So a character's width is its frame's width, which is why
 * the font is proportional and why `charWidth` is a resource read rather than a
 * table lookup. A character below space is drawn as frame 64 — the original's
 * fallback, which keeps a control byte in a translated string from indexing off
 * the end.
 *
 * ## Three colours, and the reason the border is conditional
 *
 * A font glyph uses two ink values: `LETTER_COL` becomes the speaker's pen
 * colour, and `BORDER_COL` becomes the outline. The outline is only drawn
 * **where the destination is still empty**, and that is not an optimisation:
 * characters overlap by three pixels (`OVERLAP`), so the next character's
 * border would otherwise erase the previous character's body.
 *
 * ## Why lines are centred and measured twice
 *
 * `analyzeSentence` measures words to break the line, then `makeTextSprite`
 * measures the finished lines to centre each within the widest. Both use the
 * same overlap arithmetic; the demo uses a different overlap (1 rather than 3),
 * which changes both the break points and the centring, so it is a parameter
 * rather than a constant.
 */

import { SWORD1_FRAME_HEADER_SIZE } from '../resource/swordDefs.js';
import type { SwordResources } from '../resource/SwordResources.js';
import { compressionOf, decodeSwordFrame } from './swordDecode.js';
import type { SwordTextSprite } from './SwordScreen.js';

/**
 * The ink values a font glyph uses, and the transparent one.
 *
 * Palette indexes, not small tags: a glyph's pixels are 193 for the letter body
 * and 200 for its outline, and those indexes sit in the *sprite* half of the
 * palette (184..255). The PlayStation conversion uses 199 for the border, which
 * is why two values map to one meaning.
 */
export const LETTER_COL = 193;
export const BORDER_COL = 200;
export const BORDER_COL_PSX = 199;
export const NO_COL = 0;

/** How far consecutive characters overlap. The demo uses one, not three. */
export const OVERLAP = 3;
export const DEMO_OVERLAP = 1;

/** Revolution's cap. A line longer than this is truncated, never grown. */
export const MAX_LINES = 30;

const SPACE = 32;

interface LineInfo {
  width: number;
  length: number;
}

interface Glyph {
  width: number;
  height: number;
  pixels: Uint8Array;
}

export class SwordText {
  private readonly glyphs = new Map<number, Glyph | null>();
  private charHeight = 0;
  private joinWidth = 0;
  /** The candidate that fetched, once one has. Null until then. */
  private fontId: number | null = null;
  /** The ids to try, in preference order. The last is the one reported. */
  private readonly candidates: readonly number[];

  constructor(
    private readonly resources: SwordResources,
    fontId: number | readonly number[],
    private readonly overlap: number = OVERLAP,
  ) {
    this.candidates = typeof fontId === 'number' ? [fontId] : fontId;
    if (this.candidates.length === 0) {
      throw new Error('SwordText needs at least one font id to try');
    }
  }

  /**
   * Why there are no subtitles, or null when there are.
   *
   * A getter that re-probes, and that is the whole point: `SwordEngine.create`
   * builds this object before `await resources.loadResident()` has run, so at
   * construction *every* cluster is absent and the font's `fetch` returns null
   * for a reason that stops being true three lines later. Answered once and
   * kept, this read "no font, so no subtitles" for the rest of the session on
   * an install whose font is right there — measured on the mounted demo, where
   * `GAME_FONT` fetches 70,414 bytes as soon as GENERAL is resident. A game
   * with no text is not playable, so this is a question worth asking twice.
   */
  get fontMissing(): string | null {
    if (this.resolve()) return null;
    // The *last* candidate, not the first: the Czech font is a preference and
    // `GAME_FONT` is the one whose absence is the problem.
    return this.resources.describeMissingResource(this.candidates[this.candidates.length - 1]);
  }

  /**
   * Finds the first candidate that fetches, and measures the font from it.
   *
   * Retried while it fails and remembered once it succeeds. Choosing the Czech
   * font by *presence* rather than by a language flag is deliberate — a
   * release's language is not established until its text is read — but presence
   * is a question that can only be answered after the clusters are loaded.
   */
  private resolve(): boolean {
    if (this.fontId !== null) return true;
    for (const candidate of this.candidates) {
      if (!this.resources.fetch(candidate)) continue;
      this.fontId = candidate;
      const first = this.glyph(SPACE);
      if (!first) {
        // The resource is there and is not a font this reader understands.
        // Keeping the id set would cache that answer; clearing it lets a later
        // candidate be tried and keeps `fontMissing` describing the real one.
        this.fontId = null;
        this.glyphs.clear();
        continue;
      }
      // Every character is the same height, so frame 0's height is the line
      // height. Reading it from the font rather than assuming 20-odd is what
      // makes the Czech and Russian fonts lay out correctly.
      this.charHeight = first.height;
      this.joinWidth = first.width - 2 * this.overlap;
      return true;
    }
    return false;
  }

  /** The line height, which the sprite's height is a multiple of. */
  get lineHeight(): number {
    this.resolve();
    return this.charHeight;
  }

  /** One character's glyph, decoded and cached. */
  private glyph(ch: number): Glyph | null {
    const code = ch < SPACE ? 64 : ch;
    const cached = this.glyphs.get(code);
    if (cached !== undefined) return cached;

    // `resolve` calls this for the space character with `fontId` already set,
    // so this is not the recursion it looks like.
    if (this.fontId === null && !this.resolve()) return null;
    const resource = this.resources.fetch(this.fontId as number);
    if (!resource) return null;
    const big = this.resources.bigEndian;
    const bytes = resource.bytes;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < 28) {
      this.glyphs.set(code, null);
      return null;
    }
    const frames = view.getUint32(20, !big);
    const frameNo = code - SPACE;
    if (frameNo < 0 || frameNo >= frames) {
      this.glyphs.set(code, null);
      return null;
    }
    const at = view.getUint32(20 + (frameNo + 1) * 4, !big);
    if (at + SWORD1_FRAME_HEADER_SIZE > bytes.length) {
      this.glyphs.set(code, null);
      return null;
    }
    const tag = new TextDecoder('latin1').decode(bytes.subarray(at, at + 4));
    const compSize = view.getUint32(at + 4, !big);
    const width = view.getUint16(at + 8, !big);
    const height = view.getUint16(at + 10, !big);
    if (width === 0 || height === 0 || width > 256 || height > 256) {
      this.glyphs.set(code, null);
      return null;
    }
    let pixels: Uint8Array;
    try {
      pixels = decodeSwordFrame(
        bytes.subarray(at + SWORD1_FRAME_HEADER_SIZE),
        compressionOf(tag),
        compSize,
        width,
        height,
      );
    } catch {
      this.glyphs.set(code, null);
      return null;
    }
    const glyph = { width, height, pixels };
    this.glyphs.set(code, glyph);
    return glyph;
  }

  /** A character's advance, before overlap. Zero when the font is unreadable. */
  charWidth(ch: number): number {
    return this.glyph(ch)?.width ?? 0;
  }

  /**
   * Breaks a sentence into lines no wider than `maxWidth`.
   *
   * A single word wider than the limit gets its own line rather than being
   * split, which is the original's behaviour and matters for the German
   * translation's compounds.
   */
  analyzeSentence(text: string, maxWidth: number): LineInfo[] {
    const lines: LineInfo[] = [];
    let lineNo = 0;
    let firstWord = true;
    let at = 0;

    while (at < text.length) {
      let wordWidth = 0;
      let wordLength = 0;
      while (at < text.length && text.charCodeAt(at) !== SPACE) {
        wordWidth += this.charWidth(text.charCodeAt(at)) - this.overlap;
        wordLength++;
        at++;
      }
      if (at < text.length && text.charCodeAt(at) === SPACE) at++;
      // No overlap on a word's final letter.
      wordWidth += this.overlap;

      if (firstWord) {
        lines[lineNo] = { width: wordWidth, length: wordLength };
        firstWord = false;
      } else {
        const spaceNeeded = lines[lineNo].width + this.joinWidth + wordWidth;
        if (spaceNeeded <= maxWidth) {
          lines[lineNo].width = spaceNeeded;
          lines[lineNo].length += wordLength + 1;
        } else {
          lineNo++;
          if (lineNo >= MAX_LINES) break;
          lines[lineNo] = { width: wordWidth, length: wordLength };
        }
      }
    }
    return lines.slice(0, Math.min(lineNo + 1, MAX_LINES));
  }

  /**
   * Renders a sentence into a sprite, or null when the font is unreadable.
   *
   * `maxWidth` of zero or less is read as "as wide as it needs": a compact
   * whose `o_speech_width` was never set would otherwise produce a
   * one-character-wide sprite thirty lines tall.
   */
  makeTextSprite(text: string, maxWidth: number, pen: number): SwordTextSprite | null {
    if (!this.resolve()) return null;
    const limit = maxWidth > 0 ? maxWidth : 400;
    const lines = this.analyzeSentence(text, limit);
    if (lines.length === 0) return null;

    const spriteWidth = Math.max(1, ...lines.map((line) => line.width));
    const spriteHeight = Math.max(1, this.charHeight * lines.length);
    const pixels = new Uint8Array(spriteWidth * spriteHeight);
    pixels.fill(NO_COL);

    let consumed = 0;
    for (const [lineNo, line] of lines.entries()) {
      // Centre each line within the widest.
      let x = Math.floor((spriteWidth - line.width) / 2);
      const y = lineNo * this.charHeight;
      for (let pos = 0; pos < line.length; pos++) {
        const ch = text.charCodeAt(consumed + pos);
        if (Number.isNaN(ch)) break;
        x += this.drawChar(ch, pixels, spriteWidth, x, y, pen) - this.overlap;
      }
      consumed += line.length + 1;
    }

    return { width: spriteWidth, height: spriteHeight, pixels };
  }

  /** Stamps one glyph, returning its advance. Border only where empty. */
  private drawChar(
    ch: number,
    out: Uint8Array,
    pitch: number,
    x: number,
    y: number,
    pen: number,
  ): number {
    const glyph = this.glyph(ch);
    if (!glyph) return 0;
    for (let row = 0; row < glyph.height; row++) {
      const destY = y + row;
      if (destY < 0) continue;
      const to = destY * pitch;
      if (to >= out.length) break;
      for (let column = 0; column < glyph.width; column++) {
        const destX = x + column;
        if (destX < 0 || destX >= pitch) continue;
        const ink = glyph.pixels[row * glyph.width + column];
        if (ink === LETTER_COL) {
          out[to + destX] = pen;
        } else if ((ink === BORDER_COL || ink === BORDER_COL_PSX) && !out[to + destX]) {
          out[to + destX] = BORDER_COL;
        }
      }
    }
    return glyph.width;
  }
}
