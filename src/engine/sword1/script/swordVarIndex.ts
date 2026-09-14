/**
 * Named access to Broken Sword's globals, resolved from the generated names.
 *
 * A lookup rather than a second table of numbers, and that is the point: the
 * engine says `SV.SCREEN` and the number comes from
 * `SWORD1_SCRIPT_VAR_NAMES`, which is generated. So there is exactly one place
 * a variable's index is written down, and a name the generated table does not
 * have fails at module load rather than silently reading global 0 — which is
 * `RETURN_VALUE`, the one global whose wrong value is least visible.
 */

import { SWORD1_SCRIPT_VAR_NAMES } from './scriptVars.js';

const INDEX = new Map<string, number>();
SWORD1_SCRIPT_VAR_NAMES.forEach((name, at) => {
  // First wins. The generated list has no duplicates today; if Revolution's
  // enum ever aliases two names to one slot, the earlier one is the one the
  // engine's own code was written against.
  if (!INDEX.has(name)) INDEX.set(name, at);
});

function need(name: string): number {
  const at = INDEX.get(name);
  if (at === undefined) {
    throw new Error(
      `Broken Sword has no script variable called ${name}. The generated name table in ` +
        `scriptVars.ts is what defines them, so either the name is misspelled here or the ` +
        `table was regenerated against a ScummVM whose enum changed.`,
    );
  }
  return at;
}

/** The globals the engine itself reads or writes, by name. */
export const SV = {
  RETURN_VALUE: need('RETURN_VALUE'),
  RETURN_VALUE_2: need('RETURN_VALUE_2'),
  RETURN_VALUE_3: need('RETURN_VALUE_3'),
  RETURN_VALUE_4: need('RETURN_VALUE_4'),
  DEFAULT_ICON_TEXT: need('DEFAULT_ICON_TEXT'),
  MENU_LOOKING: need('MENU_LOOKING'),
  TOP_MENU_DISABLED: need('TOP_MENU_DISABLED'),
  GEORGE_WALKING: need('GEORGE_WALKING'),
  MEGA_ON_GRID: need('MEGA_ON_GRID'),
  REROUTE_GEORGE: need('REROUTE_GEORGE'),
  WALK_FLAG: need('WALK_FLAG'),
  TARGET_X: need('TARGET_X'),
  TARGET_Y: need('TARGET_Y'),
  NEW_SCREEN: need('NEW_SCREEN'),
  CUR_ID: need('CUR_ID'),
  MOUSE_STATUS: need('MOUSE_STATUS'),
  GEORGE_HOLDING_PIECE: need('GEORGE_HOLDING_PIECE'),
  PALETTE: need('PALETTE'),
  NEW_PALETTE: need('NEW_PALETTE'),
  MOUSE_X: need('MOUSE_X'),
  MOUSE_Y: need('MOUSE_Y'),
  SPECIAL_ITEM: need('SPECIAL_ITEM'),
  CLICK_ID: need('CLICK_ID'),
  MOUSE_BUTTON: need('MOUSE_BUTTON'),
  SAFE_X: need('SAFE_X'),
  SAFE_Y: need('SAFE_Y'),
  CHANGE_X: need('CHANGE_X'),
  CHANGE_Y: need('CHANGE_Y'),
  CHANGE_PLACE: need('CHANGE_PLACE'),
  CHANGE_DIR: need('CHANGE_DIR'),
  CHANGE_STANCE: need('CHANGE_STANCE'),
  GEORGE_CDT_FLAG: need('GEORGE_CDT_FLAG'),
  SCROLL_FLAG: need('SCROLL_FLAG'),
  SCROLL_OFFSET_X: need('SCROLL_OFFSET_X'),
  SCROLL_OFFSET_Y: need('SCROLL_OFFSET_Y'),
  MAX_SCROLL_OFFSET_X: need('MAX_SCROLL_OFFSET_X'),
  MAX_SCROLL_OFFSET_Y: need('MAX_SCROLL_OFFSET_Y'),
  FEET_X: need('FEET_X'),
  FEET_Y: need('FEET_Y'),
  SECOND_ITEM: need('SECOND_ITEM'),
  SUBJECT_CHOSEN: need('SUBJECT_CHOSEN'),
  IN_SUBJECT: need('IN_SUBJECT'),
  CURRENT_MUSIC: need('CURRENT_MUSIC'),
  PLAYINGDEMO: need('PLAYINGDEMO'),
  OBJECT_HELD: need('OBJECT_HELD'),
  SCREEN: need('SCREEN'),
  POCKET_1: need('POCKET_1'),
  FINALE_OPTION_FLAG: need('FINALE_OPTION_FLAG'),
} as const;
