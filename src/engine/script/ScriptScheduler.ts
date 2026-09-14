import { ObjectWhere, ScriptStatus } from '../constants.js';
import type { ScummEngine } from '../ScummEngine.js';
import type { ScriptState } from './ScriptState.js';

/**
 * Running scripts: which slots exist, whose turn it is, and when they stop.
 *
 * The half of an interpreter that does not depend on the instruction encoding.
 * A stack machine and a byte-per-opcode machine disagree about everything in
 * how a script is *read* and about nothing in how one is *scheduled*, so this
 * is shared and the decoding is not (ADR 0001).
 *
 * The implementations here are the v5 engine's, which are the ones a released
 * game has been played through. That direction matters: converging on the newer
 * copy would have kept four faults the v6 engine had picked up on its own —
 * a freeze-resistant script being frozen when the flag said not to, room
 * scripts answering `isScriptRunning`, the sentence not thawing with the
 * scripts, and a room change dropping cutscene state without a word.
 */
export abstract class ScriptScheduler {
  protected readonly engine: ScummEngine;
  protected readonly state: ScriptState;

  /** Script ids already reported as missing, so each is said once. */
  protected readonly missingScripts = new Set<number>();

  constructor(engine: ScummEngine, state: ScriptState) {
    this.engine = engine;
    this.state = state;
  }

  /** Runs the current slot until it yields, ends, or runs out of budget. */
  protected abstract executeSlot(): void;

  protected findFreeSlot(): number {
    for (let i = 0; i < this.state.slots.length; i++) {
      if (this.state.slots[i].status === ScriptStatus.Dead) return i;
    }
    throw new Error('Out of script slots');
  }

  /**
   * Says once that a script could not be found.
   *
   * Once, because a game polls: a script started every frame by a background
   * loop would otherwise fill the log with the same line and bury everything
   * else in it.
   */
  protected reportMissingScript(script: number, kind: 'global' | 'local'): void {
    if (this.missingScripts.has(script)) return;
    this.missingScripts.add(script);
    this.engine.trace(
      `Script ${script} was started but there is no ${kind} script ${script} in this game, ` +
        `so nothing ran`,
    );
  }

  /** Kills every slot running `script`, wherever it lives. */
  stopScript(script: number): void {
    if (this.engine.traceScripts) this.engine.trace(`script ${script} stopped`);
    if (script === 0) return;
    for (let i = 0; i < this.state.slots.length; i++) {
      const slot = this.state.slots[i];
      if (
        slot.number === script &&
        slot.status !== ScriptStatus.Dead &&
        (slot.where === ObjectWhere.Global || slot.where === ObjectWhere.Local)
      ) {
        slot.reset();
        if (this.state.currentSlot === i) this.state.currentSlot = -1;
      }
    }
  }

  isScriptRunning(script: number): boolean {
    return this.state.slots.some(
      (slot) =>
        slot.number === script &&
        slot.where !== ObjectWhere.Room &&
        slot.status !== ScriptStatus.Dead,
    );
  }

  /**
   * Whether a *room* script of that number is running.
   *
   * Deliberately the complement of `isScriptRunning`, which excludes room
   * scripts: a game asks these two different questions of the same number, and
   * answering either with the other's slots is how a room script ends up
   * reported as a global one.
   */
  isRoomScriptRunning(script: number): boolean {
    return this.state.slots.some(
      (slot) =>
        slot.number === script &&
        slot.where === ObjectWhere.Room &&
        slot.status !== ScriptStatus.Dead,
    );
  }

  isObjectScriptRunning(object: number): boolean {
    return this.state.slots.some(
      (slot) =>
        slot.number === object &&
        (slot.where === ObjectWhere.Room ||
          slot.where === ObjectWhere.Inventory ||
          slot.where === ObjectWhere.FlObject) &&
        slot.status !== ScriptStatus.Dead,
    );
  }

  /**
   * Kills every slot running a verb script for that object.
   *
   * Object scripts are addressed by object number, not script number, and live
   * in three different places depending on whether the object is in the room,
   * in the inventory, or a floating object — so this cannot go through
   * `stopScript`, which looks at the other two `where`s.
   */
  stopObjectScript(object: number): void {
    for (let i = 0; i < this.state.slots.length; i++) {
      const slot = this.state.slots[i];
      if (
        slot.number === object &&
        slot.status !== ScriptStatus.Dead &&
        (slot.where === ObjectWhere.Room ||
          slot.where === ObjectWhere.Inventory ||
          slot.where === ObjectWhere.FlObject)
      ) {
        slot.reset();
        if (this.state.currentSlot === i) this.state.currentSlot = -1;
      }
    }
  }

  /**
   * Suspends every other script, the way `freezeScripts` does in the original.
   *
   * The one slot that must survive is whichever script opened the cutscene
   * that is being set up. It is parked mid-opcode inside `beginCutscene` while
   * the game's own cutscene start script runs nested, so `currentSlot` is the
   * start script, not the opener, and the check above does not spare it.
   * Freezing the opener is fatal rather than merely wrong: a frozen slot is
   * never stepped again, and the opener is the script that would later reach
   * `endCutscene`, so the cutscene — and the input lock and hidden actors that
   * come with it — would last for the rest of the session.
   */
  freezeScripts(flag: number): void {
    for (let i = 0; i < this.state.slots.length; i++) {
      const slot = this.state.slots[i];
      if (this.state.currentSlot !== i && slot.status !== ScriptStatus.Dead) {
        if (!slot.freezeResistant || flag >= 0x80) slot.freezeCount++;
      }
    }

    const opener = this.state.slots[this.state.startingCutsceneSlot];
    if (opener) opener.freezeCount = 0;

    this.engine.freezeSentence();
  }

  /**
   * Kills every script but the one running, as v6's kernel form asks.
   *
   * Used at the seams where a game throws the world away and rebuilds it — a
   * restart, or the hand-off into a set piece. The current slot has to survive
   * because it is the script doing the asking, and it still has instructions
   * after this one.
   */
  killAllScriptsExceptCurrent(): void {
    for (let i = 0; i < this.state.slots.length; i++) {
      if (i === this.state.currentSlot) continue;
      this.state.slots[i].reset();
    }
    this.state.cutSceneStack.length = 0;
    this.state.startingCutsceneSlot = -1;
  }

  /** Clears every freeze at once, for recovery paths that cannot count them. */
  thawAllScripts(): void {
    for (const slot of this.state.slots) slot.freezeCount = 0;
    this.engine.unfreezeSentence();
  }

  /** Kills room-owned scripts when leaving a room. */
  killScriptsAndResources(): void {
    for (let i = 0; i < this.state.slots.length; i++) {
      const slot = this.state.slots[i];
      const roomOwned =
        slot.where === ObjectWhere.Room ||
        slot.where === ObjectWhere.FlObject ||
        slot.where === ObjectWhere.Local;
      if (!roomOwned) continue;

      if (slot.cutsceneOverride > 0) {
        this.engine.warn(
          `Script ${slot.number} stopped by a room change with an active cutscene or override`,
        );
        slot.cutsceneOverride = 0;
      }
      slot.reset();
      if (this.state.currentSlot === i) this.state.currentSlot = -1;
    }

    // Levels those scripts opened have lost the only thing that could close
    // them, so drop them rather than leave input suspended for good.
    this.engine.unwindOrphanedCutscenes();
  }

  /**
   * Ages `delay` counters; a slot wakes when its delay expires.
   *
   * By the length of the cycle rather than by one, because a delay is a length
   * of *time*: `delay 60` means one second and the counter is in sixtieths.
   * `decreaseScriptDelay(delta)` is what the original calls, and calling it
   * with one instead spends a cycle's worth of the counter however long the
   * cycle actually was — so a game running ten cycles a second took six
   * seconds over every one-second wait, and everything paced by a script's
   * own waiting ran at a sixth speed.
   */
  updateScriptDelays(jiffies = 1): void {
    const amount = Math.max(1, jiffies);
    for (const slot of this.state.slots) {
      if (slot.status === ScriptStatus.Paused && slot.delayed) {
        slot.delay -= amount;
        if (slot.delay <= 0) {
          slot.status = ScriptStatus.Running;
          slot.delayed = false;
        }
      }
    }
  }

  /** Resumes every slot paused by `breakHere` so they run again next frame. */
  resumeBrokenScripts(): void {
    for (const slot of this.state.slots) {
      if (slot.status === ScriptStatus.Paused && !slot.delayed) {
        slot.status = ScriptStatus.Running;
      }
    }
  }
}
