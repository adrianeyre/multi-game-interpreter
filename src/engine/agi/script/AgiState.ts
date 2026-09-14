/**
 * All of an AGI game's state: 256 flags, 256 vars, strings, and the objects.
 *
 * That really is all of it. There are no local variables, no stack, no object
 * properties and no script slots — which is why none of SCUMM's slot model
 * (`ScriptScheduler`, `ScriptSlot`, `ScriptState`) is reusable here, and why the
 * stack machine `v6` and `v7` share is not either (ADR 0006, #129).
 *
 * The reserved entries are documented **where they are declared**, because a
 * reserved variable is only discoverable from the games that use it: nothing in
 * the bytecode says `v0` is the current room, and a script that reads it looks
 * exactly like a script reading a variable the author happened to pick.
 */

import { SCREEN_OBJECT_COUNT, createScreenObject, type ScreenObject } from '../ScreenObject.js';

/**
 * The variables AGI's interpreter writes and every game reads.
 *
 * Anything not listed is the game author's to use. The interpreter writes these
 * whether a game reads them or not, so getting one wrong is a game that behaves
 * oddly rather than one that fails: `V_EGO_DIRECTION` written to the wrong slot
 * leaves the player walking on the spot.
 */
export const V = {
  /** The room the game is in. `new.room` writes it. */
  CURRENT_ROOM: 0,
  /** The room it was in before, so a script can tell which door was used. */
  PREVIOUS_ROOM: 1,
  /** Which screen edge ego touched: 1 top, 2 right, 3 bottom, 4 left. */
  EGO_BORDER: 2,
  SCORE: 3,
  /** The object that touched an edge, and which edge, as a pair. */
  BORDER_OBJECT: 4,
  BORDER_CODE: 5,
  /**
   * Ego's direction, 0 to 8.
   *
   * Read *and* written, and which way round depends on `player.control`: under
   * player control the interpreter copies this into ego, and under program
   * control it copies ego's into this. Getting that backwards makes a cutscene
   * fight the script driving it.
   */
  EGO_DIRECTION: 6,
  MAX_SCORE: 7,
  FREE_PAGES: 8,
  /** The word number of a word the parser did not know. */
  WORD_NOT_FOUND: 9,
  /** Cycles to wait between ticks, in twentieths of a second. */
  TIME_DELAY: 10,
  SECONDS: 11,
  MINUTES: 12,
  HOURS: 13,
  DAYS: 14,
  JOYSTICK_SENSITIVITY: 15,
  /** The View ego is wearing, preserved across a room change. */
  EGO_VIEW: 16,
  /** The interpreter's own error code, which a few games display. */
  ERROR_CODE: 17,
  ERROR_INFO: 18,
  /** The key the player pressed this cycle, or 0. */
  KEY: 19,
  /** 0 for a PC, which is what every DOS release is. */
  COMPUTER_TYPE: 20,
  WINDOW_CLOSE_TIME: 21,
  /** 1 for the PC speaker, 3 for a Tandy — what a game checks before playing. */
  SOUND_GENERATOR: 22,
  SOUND_VOLUME: 23,
  MAX_INPUT_LENGTH: 24,
  SELECTED_ITEM: 25,
  MONITOR_TYPE: 26,
} as const;

/**
 * The flags AGI's interpreter sets, and every game tests.
 *
 * `NEW_ROOM` is the load-bearing one: it is true for exactly the first cycle
 * after `new.room`, which is how every room's Logic knows to draw its picture
 * and place its objects. A game whose `NEW_ROOM` never clears re-draws its room
 * every cycle; one whose never sets shows an empty screen.
 */
export const F = {
  EGO_ON_WATER: 0,
  /** Ego is behind something, worked out from the priority buffer. */
  EGO_HIDDEN: 1,
  /** The player typed a line this cycle. Cleared at the start of every cycle. */
  ENTERED_COMMAND: 2,
  /** Ego stepped on a priority-2 signal line. */
  EGO_TOUCHED_SIGNAL: 3,
  /** A `said` matched this cycle, so later `said`s stop trying. */
  SAID_ACCEPTED: 4,
  /** True for the first cycle in a new room, and only that cycle. */
  NEW_ROOM: 5,
  RESTART_GAME: 6,
  SCRIPT_BLOCKED: 7,
  JOYSTICK_USED: 8,
  SOUND_ON: 9,
  DEBUG: 10,
  /** True the first time logic 0 runs, and false ever after. */
  LOGIC_ZERO_FIRST_TIME: 11,
  RESTORE_GAME: 12,
  /** Whether the status line and item selection are allowed. */
  STATUS_LINE_ALLOWED: 13,
  MENU_ALLOWED: 14,
  /** Keep a text window up until `close.window` rather than on a keypress. */
  LEAVE_WINDOW_OPEN: 15,
} as const;

/** AGI gives a game twelve string slots of forty characters. */
export const STRING_COUNT = 24;
export const STRING_LENGTH = 40;

/** The default horizon: ego cannot walk above this row unless told it may. */
export const DEFAULT_HORIZON = 36;

/**
 * A rectangular region ego is confined to or kept out of, as `block` sets.
 *
 * One at a time, which is AGI's own limit rather than ours.
 */
export interface BlockRegion {
  active: boolean;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export class AgiState {
  /** 256 variables of one byte each. Arithmetic wraps, as AGI's does. */
  readonly vars = new Uint8Array(256);
  /** 256 flags. A byte each rather than packed bits: the space is irrelevant. */
  readonly flags = new Uint8Array(256);
  readonly strings: string[] = new Array(STRING_COUNT).fill('');
  readonly objects: ScreenObject[] = Array.from({ length: SCREEN_OBJECT_COUNT }, (_unused, index) =>
    createScreenObject(index),
  );

  /** Where the room's picture is drawn from, and whether it has been shown. */
  currentPicture = -1;
  pictureShown = false;

  /** Rows above this are out of bounds for anything not ignoring the horizon. */
  horizon = DEFAULT_HORIZON;

  /**
   * Whether the player drives ego, or the game's own scripts do.
   *
   * `player.control` and `program.control` are the whole of the difference
   * between the player walking and a cutscene walking them — there is no
   * separate cutscene stack the way SCUMM has one.
   */
  playerControl = true;

  block: BlockRegion = { active: false, x1: 0, y1: 0, x2: 0, y2: 0 };

  /** Whether text input is accepted, as `prevent.input`/`accept.input` set. */
  inputEnabled = true;
  /** The status line at the top of the screen. */
  statusLineVisible = false;
  /** Whether the graphics screen or the text screen is showing. */
  textMode = false;

  /** Controllers a script has bound to keys, by controller number. */
  readonly keyBindings = new Map<number, number>();
  /** Controllers triggered this cycle, which `controller()` tests. */
  readonly firedControllers = new Set<number>();
  /** Controllers a menu has disabled. */
  readonly disabledControllers = new Set<number>();

  /** The game id `set.game.id` declared, which is what a save is tagged with. */
  gameId = '';

  /** Set by `quit`. The shell reads it through `AdventureEngine.hasQuit`. */
  quitRequested = false;
  /** Set by `restart.game`, which the cycle acts on between logics. */
  restartRequested = false;

  /**
   * Set by `new.room`, and acted on after the current logic returns.
   *
   * A room change cannot happen inside a logic: the logic is running out of a
   * resource the change would unload. So `new.room` records the room and asks
   * every logic on the stack to return, which is what `exitAllLogics` is.
   */
  pendingRoom: number | null = null;
  exitAllLogics = false;

  flag(number: number): boolean {
    return this.flags[number & 0xff] !== 0;
  }

  setFlag(number: number, value: boolean): void {
    this.flags[number & 0xff] = value ? 1 : 0;
  }

  var(number: number): number {
    return this.vars[number & 0xff];
  }

  setVar(number: number, value: number): void {
    // One byte, wrapping. AGI games rely on this: a counter that overflows to
    // zero is how several of them time things.
    this.vars[number & 0xff] = value & 0xff;
  }

  object(number: number): ScreenObject {
    // Out of range is a script bug rather than an engine one, and AGI itself
    // wrote past the table. Clamping keeps a bad script from corrupting the
    // whole table, and the caller logs it.
    return this.objects[Math.max(0, Math.min(SCREEN_OBJECT_COUNT - 1, number))];
  }

  /**
   * Puts the interpreter's own answers in the variables a game reads at boot.
   *
   * Every one of these is something a real game tests before doing anything —
   * a game that finds `SOUND_GENERATOR` at 0 concludes there is no sound card
   * and takes a different path through its own opening.
   */
  reset(): void {
    this.vars.fill(0);
    this.flags.fill(0);
    this.strings.fill('');

    this.setVar(V.MAX_INPUT_LENGTH, STRING_LENGTH - 1);
    // Two twentieths of a second, which is the delay AGI itself starts at.
    this.setVar(V.TIME_DELAY, 2);
    this.setVar(V.FREE_PAGES, 180);
    // A PC with a PC speaker and an EGA monitor: the configuration every DOS
    // release was written for.
    this.setVar(V.COMPUTER_TYPE, 0);
    this.setVar(V.SOUND_GENERATOR, 1);
    this.setVar(V.MONITOR_TYPE, 3);
    this.setVar(V.SOUND_VOLUME, 15);
    this.setVar(V.JOYSTICK_SENSITIVITY, 0);

    this.setFlag(F.SOUND_ON, true);
    this.setFlag(F.LOGIC_ZERO_FIRST_TIME, true);
    // The game starts as though it had just entered a room, which is how a
    // game's one-off setup runs at all: the first-cycle code tests flag 5 the
    // same way a room's entry code does, rather than having a hook of its own.
    //
    // Enclosure binds every one of its keys inside `if (isset(f5))` in logic
    // 91, called from logic 0's first cycle. Without this that block never
    // runs, no key is ever bound, and the game silently ignores its own
    // controls — including the one that skips its opening cutscene.
    this.setFlag(F.NEW_ROOM, true);
    this.setFlag(F.STATUS_LINE_ALLOWED, true);
    this.setFlag(F.MENU_ALLOWED, true);

    this.horizon = DEFAULT_HORIZON;
    this.playerControl = true;
    this.inputEnabled = true;
    this.textMode = false;
    this.statusLineVisible = false;
    this.block = { active: false, x1: 0, y1: 0, x2: 0, y2: 0 };
    this.currentPicture = -1;
    this.pictureShown = false;
    this.quitRequested = false;
    this.restartRequested = false;
    this.pendingRoom = null;
    this.exitAllLogics = false;
    this.keyBindings.clear();
    this.firedControllers.clear();
    this.disabledControllers.clear();

    for (const [index, object] of this.objects.entries()) {
      this.objects[index] = createScreenObject(object.number);
    }
  }
}
