/**
 * Broken Sword's renderer: a room-sized buffer, then the window onto it.
 *
 * ## Why there are two buffers and not one
 *
 * A Broken Sword screen is *bigger than the display*. Screen 1 is 784x400 in a
 * 640x400 window, and the game scrolls. So drawing happens into a buffer the
 * size of the **room**, in the room's own coordinates, and the visible window
 * is copied out of it afterwards. Every coordinate in this file is a room
 * coordinate until `present`, which is the one place the scroll offset applies.
 *
 * Getting that the other way round — drawing into a screen-sized buffer and
 * offsetting each sprite — is what makes masking wrong: the layer grid is
 * indexed in room blocks, and a sprite clipped to the display has already lost
 * the pixels the mask needed to test.
 *
 * ## The masking, which is the interesting part
 *
 * A room has a background layer and up to three **mask** layers, plus a grid
 * per mask. The grid is a 16x8-block map saying which block of which mask
 * covers that part of the room; a non-zero entry is a 128-byte block of pixels
 * to stamp back *over* a sprite after it is drawn. That is how George walks
 * behind a lamp-post without the lamp-post being a sprite.
 *
 * The grid is indexed against an **imaginary screen 128 pixels wider on each
 * side**, which is why `gridWidth` in the room table is not `sizeX / 16` and why
 * `SCREEN_LEFT_EDGE / SCRNGRID_X` appears in the index arithmetic. Using the
 * visible width instead shifts every mask eight blocks left, which looks like
 * the masks belonging to a different room.
 *
 * ## Drawing order
 *
 * Background, then the background sprite list, then the sorted list **sorted by
 * y**, then the parallax layers, then the foreground list. The sort is what
 * makes two megas in the same room overlap correctly, and it is a bubble sort
 * over at most a few dozen entries in the original — kept as a stable sort by
 * y here, which gives the same order for the same input.
 */

import { Palette } from '../../gfx/Palette.js';
import type { SwordCompact } from '../resource/swordCompact.js';
import { CPT } from '../resource/swordCompact.js';
import {
  SWORD1_MENU_BAR_HEIGHT,
  SWORD1_SCREEN_DEPTH,
  SWORD1_SCREEN_FULL_DEPTH,
  SWORD1_SCREEN_LEFT_EDGE,
  SWORD1_SCREEN_TOP_EDGE,
  SWORD1_SCREEN_WIDTH,
  SwordStatus,
  SwordType,
} from '../resource/swordDefs.js';
import { SWORD1_ROOMS, type Sword1RoomDef } from '../resource/swordRooms.js';
import type { SwordObjects } from '../resource/SwordObjects.js';
import type { SwordResources } from '../resource/SwordResources.js';
import { formatResourceId } from '../resource/rif.js';
import {
  compressionOf,
  decodeSwordFrame,
  decodeSwordParallaxRow,
  fastShrink,
  parseSwordParallax,
  SwordDecodeError,
  type SwordParallax,
} from './swordDecode.js';
import { MASK_BLOCK_BYTES, parseSwordGrid, SCRNGRID_X, SCRNGRID_Y } from './swordMask.js';

export { SCRNGRID_X, SCRNGRID_Y, MASK_BLOCK_BYTES } from './swordMask.js';

/** A sprite waiting to be drawn: its id, and the y it sorts on. */
interface SortEntry {
  id: number;
  y: number;
}

/** A mouse-hittable object this cycle, in room coordinates. */
export interface SwordMouseTarget {
  readonly id: number;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly priority: number;
  readonly mouseOn: number;
  readonly mouseOff: number;
  readonly mouseClick: number;
}

/** What a text sprite looks like to the renderer: bytes plus a size. */
export interface SwordTextSprite {
  readonly width: number;
  readonly height: number;
  /** Already-decoded pixels; zero is transparent. */
  readonly pixels: Uint8Array;
}

export class SwordScreen {
  /** The room-sized draw buffer, in the room's own coordinates. */
  private buffer = new Uint8Array(SWORD1_SCREEN_WIDTH * SWORD1_SCREEN_DEPTH);
  private roomWidth = SWORD1_SCREEN_WIDTH;
  private roomHeight = SWORD1_SCREEN_DEPTH;
  private gridWidth = 0;
  private gridHeight = 0;

  private room: Sword1RoomDef | null = null;
  private currentScreen = -1;

  /** Mask layer block data, one per mask layer (layers 1..3). */
  private maskBlocks: (Uint8Array | null)[] = [];
  /** Mask grids, one per mask layer. 16-bit block indexes, one-based. */
  private maskGrids: (Uint16Array | null)[] = [];
  private parallax: { header: SwordParallax; bytes: Uint8Array }[] = [];

  readonly palette = new Palette();

  private foreList: number[] = [];
  private sortList: SortEntry[] = [];
  private backList: number[] = [];
  private mouseList: SwordMouseTarget[] = [];

  /** Scroll offsets in room pixels, clamped to the room's size. */
  scrollX = 0;
  scrollY = 0;

  /** A one-frame flash colour, or null. `fnRedFlash` and friends. */
  private flashColour: number | null = null;

  /** Text sprites the text manager owns, by text compact id. */
  private readonly textSprites = new Map<number, SwordTextSprite>();

  /** Notes worth putting on the status line. */
  readonly warnings: string[] = [];

  constructor(
    private readonly resources: SwordResources,
    private readonly objects: SwordObjects,
  ) {}

  /** Which screen is being drawn. -1 before the first `newScreen`. */
  get screen(): number {
    return this.currentScreen;
  }

  get size(): { width: number; height: number } {
    return { width: this.roomWidth, height: this.roomHeight };
  }

  /** The resource ids this screen needs, so the engine can make them resident. */
  static resourcesFor(screen: number): number[] {
    const room = SWORD1_ROOMS[screen];
    if (!room) return [];
    const ids: number[] = [];
    for (let layer = 0; layer < room.totalLayers; layer++) {
      if (room.layers[layer]) ids.push(room.layers[layer]);
    }
    for (let grid = 0; grid < Math.max(0, room.totalLayers - 1); grid++) {
      if (room.grids[grid]) ids.push(room.grids[grid]);
    }
    for (const palette of room.palettes) if (palette) ids.push(palette);
    for (const layer of room.parallax) if (layer) ids.push(layer);
    return ids;
  }

  /**
   * Enters a screen: sizes the buffer, loads its layers, grids and parallax.
   *
   * Everything it cannot find is recorded and skipped. A room with no
   * background still runs its scripts — which is what makes a CD1-only install
   * of a CD2 room say so on the status line rather than crash.
   */
  newScreen(screen: number): void {
    this.currentScreen = screen;
    const room = SWORD1_ROOMS[screen];
    this.room = room ?? null;
    this.maskBlocks = [];
    this.maskGrids = [];
    this.parallax = [];
    this.scrollX = 0;
    this.scrollY = 0;

    if (!room || room.sizeX === 0 || room.sizeY === 0) {
      this.roomWidth = SWORD1_SCREEN_WIDTH;
      this.roomHeight = SWORD1_SCREEN_DEPTH;
      this.buffer = new Uint8Array(this.roomWidth * this.roomHeight);
      this.gridWidth = 0;
      this.gridHeight = 0;
      if (screen !== 0) {
        this.note(`screen ${screen} has no room definition, so nothing is drawn behind it`);
      }
      return;
    }

    this.roomWidth = room.sizeX;
    this.roomHeight = room.sizeY;
    this.buffer = new Uint8Array(this.roomWidth * this.roomHeight);
    this.gridWidth = Math.floor(this.roomWidth / SCRNGRID_X);
    this.gridHeight = Math.floor(this.roomHeight / SCRNGRID_Y);

    // The background, layer 0. Drawn here so a `present` before the first
    // `draw` shows the room rather than black; `draw` lays it again every
    // frame, which is what keeps sprites from accumulating.
    if (!this.restoreBackground() && room.layers[0]) {
      this.note(
        `screen ${screen}'s background ${formatResourceId(room.layers[0])}: ` +
          this.resources.describeMissingResource(room.layers[0]),
      );
    }

    for (let layer = 1; layer < room.totalLayers; layer++) {
      const id = room.layers[layer];
      const resource = id ? this.resources.fetch(id) : null;
      // The mask layers *are* past their header, which is the asymmetry above.
      this.maskBlocks.push(resource ? resource.payload : null);
      if (id && !resource) {
        this.note(
          `screen ${screen}'s mask layer ${layer}: ${this.resources.describeMissingResource(id)}`,
        );
      }
    }

    for (let grid = 0; grid < room.totalLayers - 1; grid++) {
      const id = room.grids[grid];
      const resource = id ? this.resources.fetch(id) : null;
      if (!resource) {
        this.maskGrids.push(null);
        if (id) {
          this.note(
            `screen ${screen}'s mask grid ${grid}: ${this.resources.describeMissingResource(id)}`,
          );
        }
        continue;
      }
      // ScummVM steps the *resource* pointer on: `_layerGrid[cnt] += 14` on a
      // `uint16 *` that `openFetchRes` returned pointing at byte 0 of the
      // resource, so the cells start 28 bytes into it and the
      // 20-byte `Header` is part of that 28 — not before it. (Mask layers, one
      // loop up, step by `sizeof(Header)` separately, which is why the two are
      // not the same number.) Measured on the demo: at 28 every grid is exactly
      // `pitch` x 82 cells, 82 being `sizeY / 8 + 32`; at 48 it is 81.85 rows,
      // which is not a map of anything.
      const pitch = this.gridWidth + 2 * (SWORD1_SCREEN_LEFT_EDGE / SCRNGRID_X);
      this.maskGrids.push(parseSwordGrid(resource.bytes, pitch, this.resources.bigEndian).cells);
    }

    for (const id of room.parallax) {
      if (!id) continue;
      const resource = this.resources.fetch(id);
      if (!resource) {
        this.note(`screen ${screen}'s parallax: ${this.resources.describeMissingResource(id)}`);
        continue;
      }
      try {
        this.parallax.push({
          header: parseSwordParallax(resource.bytes, this.resources.bigEndian),
          bytes: resource.bytes,
        });
      } catch (error) {
        this.note(
          `screen ${screen}'s parallax ${formatResourceId(id)} would not parse: ` +
            (error instanceof SwordDecodeError ? error.message : String(error)),
        );
      }
    }

    // Both palettes: the background half (0..183) and the sprite half
    // (184..255). A room that ships only one leaves the other as it was, which
    // is what the game relies on for the shared sprite palette.
    for (const [at, id] of room.palettes.entries()) {
      if (!id) continue;
      this.setPalette(at === 0 ? 0 : 184, at === 0 ? 184 : 72, id);
    }
  }

  /** Room size relative to the display, which is what `SCROLL_FLAG` reports. */
  scrollLimits(): { flag: number; maxX: number; maxY: number } {
    if (this.roomWidth > SWORD1_SCREEN_WIDTH || this.roomHeight > SWORD1_SCREEN_DEPTH) {
      return {
        flag: 2,
        maxX: this.roomWidth - SWORD1_SCREEN_WIDTH,
        maxY: this.roomHeight - SWORD1_SCREEN_DEPTH,
      };
    }
    return { flag: 0, maxX: 0, maxY: 0 };
  }

  /** Sets the scroll, clamped. Called with the player's offset from its anchor. */
  setScrolling(offsetX: number, offsetY: number): void {
    const limits = this.scrollLimits();
    this.scrollX = Math.max(0, Math.min(offsetX, limits.maxX));
    this.scrollY = Math.max(0, Math.min(offsetY, limits.maxY));
  }

  addToGraphicList(list: 0 | 1 | 2, id: number): void {
    if (list === 0) this.foreList.push(id);
    else if (list === 2) this.backList.push(id);
    else {
      const compact = this.objects.fetch(id);
      this.sortList.push({ id, y: compact ? compact.y : 0 });
    }
  }

  addToMouseList(id: number, compact: SwordCompact): void {
    this.mouseList.push({
      id,
      x1: compact.get(CPT.MOUSE_X1),
      y1: compact.get(CPT.MOUSE_Y1),
      x2: compact.get(CPT.MOUSE_X2),
      y2: compact.get(CPT.MOUSE_Y2),
      priority: compact.get(CPT.PRIORITY),
      mouseOn: compact.get(CPT.MOUSE_ON),
      mouseOff: compact.get(CPT.MOUSE_OFF),
      mouseClick: compact.get(CPT.MOUSE_CLICK),
    });
  }

  /** This cycle's hit list, highest priority first. Cleared by `draw`. */
  hitTargets(): readonly SwordMouseTarget[] {
    return [...this.mouseList].sort((left, right) => right.priority - left.priority);
  }

  /** Registers a text sprite so a text compact can be drawn. */
  setTextSprite(textCompactId: number, sprite: SwordTextSprite | null): void {
    if (sprite) this.textSprites.set(textCompactId, sprite);
    else this.textSprites.delete(textCompactId);
  }

  textSpriteSize(textCompactId: number): { width: number; height: number } | null {
    const sprite = this.textSprites.get(textCompactId);
    return sprite ? { width: sprite.width, height: sprite.height } : null;
  }

  flash(colour: number): void {
    this.flashColour = colour;
  }

  /**
   * Loads a palette range from a resource, widening its six bits to eight.
   *
   * `<< 2` and not `* 255 / 63`: the original shifts, so colour 63 becomes 252
   * rather than 255, and every shipped screen was authored against that. The
   * "more correct" scaling makes every bright area visibly lighter.
   *
   * Colour 0 is forced black when the range starts at 0, which the original
   * also does — a background palette whose first entry is not black shows as a
   * tinted transparency everywhere a sprite has a hole.
   */
  setPalette(start: number, length: number, resourceId: number): void {
    const resource = this.resources.fetch(resourceId);
    if (!resource) {
      this.note(
        `palette ${formatResourceId(resourceId)}: ` +
          this.resources.describeMissingResource(resourceId),
      );
      return;
    }
    const data = resource.bytes;
    for (let at = 0; at < length; at++) {
      const index = start + at;
      if (index > 255) break;
      const from = at * 3;
      if (from + 2 >= data.length) break;
      const forceBlack = start === 0 && at === 0;
      this.palette.setColor(
        index,
        forceBlack ? 0 : data[from] << 2,
        forceBlack ? 0 : data[from + 1] << 2,
        forceBlack ? 0 : data[from + 2] << 2,
      );
    }
  }

  /** Draws the whole room: background, sprites, parallax, masks. */
  draw(): void {
    // Screen 54 has a *background* parallax rather than a foreground one, so it
    // is drawn before the background and the background is composited over it
    // with zero as transparent. One room, and it is the only room-number test
    // in this file — Revolution special-cased it and there is no data-side flag
    // that says so.
    if (this.currentScreen === 54) {
      if (this.parallax.length > 0) this.renderParallax(this.parallax[0]);
      this.compositeBackgroundTransparently();
    } else {
      this.restoreBackground();
    }

    for (const id of this.backList) this.processImage(id);

    // Stable sort by y: a sprite lower on the screen is in front. The original
    // bubble-sorts, which is stable, so equal-y sprites keep the order the
    // logic walk added them in — and that order is section then object index,
    // which is deterministic.
    this.sortList.sort((left, right) => left.y - right.y);
    for (const entry of this.sortList) this.processImage(entry.id);

    for (const [at, layer] of this.parallax.entries()) {
      // Screen 54's first parallax was already drawn, underneath.
      if (this.currentScreen === 54 && at === 0) continue;
      this.renderParallax(layer);
    }

    for (const id of this.foreList) this.processImage(id);

    this.foreList = [];
    this.sortList = [];
    this.backList = [];
  }

  /** Clears the hit list. Separate from `draw` so input can read it after. */
  clearMouseList(): void {
    this.mouseList = [];
  }

  /**
   * Lays the background down, which every frame starts by doing.
   *
   * `Screen::draw` opens with `memcpy(_screenBuf, _layerBlocks[0], ...)`, and
   * the copy is per *frame* rather than per room: the draw buffer is scratch,
   * not a canvas that accumulates. Doing it once on entry instead leaves every
   * sprite ever drawn on the screen — measured on the demo, 2,500 frames of
   * George walking and subtitles appearing buried two thirds of the Paris café
   * under smears, and left the subtitle unreadable underneath them.
   *
   * The bytes *are* the room's pixels: no header skip, because ScummVM keeps
   * `_layerBlocks[0]` pointing at the resource start and only advances the mask
   * layers past their headers. Answers whether it found the background.
   */
  private restoreBackground(): boolean {
    const id = this.room?.layers[0] ?? 0;
    const background = id ? this.resources.fetch(id) : null;
    if (!background) return false;
    this.buffer.set(background.bytes.subarray(0, this.buffer.length));
    return true;
  }

  /**
   * The background composited with zero as transparent, for screen 54.
   *
   * A plain copy would hide the parallax already underneath it; this is the
   * per-pixel test the original does for exactly this room.
   */
  private compositeBackgroundTransparently(): void {
    const id = this.room?.layers[0] ?? 0;
    const background = id ? this.resources.fetch(id) : null;
    if (!background) return;
    const src = background.bytes;
    const count = Math.min(this.buffer.length, src.length);
    for (let at = 0; at < count; at++) {
      const pixel = src[at];
      if (pixel) this.buffer[at] = pixel;
    }
  }

  /** Draws one object's current frame, then masks it. */
  private processImage(id: number): void {
    const compact = this.objects.fetch(id);
    if (!compact) return;

    let pixels: Uint8Array;
    let width: number;
    let height: number;
    let offsetX = 0;
    let offsetY = 0;

    if (compact.type === SwordType.TEXT) {
      const sprite = this.textSprites.get(compact.get(CPT.TARGET));
      if (!sprite) return;
      pixels = sprite.pixels;
      width = sprite.width;
      height = sprite.height;
    } else {
      const frame = this.frame(compact.resource, compact.frame);
      if (!frame) return;
      pixels = frame.pixels;
      width = frame.width;
      height = frame.height;
      offsetX = frame.offsetX;
      offsetY = frame.offsetY;
    }

    let spriteX = compact.get(CPT.ANIM_X);
    let spriteY = compact.get(CPT.ANIM_Y);
    let scale = 256;

    if (compact.status & SwordStatus.SHRINK) {
      scale = Math.trunc((compact.get(CPT.SCALE_A) * compact.y + compact.get(CPT.SCALE_B)) / 256);
      spriteX += Math.trunc((offsetX * scale) / 256);
      spriteY += Math.trunc((offsetY * scale) / 256);
    } else {
      spriteX += offsetX;
      spriteY += offsetY;
    }

    let drawWidth = width;
    let drawHeight = height;
    if (compact.status & SwordStatus.SHRINK && scale !== 256 && scale > 0) {
      const shrunk = new Uint8Array(Math.max(1, width * height));
      const size = fastShrink(pixels, width, height, scale, shrunk);
      pixels = shrunk;
      drawWidth = size.width;
      drawHeight = size.height;
    }

    // The mouse box follows the drawn sprite unless the script overrode it. A
    // sprite with frame offsets is a boxed mega, whose box is narrowed to the
    // middle half and the top nine tenths — because the frame is bigger than
    // the character inside it.
    if (!(compact.status & SwordStatus.OVERRIDE)) {
      if (offsetX || offsetY) {
        compact.set(CPT.MOUSE_X1, spriteX + Math.trunc(drawWidth / 4));
        compact.set(CPT.MOUSE_X2, spriteX + Math.trunc((3 * drawWidth) / 4));
        compact.set(CPT.MOUSE_Y1, spriteY + Math.trunc(drawHeight / 10));
        compact.set(CPT.MOUSE_Y2, spriteY + Math.trunc((9 * drawHeight) / 10));
      } else {
        compact.set(CPT.MOUSE_X1, spriteX);
        compact.set(CPT.MOUSE_X2, spriteX + drawWidth);
        compact.set(CPT.MOUSE_Y1, spriteY);
        compact.set(CPT.MOUSE_Y2, spriteY + drawHeight);
      }
    }

    // Into room coordinates: the game's space is offset by 128 in both axes.
    const roomX = spriteX - SWORD1_SCREEN_LEFT_EDGE;
    const roomY = spriteY - SWORD1_SCREEN_TOP_EDGE;
    const drawn = this.blitSprite(pixels, roomX, roomY, drawWidth, drawHeight);
    if (!drawn) return;

    // A foreground sprite is in front of the masks by definition, so it is not
    // masked. Everything else is.
    if (!(compact.status & SwordStatus.FORE)) {
      this.verticalMask(drawn.x, drawn.y, drawn.width, drawn.height);
    }
  }

  /** Decodes one frame of a sprite resource, with its offsets. */
  private frame(
    resourceId: number,
    frameNo: number,
  ): {
    pixels: Uint8Array;
    width: number;
    height: number;
    offsetX: number;
    offsetY: number;
  } | null {
    if (!resourceId) return null;
    const resource = this.resources.fetch(resourceId);
    if (!resource) return null;
    const big = this.resources.bigEndian;
    const bytes = resource.bytes;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < 28) return null;

    const frames = view.getUint32(20, !big);
    if (frameNo < 0 || frameNo >= frames) return null;
    const at = view.getUint32(20 + (frameNo + 1) * 4, !big);
    if (at + 16 > bytes.length) return null;

    const tag = new TextDecoder('latin1').decode(bytes.subarray(at, at + 4));
    const compSize = view.getUint32(at + 4, !big);
    const width = view.getUint16(at + 8, !big);
    const height = view.getUint16(at + 10, !big);
    const offsetX = view.getInt16(at + 12, !big);
    const offsetY = view.getInt16(at + 14, !big);
    if (width === 0 || height === 0 || width > 4096 || height > 4096) return null;

    try {
      const pixels = decodeSwordFrame(
        bytes.subarray(at + 16),
        compressionOf(tag),
        compSize,
        width,
        height,
      );
      return { pixels, width, height, offsetX, offsetY };
    } catch (error) {
      this.note(
        `frame ${frameNo} of ${formatResourceId(resourceId)} would not decode: ` +
          (error instanceof Error ? error.message : String(error)),
      );
      return null;
    }
  }

  /**
   * Clips and blits a sprite into the room buffer. Zero is transparent.
   *
   * Returns the clipped rectangle, which the mask then works on — masking the
   * *unclipped* rectangle is how a sprite half off the left edge picks up mask
   * blocks from the right of the room.
   */
  private blitSprite(
    pixels: Uint8Array,
    x: number,
    y: number,
    width: number,
    height: number,
  ): { x: number; y: number; width: number; height: number } | null {
    let sprX = x;
    let sprY = y;
    let sprW = width;
    let sprH = height;
    let skip = 0;

    if (sprY < 0) {
      skip = -sprY * sprW;
      sprH += sprY;
      sprY = 0;
    }
    if (sprX < 0) {
      skip -= sprX;
      sprW += sprX;
      sprX = 0;
    }
    if (sprY + sprH > this.roomHeight) sprH = this.roomHeight - sprY;
    if (sprX + sprW > this.roomWidth) sprW = this.roomWidth - sprX;
    if (sprW <= 0 || sprH <= 0) return null;

    for (let row = 0; row < sprH; row++) {
      const from = skip + row * width;
      const to = (sprY + row) * this.roomWidth + sprX;
      for (let column = 0; column < sprW; column++) {
        const pixel = pixels[from + column];
        if (pixel) this.buffer[to + column] = pixel;
      }
    }
    return { x: sprX, y: sprY, width: sprW, height: sprH };
  }

  /**
   * Stamps mask blocks back over a drawn sprite, bottom row first.
   *
   * Bottom-up and stopping at the first empty block in a column is the
   * original's early-out, and it is not just a speed trick: a mask column is
   * contiguous from the floor upwards, so an empty block means "nothing above
   * this masks here either".
   *
   * All the mask levels are checked, not just the nearest — ScummVM's fix for
   * its bug #1536, where a sprite standing where two masks overlap was only
   * masked by one of them.
   */
  private verticalMask(x: number, y: number, width: number, height: number): void {
    const room = this.room;
    if (!room || room.totalLayers <= 1 || this.gridWidth === 0) return;

    let blockWidth = Math.floor((width + (x & (SCRNGRID_X - 1)) + (SCRNGRID_X - 1)) / SCRNGRID_X);
    let blockHeight = Math.floor((height + (y & (SCRNGRID_Y - 1)) + (SCRNGRID_Y - 1)) / SCRNGRID_Y);
    const blockX = Math.floor(x / SCRNGRID_X);
    const blockY = Math.floor(y / SCRNGRID_Y);
    if (blockX + blockWidth > this.gridWidth) blockWidth = this.gridWidth - blockX;
    if (blockY + blockHeight > this.gridHeight) blockHeight = this.gridHeight - blockY;
    if (blockWidth <= 0 || blockHeight <= 0) return;

    // The imaginary screen: the grid is 128 pixels wider on each side, so an
    // index into it is offset by eight blocks across and sixteen down.
    const gridY = blockY + SWORD1_SCREEN_TOP_EDGE / SCRNGRID_Y + blockHeight - 1;
    const gridX = blockX + SWORD1_SCREEN_LEFT_EDGE / SCRNGRID_X;
    const gridPitch = this.gridWidth + 2 * (SWORD1_SCREEN_LEFT_EDGE / SCRNGRID_X);

    for (let column = 0; column < blockWidth; column++) {
      for (let level = room.totalLayers - 2; level >= 0; level--) {
        const grid = this.maskGrids[level];
        const blocks = this.maskBlocks[level];
        if (!grid || !blocks) continue;
        let at = gridX + column + gridY * gridPitch;
        if (at < 0 || at >= grid.length || grid[at] === 0) continue;
        for (let row = blockHeight - 1; row >= 0; row--) {
          if (at < 0 || at >= grid.length) break;
          const block = grid[at];
          if (block === 0) break;
          this.blitMaskBlock(blockX + column, blockY + row, blocks, (block - 1) * MASK_BLOCK_BYTES);
          at -= gridPitch;
        }
      }
    }
  }

  private blitMaskBlock(blockX: number, blockY: number, blocks: Uint8Array, from: number): void {
    if (from < 0 || from + MASK_BLOCK_BYTES > blocks.length) return;
    const baseX = blockX * SCRNGRID_X;
    const baseY = blockY * SCRNGRID_Y;
    for (let row = 0; row < SCRNGRID_Y; row++) {
      const y = baseY + row;
      if (y < 0 || y >= this.roomHeight) continue;
      const to = y * this.roomWidth + baseX;
      const src = from + row * SCRNGRID_X;
      for (let column = 0; column < SCRNGRID_X; column++) {
        const x = baseX + column;
        if (x < 0 || x >= this.roomWidth) continue;
        const pixel = blocks[src + column];
        if (pixel) this.buffer[to + column] = pixel;
      }
    }
  }

  /**
   * Draws a parallax layer, scrolled at its own rate.
   *
   * The rate is derived rather than authored: a layer wider than the room
   * scrolls proportionally less, so `(paraSize - screen) / (roomSize - screen)`
   * is the factor. A layer exactly screen-sized does not scroll at all, which
   * is why the divisor is guarded rather than assumed non-zero.
   */
  private renderParallax(layer: { header: SwordParallax; bytes: Uint8Array }): void {
    const { header, bytes } = layer;
    let paraScrollX = 0;
    let paraScrollY = 0;
    if (this.roomWidth !== SWORD1_SCREEN_WIDTH) {
      paraScrollX = Math.trunc(
        (this.scrollX * (header.width - SWORD1_SCREEN_WIDTH)) /
          (this.roomWidth - SWORD1_SCREEN_WIDTH),
      );
    }
    if (this.roomHeight !== SWORD1_SCREEN_DEPTH) {
      paraScrollY = Math.trunc(
        (this.scrollY * (header.height - SWORD1_SCREEN_DEPTH)) /
          (this.roomHeight - SWORD1_SCREEN_DEPTH),
      );
    }

    for (let row = 0; row < SWORD1_SCREEN_DEPTH; row++) {
      const sourceRow = row + paraScrollY;
      if (sourceRow < 0 || sourceRow >= header.height) continue;
      const strip = decodeSwordParallaxRow(bytes, header, sourceRow);
      if (!strip) continue;
      const destY = row + this.scrollY;
      if (destY < 0 || destY >= this.roomHeight) continue;
      const to = destY * this.roomWidth + this.scrollX;
      for (let column = 0; column < SWORD1_SCREEN_WIDTH; column++) {
        const pixel = strip[column + paraScrollX];
        if (pixel && this.scrollX + column < this.roomWidth) {
          this.buffer[to + column] = pixel;
        }
      }
    }
  }

  /**
   * Copies the visible window into a display-sized framebuffer.
   *
   * 640x480 with 40-pixel bars top and bottom, which is where the game's menus
   * live: the game area is rows 40..439. The bars are cleared rather than left,
   * because a menu that is not drawn should be black rather than stale.
   */
  present(out: Uint8Array): void {
    out.fill(0);
    const top = SWORD1_MENU_BAR_HEIGHT;
    for (let row = 0; row < SWORD1_SCREEN_DEPTH; row++) {
      const sourceRow = row + this.scrollY;
      if (sourceRow < 0 || sourceRow >= this.roomHeight) continue;
      const from = sourceRow * this.roomWidth + this.scrollX;
      const width = Math.min(SWORD1_SCREEN_WIDTH, this.roomWidth - this.scrollX);
      if (width <= 0) continue;
      out.set(this.buffer.subarray(from, from + width), (top + row) * SWORD1_SCREEN_WIDTH);
    }

    if (this.flashColour !== null) {
      // A border flash: the bars, in the flash colour's palette slot. The
      // original flashes the whole screen for red and blue and only the border
      // for the four colours; both are one frame, and one frame is what this is.
      const colour = this.flashColour === 0 ? 1 : this.flashColour;
      const barBytes = SWORD1_MENU_BAR_HEIGHT * SWORD1_SCREEN_WIDTH;
      out.fill(colour, 0, barBytes);
      out.fill(colour, SWORD1_SCREEN_WIDTH * (SWORD1_SCREEN_FULL_DEPTH - SWORD1_MENU_BAR_HEIGHT));
      this.flashColour = null;
    }
  }

  private note(message: string): void {
    if (this.warnings.length < 40 && !this.warnings.includes(message)) {
      this.warnings.push(message);
    }
  }
}
