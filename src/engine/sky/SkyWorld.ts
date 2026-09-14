/**
 * Beneath a Steel Sky's world: the Compacts as the game mutates them, the
 * script variables, and the calls a script makes out of the interpreter.
 *
 * ## What "implemented" means here, and what it deliberately does not
 *
 * 115 mcodes exist. This implements the ones that can be written **and
 * checked** without a renderer, a router or a sound engine — assignments,
 * fetches, flags, and the script-and-mode machinery a script uses to call
 * another script. Everything else throws `SkyMcodeUnimplemented`, which stops
 * the script with the mcode's name and the word offset that called it.
 *
 * **Stopping is the design.** `CONTEXT.md`'s rule is that an unimplemented
 * thing is reported and never skipped, and it bites hardest here: an mcode
 * passed over leaves the world in a state its script did not ask for, and the
 * consequence surfaces later, somewhere else, looking like a different bug.
 * A stall that names an mcode at a word offset is a fact; a game that keeps
 * running past it is a fiction.
 *
 * The measurement that says which of these matter is in `bin/vt-sweep.ts`, and
 * it is not what you would guess: the busiest calls in the shipped bytecode are
 * `fnSetToStand`, `fnTurnTo`, `fnAr`, `fnRunFrames` and `fnArAnimate` —
 * character movement and routing — rather than drawing. Those five now land,
 * which is what a floor-click needed: `fnAr` sets a target and hands the mega
 * to the routing logics, and `fnInteract` runs the clicked thing's action
 * script **on the mega**. The route it builds is a straight line and says so —
 * see `routeDirection` for what is refused and why.
 */

import {
  skyCompactFieldAt,
  SKY_COMPACT_FIELDS,
  type SkyCompacts,
  type SkyCompactRecord,
} from './resource/skyCompacts.js';
import { SkyMcodeUnimplemented, type SkyScriptWorld } from './script/SkyInterpreter.js';
import { SKY_MCODE } from './script/skyMcodes.js';
import type { SkyWorldState } from './save/skyWorldState.js';
import type { SkyGrids } from './resource/SkyGrid.js';

/** Script variables this engine reads by name rather than by number. */
export const SKY_VAR = {
  result: 0,
  screen: 1,
  logicListNumber: 2,
  mouseListNumber: 6,
  drawListNumber: 8,
  currentId: 12,
  /**
   * The mouse's state: which buttons are down and whether the pointer is live.
   * Written by the input loop and by `fnNoHuman`/`fnAddButtons`/`fnNoButtons`,
   * and read every tick by the pointer and menu Compacts. Nothing on this side
   * writes it yet, which is what the booted game sits polling (#268).
   */
  mouseStatus: 13,
  mouseStop: 14,
  button: 15,
  /** The Compact the pointer is over, 0 for none. `pointerEngine` writes it. */
  specialItem: 17,
  /** The script to run when the pointer leaves what it is over. */
  getOff: 18,
  cursorId: 22,
  safeX: 25,
  safeY: 26,
  playerScreen: 30,
  /**
   * The resource holding the current room's background.
   *
   * A room-entry script sets this and then calls `fnDrawScreen`, so it is the
   * background rather than anything `fnDrawScreen` is passed — which is what
   * `Screen::recreate` reads to build the picture. Screen 0's entry script does
   * `push_number 64; pop_variable 164`, and 164/4 is this index.
   */
  layer0Id: 41,
  layer1Id: 42,
  menu: 102,
  currentSection: 143,
} as const;

/**
 * The bits of a Compact's `status` field this engine reads.
 *
 * Transcribed from ScummVM's `skydefs.h`, which defines them as plain values
 * rather than shifts: `ST_BACKGROUND` 1, `ST_FOREGROUND` 2, `ST_SORT` 4,
 * `ST_RECREATE` 8, `ST_MOUSE` 16, `ST_COLLISION` 32, `ST_LOGIC` 64,
 * `ST_GRID_PLOT` 128, `ST_AR_PRIORITY` 256, `ST_NO_VMASK` 0x200.
 *
 * Only the two this engine acts on are named here. The rest belong to a
 * renderer and a collision layer that do not exist yet, and naming a bit
 * nothing reads would suggest something reads it.
 *
 * `logic` is the one with teeth, and it was found in the shipped data before it
 * was looked up: every Compact in the CD release's opening logic list with a
 * non-zero `logic` field carries it, and the two that do not — `loader` and
 * `top_barrel` — have a `status` of exactly zero. That is the correlation the
 * gate predicts, which is why this is a transcription that was checked rather
 * than a constant that was copied.
 */
/**
 * The section with its own mouse cursors, which is the only thing entering or
 * leaving a section does beyond loading its media.
 */
const SKY_LINC_SECTION = 5;

/**
 * The bits of `MOUSE_STATUS`, which is the variable a booted game polls.
 *
 * `fnAddHuman` sets both — "cursor & mouse" in the game's own comment — and
 * that is what tells the scripts a person is there. Nothing on this side wrote
 * this variable at all until there was a mouse engine to write it, which is why
 * the game sat reading it.
 */
export const SKY_MOUSE_STATUS = {
  /** The pointer is live and the pointer engine should run. */
  mouse: 2,
  /** Buttons are enabled, so a click is worth testing. */
  buttons: 4,
} as const;

/**
 * Where the game's screen sits inside its own coordinate space.
 *
 * The mouse engine is handed `pointer + TOP_LEFT`, and a Compact's `xcood` and
 * `ycood` are in the same space, so a hit test that forgets this is off by a
 * screen's worth in both directions.
 */
export const SKY_TOP_LEFT_X = 128;
export const SKY_TOP_LEFT_Y = 136;

/**
 * The cursor shapes a pointer-mode mcode selects, by this project's own label.
 *
 * `fnNormalMouse` and its six neighbours each set one of these — the arrow, the
 * blank pointer, the disk-menu pointer, the examine cross, and the two hand
 * shapes a script swaps in to say a click will pick something up or put it down.
 * The label is a name for the request, not a transcription of ScummVM's cursor
 * sprite numbers: nothing here draws a cursor (#256), so the shape is recorded
 * for a report and the renderer is noted missing rather than guessed at.
 */
export type SkyCursor = 'normal' | 'blank' | 'disk' | 'cross' | 'open-hand' | 'close-hand';

export const SKY_STATUS = {
  /** Drawn in the flat layer behind the sortable sprites. */
  background: 1,
  /** Drawn in the flat layer in front of them. */
  foreground: 2,
  /**
   * Drawn between the two, ordered by the foot of the sprite.
   *
   * The bit that carries the *people*. Foster has this and neither flat layer,
   * so a compositor that draws only background and foreground produces a room
   * with its scenery and nobody in it.
   */
  sort: 4,
  /** The Compact wishes to have its logic run. Cleared by `fnKillId`. */
  logic: 64,
  /** The Compact is plotted into the walk grid (which ships; nothing routes on it yet). */
  gridPlot: 128,
  /** The Compact is worth testing the pointer against. */
  mouse: 16,
} as const;

/**
 * The names of the script variables this project has identified, by index.
 *
 * Transcribed from ScummVM's `scriptVariableOffsets`, and used only to make a
 * stall report legible: "waiting on variable 13" costs a reader a search that
 * "waiting on MOUSE_STATUS" does not. A name here is not a claim the engine
 * does anything with the variable — most of these it only reads.
 */
export const SKY_VAR_NAMES: Readonly<Record<number, string>> = Object.freeze({
  [SKY_VAR.result]: 'RESULT',
  [SKY_VAR.screen]: 'SCREEN',
  [SKY_VAR.logicListNumber]: 'LOGIC_LIST_NO',
  [SKY_VAR.mouseListNumber]: 'MOUSE_LIST_NO',
  [SKY_VAR.drawListNumber]: 'DRAW_LIST_NO',
  [SKY_VAR.currentId]: 'CUR_ID',
  [SKY_VAR.mouseStatus]: 'MOUSE_STATUS',
  [SKY_VAR.mouseStop]: 'MOUSE_STOP',
  [SKY_VAR.button]: 'BUTTON',
  [SKY_VAR.specialItem]: 'SPECIAL_ITEM',
  [SKY_VAR.getOff]: 'GET_OFF',
  [SKY_VAR.cursorId]: 'CURSOR_ID',
  [SKY_VAR.safeX]: 'SAFEX',
  [SKY_VAR.safeY]: 'SAFEY',
  [SKY_VAR.playerScreen]: 'PLAYER_SCREEN',
  [SKY_VAR.layer0Id]: 'LAYER_0_ID',
  [SKY_VAR.layer1Id]: 'LAYER_1_ID',
  [SKY_VAR.menu]: 'MENU',
  [SKY_VAR.currentSection]: 'CUR_SECTION',
});

/** A script variable's name where this project knows it, or `variable N`. */
export function skyVariableName(index: number): string {
  return SKY_VAR_NAMES[index] ?? `variable ${index}`;
}

/**
 * Field name to word index, built once.
 *
 * A Compact's fields are its words in order, so this is a lookup rather than a
 * search — which matters because the engine reads `logic` and `mode` for every
 * Compact in the logic list on every tick, and a scan per read is a scan per
 * object per frame.
 */
const FIELD_INDEX: ReadonlyMap<string, number> = new Map(
  SKY_COMPACT_FIELDS.map((name, index) => [name, index]),
);

/** Five directions, and a turn table is five rows of five. */
const TURN_DIRECTIONS = 5;

/** An animation set is fourteen words, its turn table the last of them. */
const MEGA_SET_WORDS = 14;
const MEGA_SET_TURN_TABLE = 13;

/**
 * Where the standing animations begin within a set.
 *
 * Four walking animations, then four standing ones, one per direction. The
 * game reaches them as `C_STAND_UP + megaSet + dir * 4` — a byte offset, four
 * bytes a slot, because these were 32-bit fields.
 */
const MEGA_SET_STAND_UP = 8;

/**
 * Where the walking animations begin within a set.
 *
 * The four before the standing ones, in the same direction order. Read off the
 * shipped Compacts rather than assumed: Foster's second animation set names
 * programs 256–259 here and 260–264 at {@link MEGA_SET_STAND_UP}, and the four
 * programs at 256 carry, per entry, a signed pair of `(0,-2)`, `(0,+2)`,
 * `(-4,0)` and `(+4,0)`. That fixes the direction numbering — up, down, left,
 * right — from the game's own data, and the standing programs agree with it
 * independently: their frames are 44, 40, 42 and 46, which is the same order
 * against the walk frames 0–9, 10–19, 20–29 and 30–39.
 */
const MEGA_SET_WALK = 4;

/** Up, down, left and right, in the order an animation set lists them. */
const DIR_UP = 0;
const DIR_DOWN = 1;
const DIR_LEFT = 2;
const DIR_RIGHT = 3;

/**
 * A walking animation's entry: a distance, a frame, and a signed step.
 *
 * Four words, against the three an animation with coordinates uses — which is
 * why following a route is a logic of its own rather than {@link
 * stepAnimation}. Measured over the shipped Compacts: of the 159 programs a
 * mega's animation set names as a walk, every one is `4n + 1` words ending in a
 * zero terminator, and every entry's first word is the magnitude of the signed
 * pair that follows.
 */
const WALK_ENTRY_WORDS = 4;

/**
 * What a route snaps its ends to, in pixels.
 *
 * The walk grid's cell, which {@link SkyGrids} reads as eight pixels square. A
 * mega covers four pixels of a horizontal step and two of a vertical one, so
 * starting and ending on a cell corner is what makes a leg's distance an exact
 * whole number of steps — without it a route overshoots its target by up to
 * three pixels and never reports having arrived.
 */
const ROUTE_CELL = 8;

/** A step, shortened to whatever distance is left when it would overshoot. */
function clampStep(step: number, remaining: number): number {
  if (step === 0) return 0;
  if (step > 0) return Math.min(step, Math.max(remaining, 0));
  return Math.max(step, Math.min(remaining, 0));
}

/**
 * What `megaSet` steps by, in the original structure's bytes.
 *
 * 144, which is 258 minus the byte offset of the first animation set. The
 * field holds an offset rather than an index, which is why this is a division
 * rather than a lookup.
 */
const MEGA_SET_STRIDE_BYTES = 144;

/** Which of a Compact's four script slots `mode` selects. */
const SUB_FIELDS: readonly string[] = [
  'baseSub',
  'baseSub_off',
  'actionSub',
  'actionSub_off',
  'getToSub',
  'getToSub_off',
  'extraSub',
  'extraSub_off',
];

/** The logic a Compact is running, by the number in its `logic` field. */
export const SKY_LOGIC_NAMES: readonly string[] = [
  'nothing',
  'script',
  'make a route',
  'follow a route',
  'turn around',
  'set up a new get-to script',
  'follow a sequence',
  'turn',
  'track the pointer',
  'talk',
  'listen',
  'wait for something to stop moving',
  'wait for the player to click',
  'animate frames',
  'count down',
  'wait for a sync',
  'animate without coordinates',
];

/**
 * The logics this engine names in code rather than only in a report.
 *
 * Indices into {@link SKY_LOGIC_NAMES}, so the two cannot drift: a Compact put
 * on `makeRoute` here is the Compact a stall would describe as "make a route".
 */
export const SKY_LOGIC = Object.freeze({
  script: 1,
  makeRoute: 2,
  followRoute: 3,
  turnAround: 4,
});

/** Anything the world could not do, counted so a report can show it. */
export interface SkyWorldNote {
  readonly what: string;
  readonly count: number;
}

/**
 * The world a script runs against.
 *
 * Holds every Compact's words as its own mutable copy, taken from the table and
 * then overwritten for the saveable ones by the starting state — which is how
 * the game itself starts a new game (`skyWorldState.ts`).
 */
export class SkyWorld implements SkyScriptWorld {
  readonly variables = new Uint32Array(838);
  /** Every record's words, mutable. Keyed by Compact id. */
  readonly compacts = new Map<number, Uint16Array>();
  /** The Compact whose script is running, which `push_offset` reads. */
  current = 0;
  /**
   * The live pointer, in the game's own screen space (origin included).
   *
   * `runMouse` writes it every tick and `fnSaveCoods` freezes it into `SAFEX`
   * and `SAFEY`. Held on the world rather than in a script variable because it
   * is the mouse engine's own reading of where the pointer is, and the get-to
   * chain reads the frozen copy, not this one.
   */
  pointerX = 0;
  pointerY = 0;
  /**
   * The cursor a pointer-mode mcode last asked for, by this project's own label.
   *
   * The pointer-mode mcodes (`fnNormalMouse` and its neighbours) do one thing:
   * change the on-screen pointer sprite. Nothing draws one here (#256), so the
   * request is recorded for the report and the cursor renderer is noted missing
   * — the label is this project's, not a transcription of ScummVM's sprite ids.
   */
  cursor: SkyCursor = 'normal';
  /**
   * The text number the last `fnPointerText` asked for, or null.
   *
   * The engine's own bookkeeping and not a script variable: which variable the
   * game keeps this in is not established, and there is nothing to gain from
   * guessing one. It is here so a report can say which label was wanted.
   */
  pointerTextNumber: number | null = null;
  /**
   * Who the last speech mcode asked to speak, and which text line, or null.
   *
   * Kept for the same reason {@link pointerTextNumber} is, and refused for the
   * same one: a line's words are compressed and the tree that decodes them is
   * not in the bytes Revolution shipped, so no reader here can produce them.
   * What *is* readable is who was asked to say what, and that is what this
   * holds — a report can name the line rather than claim it was said.
   */
  spokenLine: { by: number; text: number } | null = null;
  /** Set by `fnQuitToDos`, which is how a Sky game asks to stop. */
  quit = false;
  /** Set by `fnSkipIntroCode`, which is how the game says the intro is over. */
  pastIntro = false;
  /** Sound effects an animation asked for, which nothing plays yet (#257). */
  effects = 0;
  /**
   * The section `enterSection` last entered, or null before any.
   *
   * Held apart from the `CUR_SECTION` variable because a script may write that
   * variable directly, and the question this answers is "which section did this
   * engine load for", which is what decides whether a reload is owed.
   */
  enteredSection: number | null = null;
  /** How many distinct sections have been entered, for the status line. */
  sectionsEntered = 0;

  /** Which resources scripts have asked to have in memory, by number. */
  readonly cached = new Set<number>();
  /** The screen a script last asked to be drawn, or null. */
  drawnScreen: number | null = null;
  /** The palette a script last asked for, or null. */
  chosenPalette: number | null = null;

  /** mcodes reached and not implemented, by name, with how often. */
  readonly unimplemented = new Map<string, number>();
  /** Logic kinds reached and not implemented, by name, with how often. */
  readonly unimplementedLogic = new Map<string, number>();

  private readonly records = new Map<number, SkyCompactRecord>();

  constructor(
    readonly table: SkyCompacts,
    /**
     * The walk grids, or null for a world built without resources (the unit
     * tests). Present in a real game: the grids ship in the resource file, and
     * the section-entry report reads {@link SkyGrids.verify} off this rather
     * than claiming, as it once did, that no grid exists.
     */
    readonly grids: SkyGrids | null = null,
  ) {
    for (const record of table.records) {
      this.records.set(record.id, record);
      this.compacts.set(record.id, new Uint16Array(record.words));
    }
    // An alias is a second name for a record rather than a record, so it shares
    // the words rather than copying them: a script writing through either name
    // has to be seen through the other.
    for (const alias of table.aliases) {
      const target = this.compacts.get(alias.targetId);
      if (target) this.compacts.set(alias.id, target);
    }
  }

  /** Starts a new game, or restores one. Both are the same operation. */
  apply(state: SkyWorldState): void {
    this.variables.set(state.variables.subarray(0, this.variables.length));
    this.table.saveIds.forEach((id, position) => {
      const words = state.compactWords[position];
      const target = this.compacts.get(id);
      if (words && target && target.length === words.length) target.set(words);
    });
  }

  /**
   * Whether a Compact wishes to have its logic run this tick.
   *
   * ScummVM's `Logic::engine` asks this before anything else — "check the id
   * actually wishes to be processed" — and skips the Compact entirely when the
   * answer is no. Leaving it out is not a missing optimisation: `fnKillId`
   * works by clearing `status`, so an engine that never reads `status` has no
   * way for a Compact to stop existing. The CD release's opening list has
   * around thirty-seven Compacts that kill themselves on their first tick, and
   * without this they were run again, and killed themselves again, every tick
   * forever.
   */
  wantsLogic(id: number): boolean {
    return (this.field(id, 'status') & SKY_STATUS.logic) !== 0;
  }

  /**
   * Enters a section, which is what the game does after a state is applied.
   *
   * ScummVM's `Logic::parseSaveData` — the routine that both starts a new game
   * and restores a save — brackets its variable copy with `fnLeaveSection` for
   * the old section and **`fnEnterSection` for the one the state names**. So
   * this is not something a script asks for at boot; it is part of applying a
   * state, and an engine that only copies the variables has entered no section
   * at all.
   *
   * What entering one *does* in the game is set `CUR_SECTION`, reset the
   * current music, and — when the section actually changed — load that
   * section's music, its sound effects and its walk grids. The music and sound
   * effects are stubbed here; the walk grids, contrary to what this said
   * before, do ship, and are read and checked once at boot (see {@link grids}).
   *
   * **That is deliberately not a `noteMissing`.** Those count subsystems a
   * *script* asked for and did not get, and `describeStatus` leads with the
   * busiest of them as the thing the game stopped on. Entering a section is not
   * a script's request and not a stop — the section is entered either way — so
   * putting it there made the report say the game had halted on missing music,
   * which it had not. It is counted here and reported as its own line.
   */
  enterSection(section: number): void {
    this.variables[SKY_VAR.currentSection] = section;
    if (section === this.enteredSection) return;
    this.enteredSection = section;
    this.sectionsEntered += 1;
  }

  /**
   * A signed Compact field. `mouseRelX` and `mouseRelY` are offsets and negative.
   */
  private signedField(id: number, name: string): number {
    const value = this.field(id, name);
    return value >= 0x8000 ? value - 0x10000 : value;
  }

  /**
   * Finds the Compact the pointer is over, walking the mouse list.
   *
   * The same walk the logic list gets — ids ending in zero, `0xffff` handing
   * off to another list — over `MOUSE_LIST_NO`, testing each Compact that is on
   * the current screen and asks to be tested. The box is `xcood + mouseRelX`
   * for `mouseSizeX`, and the two offsets are signed.
   *
   * Returns the Compact's id, or 0 when the pointer is over nothing.
   */
  pointerOver(x: number, y: number): number {
    let listId = this.variables[SKY_VAR.mouseListNumber];
    let list = this.words(listId);
    let at = 0;
    let guard = 0;

    while (list && guard < 4096) {
      guard += 1;
      const id = list[at];
      at += 1;
      if (id === 0) break;
      if (id === 0xffff) {
        listId = list[at];
        list = this.words(listId);
        at = 0;
        continue;
      }

      if (this.field(id, 'screen') !== this.variables[SKY_VAR.screen]) continue;
      if ((this.field(id, 'status') & SKY_STATUS.mouse) === 0) continue;

      const left = this.field(id, 'xcood') + this.signedField(id, 'mouseRelX');
      const top = this.field(id, 'ycood') + this.signedField(id, 'mouseRelY');
      if (x < left || x > left + this.field(id, 'mouseSizeX')) continue;
      if (y < top || y > top + this.field(id, 'mouseSizeY')) continue;
      return id;
    }
    return 0;
  }

  /** The current state, for a save. Shares nothing with the live world. */
  capture(state: SkyWorldState): SkyWorldState {
    return {
      ...state,
      variables: new Uint32Array(this.variables),
      compactWords: this.table.saveIds.map((id) => {
        const words = this.compacts.get(id);
        return words ? new Uint16Array(words) : new Uint16Array(0);
      }),
      compacts: new Map(),
    };
  }

  name(id: number): string {
    return this.records.get(id)?.name ?? `compact ${id.toString(16)}`;
  }

  /**
   * The Compact the shipped name pool calls `name`, or null.
   *
   * The names come out of `sky.cpt`'s own name pool — the one this file's
   * reader consumes exactly — so this is a lookup in game-authored data rather
   * than a table living only here, which is the distinction ADR 0033 draws.
   * That matters for the one caller that needs it: finding the player's Compact
   * without hard-coding an id.
   */
  idNamed(name: string): number | null {
    for (const record of this.records.values()) {
      if (record.name === name) return record.id;
    }
    return null;
  }

  words(id: number): Uint16Array | undefined {
    return this.compacts.get(id);
  }

  /**
   * A field of a Compact by name, which is how this engine reads the world.
   *
   * Zero for a field the record is too short to hold, rather than a throw:
   * 200-odd shipped records stop before the field list does, and asking a
   * scenery object for its `mode` is a reasonable question with the answer
   * "it has none".
   */
  field(id: number, name: string): number {
    const words = this.compacts.get(id);
    const index = FIELD_INDEX.get(name);
    if (!words || index === undefined || index >= words.length) return 0;
    return words[index];
  }

  setField(id: number, name: string, value: number): void {
    const words = this.compacts.get(id);
    const index = FIELD_INDEX.get(name);
    if (!words || index === undefined || index >= words.length) return;
    words[index] = value & 0xffff;
  }

  // --- what the interpreter reaches ---------------------------------------

  readVariable(index: number): number {
    return this.variables[index] ?? 0;
  }

  writeVariable(index: number, value: number): void {
    if (index < this.variables.length) this.variables[index] = value >>> 0;
  }

  readCompact(offset: number): number {
    const field = skyCompactFieldAt(offset);
    const words = this.compacts.get(this.current);
    if (!field || !words) return 0;
    return words[field.index] ?? 0;
  }

  writeCompact(offset: number, value: number): void {
    const field = skyCompactFieldAt(offset);
    const words = this.compacts.get(this.current);
    if (!field || !words) return;
    if (field.index < words.length) words[field.index] = value & 0xffff;
  }

  /**
   * The calls out of the interpreter.
   *
   * Returns false to pause the script, which is a normal thing for a Sky mcode
   * to do rather than a failure. Throws for anything not implemented, which the
   * interpreter turns into a stop naming the mcode and the offset.
   */
  callMcode(mcode: number, a: number, b: number, c: number): boolean {
    switch (mcode) {
      // Loading. A no-op with a record kept: nothing here streams resources in
      // and out of memory, and what a script asked for is worth reporting.
      case SKY_MCODE.fnCacheChip:
      case SKY_MCODE.fnCacheFast:
      case SKY_MCODE.fnFlushBuffers:
      case SKY_MCODE.fnFlushChip:
        this.recordCacheList(a);
        return true;

      case SKY_MCODE.fnDrawScreen:
        // **One argument, and it is the palette.** This read used to take `a`
        // as a screen and `b` as a palette, which is wrong twice over: the
        // game's own room-entry scripts call this with `argc=1`, so `b` was
        // always zero, and the background is not passed here at all — it is
        // `LAYER_0_ID`, which the script sets a few instructions earlier.
        // Screen 0's entry reads `push_number 4316; call_mcode fnDrawScreen`,
        // and 4316 is the Compact holding that room's palette.
        this.chosenPalette = a;
        this.drawnScreen = this.variables[SKY_VAR.layer0Id];
        return true;

      case SKY_MCODE.fnSetPalette:
        this.chosenPalette = a;
        return true;

      case SKY_MCODE.fnPointerText:
        // The name that appears under the pointer when it is over something —
        // "door", "bar" — from a text number the script pushes. Twenty call
        // sites across the shipped modules, every one of them one argument.
        //
        // **Recorded rather than stopped on, and the distinction is the whole
        // point of `noteMissing`.** This is not an mcode nobody has written: it
        // is an mcode whose one job reaches a subsystem that does not exist
        // here, because Sky's text is compressed and the tree that decodes it
        // has not been found (see `SkyGrid.ts` for the parallel refusal, and the
        // editor's text surface for the state of that search). Stopping the
        // script would be wrong — the object's mouse script goes on to do things
        // that have nothing to do with a label, and a stop here hides all of
        // them behind a caption. So the gap is counted, by name, and the script
        // carries on the way `fnKillId` carries on past the walk grid.
        //
        // What this costs is honest and bounded: hovering a thing does not name
        // it. What it buys is that the four hotspots whose mouse scripts stopped
        // here now run to their ends.
        // Kept on the world rather than in a script variable: which variable
        // the game uses for this is not established, and writing a made-up slot
        // would be a claim about the layout in exchange for nothing. This is the
        // engine's own note of what was asked for, so a report can name it.
        this.pointerTextNumber = a & 0xffff;
        this.noteMissing('the pointer’s text, which needs Sky’s compressed text read');
        return true;

      case SKY_MCODE.fnSpeakMe:
      case SKY_MCODE.fnSpeakMeDir:
      case SKY_MCODE.fnSpeakWait:
      case SKY_MCODE.fnSpeakWaitDir: {
        // A character saying a line: who says it, which line, and which talking
        // animation. Three arguments at every one of the 1,304 call sites
        // across the shipped modules — `fnSpeakMe` 339, `fnSpeakMeDir` 650,
        // `fnSpeakWait` 280, `fnSpeakWaitDir` 35 — which makes speech the single
        // most-called thing Sky's scripts do.
        //
        // **Recorded rather than stopped on, for `fnPointerText`'s reason and
        // one more.** The words cannot be produced here: Sky's text is
        // compressed against a tree that is not among the bytes Revolution
        // shipped, so the only place to get one is a reimplementation's source,
        // which ADR 0033 refuses by name. That refusal is settled and this does
        // not reopen it.
        //
        // The extra reason is what stopping costs, measured on the freeware CD
        // release rather than reasoned about. An object's action script brackets
        // its line with `fnNoHuman` before and `fnAddHuman` after — the game
        // taking the pointer away while somebody talks and giving it back
        // afterwards. Stopping on the line means the `fnAddHuman` is never
        // reached, so a click on the fire notice, the door, the bar or the
        // stairs walked Foster over, took the player's control away and never
        // returned it. Every object in the game locked the game up, and the
        // report said "speech is missing". Carrying on costs a line nobody
        // hears; stopping cost the game.
        //
        // Dropping out rather than running straight on is the game's own shape
        // for this mcode: a line is started and the script resumes after it.
        //
        // **What that costs is a pacing divergence, and it is named rather than
        // hidden.** `CONTEXT.md` is firm that an interpreter which ignores
        // speech must still produce the same pause, and `SkySound` repeats it
        // for the `fnSpeakWait` family. This resumes on the next tick instead,
        // because the length of a line is a function of its characters and its
        // recording — one refused above, the other #257 — so there is nothing
        // here to measure a pause against. A line goes by in a tick; nobody is
        // left waiting on one, and nothing is claimed to have been said.
        this.spokenLine = { by: a & 0xffff, text: b & 0xffff };
        this.noteMissing('a spoken line, which needs Sky’s compressed text read');
        return false;
      }

      case SKY_MCODE.fnInteract: {
        // Do a thing to a thing: the last link in the chain a click runs, after
        // `fnSaveCoods` froze the pointer, `fnGetTo` walked the mega to the
        // place and the route arrived.
        //
        // **It runs the target's action script on the mega, not on the target**,
        // and that is the correction that made a floor-click walk. This used to
        // install the script on the target Compact and set it running, which is
        // wrong on two counts the shipped data settles between them:
        //
        //  - `floor`'s `status` is 16, with no logic bit, so it is not in the
        //    logic list and nothing ever runs it. A script installed there is a
        //    script that never executes — which is exactly what a floor-click
        //    did: the chain completed, the mcode returned, and nobody moved.
        //  - `floor`'s action script is 31, and script 31's first instruction
        //    reads `downFlag` and its sixth calls `fnAr(SAFEX, SAFEY)`. Both of
        //    those are the *mega's* fields: the flag a route clears, and the
        //    walk that carries the mega to the pointer. Run on the floor they
        //    read and write a hotspot's unused words.
        //
        // So this is `fnStartSub`'s shape — one mode up, the script installed,
        // drop out so it runs next — with the script taken from another
        // Compact's `actionScript`. Which is also why the caller's own script
        // carries on afterwards in the right order: script 1's `fnSetToStand`,
        // `fnIdle` and `fnQuit` sit after its `fnInteract`, and they are the
        // mega finishing what the action started.
        //
        // The argument is a Compact id, taken from this game's own bytecode:
        // all 51 call sites across the shipped modules are `call_mcode 1, 24`,
        // pushing either a literal id or a variable holding one.
        const target = a & 0xffff;
        const mode = this.field(this.current, 'mode') + 4;
        this.setField(this.current, 'mode', mode);
        this.setSub(this.current, mode, this.field(target, 'actionScript'));
        this.setSub(this.current, mode + 2, 0);
        return false;
      }

      case SKY_MCODE.fnStartSub: // call a script, and come back to this one after
        this.pushSub(a);
        return false;

      case SKY_MCODE.fnTheyStartSub: {
        // The same, on another Compact.
        const previous = this.current;
        this.current = a;
        this.pushSub(b);
        this.current = previous;
        return true;
      }

      case SKY_MCODE.fnAssignBase:
        // Replace the base script rather than stacking, and — the part this used
        // to leave out — **set the compact running.** ScummVM's own body sets
        // four fields: `mode = C_BASE_MODE` (0), `logic = L_SCRIPT` (1), and the
        // two halves of the sub. Without the `logic` write the compact keeps
        // whatever logic it had, which for the player between actions is 0
        // (nothing) — so a floor-click assigned the walk's base script and then
        // never ran it. The click completed and the player sat still: the walk
        // did not stall, it simply never started. `scr` is a full pointer, so
        // its high half is the offset, not a hardcoded 0.
        this.setField(a, 'mode', 0);
        this.setField(a, 'logic', 1);
        this.setField(a, 'baseSub', b & 0xffff);
        this.setField(a, 'baseSub_off', (b >>> 16) & 0xffff);
        return true;

      case SKY_MCODE.fnNoHuman:
        // **Not `MOUSE_STOP`.** These two used to write that variable, which is
        // `fnSetStop`/`fnClearStop`'s job, and so nothing ever wrote
        // `MOUSE_STATUS` — the variable a booted game sits reading. Taking the
        // human away clears every bit but the first; giving one back sets
        // "cursor & mouse".
        if (this.variables[SKY_VAR.mouseStop] === 0) {
          this.variables[SKY_VAR.mouseStatus] &= 1;
        }
        return true;

      case SKY_MCODE.fnAddHuman:
        if (this.variables[SKY_VAR.mouseStop] === 0) {
          this.variables[SKY_VAR.mouseStatus] |= SKY_MOUSE_STATUS.mouse | SKY_MOUSE_STATUS.buttons;
          // Forces the pointer engine to treat the next tick as a fresh touch
          // even when the pointer is over nothing.
          this.variables[SKY_VAR.specialItem] = 0xffffffff;
        }
        return true;

      case SKY_MCODE.fnAddButtons:
        this.variables[SKY_VAR.mouseStatus] |= SKY_MOUSE_STATUS.buttons;
        return true;

      case SKY_MCODE.fnNoButtons:
        this.variables[SKY_VAR.mouseStatus] &= ~SKY_MOUSE_STATUS.buttons;
        return true;

      case SKY_MCODE.fnSetStop:
        // The `MOUSE_STOP` variable, not the running Compact's `stopScript`
        // field. These two are the gate `fnAddHuman` and `fnNoHuman` check
        // before touching `MOUSE_STATUS`, so writing the wrong thing here left
        // that gate reading zero by luck rather than by agreement.
        this.variables[SKY_VAR.mouseStop] |= 1;
        return true;
      case SKY_MCODE.fnClearStop:
        this.variables[SKY_VAR.mouseStop] = 0;
        return true;

      // The pointer-mode family. Each of these sets the on-screen cursor to a
      // shape, and the shape is what a click will mean — the cross examines, an
      // open hand is about to pick up, a closed one is about to put down. On
      // this side the shape has no renderer, so the request is recorded and the
      // cursor is noted missing; the *dispatch* of a click does not read the
      // shape — it runs the touched Compact's `mouseClick` script regardless —
      // so recording it changes nothing a script can then observe going wrong.
      case SKY_MCODE.fnNormalMouse:
        this.setCursor('normal');
        return true;
      case SKY_MCODE.fnBlankMouse:
        this.setCursor('blank');
        return true;
      case SKY_MCODE.fnDiskMouse:
        this.setCursor('disk');
        return true;
      case SKY_MCODE.fnCrossMouse:
        this.setCursor('cross');
        return true;
      case SKY_MCODE.fnOpenHand:
        this.setCursor('open-hand');
        return true;
      case SKY_MCODE.fnCloseHand:
        this.setCursor('close-hand');
        return true;

      case SKY_MCODE.fnSaveCoods:
        // Freeze the live pointer into SAFEX/SAFEY. This is the first link in
        // the get-to chain: a `mouseClick` script calls it so that the walk it
        // is about to start heads for where the pointer *was* when clicked, not
        // wherever it drifts to while the route is built. `runMouse` keeps the
        // live reading on the world; this copies it into the two variables the
        // routing mcodes read. Nothing wrote these two before, which is why the
        // click's own script had nowhere to stop but here.
        this.variables[SKY_VAR.safeX] = this.pointerX;
        this.variables[SKY_VAR.safeY] = this.pointerY;
        return true;

      case SKY_MCODE.fnGetTo: {
        // Select the get-to script for a target place, and hand the script over
        // to it — the second link in the chain a floor-click runs, after
        // `fnSaveCoods`. **This moves nobody.** It does not read the grid, build
        // a route, or touch a coordinate; all it does is pick which script will
        // do the walking and install it as the next mode up, exactly the way
        // `fnStartSub` calls a subroutine. So it can be implemented, and checked,
        // before the router that reads it (`fnAr`) exists — and implementing it
        // is what moves the stall off `fnGetTo` and onto that router, which is
        // the honest next stop rather than a fabricated position.
        //
        // ScummVM's `Logic::fnGetTo`: save the arrival mode in `upFlag` for
        // `fnArrived` to read, remember the target in `getToFlag`, then look the
        // get-to script up in the table belonging to the mega's **current
        // place** — `place`'s `getToTableId` — which is why the same target
        // reached from two rooms runs two different scripts. The table is
        // (placeId, script) pairs; the game walks it until the placeId matches.
        const targetPlaceId = a & 0xffff;
        this.setField(this.current, 'upFlag', b & 0xffff);
        this.setField(this.current, 'getToFlag', targetPlaceId);

        const placeId = this.field(this.current, 'place');
        const tableId = this.field(placeId, 'getToTableId');
        const table = this.compacts.get(tableId);
        if (!table) {
          // No table for this place: the mega has nowhere the get-to chain can
          // read a script from. Counted rather than pretended, and the script
          // carries on the way ScummVM's own early return does.
          this.noteMissing('a get-to table for the mega’s place');
          return true;
        }

        // The game's search has no bound — it trusts the target to be present.
        // Bounded here so a table that does not carry the target is a counted
        // finding rather than a read off the end of the record.
        let pair = -1;
        for (let i = 0; i + 1 < table.length; i += 2) {
          if (table[i] === targetPlaceId) {
            pair = i;
            break;
          }
        }
        if (pair < 0) {
          this.noteMissing(`a get-to script for place ${targetPlaceId}`);
          return true;
        }

        // Install the get-to script one mode up and drop out so it runs next,
        // the same call-a-subroutine shape as `pushSub`. Its offset half is 0:
        // the script starts at its beginning.
        const mode = this.field(this.current, 'mode') + 4;
        this.setField(this.current, 'mode', mode);
        this.setSub(this.current, mode, table[pair + 1]);
        this.setSub(this.current, mode + 2, 0);
        return false;
      }

      case SKY_MCODE.fnKillId: {
        // — the object stops existing as far as the world is
        // concerned. The game also takes it out of the walk grid; the grid now
        // ships and is read, but nothing plots megas into it (no router reads
        // it), so removing a mega from it is recorded rather than pretended.
        if (a !== 0) {
          if ((this.field(a, 'status') & SKY_STATUS.gridPlot) !== 0)
            this.noteMissing('plotting a mega into the walk grid');
          this.setField(a, 'status', 0);
        }
        return true;
      }

      case SKY_MCODE.fnEnterSection:
        // A script changing section, which is the same operation `boot` does
        // through `enterSection` — one route, so a section entered by a script
        // and a section entered by applying a state cannot disagree.
        this.enterSection(a);
        return true;

      case SKY_MCODE.fnLeaveSection:
        // Nothing to undo. In the game this swaps the mouse cursors back when
        // leaving the LINC section and otherwise does nothing, and there are no
        // cursors here — so this is complete rather than a stub, and section 5
        // is recorded as the one case that would want more.
        if (a === SKY_LINC_SECTION) this.noteMissing('the LINC section’s own cursors');
        return true;

      case SKY_MCODE.fnForeground:
      case SKY_MCODE.fnBackground:
      case SKY_MCODE.fnSort: {
        // Which of the three drawing layers a Compact belongs to. The layers are
        // already named in {@link SKY_STATUS} — flat behind, flat in front, and
        // the sortable band between them that carries the people — and these
        // three mcodes are the one-per-layer way a script moves something
        // between them.
        //
        // **The argument is a Compact id, and the shipped call sites settle
        // both halves of that.** Across the seven script modules: `fnForeground`
        // is called 42 times and `fnSort` 61, every one of them with one
        // argument; most push `ID` — the running Compact saying "put me there" —
        // and the rest push a literal id, which is what makes it an id rather
        // than a flag. `fnBackground` is called 48 times in two shapes, 10 with
        // one argument (all of them `ID`) and 38 with none, so no argument means
        // the Compact whose script is running.
        //
        // The three bits are exclusive — a sprite is in one layer — so the
        // other two are cleared. That is a reading of what a layer is rather
        // than a transcription of anyone's mask, and it is the reading the
        // renderer already assumes: `paintSprites` walks the background list,
        // then the sorted band, then the foreground, and a Compact carrying two
        // bits would be painted twice.
        const id = a === 0 ? this.current : a & 0xffff;
        const layer =
          mcode === SKY_MCODE.fnForeground
            ? SKY_STATUS.foreground
            : mcode === SKY_MCODE.fnBackground
              ? SKY_STATUS.background
              : SKY_STATUS.sort;
        const status = this.field(id, 'status');
        const cleared = status & ~(SKY_STATUS.background | SKY_STATUS.foreground | SKY_STATUS.sort);
        this.setField(id, 'status', cleared | layer);
        return true;
      }

      case SKY_MCODE.fnToggleGrid:
        // A Compact going into or out of the walk grid, which is what its name
        // says and what the one grid bit {@link SKY_STATUS} carries is for. The
        // scripts use it either side of a mega passing through something it
        // would otherwise have to walk around — the low floor's get-to script
        // toggles it between `fnForeground` and the walk.
        //
        // Flipping the bit is the whole of what can be done here and the
        // shortfall is the one `fnKillId` already records: the grid ships and is
        // decoded, nothing routes on it, because the table saying which grid a
        // screen uses is refused under ADR 0033. So the Compact's own state
        // follows the script and the plotting is counted, rather than the script
        // stopping on a walk it is in the middle of.
        this.setField(
          this.current,
          'status',
          this.field(this.current, 'status') ^ SKY_STATUS.gridPlot,
        );
        this.noteMissing('plotting a mega into the walk grid');
        return true;

      case SKY_MCODE.fnStartFx:
      case SKY_MCODE.fnStopFx:
      case SKY_MCODE.fnPauseFx:
      case SKY_MCODE.fnUnPauseFx:
      case SKY_MCODE.fnStartMusic:
      case SKY_MCODE.fnStopMusic:
        // The audio a script asks for: 381 `fnStartFx` call sites, 67
        // `fnStopFx`, 60 `fnStartMusic`, 10 `fnStopMusic` and one each of the
        // pause pair, across the shipped modules.
        //
        // Counted rather than stopped on, and the ground for that is narrower
        // than it is for speech: an mcode passed over is dangerous when it
        // leaves world state the script will read back, and these leave none —
        // nothing in Sky's bytecode reads what is playing. The subsystem is
        // #257, and the animation programs already count their own effect
        // requests this same way rather than stopping the mega mid-walk.
        this.effects += 1;
        this.noteMissing('a sound the game asked to play');
        return true;

      case SKY_MCODE.fnQuit: // the script ends, the game does not
        return false;

      case SKY_MCODE.fnSendSync: // hand a sync to another Compact, and wait
      case SKY_MCODE.fnSendFastSync:
        this.setField(a, 'sync', b & 0xffff);
        return false;

      case SKY_MCODE.fnResetId: {
        // — a list of (field offset, value) pairs written into a
        // Compact, ending in 0xffff. Used when a character changes shape or
        // room, which is why it writes through the same addressing a script's
        // own `pop_offset` uses.
        const block = this.compacts.get(b);
        if (!block) return true;
        for (let i = 0; i + 1 < block.length; i += 2) {
          const offset = block[i];
          if (offset === 0xffff) break;
          const field = skyCompactFieldAt(offset);
          if (!field) {
            // An offset this project does not resolve — the animation-set and
            // turn-table region. Counted rather than written to the wrong word.
            this.noteMissing(`a reset writing to compact offset ${offset}`);
            continue;
          }
          const words = this.compacts.get(a);
          if (words && field.index < words.length) words[field.index] = block[i + 1];
        }
        return true;
      }

      case SKY_MCODE.fnAwaitSync: // go on if a sync arrived, otherwise wait
        if (this.field(this.current, 'sync') !== 0) return true;
        this.setField(this.current, 'logic', 15);
        return false;

      case SKY_MCODE.fnSkipIntroCode:
        this.pastIntro = true;
        return true;

      case SKY_MCODE.fnIdle: // the player stops doing anything
        this.setField(this.current, 'logic', 0);
        return true;

      case SKY_MCODE.fnAr: {
        // Walk a mega to a point: the third link in the chain a floor-click
        // runs, after `fnSaveCoods` froze the pointer and `fnGetTo` chose the
        // script that calls this. **This mcode moves nobody by itself** — it
        // records the target and hands the Compact to the routing logics, the
        // same shape `fnTurnTo` and `fnSimpleMod` use to hand it to a turn or
        // an animation.
        //
        // `downFlag` is set to 1 *before* the walk rather than after it. It is
        // the get-to script's "did that work" flag, and a script interrupted
        // mid-route — by speech, by another mega's sync — must read a failure
        // rather than a stale success, so the route clears it on arrival and
        // nothing else ever sets it.
        //
        // Both ends are snapped to {@link ROUTE_CELL}; see that constant for
        // why a route that does not start and end on a cell corner cannot
        // arrive exactly.
        this.setField(this.current, 'downFlag', 1);
        this.setField(this.current, 'arTargetX', a & 0xffff & ~(ROUTE_CELL - 1));
        this.setField(this.current, 'arTargetY', b & 0xffff & ~(ROUTE_CELL - 1));
        this.setField(this.current, 'xcood', this.field(this.current, 'xcood') & ~(ROUTE_CELL - 1));
        this.setField(this.current, 'ycood', this.field(this.current, 'ycood') & ~(ROUTE_CELL - 1));
        this.setField(this.current, 'arAnimIndex', 0);
        this.setField(this.current, 'logic', SKY_LOGIC.makeRoute);
        return false;
      }

      case SKY_MCODE.fnLeaving:
        // A mega leaving the place it was standing in. Zero arguments at every
        // call site, and the shipped scripts put it in exactly two positions:
        // in a get-to script immediately before `place` is overwritten with the
        // place just reached (script 28, words 1120–1125), and in an action
        // script between the route arriving and the mega standing up (script 31,
        // word 1169).
        //
        // Both of those say the same thing — this is the end of standing
        // somewhere — and the Compact's only state for that is the
        // `atWatch`/`atWas` pair, so this clears the watch.
        //
        // **What that is worth is small, and saying so is the point.** Measured
        // over every shipped module: `atWatch` is written by 35 script sites and
        // read by none, and `leaving` — the other field the name suggests — is
        // neither written nor read by any script in the game. So neither
        // candidate effect is observable from bytecode, and what this mcode
        // actually buys is the script carrying on: without it a floor-click
        // walked and then stopped one instruction short of standing the mega up.
        this.setField(this.current, 'atWatch', 0);
        return true;

      case SKY_MCODE.fnArAnimate:
        // Put a mega back on its walking animation. Zero arguments at every one
        // of its call sites, and the shipped get-to scripts place it between an
        // arrival and `fnSetToStand` — which is the pair that fixes what `mood`
        // means, because `fnSetToStand` is the only other thing that writes it
        // and it writes 1. So this writes 0: the mega is moving, not stood.
        //
        // Handing it to "follow a route" rather than setting a frame directly is
        // what makes it right in both the cases the scripts use it for. A mega
        // that has arrived has its target under it, so the route ends on the
        // spot and the script carries straight on to stand it up. A mega with
        // distance still to cover walks it.
        this.setField(this.current, 'mood', 0);
        this.setField(this.current, 'logic', SKY_LOGIC.followRoute);
        return false;

      case SKY_MCODE.fnSetToStand: {
        // Stand still, facing wherever the Compact is facing. The animation to
        // use is one of four in the current animation set, picked by direction.
        this.setField(this.current, 'mood', 1);
        const stand = this.megaSetWord(
          this.current,
          MEGA_SET_STAND_UP + this.field(this.current, 'dir'),
        );
        this.setField(this.current, 'grafixProgId', stand);
        this.setField(this.current, 'grafixProgPos', 0);
        this.setField(this.current, 'offset', this.grafix(this.current)?.[0] ?? 0);
        this.setField(this.current, 'logic', 16);
        this.setField(this.current, 'grafixProgPos', 1);
        this.stepSimpleAnimation(this.current);
        return false;
      }

      case SKY_MCODE.fnTurnTo: {
        // Turn a character to face a direction. The frames for going from one
        // direction to another are a table the Compact's animation set names —
        // five rows of five, which is why `turnTable` records exist at all.
        const from = this.field(this.current, 'dir');
        this.setField(this.current, 'dir', a & 0xffff);
        const table = this.turnTable(this.current);
        const program = table ? table[from * TURN_DIRECTIONS + a] : 0;
        // No program means the two directions need no animation between them,
        // and the script carries on rather than pausing.
        if (!program) return true;

        this.setField(this.current, 'turnProgId', program);
        this.setField(this.current, 'turnProgPos', 0);
        this.setField(this.current, 'logic', 7);
        this.stepTurn(this.current);
        return false;
      }

      case SKY_MCODE.fnRunAnimMod:
        // The same as fnSimpleMod, for an animation that does carry
        // coordinates. Both are the game's own words walked by an index the
        // Compact holds.
        this.setField(this.current, 'grafixProgId', a);
        this.setField(this.current, 'grafixProgPos', 0);
        this.setField(this.current, 'offset', this.grafix(this.current)?.[0] ?? 0);
        this.setField(this.current, 'grafixProgPos', 1);
        this.setField(this.current, 'logic', 6);
        this.stepAnimation(this.current);
        return false;

      case SKY_MCODE.fnSimpleMod:
        // Start an animation program that ignores coordinates, and step it
        // once. The program is another Compact's words, walked by an index the
        // Compact carries — so it is state, not a subsystem.
        this.setField(this.current, 'grafixProgId', a);
        this.setField(this.current, 'grafixProgPos', 0);
        this.setField(this.current, 'logic', 16);
        this.setField(this.current, 'offset', this.grafix(this.current)?.[0] ?? 0);
        this.setField(this.current, 'grafixProgPos', 1);
        this.stepSimpleAnimation(this.current);
        return false;

      case SKY_MCODE.fnQuitToDos:
        this.quit = true;
        return false;

      case SKY_MCODE.fnPause: // count down in the Compact and come back
        this.setField(this.current, 'flag', a);
        this.setField(this.current, 'logic', 14);
        return false;

      case SKY_MCODE.fnRandom:
        this.variables[SKY_VAR.result] = a > 0 ? Math.floor(Math.random() * a) : 0;
        return true;

      case SKY_MCODE.fnFetchX:
        this.variables[SKY_VAR.result] = this.field(a, 'xcood');
        return true;
      case SKY_MCODE.fnFetchY:
        this.variables[SKY_VAR.result] = this.field(a, 'ycood');
        return true;
      case SKY_MCODE.fnFetchPlace:
        this.variables[SKY_VAR.result] = this.field(a, 'place');
        return true;

      case SKY_MCODE.fnPersonHere:
        this.variables[SKY_VAR.result] = this.field(a, 'screen') === b ? 1 : 0;
        return true;

      default:
        // Named and counted rather than skipped. The interpreter turns this
        // into a stop carrying the mcode's name and the calling offset.
        void c;
        throw new SkyMcodeUnimplemented(mcode);
    }
  }

  /**
   * Records a subsystem an mcode wanted and this project does not have.
   *
   * Different from an unimplemented mcode and worth keeping apart: the mcode
   * *ran*, and one thing it does reached nothing. Counting it keeps the gap
   * visible without stopping a script that is otherwise being served properly.
   */
  private noteMissing(what: string): void {
    this.unimplemented.set(what, (this.unimplemented.get(what) ?? 0) + 1);
  }

  /**
   * Records the cursor shape a pointer-mode mcode asked for, and notes that
   * nothing draws it. Kept as one line the six mcodes share so the "recorded,
   * not drawn" decision lives in one place rather than six.
   */
  private setCursor(cursor: SkyCursor): void {
    this.cursor = cursor;
    this.noteMissing('the mouse cursor');
  }

  /** Notes the resources a script asked to have loaded. */
  private recordCacheList(listId: number): void {
    const list = this.compacts.get(listId);
    if (!list) return;
    for (const entry of list) {
      if (entry === 0) break;
      this.cached.add(entry & 0x7fff);
    }
  }

  /**
   * Calls a script from a script.
   *
   * A Compact holds four script slots and `mode` says which is running, so a
   * call is "step mode on by four, and put the new script in the slot that
   * lands on". Returning to the caller is `mode` stepping back, which
   * `logicScript` does when a script exits.
   */
  private pushSub(script: number): void {
    const mode = this.field(this.current, 'mode') + 4;
    this.setField(this.current, 'mode', mode);
    this.setSub(this.current, mode, script & 0xffff);
    this.setSub(this.current, mode + 2, (script >>> 16) & 0xffff);
  }

  /**
   * The animation program a Compact is running, from its current position.
   *
   * The program is another Compact's words and `grafixProgPos` indexes into
   * them, which is why an animation is state a save carries rather than
   * something an engine holds beside the world.
   */
  grafix(id: number): Uint16Array | null {
    const programId = this.field(id, 'grafixProgId');
    const program = this.compacts.get(programId);
    if (!program) return null;
    const at = this.field(id, 'grafixProgPos');
    return at < program.length ? program.subarray(at) : null;
  }

  /**
   * One step of an animation that ignores coordinates.
   *
   * Three words a step: a command, two coordinates that this kind skips, and a
   * frame. A command of 0xffff is not a frame at all — it hands a sync to
   * another Compact and the walk continues, which is how one character's
   * animation starts another's.
   *
   * Returns false when the program ran out — the animation ending and the
   * Compact going back to its script, exactly as {@link stepAnimation} ends.
   *
   * **That ending is what a click on a thing was missing.** This used to return
   * at the end of the program and leave the Compact on logic 16, where every
   * later tick re-read an exhausted program and returned again: the mega stood
   * there and its script never resumed. Measured on the shipped game, clicking
   * Beneath a Steel Sky's `fire_notice` ran `fnGetTo`, walked Foster from
   * 288,216 to the notice, ran `fnLeaving`, `fnArAnimate` and `fnSetToStand` —
   * and stopped there for good, with `mode` still 4, so the `fnInteract` that
   * sits after the walk in the clicking script never ran. The walk worked and
   * the action was swallowed, which looks from outside like a game that does
   * not respond to anything you click.
   */
  stepSimpleAnimation(id: number): boolean {
    for (let guard = 0; guard < 256; guard += 1) {
      const program = this.grafix(id);
      if (!program || program.length === 0 || program[0] === 0) break;

      this.setField(id, 'grafixProgPos', this.field(id, 'grafixProgPos') + 3);
      if (program[0] !== 0xffff) {
        const frame = program[2];
        // A frame below 64 is relative to the Compact's own offset; at or above
        // it, absolute. That split is the game's, and getting it backwards
        // draws the right animation from the wrong place.
        this.setField(id, 'frame', frame >= 64 ? frame : frame + this.field(id, 'offset'));
        return true;
      }
      this.setField(program[1], 'sync', program[2]);
    }

    // The same two writes the coordinate-carrying kind ends with: the script's
    // "that worked" flag cleared, and the Compact handed back to its script.
    this.setField(id, 'downFlag', 0);
    this.setField(id, 'logic', SKY_LOGIC.script);
    return false;
  }

  /**
   * One step of an animation that carries coordinates.
   *
   * Three words a step again, and the first says which kind: 0xfffe asks for a
   * sound effect, anything above it hands a sync to another Compact, and
   * anything else is a position and a frame.
   *
   * A frame here is `frame | offset` where the coordinate-less kind adds them.
   * That is the game's own difference between the two and not a tidiness to
   * unify: `or` and `+` agree only while the low bits are clear.
   *
   * Returns false when the program ran out, which is the animation ending and
   * the Compact going back to its script.
   */
  stepAnimation(id: number): boolean {
    for (let guard = 0; guard < 256; guard += 1) {
      const program = this.grafix(id);
      if (!program || program.length === 0 || program[0] === 0) break;

      this.setField(id, 'grafixProgPos', this.field(id, 'grafixProgPos') + 3);
      const command = program[0];

      if (command === 0xfffe) {
        // A sound effect. Nothing plays yet (#257), and the request is counted
        // rather than dropped so the gap is visible.
        this.effects += 1;
        continue;
      }
      if (command > 0xfffe) {
        this.setField(program[1], 'sync', program[2]);
        continue;
      }

      this.setField(id, 'xcood', program[0]);
      this.setField(id, 'ycood', program[1]);
      this.setField(id, 'frame', program[2] | this.field(id, 'offset'));
      return true;
    }

    this.setField(id, 'downFlag', 0);
    this.setField(id, 'logic', 1);
    return false;
  }

  /**
   * A word of the animation set a Compact is currently using.
   *
   * The engine reaches into this region where a script never does — the
   * measurement behind `skyCompactFieldAt` found no script indexing past the
   * Compact's own fields, and that is still true; what needs it is this side.
   *
   * `megaSet` holds a byte offset rather than an index, and the game's own
   * constants pin the layout: `C_MEGA_SET` is 112, `C_GRID_WIDTH` — the first
   * word of the first set — is 114, and `C_STAND_UP` is 138. All three agree
   * with the field table this project measured, at three independent points.
   */
  megaSetWord(id: number, index: number): number {
    const set = Math.floor(this.field(id, 'megaSet') / MEGA_SET_STRIDE_BYTES);
    const words = this.compacts.get(id);
    if (!words) return 0;
    const at = SKY_COMPACT_FIELDS.length + set * MEGA_SET_WORDS + index;
    return at < words.length ? words[at] : 0;
  }

  /**
   * The turn table of the animation set a Compact is currently using.
   *
   * `megaSet` holds a **byte offset** into the original structure rather than
   * an index — 0, 144, 288 or 432 — which is the same addressing a script's own
   * `push_offset` uses, and a further confirmation of it: the Compact's own
   * fields end at byte 114, where the first animation set begins.
   */
  turnTable(id: number): Uint16Array | null {
    return this.compacts.get(this.megaSetWord(id, MEGA_SET_TURN_TABLE)) ?? null;
  }

  /**
   * One frame of a turn.
   *
   * A flat list of frames ending in zero. When it runs out the Compact goes
   * back to its script, which is the same shape as an animation ending.
   */
  stepTurn(id: number): boolean {
    const program = this.compacts.get(this.field(id, 'turnProgId'));
    const at = this.field(id, 'turnProgPos');
    const frame = program && at < program.length ? program[at] : 0;
    if (frame !== 0) {
      this.setField(id, 'frame', frame);
      this.setField(id, 'turnProgPos', at + 1);
      return true;
    }
    this.setField(id, 'arAnimIndex', 0);
    this.setField(id, 'logic', 1);
    return false;
  }

  /**
   * The direction a Compact would have to face to get closer to its target.
   *
   * Horizontal first, then vertical: a route of at most two legs. **This is
   * where a faithful router would read the walk grid, and does not.** Sky
   * chooses which of the seventy shipped grids a screen uses through a table
   * that lives only in an interpreter — looked for in the Compacts, in the disk
   * index and in an executable, found in none of them, and therefore refused by
   * name under ADR 0033 (`SkyGrid.ts` records the search). Without that map
   * there is no grid to ask "is this cell blocked", so there is nothing to route
   * around and the honest thing is a straight line stated as one.
   *
   * What that costs, plainly: Foster walks, and he walks through scenery rather
   * than around it. What it buys is that the get-to chain a click starts now
   * finishes — the walk arrives, `downFlag` clears, and the script that was
   * waiting on it runs on.
   *
   * Returns null when the Compact is already on its target.
   */
  private routeDirection(id: number): number | null {
    const x = this.field(id, 'xcood');
    const y = this.field(id, 'ycood');
    const toX = this.field(id, 'arTargetX');
    const toY = this.field(id, 'arTargetY');
    if (x !== toX) return x < toX ? DIR_RIGHT : DIR_LEFT;
    if (y !== toY) return y < toY ? DIR_DOWN : DIR_UP;
    return null;
  }

  /**
   * Begins the walk a Compact was handed a target for.
   *
   * The whole of "making a route" here, because {@link routeDirection} decides
   * each leg from the live position rather than from a buffer built in advance:
   * the state a route needs is the target and the animation index, and the
   * Compact already carries both. That is why nothing writes `animScratchId` —
   * the game keeps its route in a scratch Compact, and a route this engine can
   * recompute in two comparisons would be a buffer written and never read.
   *
   * Returns false when there is nowhere to go, which ends the walk as an
   * arrival: a script that asks a mega to walk to where it stands is asking for
   * a no-op, not for a failure.
   */
  startRoute(id: number): boolean {
    this.setField(id, 'arAnimIndex', 0);
    return this.routeDirection(id) !== null;
  }

  /**
   * One frame of a walk, or the end of one.
   *
   * Four words an entry — a distance, a frame and a signed step — against the
   * three {@link stepAnimation} reads, which is the difference between an
   * animation that is played and a walk that is followed. The frame obeys the
   * same split {@link stepSimpleAnimation} uses: below 64 it is relative to the
   * Compact's own `offset`, at or above it absolute.
   *
   * Returns false when the Compact has arrived, and clears `downFlag` as it
   * does — that flag is the get-to script's answer and this is the one place
   * that gives it.
   */
  stepRoute(id: number): boolean {
    const direction = this.routeDirection(id);
    if (direction === null) {
      this.setField(id, 'downFlag', 0);
      this.setField(id, 'logic', SKY_LOGIC.script);
      return false;
    }

    const program = this.compacts.get(this.megaSetWord(id, MEGA_SET_WALK + direction));
    if (!program) {
      // A mega whose animation set names no walk for this direction. Counted
      // rather than pretended, and the Compact is put back on its script so a
      // missing program is a thing that does not animate instead of a thing
      // that hangs.
      this.noteMissing(`a walking animation for direction ${direction}`);
      this.setField(id, 'downFlag', 0);
      this.setField(id, 'logic', SKY_LOGIC.script);
      return false;
    }

    let at = this.field(id, 'arAnimIndex');
    if (at + WALK_ENTRY_WORDS > program.length || program[at] === 0) at = 0;
    this.setField(id, 'arAnimIndex', at + WALK_ENTRY_WORDS);

    const frame = program[at + 1];
    const stepX = this.signedWord(program[at + 2]);
    const stepY = this.signedWord(program[at + 3]);
    // Clamped so a step longer than what is left lands on the target rather
    // than past it. The shipped steps divide every snapped distance exactly, so
    // this never fires for a mega walking on its own animation set; it is here
    // so that one which did not could still arrive.
    const left = this.field(id, 'arTargetX') - this.field(id, 'xcood');
    const up = this.field(id, 'arTargetY') - this.field(id, 'ycood');
    this.setField(id, 'xcood', this.field(id, 'xcood') + clampStep(stepX, left));
    this.setField(id, 'ycood', this.field(id, 'ycood') + clampStep(stepY, up));
    this.setField(id, 'frame', frame >= 64 ? frame : frame + this.field(id, 'offset'));
    return true;
  }

  /**
   * Starts the turn a change of leg needs, if the animation set has one.
   *
   * The same turn table {@link stepTurn} walks, reached the same way — so a
   * mega turning a corner mid-route turns with the frames the game ships for
   * it. Returns false when there is no program between the two directions,
   * which is the set saying the change needs no animation.
   */
  startRouteTurn(id: number, direction: number): boolean {
    const from = this.field(id, 'dir');
    this.setField(id, 'dir', direction);
    const table = this.turnTable(id);
    const program = table ? table[from * TURN_DIRECTIONS + direction] : 0;
    if (!program) return false;
    this.setField(id, 'turnProgId', program);
    this.setField(id, 'turnProgPos', 0);
    return true;
  }

  /** Whether a Compact on a route still has to turn before its next step. */
  routeTurn(id: number): number | null {
    const direction = this.routeDirection(id);
    if (direction === null || direction === this.field(id, 'dir')) return null;
    return direction;
  }

  /** A Compact word read as a signed sixteen-bit number. */
  private signedWord(value: number): number {
    return value >= 0x8000 ? value - 0x10000 : value;
  }

  /** The script number or offset in one of a Compact's four slots. */
  getSub(id: number, mode: number): number {
    const name = SUB_FIELDS[mode / 2];
    return name ? this.field(id, name) : 0;
  }

  setSub(id: number, mode: number, value: number): void {
    const name = SUB_FIELDS[mode / 2];
    if (name) this.setField(id, name, value);
  }

  /** What could not be done, for a stall report. */
  notes(): SkyWorldNote[] {
    const out: SkyWorldNote[] = [];
    for (const [what, count] of this.unimplemented) out.push({ what, count });
    for (const [what, count] of this.unimplementedLogic) {
      out.push({ what: `logic: ${what}`, count });
    }
    return out.sort((left, right) => right.count - left.count);
  }
}
