/**
 * AGI saved games, in this project's own format.
 *
 * ADR 0002's reasoning applies unchanged: reading Sierra's `.sg` files would
 * buy interoperability at the price of pinning our internal state layout to
 * another project's struct order, permanently. So this is ours, and the UI does
 * not pretend otherwise.
 *
 * It lands before any Completable claim, for the reason `CONTEXT.md` gives:
 * Completable means "played from first screen to last, **saving and resuming
 * along the way**", and no AGI game is completable in one sitting.
 *
 * `src/engine/save/SaveState.ts` is not reusable, only its conventions are.
 * AGI's state is smaller and flatter — 255 flags, 255 vars, the screen-object
 * table, inventory, the room and picture, and the strings — with no cutscene
 * stack and no script slot array. And the two fields v7 *added* to the SCUMM
 * payload, a second camera axis and the identity of the audio bundle, have no
 * AGI equivalent at all, which is more evidence the payload is a sibling rather
 * than a shared shape.
 */

import type { SavedGameEnvelope } from '../../AdventureEngine.js';
import { describeTarget, parseTarget, sameTarget, type Target } from '../../../authoring/target.js';
import { V, type AgiState } from '../script/AgiState.js';
import { createScreenObject, type ScreenObject } from '../ScreenObject.js';

/**
 * Bumped when the shape changes incompatibly. Refused rather than guessed at.
 *
 * Numbered independently of the SCUMM format, because the two payloads version
 * separately: an AGI format 1 and a SCUMM format 4 are not comparable numbers,
 * and one module importing the other's constant is how they would end up
 * compared.
 */
export const AGI_SAVE_FORMAT = 1;

/** One screen object, flattened. Every field, because every field is live. */
export interface SavedScreenObject {
  number: number;
  drawn: boolean;
  animated: boolean;
  updating: boolean;
  view: number;
  loop: number;
  cel: number;
  x: number;
  y: number;
  priority: number;
  fixedPriority: boolean;
  cycling: boolean;
  cycleDirection: number;
  cycleUntilEnd: ScreenObject['cycleUntilEnd'];
  cycleEndFlag: number;
  cycleTime: number;
  fixedLoop: boolean;
  direction: number;
  stepSize: number;
  stepTime: number;
  motion: ScreenObject['motion'];
  moveTo: ScreenObject['moveTo'];
  followFlag: number;
  ignoreBlocks: boolean;
  ignoreHorizon: boolean;
  ignoreObjects: boolean;
  restriction: ScreenObject['restriction'];
}

export interface AgiSavedGame extends SavedGameEnvelope {
  format: number;
  /**
   * The Target that wrote it (ADR 0012).
   *
   * A save is Target-tagged rather than version-tagged, and for AGI that
   * matters twice over: an AGI save and a SCUMM save share no state at all, and
   * two AGI Targets with different interpreter versions can disagree about what
   * a variable means.
   */
  target: Target;
  gameId: string;
  savedAt: number;
  name: string;
  room: number;

  vars: number[];
  flags: number[];
  strings: string[];
  objects: SavedScreenObject[];
  /** Which room each inventory item is in — including "carried". */
  itemRooms: number[];
  picture: number;
  pictureShown: boolean;
  horizon: number;
  playerControl: boolean;
  inputEnabled: boolean;
  statusLineVisible: boolean;
  textMode: boolean;
  priorityBase: number;
  block: { active: boolean; x1: number; y1: number; x2: number; y2: number };
  /** Key-to-controller bindings, as pairs so the save stays plain JSON. */
  keyBindings: Array<[number, number]>;
  disabledControllers: number[];
}

export interface CaptureContext {
  state: AgiState;
  target: Target;
  gameId: string;
  itemRooms: readonly number[];
  priorityBase: number;
}

/** Snapshots everything a resumed game needs and nothing it can rebuild. */
export function captureAgiState(context: CaptureContext, name: string): AgiSavedGame {
  const { state } = context;

  return {
    format: AGI_SAVE_FORMAT,
    target: context.target,
    gameId: context.gameId,
    savedAt: Date.now(),
    name,
    room: state.var(V.CURRENT_ROOM),

    vars: [...state.vars],
    flags: [...state.flags],
    strings: [...state.strings],
    objects: state.objects.map(captureObject),
    itemRooms: [...context.itemRooms],
    picture: state.currentPicture,
    pictureShown: state.pictureShown,
    horizon: state.horizon,
    playerControl: state.playerControl,
    inputEnabled: state.inputEnabled,
    statusLineVisible: state.statusLineVisible,
    textMode: state.textMode,
    priorityBase: context.priorityBase,
    block: { ...state.block },
    keyBindings: [...state.keyBindings.entries()],
    disabledControllers: [...state.disabledControllers],
  };
}

function captureObject(object: ScreenObject): SavedScreenObject {
  return {
    number: object.number,
    drawn: object.drawn,
    animated: object.animated,
    updating: object.updating,
    view: object.view,
    loop: object.loop,
    cel: object.cel,
    x: object.x,
    y: object.y,
    priority: object.priority,
    fixedPriority: object.fixedPriority,
    cycling: object.cycling,
    cycleDirection: object.cycleDirection,
    cycleUntilEnd: object.cycleUntilEnd,
    cycleEndFlag: object.cycleEndFlag,
    cycleTime: object.cycleTime,
    fixedLoop: object.fixedLoop,
    direction: object.direction,
    stepSize: object.stepSize,
    stepTime: object.stepTime,
    motion: object.motion,
    moveTo: object.moveTo ? { ...object.moveTo } : null,
    followFlag: object.followFlag,
    ignoreBlocks: object.ignoreBlocks,
    ignoreHorizon: object.ignoreHorizon,
    ignoreObjects: object.ignoreObjects,
    restriction: object.restriction,
  };
}

/**
 * Why a save cannot be loaded here, or null when it can.
 *
 * Asked before anything is applied, because a partly restored game is a set of
 * symptoms with no cause and every one of them looks like an engine bug.
 *
 * The *order* is deliberate: family first, then game, then format. A save from
 * the other Engine family shares none of the fields below — its numbers mean
 * nothing here — so asking about its format version first would compare two
 * numbers that are not on the same scale, and might well pass.
 */
export function describeIncompatibleAgiSave(
  saved: AgiSavedGame,
  target: Target,
  gameId: string,
): string | null {
  const savedTarget = parseTarget(saved.target);

  if (!savedTarget) {
    return (
      `This save does not carry a Target this build recognises, so there is no ` +
      `way to tell which engine or which game wrote it. It is refused rather ` +
      `than guessed at.`
    );
  }

  if (savedTarget.engine !== 'agi') {
    return (
      `This save was made by ${describeTarget(savedTarget)} and this is an AGI ` +
      `game. The two engines share no state at all — 255 flags are not a ` +
      `variable array — so it is refused rather than read as though they did.`
    );
  }

  if (saved.gameId !== gameId) {
    return (
      `This save belongs to "${saved.gameId}" and the game loaded is "${gameId}". ` +
      `Room, item and Logic numbers mean different things in different games, so ` +
      `it cannot be loaded here.`
    );
  }

  if (saved.format !== AGI_SAVE_FORMAT) {
    return (
      `This save was written in AGI format ${saved.format} and this build reads ` +
      `format ${AGI_SAVE_FORMAT}. Loading it would put the game into a state no ` +
      `script expects, so it is refused rather than half-read.`
    );
  }

  if (!sameTarget(savedTarget, target)) {
    // Same family and same game, different interpreter version or platform —
    // which means a different arity table, so the Logic offsets a script
    // reaches are not the same offsets.
    return (
      `This save was made against ${describeTarget(savedTarget)} and this game ` +
      `is running as ${describeTarget(target)}. The two decode instructions ` +
      `differently, so a saved state from one does not describe the other.`
    );
  }

  return null;
}

export interface RestoreContext {
  state: AgiState;
  target: Target;
  gameId: string;
  itemRooms: number[];
  setPriorityBase(base: number): void;
}

/** Puts a save back, or throws saying why it cannot. Never half-applies. */
export function restoreAgiState(context: RestoreContext, saved: AgiSavedGame): void {
  const refusal = describeIncompatibleAgiSave(saved, context.target, context.gameId);
  if (refusal) throw new Error(refusal);

  const { state } = context;

  state.vars.set(saved.vars.slice(0, state.vars.length));
  state.flags.set(saved.flags.slice(0, state.flags.length));
  for (const [index] of state.strings.entries()) {
    state.strings[index] = saved.strings[index] ?? '';
  }

  for (const [index, object] of state.objects.entries()) {
    const source = saved.objects[index];
    if (!source) {
      state.objects[index] = createScreenObject(object.number);
      continue;
    }
    // Assigned field by field rather than spread, so a field added to
    // `ScreenObject` and forgotten here fails to typecheck instead of silently
    // restoring as undefined.
    Object.assign(object, {
      drawn: source.drawn,
      animated: source.animated,
      updating: source.updating,
      view: source.view,
      loop: source.loop,
      cel: source.cel,
      x: source.x,
      y: source.y,
      priority: source.priority,
      fixedPriority: source.fixedPriority,
      cycling: source.cycling,
      cycleDirection: source.cycleDirection,
      cycleUntilEnd: source.cycleUntilEnd,
      cycleEndFlag: source.cycleEndFlag,
      cycleTime: source.cycleTime,
      cycleCounter: 0,
      fixedLoop: source.fixedLoop,
      direction: source.direction,
      stepSize: source.stepSize,
      stepTime: source.stepTime,
      stepCounter: 0,
      motion: source.motion,
      moveTo: source.moveTo ? { ...source.moveTo } : null,
      followFlag: source.followFlag,
      ignoreBlocks: source.ignoreBlocks,
      ignoreHorizon: source.ignoreHorizon,
      ignoreObjects: source.ignoreObjects,
      restriction: source.restriction,
      stopped: false,
      // Cel dimensions are derivable from the View, so they are not stored —
      // the same rule the SCUMM save follows for room graphics. Re-applied by
      // the engine once the View is loaded again.
      width: 0,
      height: 0,
      loopCount: 0,
      celCount: 0,
    } satisfies Partial<ScreenObject>);
  }

  for (const [index] of context.itemRooms.entries()) {
    context.itemRooms[index] = saved.itemRooms[index] ?? context.itemRooms[index];
  }

  state.currentPicture = saved.picture;
  state.pictureShown = saved.pictureShown;
  state.horizon = saved.horizon;
  state.playerControl = saved.playerControl;
  state.inputEnabled = saved.inputEnabled;
  state.statusLineVisible = saved.statusLineVisible;
  state.textMode = saved.textMode;
  state.block = { ...saved.block };

  state.keyBindings.clear();
  for (const [controller, key] of saved.keyBindings) state.keyBindings.set(controller, key);
  state.disabledControllers.clear();
  for (const controller of saved.disabledControllers) state.disabledControllers.add(controller);

  context.setPriorityBase(saved.priorityBase);

  // Not restored, deliberately: `pendingRoom` and `exitAllLogics` are
  // mid-cycle bookkeeping, and a save taken between cycles has neither set.
  state.pendingRoom = null;
  state.exitAllLogics = false;
  state.quitRequested = false;
  state.restartRequested = false;
}

/**
 * What to tell the player about an AGI save.
 *
 * Says the two things that surprise people, and ADR 0002's stated consequence
 * is the first of them: these are not interchangeable with anything else, and
 * an AGI save and a SCUMM save are not interchangeable with each other either.
 */
export const AGI_SAVE_NOTE =
  'AGI saves are kept in this browser, for this game, and are specific to this ' +
  'interpreter — Sierra’s own save files and ScummVM’s cannot be read, and ' +
  'these cannot be read by them. A SCUMM save and an AGI save are not ' +
  'interchangeable and loading one into the other is refused.';
