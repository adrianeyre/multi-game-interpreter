/**
 * AGI's screen objects: the animated things in a room.
 *
 * The counterpart to `src/engine/actor/Actor.ts`, and it shares nothing with
 * it. A SCUMM actor has a costume, a walk box, a scale ramp, a talk script and
 * a z-plane; an AGI screen object has a View, a loop, a cel, a position, a
 * priority and a set of flags — and everything about where it can walk comes
 * from the Picture's priority buffer rather than from the room's geometry.
 *
 * Object 0 is the player, which AGI calls **ego**. Not a special type: it is
 * object 0 with the game's own scripts driving it, which is why `player.control`
 * and `program.control` are the whole of the difference between the player
 * walking and a cutscene walking them.
 */

/** How many animated objects AGI keeps room for. */
export const SCREEN_OBJECT_COUNT = 16;

/** Object 0 is the player. */
export const EGO = 0;

/** The eight directions AGI numbers, with 0 meaning "not moving". */
export const DIRECTION_STEPS: ReadonlyArray<readonly [number, number]> = [
  [0, 0], // 0 stopped
  [0, -1], // 1 north
  [1, -1], // 2 north-east
  [1, 0], // 3 east
  [1, 1], // 4 south-east
  [0, 1], // 5 south
  [-1, 1], // 6 south-west
  [-1, 0], // 7 west
  [-1, -1], // 8 north-west
];

/** What kind of motion a script has put an object under. */
export type MotionKind = 'none' | 'wander' | 'follow.ego' | 'move.obj';

/**
 * One screen object.
 *
 * A plain mutable record rather than a class with behaviour, because every
 * transition an object makes is an opcode: `set.view`, `set.loop`,
 * `start.cycling`, `move.obj`. Putting behaviour here would mean two places
 * decide what `end.of.loop` does.
 */
export interface ScreenObject {
  readonly number: number;

  /** Drawn at all. `draw` sets it and `erase` clears it. */
  drawn: boolean;
  /** `animate.obj` has been called, which is what lets it be drawn. */
  animated: boolean;
  /** Redrawn each cycle. `stop.update` clears it. */
  updating: boolean;

  view: number;
  loop: number;
  cel: number;
  /** Loops in the current View, so `end.of.loop` knows where the end is. */
  loopCount: number;
  celCount: number;

  /** Position, with `y` the object's **bottom** row — where it stands. */
  x: number;
  y: number;
  /** The cel's size, kept so a move can be bounds-checked before it happens. */
  width: number;
  height: number;

  /**
   * Priority, and whether a script fixed it.
   *
   * Unfixed, it comes from the object's row through the Picture's band table —
   * which is what makes walking behind scenery work without any per-object
   * setup. `set.priority` fixes it and `release.priority` gives it back.
   */
  priority: number;
  fixedPriority: boolean;

  /** Cycling through the cels of the current loop. */
  cycling: boolean;
  /** +1 forwards, -1 in reverse, as `reverse.cycle` sets. */
  cycleDirection: number;
  /**
   * Cycling that stops at the end of the loop and sets a flag.
   *
   * `end.of.loop` and `reverse.loop` both work this way, and the flag is how a
   * script waits for an animation: the script polls it rather than blocking, so
   * a "wait" in AGI is a script that returns and is called again next cycle.
   */
  cycleUntilEnd: 'none' | 'forward' | 'reverse';
  cycleEndFlag: number;
  /** Cycles between cel changes; 0 means every cycle. */
  cycleTime: number;
  cycleCounter: number;

  /** Whether the loop follows the direction the object is moving. */
  fixedLoop: boolean;

  direction: number;
  stepSize: number;
  stepTime: number;
  stepCounter: number;
  motion: MotionKind;
  /** Where `move.obj` is heading, and the flag it sets on arrival. */
  moveTo: { x: number; y: number; endFlag: number } | null;
  /** `follow.ego`'s stepSize and the flag it sets when it arrives. */
  followFlag: number;

  /** Blocked by the priority-3 control line and by `block` regions. */
  ignoreBlocks: boolean;
  /** Allowed above the horizon. */
  ignoreHorizon: boolean;
  /** Passes through other objects. */
  ignoreObjects: boolean;
  /** Restricted to water (priority 3) or to land, or neither. */
  restriction: 'none' | 'water' | 'land';
  /** Set when the last attempted step was refused, which scripts test. */
  stopped: boolean;
}

export function createScreenObject(number: number): ScreenObject {
  return {
    number,
    drawn: false,
    animated: false,
    updating: true,
    view: 0,
    loop: 0,
    cel: 0,
    loopCount: 0,
    celCount: 0,
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    priority: 0,
    fixedPriority: false,
    cycling: false,
    cycleDirection: 1,
    cycleUntilEnd: 'none',
    cycleEndFlag: 0,
    cycleTime: 1,
    cycleCounter: 0,
    fixedLoop: false,
    direction: 0,
    stepSize: 1,
    stepTime: 1,
    stepCounter: 0,
    motion: 'none',
    moveTo: null,
    followFlag: 0,
    ignoreBlocks: false,
    ignoreHorizon: false,
    ignoreObjects: false,
    restriction: 'none',
    stopped: false,
  };
}

/**
 * The order objects are drawn in.
 *
 * By priority ascending, so a low-band object is laid down before the ones in
 * front of it. **Equal priorities break by object number ascending**, which
 * `#128` asks to be defined and documented rather than left to the sort's
 * stability: two objects standing on the same row is common — a character and
 * the item they are about to pick up — and an undefined order there means the
 * pair flickers between frames as the array is rebuilt.
 *
 * Object number rather than, say, insertion order, because the number is the
 * only thing about an object a script can rely on: it is what every opcode
 * addresses it by, so an author who needs one in front of the other can
 * arrange it.
 */
export function drawOrder(objects: readonly ScreenObject[]): ScreenObject[] {
  return objects
    .filter((object) => object.drawn && object.animated)
    .sort((a, b) => a.priority - b.priority || a.number - b.number);
}

/**
 * The priority an object draws at.
 *
 * Unfixed, it is read from the band table by the object's own row — so an
 * object walking down the screen comes forward past scenery without a script
 * doing anything. `set.priority` overrides it, and `release.priority` puts it
 * back under the row's control.
 */
export function effectivePriority(object: ScreenObject, bands: Uint8Array): number {
  if (object.fixedPriority) return object.priority;
  const row = Math.max(0, Math.min(bands.length - 1, object.y));
  return bands[row];
}
