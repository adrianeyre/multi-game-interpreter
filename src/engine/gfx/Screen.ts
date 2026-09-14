import type { Palette } from './Palette.js';
import type { RoomGraphics } from './RoomGraphics.js';

/**
 * The size every Version this project supported before SCI ran at.
 *
 * Kept as the default a `Screen` is built at rather than as the size a `Screen`
 * *is* (ADR 0015, #213). SCUMM v2-v8 and AGI v2-v3 are all 320x200 and their
 * own modules may go on saying so; what changed is that the shell no longer
 * imports these, because SCI2 composites 320x200 script coordinates to 640x480
 * and a single pair of module constants cannot express that.
 */
export const SCREEN_WIDTH = 320;
export const SCREEN_HEIGHT = 200;

export interface VirtScreen {
  /** First screen row this virtual screen covers. */
  top: number;
  height: number;
}

/**
 * The 320x200 palette-indexed framebuffer, plus the virtual screen layout.
 *
 * SCUMM splits the display into three bands: a text band at the top, the room
 * view, and the verb/inventory panel. v5 games set this up with
 * `roomOps setScreen`, so the split is data driven rather than hard coded —
 * Indiana Jones and Monkey Island use different values.
 */
export class Screen {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;

  /** The room view. */
  main: VirtScreen = { top: 16, height: 128 };
  /** The band above the room view, where some games put dialogue. */
  text: VirtScreen = { top: 0, height: 16 };
  /** The verb and inventory panel. */
  verb: VirtScreen = { top: 144, height: 56 };

  private imageData: ImageData | null = null;

  /**
   * Built at a size rather than at *the* size.
   *
   * ADR 0011 claimed this class was "reusable unchanged" for a second family
   * and that held — AGI is also 320x200. SCI2 is the first caller to falsify
   * it, so the two constants became a default and the dimensions became
   * instance state. Everything below reads `this.width`/`this.height`, which is
   * the whole of the change: no caller that wanted 320x200 has to say so.
   */
  constructor(width = SCREEN_WIDTH, height = SCREEN_HEIGHT) {
    this.width = width;
    this.height = height;
    this.pixels = new Uint8Array(width * height);
  }

  /** Mirrors `initScreens(b, h)`: text band height `b`, verb panel below `h`. */
  setLayout(b: number, h: number): void {
    this.main = { top: b, height: Math.max(0, h - b) };
    this.text = { top: 0, height: b };
    this.verb = { top: h, height: Math.max(0, this.height - h) };
  }

  clear(color = 0): void {
    this.pixels.fill(color);
  }

  clearVirtScreen(screen: VirtScreen, color = 0): void {
    const start = screen.top * this.width;
    this.pixels.fill(color, start, start + screen.height * this.width);
  }

  /**
   * Copies the visible window of the room background into the framebuffer.
   *
   * `cameraX` is the leftmost visible room column and `cameraY` the topmost
   * visible row. Both are clamped here rather than trusted: a room no larger
   * than the band has nowhere to scroll, which is every v5 and v6 room on the
   * y axis, so those draw from row 0 without anything asking which version is
   * running (ADR 0007).
   */
  drawRoom(room: RoomGraphics, cameraX: number, cameraY = 0): void {
    const { top, height } = this.main;
    const maxX = Math.max(0, room.width - this.width);
    const maxY = Math.max(0, room.height - height);
    const originX = Math.max(0, Math.min(cameraX, maxX));
    const originY = Math.max(0, Math.min(cameraY, maxY));

    for (let y = 0; y < height; y++) {
      const roomRow = originY + y;
      const destBase = (top + y) * this.width;
      if (roomRow >= room.height) {
        this.pixels.fill(0, destBase, destBase + this.width);
        continue;
      }
      const srcBase = roomRow * room.width + originX;
      const copyWidth = Math.min(this.width, room.width - originX);
      this.pixels.set(room.background.subarray(srcBase, srcBase + copyWidth), destBase);
      if (copyWidth < this.width) {
        this.pixels.fill(0, destBase + copyWidth, destBase + this.width);
      }
    }
  }

  /** Bounds-checked single pixel write in screen coordinates. */
  putPixel(x: number, y: number, color: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.pixels[y * this.width + x] = color;
  }

  getPixel(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return 0;
    return this.pixels[y * this.width + x];
  }

  fillRect(x: number, y: number, width: number, height: number, color: number): void {
    const x0 = Math.max(0, x);
    const y0 = Math.max(0, y);
    const x1 = Math.min(this.width, x + width);
    const y1 = Math.min(this.height, y + height);
    for (let row = y0; row < y1; row++) {
      this.pixels.fill(color, row * this.width + x0, row * this.width + x1);
    }
  }

  drawRect(x: number, y: number, width: number, height: number, color: number): void {
    this.fillRect(x, y, width, 1, color);
    this.fillRect(x, y + height - 1, width, 1, color);
    this.fillRect(x, y, 1, height, color);
    this.fillRect(x + width - 1, y, 1, height, color);
  }

  /**
   * Expands the indexed framebuffer through the palette into `ImageData` and
   * paints it.
   *
   * `putImageData` bypasses the canvas transform, so scaling is left to CSS on
   * the canvas element with `image-rendering: pixelated`. That keeps the blit
   * a straight memcpy and the output crisp at any integer zoom.
   */
  present(context: CanvasRenderingContext2D, palette: Palette): void {
    palette.flush();
    if (!this.imageData) {
      this.imageData = context.createImageData(this.width, this.height);
    }
    const out = this.imageData.data;
    const { pixels } = this;
    const rgba = palette.rgba;

    for (let i = 0, j = 0; i < pixels.length; i++, j += 4) {
      const index = pixels[i] << 2;
      out[j] = rgba[index];
      out[j + 1] = rgba[index + 1];
      out[j + 2] = rgba[index + 2];
      out[j + 3] = 255;
    }
    context.putImageData(this.imageData, 0, 0);
  }

  /** Snapshot used by the save system and by the tests. */
  copyPixels(): Uint8Array {
    return this.pixels.slice();
  }
}
