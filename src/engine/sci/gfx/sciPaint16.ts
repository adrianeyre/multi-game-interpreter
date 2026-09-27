/**
 * SCI16's immediate drawing onto a room: what `Graph`, `DrawCel`, `AddToPic`
 * and `OnControl` do to the three buffers a Picture leaves behind.
 *
 * A SCI0 or SCI1 room is three screens of the same size — **visual**, what is
 * seen; **priority**, what occludes what; and **control**, where an actor may
 * walk and what a script finds under its feet. A Picture paints all three,
 * and these calls paint over them afterwards: `AddToPic` stamps scenery that
 * never moves again into all three, `DrawCel` stamps one cel, `Graph` fills
 * and rules boxes and lines, saves a box and puts it back, and `OnControl`
 * reads back which control colours lie under a rectangle, which is how a
 * game tells an ego standing on water from one standing on a path.
 *
 * Transcribed from ScummVM's `GfxPaint16`, `GfxScreen::drawLine` and
 * `GfxCompare::isOnControl` (`engines/sci/graphics/paint16.cpp`,
 * `screen.cpp`, `compare.cpp`), fetched 2026-09-27.
 *
 * **A room with no visual buffer is drawn onto with screen items.** A SCI1.1
 * cel Picture is a composition of cels rather than a painted buffer, so there
 * is nothing to stamp a line into; the visual half of each operation becomes a
 * one-colour item owned by the Picture instead, drawn over the room exactly
 * where Sierra would have painted, and the priority and control halves still
 * go into the buffers, which a cel Picture does have. `RestoreBox` there
 * removes what was added after the matching `SaveBox`, which is what putting
 * the saved pixels back amounts to.
 */

import type { SciCel } from './SciView.js';

/** `GFX_SCREEN_MASK_*`. */
export const SCI_SCREEN_MASK = { visual: 1, priority: 2, control: 4 } as const;

export interface SciRect16 {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The room's three buffers, in the Picture's own coordinates. */
export interface SciRoomSurface {
  width: number;
  height: number;
  visual: Uint8Array | null;
  priority: Uint8Array | null;
  control: Uint8Array | null;
  /** Puts a cel on the room as part of its Picture, for a room with no visual buffer. */
  addItem(cel: SciCel, x: number, y: number, priority: number): void;
  /** How many Picture-owned items the room has, and a way back to fewer. */
  itemCount(): number;
  truncateItems(count: number): void;
}

/** What a `SaveBox` kept, which only `RestoreBox` reads. */
export interface SciSavedBox {
  rect: SciRect16;
  mask: number;
  visual: Uint8Array | null;
  priority: Uint8Array | null;
  control: Uint8Array | null;
  items: number;
}

function clipped(surface: SciRoomSurface, rect: SciRect16): SciRect16 | null {
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const right = Math.min(surface.width, rect.right);
  const bottom = Math.min(surface.height, rect.bottom);
  return right > left && bottom > top ? { left, top, right, bottom } : null;
}

/** A single-colour cel: `colour` where `covered`, a different index elsewhere. */
function solidCel(width: number, height: number, colour: number, covered?: Uint8Array): SciCel {
  const clearKey = (colour + 1) & 0xff;
  const pixels = new Uint8Array(width * height).fill(covered ? clearKey : colour);
  if (covered) for (let i = 0; i < covered.length; i++) if (covered[i]) pixels[i] = colour;
  return { width, height, displaceX: 0, displaceY: 0, clearKey, pixels };
}

/**
 * `GfxPaint16::fillRect`: each buffer the mask names, filled over `rect`.
 * Priority and control are four-bit, because Sierra kept both in one byte.
 */
export function sciFillRect(
  surface: SciRoomSurface,
  rect: SciRect16,
  mask: number,
  colour: number,
  priority: number,
  control: number,
): void {
  const r = clipped(surface, rect);
  if (!r) return;
  const fill = (buffer: Uint8Array | null, value: number): void => {
    if (!buffer) return;
    for (let y = r.top; y < r.bottom; y++) {
      buffer.fill(value, y * surface.width + r.left, y * surface.width + r.right);
    }
  };
  if (mask & SCI_SCREEN_MASK.visual) {
    if (surface.visual) fill(surface.visual, colour & 0xff);
    else {
      surface.addItem(
        solidCel(r.right - r.left, r.bottom - r.top, colour & 0xff),
        r.left,
        r.top,
        priority & 0x0f,
      );
    }
  }
  if (mask & SCI_SCREEN_MASK.priority) fill(surface.priority, priority & 0x0f);
  if (mask & SCI_SCREEN_MASK.control) fill(surface.control, control & 0x0f);
}

/**
 * `GfxScreen::drawLine`: Bresenham with both ends set, clipped to the screen
 * the way LSL3's room 620 needs. A priority or control of -1 leaves that
 * buffer alone, which is `getDrawingMask`.
 */
export function sciDrawLine(
  surface: SciRoomSurface,
  from: { x: number; y: number },
  to: { x: number; y: number },
  colour: number,
  priority: number,
  control: number,
): void {
  const clampX = (x: number): number => Math.max(0, Math.min(surface.width - 1, x));
  const clampY = (y: number): number => Math.max(0, Math.min(surface.height - 1, y));
  let left = clampX(from.x);
  let top = clampY(from.y);
  const right = clampX(to.x);
  const bottom = clampY(to.y);

  const points: Array<[number, number]> = [];
  if (top === bottom) {
    for (let x = Math.min(left, right); x <= Math.max(left, right); x++) points.push([x, top]);
  } else if (left === right) {
    for (let y = Math.min(top, bottom); y <= Math.max(top, bottom); y++) points.push([left, y]);
  } else {
    const stepY = bottom - top < 0 ? -1 : 1;
    const stepX = right - left < 0 ? -1 : 1;
    const dy = Math.abs(bottom - top) << 1;
    const dx = Math.abs(right - left) << 1;
    points.push([left, top], [right, bottom]);
    if (dx > dy) {
      let fraction = dy - (dx >> 1);
      while (left !== right) {
        if (fraction >= 0) {
          top += stepY;
          fraction -= dx;
        }
        left += stepX;
        fraction += dy;
        points.push([left, top]);
      }
    } else {
      let fraction = dx - (dy >> 1);
      while (top !== bottom) {
        if (fraction >= 0) {
          left += stepX;
          fraction -= dy;
        }
        top += stepY;
        fraction += dx;
        points.push([left, top]);
      }
    }
  }

  const put = (buffer: Uint8Array | null, value: number): void => {
    if (!buffer) return;
    for (const [x, y] of points) buffer[y * surface.width + x] = value;
  };
  if (surface.visual) put(surface.visual, colour & 0xff);
  else if (points.length > 0) {
    const minX = Math.min(...points.map(([x]) => x));
    const minY = Math.min(...points.map(([, y]) => y));
    const width = Math.max(...points.map(([x]) => x)) - minX + 1;
    const height = Math.max(...points.map(([, y]) => y)) - minY + 1;
    const covered = new Uint8Array(width * height);
    for (const [x, y] of points) covered[(y - minY) * width + (x - minX)] = 1;
    surface.addItem(solidCel(width, height, colour & 0xff, covered), minX, minY, 15);
  }
  if (priority >= 0 && priority !== 255) put(surface.priority, priority & 0x0f);
  if (control >= 0 && control !== 255) put(surface.control, control & 0x0f);
}

/** `kernelGraphSaveBox`: the named buffers under `rect`, kept for `sciRestoreBox`. */
export function sciSaveBox(surface: SciRoomSurface, rect: SciRect16, mask: number): SciSavedBox {
  const r = clipped(surface, rect) ?? { left: 0, top: 0, right: 0, bottom: 0 };
  const copy = (buffer: Uint8Array | null, bit: number): Uint8Array | null => {
    if (!buffer || !(mask & bit)) return null;
    const width = r.right - r.left;
    const out = new Uint8Array(width * (r.bottom - r.top));
    for (let y = r.top; y < r.bottom; y++) {
      out.set(
        buffer.subarray(y * surface.width + r.left, y * surface.width + r.right),
        (y - r.top) * width,
      );
    }
    return out;
  };
  return {
    rect: r,
    mask,
    visual: copy(surface.visual, SCI_SCREEN_MASK.visual),
    priority: copy(surface.priority, SCI_SCREEN_MASK.priority),
    control: copy(surface.control, SCI_SCREEN_MASK.control),
    items: surface.itemCount(),
  };
}

export function sciRestoreBox(surface: SciRoomSurface, saved: SciSavedBox): void {
  const { rect: r } = saved;
  const width = r.right - r.left;
  const paste = (buffer: Uint8Array | null, from: Uint8Array | null): void => {
    if (!buffer || !from) return;
    for (let y = r.top; y < r.bottom; y++) {
      buffer.set(
        from.subarray((y - r.top) * width, (y - r.top + 1) * width),
        y * surface.width + r.left,
      );
    }
  };
  paste(surface.visual, saved.visual);
  paste(surface.priority, saved.priority);
  paste(surface.control, saved.control);
  if (!surface.visual && saved.mask & SCI_SCREEN_MASK.visual) surface.truncateItems(saved.items);
}

/**
 * `GfxView::draw` for an unscaled cel with its top left at (`left`, `top`).
 *
 * A pixel shows where it is not the cel's clear key and `priority` is at
 * least what the priority buffer holds there; it then writes `priority` into
 * that buffer too, unless `priority` is above fifteen — which is how a
 * `DrawCel` with no priority (-1, a byte of 255) draws over everything and
 * occludes nothing.
 */
export function sciDrawCel(
  surface: SciRoomSurface,
  cel: SciCel,
  left: number,
  top: number,
  priority: number,
): void {
  const value = priority & 0xff;
  const writesPriority = value <= 15;
  if (!surface.visual) {
    surface.addItem(cel, left, top, writesPriority ? value : 15);
  }
  for (let y = 0; y < cel.height; y++) {
    const destY = top + y;
    if (destY < 0 || destY >= surface.height) continue;
    for (let x = 0; x < cel.width; x++) {
      const destX = left + x;
      if (destX < 0 || destX >= surface.width) continue;
      const colour = cel.pixels[y * cel.width + x];
      if (colour === cel.clearKey) continue;
      const index = destY * surface.width + destX;
      if (surface.priority && value < surface.priority[index]) continue;
      if (surface.visual) surface.visual[index] = colour;
      if (writesPriority && surface.priority) surface.priority[index] = value;
    }
  }
}

/**
 * `GfxCompare::isOnControl`: one bit per distinct value under `rect` — of the
 * priority buffer when the mask names it, and of the control buffer otherwise.
 */
export function sciOnControl(surface: SciRoomSurface, mask: number, rect: SciRect16): number {
  const r = clipped(surface, rect);
  const buffer = mask & SCI_SCREEN_MASK.priority ? surface.priority : surface.control;
  if (!r || !buffer) return 0;
  let result = 0;
  for (let y = r.top; y < r.bottom; y++) {
    for (let x = r.left; x < r.right; x++) result |= 1 << (buffer[y * surface.width + x] & 0x0f);
  }
  return result & 0xffff;
}
