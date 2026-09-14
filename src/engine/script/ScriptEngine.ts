import type { ObjectWhere } from '../constants.js';

/**
 * What the engine asks of an interpreter, whichever version's it is.
 *
 * ADR 0001 gives each SCUMM version its own script engine over one shared
 * `ScummEngine`. This is the other side of that: the engine drives scripts
 * through these calls and never needs to know which encoding is underneath.
 *
 * Deliberately behaviour only. What is *running* — slots, locals, the cutscene
 * stack — lives in `ScriptState`, which the engine owns and reads directly, so
 * none of it appears here.
 */
export interface ScriptEngine {
  /** Reads a SCUMM variable, resolving the version's address spaces. */
  readVar(variable: number): number;
  writeVar(variable: number, value: number): void;

  runScript(script: number, freezeResistant: boolean, recursive: boolean, args: number[]): void;
  /** Runs an object's handler for one verb, which every version can do. */
  runObjectScript(
    object: number,
    entry: number,
    freezeResistant: boolean,
    recursive: boolean,
    args: number[],
  ): void;
  runInlineScript(pseudoNumber: number, data: Uint8Array, offset: number, where: ObjectWhere): void;
  stopScript(script: number): void;
  isScriptRunning(script: number): boolean;

  /** Runs every slot that is due to run this frame. */
  runAllScripts(): void;
  /** Ages paused scripts by `jiffies` sixtieths — the length of one cycle. */
  updateScriptDelays(jiffies: number): void;
  resumeBrokenScripts(): void;

  freezeScripts(flag: number): void;
  thawAllScripts(): void;
  killScriptsAndResources(): void;
}
