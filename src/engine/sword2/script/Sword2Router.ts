/**
 * Broken Sword II's walk router.
 *
 * ## The same algorithm as Sword1's, and that is a finding rather than a shortcut
 *
 * Revolution carried their polygon router from Broken Sword into Broken Sword
 * II largely unchanged: the same three stages (a route through walk-grid nodes,
 * the smoothest eight-directional path through them, then whole walk frames
 * fitted to that path), the same `BarData`/`NodeData` records, the same
 * `scan` / `newCheck` / `lineCheck` geometry, and the same slidy and solid
 * animators.
 *
 * That does **not** make the two families one. `CONTEXT.md`'s test is bytecode,
 * resource layout and renderer, and those are still wholly different (ADR
 * 0036). What is shared is one *algorithm*, and it is reimplemented here rather
 * than imported from `sword1` because everything it touches differs:
 *
 * - **The walk grid** is not one floor object's resource. It is a *list* of
 *   grid resources that scripts add and remove with `fnAddWalkGrid` and
 *   `fnRemoveWalkGrid`, all concatenated into one set of bars and nodes. A room
 *   can therefore gain and lose walkable area while the player stands in it.
 * - **The walk data** is an `ObjectWalkdata` structure the script hands over,
 *   not a resource read from a mega id — and it is **data-driven** where
 *   Sword1's was hardcoded: which frames are stand frames, turn frames, slow-in
 *   and slow-out frames all follow from four flags and a per-direction count.
 *   Sword1 has George's frame numbers written into its router; this one has
 *   none, which is strictly better and is why George's walk here needed no
 *   special case.
 * - **The step sizes** are summed over half a walk cycle from the walk data
 *   rather than read as a `modX`/`modY` pair, so `_modX[i]` is a derived total.
 *
 * ## What the caller gets
 *
 * `routeFinder` writes a walk into a `WalkData` array — frame, x, y, step, dir
 * per node — and answers 0, 1 or 2 the way Sword1's does. The scripts branch on
 * that value, so it is the part that has to be exactly right.
 */

import type { Sword2Resources } from '../resource/Sword2Resources.js';
import { RES_HEADER_SIZE } from '../resource/sword2Headers.js';
import {
  readSwordWalkBarFields,
  readSwordWalkNodes,
  SWORD_BAR_BYTES,
} from '../../sword1/script/swordWalkGrid.js';

export const O_GRID_SIZE = 200;
export const O_ROUTE_SIZE = 50;
export const NO_DIRECTIONS = 8;
export const ROUTE_END_FLAG = 255;
/** How many grids a session may have added at once. */
export const MAX_WALKGRIDS = 10;
/** The router's output buffer, in nodes. */
export const SWORD2_WALK_ANIM_SIZE = 600;

/** `ObjectWalkdata`, as the scripts hand it over. 916 bytes. */
export interface Sword2WalkData {
  readonly nWalkFrames: number;
  readonly usingStandingTurnFrames: boolean;
  readonly usingWalkingTurnFrames: boolean;
  readonly usingSlowInFrames: boolean;
  /** Zero, or how many slow-out frames each direction has. */
  readonly usingSlowOutFrames: number;
  readonly nSlowInFrames: readonly number[];
  readonly leadingLeg: readonly number[];
  readonly dx: readonly number[];
  readonly dy: readonly number[];
}

/** One node of the walk this router produces. */
export interface Sword2WalkNode {
  frame: number;
  x: number;
  y: number;
  step: number;
  dir: number;
}

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

export const Sword2RouteResult = { FAILED: 0, FOUND: 1, ALREADY_THERE: 2 } as const;

/**
 * Reads an `ObjectWalkdata` out of an object's bytes.
 *
 * 916 bytes of fixed layout: five flags, eight slow-in counts, eight leading
 * legs, then 104 x-steps and 104 y-steps. The step arrays are `8 * (12 + 1)`
 * because a walk cycle is at most twelve frames and the thirteenth slot is the
 * stand frame's zero step.
 */
export function readSword2WalkData(bytes: Uint8Array, at: number): Sword2WalkData | null {
  if (at + 916 > bytes.length) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const i32 = (offset: number): number => view.getInt32(at + offset, true);

  const nSlowInFrames: number[] = [];
  for (let index = 0; index < 8; index++) nSlowInFrames.push(i32(20 + index * 4));
  const leadingLeg: number[] = [];
  for (let index = 0; index < 8; index++) leadingLeg.push(i32(52 + index * 4));
  const dx: number[] = [];
  const dy: number[] = [];
  for (let index = 0; index < 8 * 13; index++) dx.push(i32(84 + index * 4));
  for (let index = 0; index < 8 * 13; index++) dy.push(i32(84 + 8 * 13 * 4 + index * 4));

  const nWalkFrames = i32(0);
  if (nWalkFrames <= 0 || nWalkFrames > 24) return null;

  return {
    nWalkFrames,
    usingStandingTurnFrames: i32(4) !== 0,
    usingWalkingTurnFrames: i32(8) !== 0,
    usingSlowInFrames: i32(12) !== 0,
    usingSlowOutFrames: i32(16),
    nSlowInFrames,
    leadingLeg,
    dx,
    dy,
  };
}

export class Sword2Router {
  private bars: BarData[] = [];
  private node: NodeData[] = [];
  private nBars = 0;
  private nNodes = 1;

  /** Grid resources scripts have added, in the order they were added. */
  private readonly grids: number[] = [];

  private startX = 0;
  private startY = 0;
  private startDir = 0;
  private targetX = 0;
  private targetY = 0;
  private targetDir = 0;
  private scaleA = 0;
  private scaleB = 0;

  private route: RouteData[] = [];
  private smoothPath: PathData[] = [];
  private modularPath: PathData[] = [];
  private routeLength = 0;

  private walk: Sword2WalkData | null = null;
  private modX: number[] = new Array(8).fill(0);
  private modY: number[] = new Array(8).fill(0);
  private diagonalx = 36;
  private diagonaly = 8;
  private framesPerStep = 0;
  private framesPerChar = 0;
  private firstStandFrame = 0;
  private firstStandingTurnLeftFrame = 0;
  private firstStandingTurnRightFrame = 0;
  private firstWalkingTurnLeftFrame = 0;
  private firstWalkingTurnRightFrame = 0;
  private readonly firstSlowInFrame: number[] = new Array(8).fill(0);
  private firstSlowOutFrame = 0;
  private numberOfSlowOutFrames = 0;

  private stepCount = 0;
  private lastCount = 0;
  private currentDir = 0;
  private moduleX = 0;
  private moduleY = 0;

  /** Where the walk is written. One array, reused, as the original's is. */
  readonly walkAnim: Sword2WalkNode[] = Array.from({ length: SWORD2_WALK_ANIM_SIZE }, () => ({
    frame: 0,
    x: 0,
    y: 0,
    step: 0,
    dir: 0,
  }));

  lastFailure: string | undefined;

  constructor(private readonly resources: Sword2Resources) {
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

  /** `fnAddWalkGrid` / `fnRegisterWalkGrid`. */
  addWalkGrid(resource: number): void {
    if (!resource || this.grids.includes(resource)) return;
    if (this.grids.length >= MAX_WALKGRIDS) {
      this.lastFailure = `a session added more than ${MAX_WALKGRIDS} walk grids; the extra one was dropped`;
      return;
    }
    this.grids.push(resource);
  }

  /** `fnRemoveWalkGrid`. */
  removeWalkGrid(resource: number): void {
    const at = this.grids.indexOf(resource);
    if (at >= 0) this.grids.splice(at, 1);
  }

  /** A session change clears the list; the new session adds its own. */
  clearWalkGrids(): void {
    this.grids.length = 0;
  }

  get walkGridCount(): number {
    return this.grids.length;
  }

  /**
   * Concatenates every registered grid into one set of bars and nodes.
   *
   * Node 0 is left for the mega's own position, which is why the node counter
   * starts at one. A grid that will not fit is skipped rather than truncated:
   * half a grid is a walkable area with invisible walls in it.
   */
  private loadWalkGrid(): void {
    this.nBars = 0;
    this.nNodes = 1;

    for (const resource of this.grids) {
      const fetched = this.resources.fetch(resource);
      if (!fetched) {
        this.lastFailure = `walk grid ${resource}: ${this.resources.describeMissingResource(resource)}`;
        continue;
      }
      const bytes = fetched.bytes;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      let at = RES_HEADER_SIZE;
      if (at + 8 > bytes.length) continue;
      const numBars = view.getInt32(at, true);
      const numNodes = view.getInt32(at + 4, true);
      at += 8;
      if (
        numBars < 0 ||
        numNodes < 0 ||
        this.nBars + numBars >= O_GRID_SIZE ||
        this.nNodes + numNodes >= O_GRID_SIZE
      ) {
        this.lastFailure =
          `walk grid ${resource} would take the total past ${O_GRID_SIZE} bars or nodes, so it ` +
          `was skipped rather than half-loaded`;
        continue;
      }
      if (at + numBars * 24 + numNodes * 4 > bytes.length) continue;

      // Read through `swordWalkGrid.ts` — the bar and node codec Revolution
      // carried across from Broken Sword unchanged, and the one reading the
      // editor takes apart and writes back. All eleven fields as stored, not
      // the seven derived: see `readSwordWalkBarFields`.
      readSwordWalkBarFields(view, at, numBars, true).forEach((bar, index) => {
        Object.assign(this.bars[this.nBars + index], bar);
      });
      readSwordWalkNodes(view, at + numBars * SWORD_BAR_BYTES, numNodes, true).forEach(
        (node, index) => {
          this.node[this.nNodes + index].x = node.x;
          this.node[this.nNodes + index].y = node.y;
        },
      );
      this.nBars += numBars;
      this.nNodes += numNodes;
    }
  }

  /**
   * Works out where every kind of frame lives in the mega's own frame table.
   *
   * Entirely data-driven, and this is the improvement over Sword1's router: the
   * order is walk, stand, standing turns, walking turns, slow-in, slow-out, and
   * each optional block is present only if its flag says so. A mega with no
   * turn frames simply reuses its stand frames, which the `else` branches do.
   */
  private loadWalkData(walk: Sword2WalkData): void {
    this.walk = walk;
    this.numberOfSlowOutFrames = walk.usingSlowOutFrames;

    for (let dir = 0; dir < NO_DIRECTIONS; dir++) {
      const first = dir * walk.nWalkFrames;
      this.modX[dir] = 0;
      this.modY[dir] = 0;
      // The step size for a direction is the sum over *half* a cycle, because
      // a "step" is one leg: a whole cycle is two steps.
      for (let frame = first; frame < first + Math.floor(walk.nWalkFrames / 2); frame++) {
        this.modX[dir] += walk.dx[frame] ?? 0;
        this.modY[dir] += walk.dy[frame] ?? 0;
      }
    }
    this.diagonalx = this.modX[3] || 36;
    this.diagonaly = this.modY[3] || 8;

    this.framesPerStep = Math.floor(walk.nWalkFrames / 2);
    this.framesPerChar = walk.nWalkFrames * NO_DIRECTIONS;

    let counter = this.framesPerChar;
    this.firstStandFrame = counter;
    counter += NO_DIRECTIONS;

    if (walk.usingStandingTurnFrames) {
      this.firstStandingTurnLeftFrame = counter;
      counter += NO_DIRECTIONS;
      this.firstStandingTurnRightFrame = counter;
      counter += NO_DIRECTIONS;
    } else {
      this.firstStandingTurnLeftFrame = this.firstStandFrame;
      this.firstStandingTurnRightFrame = this.firstStandFrame;
    }

    if (walk.usingWalkingTurnFrames) {
      this.firstWalkingTurnLeftFrame = counter;
      counter += this.framesPerChar;
      this.firstWalkingTurnRightFrame = counter;
      counter += this.framesPerChar;
    } else {
      this.firstWalkingTurnLeftFrame = 0;
      this.firstWalkingTurnRightFrame = 0;
    }

    if (walk.usingSlowInFrames) {
      for (let dir = 0; dir < NO_DIRECTIONS; dir++) {
        this.firstSlowInFrame[dir] = counter;
        counter += walk.nSlowInFrames[dir] ?? 0;
      }
    }

    this.firstSlowOutFrame = counter;
  }

  /**
   * Finds a route and writes the walk. 0 failed, 1 found, 2 already there.
   *
   * `mega` is the object's `ObjectMega` structure read out for us — feet,
   * direction and scale — because this router does not know how to find it in
   * an object and should not.
   */
  routeFinder(
    mega: { feetX: number; feetY: number; dir: number; scaleA: number; scaleB: number },
    walk: Sword2WalkData,
    x: number,
    y: number,
    dir: number,
  ): number {
    this.lastFailure = undefined;
    this.loadWalkGrid();
    this.startX = mega.feetX;
    this.startY = mega.feetY;
    this.startDir = mega.dir;
    this.targetX = x;
    this.targetY = y;
    this.targetDir = dir;
    this.scaleA = mega.scaleA;
    this.scaleB = mega.scaleB;

    this.node[0] = { x: this.startX, y: this.startY, level: 1, prev: 0, dist: 0 };
    for (let index = 1; index < this.nNodes; index++) {
      this.node[index].level = 0;
      this.node[index].prev = 0;
      this.node[index].dist = 9999;
    }
    this.node[this.nNodes] = {
      x: this.targetX,
      y: this.targetY,
      level: 0,
      prev: 0,
      dist: 9999,
    };

    this.loadWalkData(walk);

    const routeFlag = this.getRoute();

    if (routeFlag === 2) {
      if (this.targetDir > 7) this.targetDir = this.startDir;
      this.modularPath[0] = { dir: this.startDir, num: 0, x: this.startX, y: this.startY };
      this.modularPath[1] = { dir: this.targetDir, num: 0, x: this.startX, y: this.startY };
      this.modularPath[2] = { dir: 9, num: ROUTE_END_FLAG, x: this.startX, y: this.startY };
      this.slidyWalkAnimator();
      return Sword2RouteResult.ALREADY_THERE;
    }

    if (routeFlag === 1) {
      this.smoothestPath();
      let solid = 0;
      if (this.targetDir === NO_DIRECTIONS) {
        this.solidPath();
        solid = this.solidWalkAnimator();
      }
      if (!solid) {
        this.slidyPath();
        this.slidyWalkAnimator();
      }
      return Sword2RouteResult.FOUND;
    }

    this.lastFailure =
      routeFlag === 3
        ? `the target (${x}, ${y}) is on a walk-grid bar, within a pixel of it`
        : `no line through the walk grid reaches (${x}, ${y}) from (${this.startX}, ${this.startY})`;
    return Sword2RouteResult.FAILED;
  }

  /** The end direction the walk actually finished in, for the caller's mega. */
  get endDirection(): number {
    return this.targetDir;
  }

  /** How many nodes the last walk wrote, up to its end marker. */
  get walkLength(): number {
    for (let at = 0; at < this.walkAnim.length; at++) {
      if (this.walkAnim[at].frame === 512) return at;
    }
    return this.walkAnim.length;
  }

  // -- the geometry, shared with Sword1's router in algorithm only ----------

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

  private scan(level: number): boolean {
    let changed = false;
    const target = this.node[this.nNodes];
    for (let i = 0; i < this.nNodes; i++) {
      const from = this.node[i];
      if (!(from.dist < target.dist && from.level === level)) continue;
      for (let j = this.nNodes; j > 0; j--) {
        const to = this.node[j];
        if (to.dist <= from.dist) continue;
        const adx = Math.abs(to.x - from.x);
        const ady = Math.abs(to.y - from.y);
        const distance =
          2 * adx > 9 * ady
            ? Math.trunc((8 * adx + 18 * ady) / (54 * 8)) + 1
            : Math.trunc((6 * adx + 36 * ady) / (36 * 14)) + 1;
        if (distance + from.dist < target.dist && distance + from.dist < to.dist) {
          if (this.newCheck(0, from.x, from.y, to.x, to.y)) {
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
      let dly = ldy;
      let dlx = Math.trunc((ldy * this.diagonalx) / this.diagonaly);
      ldx -= dlx;
      dlx *= dirX;
      dly *= dirY;
      ldx *= dirX;

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
      let dlx = ldx;
      let dly = Math.trunc((ldx * this.diagonaly) / this.diagonalx);
      ldy -= dly;
      dlx *= dirX;
      dly *= dirY;
      ldy *= dirY;

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
        this.lastFailure = `leg ${p} of the route was found by the scan and rejected by the smoother`;
        this.smoothCheck(steps, 1, p, dirS, dirD);
      }
      lastDir = chosen === 0 || chosen === 1 ? dirS : dirD;
    }

    this.smoothPath[steps.value].dir = 9;
    this.smoothPath[steps.value].num = ROUTE_END_FLAG;
  }

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

    if (dirS === 0 || dirS === 4) {
      ddx = ldx;
      ddy = Math.trunc((ldx * this.diagonaly) / this.diagonalx);
      dsy = ldy - ddy;
      ddx *= dirX;
      ddy *= dirY;
      dsy *= dirY;
      dsx = 0;
      const stepD = this.modX[dirD] || 1;
      const stepS = this.modY[dirS] || 1;
      sd0 = Math.trunc((ddx + Math.trunc(stepD / 2)) / stepD);
      ss0 = Math.trunc((dsy + Math.trunc(stepS / 2)) / stepS);
    } else {
      ddy = ldy;
      ddx = Math.trunc((ldy * this.diagonalx) / this.diagonaly);
      dsx = ldx - ddx;
      ddy *= dirY;
      ddx *= dirX;
      dsx *= dirX;
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
      case 0:
        put(x + Math.trunc(dsx / 2), y + Math.trunc(dsy / 2), dirS, ss1);
        put(x + Math.trunc(dsx / 2) + ddx, y + Math.trunc(dsy / 2) + ddy, dirD, sd0);
        put(x + dsx + ddx, y + dsy + ddy, dirS, ss2);
        break;
      case 1:
        put(x + dsx, y + dsy, dirS, ss0);
        put(x2, y2, dirD, sd0);
        break;
      case 2:
        put(x + ddx, y + ddy, dirD, sd0);
        put(x2, y2, dirS, ss0);
        break;
      default:
        put(x + Math.trunc(ddx / 2), y + Math.trunc(ddy / 2), dirD, sd1);
        put(x + dsx + Math.trunc(ddx / 2), y + dsy + Math.trunc(ddy / 2), dirS, ss0);
        put(x2, y2, dirD, sd2);
        break;
    }
  }

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

  // -- the animators -------------------------------------------------------

  private write(frame: number, step: number, dir: number, x: number, y: number): void {
    if (this.stepCount < 0 || this.stepCount >= SWORD2_WALK_ANIM_SIZE - 3) return;
    const node = this.walkAnim[this.stepCount];
    node.frame = frame;
    node.step = step;
    node.dir = dir;
    node.x = x;
    node.y = y;
    this.stepCount++;
  }

  /** The optional slow-in block, if this mega has one and actually walks. */
  private addSlowInFrames(): boolean {
    const walk = this.walk;
    if (!walk?.usingSlowInFrames || this.modularPath[1].num <= 0) return false;
    const count = walk.nSlowInFrames[this.currentDir] ?? 0;
    for (let frame = 0; frame < count; frame++) {
      this.write(
        this.firstSlowInFrame[this.currentDir] + frame,
        0,
        this.currentDir,
        this.moduleX,
        this.moduleY,
      );
    }
    return true;
  }

  /**
   * The optional slow-out block: the last half-cycle becomes slowing frames.
   *
   * The mapping is the interesting part. There can be *more* slow-out frames
   * than walk frames, so an existing walk frame maps across by
   * `first + (frame / framesPerStep) * (slowOut - framesPerStep)` rather than by
   * a flat offset — and any frames left over are added as stationary ones.
   */
  private addSlowOutFrames(): void {
    const walk = this.walk;
    if (!walk?.usingSlowOutFrames || this.lastCount < this.framesPerStep) return;

    for (let at = this.lastCount - this.framesPerStep; at < this.lastCount; at++) {
      const node = this.walkAnim[at];
      node.frame +=
        this.firstSlowOutFrame +
        Math.trunc(node.frame / this.framesPerStep) *
          (this.numberOfSlowOutFrames - this.framesPerStep);
      node.step = 0;
    }
    for (let extra = this.framesPerStep; extra < this.numberOfSlowOutFrames; extra++) {
      const previous = this.walkAnim[this.stepCount - 1];
      this.write(previous.frame + 1, 0, previous.dir, previous.x, previous.y);
    }
  }

  /** Turns the module list into frames, sliding to land on the exact target. */
  private slidyWalkAnimator(): void {
    let p = 0;
    let lastDir = this.modularPath[0].dir;
    this.currentDir = this.modularPath[1].dir;
    if (this.currentDir === NO_DIRECTIONS) this.currentDir = lastDir;

    this.moduleX = this.startX;
    this.moduleY = this.startY;
    let module16X = this.moduleX * 0x10000;
    let module16Y = this.moduleY * 0x10000;
    this.stepCount = 0;

    this.write(this.framesPerChar + lastDir, 0, lastDir, this.moduleX, this.moduleY);

    if (lastDir !== this.currentDir) {
      let turnDir = this.currentDir - lastDir;
      if (turnDir < 0) turnDir += NO_DIRECTIONS;
      if (turnDir > 4) turnDir = -1;
      else if (turnDir > 0) turnDir = 1;

      if (this.walk?.usingStandingTurnFrames) {
        const base =
          turnDir < 0 ? this.firstStandingTurnLeftFrame : this.firstStandingTurnRightFrame;
        this.write(base + lastDir, 0, lastDir, this.moduleX, this.moduleY);
      }
      while (lastDir !== this.currentDir) {
        lastDir += turnDir;
        if (turnDir < 0) {
          if (lastDir < 0) lastDir += NO_DIRECTIONS;
          this.write(
            this.firstStandingTurnLeftFrame + lastDir,
            0,
            lastDir,
            this.moduleX,
            this.moduleY,
          );
        } else {
          if (lastDir > 7) lastDir -= NO_DIRECTIONS;
          this.write(
            this.firstStandingTurnRightFrame + lastDir,
            0,
            lastDir,
            this.moduleX,
            this.moduleY,
          );
        }
      }
      this.stepCount -= 1;
    }

    let lastRealDir = this.currentDir;
    this.addSlowInFrames();

    // Which foot to lead with comes from the walk data, per direction — where
    // Sword1 alternated a flag between walks.
    let left = this.walk?.leadingLeg[this.currentDir] ?? 0;

    this.lastCount = this.stepCount;
    lastDir = 99;
    this.currentDir = 99;

    do {
      while (this.modularPath[p]?.num === 0) {
        p += 1;
        if (this.currentDir !== 99) lastRealDir = this.currentDir;
        lastDir = this.currentDir;
        this.lastCount = this.stepCount;
        if (p >= this.modularPath.length) break;
      }
      if (p >= this.modularPath.length) break;

      this.currentDir = this.modularPath[p].dir;
      if (this.currentDir < NO_DIRECTIONS) {
        let module = this.currentDir * this.framesPerStep * 2 + left * this.framesPerStep;
        left = left ? 0 : 1;
        const moduleEnd = module + this.framesPerStep;
        let step = 0;
        const scale = this.scaleA * this.moduleY + this.scaleB;
        do {
          module16X += (this.walk?.dx[module] ?? 0) * scale;
          module16Y += (this.walk?.dy[module] ?? 0) * scale;
          this.moduleX = Math.floor(module16X / 0x10000);
          this.moduleY = Math.floor(module16Y / 0x10000);
          this.write(module, step, this.currentDir, this.moduleX, this.moduleY);
          step += 1;
          module += 1;
        } while (module < moduleEnd && this.stepCount < SWORD2_WALK_ANIM_SIZE - 4);

        const stepX = this.modX[this.modularPath[p].dir];
        const stepY = this.modY[this.modularPath[p].dir];
        let errorX = (this.modularPath[p].x - this.moduleX) * stepX;
        let errorY = (this.modularPath[p].y - this.moduleY) * stepY;

        if (errorX < 0 || errorY < 0) {
          this.modularPath[p].num = 0;
          let frames = this.stepCount - this.lastCount;
          errorX = this.modularPath[p].x - this.walkAnim[this.stepCount - 1].x;
          errorY = this.modularPath[p].y - this.walkAnim[this.stepCount - 1].y;

          if (frames > this.framesPerStep) {
            const lastErrorX = this.modularPath[p].x - this.walkAnim[this.stepCount - 7]?.x;
            const lastErrorY = this.modularPath[p].y - this.walkAnim[this.stepCount - 7]?.y;
            if (stepX === 0) {
              if (3 * Math.abs(lastErrorY) < Math.abs(errorY)) {
                this.stepCount -= this.framesPerStep;
                left = left ? 0 : 1;
              }
            } else if (3 * Math.abs(lastErrorX) < Math.abs(errorX)) {
              this.stepCount -= this.framesPerStep;
              left = left ? 0 : 1;
            }
          }

          errorX = this.modularPath[p].x - this.walkAnim[this.stepCount - 1].x;
          errorY = this.modularPath[p].y - this.walkAnim[this.stepCount - 1].y;
          frames = this.stepCount - this.lastCount;
          if (errorX !== 0 && frames > 0) {
            for (let frame = 1; frame <= frames; frame++) {
              this.walkAnim[this.lastCount + frame - 1].x += Math.trunc((errorX * frame) / frames);
            }
          }
          if (errorY !== 0 && frames > 0) {
            for (let frame = 1; frame <= frames; frame++) {
              this.walkAnim[this.lastCount + frame - 1].y += Math.trunc((errorY * frame) / frames);
            }
          }

          if (frames < this.framesPerStep) this.currentDir = 99;
          if (this.currentDir !== 99) lastRealDir = this.currentDir;

          // The walking turn cycles, if this mega has them. Data-driven, so no
          // character is named here.
          if (lastDir !== 99 && this.currentDir !== 99 && this.walk?.usingWalkingTurnFrames) {
            const delta = this.currentDir - lastDir;
            const turningLeft = delta === -1 || delta === 7 || delta === -2 || delta === 6;
            const turningRight = delta === 1 || delta === -7 || delta === 2 || delta === -6;
            if (turningLeft || turningRight) {
              const base = turningLeft
                ? this.firstWalkingTurnLeftFrame
                : this.firstWalkingTurnRightFrame;
              for (
                let frame = this.lastCount - this.framesPerStep;
                frame < this.lastCount;
                frame++
              ) {
                if (frame >= 0) this.walkAnim[frame].frame += base;
              }
            }
            lastDir = this.currentDir;
          }

          this.lastCount = this.stepCount;
          this.moduleX = this.walkAnim[this.stepCount - 1].x;
          this.moduleY = this.walkAnim[this.stepCount - 1].y;
          module16X = this.moduleX * 0x10000;
          module16Y = this.moduleY * 0x10000;
        }
      }
    } while (
      p < this.modularPath.length &&
      this.modularPath[p].dir < NO_DIRECTIONS &&
      this.stepCount < SWORD2_WALK_ANIM_SIZE - 4
    );

    if (lastRealDir === 99) lastRealDir = this.startDir;
    this.addSlowOutFrames();

    if (this.targetDir === NO_DIRECTIONS) {
      this.targetDir = lastRealDir;
      this.write(this.firstStandFrame + lastRealDir, 0, lastRealDir, this.moduleX, this.moduleY);
    } else if (this.targetDir !== lastRealDir) {
      let turnDir = this.targetDir - lastRealDir;
      if (turnDir < 0) turnDir += NO_DIRECTIONS;
      if (turnDir > 4) turnDir = -1;
      else if (turnDir > 0) turnDir = 1;

      if (this.walk?.usingStandingTurnFrames) {
        const base =
          turnDir < 0 ? this.firstStandingTurnLeftFrame : this.firstStandingTurnRightFrame;
        this.write(base + lastRealDir, 0, lastRealDir, this.moduleX, this.moduleY);
      }
      while (lastRealDir !== this.targetDir) {
        lastRealDir += turnDir;
        if (turnDir < 0) {
          if (lastRealDir < 0) lastRealDir += NO_DIRECTIONS;
          this.write(
            this.firstStandingTurnLeftFrame + lastRealDir,
            0,
            lastRealDir,
            this.moduleX,
            this.moduleY,
          );
        } else {
          if (lastRealDir > 7) lastRealDir -= NO_DIRECTIONS;
          this.write(
            this.firstStandingTurnRightFrame + lastRealDir,
            0,
            lastRealDir,
            this.moduleX,
            this.moduleY,
          );
        }
      }
      if (this.stepCount > 0) {
        this.walkAnim[this.stepCount - 1].frame = this.firstStandFrame + lastRealDir;
      }
    } else {
      this.write(this.firstStandFrame + lastRealDir, 0, lastRealDir, this.moduleX, this.moduleY);
    }

    for (let extra = 0; extra < 3; extra++) {
      this.write(512, 0, 0, this.moduleX, this.moduleY);
    }
  }

  /** Whole steps, no sliding. Returns 0 when the route it walked is blocked. */
  private solidWalkAnimator(): number {
    let lastDir = this.modularPath[0].dir;
    this.currentDir = this.modularPath[1].dir;
    this.moduleX = this.startX;
    this.moduleY = this.startY;
    let module16X = this.moduleX * 0x10000;
    let module16Y = this.moduleY * 0x10000;
    this.stepCount = 0;

    this.write(this.framesPerChar + lastDir, 0, lastDir, this.moduleX, this.moduleY);

    if (lastDir !== this.currentDir) {
      let turnDir = this.currentDir - lastDir;
      if (turnDir < 0) turnDir += NO_DIRECTIONS;
      if (turnDir > 4) turnDir = -1;
      else if (turnDir > 0) turnDir = 1;

      if (this.walk?.usingStandingTurnFrames) {
        const base =
          turnDir < 0 ? this.firstStandingTurnLeftFrame : this.firstStandingTurnRightFrame;
        this.write(base + lastDir, 0, lastDir, this.moduleX, this.moduleY);
      }
      while (lastDir !== this.currentDir) {
        lastDir += turnDir;
        if (turnDir < 0) {
          if (lastDir < 0) lastDir += NO_DIRECTIONS;
          this.write(
            this.firstStandingTurnLeftFrame + lastDir,
            0,
            lastDir,
            this.moduleX,
            this.moduleY,
          );
        } else {
          if (lastDir > 7) lastDir -= NO_DIRECTIONS;
          this.write(
            this.firstStandingTurnRightFrame + lastDir,
            0,
            lastDir,
            this.moduleX,
            this.moduleY,
          );
        }
      }
      this.stepCount -= 1;
    }

    let slowStart = this.addSlowInFrames();

    let left = this.walk?.leadingLeg[this.currentDir] ?? 0;
    this.lastCount = this.stepCount;
    lastDir = 99;
    this.currentDir = 99;

    let p = 1;
    for (; p < this.modularPath.length && this.modularPath[p].dir < NO_DIRECTIONS; p++) {
      let guard = 0;
      while (
        this.modularPath[p].num > 0 &&
        this.stepCount < SWORD2_WALK_ANIM_SIZE - 4 &&
        guard++ < 256
      ) {
        this.currentDir = this.modularPath[p].dir;
        if (this.currentDir >= NO_DIRECTIONS) break;

        let module = this.currentDir * this.framesPerStep * 2 + left * this.framesPerStep;
        left = left ? 0 : 1;
        const moduleEnd = module + this.framesPerStep;
        let step = 0;
        const scale = this.scaleA * this.moduleY + this.scaleB;
        do {
          module16X += (this.walk?.dx[module] ?? 0) * scale;
          module16Y += (this.walk?.dy[module] ?? 0) * scale;
          this.moduleX = Math.floor(module16X / 0x10000);
          this.moduleY = Math.floor(module16Y / 0x10000);
          this.write(module, step, this.currentDir, this.moduleX, this.moduleY);
          module += 1;
          step += 1;
        } while (module < moduleEnd && this.stepCount < SWORD2_WALK_ANIM_SIZE - 4);

        const errorX = (this.modularPath[p].x - this.moduleX) * this.modX[this.modularPath[p].dir];
        const errorY = (this.modularPath[p].y - this.moduleY) * this.modY[this.modularPath[p].dir];
        if (errorX < 0 || errorY < 0) {
          this.modularPath[p].num = 0;
          this.stepCount -= this.framesPerStep;
          left = left ? 0 : 1;
          this.moduleX = this.walkAnim[this.stepCount - 1].x;
          this.moduleY = this.walkAnim[this.stepCount - 1].y;
          module16X = this.moduleX * 0x10000;
          module16Y = this.moduleY * 0x10000;
          this.modularPath[p].x = this.moduleX;
          this.modularPath[p].y = this.moduleY;

          if (this.stepCount - this.lastCount < this.framesPerStep) {
            this.currentDir = 99;
            if (slowStart) {
              const count = this.walk?.nSlowInFrames[this.modularPath[1].dir] ?? 0;
              this.stepCount -= count;
              this.lastCount -= count;
              slowStart = false;
            }
          }

          if (lastDir !== 99 && this.currentDir !== 99 && this.walk?.usingWalkingTurnFrames) {
            const delta = this.currentDir - lastDir;
            const turningLeft = delta === -1 || delta === 7 || delta === -2 || delta === 6;
            const turningRight = delta === 1 || delta === -7 || delta === 2 || delta === -6;
            if (turningLeft || turningRight) {
              const base = turningLeft
                ? this.firstWalkingTurnLeftFrame
                : this.firstWalkingTurnRightFrame;
              for (
                let frame = this.lastCount - this.framesPerStep;
                frame < this.lastCount;
                frame++
              ) {
                if (frame >= 0) this.walkAnim[frame].frame += base;
              }
            }
          }
          this.lastCount = this.stepCount;
        }
      }
      lastDir = this.currentDir;
      slowStart = false;
    }

    this.addSlowOutFrames();

    const endDir = this.modularPath[Math.max(0, p - 1)].dir;
    this.write(this.firstStandFrame + endDir, 0, endDir, this.moduleX, this.moduleY);
    for (let extra = 0; extra < 3; extra++) this.write(512, 0, 0, this.moduleX, this.moduleY);

    // Re-check what was actually walked: solid steps do not land where the path
    // said, so the legs have to be tested at the coordinates reached.
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
      if (this.checkTarget(this.moduleX, this.moduleY) === 3) {
        this.lastFailure = `a solid walk ended on a walk-grid bar at (${this.moduleX}, ${this.moduleY}), so it was rebuilt as a slidy one`;
        walked = 0;
      }
    }
    return walked;
  }

  /** A line for the stall report. */
  describe(): string {
    return (
      `router: ${this.grids.length} walk grids, ${this.nBars} bars, ${this.nNodes} nodes, ` +
      `route length ${this.routeLength}` +
      (this.lastFailure ? `; last failure: ${this.lastFailure}` : '')
    );
  }
}
