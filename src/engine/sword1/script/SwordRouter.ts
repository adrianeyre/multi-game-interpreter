/**
 * Broken Sword's walk router: a polygon path-finder with modular walks.
 *
 * Revolution's own header calls it "polygon router with modular walks, 21
 * august 94", and the three stages it names are the three stages here:
 *
 * 1. **A route** — a series of way points through the walk grid's nodes, found
 *    by repeatedly scanning every node pair for a line that crosses no bar
 *    (`getRoute` / `scan` / `newCheck`). This is a shortest-path search whose
 *    edge test is "can a mega actually walk this in one of four stylised
 *    ways", which is why it is not a plain Dijkstra over a visibility graph.
 * 2. **A path** — the smoothest eight-directional route through those points,
 *    chosen to minimise turning, with two 45-degree turns preferred over one
 *    90-degree turn (`smoothestPath` / `smoothCheck`).
 * 3. **A walk** — the actual animation frames, with the mega's step sizes
 *    scaled by its distance up the screen (`slidyPath` / `slidyWalkAnimator`).
 *
 * ## Both animators, and when each runs
 *
 * Stage 3 has two of them and the target direction chooses:
 *
 * - **Slidy** fits whole steps to the path and then slides the mega's feet so
 *   it lands on the exact target. Every walk with a specified end direction
 *   uses it, because the animation that follows expects exact coordinates.
 * - **Solid** takes whole steps and stops wherever the last one lands, with no
 *   sliding at all. `routeFinder` tries it when the end direction is "any"
 *   (`NO_DIRECTIONS`) — a plain click about the room — and falls back to slidy
 *   when it fails, which is exactly what the original does.
 *
 * Solid can fail, and the check is the last thing it does: it re-walks its own
 * module list against the bars at the coordinates it actually reached, and
 * refuses if any leg crosses one or if the point it stopped on sits on a bar.
 * That is why it returns a count rather than a boolean — zero means "use slidy".
 *
 * George gets three things from the solid animator that slidy cannot give him,
 * and they are the visible reason it exists: a three-frame **slow-in** when a
 * walk starts left or right, a **slow-out** when it ends the same way, and the
 * walking turn cycles applied to whole steps. Those frame numbers (296-301,
 * 308, 315, 322, 329, and the +244/+245/+278/+279 offsets) are positions in
 * George's own mega resource and are not derivable from anything smaller.
 *
 * ## Why the arithmetic is transcribed rather than modernised
 *
 * Every `>> 16`, every `/ 2` on a negative, every `+ 1` in a distance estimate
 * is load-bearing. The step sizes come out of the mega's own walk data as 16.16
 * fixed point and the scale ramp is `scaleA * y + scaleB`; a floating-point
 * "improvement" changes which frame a step lands on, and George walks visibly
 * differently. So the integer semantics are kept exactly, including truncation
 * toward zero, which is what C does and what `Math.trunc` does.
 */

import { CPT, ROUTE_NODE_WORDS, type SwordCompact } from '../resource/swordCompact.js';
import { SWORD1_WALKANIM_SIZE } from '../resource/swordDefs.js';
import {
  readSwordWalkBarFields,
  readSwordWalkNodes,
  SWORD1_WALK_GRID_COUNTS_AT,
  SWORD_BAR_BYTES,
} from './swordWalkGrid.js';
import type { SwordResources } from '../resource/SwordResources.js';
import type { SwordObjects } from '../resource/SwordObjects.js';

/** Revolution's caps. Exceeding either is a grid this router refuses. */
export const O_GRID_SIZE = 200;
export const O_ROUTE_SIZE = 50;
export const NO_DIRECTIONS = 8;
export const ROUTE_END_FLAG = 255;
/** Written into a route node's frame to mean "the walk ends here". */
export const WALK_END_FRAME = 512;

/**
 * The diagonal step George's mega data declares, used before it is loaded.
 *
 * `whatTarget` is called by `fnFaceXy` before any walk data is in hand, so it
 * uses these rather than the loaded pair. Revolution's `DIAGONALX`/`DIAGONALY`.
 */
export const DIAGONALX = 36;
export const DIAGONALY = 8;

/** George's and Nico's compact ids, which the animator special-cases. */
const GEORGE = 8388608;
const NICO = 8454144;
/** Frame-table offsets George's extra turn and slow-in/out cycles sit at. */
const SLOW_IN = 9;
const SLOW_OUT = 15;

interface BarData {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
  dx: number;
  dy: number;
  co: number;
}

interface NodeData {
  x: number;
  y: number;
  level: number;
  prev: number;
  dist: number;
}

interface RouteData {
  x: number;
  y: number;
  dirS: number;
  dirD: number;
}

interface PathData {
  x: number;
  y: number;
  dir: number;
  num: number;
}

/** `routeFinder`'s answer, which is what the calling script branches on. */
export const RouteResult = {
  /** No route: the target was off the floor. */
  FAILED: 0,
  FOUND: 1,
  /** Already there; a turn on the spot was produced instead. */
  ALREADY_THERE: 2,
} as const;

/**
 * The direction to face to get from one point to another.
 *
 * Three bands rather than eight equal sectors: flat, diagonal and vertical, with
 * the diagonal band twice as wide as a naive split would make it. That is what
 * makes a mega prefer walking straight over walking diagonally, which is how
 * Broken Sword's walks look.
 */
export function whatTarget(startX: number, startY: number, destX: number, destY: number): number {
  const deltaX = destX - startX;
  const deltaY = destY - startY;
  const right = deltaX > 0;
  const down = deltaY > 0;

  let slope: 0 | 1 | 2;
  if (Math.abs(deltaY) * DIAGONALX < Math.trunc((Math.abs(deltaX) * DIAGONALY) / 2)) slope = 0;
  else if (Math.trunc((Math.abs(deltaY) * DIAGONALX) / 2) > Math.abs(deltaX) * DIAGONALY) slope = 2;
  else slope = 1;

  if (slope === 0) return right ? 2 : 6;
  if (slope === 2) return down ? 4 : 0;
  if (right) return down ? 3 : 1;
  return down ? 5 : 7;
}

export class SwordRouter {
  private bars: BarData[] = [];
  private node: NodeData[] = [];
  private nBars = 0;
  private nNodes = 0;

  private startX = 0;
  private startY = 0;
  private startDir = 0;
  private targetX = 0;
  private targetY = 0;
  private targetDir = 0;
  private scaleA = 0;
  private scaleB = 0;
  private megaId = 0;

  private route: RouteData[] = [];
  private smoothPath: PathData[] = [];
  private modularPath: PathData[] = [];
  private routeLength = 0;

  private framesPerStep = 0;
  private framesPerChar = 0;
  private nWalkFrames = 0;
  private nTurnFrames = 0;
  private dx: number[] = [];
  private dy: number[] = [];
  private modX: number[] = [];
  private modY: number[] = [];
  private diagonalx = DIAGONALX;
  private diagonaly = DIAGONALY;
  private standFrames = 0;
  private turnFramesLeft = 0;
  private turnFramesRight = 0;

  /**
   * Flipped on every walk so consecutive walks start on opposite feet.
   *
   * State that survives between calls, deliberately: without it a mega starts
   * every walk on the same foot, which reads as a stutter.
   */
  private slidyState = false;

  /** The player's last requested target, for a re-route after a collision. */
  private playerTarget = { x: 0, y: 0, dir: 0, stance: 0 };

  /** Why the last call failed, for the stall report. */
  lastFailure: string | undefined;

  constructor(
    private readonly objects: SwordObjects,
    private readonly resources: SwordResources,
  ) {
    this.reset();
  }

  private reset(): void {
    this.bars = Array.from({ length: O_GRID_SIZE }, () => ({
      x1: 0,
      y1: 0,
      x2: 0,
      y2: 0,
      xmin: 0,
      ymin: 0,
      xmax: 0,
      ymax: 0,
      dx: 0,
      dy: 0,
      co: 0,
    }));
    this.node = Array.from({ length: O_GRID_SIZE + 1 }, () => ({
      x: 0,
      y: 0,
      level: 0,
      prev: 0,
      dist: 9999,
    }));
    this.route = Array.from({ length: O_ROUTE_SIZE + 1 }, () => ({ x: 0, y: 0, dirS: 0, dirD: 0 }));
    this.smoothPath = Array.from({ length: O_ROUTE_SIZE + 2 }, () => ({
      x: 0,
      y: 0,
      dir: 0,
      num: 0,
    }));
    this.modularPath = Array.from({ length: O_ROUTE_SIZE + 2 }, () => ({
      x: 0,
      y: 0,
      dir: 0,
      num: 0,
    }));
  }

  setPlayerTarget(x: number, y: number, dir: number, stance: number): void {
    this.playerTarget = { x, y, dir, stance };
  }

  /** The player's last target, for a re-route the collision handler asks for. */
  get playerTargetState(): { x: number; y: number; dir: number; stance: number } {
    return { ...this.playerTarget };
  }

  /**
   * Finds a route and writes the walk into the mega's `o_route`.
   *
   * Returns one of `RouteResult`. `FAILED` is not an error — a script clicks at
   * a point off the floor constantly and branches on the zero.
   */
  routeFinder(id: number, mega: SwordCompact, x: number, y: number, dir: number): number {
    this.lastFailure = undefined;
    this.megaId = id;

    if (!this.loadWalkResources(mega, x, y, dir)) return RouteResult.FAILED;

    this.framesPerStep = this.nWalkFrames >> 1;
    this.framesPerChar = this.nWalkFrames * NO_DIRECTIONS;

    this.standFrames = this.framesPerChar;
    this.turnFramesLeft = this.standFrames;
    this.turnFramesRight = this.standFrames;

    // George and Nico carry extra cycles — head turns, and slow-in/slow-out —
    // laid out after the walk frames. The arithmetic is the layout of their
    // mega resources and is not derivable from anything smaller.
    if (this.megaId === GEORGE) {
      this.turnFramesLeft = 3 * this.framesPerChar + NO_DIRECTIONS + 2 * SLOW_IN + 4 * SLOW_OUT;
      this.turnFramesRight =
        3 * this.framesPerChar + NO_DIRECTIONS + 2 * SLOW_IN + 4 * SLOW_OUT + NO_DIRECTIONS;
    } else if (this.megaId === NICO) {
      this.turnFramesLeft = this.framesPerChar + NO_DIRECTIONS;
      this.turnFramesRight = this.framesPerChar + 2 * NO_DIRECTIONS;
    }

    const routeFlag = this.getRoute();

    if (routeFlag === 2) {
      // Zero-length route: a turn on the spot. `modularPath` is normally
      // `extractRoute`'s output, so it is written by hand here.
      if (this.targetDir > 7) this.targetDir = this.startDir;
      this.modularPath[0] = { dir: this.startDir, num: 0, x: this.startX, y: this.startY };
      this.modularPath[1] = { dir: this.targetDir, num: 0, x: this.startX, y: this.startY };
      this.modularPath[2] = { dir: 9, num: ROUTE_END_FLAG, x: this.startX, y: this.startY };
      this.slidyWalkAnimator(mega);
      return RouteResult.ALREADY_THERE;
    }

    if (routeFlag === 1) {
      this.smoothestPath();

      // A walk with no specified end direction is a plain click about the room,
      // and those get the solid animator: whole steps, no sliding, and George's
      // slow-in and slow-out. It can refuse, and slidy runs instead — the
      // original's own arrangement.
      let solid = 0;
      if (this.targetDir === NO_DIRECTIONS) {
        this.solidPath();
        solid = this.solidWalkAnimator(mega);
      }

      if (!solid) {
        this.slidyPath();
        this.slidyWalkAnimator(mega);
      }
      return RouteResult.FOUND;
    }

    if (routeFlag === 3) {
      this.lastFailure = `the target (${x}, ${y}) is on a walk-grid bar, within a pixel of it`;
    } else {
      this.lastFailure = `no line through the walk grid reaches (${x}, ${y}) from (${this.startX}, ${this.startY})`;
    }
    return RouteResult.FAILED;
  }

  /**
   * Loads the floor's walk grid and the mega's step data.
   *
   * False when either resource is missing, which is recoverable: the caller
   * reports a failed route and the script branches, exactly as it would for a
   * click off the floor.
   */
  private loadWalkResources(mega: SwordCompact, x: number, y: number, dir: number): boolean {
    const floorId = mega.get(CPT.PLACE);
    const floor = this.objects.fetch(floorId);
    if (!floor) {
      this.lastFailure = `the mega's floor object ${floorId} is not in an open section`;
      return false;
    }
    const gridId = floor.get(CPT.RESOURCE);
    const grid = this.resources.fetch(gridId);
    if (!grid) {
      this.lastFailure = `walk grid ${gridId}: ${this.resources.describeMissingResource(gridId)}`;
      return false;
    }

    const big = this.resources.bigEndian;
    const view = new DataView(grid.bytes.buffer, grid.bytes.byteOffset, grid.bytes.byteLength);
    const countsAt = SWORD1_WALK_GRID_COUNTS_AT;
    this.nBars = view.getInt32(countsAt, !big);
    const declaredNodes = view.getInt32(countsAt + 4, !big);

    if (this.nBars < 0 || this.nBars >= O_GRID_SIZE) this.nBars = 0;
    // `+ 1`: the array holds a start node at 0 and a target node at the end, so
    // a grid with n nodes needs n + 2 slots and indexes the target at n + 1.
    this.nNodes = declaredNodes + 1;
    if (this.nNodes < 0 || this.nNodes >= O_GRID_SIZE) this.nNodes = 0;

    // Read through `swordWalkGrid.ts`, which is the one reading of this format
    // the editor also takes apart and writes back — and read with all eleven
    // fields as stored rather than with the seven derived, because a router
    // that derived them would route differently from the shipped game wherever
    // a grid compiler wrote something a derivation does not reproduce.
    const barsAt = countsAt + 8;
    readSwordWalkBarFields(view, barsAt, this.nBars, !big).forEach((bar, index) => {
      Object.assign(this.bars[index], bar);
    });
    readSwordWalkNodes(
      view,
      barsAt + this.nBars * SWORD_BAR_BYTES,
      Math.max(0, this.nNodes - 1),
      !big,
    ).forEach((node, index) => {
      this.node[index + 1].x = node.x;
      this.node[index + 1].y = node.y;
    });

    this.startX = mega.get(CPT.XCOORD);
    this.startY = mega.get(CPT.YCOORD);
    this.startDir = mega.get(CPT.DIR);
    this.targetX = x;
    this.targetY = y;
    this.targetDir = dir;
    this.scaleA = mega.get(CPT.SCALE_A);
    this.scaleB = mega.get(CPT.SCALE_B);

    const megaId = mega.get(CPT.MEGA_RESOURCE);
    const megaRes = this.resources.fetch(megaId);
    if (!megaRes) {
      this.lastFailure = `mega walk data ${megaId}: ${this.resources.describeMissingResource(megaId)}`;
      return false;
    }
    // "Apparently this resource is in little endian in both the Mac and the PC
    // version" — ScummVM's note, and it is why this read ignores `big`.
    const megaView = new DataView(
      megaRes.bytes.buffer,
      megaRes.bytes.byteOffset,
      megaRes.bytes.byteLength,
    );
    let mAt = 0;
    this.nWalkFrames = megaView.getUint8(mAt++);
    this.nTurnFrames = megaView.getUint8(mAt++);
    const steps = NO_DIRECTIONS * (this.nWalkFrames + 1 + this.nTurnFrames);
    this.dx = [];
    this.dy = [];
    for (let step = 0; step < steps; step++) {
      this.dx.push(megaView.getInt32(mAt, true));
      mAt += 4;
    }
    for (let step = 0; step < steps; step++) {
      this.dy.push(megaView.getInt32(mAt, true));
      mAt += 4;
    }
    this.modX = [];
    this.modY = [];
    for (let d = 0; d < NO_DIRECTIONS; d++) {
      this.modX.push(megaView.getInt32(mAt, true));
      mAt += 4;
    }
    for (let d = 0; d < NO_DIRECTIONS; d++) {
      this.modY.push(megaView.getInt32(mAt, true));
      mAt += 4;
    }
    this.diagonalx = this.modX[3] ?? DIAGONALX;
    this.diagonaly = this.modY[3] ?? DIAGONALY;

    // Put the mega at node 0 and the target at the end, and clear the rest.
    this.node[0] = { x: this.startX, y: this.startY, level: 1, prev: 0, dist: 0 };
    for (let n = 1; n < this.nNodes; n++) {
      this.node[n].level = 0;
      this.node[n].prev = 0;
      this.node[n].dist = 9999;
    }
    this.node[this.nNodes] = {
      x: this.targetX,
      y: this.targetY,
      level: 0,
      prev: 0,
      dist: 9999,
    };
    return true;
  }

  /** 0 failed, 1 found, 2 already there, 3 target on a bar. */
  private getRoute(): number {
    let routeGot =
      this.startX === this.targetX && this.startY === this.targetY
        ? 2
        : this.checkTarget(this.targetX, this.targetY);

    if (routeGot === 0) {
      let level = 1;
      while (this.scan(level)) level++;
      if (this.node[this.nNodes].dist < 9999) {
        routeGot = 1;
        this.extractRoute();
      }
    }
    return routeGot;
  }

  /** 3 when the target is within a pixel of a bar, 0 otherwise. */
  private checkTarget(x: number, y: number): number {
    const xmin = x - 1;
    const xmax = x + 1;
    const ymin = y - 1;
    const ymax = y + 1;

    for (let i = 0; i < this.nBars; i++) {
      const bar = this.bars[i];
      if (xmax < bar.xmin || xmin > bar.xmax || ymax < bar.ymin || ymin > bar.ymax) continue;

      const yc = bar.dx === 0 ? 0 : bar.y1 + Math.trunc((bar.dy * (x - bar.x1)) / bar.dx);
      if (yc >= ymin && yc <= ymax) return 3;

      const xc = bar.dy === 0 ? 0 : bar.x1 + Math.trunc((bar.dx * (y - bar.y1)) / bar.dy);
      if (xc >= xmin && xc <= xmax) return 3;
    }
    return 0;
  }

  /**
   * One relaxation pass over the node graph. True when anything improved.
   *
   * The distance estimate's two branches are the flat and the steep case, and
   * the `+ 1` on each is deliberate: a route of many short hops should cost
   * more than one long one even when the pixel distance is the same, because
   * each hop is a turn.
   */
  private scan(level: number): boolean {
    let changed = false;
    const target = this.node[this.nNodes];

    for (let i = 0; i < this.nNodes; i++) {
      const from = this.node[i];
      if (!(from.dist < target.dist && from.level === level)) continue;
      const x1 = from.x;
      const y1 = from.y;

      for (let j = this.nNodes; j > 0; j--) {
        const to = this.node[j];
        if (to.dist <= from.dist) continue;
        const x2 = to.x;
        const y2 = to.y;
        const adx = Math.abs(x2 - x1);
        const ady = Math.abs(y2 - y1);

        // `4.5 * ady` in the original, in floating point, compared against an
        // integer. Multiplying both sides by two keeps it integer and keeps the
        // same comparison — `adx > 4.5 * ady` is `2 * adx > 9 * ady`.
        const distance =
          2 * adx > 9 * ady
            ? Math.trunc((8 * adx + 18 * ady) / (54 * 8)) + 1
            : Math.trunc((6 * adx + 36 * ady) / (36 * 14)) + 1;

        if (distance + from.dist < target.dist && distance + from.dist < to.dist) {
          if (this.newCheck(0, x1, y1, x2, y2)) {
            to.level = level + 1;
            to.dist = distance + from.dist;
            to.prev = i;
            changed = true;
          }
        }
      }
    }
    return changed;
  }

  /**
   * Whether a mega can walk from one point to another, and how.
   *
   * `status === 0` answers a step count (zero means "cannot"); `status === 1`
   * answers a bitmask of which of the four stylised routes are walkable. The
   * same function doing both is Revolution's, and the two callers want exactly
   * these two answers: `scan` wants "can I", `smoothestPath` wants "which ways".
   *
   * The four routes are square-then-diagonal, diagonal-then-square, and the two
   * three-segment variants that split one of them in half. A mega walks in eight
   * directions, so any point is reached by combining a straight run with a
   * diagonal one — these are the four ways to order that.
   */
  private newCheck(status: number, x1: number, y1: number, x2: number, y2: number): number {
    let steps = 0;
    let options = 0;
    let ldx = x2 - x1;
    let ldy = y2 - y1;
    let dirX = 1;
    let dirY = 1;

    if (ldx < 0) {
      ldx = -ldx;
      dirX = -1;
    }
    if (ldy < 0) {
      ldy = -ldy;
      dirY = -1;
    }

    const c = (ax: number, ay: number, bx: number, by: number): number =>
      this.check(ax, ay, bx, by) ? 1 : 0;

    if (this.diagonaly * ldx > this.diagonalx * ldy) {
      // Mostly horizontal: dir is 1,2 or 2,3 or 5,6 or 6,7.
      let dly = ldy;
      let dlx = Math.trunc((ldy * this.diagonalx) / this.diagonaly);
      ldx = ldx - dlx;
      dlx = dlx * dirX;
      dly = dly * dirY;
      ldx = ldx * dirX;
      // `ldy` is consumed into `dly` above and is zero for the rest of this
      // branch by construction; the original assigns it and never reads it.

      let step1 = c(x1, y1, x1 + ldx, y1);
      if (step1) {
        const step2 = c(x1 + ldx, y1, x2, y2);
        if (step2) {
          steps = step1 + step2;
          options |= 2;
        }
      }
      if (steps === 0 || status === 1) {
        step1 = c(x1, y1, x1 + dlx, y1 + dly);
        if (step1) {
          const step2 = c(x1 + dlx, y2, x2, y2);
          if (step2) {
            steps = step1 + step2;
            options |= 4;
          }
        }
      }
      if (steps === 0 || status === 1) {
        const half = Math.trunc(ldx / 2);
        step1 = c(x1, y1, x1 + half, y1);
        if (step1) {
          const step2 = c(x1 + half, y1, x1 + half + dlx, y2);
          if (step2) {
            const step3 = c(x1 + half + dlx, y2, x2, y2);
            if (step3) {
              steps = step1 + step2 + step3;
              options |= 1;
            }
          }
        }
      }
      if (steps === 0 || status === 1) {
        const hx = Math.trunc(dlx / 2);
        const hy = Math.trunc(dly / 2);
        step1 = c(x1, y1, x1 + hx, y1 + hy);
        if (step1) {
          const step2 = c(x1 + hx, y1 + hy, x1 + ldx + hx, y1 + hy);
          if (step2) {
            const step3 = c(x1 + ldx + hx, y1 + hy, x2, y2);
            if (step3) {
              steps = step1 + step2 + step3;
              options |= 8;
            }
          }
        }
      }
    } else {
      // Mostly vertical: dir is 7,0 or 0,1 or 3,4 or 4,5.
      let dlx = ldx;
      let dly = Math.trunc((ldx * this.diagonaly) / this.diagonalx);
      ldy = ldy - dly;
      dlx = dlx * dirX;
      dly = dly * dirY;
      ldy = ldy * dirY;
      // `ldx` is consumed into `dlx` above and is zero for the rest of this
      // branch by construction; the original assigns it and never reads it.

      let step1 = c(x1, y1, x1, y1 + ldy);
      if (step1) {
        const step2 = c(x1, y1 + ldy, x2, y2);
        if (step2) {
          steps = step1 + step2;
          options |= 2;
        }
      }
      if (steps === 0 || status === 1) {
        step1 = c(x1, y1, x2, y1 + dly);
        if (step1) {
          const step2 = c(x2, y1 + dly, x2, y2);
          if (step2) {
            steps = step1 + step2;
            options |= 4;
          }
        }
      }
      if (steps === 0 || status === 1) {
        const half = Math.trunc(ldy / 2);
        step1 = c(x1, y1, x1, y1 + half);
        if (step1) {
          const step2 = c(x1, y1 + half, x1, y1 + half + dly);
          if (step2) {
            const step3 = c(x2, y1 + half + dly, x2, y2);
            if (step3) {
              steps = step1 + step2 + step3;
              options |= 1;
            }
          }
        }
      }
      if (steps === 0 || status === 1) {
        const hx = Math.trunc(dlx / 2);
        const hy = Math.trunc(dly / 2);
        step1 = c(x1, y1, x1 + hx, y1 + hy);
        if (step1) {
          const step2 = c(x1 + hx, y1 + hy, x1 + hx, y1 + ldy + hy);
          if (step2) {
            const step3 = c(x1 + hx, y1 + ldy + hy, x2, y2);
            if (step3) {
              steps = step1 + step2 + step3;
              options |= 8;
            }
          }
        }
      }
    }

    return status === 0 ? steps : options;
  }

  /** True when the line crosses no bar. Dispatches to the cheapest test. */
  private check(x1: number, y1: number, x2: number, y2: number): boolean {
    if (x1 === x2 && y1 === y2) return true;
    if (x1 === x2) return this.vertCheck(x1, y1, y2);
    if (y1 === y2) return this.horizCheck(x1, y1, x2);
    return this.lineCheck(x1, y1, x2, y2);
  }

  private horizCheck(x1: number, y: number, x2: number): boolean {
    const xmin = Math.min(x1, x2);
    const xmax = Math.max(x1, x2);
    for (let i = 0; i < this.nBars; i++) {
      const bar = this.bars[i];
      if (xmax < bar.xmin || xmin > bar.xmax || y < bar.ymin || y > bar.ymax) continue;
      // A horizontal bar overlapping in both axes crosses by definition.
      if (bar.dy === 0) return false;
      const xc = bar.x1 + Math.trunc((bar.dx * (y - bar.y1)) / bar.dy);
      if (xc >= xmin - 1 && xc <= xmax + 1) return false;
    }
    return true;
  }

  private vertCheck(x: number, y1: number, y2: number): boolean {
    const ymin = Math.min(y1, y2);
    const ymax = Math.max(y1, y2);
    for (let i = 0; i < this.nBars; i++) {
      const bar = this.bars[i];
      if (x < bar.xmin || x > bar.xmax || ymax < bar.ymin || ymin > bar.ymax) continue;
      if (bar.dx === 0) return false;
      const yc = bar.y1 + Math.trunc((bar.dy * (x - bar.x1)) / bar.dx);
      if (yc >= ymin - 1 && yc <= ymax + 1) return false;
    }
    return true;
  }

  private lineCheck(x1: number, y1: number, x2: number, y2: number): boolean {
    const xmin = Math.min(x1, x2);
    const xmax = Math.max(x1, x2);
    const ymin = Math.min(y1, y2);
    const ymax = Math.max(y1, y2);
    const dirx = x2 - x1;
    const diry = y2 - y1;
    const co = y1 * dirx - x1 * diry;

    for (let i = 0; i < this.nBars; i++) {
      const bar = this.bars[i];
      if (xmax < bar.xmin || xmin > bar.xmax || ymax < bar.ymin || ymin > bar.ymax) continue;
      const slope = bar.dx * diry - bar.dy * dirx;
      // Parallel lines are assumed not to cross, which is Revolution's call and
      // is correct for a walk grid: a bar a mega walks exactly along is not a
      // bar it crosses.
      if (slope === 0) continue;
      const xc = Math.trunc((bar.co * dirx - co * bar.dx) / slope);
      if (xc < xmin - 1 || xc > xmax + 1) continue;
      if (xc < bar.xmin - 1 || xc > bar.xmax + 1) continue;
      const yc = Math.trunc((bar.co * diry - co * bar.dy) / slope);
      if (yc < ymin - 1 || yc > ymax + 1) continue;
      if (yc < bar.ymin - 1 || yc > bar.ymax + 1) continue;
      return false;
    }
    return true;
  }

  /**
   * Turns the node chain into a route with a straight and a diagonal option
   * per leg.
   *
   * Two directions per leg rather than one, because the smoother decides later
   * which to prefer: `dirS` is the straight run's direction and `dirD` the
   * diagonal's, and every leg can be walked as some mix of the two.
   */
  private extractRoute(): void {
    let prev = this.nNodes;
    let last = prev;
    let point = O_ROUTE_SIZE - 1;
    this.route[point].x = this.node[last].x;
    this.route[point].y = this.node[last].y;

    do {
      point--;
      prev = this.node[last].prev;
      this.route[point].x = this.node[prev].x;
      this.route[point].y = this.node[prev].y;
      last = prev;
    } while (prev > 0 && point > 0);

    this.routeLength = 0;
    while (point < O_ROUTE_SIZE) {
      this.route[this.routeLength].x = this.route[point].x;
      this.route[this.routeLength].y = this.route[point].y;
      point++;
      this.routeLength++;
    }
    this.routeLength--;

    let p: number;
    for (p = 0; p < this.routeLength; p++) {
      let ldx = this.route[p + 1].x - this.route[p].x;
      let ldy = this.route[p + 1].y - this.route[p].y;
      let dirx = 1;
      let diry = 1;
      if (ldx < 0) {
        ldx = -ldx;
        dirx = -1;
      }
      if (ldy < 0) {
        ldy = -ldy;
        diry = -1;
      }

      if (this.diagonaly * ldx > this.diagonalx * ldy) {
        const dir = 4 - 2 * dirx;
        this.route[p].dirS = dir;
        this.route[p].dirD = dir + diry * dirx;
      } else {
        this.route[p].dirS = 2 + 2 * diry;
        this.route[p].dirD = 4 - 2 * dirx + diry * dirx;
      }
    }

    if (this.targetDir === NO_DIRECTIONS) {
      this.route[p].dirS = this.route[Math.max(0, p - 1)].dirS;
      this.route[p].dirD = this.route[Math.max(0, p - 1)].dirD;
    } else {
      this.route[p].dirS = this.targetDir;
      this.route[p].dirD = this.targetDir;
    }
  }

  /**
   * Chooses, per leg, the least-turning of the four walkable routes.
   *
   * The `turntable` maps a direction difference to a *turn cost*, and it is not
   * linear: `{0, 1, 3, 5, 7, 5, 3, 1}` says one step round is cheap, a
   * half-turn is expensive, and turning left costs the same as turning right.
   * The `+ 3` on options 0 and 3 is Revolution's weight against split routes —
   * "split routes look crap".
   */
  private smoothestPath(): void {
    const turntable = [0, 1, 3, 5, 7, 5, 3, 1];
    const steps = { value: 0 };
    let lastDir = this.startDir;

    this.smoothPath[0] = { x: this.startX, y: this.startY, dir: this.startDir, num: 0 };

    for (let p = 0; p < this.routeLength; p++) {
      const dirS = this.route[p].dirS;
      const dirD = this.route[p].dirD;
      const nextDirS = this.route[p + 1].dirS;
      const nextDirD = this.route[p + 1].dirD;

      const wrap = (value: number): number => (value < 0 ? value + NO_DIRECTIONS : value);
      const dS = turntable[wrap(dirS - lastDir)];
      const dD = turntable[wrap(dirD - lastDir)];
      let dSS = turntable[wrap(dirS - nextDirS)];
      let dDD = turntable[wrap(dirD - nextDirD)];
      const dSD = turntable[wrap(dirS - nextDirD)];
      const dDS = turntable[wrap(dirD - nextDirS)];

      if (dSD < dSS) dSS = dSD;
      if (dDS < dDD) dDD = dDS;

      const tempturns = [dS + dSS + 3, dS + dDD, dD + dSS, dD + dDD + 3];
      const turns = [0, 1, 2, 3];
      // A three-pass bubble over four entries, exactly as the original: the
      // order of equal-cost options is what decides which walk the player sees,
      // so a different stable sort is a different-looking game.
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          if (tempturns[j] > tempturns[j + 1]) {
            [turns[j], turns[j + 1]] = [turns[j + 1], turns[j]];
            [tempturns[j], tempturns[j + 1]] = [tempturns[j + 1], tempturns[j]];
          }
        }
      }

      const options = this.newCheck(
        1,
        this.route[p].x,
        this.route[p].y,
        this.route[p + 1].x,
        this.route[p + 1].y,
      );

      let chosen = -1;
      for (let i = 0; i < 4; i++) {
        if (options & (1 << turns[i])) {
          this.smoothCheck(steps, turns[i], p, dirS, dirD);
          chosen = turns[i];
          break;
        }
      }
      if (chosen < 0) {
        // ScummVM asserts here. A leg the scan said was walkable and the
        // smoother says is not means the two disagree, which is a bug rather
        // than a game state — so it is recorded and the leg is walked by its
        // straight-then-diagonal option, which is the one `scan` proved.
        this.lastFailure = `leg ${p} of the route was found by the scan and rejected by the smoother`;
        this.smoothCheck(steps, 1, p, dirS, dirD);
      }
      lastDir = chosen === 0 || chosen === 1 ? dirS : dirD;
    }

    this.smoothPath[steps.value].dir = 9;
    this.smoothPath[steps.value].num = ROUTE_END_FLAG;
  }

  /** Writes one leg's two or three segments into `smoothPath`. */
  private smoothCheck(
    k: { value: number },
    best: number,
    p: number,
    dirS: number,
    dirD: number,
  ): void {
    if (p === 0) k.value = 1;

    const x = this.route[p].x;
    const y = this.route[p].y;
    const x2 = this.route[p + 1].x;
    const y2 = this.route[p + 1].y;
    let ldx = x2 - x;
    let ldy = y2 - y;
    let dirX = 1;
    let dirY = 1;
    if (ldx < 0) {
      ldx = -ldx;
      dirX = -1;
    }
    if (ldy < 0) {
      ldy = -ldy;
      dirY = -1;
    }

    let dsx: number;
    let dsy: number;
    let ddx: number;
    let ddy: number;
    let ss0: number;
    let sd0: number;

    // The step counts are a *rounded* division by the mega's own step size for
    // that direction — `(distance + step/2) / step`. Truncating instead makes
    // every leg one step short, which accumulates into a mega that never
    // arrives.
    if (dirS === 0 || dirS === 4) {
      ddx = ldx;
      ddy = Math.trunc((ldx * this.diagonaly) / this.diagonalx);
      dsy = ldy - ddy;
      ddx = ddx * dirX;
      ddy = ddy * dirY;
      dsy = dsy * dirY;
      dsx = 0;
      const stepD = this.modX[dirD] || 1;
      const stepS = this.modY[dirS] || 1;
      sd0 = Math.trunc((ddx + Math.trunc(stepD / 2)) / stepD);
      ss0 = Math.trunc((dsy + Math.trunc(stepS / 2)) / stepS);
    } else {
      ddy = ldy;
      ddx = Math.trunc((ldy * this.diagonalx) / this.diagonaly);
      dsx = ldx - ddx;
      ddy = ddy * dirY;
      ddx = ddx * dirX;
      dsx = dsx * dirX;
      dsy = 0;
      const stepD = this.modY[dirD] || 1;
      const stepS = this.modX[dirS] || 1;
      sd0 = Math.trunc((ddy + Math.trunc(stepD / 2)) / stepD);
      ss0 = Math.trunc((dsx + Math.trunc(stepS / 2)) / stepS);
    }
    const sd1 = Math.trunc(sd0 / 2);
    const ss1 = Math.trunc(ss0 / 2);
    const sd2 = sd0 - sd1;
    const ss2 = ss0 - ss1;

    const put = (px: number, py: number, dir: number, num: number): void => {
      if (k.value >= this.smoothPath.length) return;
      this.smoothPath[k.value] = { x: px, y: py, dir, num };
      k.value++;
    };

    switch (best) {
      case 0: // halfsquare, diagonal, halfsquare
        put(x + Math.trunc(dsx / 2), y + Math.trunc(dsy / 2), dirS, ss1);
        put(x + Math.trunc(dsx / 2) + ddx, y + Math.trunc(dsy / 2) + ddy, dirD, sd0);
        put(x + dsx + ddx, y + dsy + ddy, dirS, ss2);
        break;
      case 1: // square, diagonal
        put(x + dsx, y + dsy, dirS, ss0);
        put(x2, y2, dirD, sd0);
        break;
      case 2: // diagonal, square
        put(x + ddx, y + ddy, dirD, sd0);
        put(x2, y2, dirS, ss0);
        break;
      default: // halfdiagonal, square, halfdiagonal
        put(x + Math.trunc(ddx / 2), y + Math.trunc(ddy / 2), dirD, sd1);
        put(x + dsx + Math.trunc(ddx / 2), y + dsy + Math.trunc(ddy / 2), dirS, ss0);
        put(x2, y2, dirD, sd2);
        break;
    }
  }

  /**
   * Strips the segments too short to be worth a step.
   *
   * "A quarter of a step minimum" — the `>> 19` is `* scale >> 16` for the step
   * size then `/ 8`, and a segment shorter than that in both axes is dropped
   * rather than walked, because walking it would be a single frame of shuffle.
   */
  private slidyPath(): void {
    let smooth = 1;
    let slidy = 1;
    this.modularPath[0] = {
      x: this.smoothPath[0].x,
      y: this.smoothPath[0].y,
      dir: this.smoothPath[0].dir,
      num: 0,
    };

    while (
      smooth < this.smoothPath.length &&
      this.smoothPath[smooth].num < ROUTE_END_FLAG &&
      slidy < this.modularPath.length - 2
    ) {
      const scale = this.scaleA * this.smoothPath[smooth].y + this.scaleB;
      const deltaX = this.smoothPath[smooth].x - this.modularPath[slidy - 1].x;
      const deltaY = this.smoothPath[smooth].y - this.modularPath[slidy - 1].y;
      const stepX = (scale * this.modX[this.smoothPath[smooth].dir]) >> 19;
      const stepY = (scale * this.modY[this.smoothPath[smooth].dir]) >> 19;

      if (Math.abs(deltaX) >= Math.abs(stepX) && Math.abs(deltaY) >= Math.abs(stepY)) {
        this.modularPath[slidy] = {
          x: this.smoothPath[smooth].x,
          y: this.smoothPath[smooth].y,
          dir: this.smoothPath[smooth].dir,
          num: 1,
        };
        slidy++;
      }
      smooth++;
    }

    // In case the last bit had no steps, the final module takes the smooth
    // path's own end point — otherwise the walk stops wherever the last kept
    // segment happened to be.
    if (slidy > 1) {
      this.modularPath[slidy - 1].x = this.smoothPath[smooth - 1].x;
      this.modularPath[slidy - 1].y = this.smoothPath[smooth - 1].y;
    }

    this.modularPath[slidy] = {
      x: this.smoothPath[smooth - 1].x,
      y: this.smoothPath[smooth - 1].y,
      dir: this.targetDir,
      num: 0,
    };
    slidy++;
    this.modularPath[slidy] = {
      x: this.smoothPath[smooth - 1].x,
      y: this.smoothPath[smooth - 1].y,
      dir: 9,
      num: ROUTE_END_FLAG,
    };
  }

  /**
   * Turns the module list into walk frames, sliding to hit the exact target.
   *
   * The longest function here and the one with the most incidental-looking
   * detail, all of which is visible on screen: the stand frame at the start so
   * collisions are detected before the mega moves, the head turn George and
   * Nico get before rotating, the step back through 45 degrees because the head
   * turn overshoots, and the error redistribution at the end of each module that
   * spreads the slide across its frames rather than snapping on the last one.
   */
  private slidyWalkAnimator(mega: SwordCompact): void {
    const route = mega.words;
    const routeBase = CPT.ROUTE >> 2;
    const maxSteps = SWORD1_WALKANIM_SIZE - 3;

    const write = (
      stepCount: number,
      frame: number,
      step: number,
      dir: number,
      x: number,
      y: number,
    ): void => {
      if (stepCount < 0 || stepCount >= maxSteps) return;
      const at = routeBase + stepCount * ROUTE_NODE_WORDS;
      route[at] = frame;
      route[at + 1] = x;
      route[at + 2] = y;
      route[at + 3] = step;
      route[at + 4] = dir;
    };
    const nodeX = (stepCount: number): number =>
      route[routeBase + stepCount * ROUTE_NODE_WORDS + 1] ?? 0;
    const nodeY = (stepCount: number): number =>
      route[routeBase + stepCount * ROUTE_NODE_WORDS + 2] ?? 0;
    const addX = (stepCount: number, delta: number): void => {
      const at = routeBase + stepCount * ROUTE_NODE_WORDS + 1;
      if (at < route.length) route[at] += delta;
    };
    const addY = (stepCount: number, delta: number): void => {
      const at = routeBase + stepCount * ROUTE_NODE_WORDS + 2;
      if (at < route.length) route[at] += delta;
    };
    const addFrame = (stepCount: number, delta: number): void => {
      const at = routeBase + stepCount * ROUTE_NODE_WORDS;
      if (at >= routeBase && at < route.length) route[at] += delta;
    };

    let p = 0;
    let lastDir = this.modularPath[0].dir;
    let currentDir = this.modularPath[1].dir;
    if (currentDir === NO_DIRECTIONS) currentDir = lastDir;

    let moduleX = this.startX;
    let moduleY = this.startY;
    let module16X = moduleX * 0x10000;
    let module16Y = moduleY * 0x10000;
    let stepCount = 0;

    // Start on a stand frame. This costs a frame of delay and is what makes
    // collisions get noticed before the mega commits to moving.
    write(stepCount++, this.framesPerChar + lastDir, 0, lastDir, moduleX, moduleY);

    if (lastDir !== currentDir) {
      let turnDir = currentDir - lastDir;
      if (turnDir < 0) turnDir += NO_DIRECTIONS;
      if (turnDir > 4) turnDir = -1;
      else if (turnDir > 0) turnDir = 1;

      if (this.megaId === GEORGE || this.megaId === NICO) {
        const base = turnDir < 0 ? this.turnFramesLeft : this.turnFramesRight;
        write(stepCount++, base + lastDir, 0, lastDir, moduleX, moduleY);
      }

      while (lastDir !== currentDir) {
        lastDir += turnDir;
        if (turnDir < 0) {
          if (lastDir < 0) lastDir += NO_DIRECTIONS;
          write(stepCount++, this.turnFramesLeft + lastDir, 0, lastDir, moduleX, moduleY);
        } else {
          if (lastDir > 7) lastDir -= NO_DIRECTIONS;
          write(stepCount++, this.turnFramesRight + lastDir, 0, lastDir, moduleX, moduleY);
        }
      }
      // Back 45 degrees: George's head turn takes him one step past the new
      // direction, so the last frame written is dropped.
      stepCount -= 1;
    }

    let lastRealDir = currentDir;
    this.slidyState = !this.slidyState;

    let lastCount = stepCount;
    // 99 is "no direction yet", which suppresses turn frames at the start.
    lastDir = 99;
    currentDir = 99;

    do {
      while (this.modularPath[p]?.num === 0) {
        p += 1;
        if (currentDir !== 99) lastRealDir = currentDir;
        lastDir = currentDir;
        lastCount = stepCount;
        if (p >= this.modularPath.length) break;
      }
      if (p >= this.modularPath.length) break;

      currentDir = this.modularPath[p].dir;
      if (currentDir < NO_DIRECTIONS) {
        let module =
          currentDir * this.framesPerStep * 2 + (this.slidyState ? this.framesPerStep : 0);
        this.slidyState = !this.slidyState;
        const moduleEnd = module + this.framesPerStep;
        let step = 0;
        const scale = this.scaleA * moduleY + this.scaleB;
        do {
          module16X += (this.dx[module] ?? 0) * scale;
          module16Y += (this.dy[module] ?? 0) * scale;
          moduleX = Math.floor(module16X / 0x10000);
          moduleY = Math.floor(module16Y / 0x10000);
          write(stepCount, module, step, currentDir, moduleX, moduleY);
          stepCount += 1;
          step += 1;
          module += 1;
        } while (module < moduleEnd && stepCount < maxSteps);

        const stepX = this.modX[this.modularPath[p].dir];
        const stepY = this.modY[this.modularPath[p].dir];
        let errorX = (this.modularPath[p].x - moduleX) * stepX;
        let errorY = (this.modularPath[p].y - moduleY) * stepY;

        if (errorX < 0 || errorY < 0) {
          this.modularPath[p].num = 0;
          let frames = stepCount - lastCount;
          errorX = this.modularPath[p].x - nodeX(stepCount - 1);
          errorY = this.modularPath[p].y - nodeY(stepCount - 1);

          // Did we overshoot? If the stop one whole step back was three times
          // closer, take that one instead — "do we want to scoot or moonwalk".
          if (frames > this.framesPerStep) {
            const lastErrorX = this.modularPath[p].x - nodeX(stepCount - 7);
            const lastErrorY = this.modularPath[p].y - nodeY(stepCount - 7);
            if (stepX === 0) {
              if (3 * Math.abs(lastErrorY) < Math.abs(errorY)) {
                stepCount -= this.framesPerStep;
                this.slidyState = !this.slidyState;
              }
            } else if (3 * Math.abs(lastErrorX) < Math.abs(errorX)) {
              stepCount -= this.framesPerStep;
              this.slidyState = !this.slidyState;
            }
          }

          errorX = this.modularPath[p].x - nodeX(stepCount - 1);
          errorY = this.modularPath[p].y - nodeY(stepCount - 1);
          frames = stepCount - lastCount;
          // Spread the remaining error across the module's frames, so the mega
          // slides a little on each rather than jumping on the last.
          if (errorX !== 0 && frames > 0) {
            for (let frameCount = 1; frameCount <= frames; frameCount++) {
              addX(lastCount + frameCount - 1, Math.trunc((errorX * frameCount) / frames));
            }
          }
          if (errorY !== 0 && frames > 0) {
            for (let frameCount = 1; frameCount <= frames; frameCount++) {
              addY(lastCount + frameCount - 1, Math.trunc((errorY * frameCount) / frames));
            }
          }

          if (frames < this.framesPerStep) currentDir = 99;
          if (currentDir !== 99) lastRealDir = currentDir;

          // George's walking turn cycles: +104 for a left turn and +200 for a
          // right one, applied to the *previous* module's frames so the turn
          // reads as part of the step before the corner.
          if (lastDir !== 99 && currentDir !== 99 && this.megaId === GEORGE) {
            const delta = currentDir - lastDir;
            if (delta === -1 || delta === 7 || delta === -2 || delta === 6) {
              for (let frame = lastCount - this.framesPerStep; frame < lastCount; frame++) {
                addFrame(frame, 104);
              }
            }
            if (delta === 1 || delta === -7 || delta === 2 || delta === -6) {
              for (let frame = lastCount - this.framesPerStep; frame < lastCount; frame++) {
                addFrame(frame, 200);
              }
            }
            lastDir = currentDir;
          }

          lastCount = stepCount;
          moduleX = nodeX(stepCount - 1);
          moduleY = nodeY(stepCount - 1);
          module16X = moduleX * 0x10000;
          module16Y = moduleY * 0x10000;
        }
      }
    } while (
      p < this.modularPath.length &&
      this.modularPath[p].dir < NO_DIRECTIONS &&
      stepCount < maxSteps
    );

    if (lastRealDir === 99) {
      // ScummVM errors out. Facing the start direction is the recoverable
      // answer: the walk is already written and the mega stands somewhere real.
      this.lastFailure = 'the walk produced no direction, so the mega keeps the one it started in';
      lastRealDir = this.startDir;
    }

    if (this.targetDir === NO_DIRECTIONS) {
      this.targetDir = lastRealDir;
      write(stepCount++, this.standFrames + lastRealDir, 0, lastRealDir, moduleX, moduleY);
    }

    if (this.targetDir === 9) {
      if (stepCount === 0) {
        write(stepCount++, this.framesPerChar + lastRealDir, 0, lastRealDir, moduleX, moduleY);
      }
    } else if (this.targetDir !== lastRealDir) {
      let turnDir = this.targetDir - lastRealDir;
      if (turnDir < 0) turnDir += NO_DIRECTIONS;
      if (turnDir > 4) turnDir = -1;
      else if (turnDir > 0) turnDir = 1;

      if (this.megaId === GEORGE || this.megaId === NICO) {
        const base = turnDir < 0 ? this.turnFramesLeft : this.turnFramesRight;
        write(stepCount++, base + lastDir, 0, lastRealDir, moduleX, moduleY);
      }
      while (lastRealDir !== this.targetDir) {
        lastRealDir += turnDir;
        if (turnDir < 0) {
          if (lastRealDir < 0) lastRealDir += NO_DIRECTIONS;
          write(stepCount++, this.turnFramesLeft + lastRealDir, 0, lastRealDir, moduleX, moduleY);
        } else {
          if (lastRealDir > 7) lastRealDir -= NO_DIRECTIONS;
          write(stepCount++, this.turnFramesRight + lastRealDir, 0, lastRealDir, moduleX, moduleY);
        }
      }
      addFrame(stepCount - 1, 0);
      const at = routeBase + (stepCount - 1) * ROUTE_NODE_WORDS;
      if (at >= 0 && at < route.length) route[at] = this.standFrames + lastRealDir;
    } else {
      write(stepCount++, this.standFrames + lastRealDir, 0, lastRealDir, moduleX, moduleY);
    }

    // Three end markers, which is what the original writes. `logicArAnimate`
    // stops at the first; the other two are slack for the code that peeks one
    // node ahead.
    for (let extra = 0; extra < 3; extra++) {
      write(stepCount + extra, WALK_END_FRAME, 0, 0, moduleX, moduleY);
    }
  }

  /**
   * Strips the short sections, keeping only whole steps.
   *
   * The difference from `slidyPath` is the shift: `>> 16` here against `>> 19`
   * there. Slidy keeps a segment worth a quarter of a step; solid keeps only one
   * worth a whole step, because it will not slide to make up the difference.
   */
  private solidPath(): void {
    let smooth = 1;
    let solid = 1;
    this.modularPath[0] = {
      x: this.smoothPath[0].x,
      y: this.smoothPath[0].y,
      dir: this.smoothPath[0].dir,
      num: 0,
    };

    do {
      const scale = this.scaleA * this.smoothPath[smooth].y + this.scaleB;
      const deltaX = this.smoothPath[smooth].x - this.modularPath[solid - 1].x;
      const deltaY = this.smoothPath[smooth].y - this.modularPath[solid - 1].y;
      const stepX = (scale * this.modX[this.smoothPath[smooth].dir]) >> 16;
      const stepY = (scale * this.modY[this.smoothPath[smooth].dir]) >> 16;

      if (Math.abs(deltaX) >= Math.abs(stepX) && Math.abs(deltaY) >= Math.abs(stepY)) {
        this.modularPath[solid] = {
          x: this.smoothPath[smooth].x,
          y: this.smoothPath[smooth].y,
          dir: this.smoothPath[smooth].dir,
          num: 1,
        };
        solid++;
      }
      smooth++;
    } while (
      smooth < this.smoothPath.length &&
      this.smoothPath[smooth].num < ROUTE_END_FLAG &&
      solid < this.modularPath.length - 2
    );

    // No whole step fitted anywhere: a dummy end, so the animator produces a
    // turn on the spot rather than reading past the list.
    if (solid === 1) {
      solid = 2;
      this.modularPath[1] = {
        x: this.smoothPath[0].x,
        y: this.smoothPath[0].y,
        dir: this.smoothPath[0].dir,
        num: 0,
      };
    }

    this.modularPath[solid - 1].x = this.smoothPath[smooth - 1].x;
    this.modularPath[solid - 1].y = this.smoothPath[smooth - 1].y;
    this.modularPath[solid] = {
      x: this.smoothPath[smooth - 1].x,
      y: this.smoothPath[smooth - 1].y,
      dir: 9,
      num: ROUTE_END_FLAG,
    };
  }

  /**
   * Turns the module list into whole-step walk frames, or refuses.
   *
   * Returns how many modules were walked, or 0 when the route it built crosses
   * a bar or ends on one — in which case the caller builds a slidy walk
   * instead. That check at the end is the whole reason this can fail: solid
   * steps do not land where the path said, so the path has to be re-tested
   * against the geometry at the coordinates actually reached.
   */
  private solidWalkAnimator(mega: SwordCompact): number {
    const route = mega.words;
    const routeBase = CPT.ROUTE >> 2;
    const maxSteps = SWORD1_WALKANIM_SIZE - 3;

    const write = (
      at: number,
      frame: number,
      step: number,
      dir: number,
      x: number,
      y: number,
    ): void => {
      if (at < 0 || at >= maxSteps) return;
      const to = routeBase + at * ROUTE_NODE_WORDS;
      route[to] = frame;
      route[to + 1] = x;
      route[to + 2] = y;
      route[to + 3] = step;
      route[to + 4] = dir;
    };
    const frameAt = (at: number): number => route[routeBase + at * ROUTE_NODE_WORDS] ?? 0;
    const addFrame = (at: number, delta: number): void => {
      const to = routeBase + at * ROUTE_NODE_WORDS;
      if (to >= 0 && to < route.length) route[to] += delta;
    };
    const nodeX = (at: number): number => route[routeBase + at * ROUTE_NODE_WORDS + 1] ?? 0;
    const nodeY = (at: number): number => route[routeBase + at * ROUTE_NODE_WORDS + 2] ?? 0;

    let lastDir = this.modularPath[0].dir;
    let currentDir = this.modularPath[1].dir;
    let module = this.framesPerChar + lastDir;
    let moduleX = this.startX;
    let moduleY = this.startY;
    let module16X = moduleX * 0x10000;
    let module16Y = moduleY * 0x10000;
    let slowStart = 0;
    let stepCount = 0;

    // A stand frame first, so a collision is noticed before the mega commits.
    write(stepCount++, module, 0, lastDir, moduleX, moduleY);

    if (lastDir !== currentDir) {
      let turnDir = currentDir - lastDir;
      if (turnDir < 0) turnDir += NO_DIRECTIONS;
      if (turnDir > 4) turnDir = -1;
      else if (turnDir > 0) turnDir = 1;

      if (this.megaId === GEORGE || this.megaId === NICO) {
        const base = turnDir < 0 ? this.turnFramesLeft : this.turnFramesRight;
        write(stepCount++, base + lastDir, 0, lastDir, moduleX, moduleY);
      }
      while (lastDir !== currentDir) {
        lastDir += turnDir;
        if (turnDir < 0) {
          if (lastDir < 0) lastDir += NO_DIRECTIONS;
          write(stepCount++, this.turnFramesLeft + lastDir, 0, lastDir, moduleX, moduleY);
        } else {
          if (lastDir > 7) lastDir -= NO_DIRECTIONS;
          write(stepCount++, this.turnFramesRight + lastDir, 0, lastDir, moduleX, moduleY);
        }
      }
      // Back 45 degrees: the head turn overshoots by one.
      stepCount -= 1;
    }

    // George's slow-in: three frames of him getting going, and only when the
    // first module actually walks. The frame numbers are positions in his own
    // mega resource, which is why no other mega has them.
    if (this.megaId === GEORGE && this.modularPath[1].num > 0) {
      const slowIn = currentDir === 2 ? [296, 297, 298] : currentDir === 6 ? [299, 300, 301] : null;
      if (slowIn) {
        slowStart = 1;
        for (const frame of slowIn) write(stepCount++, frame, 0, currentDir, moduleX, moduleY);
      }
    }

    // Which foot to start on. Unlike slidy's alternating state, solid's follows
    // from the direction: walking left starts on the other foot.
    let left = currentDir > 4 ? 1 : 0;

    let lastCount = stepCount;
    lastDir = 99;
    currentDir = 99;

    let p = 1;
    for (; p < this.modularPath.length && this.modularPath[p].dir < NO_DIRECTIONS; p++) {
      let guard = 0;
      while (this.modularPath[p].num > 0 && stepCount < maxSteps && guard++ < 256) {
        currentDir = this.modularPath[p].dir;
        if (currentDir >= NO_DIRECTIONS) break;

        module = currentDir * this.framesPerStep * 2 + left * this.framesPerStep;
        left = left ? 0 : 1;
        const moduleEnd = module + this.framesPerStep;
        let step = 0;
        const scale = this.scaleA * moduleY + this.scaleB;
        do {
          module16X += (this.dx[module] ?? 0) * scale;
          module16Y += (this.dy[module] ?? 0) * scale;
          moduleX = Math.floor(module16X / 0x10000);
          moduleY = Math.floor(module16Y / 0x10000);
          write(stepCount, module, step, currentDir, moduleX, moduleY);
          stepCount += 1;
          module += 1;
          step += 1;
        } while (module < moduleEnd && stepCount < maxSteps);

        const errorX = (this.modularPath[p].x - moduleX) * this.modX[this.modularPath[p].dir];
        const errorY = (this.modularPath[p].y - moduleY) * this.modY[this.modularPath[p].dir];
        if (errorX < 0 || errorY < 0) {
          // Overshot: drop the step that went past and stop here. Solid never
          // slides, so the module's end moves to where the walk actually got to.
          this.modularPath[p].num = 0;
          stepCount -= this.framesPerStep;
          left = left ? 0 : 1;
          moduleX = nodeX(stepCount - 1);
          moduleY = nodeY(stepCount - 1);
          module16X = moduleX * 0x10000;
          module16Y = moduleY * 0x10000;
          this.modularPath[p].x = moduleX;
          this.modularPath[p].y = moduleY;

          if (stepCount - lastCount < this.framesPerStep) {
            // No step was taken at all, so no turn frames belong here — and a
            // slow-in with no walk after it has to be undone.
            currentDir = 99;
            if (slowStart === 1) {
              stepCount -= 3;
              lastCount -= 3;
              slowStart = 0;
            }
          }

          if (lastDir !== 99 && currentDir !== 99 && this.megaId === GEORGE) {
            const delta = currentDir - lastDir;
            if (delta === -1 || delta === 7 || delta === -2 || delta === 6) {
              for (let frame = lastCount - this.framesPerStep; frame < lastCount; frame++) {
                addFrame(frame, 104);
              }
            }
            if (delta === 1 || delta === -7 || delta === 2 || delta === -6) {
              for (let frame = lastCount - this.framesPerStep; frame < lastCount; frame++) {
                addFrame(frame, 200);
              }
            }
          }
          lastCount = stepCount;
        }
      }
      lastDir = currentDir;
      // A slow-in is only valid on the first module.
      slowStart = 0;
    }

    // George's slow-out: the last step becomes a slowing one and a stop frame
    // follows. Which offset applies depends on the foot the walk ended on,
    // which is what the frame-number test reads.
    if (this.megaId === GEORGE && (currentDir === 2 || currentDir === 6)) {
      const from = lastCount - this.framesPerStep;
      const ending = frameAt(from);
      const table: Record<number, { add: number; stop: number }> = {
        24: { add: 278, stop: 308 },
        30: { add: 279, stop: 315 },
        72: { add: 244, stop: 322 },
        78: { add: 245, stop: 329 },
      };
      const slowOut = table[ending];
      if (slowOut) {
        for (let frame = from; frame < lastCount; frame++) addFrame(frame, slowOut.add);
        write(stepCount++, slowOut.stop, 7, currentDir, moduleX, moduleY);
      }
    }

    const endDir = this.modularPath[Math.max(0, p - 1)].dir;
    write(stepCount++, this.framesPerChar + endDir, 0, endDir, moduleX, moduleY);
    for (let extra = 0; extra < 3; extra++) {
      write(stepCount + extra, WALK_END_FRAME, 0, 0, moduleX, moduleY);
    }

    // Now check the route it actually walked. Solid steps do not land where the
    // path said they would, so every leg is re-tested at the coordinates
    // reached — and a target that ended up on a bar is refused too.
    let walked = p;
    for (let leg = 0; leg < p - 1; leg++) {
      if (
        !this.check(
          this.modularPath[leg].x,
          this.modularPath[leg].y,
          this.modularPath[leg + 1].x,
          this.modularPath[leg + 1].y,
        )
      ) {
        walked = 0;
        break;
      }
    }

    if (walked !== 0) {
      this.targetDir = this.modularPath[p - 1].dir;
      if (this.checkTarget(moduleX, moduleY) === 3) {
        this.lastFailure = `a solid walk ended on a walk-grid bar at (${moduleX}, ${moduleY}), so it was rebuilt as a slidy one`;
        walked = 0;
      }
    }

    return walked;
  }

  /** A line for the stall report: what the last route did. */
  describe(): string {
    return (
      `router: ${this.nBars} bars, ${this.nNodes} nodes, route length ${this.routeLength}` +
      (this.lastFailure ? `; last failure: ${this.lastFailure}` : '')
    );
  }
}
