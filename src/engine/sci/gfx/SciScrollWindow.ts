/**
 * SCI32's scrolling text window: a log a game appends to and pages through.
 *
 * Space Quest 6's datacorder, Phantasmagoria's "About" box and LSL6 hi-res's
 * conversation log are each one of these: the game creates it with a size and
 * an entry limit, adds lines to it, and scrolls it with the arrows, the page
 * keys and a slider that asks `Where` and answers `Go`. `kScrollWindow` is the
 * one Kernel call behind all of it, sub-functions 0 to 19.
 *
 * Transcribed from ScummVM's `ScrollWindow` (`engines/sci/graphics/
 * controls32.cpp`) and `kScrollWindow*` (`engines/sci/engine/kgraphics32.cpp`),
 * fetched 2026-09-27. The **model** is Sierra's exactly: the text is one
 * string the entries are concatenated into, lines are character offsets into
 * it, and every scroll is a change of `firstVisibleChar` that `update` turns
 * back into a top and bottom line. That arithmetic is what a slider reads, so
 * it is kept to the character.
 *
 * What is this engine's is the measuring: `measure` answers how many
 * characters of the text fit on one line of the window, which the engine
 * answers from the game's own font. Control codes are Sierra's — `|f<n>|`,
 * `|c<n>|` and `|a<n>|` are added in front of an entry exactly as `fillEntry`
 * adds them — and are skipped when measuring or drawing.
 */

export interface SciScrollWindowOptions {
  /** How many characters from `start` fit on one line `width` pixels wide. */
  lineLength(text: string, start: number, width: number): number;
  /** How many characters from 0 fit in the whole text rectangle. */
  pageLength(text: string, width: number, height: number): number;
  /** The text rectangle: the window less two pixels of border on each side. */
  width: number;
  height: number;
  maxEntries: number;
}

interface Entry {
  id: number;
  text: string;
}

export class SciScrollWindow {
  visible = false;
  /** The text within the viewport, control codes and all, for the renderer. */
  visibleText = '';

  private readonly options: SciScrollWindowOptions;
  private readonly entries: Entry[] = [];
  private text = '';
  private startsOfLines: number[] = [0];
  private numLines = 0;
  private numVisibleLines = 0;
  private firstVisibleChar = 0;
  private lastVisibleChar = 0;
  private topVisibleLine = 0;
  private bottomVisibleLine = 0;
  private nextEntryId = 1;

  constructor(options: SciScrollWindowOptions) {
    this.options = options;
    this.computeLineIndices();
  }

  /** The top line and the line count, which `Where` scales into the slider's range. */
  get where(): { top: number; lines: number } {
    return { top: this.topVisibleLine, lines: Math.max(this.numLines, 1) };
  }

  /**
   * `add`: a new entry at the end, dropping the oldest at the limit.
   *
   * Entry IDs count from one and wrap at the limit, which is SSCI's memory
   * handle turned into a number the way ScummVM turns it. `scrollTo` moves the
   * view to the new entry, which is the default a game gets.
   */
  add(text: string, font: number, colour: number, alignment: number, scrollTo: boolean): number {
    if (this.entries.length === this.options.maxEntries && this.entries.length > 0) {
      const removed = this.entries.shift() as Entry;
      this.text = this.text.slice(removed.text.length);
      if (!scrollTo) this.firstVisibleChar -= removed.text.length;
    }

    const entry: Entry = { id: this.nextEntryId++, text: formatted(text, font, colour, alignment) };
    if (this.nextEntryId > this.options.maxEntries) this.nextEntryId = 1;
    this.entries.push(entry);

    if (scrollTo) this.firstVisibleChar = this.text.length;
    this.text += entry.text;
    this.computeLineIndices();
    this.update();
    return entry.id;
  }

  /** `modify`: replace one entry's text, answering its ID, or nought for none. */
  modify(
    id: number,
    text: string,
    font: number,
    colour: number,
    alignment: number,
    scrollTo: boolean,
  ): number {
    let first = 0;
    const entry = this.entries.find((candidate) => {
      if (candidate.id === id) return true;
      first += candidate.text.length;
      return false;
    });
    if (!entry) return 0;

    const oldLength = entry.text.length;
    entry.text = formatted(text, font, colour, alignment);
    this.text = this.text.slice(0, first) + entry.text + this.text.slice(first + oldLength);
    if (scrollTo) this.firstVisibleChar = first;
    this.computeLineIndices();
    this.update();
    return entry.id;
  }

  upArrow(): void {
    if (this.topVisibleLine === 0) return;
    this.topVisibleLine--;
    this.bottomVisibleLine--;
    if (this.bottomVisibleLine - this.topVisibleLine + 1 < this.numVisibleLines) {
      this.bottomVisibleLine = this.numLines - 1;
    }
    this.firstVisibleChar = this.startsOfLines[this.topVisibleLine];
    this.lastVisibleChar = this.startsOfLines[this.bottomVisibleLine + 1] - 1;
    this.visibleText = this.text.slice(this.firstVisibleChar, this.lastVisibleChar + 1);
  }

  downArrow(): void {
    if (this.topVisibleLine + 1 >= this.numLines) return;
    this.topVisibleLine++;
    this.bottomVisibleLine++;
    if (this.bottomVisibleLine + 1 >= this.numLines) this.bottomVisibleLine = this.numLines - 1;
    this.firstVisibleChar = this.startsOfLines[this.topVisibleLine];
    this.lastVisibleChar = this.startsOfLines[this.bottomVisibleLine + 1] - 1;
    this.visibleText = this.text.slice(this.firstVisibleChar, this.lastVisibleChar + 1);
  }

  /**
   * `go`: to a fraction of the way down, `numerator / denominator` of the
   * lines. A fraction of one parks the top past the end, which is ScummVM's
   * own adjustment for Phantasmagoria's slider.
   */
  go(numerator: number, denominator: number): boolean {
    if (denominator === 0) return false;
    const line = Math.trunc((numerator * this.numLines) / denominator);
    if (line < 0 || line > this.numLines) return false;
    this.firstVisibleChar = this.startsOfLines[line] ?? this.text.length;
    this.update();
    if (numerator === denominator) this.topVisibleLine = this.numLines;
    return true;
  }

  home(): void {
    if (this.firstVisibleChar === 0) return;
    this.firstVisibleChar = 0;
    this.update();
  }

  end(): void {
    if (this.bottomVisibleLine + 1 >= this.numLines) return;
    const line = Math.max(0, this.numLines - this.numVisibleLines);
    this.firstVisibleChar = this.startsOfLines[line];
    this.update();
  }

  pageUp(): void {
    if (this.topVisibleLine === 0) return;
    this.topVisibleLine = Math.max(0, this.topVisibleLine - this.numVisibleLines);
    this.firstVisibleChar = this.startsOfLines[this.topVisibleLine];
    this.update();
  }

  pageDown(): void {
    if (this.topVisibleLine + 1 >= this.numLines) return;
    this.topVisibleLine += this.numVisibleLines;
    if (this.topVisibleLine + 1 >= this.numLines) this.topVisibleLine = this.numLines - 1;
    this.firstVisibleChar = this.startsOfLines[this.topVisibleLine];
    this.update();
  }

  /** The line the viewport starts on, for a caller that wants it plainly. */
  get topLine(): number {
    return this.topVisibleLine;
  }

  get lineCount(): number {
    return this.numLines;
  }

  /** The lines in the viewport, each without its line break, for drawing. */
  visibleLines(): string[] {
    const lines: string[] = [];
    for (
      let line = this.topVisibleLine;
      line <= this.bottomVisibleLine && line < this.numLines;
      line++
    ) {
      lines.push(
        this.text
          .slice(this.startsOfLines[line], this.startsOfLines[line + 1])
          .replace(/\r?\n$|\r$/, ''),
      );
    }
    return lines;
  }

  private computeLineIndices(): void {
    const { width, height } = this.options;
    this.startsOfLines = [];
    for (let at = 0; at < this.text.length;) {
      this.startsOfLines.push(at);
      // At least one character, so a glyph wider than the window cannot stop
      // the scan; Sierra's `getTextCount` makes the same guarantee.
      at += Math.max(1, this.options.lineLength(this.text, at, width));
    }
    this.numLines = this.startsOfLines.length;
    this.startsOfLines.push(this.text.length);

    this.lastVisibleChar = this.options.pageLength(this.text, width, height) - 1;
    this.bottomVisibleLine = 0;
    while (
      this.bottomVisibleLine < this.numLines - 1 &&
      this.startsOfLines[this.bottomVisibleLine + 1] < this.lastVisibleChar
    ) {
      this.bottomVisibleLine++;
    }
    this.numVisibleLines = this.bottomVisibleLine + 1;
  }

  private update(): void {
    this.topVisibleLine = 0;
    while (
      this.topVisibleLine < this.numLines - 1 &&
      this.firstVisibleChar >= this.startsOfLines[this.topVisibleLine + 1]
    ) {
      this.topVisibleLine++;
    }
    this.bottomVisibleLine = Math.min(
      this.topVisibleLine + this.numVisibleLines - 1,
      this.numLines - 1,
    );
    this.firstVisibleChar = this.startsOfLines[this.topVisibleLine] ?? 0;
    this.lastVisibleChar =
      this.bottomVisibleLine >= 0 ? this.startsOfLines[this.bottomVisibleLine + 1] - 1 : -1;
    this.visibleText = this.text.slice(this.firstVisibleChar, this.lastVisibleChar + 1);
  }
}

/** `fillEntry`: the codes an entry's own font, colour and alignment need, then its text. */
function formatted(text: string, font: number, colour: number, alignment: number): string {
  let codes = '';
  if (font !== -1) codes += `|f${font}|`;
  if (colour !== -1) codes += `|c${colour}|`;
  if (alignment !== -1) codes += `|a${alignment}|`;
  return codes + text;
}

/**
 * Skips a `|x...|` control code at `at`, answering where the text resumes.
 *
 * Sierra's codes are a pipe, a letter, digits, and a pipe; anything else is
 * a literal pipe and is left for the caller to draw.
 */
export function skipSciTextCode(text: string, at: number): number {
  if (text[at] !== '|') return at;
  const close = text.indexOf('|', at + 1);
  if (close < 0 || !/^[a-z][0-9]*$/i.test(text.slice(at + 1, close))) return at;
  return close + 1;
}

/** The text with every control code taken out, for drawing in one colour. */
export function stripSciTextCodes(text: string): string {
  let out = '';
  for (let at = 0; at < text.length;) {
    const next = skipSciTextCode(text, at);
    if (next !== at) {
      at = next;
      continue;
    }
    out += text[at];
    at++;
  }
  return out;
}

/**
 * `GfxText32::getTextCount` for one line: how many characters of `text`
 * from `start` fit in `width` pixels, breaking after a newline or at the last
 * space that fits, and at the last character that fits when a word is wider
 * than the line.
 */
export function sciLineLength(
  text: string,
  start: number,
  width: number,
  charWidth: (code: number) => number,
): number {
  let at = start;
  let used = 0;
  let lastBreak = -1;
  while (at < text.length) {
    const code = skipSciTextCode(text, at);
    if (code !== at) {
      at = code;
      continue;
    }
    const character = text[at];
    if (character === '\r' && text[at + 1] === '\n') return at + 2 - start;
    if (character === '\n' || character === '\r') return at + 1 - start;
    const advance = charWidth(character.charCodeAt(0));
    if (used + advance > width) {
      if (lastBreak >= 0) return lastBreak + 1 - start;
      return Math.max(1, at - start);
    }
    used += advance;
    if (character === ' ') lastBreak = at;
    at++;
  }
  return at - start;
}
