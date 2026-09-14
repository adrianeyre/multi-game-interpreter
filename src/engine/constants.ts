/**
 * Well-known SCUMM variable slots for v5.
 *
 * The interpreter and the game scripts share these by number: the scripts read
 * `VAR_MOUSE_X` to find the cursor, the interpreter reads `VAR_EGO` to know
 * which actor the player controls. Getting one wrong produces symptoms far
 * from the cause, so they are named rather than inlined.
 */
export const VAR = {
  KEYPRESS: 0,
  EGO: 1,
  CAMERA_POS_X: 2,
  HAVE_MSG: 3,
  ROOM: 4,
  OVERRIDE: 5,
  MACHINE_SPEED: 6,
  ME: 7,
  NUM_ACTOR: 8,
  CURRENT_LIGHTS: 9,
  CURRENTDRIVE: 10,
  TMR_1: 11,
  TMR_2: 12,
  TMR_3: 13,
  MUSIC_TIMER: 14,
  ACTOR_RANGE_MIN: 15,
  ACTOR_RANGE_MAX: 16,
  CAMERA_MIN_X: 17,
  CAMERA_MAX_X: 18,
  TIMER_NEXT: 19,
  VIRT_MOUSE_X: 20,
  VIRT_MOUSE_Y: 21,
  ROOM_RESOURCE: 22,
  LAST_SOUND: 23,
  CUTSCENEEXIT_KEY: 24,
  TALK_ACTOR: 25,
  CAMERA_FAST_X: 26,
  SCROLL_SCRIPT: 27,
  ENTRY_SCRIPT: 28,
  ENTRY_SCRIPT2: 29,
  EXIT_SCRIPT: 30,
  EXIT_SCRIPT2: 31,
  VERB_SCRIPT: 32,
  SENTENCE_SCRIPT: 33,
  INVENTORY_SCRIPT: 34,
  CUTSCENE_START_SCRIPT: 35,
  CUTSCENE_END_SCRIPT: 36,
  CHARINC: 37,
  WALKTO_OBJ: 38,
  DEBUGMODE: 39,
  HEAPSPACE: 40,
  RESTART_KEY: 42,
  PAUSE_KEY: 43,
  MOUSE_X: 44,
  MOUSE_Y: 45,
  TIMER: 46,
  TIMER_TOTAL: 47,
  SOUNDCARD: 48,
  VIDEOMODE: 49,
  MAINMENU_KEY: 50,
  FIXEDDISK: 51,
  CURSORSTATE: 52,
  USERPUT: 53,
  V5_TALK_STRING_Y: 54,
  SOUNDRESULT: 56,
  TALKSTOP_KEY: 57,
  FADE_DELAY: 59,
  NOSUBTITLES: 60,
  SOUNDPARAM: 64,
  SOUNDPARAM2: 65,
  SOUNDPARAM3: 66,
  INPUTMODE: 67,
  MEMORY_PERFORMANCE: 68,
  VIDEO_PERFORMANCE: 69,
  ROOM_FLAG: 70,
  GAME_LOADED: 71,
  NEW_ROOM: 72,
} as const;

/**
 * The slots v5 added, which a v4 game does not have.
 *
 * A subtraction rather than a second table, because v4's map *is* v5's up to
 * this point: `ScummEngine::setupScummVars` fills the shared list and then
 * guards these eleven behind `_game.version >= 5`. Listed by name so the
 * relationship stays visible — a v4 map written out in full would be v5's with
 * eleven lines quietly missing, and the next person to add a slot would have to
 * notice.
 *
 * A v4 game writing one of these anyway lands on the absent slot, which is what
 * `resolveVariables` exists for: better a variable nobody reads than variable
 * 56 of a game that keeps something else there.
 */
const V5_ONLY_VARIABLES = [
  'SOUNDRESULT',
  'TALKSTOP_KEY',
  'FADE_DELAY',
  'SOUNDPARAM',
  'SOUNDPARAM2',
  'SOUNDPARAM3',
  'INPUTMODE',
  'MEMORY_PERFORMANCE',
  'VIDEO_PERFORMANCE',
  'ROOM_FLAG',
  'GAME_LOADED',
  'NEW_ROOM',
] as const;

/**
 * Variable slots v6 adds to the table above.
 *
 * v6 keeps every v5 slot where it was and appends its own, which is why this is
 * an addendum rather than a second table: `VAR.EGO` is 1 in both, and a v6
 * engine reading a v6-only slot out of the v5 table would find whatever the
 * game happened to leave there.
 *
 * From `ScummEngine_v6::setupScummVars`.
 */
export const VAR_V6 = {
  ROOM_WIDTH: 41,
  ROOM_HEIGHT: 54,
  /** 0 voice, 1 voice and text, 2 text only. */
  VOICE_MODE: 60,
  PRE_SAVELOAD_SCRIPT: 61,
  POST_SAVELOAD_SCRIPT: 62,
  LEFTBTN_HOLD: 74,
  RIGHTBTN_HOLD: 75,
  EMS_SPACE: 76,
  RANDOM_NR: 118,
  TIMEDATE_YEAR: 119,
  TIMEDATE_HOUR: 125,
  TIMEDATE_MINUTE: 126,
  TIMEDATE_DAY: 128,
  TIMEDATE_MONTH: 129,
} as const;

/**
 * The v7 variable table, which is not v5's with additions.
 *
 * v6 layers a handful of overrides onto the base table, which is why `VAR_V6`
 * is a short list. v7 does not: `ScummEngine_v7::setupScummVars` assigns every
 * slot from scratch and agrees with the base on almost nothing. `VAR_ROOM` is
 * 4 for v5 and v6 and 10 for v7; `VAR_EGO` is 1 and 111; `VAR_KEYPRESS` is 0
 * and 118 — and 118 is v6's `VAR_RANDOM_NR`, so a v7 game reading the base
 * table finds the last random number where it expects the last key.
 *
 * That makes this a full table rather than a delta, and it is why the numbers
 * are written out even where they happen to coincide: a coincidence read as a
 * shared rule is how the next version acquires the wrong one.
 *
 * **The engine does not yet read this everywhere.** `ScummEngine` names the
 * base table directly at some eighty sites, so a v7 game currently agrees with
 * its scripts only where the two tables happen to coincide. Wiring a
 * per-version lookup through those sites is its own change; what is here is the
 * table, used at the sites v7 code owns.
 *
 * From `ScummEngine_v7::setupScummVars`.
 */
export const VAR_V7 = {
  MOUSE_X: 1,
  MOUSE_Y: 2,
  VIRT_MOUSE_X: 3,
  VIRT_MOUSE_Y: 4,
  ROOM_WIDTH: 5,
  ROOM_HEIGHT: 6,
  CAMERA_POS_X: 7,
  /** v7's second camera axis, which v5 and v6 have no variable for at all. */
  CAMERA_POS_Y: 8,
  OVERRIDE: 9,
  ROOM: 10,
  ROOM_RESOURCE: 11,
  TALK_ACTOR: 12,
  HAVE_MSG: 13,
  TIMER: 14,
  TIMER_TOTAL: 15,
  TIMEDATE_YEAR: 16,
  TIMEDATE_MONTH: 17,
  TIMEDATE_DAY: 18,
  TIMEDATE_HOUR: 19,
  TIMEDATE_MINUTE: 20,
  TIMEDATE_SECOND: 21,
  LEFTBTN_DOWN: 22,
  RIGHTBTN_DOWN: 23,
  LEFTBTN_HOLD: 24,
  RIGHTBTN_HOLD: 25,
  MEMORY_PERFORMANCE: 26,
  VIDEO_PERFORMANCE: 27,
  GAME_LOADED: 29,
  EMS_SPACE: 32,
  /** 0 voice, 1 voice and text, 2 text only. */
  VOICE_MODE: 33,
  RANDOM_NR: 34,
  NEW_ROOM: 35,
  WALKTO_OBJ: 36,
  NUM_GLOBAL_OBJS: 37,
  CAMERA_DEST_X: 38,
  CAMERA_DEST_Y: 39,
  CAMERA_FOLLOWED_ACTOR: 40,
  SCROLL_SCRIPT: 50,
  ENTRY_SCRIPT: 51,
  ENTRY_SCRIPT2: 52,
  EXIT_SCRIPT: 53,
  EXIT_SCRIPT2: 54,
  VERB_SCRIPT: 55,
  SENTENCE_SCRIPT: 56,
  INVENTORY_SCRIPT: 57,
  CUTSCENE_START_SCRIPT: 58,
  CUTSCENE_END_SCRIPT: 59,
  PRE_SAVELOAD_SCRIPT: 60,
  POST_SAVELOAD_SCRIPT: 61,
  CUTSCENEEXIT_KEY: 62,
  RESTART_KEY: 63,
  PAUSE_KEY: 64,
  MAINMENU_KEY: 65,
  VERSION_KEY: 66,
  TALKSTOP_KEY: 67,
  TIMER_NEXT: 97,
  TMR_1: 98,
  TMR_2: 99,
  TMR_3: 100,
  CAMERA_MIN_X: 101,
  CAMERA_MAX_X: 102,
  CAMERA_MIN_Y: 103,
  CAMERA_MAX_Y: 104,
  CAMERA_THRESHOLD_X: 105,
  CAMERA_THRESHOLD_Y: 106,
  CAMERA_SPEED_X: 107,
  CAMERA_SPEED_Y: 108,
  CAMERA_ACCEL_X: 109,
  CAMERA_ACCEL_Y: 110,
  EGO: 111,
  CURSORSTATE: 112,
  USERPUT: 113,
  DEFAULT_TALK_DELAY: 114,
  CHARINC: 115,
  DEBUGMODE: 116,
  FADE_DELAY: 117,
  KEYPRESS: 118,
  /** Full Throttle only; The Dig's interpreter leaves the slot unassigned. */
  CHARSET_MASK: 119,
  /**
   * The array handle holding the name of the video to play.
   *
   * v7 does not pass a file name as an operand: a script writes the name into
   * a string array and `kernelSetFunctions` 6 reads it back from here. So a
   * video is played by two instructions that have to agree about a variable
   * number, and getting this one wrong plays nothing while looking like a
   * missing file.
   */
  VIDEONAME: 123,
  STRING2DRAW: 130,
  CUSTOMSCALETABLE: 131,
  BLAST_ABOVE_TEXT: 133,
  MUSIC_BUNDLE_LOADED: 135,
  VOICE_BUNDLE_LOADED: 136,
} as const;

/**
 * A version's variable table, resolved over every name any version has.
 *
 * The engine needs one shape whichever version is running, and the three tables
 * are not the same shape. v6 is the base plus fourteen names of its own; v7 is
 * a table written from scratch that lacks twenty-two of the base's names and
 * adds others. So the key set here is the **union** of all three, and a version
 * that has no such variable says so rather than being given a default — because
 * a default is a real slot holding something else.
 */
/**
 * The v8 variable table, which agrees with v7's about even less than v7's does
 * with v5's.
 *
 * `VAR_EGO` is 1 at v5, 111 at v7 and 126 here. `VAR_ROOM` is 4, 10 and 31.
 * `VAR_KEYPRESS` is 0, 118 and 132. There is no arithmetic that turns one into
 * another, which is why this is a whole table rather than a delta and why the
 * numbers are written out even where two Versions happen to coincide — a
 * coincidence read as a shared rule is how the next Version acquires the wrong
 * one.
 *
 * v8 also spends a long run of slots on the camera that no earlier Version has
 * variables for at all: minimum, maximum, speed, acceleration and threshold on
 * both axes.
 *
 * From `ScummEngine_v8::setupScummVars`.
 */
export const VAR_V8 = {
  ROOM_WIDTH: 1,
  ROOM_HEIGHT: 2,
  MOUSE_X: 3,
  MOUSE_Y: 4,
  VIRT_MOUSE_X: 5,
  VIRT_MOUSE_Y: 6,
  CURSORSTATE: 7,
  USERPUT: 8,
  CAMERA_POS_X: 9,
  CAMERA_POS_Y: 10,
  CAMERA_DEST_X: 11,
  CAMERA_DEST_Y: 12,
  CAMERA_FOLLOWED_ACTOR: 13,
  TALK_ACTOR: 14,
  HAVE_MSG: 15,
  LEFTBTN_DOWN: 16,
  RIGHTBTN_DOWN: 17,
  LEFTBTN_HOLD: 18,
  RIGHTBTN_HOLD: 19,
  TIMEDATE_YEAR: 24,
  TIMEDATE_MONTH: 25,
  TIMEDATE_DAY: 26,
  TIMEDATE_HOUR: 27,
  TIMEDATE_MINUTE: 28,
  TIMEDATE_SECOND: 29,
  OVERRIDE: 30,
  ROOM: 31,
  NEW_ROOM: 32,
  WALKTO_OBJ: 33,
  TIMER: 34,
  VOICE_MODE: 39,
  GAME_LOADED: 40,
  LANGUAGE: 41,
  CURRENTDISK: 42,
  MUSIC_BUNDLE_LOADED: 45,
  VOICE_BUNDLE_LOADED: 46,
  SCROLL_SCRIPT: 50,
  ENTRY_SCRIPT: 51,
  ENTRY_SCRIPT2: 52,
  EXIT_SCRIPT: 53,
  EXIT_SCRIPT2: 54,
  VERB_SCRIPT: 55,
  SENTENCE_SCRIPT: 56,
  INVENTORY_SCRIPT: 57,
  CUTSCENE_START_SCRIPT: 58,
  CUTSCENE_END_SCRIPT: 59,
  CUTSCENEEXIT_KEY: 62,
  PAUSE_KEY: 64,
  MAINMENU_KEY: 65,
  VERSION_KEY: 66,
  TALKSTOP_KEY: 67,
  CUSTOMSCALETABLE: 111,
  TIMER_NEXT: 112,
  TMR_1: 113,
  TMR_2: 114,
  TMR_3: 115,
  CAMERA_MIN_X: 116,
  CAMERA_MAX_X: 117,
  CAMERA_MIN_Y: 118,
  CAMERA_MAX_Y: 119,
  CAMERA_SPEED_X: 120,
  CAMERA_SPEED_Y: 121,
  CAMERA_ACCEL_X: 122,
  CAMERA_ACCEL_Y: 123,
  CAMERA_THRESHOLD_X: 124,
  CAMERA_THRESHOLD_Y: 125,
  EGO: 126,
  DEFAULT_TALK_DELAY: 128,
  CHARINC: 129,
  DEBUGMODE: 130,
  KEYPRESS: 132,
  BLAST_ABOVE_TEXT: 133,
  SYNC: 134,
  SAVELOAD_PAGE: 175,
  OBJECT_LABEL_FLAG: 176,
} as const;

export type VariableMap = Readonly<
  Record<keyof typeof VAR | keyof typeof VAR_V6 | keyof typeof VAR_V7 | keyof typeof VAR_V8, number>
>;

/** Every name any version knows, which is the shape a resolved map answers. */
const ALL_VARIABLE_NAMES = [
  ...new Set([
    ...Object.keys(VAR),
    ...Object.keys(VAR_V6),
    ...Object.keys(VAR_V7),
    ...Object.keys(VAR_V8),
  ]),
] as Array<keyof VariableMap>;

/**
 * Names v7 has no variable for, written down rather than only derived.
 *
 * Mostly the machine-configuration slots a v5 game polls — how fast the machine
 * is, which drive it booted from, what sound card is fitted. v7 asks none of
 * that, so there is nothing for these to mean and nowhere to write them.
 *
 * Kept as a list as well as being derivable from `VAR_V7`, because "v7 has no
 * such variable" and "the v7 table has not been transcribed yet" produce the
 * same lookup miss and only the first is safe. A test asserts the two agree, so
 * a name dropped from `VAR_V7` by accident fails rather than silently resolving
 * to nowhere and reading as zero for ever.
 */
export const ABSENT_IN_V7 = [
  // Five that v8 introduced and v7 has no counterpart for. They are on this
  // list rather than only in `VAR_V8` for the same reason as the rest of it:
  // the list is what tells "v7 does not have this" apart from "someone dropped
  // a line from the v7 table".
  'CURRENTDISK',
  'LANGUAGE',
  'OBJECT_LABEL_FLAG',
  'SAVELOAD_PAGE',
  'SYNC',
  'MACHINE_SPEED',
  'ME',
  'NUM_ACTOR',
  'CURRENT_LIGHTS',
  'CURRENTDRIVE',
  'MUSIC_TIMER',
  'ACTOR_RANGE_MIN',
  'ACTOR_RANGE_MAX',
  'LAST_SOUND',
  'CAMERA_FAST_X',
  'HEAPSPACE',
  'SOUNDCARD',
  'VIDEOMODE',
  'FIXEDDISK',
  'V5_TALK_STRING_Y',
  'SOUNDRESULT',
  'NOSUBTITLES',
  'SOUNDPARAM',
  'SOUNDPARAM2',
  'SOUNDPARAM3',
  'INPUTMODE',
  'ROOM_FLAG',
] as const satisfies ReadonlyArray<keyof VariableMap>;

function resolveVariables(
  own: Partial<Record<keyof VariableMap, number>>,
  absentSlot: number,
): VariableMap {
  const resolved = {} as Record<keyof VariableMap, number>;
  for (const name of ALL_VARIABLE_NAMES) resolved[name] = own[name] ?? absentSlot;
  return resolved;
}

/**
 * The variable table for a SCUMM version.
 *
 * `absentSlot` is where a name this version has no variable for resolves to: a
 * real slot the engine reserves past the game's own, so every caller stays a
 * plain array index. The alternative — a sentinel of -1 — reads back as
 * `undefined` and propagates as `NaN` through whatever arithmetic touches it,
 * which is a wrong number rather than an absent one. Zero is worse still: it is
 * `VAR_KEYPRESS` under v5 and a live slot under v7.
 *
 * Written as an exact match per version rather than a `>=` chain, for the same
 * reason the interpreter is chosen that way: a `>=` here is how a later version
 * quietly acquires an earlier one's table.
 */
export function variablesFor(version: number, absentSlot: number): VariableMap {
  if (version >= 8) return resolveVariables(VAR_V8, absentSlot);
  if (version === 7) return resolveVariables(VAR_V7, absentSlot);
  if (version === 6) return resolveVariables({ ...VAR, ...VAR_V6 }, absentSlot);
  if (version <= 4) {
    const v4: Record<string, number> = { ...VAR };
    for (const name of V5_ONLY_VARIABLES) delete v4[name];
    return resolveVariables(v4 as unknown as typeof VAR, absentSlot);
  }
  return resolveVariables(VAR, absentSlot);
}

/**
 * Where a click landed, as the game's own input script is told it.
 *
 * From v5 onwards SCUMM does not decide what a click means: it runs the game's
 * input script — `VAR_VERB_SCRIPT` — with the area, what was clicked and which
 * button, and the script decides. That is what makes Sam & Max's verb coin
 * possible at all: the coin is drawn and driven entirely by scripts, and the
 * interpreter's only part in it is reporting the button honestly.
 *
 * From ScummVM's `ClickArea` in `verbs.h`.
 */
export const enum ClickArea {
  Verb = 1,
  Scene = 2,
  Inventory = 3,
  Key = 4,
  Sentence = 5,
}

/** Which mouse button an input script is told about. */
export const enum MouseButton {
  Left = 1,
  Right = 2,
}

/** Where a script or object lives, mirroring SCUMM's `WhereIsObject`. */
export const enum ObjectWhere {
  NotFound = -1,
  Inventory = 0,
  Room = 1,
  Global = 2,
  Local = 3,
  FlObject = 4,
}

export const enum ScriptStatus {
  Dead = 0,
  Paused = 1,
  Running = 2,
}

/**
 * The object classes the engine itself reads, from ScummVM's `ObjectClass`.
 *
 * Only the named ones are the engine's business; everything else in the range
 * 1 to 32 belongs to the game and is only ever moved about by `setClass` and
 * read by `ifClassOfIs`. Which numbers these are is a fact about the games,
 * and getting them wrong is quiet: the classes not named here are in constant
 * use by real scripts, so a test against the wrong number answers with
 * somebody else's flag rather than with nothing.
 *
 * `Untouchable` was 20 here, which is `NeverClip`. Day of the Tentacle loads a
 * small floating object to use as the mouse cursor and marks it untouchable;
 * with the hit test asking the wrong question, the cursor object counted as a
 * hotspot, and because it sits at the top-left corner of the room the game
 * thought the player was pointing at it whenever the pointer had not moved
 * yet. Every click then acted on the cursor instead of on the floor.
 *
 * Atlantis reads the same fault the other way round. Its opening attic sets
 * class 20 on every object in the room, so with the numbers shifted all
 * fifteen of them tested untouchable at once and the room could not be played
 * at all.
 */
export const OBJECT_CLASS = {
  /** Draw in front of everything, whatever the room's masks say. */
  NeverClip: 20,
  /** Draw behind everything. */
  AlwaysClip: 21,
  /** Walk without regard to the room's boxes. */
  IgnoreBoxes: 22,
  YFlip: 29,
  XFlip: 30,
  /** The actor the player is controlling. */
  Player: 31,
  /** Not a hotspot: the hit test passes straight over it. */
  Untouchable: 32,
} as const;

export const OF_OWNER_ROOM = 0x0f;

/**
 * What v7 leaves in the owner table, meaning the same as `OF_OWNER_ROOM`.
 *
 * v7's index dropped the owner column — it keeps a state and a room per object
 * and nothing else — so there is no owner to read and the original fills the
 * table with this instead (`ScummEngine_v7::readGlobalObjects`). It has to read
 * as "the room has it": tested against `OF_OWNER_ROOM` alone, every object in
 * every v7 room counts as belonging to somebody else, and a room where nothing
 * is drawn and nothing can be clicked is a room the game cannot get out of.
 */
export const OF_OWNER_ROOM_V7 = 0xff;

/**
 * The `animateActor` arguments that are commands rather than frame numbers.
 *
 * Almost every argument *is* a frame: a script asks for chore 6 by passing 6.
 * Three values are reserved, and they are counted down from the top of the
 * byte rather than up from zero — the original derives the command as
 * `0x3F - (argument >> 2) + 2`, so the reserved block is the last twelve
 * arguments and each command occupies four of them, one per direction in the
 * low two bits.
 *
 * Numbering them up from one instead put the reserved block at arguments 4 to
 * 15, which are ordinary chores in a real game. Day of the Tentacle's intro is
 * where that shows: it plays Purple Tentacle's drink through chores 6 to 9, so
 * "animate chore 6" was read as "stand", the drinking never played, and the
 * script waiting for that animation to tick the costume's counter waited for
 * an animation that had never started.
 */
export const ANIMATE_COMMAND = {
  /** Stop walking and stand. */
  Stand: 0xfc,
  /** Face a direction at once, without animating the turn. */
  SetDirection: 0xf8,
  /** Turn to a direction, animating through the intermediate facings. */
  TurnToDirection: 0xf4,
} as const;

/**
 * Frame numbers `startAnimActor` resolves against the actor's own frames,
 * rather than treating as costume frames.
 */
export const ANIMATE_FRAME = {
  Init: 0x38,
  Walk: 0x39,
  Stand: 0x3a,
  TalkStart: 0x3b,
  TalkStop: 0x3c,
} as const;

/**
 * v7's pseudo-frames, which stand where v5 and v6 keep `ANIMATE_FRAME`.
 *
 * v7 reads the argument in thousands rather than in the low two bits, so its
 * standard poses are 1001 to 1005 and its commands are 2000, 3000 and 4000.
 */
export const ANIMATE_FRAME_V7 = {
  Init: 1001,
  Walk: 1002,
  Stand: 1003,
  TalkStart: 1004,
  TalkStop: 1005,
} as const;

/** Builds an `animateActor` argument for one of the reserved commands. */
export function packAnimateActor(command: number, direction = 0): number {
  return (command & 0xfc) | (direction & 3);
}

/**
 * Where a SCUMM script parks an actor it wants out of sight.
 *
 * Nothing in the interpreter writes it; games do, when a character has to
 * exist but not be seen. It matters here because a report that does not know
 * the value describes a hidden actor as one at a wild position, and a room
 * whose entry script hides the player looks identical to one that failed to
 * place them at all.
 */
export const OFF_SCREEN_POSITION = -32000;

/**
 * The four destinations the `print` family can send a line to.
 *
 * They are four different mechanisms, not four styles of the same one, which
 * is why the number has to be carried rather than inferred from the text:
 *
 *   Speech   the line an actor or the narrator says, which expires on a timer
 *   Painted  a string written into the picture and left there
 *   Debug    a note to whoever was building the game, never shown to a player
 *   System   a dialogue the interpreter puts up and waits on
 *
 * Every SCUMM version has all four; they differ only in how a script names
 * one. (`ScummEngine::printString`, whose four cases these are.)
 */
export const TEXT_SLOT = { Speech: 0, Painted: 1, Debug: 2, System: 3 } as const;

/** How many slots the `print` family has, each remembering its own settings. */
export const TEXT_SLOT_COUNT = 4;

/**
 * The actor numbers v3-v5 use to mean "not an actor, a text slot".
 *
 * v6 gives each slot an instruction of its own; v3, v4 and v5 have one `print`
 * and overload its actor operand, so 254 is not actor 254 — it is the painted
 * slot. Read as an actor, the line is laid out as speech for somebody who does
 * not exist and then expires, which is what happens to Loom's opening menu:
 * PRACTICE, STANDARD and EXPERT are each drawn, each replaced by the next, and
 * the three boxes are left empty. (`ScummEngine_v5::decodeParseString`.)
 */
export const TEXT_SLOT_FOR_ACTOR: Readonly<Record<number, number>> = {
  252: TEXT_SLOT.System,
  253: TEXT_SLOT.Debug,
  254: TEXT_SLOT.Painted,
};

export const NUM_SCRIPT_SLOTS = 80;
export const NUM_SCRIPT_LOCALS = 25;
export const NUM_SENTENCE_SLOTS = 6;

/** The engine's nominal tick rate; SCUMM was authored against 60 Hz timers. */
export const TICKS_PER_SECOND = 60;
/** Frames per second the main loop targets. */
export const TARGET_FPS = 60;
