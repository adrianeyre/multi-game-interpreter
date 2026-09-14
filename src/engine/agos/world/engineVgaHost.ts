/**
 * The VGA host seam, answered by a real game rather than by a recorder.
 *
 * `gfx/vgaHost.ts` defines what a VGA script needs from outside the drawing
 * machine and ships a recorder that answers no to everything and counts the
 * question. That was the honest default for a machine with no world under it,
 * and it is the wrong answer once there *is* one: a script asking "is the
 * lantern in this room" and always hearing no takes the same branch for ever.
 *
 * ## Narrow dependencies, deliberately
 *
 * This takes four small shapes rather than an `AgosEngine` or an `AgosState`.
 * Two reasons, and the second is the one that mattered. The first is testing —
 * every method here can be exercised with an object literal. The second is
 * direction: `AgosState` lives under `script/` and the machine under `gfx/`, so
 * a host that imported the state would put a graphics module downstream of the
 * interpreter, and the two are siblings.
 *
 * ## What it answers honestly, and what it still cannot
 *
 * Nine of the eleven seam methods are real here: the three item queries, the
 * two hit-area operations, `animationScriptOffset`, which reads the graphics
 * resource's own animation table, and the three route calls wherever a
 * {@link Pathfinder} is supplied. `speechActive` is real wherever the caller
 * passes a sound.
 *
 * The **numbered sound effects** are real too wherever the release ships an
 * effects resource. Where it does not — every floppy Simon 1 demo, for one —
 * the two opcodes are **named** through `unsupported` rather than silently
 * doing nothing, which is also what the route calls fall back to when no
 * pathfinder is supplied. So is an effect number the resource has no sound
 * for: that is either a resource we failed to open or a number we read
 * wrongly, and both are things somebody should see.
 */

import type { VgaHost } from '../gfx/vgaHost.js';
import type { VgaEntry } from '../gfx/vgaFile.js';
import type { HitAreaTable } from './hitAreas.js';
import { ROUTE_VARIABLE, type Pathfinder } from './pathfinder.js';

/**
 * The part of the game world the item conditions ask about.
 *
 * Exactly the three things they need, named as the interpreter names them, so a
 * reader can see this is the same world rather than a parallel one.
 */
export interface VgaHostWorld {
  /** Where an item is, as an item number; the interpreter's `parentOf`. */
  parentOf(id: number): number;
  /** The player, which is what "here" is relative to. */
  readonly me: number;
  /** Item records, for the state query. */
  readonly items: readonly ({ readonly state: number } | undefined)[];
  /**
   * A game variable, which is where the selected route's number lives.
   *
   * The interpreter's own `read`. Optional so a caller that only needs the item
   * queries — a test, a sweep — is not obliged to supply a variable array; a
   * host with no variables selects no route rather than route zero.
   */
  read?(variable: number): number;
  /**
   * Writing one, which `COMPUTE_YOFS` needs: it fills variables 20 and up
   * with the walk it has just computed. Optional for the reason `read` is.
   */
  write?(variable: number, value: number): void;
  /**
   * Where a raised sync goes, so a waiting game script can see it.
   *
   * Optional for the reason `read` is: a sweep and a test have no game script
   * to wake, and a host with nowhere to put a sync raises it into the machine's
   * own sprites and no further — which is the behaviour those callers want.
   */
  readonly syncsRaised?: Set<number>;
  /**
   * Raises an animation mark, which a game script may be waiting on.
   *
   * The mirror of {@link syncsRaised} for the persistent-bit kind of wait:
   * `SET_MARK` in the drawing bytecode turns a bit on and `os2_waitMark` in the
   * game bytecode blocks until it is. Optional for the reason `read` is — a
   * sweep with no game script under it has nothing to mark — and a machine with
   * nowhere to put a mark simply does not raise one.
   */
  setMark?(bit: number): void;
  /** Lowers an animation mark, the counterpart of {@link setMark}. */
  clearMark?(bit: number): void;
}

export interface EngineVgaHostParts {
  readonly world: VgaHostWorld;
  readonly hitAreas: HitAreaTable;
  /** The graphics resource's animation table, which `CHAIN_TO` looks a sprite up in. */
  readonly animations: readonly VgaEntry[];
  /** Whether a voice is playing. Omitted where the caller has no sound. */
  readonly sound?: { readonly speechActive: boolean };
  /**
   * Plays a numbered sound effect, returning whether there was one to play.
   *
   * Optional, and its absence is the honest older behaviour: a release that
   * ships no effects resource — every floppy Simon 1 demo, for one — has
   * nothing to hand here, and the opcode is named rather than silently doing
   * nothing.
   */
  playEffect?(effect: number): boolean;
  /** Loads and starts another zone's image, which is what `CALL` asks for. */
  loadImage?(id: number): void;
  /** Points a window at an image. */
  setWindowImage?(windowNumber: number, image: number): void;
  /**
   * Starts a sprite in whichever zone its id names.
   *
   * Optional, and its absence is what a machine with no Engine behind it wants:
   * `NEW_SPRITE` then falls back to this machine's own animation table, which
   * is right for a sweep and for every test that runs one zone.
   */
  startSprite?(zone: number, spriteId: number, x: number, y: number, palette: number): boolean;
  /**
   * Halts a sprite in every zone but the one that asked, which `STOP_ANIMATE`
   * needs because the reference's sprites are one array for the whole game.
   * Optional for the same reason `startSprite` is: a machine with no Engine
   * behind it has only its own sprites, which it halts itself.
   */
  stopSprite?(spriteId: number, zone?: number): void;
  /**
   * A sync has been raised, and sprites in **other zones** may be waiting.
   *
   * The reference keeps one wait table for every sprite in the game, so a sync
   * raised in one zone wakes sprites in all of them. Optional, because a
   * machine with no Engine behind it has no other zones — and `SYNC` still
   * wakes its own sprites either way.
   */
  syncRaised?(id: number): void;
  /** Clears every zone's sprites, which `RESET` asks for. */
  resetSprites?(): void;
  /**
   * The routes a script hands out and picks between.
   *
   * Optional, and its absence is the difference between the two honest
   * answers: with a pathfinder the three route opcodes act, and without one
   * they are named through {@link EngineVgaHostParts.unsupported} exactly as
   * they were before the subsystem existed.
   */
  readonly pathfinder?: Pathfinder;
  /** Where an opcode with nothing behind it is recorded by name. */
  readonly unsupported?: Set<string>;
}

export class EngineVgaHost implements VgaHost {
  constructor(private readonly parts: EngineVgaHostParts) {}

  /**
   * Whether an item is where the player is.
   *
   * **A reading rather than a transcription**, and worth saying so. The
   * interpreter has `o_at` (`parentOf(me) === item`) and `o_carried`
   * (`parentOf(item) === item1`), and neither is this question: "here" means
   * the item shares the player's container. So this is built from the same
   * vocabulary as those two rather than copied from a reference, and if it is
   * wrong it is wrong in a way a game with real data will show.
   */
  objectHere(item: number): boolean {
    const { world } = this.parts;
    return world.parentOf(item) === world.parentOf(world.me);
  }

  /** Whether an item's container is a given item — the interpreter's `o_isAt`. */
  objectIsAt(item: number, parent: number): boolean {
    return this.parts.world.parentOf(item) === parent;
  }

  /** Whether an item's state equals a value — the interpreter's `o_state`. */
  objectStateIs(item: number, state: number): boolean {
    return (this.parts.world.items[item]?.state ?? -1) === state;
  }

  /**
   * Whether a voice is still playing.
   *
   * False where the caller passed no sound, which is a headless run rather than
   * a silence — and false is the safe answer there: it lets an animation
   * proceed rather than waiting for a line that will never start.
   */
  speechActive(): boolean {
    return this.parts.sound?.speechActive ?? false;
  }

  /**
   * The two effect opcodes, which differ in their operands and not their job.
   *
   * `PLAY_SOUND` carries four words and `PLAY_EFFECT` one, and the effect
   * number is the first in both — the remaining three are a channel, a volume
   * and a loop flag this mixer does not take, so they are read and not used
   * rather than silently reinterpreted.
   *
   * An effect number the release ships nothing for is **named**, not ignored:
   * that is either a resource we failed to open or a number we read wrongly,
   * and both are things somebody should see.
   */
  playSound(effect: number): void {
    this.playNumbered(effect, 'PLAY_SOUND');
  }

  playEffect(effect: number): void {
    this.playNumbered(effect, 'PLAY_EFFECT');
  }

  private playNumbered(effect: number, opcode: string): void {
    if (!this.parts.playEffect) {
      this.parts.unsupported?.add(`${opcode}: this release ships no effects resource`);
      return;
    }
    if (!this.parts.playEffect(effect)) {
      this.parts.unsupported?.add(`${opcode}: no effect ${effect} in the resource`);
    }
  }

  enableBox(box: number): void {
    this.parts.hitAreas.setEnabled(box, true);
  }

  /**
   * Moves a hit area.
   *
   * `HitAreaTable.move` takes a **delta**, and the opcode's operands are a
   * delta too, so this passes them through rather than treating them as a
   * position. Reading them as absolute would send every box the script nudges
   * to the top-left corner of the screen.
   */
  moveBox(box: number, x: number, y: number): void {
    this.parts.hitAreas.move(box, x, y);
  }

  /**
   * Where a sprite's animation script starts.
   *
   * `CHAIN_TO` takes no operand — the running sprite's id is the argument — and
   * the resource's animation table is what turns that id into an offset.
   * Returns null when the table has no such id, which is a script and a
   * resource that disagree; the machine records that rather than jumping.
   */
  /**
   * Hands a raised sync to the game's own scripts.
   *
   * The one host method that carries something *out* of the drawing machine
   * rather than answering a question about the world. Both directions matter:
   * the machine wakes its own sprites, and this wakes the game script that
   * started the animation and is waiting for it to end.
   */
  syncRaised(id: number): void {
    this.parts.world.syncsRaised?.add(id);
    this.parts.syncRaised?.(id);
  }

  startSpriteInZone(
    zone: number,
    spriteId: number,
    x: number,
    y: number,
    palette: number,
  ): boolean {
    return this.parts.startSprite?.(zone, spriteId, x, y, palette) ?? false;
  }

  stopSprite(spriteId: number, zone?: number): void {
    this.parts.stopSprite?.(spriteId, zone);
  }

  resetSprites(): void {
    this.parts.resetSprites?.();
  }

  setMark(bit: number): void {
    this.parts.world.setMark?.(bit);
  }

  clearMark(bit: number): void {
    this.parts.world.clearMark?.(bit);
  }

  animationScriptOffset(spriteId: number): number | null {
    const entry = this.parts.animations.find((each) => each.id === spriteId);
    return entry ? entry.scriptOffset : null;
  }

  loadImage(id: number): void {
    if (this.parts.loadImage) {
      this.parts.loadImage(id);
      return;
    }
    this.parts.unsupported?.add('CALL: no zone loader was supplied');
  }

  setWindowImage(windowNumber: number, image: number): void {
    if (this.parts.setWindowImage) {
      this.parts.setWindowImage(windowNumber, image);
      return;
    }
    this.parts.unsupported?.add('SET_WINDOW_IMAGE: no window sink was supplied');
  }

  /**
   * Gives an item the route a script drew for it.
   *
   * The points arrive already decoded — the VGA decoder reads a `q` operand as
   * a list of pairs — so nothing is parsed here. `world/pathfinder.ts` is
   * explicit that this is not a router: the route is authored, and inventing
   * one would send an actor plausibly through scenery nobody tested.
   */
  setPathfindItem(item: number, points: readonly (readonly [number, number])[]): void {
    const pathfinder = this.parts.pathfinder;
    if (!pathfinder) {
      this.parts.unsupported?.add('SET_PATHFIND_ITEM: there is no pathfinder');
      return;
    }
    pathfinder.set(item, points);
  }

  /**
   * Selects the route the game's own variable names.
   *
   * One-based, out of variable 12, falling back to the first route where that
   * names one which is not set. The fallback is the original's behaviour rather
   * than a shortcut — real saves select an invalid route — and a *corrected*
   * selection is recorded by name, because the correction is worth seeing even
   * though it is not a failure.
   */
  computePathfinder(): void {
    const pathfinder = this.parts.pathfinder;
    if (!pathfinder) {
      this.parts.unsupported?.add('COMPUTE_YOFS: there is no pathfinder');
      return;
    }
    const world = this.parts.world;
    const read = world.read?.bind(world);
    const write = world.write?.bind(world);

    const wanted = read?.(ROUTE_VARIABLE) ?? 0;
    const { corrected } = pathfinder.select(wanted);
    if (corrected) this.parts.unsupported?.add(`COMPUTE_YOFS: route ${wanted} is not set`);

    /**
     * The rest of `vc48_setPathFinder`, which is the walk itself.
     *
     * Selecting a route was all this did, and it is the smaller half. The
     * original reads the route from variable 12, the point to start from from
     * 13 and how many steps to take from 14 — negative meaning back along the
     * route — and writes the walk's **per-step vertical deltas** into variables
     * 20 and up, two per step, each leg's change split into halves. The game's
     * own script steps the actor with them, so without them a walk has neither
     * vertical movement nor a length.
     */
    const route = pathfinder.selectedRoute();
    if (!route || !read || !write) return;

    let at = read(13);
    // The step count is read **signed** — the reference's `int c =
    // _variableArray[14]`, where the drawing bytecode's `vcReadVar` casts to
    // int16. A walk *back* along a route is a negative count; the interpreter's
    // `read` returns the array unsigned (`& 0xffff`, matching the game
    // bytecode's own reading), so a −6-step walk arrives here as 65530. Taken
    // unsigned the loop below would write 65530 legs from variable 20 upward,
    // running clean through variable 32 — the junction-cross subroutine a click
    // has just armed — and off the end of the route. Sign-extending is the
    // whole of the fix: it is why a click walked Simon nowhere but on the spot.
    let remaining = (read(14) << 16) >> 16;
    const direction = remaining < 0 ? -1 : 1;
    remaining = Math.abs(remaining);
    let slot = 20;
    for (let taken = 0; taken < remaining; taken += 1) {
      const from = route[at];
      const to = route[at + direction];
      if (!from || !to) break;
      const change = to.y - from.y;
      const half = Math.trunc(change / 2);
      write(slot, half);
      write(slot + 1, change - half);
      slot += 2;
      at += direction;
    }
  }

  /** Forgets every route, so an actor cannot walk one the script discarded. */
  clearPathfind(): void {
    this.parts.pathfinder?.clear();
  }
}
