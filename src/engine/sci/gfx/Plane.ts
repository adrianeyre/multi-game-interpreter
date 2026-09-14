/**
 * A Plane, and the compositor that draws them (ADR 0015).
 *
 * The decision this file exists to implement: **the priority buffer is optional
 * data on a Plane, not a branch in the code.** A SCI16 Plane carries the
 * per-pixel mask painted from its Picture; a SCI32 Plane never does and
 * occludes by ordering alone. Both go through the same compositor, which is
 * what makes SCI2's renderer a generalisation of this one rather than a
 * replacement (#225).
 *
 * The naive reading — "SCI16 is one full-screen Plane" — is false, and the
 * reason is the whole point: a sorted display list cannot reproduce scenery
 * occluding the middle of an actor while its head shows above. Carrying the
 * mask on the Plane can.
 *
 * **The tripwire, stated where it would fire.** If the mask's presence starts
 * being asked about *outside* `visible` below — in dirty-rect tracking, in cel
 * clipping, in hit-testing — it is not optional data, it is a second renderer,
 * and the renderer should split rather than grow flags. Splitting it does not
 * reopen ADR 0015: the family claim rests on shared bytecode and a drifting
 * resource layout, not on the renderer.
 */

import type { SciCel } from './SciView.js';

/**
 * What a Plane's `picture` says when it is not a Picture.
 *
 * SCI32's `PlanePictureCodes` (`plane32.h`): at or below 65531 the number is a
 * resource, and the four values above it say what kind of Plane this is. A
 * reader that takes them for resource numbers asks for Pictures that were never
 * shipped and leaves every coloured and transparent Plane blank.
 *
 * **The four names were one apart from Sierra's and now are not.** They were
 * written as 65532 opaque, 65533 transparent, 65534 coloured, with 65535 left
 * out of the enumeration altogether; `plane32.h` has 65532 transparent-picture,
 * 65533 opaque, 65534 transparent and 65535 coloured. The *range* was right
 * either way, which is why nothing showed it: `isPlanePicture` only asks
 * whether the number is at or below 65531. It stopped being harmless the
 * moment a Plane's kind decided what it draws, because King's Quest VII's
 * chapter screens are 65535 and under the old names 65535 was not a kind at
 * all.
 */
export const PLANE_PIC_TRANSPARENT_PICTURE = 65532;
export const PLANE_PIC_OPAQUE = 65533;
export const PLANE_PIC_TRANSPARENT = 65534;
export const PLANE_PIC_COLOURED = 65535;
/** The highest number that is still a Picture resource. */
export const PLANE_PIC_MAX = 65531;

/**
 * The View number that means "this item is not drawn from a View".
 *
 * The counterpart of `PLANE_PIC_*` one layer down: a bitmap-backed screen item
 * carries it, and asking the resource layer for View 65535 gets the truthful
 * and useless answer that the game has not got one.
 */
export const NO_VIEW = 0xffff;

/** Whether a Plane's `picture` names a resource rather than a kind. */
export function isPlanePicture(picture: number): boolean {
  return picture > 0 && picture <= PLANE_PIC_MAX;
}

/** What kind of Plane a `picture` number makes it, which is what it draws. */
export type PlaneKind = 'picture' | 'transparent-picture' | 'opaque' | 'transparent' | 'coloured';

/**
 * `Plane::setType`, which is four lines and decides everything a Plane paints
 * of its own.
 *
 * Only a **coloured** Plane is filled. `GfxFrameout::drawEraseList` returns
 * without painting unless the Plane is `kPlaneTypeColored`, and
 * `Plane::calcLists` does not put a picture or an opaque Plane on the erase
 * list at all. So a transparent Plane shows the room through it, an opaque one
 * keeps whatever was already in the buffer, and a picture Plane's own cels are
 * its background.
 *
 * A number at or below 65531 is a resource whatever else is true, which is why
 * this is written as a switch with a default and not as a table.
 */
export function planeKind(picture: number): PlaneKind {
  switch (picture) {
    case PLANE_PIC_COLOURED:
      return 'coloured';
    case PLANE_PIC_TRANSPARENT:
      return 'transparent';
    case PLANE_PIC_OPAQUE:
      return 'opaque';
    case PLANE_PIC_TRANSPARENT_PICTURE:
      return 'transparent-picture';
    default:
      return 'picture';
  }
}

/**
 * A SCI32 screen item's `nsRect`, in script coordinates.
 *
 * **Measured differently from SCI16's, and `z` is not in it.**
 * `ScreenItem::getNowSeenRect` (`screen_item32.cpp`) takes the cel's own
 * rectangle, scales it out of the cel's resolution and into the script's, and
 * translates it by the position less the origin. There is no baseline and no
 * elevation: SCI32 uses `z` for priority, so subtracting it — which is right
 * for SCI16, where `z` is a height above the floor — puts the rectangle
 * wherever the priority happens to be.
 *
 * **A script's own `onMe` is usually a bounding-box test against these four
 * words rather than a Kernel call**, so a wrong rectangle is not cosmetic: it
 * is a thing on screen that cannot be clicked. King's Quest VII's chapter-select
 * digits each set `z` to 1000 to order themselves, and under SCI16's arithmetic
 * all six boxes landed at y −929 to −893 while the digits were drawn at y 81.
 *
 * Truncated rather than rounded, which is what `Ratio::toInt` does.
 */
export function sci32NowSeenRect(
  cel: { width: number; height: number; displaceX: number; displaceY: number },
  celResolution: { width: number; height: number },
  script: { width: number; height: number },
  x: number,
  y: number,
): Rect & { left: number; top: number; right: number; bottom: number } {
  const acrossX = (value: number): number =>
    Math.floor((value * script.width) / celResolution.width);
  const acrossY = (value: number): number =>
    Math.floor((value * script.height) / celResolution.height);

  const left = x - acrossX(cel.displaceX);
  const top = y - acrossY(cel.displaceY);
  const right = left + acrossX(cel.width);
  const bottom = top + acrossY(cel.height);
  return { x: left, y: top, width: right - left, height: bottom - top, left, top, right, bottom };
}

/** Where something sits, in the coordinate space its Plane is in. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One thing drawn onto a Plane. */
export interface ScreenItem {
  /** Indexed pixels, and the index that means "leave what is underneath". */
  cel: SciCel;
  x: number;
  y: number;
  /**
   * What this item occludes and is occluded by.
   *
   * On a Plane with a mask this is compared per pixel against the mask; on one
   * without, it only orders the item in the display list. Same field either
   * way, which is what "optional data" means here.
   */
  priority: number;
  /** Ties are broken by insertion, so a script's own order is preserved. */
  order: number;
  /** Set false to keep an item without drawing it. */
  visible: boolean;
  /**
   * How big the item is **on screen**, when that is not the cel's pixel size.
   *
   * SCI32's one genuinely new idea about drawing: a cel declares the resolution
   * it was drawn for, and the compositor maps it onto whatever the screen is.
   * King's Quest VII's cast is drawn at 320x200 and its interface at 640x480,
   * on the same Plane, in the same frame — so "the cel's width" and "how many
   * pixels it covers" stopped being the same number and a second pair is the
   * only honest way to say it.
   *
   * Null means one pixel per pixel, which is every SCI16 item and most SCI32
   * ones, and the blitter keeps its exact old path for them.
   */
  size?: { width: number; height: number } | null;
  /**
   * The Picture this item came out of, when it did not come from a script.
   *
   * Sierra keeps both halves of this: the cel's type says it came from a
   * Picture (`_celInfo.type == kCelTypePic`, which `deleteAllPics` reads) and
   * `screenItem->_pictureId` says which one (which `deletePic` reads). A
   * single optional number is the same two facts, and it has to be the number
   * rather than a flag because `AddPicAt` layers several Pictures on one Plane
   * and can be asked to replace just one of them.
   */
  pictureId?: number;
}

/** What an item covers on screen, which is its `size` where it has one. */
export function screenItemSize(item: ScreenItem): { width: number; height: number } {
  return item.size ?? { width: item.cel.width, height: item.cel.height };
}

/**
 * Where a cel's own coordinate origin sits inside it, in the cel's pixels.
 *
 * **A View's cel header does not hold an origin; it holds a displacement from
 * the bottom centre.** SCI puts an actor's position at their feet, so nought
 * and nought means "the middle of the bottom row", and the pair of signed words
 * at offsets 4 and 6 nudges the origin away from there. `celobj32.cpp:1074`
 * turns them into an origin, and SCI16's `getCelRect` reaches the same place by
 * a different arrangement of the same terms — the two families agree, and this
 * is the one function that says so.
 *
 * Reading the header words *as* the origin looks harmless while every cel is an
 * actor drawn around nought, and it is ruinous for an interface: a button
 * authored to hang from its top left is written with `width/2` and `height-1`
 * precisely so the pair cancels, and read raw it is displaced by its own size.
 * King's Quest VII's three menu buttons landed at x 161, 97 and 214 — not a
 * column at all — instead of 240, 210 and 268, whose centres are 319.5, 323 and
 * 322 on a 640-pixel screen.
 *
 * A bitmap is the exception and is not one: SCI32 builds bitmaps with a real
 * origin in their header (`celobj32.cpp:1330`), so a caller that has put that
 * origin in these fields passes `bitmap` and it is used as it stands.
 */
export function celOrigin(
  cel: Pick<SciCel, 'width' | 'height' | 'displaceX' | 'displaceY'>,
  bitmap = false,
): { x: number; y: number } {
  if (bitmap) return { x: cel.displaceX, y: cel.displaceY };
  return { x: (cel.width >> 1) - cel.displaceX, y: cel.height - cel.displaceY - 1 };
}

export class Plane {
  readonly bounds: Rect;
  /** Draw order between Planes; higher is nearer the viewer. */
  priority: number;
  /**
   * The per-pixel priority mask, or null.
   *
   * **Null is the SCI32 case and is not a special case.** A Plane without a
   * mask occludes by ordering alone, which is what every SCI32 Plane does and
   * what a SCI16 Plane with no Picture behind it does too — a text window, for
   * instance. The compositor below asks once, in one place.
   */
  mask: Uint8Array | null;

  /** The Plane's own picture, drawn under its items. */
  background: Uint8Array | null = null;

  /**
   * The colour a `kPlaneTypeColored` Plane declares, **recorded and not
   * painted**.
   *
   * This has now been tried twice and reverted twice, and the second time is
   * worth writing down because the reasoning looked airtight. Sierra's
   * `GfxFrameout::drawEraseList` returns without painting unless the Plane is
   * `kPlaneTypeColored`, and `Plane::calcLists` does not put an opaque or a
   * picture Plane on the erase list at all — so "fill exactly the coloured
   * ones" reads as the faithful rule, and the first attempt's mistake looks
   * like it was filling too many kinds.
   *
   * It is not. **King's Quest VII's interface Plane is `kPlanePicColored` with
   * a `back` of nought, sits at priority 65535 over everything, and covers the
   * bottom third of the screen.** Filling it puts a flat block across every
   * screen the game has — the menu's "Quit" button is cut in half by it — and
   * that is what an owner playing it in a browser reported, in those words,
   * after this project shipped the rule.
   *
   * And the artwork it hides was **already being drawn**. With the fill gone,
   * the bottom third of King's Quest VII's first room is its inventory bar —
   * the monogram, the carried item in its slot, the eye, the crystal ball —
   * and the menu's "Quit" button is whole again. The fill was not standing in
   * for something missing; it was painting over something that worked.
   *
   * So the colour is carried — `planeKind` still answers, and a caller with a
   * reason for it has the number waiting — and the compositor does not use it.
   * **Do not paint from this without a screenshot of the main menu and of a
   * room's interface bar in the commit.** Reading `drawEraseList` is what
   * produced this twice; only the screen settles it.
   */
  fill: number | null = null;

  /**
   * The `picture` number this Plane was last told, as the script said it.
   *
   * Held so that `setPicture` can tell a change from a repetition:
   * `UpdatePlane` arrives every cycle a game is running and re-reading a
   * Picture on each one would re-fetch a 200KB background sixty times a second.
   * A Plane with no picture yet is coloured, which is the field Sierra's own
   * constructor initialises `_type` to.
   */
  pictureId: number = PLANE_PIC_COLOURED;

  readonly items: ScreenItem[] = [];
  private nextOrder = 0;

  constructor(bounds: Rect, priority = 0, mask: Uint8Array | null = null) {
    this.bounds = bounds;
    this.priority = priority;
    this.mask = mask;
  }

  add(item: Omit<ScreenItem, 'order'>): ScreenItem {
    const added: ScreenItem = { ...item, order: this.nextOrder++ };
    this.items.push(added);
    return added;
  }

  remove(item: ScreenItem): void {
    const index = this.items.indexOf(item);
    if (index >= 0) this.items.splice(index, 1);
  }

  /**
   * `Plane::deleteAllPics` — every cel this Plane's Picture put here, gone.
   *
   * The cast stays. That is the whole distinction the `fromPicture` flag
   * exists for, and it is what makes a room change a change of background
   * rather than a clearing of the screen.
   */
  deleteAllPics(): void {
    for (let index = this.items.length - 1; index >= 0; index--) {
      if (this.items[index].pictureId !== undefined) this.items.splice(index, 1);
    }
    this.background = null;
  }

  /**
   * `Plane::deletePic` — one Picture's cels off a Plane that may hold several.
   *
   * `AddPicAt` is why a Plane may: a SCI32 room composes its background from
   * its own Picture and any number of others placed at offsets, and re-adding
   * one is how a game changes a part of the scenery. Sierra's default for that
   * call's `deleteDuplicate` is true, so re-adding the same number replaces it
   * rather than stacking a second copy on top.
   */
  deletePic(picture: number): void {
    for (let index = this.items.length - 1; index >= 0; index--) {
      if (this.items[index].pictureId === picture) this.items.splice(index, 1);
    }
  }

  /**
   * What this Plane shows under its items, told the way a script tells it.
   *
   * The three statements of Sierra's `Plane::sync` in the order it has them:
   * when the number differs from the one being held, `deleteAllPics` empties
   * the Plane of its old Picture, `setType` re-reads what kind of Plane the
   * new number makes it, and `changePic` puts the new Picture on — which for a
   * number that is not a Picture does nothing at all.
   *
   * **Returns whether the caller must now fetch a Picture**, because the fetch
   * is asynchronous here and synchronous in Sierra's engine, and that is the
   * only difference between the two.
   *
   * The case that was missing was not a Picture becoming another Picture; it
   * was a Picture becoming a *code*. King's Quest VII holds one Plane for its
   * title screen and for every chapter screen after it, and a chapter screen
   * sets `picture` to `kPlanePicColored`. Without the delete, the title art
   * stayed on that Plane for the rest of the game, lit by whatever palette the
   * new screen had loaded.
   */
  setPicture(picture: number, back: number): boolean {
    const changed = picture !== this.pictureId;
    this.pictureId = picture;
    if (changed) this.deleteAllPics();

    const kind = planeKind(picture);
    this.fill = kind === 'coloured' && back >= 0 ? back & 0xff : null;
    return changed && isPlanePicture(picture);
  }

  /**
   * Whether this item's pixel shows at `(x, y)`.
   *
   * **The one place the mask is asked about.** With a mask, an item shows where
   * its own priority is at least the mask's — which is how scenery painted into
   * the Picture hides an actor's legs and not its head. Without one, it always
   * shows, and the display-list order has already decided what is on top.
   */
  visible(item: ScreenItem, x: number, y: number): boolean {
    if (!this.mask) return true;
    const index = y * this.bounds.width + x;
    if (index < 0 || index >= this.mask.length) return true;
    return item.priority >= this.mask[index];
  }
}

/**
 * Draws Planes into a framebuffer.
 *
 * Sorted by Plane, then by item priority, then by insertion — the same three
 * keys SCI32's own compositor uses, and they are the same three whether or not
 * a Plane carries a mask.
 */
export class SciCompositor {
  readonly planes: Plane[] = [];
  /**
   * What the last frame touched, so this frame can repair it.
   *
   * A dirty-rect redraw needs two sets and not one: where things are now, and
   * where they were. Redrawing only the first leaves the trail an actor walked
   * out of, which looks like a smear rather than like a fault.
   */
  private previous: Rect[] = [];

  add(plane: Plane): Plane {
    this.planes.push(plane);
    return plane;
  }

  remove(plane: Plane): void {
    const index = this.planes.indexOf(plane);
    if (index >= 0) this.planes.splice(index, 1);
  }

  /**
   * Composites only what changed since the last frame (#225).
   *
   * The union of what this frame touches and what the last one did, clipped to
   * that union and nothing else. The first call has no previous frame and so
   * redraws everything, which is also what a room change wants.
   *
   * **The tripwire, and it did not fire.** ADR 0015 says the priority buffer is
   * optional data on a Plane and warns that if its presence starts being asked
   * about *outside* the visibility test — "in dirty-rect tracking, in cel
   * clipping, in hit-testing" — it is a second renderer wearing a flag. Dirty
   * tracking is the first of those three to be built, and it does not ask: a
   * rectangle is a rectangle whether or not the Plane under it carries a mask,
   * and the only call into `visible` is still the one inside `blitItem`.
   *
   * Returns the rectangles repaired, which is what a caller uploading to a
   * canvas needs in order to upload only those.
   */
  compositeDirty(target: Uint8Array, width: number, height: number): Rect[] {
    const now = this.rectangles();
    const repair = merge([...this.previous, ...now]);
    this.previous = now;

    if (repair.length === 0) return [];

    // **One region covering the screen is the ordinary case, and it does not
    // need the scratch copy.** A room whose background spans the whole frame
    // merges every rectangle into one, and going through `compositeClipped`
    // then costs two full-buffer copies to end up with what compositing
    // straight into the target already is.
    if (repair.length === 1 && covers(repair[0], width, height)) {
      target.fill(0);
      this.composite(target, width, height);
      return repair;
    }

    for (const region of repair) {
      // Clear the region before redrawing it. Without this an item that shrank
      // or moved leaves its own old pixels behind inside a region that *is*
      // being redrawn, which is subtler than a smear and harder to see.
      for (let y = region.y; y < region.y + region.height; y++) {
        if (y < 0 || y >= height) continue;
        target.fill(
          0,
          y * width + Math.max(0, region.x),
          y * width + Math.min(width, region.x + region.width),
        );
      }
    }

    this.compositeClipped(target, width, height, repair);
    return repair;
  }

  /** Where everything currently sits, in framebuffer coordinates. */
  private rectangles(): Rect[] {
    const rects: Rect[] = [];
    for (const plane of this.planes) {
      if (plane.background) rects.push({ ...plane.bounds });
      for (const item of plane.items) {
        if (!item.visible) continue;
        const size = screenItemSize(item);
        rects.push({
          x: plane.bounds.x + item.x,
          y: plane.bounds.y + item.y,
          width: size.width,
          height: size.height,
        });
      }
    }
    return rects;
  }

  /** Draws everything, but only where it falls inside one of `regions`. */
  /**
   * A frame's worth of scratch, kept rather than made.
   *
   * This was a `new Uint8Array(target.length)` inside the frame loop: 307,200
   * bytes of garbage sixty times a second for a 640x480 game, which is the
   * other half of what an owner reported as the first room lagging.
   */
  private scratch: Uint8Array | null = null;

  private compositeClipped(
    target: Uint8Array,
    width: number,
    height: number,
    regions: readonly Rect[],
  ): void {
    if (!this.scratch || this.scratch.length !== target.length) {
      this.scratch = new Uint8Array(target.length);
    }
    const scratch = this.scratch;
    scratch.set(target);
    this.composite(scratch, width, height);

    for (const region of regions) {
      for (let y = region.y; y < region.y + region.height; y++) {
        if (y < 0 || y >= height) continue;
        const from = y * width + Math.max(0, region.x);
        const to = y * width + Math.min(width, region.x + region.width);
        if (to > from) target.set(scratch.subarray(from, to), from);
      }
    }
  }

  /**
   * Composites everything into `target`, which is `width` pixels wide.
   *
   * Returns the rectangles it touched. Whole-frame rather than incremental —
   * `compositeDirty` is the incremental one, and this is what it repairs
   * through, what the first frame uses, and what `npm run shot:sci` wants.
   */
  composite(target: Uint8Array, width: number, height: number): Rect[] {
    const dirty: Rect[] = [];

    for (const plane of [...this.planes].sort((a, b) => a.priority - b.priority)) {
      if (plane.background) {
        blitBackground(plane, target, width, height);
        dirty.push({ ...plane.bounds });
      }

      const items = plane.items
        .filter((item) => item.visible)
        .sort((a, b) => a.priority - b.priority || a.order - b.order);

      for (const item of items) {
        const touched = blitItem(plane, item, target, width, height);
        if (touched) dirty.push(touched);
      }
    }
    return dirty;
  }
}

function blitBackground(plane: Plane, target: Uint8Array, width: number, height: number): void {
  const background = plane.background;
  if (!background) return;
  for (let y = 0; y < plane.bounds.height; y++) {
    const destY = plane.bounds.y + y;
    if (destY < 0 || destY >= height) continue;
    for (let x = 0; x < plane.bounds.width; x++) {
      const destX = plane.bounds.x + x;
      if (destX < 0 || destX >= width) continue;
      target[destY * width + destX] = background[y * plane.bounds.width + x];
    }
  }
}

/**
 * One cel, tested per pixel against the Plane's mask.
 *
 * The transparency test and the priority test are separate and both have to
 * pass: a pixel the cel says is clear leaves what is underneath whatever the
 * priorities say, and a pixel the mask hides is hidden however opaque the cel
 * is. Folding them into one test loses the difference between an actor behind
 * a wall and an actor with a hole in it.
 */
function blitItem(
  plane: Plane,
  item: ScreenItem,
  target: Uint8Array,
  width: number,
  height: number,
): Rect | null {
  const { cel } = item;
  const size = screenItemSize(item);
  if (size.width <= 0 || size.height <= 0 || cel.width <= 0 || cel.height <= 0) return null;

  // **Nearest-neighbour, and deliberately.** A SCI32 cel scaled up is Sierra's
  // own pixel art at a whole-number ratio in the common case, and smoothing it
  // would be a different picture from the one the artist drew. The source index
  // is picked per destination pixel so a cel that is *not* a whole ratio still
  // covers exactly the rectangle the display list says it does — the alternative
  // is a seam between an actor and the scenery it stands on.
  const scaled = size.width !== cel.width || size.height !== cel.height;
  const masked = plane.mask !== null;
  let touched = false;

  // **Clipped before the loop rather than inside it.** A SCI32 panorama is
  // three 640x334 cels on a Plane twice the width of the screen, so two of
  // them are almost entirely off it — and skipping those pixels one `continue`
  // at a time still walks 213,760 of them per cel per frame. Working out the
  // visible span first turns the room's background from about 640,000
  // iterations a frame into only the pixels that land on screen. This is what
  // an owner playing it in a browser reported as the first room lagging.
  const originX = plane.bounds.x + item.x;
  const originY = plane.bounds.y + item.y;
  const fromY = Math.max(0, -originY);
  const toY = Math.min(size.height, height - originY);
  const fromX = Math.max(0, -originX);
  const toX = Math.min(size.width, width - originX);

  for (let y = fromY; y < toY; y++) {
    const planeY = item.y + y;
    const destRow = (originY + y) * width;
    const sourceY = scaled
      ? Math.min(cel.height - 1, Math.floor((y * cel.height) / size.height))
      : y;
    const sourceRow = sourceY * cel.width;

    for (let x = fromX; x < toX; x++) {
      const sourceX = scaled
        ? Math.min(cel.width - 1, Math.floor((x * cel.width) / size.width))
        : x;
      const pixel = cel.pixels[sourceRow + sourceX];
      if (pixel === cel.clearKey) continue;
      // **The mask is asked about once per item, not once per pixel.** ADR
      // 0015's optional-data claim is exactly what makes that safe: a Plane
      // without a mask always answers yes, and every SCI32 Plane is one — so a
      // per-pixel call there was two million function calls a frame to be told
      // nothing. The masked path still asks per pixel, because there the
      // answer genuinely differs per pixel.
      if (masked && !plane.visible(item, item.x + x, planeY)) continue;

      target[destRow + originX + x] = pixel;
      touched = true;
    }
  }

  return touched
    ? {
        x: plane.bounds.x + item.x,
        y: plane.bounds.y + item.y,
        width: size.width,
        height: size.height,
      }
    : null;
}

/**
 * Merges overlapping rectangles, so a region is repaired once.
 *
 * Not an optimal packing and not trying to be: two cels that overlap become one
 * rectangle covering both, and a frame with fifty scattered items keeps roughly
 * fifty regions. The property that matters is that no pixel is drawn twice and
 * none is missed, and a merge that is too generous fails neither.
 */
function merge(rects: readonly Rect[]): Rect[] {
  const merged: Rect[] = [];

  for (const rect of rects) {
    if (rect.width <= 0 || rect.height <= 0) continue;
    let current = { ...rect };
    let combined = true;

    // Repeated until nothing more joins, because merging two rectangles can
    // bring the result into contact with a third that neither touched.
    while (combined) {
      combined = false;
      for (let index = merged.length - 1; index >= 0; index--) {
        if (!overlaps(current, merged[index])) continue;
        current = union(current, merged[index]);
        merged.splice(index, 1);
        combined = true;
      }
    }
    merged.push(current);
  }

  return merged;
}

/** Whether this rectangle reaches every pixel of a frame that size. */
function covers(rect: Rect, width: number, height: number): boolean {
  return (
    rect.x <= 0 && rect.y <= 0 && rect.x + rect.width >= width && rect.y + rect.height >= height
  );
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}
