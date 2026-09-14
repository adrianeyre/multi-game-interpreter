/**
 * AGOS saved games, in this project's own format.
 *
 * ADR 0002's reasoning applies unchanged for the fourth time: reading another
 * project's saves would pin our state layout to their struct order permanently.
 * And it lands before any Completable claim for the reason `CONTEXT.md` gives —
 * Completable means played from first screen to last, *saving and resuming
 * along the way*, and no AGOS game is finishable in one sitting.
 *
 * ## What makes this one different from its siblings
 *
 * SCUMM and AGI save a set of scalars: variables, flags, a room number, a table
 * of screen objects. AGOS's world is a **tree that the game rewrites** — `o_place`
 * re-parents an item, and that is how anything happens at all. So a save is a
 * graph delta, which puts it closer to ADR 0019's SCI problem than to AGI's.
 *
 * ADR 0019's warning applies here directly: a save that restores a world which
 * *looks* right but whose items are not the ones the scripts hold numbers for
 * is the worst shape of bug, because nothing errors. The defence is that item
 * identity is a **number**, not a reference — an AGOS item is its index in the
 * tree, and the file's numbering never moves. So the save records what changed
 * about each numbered slot and nothing has to be re-identified on load.
 *
 * That is why only the parent link and the state are saved per item, and why
 * they are saved by number rather than in tree order: tree order is derived,
 * and a save that stored it would be storing the same fact twice with two
 * chances to disagree.
 */

import type { SavedGameEnvelope } from '../../AdventureEngine.js';
import { describeTarget, parseTarget, sameTarget, type Target } from '../../../authoring/target.js';
import type { AgosState } from '../script/AgosInterpreter.js';
import { itemIdOf, linkTo } from '../world/itemTree.js';

/**
 * Bumped when the shape changes incompatibly. Refused rather than guessed at.
 *
 * Numbered independently of the other families' formats, because the payloads
 * version separately and one module importing another's constant is how two
 * unrelated numbers end up compared.
 */
export const AGOS_SAVE_FORMAT = 2;

/** One item's mutable half. Everything else about an item comes back from GAMEPC. */
export interface SavedItem {
  id: number;
  parent: number;
  state: number;
}

/**
 * A pending timer, **rebased to the moment of the save**.
 *
 * `due` here is seconds-from-save, not the absolute clock value the running
 * game holds — the reference does the same (`te->time - curTime` out,
 * `addTimeEvent(timeout, ...)` back in, `saveload.cpp`), because the clock on
 * the engine that loads a save is not the one that took it. A negative `due` is
 * a timer already overdue at save, which loads as due immediately.
 */
export interface SavedTimeEvent {
  due: number;
  subroutine: number;
}

export interface AgosSavedGame extends SavedGameEnvelope {
  target: Target;
  variables: number[];
  items: SavedItem[];
  /** The scheduled Subroutines, so a room's own timers resume rather than the
   *  boot heartbeat that the loading engine happens to be running. */
  timeEvents: SavedTimeEvent[];
  me: number;
  item1: number;
}

/**
 * Captures a running game.
 *
 * Every item is written rather than only the moved ones. A delta against the
 * shipped tree would be smaller and would make a save depend on the exact
 * release it was taken from — which is the same class of mistake as leaving the
 * release kind off a Target, and it fails the same way: quietly, later.
 */
export function saveAgosState(
  state: AgosState,
  target: Target,
  gameId: string,
  name: string,
): AgosSavedGame {
  const items: SavedItem[] = [];
  for (const [id, item] of state.items.entries()) {
    if (!item) continue;
    items.push({ id, parent: itemIdOf(item.parent), state: item.state });
  }

  return {
    format: AGOS_SAVE_FORMAT,
    gameId,
    savedAt: Date.now(),
    name,
    // AGOS has no room number: where the player is *is* an item, and the shell
    // only wants something to show, so the player's parent is the honest answer.
    room: state.parentOf(state.me),
    target,
    variables: [...state.variables],
    items,
    // Rebased to save time (see {@link SavedTimeEvent}). `state.clock` is where
    // the running game's absolute due values are measured from.
    timeEvents: state.timeEvents.map((event) => ({
      due: event.due - state.clock,
      subroutine: event.subroutine,
    })),
    me: state.me,
    item1: state.item1,
  };
}

/**
 * Restores a game, or refuses.
 *
 * Refusing leaves the game playable, which is the rule the other families
 * follow. The Target check is not a formality here: a Simon 1 talkie save
 * loaded into the floppy release would restore variables into a game whose
 * scripts were decoded differently, and the two disagree about exactly two
 * opcodes — which is enough for the restored game to be subtly and
 * untraceably wrong (ADR 0027's amendment).
 */
export function loadAgosState(state: AgosState, saved: AgosSavedGame, target: Target): void {
  if (saved.format !== AGOS_SAVE_FORMAT) {
    throw new Error(
      `This save is format ${saved.format} and this engine reads ${AGOS_SAVE_FORMAT}.`,
    );
  }

  const savedTarget = parseTarget(saved.target);
  if (!savedTarget) throw new Error('This save does not name a Target it was made for.');
  if (!sameTarget(savedTarget, target)) {
    throw new Error(
      `This save was made for ${describeTarget(savedTarget)} and this game is ${describeTarget(target)}.`,
    );
  }

  for (const [index, value] of saved.variables.entries()) state.write(index, value);
  for (const saved_ of saved.items) {
    const item = state.items[saved_.id];
    if (!item) continue;
    state.items[saved_.id] = { ...item, parent: linkTo(saved_.parent), state: saved_.state };
  }

  // **Replace the timers, do not merge them.** The engine that loads a save has
  // booted, so it already holds the boot heartbeat; leaving that in place beside
  // the restored timers is how a loaded game keeps running the opening. Rebased
  // from save time back onto this engine's clock (see {@link SavedTimeEvent}).
  state.timeEvents.length = 0;
  for (const event of saved.timeEvents) {
    state.timeEvents.push({ due: state.clock + event.due, subroutine: event.subroutine });
  }

  state.me = saved.me;
  state.item1 = saved.item1;
}
