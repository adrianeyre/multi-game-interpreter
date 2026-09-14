/**
 * Which global a script's variable number means, per Release.
 *
 * ## Why a Release can renumber the globals
 *
 * Broken Sword's globals are not a table in a file the interpreter reads. They
 * are an enum in Revolution's source, and the script compiler resolves a name
 * to its position in that enum at build time. `IT_PUSHVARIABLE 909` is not
 * "the variable called SCREEN"; it is "the 909th slot", and which slot that is
 * depends on the enum the scripts were compiled against.
 *
 * The demo was built before the retail game and its enum is two entries
 * shorter: **1,177 globals against retail's 1,179**. Two variables were
 * inserted later, so every demo number at or above the first insertion is one
 * lower than the retail number for the same variable, and every number at or
 * above the second is two lower. Running the demo's scripts against retail
 * numbering is not a small error — `SCREEN` becomes a room flag, the script
 * that tests it never fires, and the object it was guarding never appears.
 *
 * ## How the two insertion points were measured
 *
 * The demo ships `RESTART.BIN`, which is its own new-game world: 4,708 bytes,
 * 1,177 little-endian 32-bit words, 95 of them non-zero. `SWORD1_SCRIPT_VAR_INIT`
 * is the retail new-game world and has 95 non-zero entries too. Expanding the
 * demo's file through the map below reproduces the retail table **95 pairs out
 * of 95, with no non-zero word left over** — which is what `sword1-vars.test.ts`
 * asserts against the install. Shifting by nothing matches 15 of 95; shifting
 * everything by two matches 78.
 *
 * The retail screen-name constants are the corroboration: `CAFE_BOMBED` = 1
 * through `SECRET_CRYPT` = 74 is a ramp of 74 consecutive values, retail
 * 1058..1126, and it sits at demo 1056..1124.
 *
 * ## What the evidence does not pin down
 *
 * The measurements bracket the insertions rather than locating them: the first
 * is somewhere in retail 298..397 and the second in retail 607..700, because
 * neither range holds a non-zero starting value to align on. This module puts
 * them at the top of each range. That choice cannot change what the game does —
 * the map is injective either way, scripts read and write through the same map,
 * and every global the engine itself names (`swordVarIndex.ts`) is at retail
 * 297 or below, or 895 or above, so none of them is in an unresolved range. It
 * changes only which name a listing prints for a variable in those ranges, and
 * `sword1ScriptVarName` already answers `var<n>` for the unnamed tail.
 */

import { SWORD1_NUM_SCRIPT_VARS } from './scriptVars.js';

/** How many globals the demo's scripts were compiled against. */
export const SWORD1_DEMO_NUM_SCRIPT_VARS = 1177;

/**
 * The retail slots the two later insertions took.
 *
 * Each is the *lowest* slot the evidence leaves open in its range; see the
 * module comment for why the choice is free.
 */
export const SWORD1_DEMO_INSERTIONS: readonly number[] = [397, 700];

/**
 * A Release's script-variable numbering, as a translation to retail numbering.
 *
 * The engine keeps its globals in retail numbering whatever it is running, so
 * that `SV.SCREEN` means one thing everywhere and a saved game holds the same
 * array shape for every Release. This is the only place that changes.
 */
export interface SwordVarLayout {
  /** How many globals this Release's scripts address. */
  readonly count: number;
  /** Script number → retail number. Indexed by the script's own number. */
  readonly toRetail: Int32Array;
  /** True when nothing is translated, so a caller can skip the work. */
  readonly identity: boolean;
}

function build(count: number, insertions: readonly number[]): SwordVarLayout {
  const toRetail = new Int32Array(count);
  for (let script = 0; script < count; script++) {
    let retail = script;
    for (const at of insertions) if (retail >= at) retail++;
    toRetail[script] = retail;
  }
  return { count, toRetail, identity: insertions.length === 0 };
}

/** Retail numbering: the identity, and what every non-demo Release uses. */
export const SWORD1_RETAIL_VAR_LAYOUT: SwordVarLayout = build(SWORD1_NUM_SCRIPT_VARS, []);

/** The demo's numbering: 1,177 slots, two fewer than retail. */
export const SWORD1_DEMO_VAR_LAYOUT: SwordVarLayout = build(
  SWORD1_DEMO_NUM_SCRIPT_VARS,
  SWORD1_DEMO_INSERTIONS,
);

/** The layout a Release uses. */
export function sword1VarLayout(release: string): SwordVarLayout {
  return release === 'demo' ? SWORD1_DEMO_VAR_LAYOUT : SWORD1_RETAIL_VAR_LAYOUT;
}

/**
 * Expands a `RESTART.BIN` written in `layout`'s numbering into retail numbering.
 *
 * The file is the game's own new-game world and is the thing the measurement in
 * the module comment is made against.
 */
export function sword1ExpandRestartBin(bytes: Uint8Array, layout: SwordVarLayout): Int32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const words = Math.floor(bytes.byteLength / 4);
  const out = new Int32Array(SWORD1_NUM_SCRIPT_VARS);
  for (let script = 0; script < words; script++) {
    const retail = layout.toRetail[script] ?? script;
    if (retail < out.length) out[retail] = view.getInt32(script * 4, true);
  }
  return out;
}
