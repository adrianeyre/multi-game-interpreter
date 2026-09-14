/**
 * Broken Sword II's global variables: where they live, and the named ones.
 *
 * ## The globals come out of the game, which is the interesting part
 *
 * Sword1 carries 1,179 globals in its interpreter and a generated table of
 * their names (`scriptVars.ts`). Sword2 does not: **resource 1 is a
 * `GLOBAL_VAR_FILE`** and the variable block inside it *is* the globals. So the
 * count comes from the game's own resource, a save is a copy of that block, and
 * nothing here has to be generated.
 *
 * What is still interpreter knowledge is the handful of *indexes the engine
 * itself* reads or writes — `ID`, `RESULT`, `MOUSE_X`, and so on. Those are
 * below, transcribed from `defs.h`, and they are the only global numbers this
 * project needs to know: every other global is a number the scripts agree on
 * among themselves.
 *
 * That asymmetry between the two families is worth stating because it looks
 * like an inconsistency and is not: it follows from where each engine put its
 * state, and it is one more reason they are two families rather than one.
 */

/** The globals the engine reads or writes, by name. From `defs.h`. */
export const SV2 = {
  /** The object currently being processed. Written every object, every cycle. */
  ID: 0,
  /** Where an opcode leaves an answer for the script. */
  RESULT: 1,
  PLAYER_ACTION: 2,
  MOUSE_X: 4,
  MOUSE_Y: 5,
  IN_SUBJECT: 6,
  COMBINE_BASE: 7,
  SPEECH_ID: 9,
  INS1: 10,
  INS2: 11,
  INS3: 12,
  TALK_FLAG: 13,
  OBJECT_HELD: 14,
  CHOOSER_COUNT_FLAG: 15,
  INS_COMMAND: 59,
  INS4: 60,
  INS5: 61,
  LOCATION: 62,
  LEFT_BUTTON: 109,
  RIGHT_BUTTON: 110,
  PLAYER_FEET_X: 141,
  PLAYER_FEET_Y: 142,
  CLICKED_ID: 178,
  PLAYER_ID: 305,
  SCROLL_X: 345,
  SCROLL_Y: 346,
  MOUSE_AVAILABLE: 686,
  EXIT_CLICK_ID: 710,
  EXIT_FADING: 713,
  PLAYER_CUR_DIR: 937,
  SYSTEM_TESTING_ANIMS: 912,
  AUTO_SELECTED: 1115,
  DEMO: 1153,
  SYSTEM_TESTING_TEXT: 1230,
  SYSTEM_WANT_PREVIOUS_LINE: 1245,
  DEAD: 1256,
  SPEECHANIMFLAG: 1278,
  SCROLL_OFFSET_X: 1314,
} as const;

/**
 * George's object id, which is also Nico's when she is the player.
 *
 * "Always 8 (George object used for Nico player character as well)" — the
 * comment is Revolution's and the sharing is why `CUR_PLAYER_ID` is a constant
 * rather than a global.
 */
export const SWORD2_CUR_PLAYER_ID = 8;

/**
 * The player's two save scripts: the one that hands its structures out, and
 * the one that takes them back.
 *
 * `george_savedata_return` is script 8 and is run by name in ScummVM's restore
 * ("Script no. 8 - 'george_savedata_return' calls fnGetPlayerSaveData",
 * `saveload.cpp:266-271`); script 7 is its twin, the one whose
 * `fnPassPlayerSaveData` the save side reaches. Named here because both the
 * save and the restore paths need them and neither should carry a bare 7.
 */
export const SWORD2_PLAYER_SAVE_DATA = 7;
export const SWORD2_PLAYER_SAVE_RETURN = 8;

/** The resource holding the globals. Read once, at startup. */
export const SWORD2_GLOBAL_VAR_RESOURCE = 1;

/**
 * `id * SIZE` is how a script id names its object.
 *
 * A script id is `objectId * 0x10000 + scriptNumber`, so dividing by this gives
 * the object and masking gives the script — the same shape Sword1 uses for its
 * sections, at a different granularity.
 */
export const SWORD2_SIZE = 0x10000;

/** The object a script id belongs to. */
export function sword2ObjectOf(scriptId: number): number {
  return Math.floor(scriptId / SWORD2_SIZE);
}

/** The script number within that object. */
export function sword2ScriptOf(scriptId: number): number {
  return scriptId & 0xffff;
}

/** The mouse pointer resource the game calls "normal". */
export const SWORD2_NORMAL_MOUSE_ID = 17;

/** The two arrows shown over the strips that scroll a wide room. `defs.h:170-171`. */
export const SWORD2_SCROLL_LEFT_MOUSE_ID = 1440;
export const SWORD2_SCROLL_RIGHT_MOUSE_ID = 1441;

/**
 * The two pointer resources `Mouse::registerMouse` swaps one for the other.
 *
 * "Change all COGS pointers to CROSHAIR. I'm guessing that this was a design
 * decision made in mid-development and they didn't want to go back and
 * re-generate the resource files" — `mouse.cpp:181-186`. The data still says
 * `USE` in places the game shows a crosshair.
 */
export const SWORD2_USE_POINTER = 3100;
export const SWORD2_CROSHAIR_POINTER = 18;
