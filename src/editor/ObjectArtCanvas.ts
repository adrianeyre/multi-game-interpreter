import { createImage, TRANSPARENT_INDEX, type IndexedImage } from '../authoring/ImageEncoder.js';
import { loadImage, storeImage } from '../authoring/imageCodec.js';
import { getPixel } from '../authoring/draw.js';
import { defaultPalette } from '../authoring/palette.js';
import type { ProjectObject } from '../authoring/project.js';
import type { EditorState } from './state.js';
import {
  KeyboardCursor,
  describeCanvas,
  drawCursor,
  isActivation,
  isErase,
} from './canvasKeyboard.js';

/**
 * A zoomed pixel editor for an object's states.
 *
 * Separate from the sprite editor because the two work in different colour
 * spaces: a costume stores its own 0-15 indices resolved through the actor
 * palette, while an object stores game palette indices directly, with 255
 * meaning transparent. Sharing one canvas would mean branching on that in every
 * operation.
 *
 * "States" are how a SCUMM object changes appearance — state 1 a closed door,
 * state 2 an open one — and scripts switch between them with `setState`.
 */
export class ObjectArtCanvas {
  readonly element: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly state: EditorState;
  private readonly defaultColors = defaultPalette();

  /**
   * Colours to draw the object's art in.
   *
   * Object art indexes the room's palette, not a palette of its own, so it has
   * to follow whichever room is open — otherwise an imported object is painted
   * in colours that belong to a different game.
   */
  private get palette(): number[][] {
    return this.state.currentRoom?.palette ?? this.defaultColors;
  }

  /** Game palette index being painted, or 255 for transparent. */
  color = 15;
  zoom = 8;
  stateIndex = 0;
  showGrid = true;

  private painting = false;
  private erasing = false;

  constructor(state: EditorState) {
    this.state = state;
    this.element = document.createElement('canvas');
    this.element.className = 'sprite-canvas';

    const context = this.element.getContext('2d');
    if (!context) throw new Error('Canvas 2D is unavailable');
    this.context = context;

    this.attach();
    this.attachKeyboardHandlers();
  }

  /**
   * The cursor the arrow keys move.
   *
   * Object art was pointer-only, exactly as costume art was, and this is the
   * same answer: a cell the keyboard moves and Enter paints. 2.1.1.
   */
  readonly cursor = new KeyboardCursor();

  /** Called after a key changes the cursor or the art, so the editor can say so. */
  onKeyboardChange: ((message: string) => void) | null = null;

  /** The description element for this canvas, placed beside it by the editor. */
  help!: HTMLElement;

  private attachKeyboardHandlers(): void {
    this.help = describeCanvas(this.element, {
      id: 'object-canvas-help',
      label: 'Object artwork',
      help:
        'Draw the selected object state. Arrow keys move the drawing cursor one pixel, ' +
        'with Shift for eight. Enter or Space paints the selected colour, Delete makes the ' +
        'pixel transparent, and P picks up the colour under the cursor. Home, End, Page Up ' +
        'and Page Down go to the edges.',
    });

    this.element.addEventListener('focus', () => {
      this.cursor.visible = true;
      this.render();
    });
    this.element.addEventListener('blur', () => {
      this.cursor.visible = false;
      this.render();
    });

    this.element.addEventListener('keydown', (event) => {
      if (!this.object) return;
      const image = this.currentImage();
      const bounds = { width: image.width, height: image.height };

      if (this.cursor.handle(event, bounds)) {
        event.preventDefault();
        this.render();
        const value = getPixel(image, this.cursor.x, this.cursor.y);
        this.onKeyboardChange?.(
          `${this.cursor.x}, ${this.cursor.y} — ${
            value === TRANSPARENT_INDEX ? 'transparent' : `colour ${value}`
          }`,
        );
        return;
      }

      if (isActivation(event) || isErase(event)) {
        event.preventDefault();
        this.state.beginTransaction();
        this.paintPixel(this.cursor.x, this.cursor.y, isErase(event));
        this.render();
        this.onKeyboardChange?.(
          isErase(event)
            ? `Made ${this.cursor.x}, ${this.cursor.y} transparent.`
            : `Painted colour ${this.color} at ${this.cursor.x}, ${this.cursor.y}.`,
        );
        return;
      }

      if (event.key === 'p' || event.key === 'P') {
        event.preventDefault();
        this.color = getPixel(image, this.cursor.x, this.cursor.y);
        this.onColorPicked?.(this.color);
        this.onKeyboardChange?.(`Picked up colour ${this.color}.`);
      }
    });
  }

  /** One pixel, from a key rather than a pointer. */
  private paintPixel(x: number, y: number, erase: boolean): void {
    const image = this.currentImage();
    if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;
    const value = erase ? TRANSPARENT_INDEX : this.color;
    if (image.pixels[y * image.width + x] === value) return;
    image.pixels[y * image.width + x] = value;
    this.writeImage(image, true);
  }

  private get object(): ProjectObject | null {
    return this.state.currentObject;
  }

  get states(): number {
    return this.object?.states.length ?? 0;
  }

  private currentImage(): IndexedImage {
    const object = this.object;
    const stored = object?.states[this.stateIndex];
    if (stored) return loadImage(stored);
    return createImage(object?.width ?? 16, object?.height ?? 16, TRANSPARENT_INDEX);
  }

  private writeImage(image: IndexedImage, transient: boolean): void {
    const objectId = this.object?.id;
    if (objectId === undefined) return;
    const stateIndex = this.stateIndex;

    this.state.update(
      (project) => {
        for (const room of project.rooms) {
          const object = room.objects.find((candidate) => candidate.id === objectId);
          if (!object) continue;
          while (object.states.length <= stateIndex) {
            object.states.push(
              storeImage(createImage(object.width, object.height, TRANSPARENT_INDEX)),
            );
          }
          object.states[stateIndex] = storeImage(image);
        }
      },
      { transient },
    );
  }

  private attach(): void {
    this.element.addEventListener('contextmenu', (event) => event.preventDefault());

    this.element.addEventListener('pointerdown', (event) => {
      if (!this.object) return;
      this.element.setPointerCapture(event.pointerId);

      // Right-click already erases here, so the eyedropper takes alt-click.
      if (event.altKey) {
        this.pickColor(event);
        return;
      }

      this.painting = true;
      this.erasing = event.button === 2;
      this.state.beginTransaction();
      this.paint(event);
    });

    this.element.addEventListener('pointermove', (event) => {
      if (this.painting) this.paint(event);
    });

    const stop = (): void => {
      this.painting = false;
      this.erasing = false;
    };
    this.element.addEventListener('pointerup', stop);
    this.element.addEventListener('pointercancel', stop);
  }

  /** Fired when the eyedropper picks a colour, so the palette can follow. */
  onColorPicked: ((color: number) => void) | null = null;

  private pickColor(event: PointerEvent): void {
    const { x, y } = this.pointerPixel(event);
    const image = this.currentImage();
    if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;
    this.color = getPixel(image, x, y);
    this.onColorPicked?.(this.color);
  }

  private pointerPixel(event: PointerEvent): { x: number; y: number } {
    const bounds = this.element.getBoundingClientRect();
    return {
      x: Math.floor(
        (((event.clientX - bounds.left) / bounds.width) * this.element.width) / this.zoom,
      ),
      y: Math.floor(
        (((event.clientY - bounds.top) / bounds.height) * this.element.height) / this.zoom,
      ),
    };
  }

  private paint(event: PointerEvent): void {
    const bounds = this.element.getBoundingClientRect();
    const x = Math.floor(
      (((event.clientX - bounds.left) / bounds.width) * this.element.width) / this.zoom,
    );
    const y = Math.floor(
      (((event.clientY - bounds.top) / bounds.height) * this.element.height) / this.zoom,
    );

    const image = this.currentImage();
    if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;

    const value = this.erasing ? TRANSPARENT_INDEX : this.color;
    if (image.pixels[y * image.width + x] === value) return;

    image.pixels[y * image.width + x] = value;
    this.writeImage(image, true);
  }

  /** Replaces the current state's art, resizing the object to match. */
  replaceWith(image: IndexedImage): void {
    const objectId = this.object?.id;
    if (objectId === undefined) return;
    const stateIndex = this.stateIndex;

    this.state.update((project) => {
      for (const room of project.rooms) {
        const object = room.objects.find((candidate) => candidate.id === objectId);
        if (!object) continue;
        while (object.states.length <= stateIndex) object.states.push(storeImage(image));
        object.states[stateIndex] = storeImage(image);
        // The hit box follows the art, or clicking the object would miss it.
        object.width = image.width;
        object.height = image.height;
      }
    });
  }

  addState(): void {
    const source = this.currentImage();
    const objectId = this.object?.id;
    if (objectId === undefined) return;

    this.state.update((project) => {
      for (const room of project.rooms) {
        const object = room.objects.find((candidate) => candidate.id === objectId);
        object?.states.push(storeImage(source));
      }
    });
    this.stateIndex = this.states - 1;
  }

  removeState(): void {
    // An object with no states is never drawn, so the last one stays.
    if (this.states <= 1) return;
    const objectId = this.object?.id;
    const at = this.stateIndex;

    this.state.update((project) => {
      for (const room of project.rooms) {
        const object = room.objects.find((candidate) => candidate.id === objectId);
        object?.states.splice(at, 1);
      }
    });
    this.stateIndex = Math.max(0, at - 1);
  }

  resize(width: number, height: number): void {
    const source = this.currentImage();
    const target = createImage(
      Math.max(1, Math.min(320, width)),
      Math.max(1, Math.min(200, height)),
      TRANSPARENT_INDEX,
    );
    for (let y = 0; y < Math.min(source.height, target.height); y++) {
      for (let x = 0; x < Math.min(source.width, target.width); x++) {
        target.pixels[y * target.width + x] = source.pixels[y * source.width + x];
      }
    }
    this.replaceWith(target);
  }

  clear(): void {
    const image = this.currentImage();
    image.pixels.fill(TRANSPARENT_INDEX);
    this.writeImage(image, false);
  }

  get size(): { width: number; height: number } {
    const image = this.currentImage();
    return { width: image.width, height: image.height };
  }

  render(): void {
    const image = this.currentImage();
    const width = image.width * this.zoom;
    const height = image.height * this.zoom;

    if (this.element.width !== width || this.element.height !== height) {
      this.element.width = width;
      this.element.height = height;
    }

    const context = this.context;
    context.clearRect(0, 0, width, height);

    // Transparency needs a chequerboard, because 255 would otherwise look like
    // whatever colour sits at that palette entry.
    const cell = Math.max(4, Math.floor(this.zoom / 2));
    for (let y = 0; y < height; y += cell) {
      for (let x = 0; x < width; x += cell) {
        const dark = ((x / cell) | 0) % 2 === ((y / cell) | 0) % 2;
        context.fillStyle = dark ? '#1b1b22' : '#23232c';
        context.fillRect(x, y, cell, cell);
      }
    }

    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        const index = image.pixels[y * image.width + x];
        if (index === TRANSPARENT_INDEX) continue;
        const entry = this.palette[index] ?? [0, 0, 0];
        context.fillStyle = `rgb(${entry[0]}, ${entry[1]}, ${entry[2]})`;
        context.fillRect(x * this.zoom, y * this.zoom, this.zoom, this.zoom);
      }
    }

    if (this.showGrid && this.zoom >= 6) {
      context.strokeStyle = 'rgba(255, 255, 255, 0.07)';
      context.lineWidth = 1;
      for (let x = 0; x <= image.width; x++) {
        context.beginPath();
        context.moveTo(x * this.zoom + 0.5, 0);
        context.lineTo(x * this.zoom + 0.5, height);
        context.stroke();
      }
      for (let y = 0; y <= image.height; y++) {
        context.beginPath();
        context.moveTo(0, y * this.zoom + 0.5);
        context.lineTo(width, y * this.zoom + 0.5);
        context.stroke();
      }
    }

    // Last, so nothing paints over it. On a canvas, the focus indicator has to
    // be part of the picture (2.4.7).
    if (this.cursor.visible) {
      this.cursor.clamp({ width: image.width, height: image.height });
      drawCursor(context, this.cursor.x, this.cursor.y, this.zoom, this.zoom);
    }
  }

  /** A thumbnail of one state, for the state strip. */
  thumbnail(index: number, size = 40): string {
    const stored = this.object?.states[index];
    if (!stored) return '';
    const image = loadImage(stored);
    const scale = Math.max(1, Math.floor(size / Math.max(image.width, image.height)));

    const canvas = document.createElement('canvas');
    canvas.width = image.width * scale;
    canvas.height = image.height * scale;
    const context = canvas.getContext('2d');
    if (!context) return '';

    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        const value = image.pixels[y * image.width + x];
        if (value === TRANSPARENT_INDEX) continue;
        const entry = this.palette[value] ?? [0, 0, 0];
        context.fillStyle = `rgb(${entry[0]}, ${entry[1]}, ${entry[2]})`;
        context.fillRect(x * scale, y * scale, scale, scale);
      }
    }
    return canvas.toDataURL();
  }
}
