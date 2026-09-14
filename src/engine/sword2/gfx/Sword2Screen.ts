/**
 * Broken Sword II's renderer: one screen resource holding nine things.
 *
 * ## A screen file is a container, not a background
 *
 * Where Sword1 has a room table naming separate layer resources, Sword2 packs a
 * whole room into **one** `SCREEN_FILE` resource and describes it with a
 * `MultiScreenHeader` of offsets: two background parallax layers, the
 * background, two foreground parallax layers, the layer (mask) table, the
 * palette, a 64 KB palette match table, and the mask data.
 *
 * So entering a room here is reading one resource and following eight offsets,
 * and the room's size comes from the resource rather than from a table this
 * project carries. That is a genuinely better format and it is the reason this
 * family needs no equivalent of `swordRooms.ts`.
 *
 * ## Drawing order
 *
 * Background parallax 0 and 1, the background, then the sprite lists —
 * background, sorted by y, foreground — then the foreground parallax layers.
 * Masks are stamped after each sorted sprite from the layer table, the same
 * principle as Sword1's grid with a simpler index: a layer is a rectangle with
 * its own mask bitmap, so there is no block grid to walk.
 *
 * ## 640x480 with no inset
 *
 * Unlike Sword1, the whole display is the game area: Sword2's menus are drawn
 * *over* the picture rather than in bars beside it. So `script` and `display`
 * are the same pair, and the engine's `resolution` says so.
 */

import { Palette } from '../../gfx/Palette.js';
import {
  LAYER_HEADER_SIZE,
  RES_HEADER_SIZE,
  readSword2AnimHeader,
  readSword2CdtEntry,
  readSword2FrameHeader,
  readSword2LayerHeader,
  SCREEN_HEADER_SIZE,
  readSword2MultiScreenHeader,
  readSword2ScreenHeader,
  Sword2FrameType,
  Sword2SpriteType,
  type Sword2LayerHeader,
  type Sword2MultiScreenHeader,
  type Sword2ScreenHeader,
} from '../resource/sword2Headers.js';
import type { Sword2Resources } from '../resource/Sword2Resources.js';
import {
  decodeSword2Frame,
  decompressRLE256,
  parseSword2Parallax,
  type Sword2Parallax,
} from './sword2Decode.js';
import type { Sword2MouseFrame } from './sword2Mouse.js';
import type { Sword2TextSprite } from './Sword2Text.js';
import {
  SWORD2_BOTTOM_MENU_TOP,
  SWORD2_ICON_DEPTH,
  SWORD2_ICON_SPACING,
  SWORD2_ICON_START,
  SWORD2_ICON_WIDTH,
  SWORD2_MENU,
  SWORD2_TOP_MENU_TOP,
  type Sword2MenuBar,
} from '../Sword2Menu.js';

export const SWORD2_SCREEN_WIDTH = 640;
export const SWORD2_SCREEN_HEIGHT = 480;

/** One sprite to draw this cycle. */
export interface Sword2Sprite {
  readonly objectId: number;
  readonly type: number;
  readonly animResource: number;
  readonly animPc: number;
  /** Feet position, for a frame whose placement is offset-and-scaled. */
  readonly feetX: number;
  readonly feetY: number;
  readonly scale: number;
  readonly shaded: boolean;
}

/** One mouse-hittable area this cycle. */
export interface Sword2MouseTarget {
  readonly objectId: number;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly priority: number;
  readonly pointer: number;
  /**
   * The text line named for this target, or 0.
   *
   * `fnRegisterPointerText` runs *before* the registration it belongs to and
   * writes into the slot about to be filled (`mouse.cpp:203-211`), which is
   * why it is carried on the target rather than looked up from the object.
   */
  readonly pointerText: number;
}

/**
 * One text sprite waiting to be drawn, at **display** coordinates.
 *
 * A `TextBloc` (`maketext.h:66`). Text is the one thing this family draws that
 * is not in room coordinates: every bloc carries `RDSPR_DISPLAYALIGN`, and
 * `drawSprite` skips the scroll subtraction for those (`sprite.cpp:636,665`).
 * So a subtitle stays put while the room slides underneath it, which is what
 * `present` relies on to draw these after the window has been copied out.
 */
export interface Sword2TextBloc {
  x: number;
  y: number;
  sprite: Sword2TextSprite;
}

/**
 * Where the system keeps the player's feet on the display, before any script
 * moves it. `layers.cpp:144-145`.
 */
const SWORD2_DEFAULT_FEET_X = 320;
const SWORD2_DEFAULT_FEET_Y = 340;

/** The most the view moves in one cycle. `MAX_SCROLL_DISTANCE`, `scroll.cpp:35`. */
const SWORD2_MAX_SCROLL_DISTANCE = 8;

export class Sword2Screen {
  /** The room-sized draw buffer, in room coordinates. */
  private buffer = new Uint8Array(SWORD2_SCREEN_WIDTH * SWORD2_SCREEN_HEIGHT);
  private roomWidth = SWORD2_SCREEN_WIDTH;
  private roomHeight = SWORD2_SCREEN_HEIGHT;

  private screenResource = 0;
  private multi: Sword2MultiScreenHeader | null = null;
  private header: Sword2ScreenHeader | null = null;
  private layers: Sword2LayerHeader[] = [];
  private bgParallax: (Sword2Parallax | null)[] = [null, null];
  private fgParallax: (Sword2Parallax | null)[] = [null, null];
  /**
   * The room's own background layer, which is a parallax like any other.
   *
   * `renderParallax(_vm->fetchBackgroundLayer(file), 2)` (`screen.cpp:310`):
   * the background is layer 2 of five, at `multi.screen + ScreenHeader::size()`,
   * and is packed exactly as the four parallaxes around it. Copying those bytes
   * straight into the buffer instead — which is what this did — reads packet
   * counts and row offsets as pixels.
   */
  private background: Sword2Parallax | null = null;
  private screenBytes: Uint8Array | null = null;

  readonly palette = new Palette();

  scrollX = 0;
  scrollY = 0;

  /**
   * The camera. `ScreenInfo::scroll_flag`, `feet_x/feet_y`, `_scrollFraction`.
   *
   * Sword2 scrolls a room wider or taller than the display by chasing the
   * player: every cycle `Screen::setScrolling` works out where the scroll
   * *should* be to put the player's feet at `feet_x, feet_y` on the display,
   * and moves a fraction of the way there (`scroll.cpp:53-155`). Nothing here
   * did that, so the view stayed at 0,0 and the player walked off the right of
   * every wide room — the demo's first room is 864 pixels across on a 640-wide
   * display.
   */
  /** 0 off, 1 on, 2 "first time on this screen, jump rather than glide". */
  private scrollFlag = 0;
  /** Where on the display the system tries to keep the player's feet. */
  private feetX = SWORD2_DEFAULT_FEET_X;
  private feetY = SWORD2_DEFAULT_FEET_Y;
  private playerFeetX = 0;
  private playerFeetY = 0;
  /**
   * How much of the remaining distance is covered per cycle: 16 normal, 32
   * slow (`fnSetScrollSpeedNormal`/`Slow`). Larger is slower — it is a divisor.
   */
  private scrollFraction = 16;

  /** A screen asked for before its cluster arrived. See `initBackground`. */
  private pendingScreen: { resourceId: number; newPalette: boolean } | null = null;

  private sprites: Sword2Sprite[] = [];
  private mouseTargets: Sword2MouseTarget[] = [];
  /**
   * The text blocs, by handle.
   *
   * Sparse on purpose: a handle is an index plus one and stays valid until the
   * script kills it, so a freed slot is a hole rather than a splice. That is
   * `_blocList` (`maketext.cpp:920-930`), and it matters because `fnISpeak`
   * holds a handle across cycles while other lines come and go.
   */
  private textBlocs: (Sword2TextBloc | null)[] = [];

  /**
   * The two menu bars, as the logic's menu module last left them.
   *
   * Pushed in rather than pulled out because the renderer has no business
   * knowing about the script engine: the engine hands this over each frame,
   * the same way it hands over sprites.
   */
  private menuBars: readonly Sword2MenuBar[] = [];

  /**
   * The luggage hanging off the pointer this frame, or null.
   *
   * Pushed in per frame for the same reason the bars are: where the pointer is
   * and what it is dragging are the engine's, and the renderer only stamps it.
   */
  private luggage: { frame: Sword2MouseFrame; x: number; y: number } | null = null;

  readonly warnings: string[] = [];

  constructor(private readonly resources: Sword2Resources) {}

  get screen(): number {
    return this.screenResource;
  }

  get size(): { width: number; height: number } {
    return { width: this.roomWidth, height: this.roomHeight };
  }

  /**
   * `fnInitBackground`: reads a screen resource and sizes the room.
   *
   * Everything it cannot find is recorded and skipped: a room with no parallax
   * still draws, and a room whose resource is on the other disc says so rather
   * than showing black.
   */
  initBackground(resourceId: number, newPalette: boolean): void {
    this.screenResource = resourceId;
    this.multi = null;
    this.header = null;
    this.layers = [];
    this.bgParallax = [null, null];
    this.fgParallax = [null, null];
    this.screenBytes = null;
    this.scrollX = 0;
    this.scrollY = 0;

    const resource = this.resources.fetch(resourceId);
    if (!resource) {
      // Asked for before its cluster arrived, which is not the same as asked
      // for and absent. `fetch` has put the id on the wanted list, the engine
      // will load the cluster, and `draw` retries from `pendingScreen` — the
      // same shape `processSession` already uses for a run list it could not
      // read yet. Without the retry the screen is requested once, at boot,
      // and a room whose cluster was one frame late stays black for ever.
      //
      // And because the retry works, the first attempt is not worth a warning.
      // This noted one unconditionally, so the demo's boot left "screen 22 is
      // in Docks.clu, which is not resident yet" on the status line for a room
      // that was drawn a few frames later and stayed drawn. Only a screen that
      // will never arrive is noted.
      if (!this.resources.willBecomeResident(resourceId)) {
        this.note(`screen ${resourceId}: ${this.resources.describeMissingResource(resourceId)}`);
      }
      this.pendingScreen = { resourceId, newPalette };
      this.roomWidth = SWORD2_SCREEN_WIDTH;
      this.roomHeight = SWORD2_SCREEN_HEIGHT;
      this.buffer = new Uint8Array(this.roomWidth * this.roomHeight);
      this.resetCamera();
      return;
    }
    this.pendingScreen = null;

    this.screenBytes = resource.bytes;
    // Every offset in the multi-screen header is from the header's own start,
    // which is immediately after the resource header.
    const base = RES_HEADER_SIZE;
    this.multi = readSword2MultiScreenHeader(resource.bytes, base);
    this.header = readSword2ScreenHeader(resource.bytes, base + this.multi.screen);

    this.roomWidth = Math.max(SWORD2_SCREEN_WIDTH, this.header.width);
    this.roomHeight = Math.max(SWORD2_SCREEN_HEIGHT, this.header.height);
    this.buffer = new Uint8Array(this.roomWidth * this.roomHeight);
    this.resetCamera();

    for (let layer = 0; layer < this.header.noLayers; layer++) {
      const at = base + this.multi.layers + layer * LAYER_HEADER_SIZE;
      if (at + LAYER_HEADER_SIZE > resource.bytes.length) break;
      this.layers.push(readSword2LayerHeader(resource.bytes, at));
    }

    this.background = parseSword2Parallax(
      resource.bytes,
      base + this.multi.screen + SCREEN_HEADER_SIZE,
    );
    this.bgParallax = this.multi.bgParallax.map((offset) =>
      offset ? parseSword2Parallax(resource.bytes, base + offset) : null,
    ) as (Sword2Parallax | null)[];
    this.fgParallax = this.multi.fgParallax.map((offset) =>
      offset ? parseSword2Parallax(resource.bytes, base + offset) : null,
    ) as (Sword2Parallax | null)[];

    if (newPalette && this.multi.palette)
      this.loadPalette(resource.bytes, base + this.multi.palette);
  }

  /** `fnSetPalette`: a separate palette resource replaces the screen's. */
  setPalette(resourceId: number): void {
    if (resourceId === 0) return;
    const resource = this.resources.fetch(resourceId);
    if (!resource) {
      this.note(`palette ${resourceId}: ${this.resources.describeMissingResource(resourceId)}`);
      return;
    }
    this.loadPalette(resource.bytes, RES_HEADER_SIZE);
  }

  /**
   * Loads 256 RGBA quads.
   *
   * Four bytes per entry, not three — a screen's palette carries an unused
   * fourth byte per colour. Reading it as three-byte triples shifts every
   * colour after the first and produces a picture that is recognisable and
   * wrong, which is the worst kind of palette bug.
   *
   * Colour 0 is forced black, as the original does: a background palette whose
   * first entry is not black shows as a tint wherever a sprite has a hole.
   */
  private loadPalette(bytes: Uint8Array, at: number): void {
    for (let index = 0; index < 256; index++) {
      const from = at + index * 4;
      if (from + 2 >= bytes.length) break;
      if (index === 0) {
        this.palette.setColor(0, 0, 0, 0);
        continue;
      }
      this.palette.setColor(index, bytes[from], bytes[from + 1], bytes[from + 2]);
    }
  }

  /** Registers a sprite for this cycle. Cleared by `draw`. */
  addSprite(sprite: Sword2Sprite): void {
    if (sprite.type === Sword2SpriteType.NO_SPRITE) return;
    this.sprites.push(sprite);
  }

  addMouseTarget(target: Sword2MouseTarget): void {
    this.mouseTargets.push(target);
  }

  /**
   * This cycle's hit list, highest priority first — which is the *smallest*
   * `priority`, not the largest.
   *
   * Broken Sword II counts priority the way a race counts places.
   * `Mouse::checkMouseList` scans `for (priority = 0; priority < 10;
   * priority++)` and returns the first registered rectangle at that priority
   * containing the pointer (`mouse.cpp:1146-1157`), and `fnInitFloorMouse`
   * gives the floor `priority = 9` under the comment "floor is always lowest
   * priority" (`function.cpp:504-512`).
   *
   * Sorted the other way — which is what this did — the floor came back first,
   * and the floor is a rectangle over the whole room. Every caller here takes
   * the first target that contains the pointer, so every click in the game was
   * answered by the floor and nothing standing on it could be touched. The
   * symptom was not an error anywhere: objects simply never responded.
   *
   * The sort is stable, so targets of equal priority stay in the order they
   * asked for the mouse in — which is `checkMouseList`'s inner loop exactly.
   */
  hitTargets(): readonly Sword2MouseTarget[] {
    return [...this.mouseTargets].sort((left, right) => left.priority - right.priority);
  }

  clearMouseList(): void {
    this.mouseTargets = [];
  }

  setScroll(x: number, y: number): void {
    this.scrollX = Math.max(0, Math.min(x, this.maxScrollX));
    this.scrollY = Math.max(0, Math.min(y, this.maxScrollY));
  }

  /** The furthest left the view can go before it runs off the room. */
  get maxScrollX(): number {
    return Math.max(0, this.roomWidth - SWORD2_SCREEN_WIDTH);
  }

  /**
   * And the furthest down.
   *
   * ScummVM subtracts the two 40-pixel menu bars here (`layers.cpp:135`)
   * because its game area is 640x400 inside a 640x480 display. This project
   * draws the whole 480 and overlays the menus, so the room may scroll the
   * full height difference — which is the same view of the room, reached with
   * a different number.
   */
  get maxScrollY(): number {
    return Math.max(0, this.roomHeight - SWORD2_SCREEN_HEIGHT);
  }

  /**
   * `fnSetScrollCoordinate`: where on the display to keep the player's feet.
   *
   * Not the scroll offset — that is what this project used to do with it, and
   * it pinned the view to whatever the script last asked for rather than
   * letting the camera chase the player (`function.cpp:1770-1785`).
   */
  setScrollTarget(x: number, y: number): void {
    this.feetX = x;
    this.feetY = y;
  }

  /** `fnUpdatePlayerStats`: where the player actually is, in room pixels. */
  setPlayerFeet(x: number, y: number): void {
    this.playerFeetX = x;
    this.playerFeetY = y;
  }

  /** 16 for `fnSetScrollSpeedNormal`, 32 for `fnSetScrollSpeedSlow`. */
  setScrollFraction(fraction: number): void {
    this.scrollFraction = fraction;
  }

  private resetCamera(): void {
    this.feetX = SWORD2_DEFAULT_FEET_X;
    this.feetY = SWORD2_DEFAULT_FEET_Y;
    // "2 means first time on screen" (`layers.cpp:124`): the first update
    // jumps the view instead of gliding to it, so a room does not open with
    // the camera sliding in from the corner.
    this.scrollFlag = this.maxScrollX > 0 || this.maxScrollY > 0 ? 2 : 0;
  }

  /**
   * Moves the view one cycle's worth towards the player. `setScrolling`.
   *
   * `forcedX`/`forcedY` are the `SCROLL_X`/`SCROLL_Y` script globals: when
   * either is set the script is driving and the camera does not
   * (`scroll.cpp:60-70`). A room that fits the display does not scroll at all,
   * which is what `scroll_flag == 0` means.
   */
  updateScroll(forcedX = 0, forcedY = 0): void {
    if (this.scrollFlag === 0) return;

    if (forcedX || forcedY) {
      this.setScroll(forcedX, forcedY);
      return;
    }

    const wantX = Math.max(0, Math.min(this.playerFeetX - this.feetX, this.maxScrollX));
    const wantY = Math.max(0, Math.min(this.playerFeetY - this.feetY, this.maxScrollY));

    if (this.scrollFlag === 2) {
      this.scrollX = wantX;
      this.scrollY = wantY;
      this.scrollFlag = 1;
      return;
    }

    this.scrollX += this.step(this.scrollX - wantX);
    this.scrollY += this.step(this.scrollY - wantY);
  }

  /**
   * How far to move when the view is `gap` pixels past where it should be.
   *
   * The 1 is ScummVM's: "I'm adding 1 to the result of dx / SCROLL_FRACTION,
   * because it would otherwise not scroll at all when dx < SCROLL_FRACTION"
   * (`scroll.cpp:110-113`).
   */
  private step(gap: number): number {
    if (gap === 0) return 0;
    const distance = Math.min(
      1 + Math.trunc(Math.abs(gap) / this.scrollFraction),
      SWORD2_MAX_SCROLL_DISTANCE,
    );
    return gap < 0 ? distance : -distance;
  }

  /** Draws the room: parallax, background, sprites, masks, parallax again. */
  draw(): void {
    // A screen whose cluster was not resident when the script asked for it.
    // Retried here rather than in the engine, because this is the object that
    // knows what it is missing, and `note` de-duplicates so a room that never
    // arrives says so once.
    if (this.pendingScreen) {
      const { resourceId, newPalette } = this.pendingScreen;
      this.initBackground(resourceId, newPalette);
    }

    this.buffer.fill(0);

    // The order `Screen::buildDisplay` draws in (`screen.cpp:295-330`): the two
    // background parallaxes, then the background layer, then the sprites, then
    // the two foreground parallaxes. All five are the same format.
    for (const layer of this.bgParallax) this.renderParallax(layer);
    this.renderParallax(this.background);

    const inList = (type: number, wanted: number): boolean => (type & 0xffff) === wanted;

    for (const sprite of this.sprites) {
      if (inList(sprite.type, Sword2SpriteType.BACK_SPRITE)) this.drawSprite(sprite);
    }

    const sorted = this.sprites
      .filter((sprite) => inList(sprite.type, Sword2SpriteType.SORT_SPRITE))
      .sort((left, right) => left.feetY - right.feetY);
    for (const sprite of sorted) {
      this.drawSprite(sprite);
      this.applyMasks(sprite);
    }

    for (const layer of this.fgParallax) this.renderParallax(layer);

    for (const sprite of this.sprites) {
      if (inList(sprite.type, Sword2SpriteType.FORE_SPRITE)) this.drawSprite(sprite);
    }

    this.sprites = [];
  }

  /**
   * Where a sprite's frame lands and how big it is once scaled.
   *
   * ScummVM's `BuildUnit`, which `Screen::registerFrame` fills in
   * (`screen.cpp:708-786`) and then hands to `Mouse::registerMouse` so that a
   * mega's hit rectangle is the shape it is actually drawn at. Returned rather
   * than drawn because the mouse list needs the rectangle a cycle before
   * anything is blitted, and computing it twice is how the two drift apart.
   */
  spriteBounds(
    sprite: Sword2Sprite,
  ): { x: number; y: number; width: number; height: number } | null {
    const placed = this.placeFrame(sprite);
    if (!placed) return null;
    return { x: placed.x, y: placed.y, width: placed.width, height: placed.height };
  }

  /** Decodes one frame and works out where it goes. */
  private placeFrame(sprite: Sword2Sprite): {
    x: number;
    y: number;
    width: number;
    height: number;
    pixels: Uint8Array;
    frameType: number;
  } | null {
    const frame = this.frame(sprite.animResource, sprite.animPc);
    if (!frame) return null;

    let x = frame.x;
    let y = frame.y;
    let width = frame.width;
    let height = frame.height;
    let pixels = frame.pixels;

    // `FRAME_OFFSET` means the placement is relative to the mega's feet and
    // scaled by its own scale. A renderer that ignores the bit draws every
    // walking animation at the top-left of the room.
    if (frame.frameType & Sword2FrameType.OFFSET) {
      const scale = sprite.scale > 0 ? sprite.scale : 256;
      x = sprite.feetX + Math.trunc((frame.x * scale) / 256);
      y = sprite.feetY + Math.trunc((frame.y * scale) / 256);
      if (scale !== 256) {
        const scaled = this.scaleFrame(pixels, width, height, scale);
        pixels = scaled.pixels;
        width = scaled.width;
        height = scaled.height;
      }
    }

    return { x, y, width, height, pixels, frameType: frame.frameType };
  }

  /** Decodes and blits one sprite's current frame. */
  private drawSprite(sprite: Sword2Sprite): void {
    const placed = this.placeFrame(sprite);
    if (!placed) return;
    const pixels =
      placed.frameType & Sword2FrameType.FLIPPED
        ? flipHorizontally(placed.pixels, placed.width, placed.height)
        : placed.pixels;
    this.blit(pixels, placed.x, placed.y, placed.width, placed.height);
  }

  /** Nearest-neighbour scale, as `Screen::scaleImageFast` does it. */
  private scaleFrame(
    pixels: Uint8Array,
    width: number,
    height: number,
    scale: number,
  ): { pixels: Uint8Array; width: number; height: number } {
    const outWidth = Math.max(1, Math.trunc((width * scale) / 256));
    const outHeight = Math.max(1, Math.trunc((height * scale) / 256));
    const out = new Uint8Array(outWidth * outHeight);
    for (let y = 0; y < outHeight; y++) {
      const sourceY = Math.trunc((y * 256) / scale);
      if (sourceY >= height) break;
      for (let x = 0; x < outWidth; x++) {
        const sourceX = Math.trunc((x * 256) / scale);
        if (sourceX >= width) break;
        out[y * outWidth + x] = pixels[sourceY * width + sourceX];
      }
    }
    return { pixels: out, width: outWidth, height: outHeight };
  }

  /** Reads and decodes one frame of an animation resource. */
  private frame(
    animResource: number,
    animPc: number,
  ): {
    pixels: Uint8Array;
    width: number;
    height: number;
    x: number;
    y: number;
    frameType: number;
  } | null {
    if (!animResource) return null;
    const resource = this.resources.fetch(animResource);
    if (!resource) return null;
    const bytes = resource.bytes;
    const animAt = RES_HEADER_SIZE;
    if (animAt + 15 > bytes.length) return null;
    const anim = readSword2AnimHeader(bytes, animAt);
    if (animPc < 0 || animPc >= anim.noAnimFrames) return null;

    const cdtAt = animAt + 15 + animPc * 9;
    if (cdtAt + 9 > bytes.length) return null;
    const cdt = readSword2CdtEntry(bytes, cdtAt);

    // `frameOffset` is measured from the *anim header*, which is one resource
    // header into the file — `fetchFrameHeader` is
    // `animFile + ResHeader::size() + cdt.frameOffset` (`protocol.cpp:174-182`).
    // Reading it from the start of the resource instead lands 44 bytes early,
    // in the middle of the previous frame, which decodes into a partial image
    // rather than into nothing: the symptom is a sprite that is mostly
    // transparent, not a sprite that is missing.
    const frameAt = animAt + cdt.frameOffset;
    if (frameAt + 8 > bytes.length) return null;
    const header = readSword2FrameHeader(bytes, frameAt);
    if (header.width === 0 || header.height === 0) return null;

    // RLE16's colour table sits between the CDT entries and the frames, which
    // is the one place the animation header's compression type changes the
    // *layout* rather than only the decode.
    let colourTable: Uint8Array | undefined;
    if (anim.runTimeComp === 2) {
      const tableAt = animAt + 15 + anim.noAnimFrames * 9;
      if (tableAt + 16 <= bytes.length) colourTable = bytes.subarray(tableAt, tableAt + 16);
    }

    const compression = cdt.frameType & Sword2FrameType.FAST_256 ? 1 : anim.runTimeComp;
    const decoded = decodeSword2Frame(
      bytes.subarray(frameAt + 8, frameAt + 8 + header.compSize),
      compression,
      header.width,
      header.height,
      colourTable,
    );
    if (!decoded.ok) {
      this.note(
        `frame ${animPc} of animation ${animResource} decoded partly, so part of it is ` +
          `transparent rather than wrong`,
      );
    }
    return {
      pixels: decoded.pixels,
      width: header.width,
      height: header.height,
      x: cdt.x,
      y: cdt.y,
      frameType: cdt.frameType,
    };
  }

  /** Clips and blits into the room buffer. Zero is transparent. */
  private blit(pixels: Uint8Array, x: number, y: number, width: number, height: number): void {
    for (let row = 0; row < height; row++) {
      const destY = y + row;
      if (destY < 0 || destY >= this.roomHeight) continue;
      const to = destY * this.roomWidth;
      const from = row * width;
      for (let column = 0; column < width; column++) {
        const destX = x + column;
        if (destX < 0 || destX >= this.roomWidth) continue;
        const pixel = pixels[from + column];
        if (pixel) this.buffer[to + destX] = pixel;
      }
    }
  }

  /**
   * Stamps the mask layers that cover a sprite back over it.
   *
   * A layer is a rectangle with its own RLE256 mask bitmap, so the test is a
   * rectangle overlap rather than a block-grid walk — simpler than Sword1's and
   * doing the same job: putting the foreground scenery back in front of a
   * character who walked behind it.
   */
  private applyMasks(sprite: Sword2Sprite): void {
    if (!this.screenBytes || this.layers.length === 0) return;
    for (const layer of this.layers) {
      // Only layers whose bottom is below the sprite's feet can be in front of
      // it, which is the same y ordering the sorted list uses.
      if (layer.y + layer.height < sprite.feetY) continue;
      // A LayerHeader's offset is measured from the end of the resource header,
      // not from the file's start — `file + ResHeader::size() + layer.offset` in
      // `Screen::processLayer`. Reading it as absolute lands 44 bytes early and
      // the mask decodes to noise.
      const maskAt = RES_HEADER_SIZE + layer.offset;
      const mask = this.screenBytes.subarray(maskAt, maskAt + layer.maskSize);
      if (mask.length === 0) continue;
      // A layer mask is always RLE256: it is a full-colour bitmap of the
      // scenery in front, not a sprite, so there is no nibble-packed variant.
      const pixels = new Uint8Array(layer.width * layer.height);
      decompressRLE256(mask, pixels, pixels.length);
      this.blit(pixels, layer.x, layer.y, layer.width, layer.height);
    }
  }

  /**
   * Blits one decoded layer into the room buffer. `Screen::renderParallax`.
   *
   * The original works in screen coordinates and offsets a layer by
   * `((layerWidth - screenWidth) * scrollX) / (roomWidth - screenWidth)`, so a
   * layer exactly as wide as the room moves with it one-for-one and a narrower
   * one lags. This buffer is room-sized and `present` takes the scroll off
   * again at the end, so the same offset is added back here — which leaves the
   * background layer, whose width *is* the room's, at 0,0 where it belongs.
   *
   * One departure, stated rather than hidden: ScummVM reserves forty pixels of
   * menu at the top and bottom and so compares against a 400-pixel-deep window,
   * where this project draws the game area over the whole 480. It shifts a
   * vertically-scrolling parallax by a few pixels and nothing else.
   */
  private renderParallax(layer: Sword2Parallax | null): void {
    if (!layer) return;
    const spanX = this.roomWidth - SWORD2_SCREEN_WIDTH;
    const spanY = this.roomHeight - SWORD2_SCREEN_HEIGHT;
    const lagX =
      spanX <= 0 ? 0 : Math.trunc(((layer.width - SWORD2_SCREEN_WIDTH) * this.scrollX) / spanX);
    const lagY =
      spanY <= 0 ? 0 : Math.trunc(((layer.height - SWORD2_SCREEN_HEIGHT) * this.scrollY) / spanY);
    const originX = this.scrollX - lagX;
    const originY = this.scrollY - lagY;

    for (let row = 0; row < layer.height; row++) {
      const destY = row + originY;
      if (destY < 0 || destY >= this.roomHeight) continue;
      const from = row * layer.width;
      const to = destY * this.roomWidth;
      for (let column = 0; column < layer.width; column++) {
        const pixel = layer.pixels[from + column];
        // 0 is transparent in every layer, including the background: a hole in
        // the background is a hole, and filling it would hide the sprites a
        // mask is meant to show through.
        if (pixel === 0) continue;
        const destX = column + originX;
        if (destX < 0 || destX >= this.roomWidth) continue;
        this.buffer[to + destX] = pixel;
      }
    }
  }

  /**
   * Adds a text sprite at display coordinates and returns its handle.
   *
   * The handle is one-based because zero means "no text" throughout the
   * scripts and `fnISpeak` tests `_speechTextBlocNo` for truth
   * (`speech.cpp:181`, `function.cpp:1046`).
   */
  addTextBloc(sprite: Sword2TextSprite, x: number, y: number): number {
    let slot = this.textBlocs.findIndex((bloc) => bloc === null);
    if (slot < 0) slot = this.textBlocs.length;
    this.textBlocs[slot] = { x, y, sprite };
    return slot + 1;
  }

  /** Removes a bloc by handle. `killTextBloc`. A handle of 0 is a no-op. */
  killTextBloc(handle: number): void {
    if (handle <= 0 || handle > this.textBlocs.length) return;
    this.textBlocs[handle - 1] = null;
  }

  /** Drops every bloc. What leaving a room does. */
  clearTextBlocs(): void {
    this.textBlocs = [];
  }

  /** How many blocs are live, for the status line and for tests. */
  get textBlocCount(): number {
    return this.textBlocs.reduce((count, bloc) => count + (bloc ? 1 : 0), 0);
  }

  /** Hands over the menu bars to draw over the picture this frame. */
  setMenu(bars: readonly Sword2MenuBar[]): void {
    this.menuBars = bars;
  }

  /**
   * Hands over the dragged luggage and where the pointer is, or null for none.
   *
   * The coordinates are the pointer's, not the image's: the hotspot is applied
   * here, because it belongs to the sprite rather than to the mouse.
   */
  setLuggage(frame: Sword2MouseFrame | null, x: number, y: number): void {
    this.luggage = frame ? { frame, x, y } : null;
  }

  /** Copies the visible window into a display-sized framebuffer. */
  present(out: Uint8Array): void {
    out.fill(0);
    for (let row = 0; row < SWORD2_SCREEN_HEIGHT; row++) {
      const sourceRow = row + this.scrollY;
      if (sourceRow < 0 || sourceRow >= this.roomHeight) continue;
      const from = sourceRow * this.roomWidth + this.scrollX;
      const width = Math.min(SWORD2_SCREEN_WIDTH, this.roomWidth - this.scrollX);
      if (width <= 0) continue;
      out.set(this.buffer.subarray(from, from + width), row * SWORD2_SCREEN_WIDTH);
    }

    // Text last, and onto the *window* rather than the room buffer. Both halves
    // of that matter: last because `printTextBlocs` runs after every parallax
    // and sprite (`screen.cpp:332`), and onto the window because a bloc is
    // display-aligned — writing it into the room buffer would scroll it away
    // and would also leave it there next cycle, since the buffer is scratch.
    for (const bloc of this.textBlocs) {
      if (bloc) this.blitText(bloc, out);
    }

    // The bars last of all, because they are drawn over the picture rather
    // than beside it: `Screen::updateDisplay` runs `processMenu` after
    // `buildDisplay` has finished with the room and its text
    // (`screen.cpp:340-347`).
    for (let menu = 0; menu < this.menuBars.length; menu++) {
      this.blitMenu(menu, this.menuBars[menu], out);
    }

    // And the luggage over everything, because in the original it is not drawn
    // into the picture at all — it is half of the *cursor*
    // (`Mouse::drawMouse`), and a cursor is above the bars it is used to click.
    this.blitLuggage(out);
  }

  /**
   * Stamps the dragged object onto the display, zero transparent.
   *
   * The hotspot is subtracted rather than added, which is the direction that
   * makes the sprite hang *below and to the right* of the pointer: every
   * luggage in the demo has a hotspot of -8,-8, so the image starts eight
   * pixels past the point being clicked and nothing the pointer is aimed at is
   * covered by what it is carrying.
   *
   * This is `drawMouse`'s luggage-only branch (`mouse.cpp:1575-1579`), and
   * deliberately so: the original composes the luggage with the cursor sprite
   * and offsets it by the difference of their two hotspots, and this project
   * draws no cursor sprite — the pointer is the browser's own. Composing
   * against a sprite that is not there would need a hotspot invented for it.
   */
  private blitLuggage(out: Uint8Array): void {
    const carried = this.luggage;
    if (!carried) return;
    const { frame } = carried;
    const originX = carried.x - frame.hotspotX;
    const originY = carried.y - frame.hotspotY;
    for (let row = 0; row < frame.height; row++) {
      const destY = originY + row;
      if (destY < 0 || destY >= SWORD2_SCREEN_HEIGHT) continue;
      for (let column = 0; column < frame.width; column++) {
        const destX = originX + column;
        if (destX < 0 || destX >= SWORD2_SCREEN_WIDTH) continue;
        const pixel = frame.pixels[row * frame.width + column]!;
        if (pixel === 0) continue;
        out[destY * SWORD2_SCREEN_WIDTH + destX] = pixel;
      }
    }
  }

  /**
   * Stamps one bar's icons onto the display.
   *
   * An `ICON_FILE` holds **two** 35x30 images, the greyed one then the
   * coloured one (`icons.cpp:176-183`), so which of them is drawn is a
   * half-resource offset and not a palette trick. Unlike a sprite or a text
   * bloc, an icon is opaque: zero is black here rather than transparent, which
   * is what `clearIconArea` filling the pocket with zero before the blit
   * amounts to.
   */
  private blitMenu(menu: number, bar: Sword2MenuBar | undefined, out: Uint8Array): void {
    if (!bar?.shown) return;
    const top = menu === SWORD2_MENU.TOP ? SWORD2_TOP_MENU_TOP : SWORD2_BOTTOM_MENU_TOP;
    const image = SWORD2_ICON_WIDTH * SWORD2_ICON_DEPTH;

    bar.pockets.forEach((pocket, at) => {
      if (!pocket) return;
      const resource = this.fetchIcon(pocket.icon);
      if (!resource) return;
      const from = RES_HEADER_SIZE + (pocket.coloured ? image : 0);
      if (from + image > resource.length) {
        this.note(
          `menu icon ${pocket.icon} is ${resource.length - RES_HEADER_SIZE} bytes, where an ` +
            `icon is two ${SWORD2_ICON_WIDTH}x${SWORD2_ICON_DEPTH} images`,
        );
        return;
      }
      const left = SWORD2_ICON_START + at * (SWORD2_ICON_WIDTH + SWORD2_ICON_SPACING);
      for (let row = 0; row < SWORD2_ICON_DEPTH; row++) {
        const destY = top + row;
        if (destY < 0 || destY >= SWORD2_SCREEN_HEIGHT) continue;
        const to = destY * SWORD2_SCREEN_WIDTH + left;
        if (left < 0 || left + SWORD2_ICON_WIDTH > SWORD2_SCREEN_WIDTH) continue;
        out.set(
          resource.subarray(from + row * SWORD2_ICON_WIDTH, from + (row + 1) * SWORD2_ICON_WIDTH),
          to,
        );
      }
    });
  }

  /** An icon resource's bytes, or null with the reason noted once. */
  private fetchIcon(id: number): Uint8Array | null {
    try {
      const resource = this.resources.fetch(id);
      if (resource) return resource.bytes;
    } catch (error) {
      this.note(`menu icon ${id}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    this.note(`menu icon ${id}: ${this.resources.describeMissingResource(id)}`);
    return null;
  }

  /** Stamps one bloc onto the display, zero transparent, clipped to it. */
  private blitText(bloc: Sword2TextBloc, out: Uint8Array): void {
    const { sprite } = bloc;
    for (let row = 0; row < sprite.height; row++) {
      const destY = bloc.y + row;
      if (destY < 0 || destY >= SWORD2_SCREEN_HEIGHT) continue;
      const to = destY * SWORD2_SCREEN_WIDTH;
      const from = row * sprite.width;
      for (let column = 0; column < sprite.width; column++) {
        const destX = bloc.x + column;
        if (destX < 0 || destX >= SWORD2_SCREEN_WIDTH) continue;
        const ink = sprite.pixels[from + column];
        // RDSPR_TRANS: zero is transparent. Every text bloc carries it.
        if (ink !== 0) out[to + destX] = ink;
      }
    }
  }

  private note(message: string): void {
    if (this.warnings.length < 40 && !this.warnings.includes(message)) this.warnings.push(message);
  }
}

/** Mirrors a frame left-to-right. `FRAME_FLIPPED`'s whole job. */
function flipHorizontally(pixels: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(pixels.length);
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      out[row * width + column] = pixels[row * width + (width - 1 - column)];
    }
  }
  return out;
}
