import { NUM_SCRIPT_LOCALS, ObjectWhere, ScriptStatus } from '../constants.js';

/**
 * One running script.
 *
 * SCUMM runs many scripts concurrently, cooperatively: each runs until it
 * blocks (`breakHere`, `wait`, `delay`) and the engine round-robins the slots
 * once per frame. `data`/`base` point at the code because scripts live inside
 * the room or global resource buffers rather than in their own allocation.
 */
export class ScriptSlot {
  number = 0;
  status: ScriptStatus = ScriptStatus.Dead;
  where: ObjectWhere = ObjectWhere.Global;

  /** Program counter, absolute within `data`. */
  offset = 0;
  /** Offset of the script's first instruction, for relative jumps. */
  base = 0;
  data: Uint8Array | null = null;

  /** Frames left to sleep, for `delay`. */
  delay = 0;
  /** True while a `delay` is counting down rather than the script being idle. */
  delayed = false;

  /** Non-zero while frozen by `freezeScripts` or a cutscene. */
  freezeCount = 0;
  /** Set once the slot has run this frame, so it is not run twice. */
  didExec = false;

  /** Cutscene nesting level that owns this slot, for `endCutscene`. */
  cutsceneOverride = 0;

  /** True for scripts started with `startScript` recursive flag. */
  recursive = false;
  /** True if the script survives `freezeScripts`. */
  freezeResistant = false;

  /**
   * Cycles `delayFrames` still has to wait, which is not the same as `delay`.
   *
   * `delay` is a length of *time* and counts sixtieths; this counts *cycles*,
   * and a cycle is however many sixtieths the game asked for. The original
   * keeps them apart for the same reason (`ScriptSlot::delayFrameCount`), and
   * folding one into the other makes `delayFrames` wrong by the cycle rate.
   */
  delayFrameCount = 0;

  readonly locals = new Int32Array(NUM_SCRIPT_LOCALS);

  reset(): void {
    this.number = 0;
    this.status = ScriptStatus.Dead;
    this.where = ObjectWhere.Global;
    this.offset = 0;
    this.base = 0;
    this.data = null;
    this.delay = 0;
    this.delayed = false;
    this.delayFrameCount = 0;
    this.freezeCount = 0;
    this.didExec = false;
    this.cutsceneOverride = 0;
    this.recursive = false;
    this.freezeResistant = false;
    this.locals.fill(0);
  }

  get isRunning(): boolean {
    return this.status === ScriptStatus.Running || this.status === ScriptStatus.Paused;
  }
}
