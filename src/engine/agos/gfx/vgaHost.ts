/**
 * What a VGA script needs from outside the drawing machine.
 *
 * `VgaMachine` runs the bytecode that places what a player sees, and a third of
 * Simon 1's opcodes ask about things the machine does not own: whether an item
 * is in the room, whether speech is still playing, which hit areas are live.
 * Those are the game's world and the Engine's sound, not the renderer's, and
 * before this seam existed the machine had no way to ask — so every one of them
 * landed in `unimplemented` and stayed there.
 *
 * ## Why an interface rather than a reference to the Engine
 *
 * The machine is constructed by the sweep and by tests with no Engine at all
 * (`bin/agos-sweep.ts` reads a game and runs its scripts to check **Structural
 * agreement**, and cares about instruction boundaries rather than about sound).
 * A required Engine would make those callers build one, and a nullable Engine
 * field would put `?.` at forty call sites. An interface with a recording
 * default gives both callers the same code path.
 *
 * ## The default records rather than pretends
 *
 * {@link RecordingVgaHost} answers every query falsely — no item is here, no
 * speech is playing — and *counts* what was asked. That is the honest answer
 * for a machine with no world under it, and it keeps this project's rule that a
 * silent no-op is worse than a named gap: a script that ran with a recording
 * host produces a count somebody can read, not a screen that is quietly wrong.
 *
 * A false answer is still an answer, though, and the distinction matters for
 * the coverage figure. An opcode wired to this seam is implemented in the sense
 * that it decodes, consumes its operands and takes the branch its answer
 * implies. It is **not** evidence the game behaves correctly, which needs a
 * host with a real world behind it.
 */

/** The item-tree, sound and hit-area questions a VGA script asks. */
export interface VgaHost {
  /** Whether an item is in the room the player is in. */
  objectHere(item: number): boolean;
  /** Whether an item's parent is a given item. */
  objectIsAt(item: number, parent: number): boolean;
  /** Whether an item's state equals a given value. */
  objectStateIs(item: number, state: number): boolean;
  /** Whether speech is still playing, which is how a script waits for a line. */
  speechActive(): boolean;
  /**
   * A sync id has been raised, and a *game* script may be waiting for it.
   *
   * `SYNC` already wakes the sprites of its own machine, which is the drawing
   * bytecode talking to itself. This is the other direction: `o_waitSync` in
   * the game bytecode blocks until an id turns up, and Simon 1's intro is built
   * out of that pairing — start an animation, wait for it to say it has
   * finished. Without a way across the seam the game script waited on something
   * only the renderer could see.
   */
  syncRaised(id: number): void;
  /**
   * Starts a sprite, which may belong to **another zone**.
   *
   * `NEW_SPRITE` names a sprite and the zone it lives in. In Simon 1 the zone
   * is not an operand — it is the id's own hundreds column, the reference's
   * `vgaSpriteId / 100` in `vc3_loadSprite` — so a script in zone 135 saying
   * `NEW_SPRITE 13402` starts a sprite that lives in zone 134. Simon 2 carries
   * the zone as an explicit operand instead, and the machine passes whichever
   * of the two its shape gave it rather than re-deriving it here.
   *
   * That is not an edge case in Simon 1: its intro is one script in one zone
   * starting nineteen sprites across a dozen others. With cross-zone starts
   * failing, the sprites that raise the syncs the *game* script waits for were
   * never created, so the intro stopped at its first wait and timed out.
   *
   * Answered by the Engine, which owns zone loading. Returns false when there
   * is no such sprite anywhere, which the machine records by name.
   */
  startSpriteInZone(zone: number, spriteId: number, x: number, y: number, palette: number): boolean;
  /**
   * Halts a sprite, which `STOP_ANIMATE` asks for.
   *
   * Simon 2 names the zone the sprite lives in — its ids are zone-local, so the
   * same id runs in many zones — and passes it here. Simon 1 gives an id alone,
   * whose sprites are global, and leaves the zone out: the machine halts its
   * own copy and this reaches every other loaded zone.
   */
  stopSprite(spriteId: number, zone?: number): void;
  /**
   * Clears the sprite table of **every** zone, which `RESET` asks for.
   *
   * The reference keeps one sprite array for the whole game, so a script
   * ending a scene clears the sprites of every zone that scene used.
   */
  resetSprites(): void;
  /**
   * Raises an animation mark, which `SET_MARK` does.
   *
   * A mark is how the drawing bytecode tells the *game* bytecode that an
   * animation has reached a moment: `os2_waitMark` blocks until the bit turns
   * on. The two are one word in the reference, shared across the seam here, so
   * a mark a sprite sets in one zone is a mark a game script waiting anywhere
   * can see.
   */
  setMark(bit: number): void;
  /** Lowers an animation mark, which `CLEAR_MARK` does. */
  clearMark(bit: number): void;
  /** Start a sound. The four operands are the reference's, in its order. */
  playSound(a: number, b: number, c: number, d: number): void;
  /** Start a sound effect by number. */
  playEffect(effect: number): void;
  /** Make a hit area live, so a click can reach it. */
  enableBox(box: number): void;
  /** Move a hit area. */
  moveBox(box: number, x: number, y: number): void;
  /**
   * Where a sprite's animation script starts, for `CHAIN_TO`.
   *
   * `CHAIN_TO` takes no operands: it restarts the *running* sprite's own
   * animation, which the original finds by looking the sprite's id up in the
   * VGA file's animation table. Returns null when the table has no such id,
   * which is a script and a resource that disagree — reported rather than
   * jumped to.
   */
  animationScriptOffset(spriteId: number): number | null;
  /**
   * Load and start another zone's image, which is what `CALL` does.
   *
   * Not a subroutine call despite the name: the original saves the two current
   * VGA file pointers, loads the image the operand names, and puts the pointers
   * back — so the called script runs against its own resource and control
   * returns here. Zone loading is the Engine's, so it is asked for rather than
   * done.
   */
  loadImage(id: number): void;
  /** Point a window at an image, which is how a room's backdrop is put up. */
  setWindowImage(windowNumber: number, image: number): void;
  /** Give the pathfinder a route: an item and the list of points it walks. */
  setPathfindItem(item: number, points: readonly (readonly [number, number])[]): void;
  /** Recompute the pathfinder's chosen route from the game's own variables. */
  computePathfinder(): void;
  /**
   * Forget every route.
   *
   * `CLEAR_PATHFIND_ARRAY` was counted rather than acted on for as long as
   * there was no pathfinder to clear. Now that there is one, counting it would
   * leave an actor walking a route the script had discarded.
   */
  clearPathfind(): void;
}

/** What a {@link RecordingVgaHost} was asked for, so a test or a sweep can read it. */
export interface VgaHostRecord {
  readonly objectQueries: number;
  readonly soundsPlayed: number;
  readonly effectsPlayed: number;
  readonly speechChecks: number;
  readonly boxesEnabled: readonly number[];
  readonly boxesMoved: readonly number[];
  readonly chainLookups: number;
  /** Sync ids raised, which a test reads to check the pairing. */
  readonly syncsRaised: readonly number[];
  /** Sprite ids a script asked to start, which a test reads. */
  readonly spritesStarted: readonly number[];
  /** Sprite ids a script asked to stop, which a test reads. */
  readonly spritesStopped: readonly number[];
  /** How many times a script cleared every zone's sprites. */
  readonly spriteResets: number;
  /** Mark bits a script raised, which a test reads. */
  readonly marksSet: readonly number[];
  /** Mark bits a script lowered. */
  readonly marksCleared: readonly number[];
  readonly imagesLoaded: readonly number[];
  readonly windowImages: number;
  readonly pathfindRoutes: number;
  readonly pathfinderComputations: number;
  readonly pathfindClears: number;
}

/**
 * A host with no world, which counts what it was asked.
 *
 * The default for every caller that has a game's bytes but not a running game:
 * the sweep, and every test about instruction decoding rather than about
 * behaviour.
 */
export class RecordingVgaHost implements VgaHost {
  private objectQueryCount = 0;
  private soundCount = 0;
  private effectCount = 0;
  private speechCount = 0;
  private chainCount = 0;
  private readonly enabled: number[] = [];
  private readonly moved: number[] = [];
  private readonly loaded: number[] = [];
  private readonly raisedSyncs: number[] = [];
  private readonly startedSprites: number[] = [];
  private readonly stoppedSprites: number[] = [];
  private readonly marksSet: number[] = [];
  private readonly marksCleared: number[] = [];
  private spriteResets = 0;
  private windowImageCount = 0;
  private pathfindRouteCount = 0;
  private pathfinderComputeCount = 0;
  private pathfindClearCount = 0;

  objectHere(): boolean {
    this.objectQueryCount += 1;
    return false;
  }

  objectIsAt(): boolean {
    this.objectQueryCount += 1;
    return false;
  }

  objectStateIs(): boolean {
    this.objectQueryCount += 1;
    return false;
  }

  speechActive(): boolean {
    this.speechCount += 1;
    return false;
  }

  syncRaised(id: number): void {
    this.raisedSyncs.push(id);
  }

  startSpriteInZone(_zone: number, spriteId: number): boolean {
    this.startedSprites.push(spriteId);
    return false;
  }

  stopSprite(spriteId: number): void {
    this.stoppedSprites.push(spriteId);
  }

  resetSprites(): void {
    this.spriteResets += 1;
  }

  setMark(bit: number): void {
    this.marksSet.push(bit);
  }

  clearMark(bit: number): void {
    this.marksCleared.push(bit);
  }

  playSound(): void {
    this.soundCount += 1;
  }

  playEffect(): void {
    this.effectCount += 1;
  }

  enableBox(box: number): void {
    this.enabled.push(box);
  }

  moveBox(box: number): void {
    this.moved.push(box);
  }

  animationScriptOffset(): number | null {
    this.chainCount += 1;
    return null;
  }

  loadImage(id: number): void {
    this.loaded.push(id);
  }

  setWindowImage(): void {
    this.windowImageCount += 1;
  }

  setPathfindItem(): void {
    this.pathfindRouteCount += 1;
  }

  computePathfinder(): void {
    this.pathfinderComputeCount += 1;
  }

  clearPathfind(): void {
    this.pathfindClearCount += 1;
  }

  get record(): VgaHostRecord {
    return {
      objectQueries: this.objectQueryCount,
      soundsPlayed: this.soundCount,
      effectsPlayed: this.effectCount,
      speechChecks: this.speechCount,
      boxesEnabled: [...this.enabled],
      boxesMoved: [...this.moved],
      chainLookups: this.chainCount,
      syncsRaised: [...this.raisedSyncs],
      spritesStarted: [...this.startedSprites],
      spritesStopped: [...this.stoppedSprites],
      spriteResets: this.spriteResets,
      marksSet: [...this.marksSet],
      marksCleared: [...this.marksCleared],
      imagesLoaded: [...this.loaded],
      windowImages: this.windowImageCount,
      pathfindRoutes: this.pathfindRouteCount,
      pathfinderComputations: this.pathfinderComputeCount,
      pathfindClears: this.pathfindClearCount,
    };
  }
}
