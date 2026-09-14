/**
 * SCI artwork out of the editor as pixels, for the same reason `imageExport.ts`
 * exists for SCUMM: a View, a Picture, a font and a cursor are artwork, and an
 * author who can edit one and not get it out has half a tool.
 *
 * These render and nothing else. The encode and the download are
 * `imageExport.ts`'s `writePng`, which is `downloadBlob` — the browser dance
 * with the revoke-on-a-timer in it that has been hand-copied wrong more than
 * once in this repository. There is no second copy here.
 *
 * ## Which colours, and why that is a question at all
 *
 * A SCI resource is palette indices, and **a View does not carry a palette**.
 * On screen its colours are whatever the room it walked into last set, so
 * exporting one means choosing a palette rather than reading one, and this
 * module says which it chose rather than picking silently:
 *
 * - **EGA** — a cel's pixel is a plain four-bit index into the hardware's
 *   sixteen (`readSciCel` reads the run in the high nibble and the colour in
 *   the low), so the sixteen are the answer and there is nothing to choose.
 * - **VGA** — the colours are in a `palette` resource. 999 is the one a SCI1
 *   game loads at startup and the nearest thing to "the game's colours"; where
 *   a release has no 999 the lowest-numbered palette it does have is used, and
 *   the name of the one used is reported.
 *
 * A Picture is the exception, and it is the reason this is worth being careful
 * about: a Picture carries its own palette, so its export needs no choosing.
 *
 * ## The EGA Picture background
 *
 * `drawSciPicture` clears its visual buffer to `0x0f` and stores a `setColour`
 * operand as the byte it arrived as, while `applyEgaPalette` reads a visual
 * byte as a *dithered pair* — two four-bit colours the display alternated
 * between. Those two readings of the same buffer disagree, and under the second
 * one an untouched EGA background is the average of white and black rather than
 * white. This module renders an EGA Picture through the pair reading, because
 * that is what this project's own interpreter puts on screen and an export that
 * disagreed with Play would be a third answer rather than a correction. The
 * disagreement is reported rather than fixed here: which of the two is right is
 * a question about `SciPicture.ts`, not about exporting.
 */

import { fromBase64 } from '../../authoring/base64.js';
import type { SciProject, SciProjectCelPicture } from '../../authoring/project.js';
import type { RenderedImage } from '../imageExport.js';
import { SCI_EGA_PALETTE, readSciPalette } from '../../engine/sci/gfx/sciPalette.js';
import type { SciCel } from '../../engine/sci/gfx/SciView.js';
import type { SciViewResource } from '../../engine/sci/gfx/SciView.js';
import type { SciFontResource } from '../../engine/sci/gfx/SciFont.js';
import { CURSOR_TRANSPARENT, type SciCursor } from '../../engine/sci/gfx/SciCursor.js';
import { readSciCelPicture } from '../../engine/sci/gfx/SciCelPicture.js';
import type { SciPictureResult } from '../../engine/sci/gfx/SciPicture.js';

/** An RGB triple per index, and in words where it came from. */
export interface SciColours {
  colours: Array<readonly [number, number, number]>;
  /** What an author is told the export was coloured with. */
  how: string;
}

/** 256 entries of black, to be filled in. */
function blackTable(): Array<readonly [number, number, number]> {
  return Array.from({ length: 256 }, () => [0, 0, 0] as const);
}

/**
 * The sixteen, indexed directly.
 *
 * Not `applyEgaPalette`'s 256 dithered combinations: that table is for a
 * *Picture's* visual buffer, and a cel's pixel is one colour rather than a
 * pair. Using the pair table for a cel halves every colour's brightness, which
 * is a wrong answer that looks like a deliberate one.
 */
function egaCelColours(): SciColours {
  const colours = blackTable();
  for (let index = 0; index < 256; index++) colours[index] = SCI_EGA_PALETTE[index & 0x0f];
  return { colours, how: "EGA's sixteen colours" };
}

/** `applyEgaPalette`'s reading: a visual byte is two colours, averaged. */
function egaPictureColours(): SciColours {
  const colours = blackTable();
  for (let index = 0; index < 256; index++) {
    const first = SCI_EGA_PALETTE[index & 0x0f];
    const second = SCI_EGA_PALETTE[(index >> 4) & 0x0f];
    colours[index] = [
      (first[0] + second[0]) >> 1,
      (first[1] + second[1]) >> 1,
      (first[2] + second[2]) >> 1,
    ];
  }
  return { colours, how: "EGA's sixteen, dithered in pairs as the interpreter draws them" };
}

/** True when this release ships colours of its own. */
export function sciIsVga(sci: SciProject): boolean {
  return sci.resources.some((resource) => resource.type === 'palette');
}

/**
 * The palette a View is exported through, named.
 *
 * 999 first because that is the one a SCI1 game loads at startup; otherwise the
 * lowest-numbered palette in the release, because a release with any palette at
 * all draws in 256 colours and an arbitrary one of its own is nearer the truth
 * than sixteen that are not its colours at all.
 */
export function sciViewColours(sci: SciProject): SciColours {
  if (!sciIsVga(sci)) return egaCelColours();

  const palettes = sci.resources
    .filter((resource) => resource.type === 'palette')
    .sort((a, b) => a.number - b.number);
  const chosen = palettes.find((palette) => palette.number === 999) ?? palettes[0];
  if (!chosen) return egaCelColours();

  const colours = blackTable();
  for (const entry of readSciPalette(fromBase64(chosen.bytes))) {
    if (entry.index < 0 || entry.index > 255) continue;
    colours[entry.index] = [entry.r, entry.g, entry.b];
  }
  return {
    colours,
    how:
      `palette ${chosen.number}` +
      (chosen.number === 999
        ? ', the one this game loads at startup'
        : ', this release having no palette 999 — a View carries no colours of its own'),
  };
}

/** One cel as pixels, with its transparent index left transparent. */
export function renderSciCel(cel: SciCel, { colours }: SciColours): RenderedImage {
  const rgba = new Uint8ClampedArray(cel.width * cel.height * 4);
  for (let i = 0, j = 0; i < cel.pixels.length; i++, j += 4) {
    const index = cel.pixels[i];
    if (index === cel.clearKey) continue;
    const entry = colours[index] ?? [0, 0, 0];
    rgba[j] = entry[0];
    rgba[j + 1] = entry[1];
    rgba[j + 2] = entry[2];
    rgba[j + 3] = 255;
  }
  return { width: cel.width, height: cel.height, rgba };
}

/** One cel of one loop, or null when the View has no such cel. */
export function renderSciViewCel(
  view: SciViewResource,
  loopIndex: number,
  celIndex: number,
  colours: SciColours,
): RenderedImage | null {
  const cel = view.loops[loopIndex]?.cels[celIndex];
  return cel ? renderSciCel(cel, colours) : null;
}

/**
 * A drawn vector Picture's **visual** buffer, and only that one.
 *
 * Priority and control are the other two buffers and they are not artwork: one
 * says what occludes what and the other where the ego may walk. Exporting them
 * as an image would produce a picture of the game's bookkeeping, in colours
 * that mean nothing.
 */
export function renderSciVectorPicture(drawn: SciPictureResult, vga: boolean): RenderedImage {
  const base = vga ? { colours: blackTable(), how: '' } : egaPictureColours();
  for (const entry of drawn.palette) {
    if (entry.index < 0 || entry.index > 255) continue;
    base.colours[entry.index] = [entry.r, entry.g, entry.b];
  }

  const rgba = new Uint8ClampedArray(drawn.width * drawn.height * 4);
  for (let i = 0, j = 0; i < drawn.visual.length; i++, j += 4) {
    const entry = base.colours[drawn.visual[i]] ?? [0, 0, 0];
    rgba[j] = entry[0];
    rgba[j + 1] = entry[1];
    rgba[j + 2] = entry[2];
    rgba[j + 3] = 255;
  }
  return { width: drawn.width, height: drawn.height, rgba };
}

/**
 * A cel Picture composed the way its own items say, or a refusal in words.
 *
 * Composed rather than exported cel by cel because that is what the resource
 * *is* from SCI2 on: items at positions with priorities, and a room drawn by
 * putting them down in that order. A SCI1.1 Picture has one item and it is the
 * background, so the same walk produces the background alone.
 */
export function renderSciCelPicture(
  picture: SciProjectCelPicture,
  /**
   * The game's own palette, under the Picture's.
   *
   * **A cel Picture's palette is a patch, not a table.** King's Quest VII's
   * room Pictures each define indices 104 to 235 and no others, because the
   * rest are the startup palette's and the running game has them already. A
   * renderer that starts from black and applies only the Picture's own entries
   * therefore draws every pixel outside that range **black at full alpha** —
   * which on screen is a room with black patches cut out of it, and is what an
   * owner reported seeing in the editor's room list.
   *
   * Optional so a caller with no project still gets the old behaviour rather
   * than an error; every caller that has one should pass it.
   */
  beneath?: SciColours,
): RenderedImage | string {
  const bytes = fromBase64(picture.bytes);
  const composition = readSciCelPicture(bytes);
  if (composition.unknown) {
    return (
      `This Picture stopped at byte ${composition.unknown.at}: ${composition.unknown.why}. ` +
      `Exporting what was reached would be a picture with a piece missing and nothing on it ` +
      `saying so.`
    );
  }
  if (composition.cels.length === 0) return 'This Picture holds no cels to draw.';

  const colours = beneath ? beneath.colours.map((entry) => [...entry]) : blackTable();
  for (const entry of readSciPalette(bytes, composition.paletteOffset)) {
    if (entry.index < 0 || entry.index > 255) continue;
    // The used flag is Sierra's merge rule and applies here for the same
    // reason it applies on screen: an unused entry is three zero bytes behind
    // a flag, not a colour the Picture is asking for.
    if (entry.used === false) continue;
    colours[entry.index] = [entry.r, entry.g, entry.b];
  }

  // The canvas is what the Picture declares, or what its items cover where it
  // declares nothing — a SCI1.1 Picture says no resolution and its one cel is
  // the size of the room.
  const width =
    picture.resolution?.width ??
    Math.max(...composition.cels.map((item) => item.x + item.cel.width));
  const height =
    picture.resolution?.height ??
    Math.max(...composition.cels.map((item) => item.y + item.cel.height));
  if (!(width > 0) || !(height > 0)) return 'This Picture declares no size this export can use.';

  const rgba = new Uint8ClampedArray(width * height * 4);
  // Ascending priority, and stably: an item drawn later covers one drawn
  // earlier, which is the whole of how a SCI32 Plane occludes (ADR 0015).
  const ordered = composition.cels
    .map((item, index) => ({ item, index }))
    .sort((a, b) => a.item.priority - b.item.priority || a.index - b.index);

  for (const { item } of ordered) {
    const { cel } = item;
    for (let y = 0; y < cel.height; y++) {
      const destY = item.y + y;
      if (destY < 0 || destY >= height) continue;
      for (let x = 0; x < cel.width; x++) {
        const index = cel.pixels[y * cel.width + x];
        if (index === cel.clearKey) continue;
        const destX = item.x + x;
        if (destX < 0 || destX >= width) continue;
        const entry = colours[index] ?? [0, 0, 0];
        const at = (destY * width + destX) * 4;
        rgba[at] = entry[0];
        rgba[at + 1] = entry[1];
        rgba[at + 2] = entry[2];
        rgba[at + 3] = 255;
      }
    }
  }
  return { width, height, rgba };
}

/** Pixels between glyphs on a font sheet, so two neighbours stay two. */
const GLYPH_GAP = 1;

/**
 * Every glyph on one sheet, in the order the font declares them.
 *
 * One image rather than one per glyph because a font's export is for looking at
 * and for handing to whoever is drawing the accented characters #222 is about,
 * and 256 downloads is not that. Inked pixels are opaque black on transparent,
 * which is what a font resource actually holds — one bit per pixel, with no
 * colour anywhere in it.
 */
export function renderSciFontSheet(font: SciFontResource): RenderedImage | string {
  if (font.glyphs.length === 0) return 'This font holds no glyphs.';

  const columns = Math.ceil(Math.sqrt(font.glyphs.length));
  const rows = Math.ceil(font.glyphs.length / columns);
  const cellWidth = Math.max(...font.glyphs.map((glyph) => glyph.width)) + GLYPH_GAP;
  const cellHeight = Math.max(...font.glyphs.map((glyph) => glyph.height)) + GLYPH_GAP;
  const width = columns * cellWidth;
  const height = rows * cellHeight;

  const rgba = new Uint8ClampedArray(width * height * 4);
  for (const [index, glyph] of font.glyphs.entries()) {
    const originX = (index % columns) * cellWidth;
    const originY = Math.floor(index / columns) * cellHeight;
    for (let y = 0; y < glyph.height; y++) {
      for (let x = 0; x < glyph.width; x++) {
        if (!glyph.pixels[y * glyph.width + x]) continue;
        const at = ((originY + y) * width + originX + x) * 4;
        rgba[at + 3] = 255;
      }
    }
  }
  return { width, height, rgba };
}

/**
 * A cursor's three states as they are: black, white, and see-through.
 *
 * Black *and* white, because that is what a SCI cursor is — an arrow with a
 * white body and a black outline reads on a dark room and a light one, and
 * exporting it as one colour on transparency makes half of it vanish.
 */
export function renderSciCursorImage(cursor: SciCursor): RenderedImage {
  const rgba = new Uint8ClampedArray(cursor.width * cursor.height * 4);
  for (let i = 0, j = 0; i < cursor.pixels.length; i++, j += 4) {
    const pixel = cursor.pixels[i];
    if (pixel === CURSOR_TRANSPARENT) continue;
    const value = pixel === 0 ? 0 : 255;
    rgba[j] = value;
    rgba[j + 1] = value;
    rgba[j + 2] = value;
    rgba[j + 3] = 255;
  }
  return { width: cursor.width, height: cursor.height, rgba };
}

/** "kq4-view-12-loop-0-cel-3.png": which game, which resource, which frame. */
export function sciImageFilename(gameName: string, parts: string): string {
  const stem = gameName
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return `${stem || 'game'}-${parts}.png`;
}
