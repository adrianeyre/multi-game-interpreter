import type { ScaleSlot, WalkBox } from './Room.js';
import { BOX_INVISIBLE, INVALID_BOX } from './Room.js';

export interface Point {
  x: number;
  y: number;
}

/** The four corners of a walk box, in the order SCUMM stores them. */
export interface BoxCorners {
  ul: Point;
  ur: Point;
  lr: Point;
  ll: Point;
}

/** C-style integer division, truncating toward zero. */
function idiv(a: number, b: number): number {
  return b === 0 ? 0 : Math.trunc(a / b);
}

export function boxCorners(box: WalkBox): BoxCorners {
  return {
    ul: { x: box.ulx, y: box.uly },
    ur: { x: box.urx, y: box.ury },
    lr: { x: box.lrx, y: box.lry },
    ll: { x: box.llx, y: box.lly },
  };
}

function rotate(box: BoxCorners): void {
  const tmp = box.ul;
  box.ul = box.ur;
  box.ur = box.lr;
  box.lr = box.ll;
  box.ll = tmp;
}

function sqrDist(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/** True if `p` lies to the left of, or on, the directed line p1 -> p2. */
function compareSlope(p1: Point, p2: Point, p3: Point): boolean {
  return (p2.y - p1.y) * (p3.x - p1.x) <= (p3.y - p1.y) * (p2.x - p1.x);
}

/**
 * Projects `p` onto the segment `lineStart`-`lineEnd`, clamped to its ends.
 *
 * This is a transcription of the original integer routine rather than the
 * floating point formula. The truncation is load bearing: actor destinations
 * differ by a pixel or two otherwise, which is enough to make an actor miss a
 * box edge and get stuck.
 */
export function closestPtOnLine(lineStart: Point, lineEnd: Point, p: Point): Point {
  const lxdiff = lineEnd.x - lineStart.x;
  const lydiff = lineEnd.y - lineStart.y;

  let result: Point;

  if (lineEnd.x === lineStart.x) {
    result = { x: lineStart.x, y: p.y };
  } else if (lineEnd.y === lineStart.y) {
    result = { x: p.x, y: lineStart.y };
  } else {
    const dist = lxdiff * lxdiff + lydiff * lydiff;
    if (Math.abs(lxdiff) > Math.abs(lydiff)) {
      const a = idiv(lineStart.x * lydiff, lxdiff);
      const b = idiv(p.x * lxdiff, lydiff);
      const c = idiv((a + b - lineStart.y + p.y) * lydiff * lxdiff, dist);
      result = { x: c, y: idiv(c * lydiff, lxdiff) - a + lineStart.y };
    } else {
      const a = idiv(lineStart.y * lxdiff, lydiff);
      const b = idiv(p.y * lydiff, lxdiff);
      const c = idiv((a + b - lineStart.x + p.x) * lydiff * lxdiff, dist);
      result = { x: idiv(c * lxdiff, lydiff) - a + lineStart.x, y: c };
    }
  }

  if (Math.abs(lydiff) < Math.abs(lxdiff)) {
    if (lxdiff > 0) {
      if (result.x < lineStart.x) result = { ...lineStart };
      else if (result.x > lineEnd.x) result = { ...lineEnd };
    } else {
      if (result.x > lineStart.x) result = { ...lineStart };
      else if (result.x < lineEnd.x) result = { ...lineEnd };
    }
  } else {
    if (lydiff > 0) {
      if (result.y < lineStart.y) result = { ...lineStart };
      else if (result.y > lineEnd.y) result = { ...lineEnd };
    } else {
      if (result.y > lineStart.y) result = { ...lineStart };
      else if (result.y < lineEnd.y) result = { ...lineEnd };
    }
  }

  return result;
}

/** Nearest point on a box's outline, and the squared distance to it. */
export function closestPtOnBox(box: BoxCorners, p: Point): { point: Point; dist: number } {
  let best = { point: { x: 0, y: 0 }, dist: Number.MAX_SAFE_INTEGER };
  const edges: Array<[Point, Point]> = [
    [box.ul, box.ur],
    [box.ur, box.lr],
    [box.lr, box.ll],
    [box.ll, box.ul],
  ];
  for (const [from, to] of edges) {
    const candidate = closestPtOnLine(from, to, p);
    const dist = sqrDist(p, candidate);
    if (dist < best.dist) best = { point: candidate, dist };
  }
  return best;
}

/**
 * Walk box geometry and routing for one room.
 *
 * Routes are recomputed with Floyd-Warshall rather than read from the room's
 * BOXM chunk. The stored matrix is a compressed form of exactly this result,
 * and recomputing sidesteps both the compression format and the handful of
 * shipped rooms whose stored matrix is wrong.
 */
export class BoxMatrix {
  readonly boxes: WalkBox[];
  private readonly corners: BoxCorners[];
  /** `itinerary[from * n + to]` is the next box to step to, or INVALID_BOX. */
  private readonly itinerary: Uint8Array;
  private readonly scaleSlots: ScaleSlot[];

  constructor(boxes: WalkBox[], scaleSlots: ScaleSlot[] = []) {
    this.boxes = boxes;
    this.scaleSlots = scaleSlots;
    this.corners = boxes.map(boxCorners);
    this.itinerary = this.computeItinerary();
  }

  get count(): number {
    return this.boxes.length;
  }

  getFlags(boxNumber: number): number {
    return this.boxes[boxNumber]?.flags ?? 0;
  }

  getMask(boxNumber: number): number {
    return this.boxes[boxNumber]?.mask ?? 0;
  }

  corner(boxNumber: number): BoxCorners {
    return this.corners[boxNumber];
  }

  /**
   * Effective scale for a point in a box: either the box's own scale byte or,
   * when bit 15 is set, an interpolation from one of the room's scale slots.
   */
  getScale(boxNumber: number, _x: number, y: number): number {
    const box = this.boxes[boxNumber];
    if (!box) return 255;

    let scale = box.scale;
    if (scale & 0x8000) {
      // Bit 15 means "look the scale up in a slot" rather than "this is the
      // scale". The stored index is one less than the slot number.
      const slot = this.scaleSlots[scale & 0x7fff];
      // An all-zero slot is an unwritten one. Interpolating it would return 0
      // and clamp to 1, shrinking the actor to a single pixel.
      if (!slot || (slot.y1 === slot.y2 && slot.scale1 === 0)) return 255;
      scale = interpolateScale(slot, y);
    }
    return Math.max(1, Math.min(255, scale));
  }

  /** Point-in-quadrilateral, following the original's degenerate-box rules. */
  contains(boxNumber: number, x: number, y: number): boolean {
    if (boxNumber < 0 || boxNumber === INVALID_BOX || boxNumber >= this.boxes.length) {
      return false;
    }
    const box = this.corners[boxNumber];
    const p = { x, y };

    // Cheap rejection: outside the bounding box of all four corners.
    if (x < box.ul.x && x < box.ur.x && x < box.lr.x && x < box.ll.x) return false;
    if (x > box.ul.x && x > box.ur.x && x > box.lr.x && x > box.ll.x) return false;
    if (y < box.ul.y && y < box.ur.y && y < box.lr.y && y < box.ll.y) return false;
    if (y > box.ul.y && y > box.ur.y && y > box.lr.y && y > box.ll.y) return false;

    // A box collapsed to a line segment counts as containing points close to
    // it; several rooms use degenerate boxes as walkable corridors.
    const same = (a: Point, b: Point) => a.x === b.x && a.y === b.y;
    if (
      (same(box.ul, box.ur) && same(box.lr, box.ll)) ||
      (same(box.ul, box.ll) && same(box.ur, box.lr))
    ) {
      const projected = closestPtOnLine(box.ul, box.lr, p);
      if (sqrDist(p, projected) <= 4) return true;
    }

    return (
      compareSlope(box.ul, box.ur, p) &&
      compareSlope(box.ur, box.lr, p) &&
      compareSlope(box.lr, box.ll, p) &&
      compareSlope(box.ll, box.ul, p)
    );
  }

  /** The highest-numbered visible box containing the point, or -1. */
  findBoxAt(x: number, y: number): number {
    for (let i = this.boxes.length - 1; i >= 0; i--) {
      if (this.getFlags(i) & BOX_INVISIBLE) continue;
      if (this.contains(i, x, y)) return i;
    }
    return -1;
  }

  /** Nearest walkable point to (x, y), used when a click lands off-box. */
  adjustToBeInBox(
    x: number,
    y: number,
    ignoreInvisible = true,
  ): { x: number; y: number; box: number } {
    const direct = this.findBoxAt(x, y);
    if (direct >= 0) return { x, y, box: direct };

    let best = { x, y, box: INVALID_BOX as number };
    let bestDist = Number.MAX_SAFE_INTEGER;

    for (let i = 0; i < this.boxes.length; i++) {
      const flags = this.getFlags(i);
      if (ignoreInvisible && flags & BOX_INVISIBLE) continue;
      const { point, dist } = closestPtOnBox(this.corners[i], { x, y });
      if (dist < bestDist) {
        bestDist = dist;
        best = { x: point.x, y: point.y, box: i };
      }
    }
    return best;
  }

  /** Next box to move to when travelling `from` -> `to`, or -1 if unreachable. */
  getNextBox(from: number, to: number): number {
    const n = this.boxes.length;
    if (from === to) return to;
    if (from < 0 || to < 0 || from >= n || to >= n) return -1;
    const next = this.itinerary[from * n + to];
    return next === INVALID_BOX ? -1 : next;
  }

  /**
   * Two boxes are neighbours if any of their edges are collinear and overlap.
   *
   * Each box is rotated through its four corner orderings so only the "upper"
   * edge ever needs comparing — 16 comparisons instead of a general segment
   * intersection test.
   */
  areNeighbors(a: number, b: number): boolean {
    if (this.getFlags(a) & BOX_INVISIBLE) return false;
    if (this.getFlags(b) & BOX_INVISIBLE) return false;

    const box2: BoxCorners = cloneCorners(this.corners[a]);
    const box: BoxCorners = cloneCorners(this.corners[b]);

    for (let j = 0; j < 4; j++) {
      for (let k = 0; k < 4; k++) {
        // Shared vertical edge?
        if (box2.ur.x === box2.ul.x && box.ul.x === box2.ul.x && box.ur.x === box2.ul.x) {
          const a1 = Math.min(box2.ul.y, box2.ur.y);
          const a2 = Math.max(box2.ul.y, box2.ur.y);
          const b1 = Math.min(box.ul.y, box.ur.y);
          const b2 = Math.max(box.ul.y, box.ur.y);
          const touchingOnly = (b1 === a2 || b2 === a1) && a2 !== a1 && b1 !== b2;
          if (!(b2 < a1 || b1 > a2 || touchingOnly)) return true;
        }

        // Shared horizontal edge?
        if (box2.ur.y === box2.ul.y && box.ul.y === box2.ul.y && box.ur.y === box2.ul.y) {
          const a1 = Math.min(box2.ul.x, box2.ur.x);
          const a2 = Math.max(box2.ul.x, box2.ur.x);
          const b1 = Math.min(box.ul.x, box.ur.x);
          const b2 = Math.max(box.ul.x, box.ur.x);
          const touchingOnly = (b1 === a2 || b2 === a1) && a2 !== a1 && b1 !== b2;
          if (!(b2 < a1 || b1 > a2 || touchingOnly)) return true;
        }

        rotate(box2);
      }
      rotate(box);
    }
    return false;
  }

  private computeItinerary(): Uint8Array {
    const n = this.boxes.length;
    const itinerary = new Uint8Array(n * n).fill(INVALID_BOX);
    if (n === 0) return itinerary;

    const INF = 255;
    const distance = new Uint8Array(n * n).fill(INF);

    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j) {
          distance[i * n + j] = 0;
          itinerary[i * n + j] = j;
        } else if (this.areNeighbors(i, j)) {
          distance[i * n + j] = 1;
          itinerary[i * n + j] = j;
        }
      }
    }

    // Kleene / Floyd-Warshall closure. n is at most a few dozen, so the cubic
    // cost is irrelevant next to loading the room.
    for (let k = 0; k < n; k++) {
      for (let i = 0; i < n; i++) {
        const dik = distance[i * n + k];
        if (dik === INF) continue;
        for (let j = 0; j < n; j++) {
          if (i === j) continue;
          const dkj = distance[k * n + j];
          if (dkj === INF) continue;
          if (distance[i * n + j] > dik + dkj) {
            distance[i * n + j] = Math.min(INF - 1, dik + dkj);
            itinerary[i * n + j] = itinerary[i * n + k];
          }
        }
      }
    }

    return itinerary;
  }

  /**
   * Finds the point where a walk from `fromBox` should cross into `toBox`.
   *
   * Returns `null` when the actor can head straight for its final destination
   * (the caller then walks to the real target instead of an intermediate one).
   */
  findPathTowards(
    fromBox: number,
    toBox: number,
    destBox: number,
    position: Point,
    destination: Point,
  ): Point | null {
    const box1 = cloneCorners(this.corners[fromBox]);
    const box2 = cloneCorners(this.corners[toBox]);

    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        // Both boxes' upper edges on one vertical line: cross at some y.
        if (box1.ul.x === box1.ur.x && box1.ul.x === box2.ul.x && box1.ul.x === box2.ur.x) {
          let flag = 0;
          if (box1.ul.y > box1.ur.y) {
            [box1.ul.y, box1.ur.y] = [box1.ur.y, box1.ul.y];
            flag |= 1;
          }
          if (box2.ul.y > box2.ur.y) {
            [box2.ul.y, box2.ur.y] = [box2.ur.y, box2.ul.y];
            flag |= 2;
          }

          const disjoint =
            box1.ul.y > box2.ur.y ||
            box2.ul.y > box1.ur.y ||
            ((box1.ur.y === box2.ul.y || box2.ur.y === box1.ul.y) &&
              box1.ul.y !== box1.ur.y &&
              box2.ul.y !== box2.ur.y);

          if (disjoint) {
            if (flag & 1) [box1.ul.y, box1.ur.y] = [box1.ur.y, box1.ul.y];
            if (flag & 2) [box2.ul.y, box2.ur.y] = [box2.ur.y, box2.ul.y];
          } else {
            let pos = position.y;
            if (toBox === destBox) {
              const diffX = destination.x - position.x;
              const diffY = destination.y - position.y;
              const boxDiffX = box1.ul.x - position.x;
              if (diffX !== 0) {
                let t = idiv(diffY * boxDiffX, diffX);
                if (t === 0 && (diffY <= 0 || diffX <= 0) && (diffY >= 0 || diffX >= 0)) {
                  t = -1;
                }
                pos = position.y + t;
              }
            }
            const q = clamp(clamp(pos, box2.ul.y, box2.ur.y), box1.ul.y, box1.ur.y);
            if (q === pos && toBox === destBox) return null;
            return { x: box1.ul.x, y: q };
          }
        }

        // Both upper edges on one horizontal line: cross at some x.
        if (box1.ul.y === box1.ur.y && box1.ul.y === box2.ul.y && box1.ul.y === box2.ur.y) {
          let flag = 0;
          if (box1.ul.x > box1.ur.x) {
            [box1.ul.x, box1.ur.x] = [box1.ur.x, box1.ul.x];
            flag |= 1;
          }
          if (box2.ul.x > box2.ur.x) {
            [box2.ul.x, box2.ur.x] = [box2.ur.x, box2.ul.x];
            flag |= 2;
          }

          const disjoint =
            box1.ul.x > box2.ur.x ||
            box2.ul.x > box1.ur.x ||
            ((box1.ur.x === box2.ul.x || box2.ur.x === box1.ul.x) &&
              box1.ul.x !== box1.ur.x &&
              box2.ul.x !== box2.ur.x);

          if (disjoint) {
            if (flag & 1) [box1.ul.x, box1.ur.x] = [box1.ur.x, box1.ul.x];
            if (flag & 2) [box2.ul.x, box2.ur.x] = [box2.ur.x, box2.ul.x];
          } else {
            let pos = position.x;
            if (toBox === destBox) {
              const diffX = destination.x - position.x;
              const diffY = destination.y - position.y;
              const boxDiffY = box1.ul.y - position.y;
              if (diffY !== 0) pos += idiv(diffX * boxDiffY, diffY);
            }
            const q = clamp(clamp(pos, box2.ul.x, box2.ur.x), box1.ul.x, box1.ur.x);
            if (q === pos && toBox === destBox) return null;
            return { x: q, y: box1.ul.y };
          }
        }

        rotate(box1);
      }
      rotate(box2);
    }

    return null;
  }
}

function cloneCorners(box: BoxCorners): BoxCorners {
  return {
    ul: { ...box.ul },
    ur: { ...box.ur },
    lr: { ...box.lr },
    ll: { ...box.ll },
  };
}

function clamp(value: number, a: number, b: number): number {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return Math.max(lo, Math.min(hi, value));
}

function interpolateScale(slot: ScaleSlot, y: number): number {
  if (slot.y1 === slot.y2) return slot.scale1;
  const clampedY = Math.max(0, y);
  return idiv((slot.scale2 - slot.scale1) * (clampedY - slot.y1), slot.y2 - slot.y1) + slot.scale1;
}
