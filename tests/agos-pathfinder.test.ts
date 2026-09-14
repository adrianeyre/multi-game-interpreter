/**
 * AGOS's routes.
 *
 * One of the two subsystems the VGA host seam had nothing behind it for. The
 * thing worth keeping in view while reading these is that **this is not a
 * router**: AGOS's routes are authored and arrive in the bytecode as a list of
 * points, so what is tested is holding them, selecting between them, and
 * stepping along one — never searching for one.
 */
import { describe, expect, it } from 'vitest';
import { Pathfinder, ROUTE_VARIABLE } from '../src/engine/agos/world/pathfinder.js';

describe('holding routes', () => {
  it('turns the decoder pairs into points, per item', () => {
    const pathfinder = new Pathfinder();

    pathfinder.set(5, [
      [10, 20],
      [30, 40],
    ]);

    expect(pathfinder.routeFor(5)).toEqual([
      { x: 10, y: 20 },
      { x: 30, y: 40 },
    ]);
    expect(pathfinder.routeFor(6)).toBeNull();
  });

  it('replaces a route rather than appending, because setting twice means the second', () => {
    const pathfinder = new Pathfinder();
    pathfinder.set(5, [[1, 1]]);

    pathfinder.set(5, [[9, 9]]);

    expect(pathfinder.routeFor(5)).toEqual([{ x: 9, y: 9 }]);
  });

  it('drops the selection along with the routes when cleared', () => {
    // A selected number that outlived its routes would point at nothing, and
    // the next selection would silently take the fallback instead of showing
    // that the script had cleared its own choice.
    const pathfinder = new Pathfinder();
    pathfinder.set(5, [[1, 1]]);
    pathfinder.select(1);

    pathfinder.clear();

    expect(pathfinder.size).toBe(0);
    expect(pathfinder.selectedItem).toBeNull();
    expect(pathfinder.selectedRoute()).toBeNull();
  });
});

describe('selecting a route', () => {
  function withThree() {
    const pathfinder = new Pathfinder();
    pathfinder.set(7, [[1, 1]]);
    pathfinder.set(5, [[2, 2]]);
    pathfinder.set(9, [[3, 3]]);
    return pathfinder;
  }

  it('is one-based and ordered by item, so route 1 is the lowest item', () => {
    const pathfinder = withThree();

    expect(pathfinder.select(1)).toEqual({ selected: 5, corrected: false });
    expect(pathfinder.select(2)).toEqual({ selected: 7, corrected: false });
    expect(pathfinder.select(3)).toEqual({ selected: 9, corrected: false });
  });

  it('falls back to the first route and says it corrected, rather than failing', () => {
    // The original corrects an invalid selection because real saves contain
    // one. A silent fallback would hide that; a failure would stop a game the
    // original plays.
    const pathfinder = withThree();

    expect(pathfinder.select(99)).toEqual({ selected: 5, corrected: true });
    expect(pathfinder.select(0)).toEqual({ selected: 5, corrected: true });
  });

  it('selects nothing when there are no routes at all', () => {
    const pathfinder = new Pathfinder();

    expect(pathfinder.select(1)).toEqual({ selected: null, corrected: false });
  });

  it('names the variable a script leaves the number in', () => {
    // Kept as a constant so the host and the pathfinder cannot disagree about
    // which variable it is.
    expect(ROUTE_VARIABLE).toBe(12);
  });
});

describe('walking a route', () => {
  const route = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
  ];

  it('moves part-way along a leg when the distance is short of it', () => {
    const step = Pathfinder.walk(route, { x: 0, y: 0 }, 1, 4);

    expect(step).toEqual({ x: 4, y: 0, index: 1, done: false });
  });

  it('carries overshoot into the next leg rather than parking on a corner', () => {
    // A fixed speed and legs of different lengths mean a step routinely ends
    // past a corner. Dropping the remainder would stall an actor on every one.
    const step = Pathfinder.walk(route, { x: 0, y: 0 }, 1, 14);

    expect(step.x).toBe(10);
    expect(step.y).toBe(4);
    expect(step.done).toBe(false);
  });

  it('reports done once the last point is reached', () => {
    const step = Pathfinder.walk(route, { x: 0, y: 0 }, 1, 100);

    expect(step).toMatchObject({ x: 10, y: 10, done: true });
  });

  it('does not consume distance crossing a zero-length leg', () => {
    // A route that repeats a point is a route with a zero-length leg in it,
    // and treating that as a walk would let an actor "spend" its whole step
    // standing still.
    const repeated = [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 6, y: 0 },
    ];

    const step = Pathfinder.walk(repeated, { x: 0, y: 0 }, 0, 3);

    expect(step).toEqual({ x: 3, y: 0, index: 2, done: false });
  });

  it('is done immediately on an empty route rather than dividing by zero', () => {
    const step = Pathfinder.walk([], { x: 5, y: 5 }, 0, 10);

    expect(step).toEqual({ x: 5, y: 5, index: 0, done: true });
  });
});

/**
 * Which route a click lands on, which is `os1_getPathPosn`'s whole content.
 *
 * A lookup over authored routes rather than a search: the points arrive in the
 * drawing bytecode and the script walks them itself, so being wrong here means
 * choosing the wrong one of the author's paths, never inventing one.
 */
describe('the nearest point on any route', () => {
  it('answers nothing when no script has drawn a route', () => {
    expect(new Pathfinder().nearest(100, 100)).toBeNull();
  });

  it('measures the larger distance plus a quarter of the smaller', () => {
    const pathfinder = new Pathfinder();
    // A click at (100, 100). Route 1's point is 40 across and level with it
    // once the twelve-pixel offset is applied, so 40. Route 2's is directly
    // above and 60 away, so 60. The nearer wins, and neither axis is
    // privileged — which is the reading the reference's cancelling
    // multiplications make easy to get wrong.
    pathfinder.set(1, [[140, 112]]);
    pathfinder.set(2, [[100, 52]]);

    expect(pathfinder.nearest(100, 100)).toEqual({ route: 1, point: 0 });
  });

  it('adds a quarter of the shorter leg rather than ignoring it', () => {
    const pathfinder = new Pathfinder();
    // 40 across and 40 up: 40 + 40/4 = 50, which loses to a point 45 away on
    // one axis. A metric that took only the larger distance would tie at 40
    // and a Manhattan one would score 80.
    pathfinder.set(1, [[140, 152]]);
    pathfinder.set(2, [[145, 112]]);

    expect(pathfinder.nearest(100, 100)).toEqual({ route: 2, point: 0 });
  });

  it('breaks a tie in favour of the route already selected', () => {
    const pathfinder = new Pathfinder();
    pathfinder.set(1, [[100, 112]]);
    pathfinder.set(2, [[100, 112]]);

    // Without the tiebreak an actor standing between two equally near routes
    // flips between them on every click.
    expect(pathfinder.nearest(100, 100, 2)).toEqual({ route: 2, point: 0 });
    expect(pathfinder.nearest(100, 100, 1)).toEqual({ route: 1, point: 0 });
  });

  it('answers the index of the point within its route', () => {
    const pathfinder = new Pathfinder();
    pathfinder.set(1, [
      [10, 112],
      [50, 112],
      [90, 112],
    ]);

    expect(pathfinder.nearest(88, 100)).toEqual({ route: 1, point: 2 });
  });
});
