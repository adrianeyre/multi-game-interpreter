/**
 * The VGA host seam with a real game behind it.
 *
 * The recorder in `gfx/vgaHost.ts` answers no to every question and counts it,
 * which is the honest default for a machine with no world under it. These tests
 * are about the answers being *real* instead — and mostly about the ones that
 * are still not, because a seam that quietly does nothing for four of its ten
 * methods is the failure mode this project keeps designing out.
 */
import { describe, expect, it } from 'vitest';
import {
  EngineVgaHost,
  type EngineVgaHostParts,
  type VgaHostWorld,
} from '../src/engine/agos/world/engineVgaHost.js';
import type { VgaHost } from '../src/engine/agos/gfx/vgaHost.js';
import { HitAreaTable } from '../src/engine/agos/world/hitAreas.js';
import { Pathfinder } from '../src/engine/agos/world/pathfinder.js';

/**
 * A world where item 5 is in room 100 with the player, and item 6 is elsewhere.
 *
 * Built as a literal rather than by booting a game, which is the whole reason
 * the host takes narrow shapes: the item conditions need three facts and this
 * supplies exactly those three.
 */
function worldOf(): VgaHostWorld {
  const parents = new Map<number, number>([
    [1, 100], // the player
    [5, 100], // here
    [6, 200], // somewhere else
  ]);
  return {
    me: 1,
    parentOf: (id) => parents.get(id) ?? 0,
    items: [undefined, undefined, undefined, undefined, undefined, { state: 3 }, { state: 0 }],
  };
}

/**
 * The host under test, typed as the seam rather than as the class.
 *
 * `VgaHost` is what the machine holds it by, and it is also the only type that
 * declares the operands: the concrete methods that ignore their arguments
 * declare none, so calling `setPathfindItem(1, [])` through the class is a type
 * error while calling it through the interface is the real call site.
 */
function hostOf(extra: Partial<EngineVgaHostParts> = {}) {
  const hitAreas = new HitAreaTable();
  const unsupported = new Set<string>();
  const host: VgaHost = new EngineVgaHost({
    world: worldOf(),
    hitAreas,
    animations: [
      { id: 7, scriptOffset: 40 },
      { id: 9, scriptOffset: 80 },
    ],
    unsupported,
    ...extra,
  });
  return { host, hitAreas, unsupported };
}

describe('the item conditions read the real world', () => {
  it('calls an item here when it shares the player container', () => {
    const { host } = hostOf();

    expect(host.objectHere(5)).toBe(true);
    expect(host.objectHere(6)).toBe(false);
  });

  it('answers objectIsAt against the container the script names', () => {
    const { host } = hostOf();

    expect(host.objectIsAt(6, 200)).toBe(true);
    expect(host.objectIsAt(6, 100)).toBe(false);
  });

  it('answers objectStateIs, and says no for an item that does not exist', () => {
    const { host } = hostOf();

    expect(host.objectStateIs(5, 3)).toBe(true);
    expect(host.objectStateIs(5, 4)).toBe(false);
    // -1 rather than 0 for a missing item, so state 0 is not a false positive:
    // most items *are* state 0, so the wrong default here would make every
    // absent item pass.
    expect(host.objectStateIs(999, 0)).toBe(false);
  });
});

describe('hit areas are really enabled and really moved', () => {
  it('enables a box the script names', () => {
    const { host, hitAreas } = hostOf();
    hitAreas.add(4, 10, 10, 20, 20, 0, 0);
    hitAreas.setEnabled(4, false);

    host.enableBox(4);

    expect(hitAreas.at(15, 15)?.id).toBe(4);
  });

  it('treats MOVE_BOX operands as a delta, not a position', () => {
    // The bug this guards: `HitAreaTable.move` takes a delta and the opcode
    // supplies one, so reading them as absolute would send every box a script
    // nudges to the top-left of the screen.
    const { host, hitAreas } = hostOf();
    hitAreas.add(4, 10, 10, 20, 20, 0, 0);

    host.moveBox(4, 5, 5);

    expect(hitAreas.at(18, 18)?.id).toBe(4);
    expect(hitAreas.at(12, 12)).toBeUndefined();
  });
});

describe('CHAIN_TO finds a sprite in the animation table', () => {
  it('returns the offset the table gives', () => {
    const { host } = hostOf();

    expect(host.animationScriptOffset(9)).toBe(80);
  });

  it('returns null for a sprite the table does not have, rather than zero', () => {
    // Zero is a real script offset, so returning it for "not found" would
    // send a chain to the start of the resource instead of reporting a script
    // and a resource that disagree.
    const { host } = hostOf();

    expect(host.animationScriptOffset(11)).toBeNull();
  });
});

describe('speech is a real question where there is a sound', () => {
  it('reports what the sound reports', () => {
    const { host } = hostOf({ sound: { speechActive: true } });

    expect(host.speechActive()).toBe(true);
  });

  it('says no rather than waiting when there is no sound at all', () => {
    // False is the safe answer for a headless run: it lets an animation
    // proceed rather than holding it for a line that will never start.
    const { host } = hostOf();

    expect(host.speechActive()).toBe(false);
  });
});

describe('what still has nothing behind it is named, not ignored', () => {
  it('names the sound effects, because AGOS effects are not read', () => {
    const { host, unsupported } = hostOf();

    host.playSound(1, 2, 3, 4);
    host.playEffect(6);

    expect([...unsupported].join(' ')).toContain('PLAY_SOUND');
    expect([...unsupported].join(' ')).toContain('PLAY_EFFECT');
  });

  it('names both route calls when no pathfinder was supplied', () => {
    // The fallback the route opcodes had before the subsystem existed, kept
    // for a host constructed without one.
    const { host, unsupported } = hostOf();

    host.setPathfindItem(1, []);
    host.computePathfinder();

    expect([...unsupported].join(' ')).toContain('there is no pathfinder');
  });

  it('names CALL when no zone loader was supplied, and uses one when it was', () => {
    const { host, unsupported } = hostOf();
    host.loadImage(300);
    expect([...unsupported].join(' ')).toContain('CALL');

    const loaded: number[] = [];
    const { host: wired } = hostOf({
      loadImage: (id: number) => {
        loaded.push(id);
      },
    });
    wired.loadImage(300);
    expect(loaded).toEqual([300]);
  });
});

describe('the route calls act when a pathfinder is behind them', () => {
  function routed() {
    const pathfinder = new Pathfinder();
    const unsupported = new Set<string>();
    // Variable 12 is where a script leaves the selected route's number.
    const variables = new Map<number, number>([[12, 1]]);
    const host: VgaHost = new EngineVgaHost({
      world: { ...worldOf(), read: (variable) => variables.get(variable) ?? 0 },
      hitAreas: new HitAreaTable(),
      animations: [],
      pathfinder,
      unsupported,
    });
    return { host, pathfinder, unsupported, variables };
  }

  it('stores a route against its item rather than naming it unsupported', () => {
    const { host, pathfinder, unsupported } = routed();

    host.setPathfindItem(5, [
      [1, 2],
      [3, 4],
    ]);

    expect(pathfinder.routeFor(5)).toEqual([
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ]);
    expect([...unsupported].join(' ')).not.toContain('SET_PATHFIND_ITEM');
  });

  it('selects the route the game variable names', () => {
    const { host, pathfinder, variables } = routed();
    host.setPathfindItem(5, [[1, 1]]);
    host.setPathfindItem(9, [[2, 2]]);

    variables.set(12, 2);
    host.computePathfinder();

    // Route 2 of two, ordered by item: item 9.
    expect(pathfinder.selectedItem).toBe(9);
  });

  it('records a corrected selection, because a fallback is worth seeing', () => {
    // Not a failure — the original corrects an invalid route because real
    // saves contain one — but not something to pass over silently either.
    const { host, pathfinder, unsupported, variables } = routed();
    host.setPathfindItem(5, [[1, 1]]);

    variables.set(12, 99);
    host.computePathfinder();

    expect(pathfinder.selectedItem).toBe(5);
    expect([...unsupported].join(' ')).toContain('route 99 is not set');
  });

  it('really clears the routes, so an actor cannot walk a discarded one', () => {
    const { host, pathfinder } = routed();
    host.setPathfindItem(5, [[1, 1]]);

    host.clearPathfind();

    expect(pathfinder.size).toBe(0);
  });
});

describe('the step count of vc48 is read signed, not unsigned', () => {
  /**
   * A world backed by a variable Map that can be written as well as read — the
   * walk half of `computePathfinder` writes its per-step deltas into variables
   * 20 and up, so a test of it has to see the writes.
   */
  function walking() {
    const pathfinder = new Pathfinder();
    const variables = new Map<number, number>();
    const host: VgaHost = new EngineVgaHost({
      world: {
        ...worldOf(),
        read: (variable) => variables.get(variable) ?? 0,
        write: (variable, value) => {
          variables.set(variable, value);
        },
      },
      hitAreas: new HitAreaTable(),
      animations: [],
      pathfinder,
      unsupported: new Set<string>(),
    });
    // A route long enough that an unsigned overrun would run clean past the
    // junction-cross Subroutine parked in variable 32.
    const route: (readonly [number, number])[] = [];
    for (let i = 0; i < 20; i += 1) route.push([i, i * 10]);
    host.setPathfindItem(1, route);
    variables.set(12, 1); // select route 1
    return { host, variables };
  }

  it('walks six legs back along the route, leaving variable 32 untouched', () => {
    const { host, variables } = walking();
    variables.set(13, 6); // start six points in
    // −6 as the drawing bytecode's signed read sees it, but stored the way the
    // interpreter's `read` hands it over: unsigned, so 65530.
    variables.set(14, 0x10000 - 6);
    // The junction-cross Subroutine a click has just armed. If the loop takes
    // the count unsigned it writes 65530 legs from variable 20 up and clobbers
    // this on the way past.
    variables.set(32, 5304);

    host.computePathfinder();

    // Exactly six legs, two deltas each, into variables 20..31 and no further:
    // variable 32 still holds the Subroutine number, and slot 33 was never
    // reached, so the loop stopped where the signed count says it should.
    expect(variables.get(32)).toBe(5304);
    for (let slot = 20; slot <= 31; slot += 1) {
      expect(variables.has(slot)).toBe(true);
    }
    expect(variables.has(33)).toBe(false);
  });

  it('walks forward when the count is genuinely positive', () => {
    const { host, variables } = walking();
    variables.set(13, 0);
    variables.set(14, 6);
    variables.set(32, 5304);

    host.computePathfinder();

    // Six legs forward, still exactly variables 20..31, still not variable 32.
    expect(variables.get(32)).toBe(5304);
    expect(variables.has(31)).toBe(true);
    expect(variables.has(33)).toBe(false);
    // Each leg of this route rises by 10, split into halves: 5 and 5.
    expect(variables.get(20)).toBe(5);
    expect(variables.get(21)).toBe(5);
  });
});
