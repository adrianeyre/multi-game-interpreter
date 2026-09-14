/**
 * AGOS's routes, and walking an actor along one.
 *
 * One of the two subsystems the VGA host seam had nothing behind it for. A
 * script hands the pathfinder a **route** — an item and an explicit list of
 * points — with `SET_PATHFIND_ITEM`, picks one with `COMPUTE_YOFS`, and clears
 * the whole set with `CLEAR_PATHFIND_ARRAY`. Until this existed all three were
 * named as unsupported, which is the honest report for a missing subsystem and
 * a poor substitute for having one.
 *
 * ## This is not a router, and the distinction is the point
 *
 * Nothing here searches for a path. AGOS's routes are **authored**: the points
 * arrive in the bytecode as a `q` operand, which the VGA decoder already reads
 * as a list of pairs, so the data shape needed no guessing and no reference.
 * What this does is hold those lists, answer which one is selected, and step a
 * position along one — which is the whole of what the opcodes ask for.
 *
 * A search-based router would be a different thing and a wrong one: it would
 * send an actor along a path the author did not draw, through scenery the
 * author never tested, and it would do so *plausibly*, which is the worst way
 * to be wrong.
 *
 * ## Where the selected route's number comes from
 *
 * From the game's own variable 12, one-based, and where that names a route
 * which is not set the first one is taken instead. Both of those are the
 * reference's behaviour rather than a choice made here — the fallback exists
 * because real Simon 1 saves select an invalid route and the original corrects
 * it rather than failing. Recorded here because a reader would otherwise take
 * the fallback for sloppiness.
 */

/** A point on a route, in screen coordinates. */
export interface RoutePoint {
  readonly x: number;
  readonly y: number;
}

/** Where a walk has got to. */
export interface WalkStep {
  readonly x: number;
  readonly y: number;
  /** Which point of the route is being walked towards. */
  readonly index: number;
  /** True once the last point has been reached. */
  readonly done: boolean;
}

/** The variable a script leaves the selected route's number in. */
export const ROUTE_VARIABLE = 12;

export class Pathfinder {
  /** Routes by the item they belong to. */
  private readonly routes = new Map<number, readonly RoutePoint[]>();
  /** The route number a script selected, one-based, or null for none. */
  private selected: number | null = null;

  /**
   * Gives an item a route.
   *
   * The pairs arrive as the decoder produced them, so this is where they stop
   * being a list of numbers and become points. Replaces any route the item
   * already had: a script that sets a route twice means the second one.
   */
  set(item: number, points: readonly (readonly [number, number])[]): void {
    this.routes.set(
      item,
      points.map(([x, y]) => ({ x, y })),
    );
  }

  /** An item's route, or null when it has none. */
  routeFor(item: number): readonly RoutePoint[] | null {
    return this.routes.get(item) ?? null;
  }

  /** How many routes are held, which is what a report can show. */
  get size(): number {
    return this.routes.size;
  }

  /**
   * Forgets every route.
   *
   * `CLEAR_PATHFIND_ARRAY`. The selection goes with them: a selected route
   * number that outlived the routes would point at nothing, and the next walk
   * would take the fallback rather than reporting that the script had cleared
   * its own selection.
   */
  clear(): void {
    this.routes.clear();
    this.selected = null;
  }

  /**
   * Selects a route by number, one-based, falling back to the first.
   *
   * Returns whether the number given was the one used, so a caller can tell a
   * clean selection from a corrected one. Both are successes — the fallback is
   * the original's behaviour — but only one of them is worth reporting.
   */
  select(number: number): { selected: number | null; corrected: boolean } {
    const numbers = [...this.routes.keys()].sort((a, b) => a - b);
    if (numbers.length === 0) {
      this.selected = null;
      return { selected: null, corrected: false };
    }

    // One-based: route 1 is the first. A zero or a number past the end is the
    // invalid case the original corrects rather than fails on.
    const wanted = numbers[number - 1];
    if (wanted !== undefined) {
      this.selected = wanted;
      return { selected: wanted, corrected: false };
    }
    this.selected = numbers[0]!;
    return { selected: this.selected, corrected: true };
  }

  /** The item whose route is selected, or null. */
  get selectedItem(): number | null {
    return this.selected;
  }

  /** The selected route's points, or null when nothing is selected. */
  selectedRoute(): readonly RoutePoint[] | null {
    return this.selected === null ? null : this.routeFor(this.selected);
  }

  /**
   * The nearest point on any route to a place the player clicked.
   *
   * What `os1_getPathPosn` answers, and the reason a click on the floor can
   * become a walk at all: the script asks *which route, and which point on it,
   * is closest to here*, writes both into variables, and its own walking code
   * takes over from there. So this is a lookup over authored routes rather than
   * a search for a path — the distinction `pathfinder.ts` exists to keep.
   *
   * **The metric is neither Euclidean nor Manhattan**, and it is copied rather
   * than improved on. It works out to *the larger distance plus a quarter of
   * the smaller* — an integer approximation of Euclidean distance that is
   * exact on an axis and about three per cent over at forty-five degrees, and
   * cheap enough for a 1993 inner loop over four hundred points.
   *
   * The reference reaches it by a route that hides what it computes: it divides
   * the smaller by four and multiplies the larger by four, then divides the
   * larger by four again on the way into the sum. The two operations on the
   * larger cancel. Worth spelling out, because the obvious misreading — that it
   * weights one axis heavily — is a plausible-looking metric that picks a
   * different point from the one the game's own scripts were tuned against.
   *
   * The twelve subtracted from a point's y is the reference's too: a route's
   * points are stored twelve pixels below the feet they describe.
   *
   * `previous` is the route the game currently has selected, and it breaks ties
   * in its own favour — which is what stops an actor standing between two
   * equally near routes from flipping between them every click.
   */
  nearest(x: number, y: number, previous = 0): { route: number; point: number } | null {
    const numbers = [...this.routes.keys()].sort((a, b) => a - b);
    if (numbers.length === 0) return null;

    let best: { route: number; point: number } | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const [slot, key] of numbers.entries()) {
      const route = this.routes.get(key);
      if (!route) continue;
      // One-based, because that is what the variables carry and what `select`
      // reads back.
      const number = slot + 1;
      for (const [index, point] of route.entries()) {
        // Written as the reference writes it rather than as `larger +
        // smaller / 4`, so the integer truncation lands in the same places.
        let horizontal = Math.abs(point.x - x);
        let vertical = Math.abs(point.y - 12 - y);
        if (horizontal < vertical) {
          horizontal = Math.floor(horizontal / 4);
          vertical *= 4;
        }
        vertical = Math.floor(vertical / 4);
        const distance = horizontal + vertical;

        if (distance < bestDistance || (distance === bestDistance && number === previous)) {
          bestDistance = distance;
          best = { route: number, point: index };
        }
      }
    }
    return best;
  }

  /**
   * Steps a position one move along a route.
   *
   * Distance rather than a fraction, because an actor walks at a speed in
   * pixels and a route's legs are not the same length — advancing a fixed
   * fraction of each leg would make an actor cross a short leg slowly and a
   * long one at a sprint.
   *
   * Overshoot carries into the next leg rather than being dropped, so a slow
   * frame does not park an actor exactly on a corner and a fast speed does not
   * stall on every one.
   */
  static walk(
    route: readonly RoutePoint[],
    from: RoutePoint,
    index: number,
    distance: number,
  ): WalkStep {
    if (route.length === 0) return { x: from.x, y: from.y, index: 0, done: true };

    let { x, y } = from;
    let at = Math.max(0, index);
    let remaining = Math.max(0, distance);

    while (remaining > 0) {
      const target = route[at];
      if (!target) return { x, y, index: route.length, done: true };

      const dx = target.x - x;
      const dy = target.y - y;
      const leg = Math.hypot(dx, dy);

      if (leg === 0) {
        // Already standing on this point: take it and move to the next,
        // without consuming distance — a zero-length leg is not a walk.
        at += 1;
        if (at >= route.length) return { x, y, index: route.length, done: true };
        continue;
      }

      if (leg > remaining) {
        // Part-way along this leg, which is the ordinary case.
        return {
          x: x + (dx / leg) * remaining,
          y: y + (dy / leg) * remaining,
          index: at,
          done: false,
        };
      }

      // Reached this point with distance to spare, which carries on.
      x = target.x;
      y = target.y;
      remaining -= leg;
      at += 1;
      if (at >= route.length) return { x, y, index: route.length, done: true };
    }

    return { x, y, index: at, done: at >= route.length };
  }
}
