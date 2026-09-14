/**
 * An AGOS image, as a drawing surface.
 *
 * The SCUMM editor's object and costume canvases and this one are the same
 * thing over different pixels: an indexed bitmap, a tool, a colour, a zoom, and
 * a keyboard cursor that can do everything the pointer can. AGOS is not a third
 * design — it is those same affordances over four-bit indices — so the shapes
 * below deliberately follow `ObjectArtCanvas`, down to which key does what. An
 * author who learned one canvas has learned all three.
 *
 * ## The colours are the game's, and used not to be
 *
 * An AGOS image's colours come from a bank a **script** selects at draw time,
 * so an image sitting on its own has no one right palette. That was taken as a
 * reason to draw every image as grey levels — the index is the fact, so show
 * the index — and it made the Art tab a monochrome surface for a game whose
 * art is its point.
 *
 * The banks are readable without running anything: they sit at offset 6 of the
 * zone's own script resource, ninety-six bytes each, up to the header block.
 * So the surface offers the ones the zone has and paints with the chosen one,
 * which is a person picking a bank rather than the editor inventing a palette.
 * Grey stays as the fallback for an image whose zone is not open, where there
 * is genuinely nothing to pick from.
 *
 * ## Why an edit is a whole bitmap and not a pixel
 *
 * ADR 0030 has the Project record **intent** — which image was painted to which
 * bitmap — rather than the zone's bytes. So this owns a working copy, mutates
 * it, and hands the whole thing back; the surface above decides when that
 * becomes a `PaintedImage`. Nothing here writes a zone.
 */

import type { IndexedBitmap } from '../../engine/agos/gfx/agosImage.js';
import {
  describeCanvas,
  drawCursor,
  isActivation,
  isErase,
  KeyboardCursor,
} from '../canvasKeyboard.js';

/** What a press does. The same four the SCUMM canvases offer, named the same. */
export type AgosTool = 'paint' | 'rectangle' | 'fill' | 'picker';

export const AGOS_TOOLS: ReadonlyArray<readonly [AgosTool, string, string]> = [
  ['paint', 'Paint', 'Freehand pixels'],
  ['rectangle', 'Rectangle', 'Drag a filled rectangle'],
  ['fill', 'Fill', 'Flood the area under the pointer'],
  ['picker', 'Pick up', 'Take the colour under the pointer'],
];

/** Four bits per pixel, so sixteen of them and no more. */
export const AGOS_COLOURS = 16;

/** The grey a colour index is drawn as when no palette is available. */
export function greyFor(index: number): string {
  const level = Math.round((Math.max(0, Math.min(15, index)) * 255) / 15);
  return `rgb(${level}, ${level}, ${level})`;
}

/** Sixteen colours, one per four-bit index. */
export type AgosPalette = readonly (readonly number[])[];

/** The fallback: sixteen grey levels, for an image with no bank behind it. */
export function greyPalette(): AgosPalette {
  return Array.from({ length: 16 }, (_, index) => {
    const level = Math.round((index * 255) / 15);
    return [level, level, level];
  });
}

/** One index as a CSS colour, for a swatch. */
export function cssFor(palette: AgosPalette, index: number): string {
  const entry = palette[index] ?? [0, 0, 0];
  return `rgb(${entry[0] ?? 0}, ${entry[1] ?? 0}, ${entry[2] ?? 0})`;
}

/**
 * Whether a swatch needs light text on it or dark.
 *
 * The index is written on the swatch because colour alone must not carry which
 * one it is (1.4.1), and a fixed ink is unreadable on half a real palette. The
 * usual luminance split, which is enough for a two-digit number.
 */
export function inkFor(palette: AgosPalette, index: number): string {
  const [red = 0, green = 0, blue = 0] = palette[index] ?? [];
  return red * 0.299 + green * 0.587 + blue * 0.114 > 140 ? '#000000' : '#ffffff';
}

/**
 * The two greys transparency is drawn as, and the size of its squares.
 *
 * A checkerboard rather than a colour, for the reason every image editor uses
 * one: nothing that can be a colour can also mean "no colour". This one is
 * light because index 0 renders as black otherwise — an AGOS sprite is mostly
 * transparent, so a whole strip of them came out as black rectangles and read
 * as a game whose art had failed to load.
 */
const CHECKER = [0xb4, 0x8c] as const;
const CHECKER_SIZE = 4;

/**
 * Paints a bitmap's indices into RGBA, as grey levels.
 *
 * Grey because an AGOS image's colours come from a bank a **script** selects at
 * draw time, so an image on its own has no one right palette and inventing one
 * would show colours the game never uses with it.
 *
 * Index 0 is the exception, and it is not a colour at all: the renderer treats
 * it as transparent unless the entry's `opaque` flag is set. So it is drawn as
 * a checkerboard, which says "nothing here" without claiming to be a shade.
 *
 * Shared by the canvas and the strip's thumbnails, so the small picture and the
 * large one cannot disagree about what an image looks like.
 */
export function paintBitmap(
  target: Uint8ClampedArray,
  bitmap: IndexedBitmap,
  options: { transparentZero?: boolean; palette?: AgosPalette } = {},
): void {
  const transparent = options.transparentZero ?? true;
  const palette = options.palette ?? greyPalette();
  for (let y = 0; y < bitmap.height; y += 1) {
    for (let x = 0; x < bitmap.width; x += 1) {
      const at = y * bitmap.width + x;
      const index = bitmap.pixels[at] ?? 0;
      if (index === 0 && transparent) {
        const level = CHECKER[(((x / CHECKER_SIZE) | 0) + ((y / CHECKER_SIZE) | 0)) % 2]!;
        target[at * 4] = level;
        target[at * 4 + 1] = level;
        target[at * 4 + 2] = level;
        target[at * 4 + 3] = 255;
        continue;
      }
      const entry = palette[index] ?? [0, 0, 0];
      target[at * 4] = entry[0] ?? 0;
      target[at * 4 + 1] = entry[1] ?? 0;
      target[at * 4 + 2] = entry[2] ?? 0;
      target[at * 4 + 3] = 255;
    }
  }
}

export interface AgosImageCanvasOptions {
  /** Called with the edited bitmap, once per completed gesture. */
  onEdit: (bitmap: IndexedBitmap) => void;
  /** Called when a tool or a key takes a colour off the image. */
  onColourPicked?: (colour: number) => void;
  /**
   * Where the pointer is, and what is under it.
   *
   * Separate from `onSay` because it fires on every mouse move: the SCUMM room
   * canvas reports the same thing into the status bar and marks it
   * `aria-hidden`, because announced it would be a stream of numbers with no
   * beginning or end. The keyboard cursor says its position through `onSay`
   * instead, on demand, which is the half a screen reader can use.
   */
  onHover?: (where: string) => void;
  /** Said out loud, for keyboard gestures that have nothing else to show. */
  onSay?: (message: string) => void;
}

export class AgosImageCanvas {
  readonly element = document.createElement('canvas');
  readonly help: HTMLElement;
  readonly cursor = new KeyboardCursor();

  tool: AgosTool = 'paint';
  colour = 0;
  zoom = 8;
  showGrid = true;
  /**
   * Whether index 0 means "nothing here" for this image.
   *
   * The entry's `opaque` flag decides it — set, and colour zero is a colour the
   * game draws; clear, and the renderer skips it. Following the flag is what
   * stops a mostly-transparent sprite from being shown as a black rectangle,
   * which is what an AGOS sprite mostly is.
   */
  transparentZero = true;
  /**
   * The sixteen colours a pixel's four bits index.
   *
   * Grey until a zone's own bank is handed over, which is the honest picture
   * for an image whose zone is not open: there is nothing to be right about.
   */
  palette: AgosPalette = greyPalette();

  private bitmap: IndexedBitmap = { width: 1, height: 1, pixels: new Uint8Array(1) };
  /** Set while a gesture is in flight, so a drag is one edit and not fifty. */
  private drawing = false;
  private anchor: { x: number; y: number } | null = null;
  /** The bitmap as it was before the gesture, so a rectangle can be previewed. */
  private before: Uint8Array | null = null;

  constructor(private readonly options: AgosImageCanvasOptions) {
    this.element.className = 'agos-image-canvas sprite-canvas';
    this.help = describeCanvas(this.element, {
      id: 'agos-image-canvas-help',
      label: 'AGOS image',
      help:
        'Draw the open image. Arrow keys move the drawing cursor one pixel, with Shift for ' +
        'eight. Enter or Space paints the selected colour index, Delete paints index zero, ' +
        'and P picks up the index under the cursor. Home, End, Page Up and Page Down go to ' +
        'the edges. An AGOS image takes its palette from whichever bank a script chooses ' +
        'when it draws, so the bank is picked on the toolbar and the checkerboard is ' +
        'colour index zero, which the game draws as transparent.',
    });
    this.attachPointer();
    this.attachKeyboard();
  }

  /** The bitmap on screen. A copy, so a caller cannot mutate what is drawn. */
  get image(): IndexedBitmap {
    return { ...this.bitmap, pixels: new Uint8Array(this.bitmap.pixels) };
  }

  /** Opens a bitmap. The cursor is clamped rather than reset: a re-render of
   * the same image should not throw away where the author was. */
  show(bitmap: IndexedBitmap): void {
    this.bitmap = { ...bitmap, pixels: new Uint8Array(bitmap.pixels) };
    this.cursor.clamp({ width: bitmap.width, height: bitmap.height });
    this.applyZoom();
    this.render();
  }

  applyZoom(): void {
    this.element.width = this.bitmap.width;
    this.element.height = this.bitmap.height;
    this.element.style.width = `${this.bitmap.width * this.zoom}px`;
    this.element.style.height = `${this.bitmap.height * this.zoom}px`;
    // Pixel art enlarged with smoothing is a different picture. The canvas is
    // its own pixel grid and CSS does the scaling, so the browser is told not
    // to interpolate on the way up.
    this.element.style.imageRendering = 'pixelated';
  }

  render(): void {
    const { width, height } = this.bitmap;
    // Set before the drawing, and outside the guard below: a canvas is
    // invisible to a screen reader without it, and a host with no 2D context
    // (a test environment, most often) would otherwise leave it unnamed.
    this.element.setAttribute(
      'aria-label',
      `AGOS image, ${width} by ${height} pixels, drawing with colour index ${this.colour}`,
    );

    const context = this.element.getContext('2d');
    if (!context) return;

    const data = context.createImageData(width, height);
    paintBitmap(data.data, this.bitmap, {
      transparentZero: this.transparentZero,
      palette: this.palette,
    });
    context.putImageData(data, 0, 0);

    if (this.cursor.visible) drawCursor(context, this.cursor.x, this.cursor.y, 1, 1);
  }

  // ------------------------------------------------------------- gestures --

  private attachPointer(): void {
    this.element.addEventListener('contextmenu', (event) => {
      // Right-click picks a colour, exactly as it does on the SCUMM canvases.
      event.preventDefault();
      const point = this.pointAt(event);
      if (point) this.pick(point);
    });

    this.element.addEventListener('pointerdown', (event) => {
      if (event.button === 2) return;
      const point = this.pointAt(event);
      if (!point) return;
      // Guarded: a drag that leaves the canvas should still be one gesture, but
      // a host without pointer capture (jsdom) must not lose the gesture to an
      // exception before a single pixel is placed.
      try {
        this.element.setPointerCapture(event.pointerId);
      } catch {
        // Capture is an improvement on the drag, never a precondition for it.
      }
      this.drawing = true;
      this.anchor = point;
      this.before = new Uint8Array(this.bitmap.pixels);

      if (this.tool === 'picker') {
        this.pick(point);
        this.finish();
        return;
      }
      if (this.tool === 'fill') {
        this.flood(point, this.colour);
        this.finish();
        return;
      }
      this.plot(point.x, point.y, this.colour);
      this.render();
    });

    this.element.addEventListener('pointerleave', () => this.options.onHover?.(''));

    this.element.addEventListener('pointermove', (event) => {
      const at = this.pointAt(event);
      // Placing anything by eye is guesswork without it, which is the reason
      // the room canvas has the same read-out.
      this.options.onHover?.(at ? `${at.x}, ${at.y} — index ${this.at(at.x, at.y)}` : '');

      if (!this.drawing) return;
      const point = this.pointAt(event);
      if (!point) return;
      if (this.tool === 'paint') {
        this.plot(point.x, point.y, this.colour);
      } else if (this.tool === 'rectangle' && this.anchor && this.before) {
        // Redrawn from the snapshot every move, so dragging a rectangle back
        // smaller does not leave the larger one behind it.
        this.bitmap.pixels.set(this.before);
        this.rectangle(this.anchor, point, this.colour);
      }
      this.render();
    });

    const end = (): void => {
      if (this.drawing) this.finish();
    };
    this.element.addEventListener('pointerup', end);
    this.element.addEventListener('pointercancel', end);
    this.element.addEventListener('pointerleave', end);
  }

  private attachKeyboard(): void {
    this.element.addEventListener('focus', () => {
      this.cursor.visible = true;
      this.render();
    });
    this.element.addEventListener('blur', () => {
      this.cursor.visible = false;
      this.render();
    });

    this.element.addEventListener('keydown', (event) => {
      const bounds = { width: this.bitmap.width, height: this.bitmap.height };

      if (this.cursor.handle(event, bounds)) {
        event.preventDefault();
        this.render();
        const value = this.at(this.cursor.x, this.cursor.y);
        this.options.onSay?.(`${this.cursor.x}, ${this.cursor.y} — colour index ${value}`);
        return;
      }

      if (isActivation(event) || isErase(event)) {
        event.preventDefault();
        // Delete paints index zero rather than clearing: four bits have no
        // "no colour", so there is nothing else it could honestly mean.
        const value = isErase(event) ? 0 : this.colour;
        this.plot(this.cursor.x, this.cursor.y, value);
        this.render();
        this.options.onEdit(this.image);
        this.options.onSay?.(
          `Painted colour index ${value} at ${this.cursor.x}, ${this.cursor.y}.`,
        );
        return;
      }

      if (event.key === 'f' || event.key === 'F') {
        event.preventDefault();
        this.flood({ x: this.cursor.x, y: this.cursor.y }, this.colour);
        this.render();
        this.options.onEdit(this.image);
        this.options.onSay?.(`Filled from ${this.cursor.x}, ${this.cursor.y}.`);
        return;
      }

      if (event.key === 'p' || event.key === 'P') {
        event.preventDefault();
        this.pick({ x: this.cursor.x, y: this.cursor.y });
      }
    });
  }

  private finish(): void {
    this.drawing = false;
    this.anchor = null;
    this.before = null;
    this.render();
    this.options.onEdit(this.image);
  }

  private pick(point: { x: number; y: number }): void {
    this.colour = this.at(point.x, point.y);
    this.options.onColourPicked?.(this.colour);
    this.options.onSay?.(`Picked up colour index ${this.colour}.`);
    this.render();
  }

  // ---------------------------------------------------------------- pixels --

  private at(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.bitmap.width || y >= this.bitmap.height) return 0;
    return this.bitmap.pixels[y * this.bitmap.width + x] ?? 0;
  }

  private plot(x: number, y: number, colour: number): void {
    if (x < 0 || y < 0 || x >= this.bitmap.width || y >= this.bitmap.height) return;
    this.bitmap.pixels[y * this.bitmap.width + x] = colour & 0x0f;
  }

  private rectangle(
    from: { x: number; y: number },
    to: { x: number; y: number },
    colour: number,
  ): void {
    const left = Math.min(from.x, to.x);
    const right = Math.max(from.x, to.x);
    const top = Math.min(from.y, to.y);
    const bottom = Math.max(from.y, to.y);
    for (let y = top; y <= bottom; y += 1) {
      for (let x = left; x <= right; x += 1) this.plot(x, y, colour);
    }
  }

  /**
   * Four-way flood fill, iteratively.
   *
   * A stack rather than recursion: a zone image can be the width of the screen,
   * and a recursive fill over a few thousand pixels is a blown stack rather
   * than a slow fill.
   */
  private flood(from: { x: number; y: number }, colour: number): void {
    const target = this.at(from.x, from.y);
    if ((colour & 0x0f) === target) return;

    const stack = [from];
    const seen = new Set<number>();
    while (stack.length > 0) {
      const point = stack.pop()!;
      const { x, y } = point;
      if (x < 0 || y < 0 || x >= this.bitmap.width || y >= this.bitmap.height) continue;
      const key = y * this.bitmap.width + x;
      if (seen.has(key)) continue;
      seen.add(key);
      if (this.at(x, y) !== target) continue;
      this.plot(x, y, colour);
      stack.push({ x: x + 1, y }, { x: x - 1, y }, { x, y: y + 1 }, { x, y: y - 1 });
    }
  }

  /**
   * Which pixel a pointer event landed on, or null when it landed outside.
   *
   * A canvas is displayed larger than its pixel grid — an AGOS sprite is a few
   * dozen pixels across — so the offset is scaled by the ratio between the
   * element's rendered size and its pixel size. Where the rendered size is zero,
   * which is what a detached or unlaid-out canvas reports, the offset is taken
   * unscaled: that is the truthful reading of "one CSS pixel is one image pixel"
   * rather than a division by zero.
   */
  private pointAt(event: MouseEvent): { x: number; y: number } | null {
    const scaleX = this.element.clientWidth > 0 ? this.element.width / this.element.clientWidth : 1;
    const scaleY =
      this.element.clientHeight > 0 ? this.element.height / this.element.clientHeight : 1;
    const x = Math.floor(event.offsetX * scaleX);
    const y = Math.floor(event.offsetY * scaleY);
    if (x < 0 || y < 0 || x >= this.element.width || y >= this.element.height) return null;
    return { x, y };
  }
}
