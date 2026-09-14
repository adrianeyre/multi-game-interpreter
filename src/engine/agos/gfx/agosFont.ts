/**
 * Getting an AGOS font, which means getting it out of an interpreter.
 *
 * `drawText.ts` takes a `GlyphSource` rather than reading one, because **AGOS
 * keeps its font in the interpreter executable rather than in the data a player
 * owns**. This is the other half: where that source comes from.
 *
 * ADR 0032 records the decision and the three options it chose between. The
 * short form is that this is ADR 0024's rule a third time — read
 * executable-resident data out of the game's own executable, never out of
 * another implementation's transcription of it — and that the alternative
 * ScummVM took, transcribing the glyphs into source, is content rather than
 * format and is refused here on the same grounds ADR 0024 refused `sky.cpt`.
 *
 * ## The font is found by shape, not by offset
 *
 * ADR 0024 set a gate on exactly this: are the bytes findable *by structure*,
 * or only by offsets hardcoded per release? A table of known executables keyed
 * by hash would be the artefact ADR 0020 argued against, arriving through the
 * back door.
 *
 * A bitmap font is findable by structure, and the properties it has are not
 * properties of code, of a picture, or of a table of numbers:
 *
 * - **The space is blank.** Character 32 is `height` zero bytes, always, and it
 *   is the anchor the whole scan hangs off.
 * - **Every printable character is not blank.** A run of glyphs with a hole in
 *   it is not a font.
 * - **The edges are quieter than the middle.** A glyph leaves a gap on its
 *   right so letters do not touch, and most leave one on the left. Across
 *   ninety-odd glyphs the two outer columns carry a small fraction of the ink
 *   the middle six do. Nothing else in an executable looks like that: code has
 *   no column structure at all, and a picture's columns are uniform.
 * - **The bottom row is quieter than the rest.** Only descenders reach it.
 * - **No glyph is solid.** A run of `0xFF` is a fill pattern or a mask, not a
 *   letter.
 * - **A letter is one unbroken stroke in a box with room left over.** Its
 *   inked rows run together — a blank row with ink above and below it is a
 *   break no letter has — and at least one row of its box is blank, which is
 *   the margin that keeps lines apart. This is the measure that separates a
 *   font from the *sparse* tables an executable is full of, and Simon 1's
 *   Windows release is why it is here: a pointer table 6KB further on scored
 *   above the real font on every other test, and the game drew its every line
 *   in shapes that were not letters. It is gated rather than only weighted,
 *   because a table that fails it is not a font however quiet its edges are.
 *
 * A candidate offset is scored against those and the best-scoring one wins,
 * with a floor below which nothing is claimed. The score is reported rather
 * than hidden, because a caller has to be able to say *how* a font was found.
 *
 * ## What is Tier 1 here and what is not
 *
 * The scan, the scoring and the drawing are Tier 1 and are tested against a
 * synthetic executable — a font table buried in bytes chosen to be hostile:
 * code-shaped runs, a solid block, and a picture. Whether a real `SIMON.EXE`
 * yields the font that release actually draws with is **Tier 2** and needs the
 * disc (`docs/processes/verifying-version-support.md`). The honest claim is
 * that a release which carries a font in this shape is read, and a release that
 * does not is told about rather than drawn with boxes.
 */

import type { Glyph, GlyphSource } from './drawText.js';

/** How many characters a table is expected to hold, starting at the space. */
const DEFAULT_COUNT = 96;

/** The first character a table covers. Everything below 32 is a control code. */
const DEFAULT_FIRST = 32;

/** Below this, nothing is claimed to be a font. */
const DEFAULT_FLOOR = 0.55;

export interface AgosFontOptions {
  /** Rows per glyph. Eight is the AGOS video font; a window font may differ. */
  readonly height?: number;
  readonly first?: number;
  readonly count?: number;
  /** The score a candidate must reach before it is called a font. */
  readonly floor?: number;
  /**
   * An offset to read at instead of scanning.
   *
   * For a person who has worked one out for their own executable and wants it
   * used. Deliberately not a table of them shipped here: that is the artefact
   * ADR 0024's gate exists to keep out.
   */
  readonly at?: number;
}

export interface AgosFont {
  /** Where in the executable the table was found. */
  readonly at: number;
  readonly height: number;
  readonly width: number;
  readonly first: number;
  readonly count: number;
  /** How well the bytes matched the shape of a font, from zero to one. */
  readonly score: number;
  glyph(character: string): Glyph | undefined;
}

/** Whether a run of bytes is entirely zero. */
function blank(data: Uint8Array, at: number, length: number): boolean {
  for (let index = 0; index < length; index += 1) if ((data[at + index] ?? 1) !== 0) return false;
  return true;
}

/**
 * The cheap rejection, asked before any arithmetic.
 *
 * The space is blank and the letters are not. Two facts, four byte runs, and
 * they clear a megabyte of executable in a few milliseconds — which is what
 * makes scanning every offset affordable and an offset table unnecessary. A run
 * of zeros passes the first and fails the second, which matters: zero runs are
 * everywhere in a binary and are the only thing common enough to make the full
 * score expensive.
 */
function couldStartAFontTable(
  data: Uint8Array,
  at: number,
  options: { height: number; first: number; count: number },
): boolean {
  const { height, first, count } = options;
  const glyphAt = (character: number): number => at + (character - first) * height;
  const covers = (character: number): boolean => character >= first && character < first + count;

  if (covers(32) && !blank(data, glyphAt(32), height)) return false;
  for (const character of [33, 65, 97]) {
    if (covers(character) && blank(data, glyphAt(character), height)) return false;
  }
  return true;
}

/**
 * How much a run of bytes looks like a font table, from zero to one.
 *
 * Written as a score rather than a set of hard tests because a real font breaks
 * any one of them somewhere — a box-drawing character is solid, a full-width
 * glyph touches both edges — and a scan that rejects a whole table for one
 * awkward glyph finds nothing. What no non-font survives is all of them at
 * once.
 */
export function scoreFontTable(
  data: Uint8Array,
  at: number,
  options: { height: number; first: number; count: number },
): number {
  const { height, first, count } = options;
  const size = height * count;
  if (at < 0 || at + size > data.length) return 0;

  if (!couldStartAFontTable(data, at, options)) return 0;

  const columnInk = new Array<number>(8).fill(0);
  const rowInk = new Array<number>(height).fill(0);
  let printable = 0;
  let empty = 0;
  let solid = 0;
  let ink = 0;
  let unbroken = 0;

  for (let index = 0; index < count; index += 1) {
    const character = first + index;
    // Only the ASCII printables are judged. What a release puts above 126 is
    // its language's business and varies far too much to score.
    if (character <= 32 || character > 126) continue;
    printable += 1;

    let glyphInk = 0;
    let glyphSolid = 0;
    let gaps = 0;
    let started = false;
    let sinceInk = 0;
    let blankRows = 0;
    for (let row = 0; row < height; row += 1) {
      const byte = data[at + index * height + row] ?? 0;
      if (byte === 0xff) glyphSolid += 1;
      // Blank rows above the letter and below it are its margins; a blank row
      // with ink on both sides of it is a break in the letter itself.
      if (byte === 0) {
        blankRows += 1;
        if (started) sinceInk += 1;
      } else {
        if (started && sinceInk > 0) gaps += 1;
        started = true;
        sinceInk = 0;
      }
      for (let column = 0; column < 8; column += 1) {
        if ((byte & (0x80 >> column)) === 0) continue;
        columnInk[column] = (columnInk[column] ?? 0) + 1;
        rowInk[row] = (rowInk[row] ?? 0) + 1;
        glyphInk += 1;
      }
    }
    ink += glyphInk;
    if (glyphInk === 0) empty += 1;
    if (glyphSolid === height) solid += 1;
    // A letter: one unbroken vertical run of rows, sitting in a box with room
    // left over. Both halves are needed — a picture has no blank row anywhere
    // and passes the first, a sparse table of small numbers is nearly all
    // blank rows and passes the second.
    if (started && gaps === 0 && blankRows > 0) unbroken += 1;
  }

  if (printable === 0) return 0;

  // Density. A font runs somewhere near a fifth to a third of its box inked;
  // random bytes run at a half and a table of small numbers at almost nothing.
  const density = ink / (printable * height * 8);
  if (density < 0.05 || density > 0.55) return 0;

  const middleColumns = columnInk.slice(1, 7).reduce((total, each) => total + each, 0) / 6;
  const edgeColumns = ((columnInk[0] ?? 0) + (columnInk[7] ?? 0)) / 2;
  const middleRows =
    rowInk.slice(0, height - 1).reduce((total, each) => total + each, 0) / (height - 1);
  const bottomRow = rowInk[height - 1] ?? 0;

  const quietEdges = middleColumns > 0 ? 1 - Math.min(1, edgeColumns / middleColumns) : 0;
  const quietBottom = middleRows > 0 ? 1 - Math.min(1, bottomRow / middleRows) : 0;
  const filled = 1 - empty / printable;
  const notSolid = 1 - solid / printable;
  const strokes = unbroken / printable;

  // Strokes, gated the way density is, and for the same reason: a run that
  // fails it is not a font however well it does on everything else. A sparse
  // table — pointers, relocations, the small-number tables a Windows
  // executable is made of — can have perfectly quiet edges, a blank bottom row
  // and no solid glyph, and score high on all three while its ink sits in
  // unconnected pieces down the box. A third is a low bar deliberately: a
  // release whose letters carry accents or dots above them breaks the stroke
  // on those characters and must still be found.
  if (strokes < 0.35) return 0;

  // The quiet edges carry the most weight, because they are the measure nothing
  // else in an executable passes: a picture is as inked at its edges as in its
  // middle, and code has no column structure at all. A letter being one
  // unbroken stroke carries as much, and it is the measure that separates a
  // font from the *sparse* tables a Windows executable is full of. Every
  // printable glyph being present is next, and it is the one that rejects a
  // table of small numbers. None alone is enough, which is why this is a sum
  // and not a sequence of tests.
  return filled * 0.25 + quietEdges * 0.25 + strokes * 0.25 + quietBottom * 0.15 + notSolid * 0.1;
}

/**
 * Finds the font in an interpreter executable, or answers null.
 *
 * Scans every offset, which is a few million scores over a DOS executable and
 * costs a fraction of a second — cheap enough that it is done once at load and
 * never cached to disk, which would be the offset table this deliberately
 * avoids becoming.
 */
export function findAgosFont(
  executable: Uint8Array,
  options: AgosFontOptions = {},
): AgosFont | null {
  const height = options.height ?? 8;
  const first = options.first ?? DEFAULT_FIRST;
  const count = options.count ?? DEFAULT_COUNT;
  const floor = options.floor ?? DEFAULT_FLOOR;
  const shape = { height, first, count };

  if (options.at !== undefined) {
    const score = scoreFontTable(executable, options.at, shape);
    return makeFont(executable, options.at, shape, score);
  }

  let bestAt = -1;
  let bestScore = floor;
  const last = executable.length - height * count;
  for (let at = 0; at <= last; at += 1) {
    // Asked first so the scoring arithmetic is never reached for the
    // overwhelming majority of offsets.
    if (!couldStartAFontTable(executable, at, shape)) continue;
    const score = scoreFontTable(executable, at, shape);
    if (score > bestScore) {
      bestScore = score;
      bestAt = at;
    }
  }

  if (bestAt < 0) return null;
  return makeFont(executable, bestAt, shape, bestScore);
}

function makeFont(
  data: Uint8Array,
  at: number,
  shape: { height: number; first: number; count: number },
  score: number,
): AgosFont {
  const { height, first, count } = shape;
  return {
    at,
    height,
    width: 8,
    first,
    count,
    score,
    glyph(character: string): Glyph | undefined {
      const code = character.codePointAt(0);
      if (code === undefined || code < first || code >= first + count) return undefined;
      const start = at + (code - first) * height;
      const pixels = new Uint8Array(8 * height);
      for (let row = 0; row < height; row += 1) {
        const byte = data[start + row] ?? 0;
        for (let column = 0; column < 8; column += 1) {
          pixels[row * 8 + column] = (byte & (0x80 >> column)) !== 0 ? 1 : 0;
        }
      }
      return { width: 8, height, pixels };
    },
  };
}

/** A font as the `GlyphSource` the renderer takes. */
export function glyphsOf(font: AgosFont): GlyphSource {
  return (character: string) => font.glyph(character);
}

/** The executable stems that name an AGOS interpreter outright. */
const KNOWN_INTERPRETERS = [
  'simon.exe',
  'simon2.exe',
  'elvira.exe',
  'elvira2.exe',
  'waxworks.exe',
  'feeble.exe',
  'simonpp.exe',
  'swampy.exe',
  'jumble.exe',
  'puzzle.exe',
  'dimp.exe',
];

/**
 * Executables that are beside an AGOS game but are provably not its interpreter.
 *
 * A denylist rather than a heuristic, because these are known things with fixed
 * names, and the reason each is here is that it *scores as a font when it is
 * not one*. A best-score sweep of every `.exe` in a Simon 2 folder picks
 * `DOS4GW.EXE` — its relocation and page tables have the quiet-edged column
 * structure the scan rewards — and draws a game's text out of a DOS extender.
 * So the judgement is made by name here, where it can be: the DOS extenders and
 * the installers are struck out before shape is ever consulted.
 *
 * This is not the same as trusting a name to *be* the interpreter — that is
 * `KNOWN_INTERPRETERS`. This says only that these particular names are never it,
 * which is a fact about DOS tooling and not about any one release. A folder
 * whose real interpreter has an unknown name still reaches the sweep and is
 * still found by shape; all this removes are the impostors that outscore it.
 */
const NOT_INTERPRETERS = [
  // DOS extenders and DPMI hosts: they front the interpreter and ship beside it.
  'dos4gw.exe',
  'dos4g.exe',
  'dos32a.exe',
  'pmodew.exe',
  'cwsdpmi.exe',
  // Installers and uninstallers.
  'install.exe',
  'setup.exe',
  'uninstall.exe',
  'unwise.exe',
  'unins000.exe',
];

function baseNameOf(name: string): string {
  return (name.replace(/\\/g, '/').split('/').pop() ?? name).toLowerCase();
}

/** Whether a file's name is one that outright names an AGOS interpreter. */
export function isKnownInterpreterName(name: string): boolean {
  return KNOWN_INTERPRETERS.includes(baseNameOf(name));
}

/**
 * Files worth reading a font out of, in the order worth trying.
 *
 * Named stems first because a folder may hold several executables and only one
 * of them is the interpreter. Any other `.exe` is tried afterwards rather than
 * refused, because ADR 0028 admits GOG and Steam repackagings and those rename
 * things — but the executables `NOT_INTERPRETERS` names are dropped, because
 * they are provably not the interpreter and they score as fonts when they are
 * not.
 */
export function interpreterCandidates(fileNames: readonly string[]): string[] {
  const named = fileNames.filter(isKnownInterpreterName);
  const others = fileNames.filter(
    (name) =>
      /\.exe$/i.test(baseNameOf(name)) &&
      !isKnownInterpreterName(name) &&
      !NOT_INTERPRETERS.includes(baseNameOf(name)),
  );
  return [...named, ...others];
}
