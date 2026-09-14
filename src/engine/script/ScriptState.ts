import { NUM_SCRIPT_SLOTS } from '../constants.js';
import { ScriptArrayTable } from './ScriptArrays.js';
import { ScriptSlot } from './ScriptSlot.js';

/** SCUMM sizes its cutscene arrays at five; nesting deeper is a script bug. */
export const MAX_CUTSCENE_DEPTH = 5;

/**
 * One open cutscene.
 *
 * `ownerScript` is kept alongside `ownerSlot` because the slot is recycled the
 * moment the script dies: without the script number a level orphaned by a room
 * change could not be named in a log, only counted.
 */
export interface CutSceneLevel {
  /** Slot that ran `beginCutscene`. */
  ownerSlot: number;
  /** Script number that slot was running, for diagnostics after it dies. */
  ownerScript: number;
  /** The cutscene's first argument, handed back to the cutscene end script. */
  data: number;
}

/**
 * Where a script resumes if the player skips what is playing.
 *
 * Kept per *depth* rather than per open cutscene, because a skip point is not
 * a property of a cutscene: a script can arm one with no cutscene open at all,
 * and Day of the Tentacle's driver script does exactly that — the whole intro
 * is skippable without ever being a cutscene. Index 0 is that depth-0 slot, so
 * the array is one longer than the deepest nesting.
 */
export interface CutSceneOverride {
  /** Slot to resume, or -1 when nothing is armed at this depth. */
  slot: number;
  /** Offset to resume it at, or -1 when nothing is armed. */
  pointer: number;
}

/**
 * What is running, and how deep into a cutscene it is.
 *
 * This is the half of script execution that does not depend on the instruction
 * encoding. Which slots exist, which one is executing, what each one's locals
 * hold, which cutscenes are open — a v6 stack machine wants all of it in the
 * same shape a v5 interpreter does, because it is the same concept with
 * different bytes underneath.
 *
 * So it lives out here rather than inside a decoder, per ADR 0001. The engine
 * owns it and lends it to whichever script engine the game's version calls for.
 * Decode state — the program counter, the current opcode, the operand stack —
 * stays with the decoder, since that genuinely differs between versions.
 */
export class ScriptState {
  readonly slots: ScriptSlot[] = [];

  /** Index of the slot currently executing, or -1. */
  currentSlot = -1;

  /**
   * The open cutscenes, innermost last.
   *
   * SCUMM keeps this as parallel fixed-size arrays indexed by a stack pointer;
   * one record per level says the same thing without letting the arrays drift
   * out of step. The skip pointer in particular used to share storage with
   * `data`, so arming an override destroyed the argument `endCutscene` owes
   * the cutscene end script.
   */
  readonly cutSceneStack: CutSceneLevel[] = [];

  /**
   * Skip points by cutscene depth, so `cutSceneOverrides[depth]` is the one a
   * script armed while that many cutscenes were open.
   */
  readonly cutSceneOverrides: CutSceneOverride[] = Array.from(
    { length: MAX_CUTSCENE_DEPTH + 1 },
    () => ({ slot: -1, pointer: -1 }),
  );

  /** The skip point for the depth the game is at now. */
  get currentOverride(): CutSceneOverride {
    return this.cutSceneOverrides[this.cutSceneStack.length];
  }

  /**
   * Slot whose `beginCutscene` is running the game's start script, or -1.
   *
   * Only set for the duration of that call. The start script freezes the
   * world, and the slot that opened the cutscene is parked mid-opcode while it
   * does, so `freezeScripts` cannot recognise it as the current script and
   * would freeze the one slot that will ever reach `endCutscene`.
   */
  startingCutsceneSlot = -1;

  /**
   * Script arrays, empty for v5 and the whole of v6's script storage.
   *
   * Here rather than in the v6 decoder because a save has to put it back, and
   * the engine only reaches state through this object (ADR 0001).
   */
  readonly arrays = new ScriptArrayTable();

  constructor() {
    for (let i = 0; i < NUM_SCRIPT_SLOTS; i++) this.slots.push(new ScriptSlot());
  }

  /** The slot executing right now, or `undefined` between scripts. */
  get current(): ScriptSlot | undefined {
    return this.slots[this.currentSlot];
  }
}
