/**
 * Which script plays a Broken Sword sprite, and at what rate.
 *
 * `docs/editor-parity.md` row 18 was a No in both Sword families, and §18a said
 * why: a sprite resource carries frames and no timing, so "a preview loop would
 * have to pick a rate, and a preview playing at an invented speed teaches an
 * author something false about their own game". That is still true of the
 * *resource*. It is not true of the *game*: the rate is in the script, and so
 * is the frame order, and both are already in this project.
 *
 * ## What a Sword 1 animation actually is
 *
 * Two resources and a script line. `fnAnim(cdt, spr)` puts the compact into
 * `ANIM` mode with `o_resource = spr` and `o_anim_resource = cdt`; from then on
 * `SwordLogic.animDriver` runs once a game cycle, reads entry `o_anim_pc` of
 * the `cdt` table, sets `o_frame` from its third word, and adds one to
 * `o_anim_pc` until it reaches the table's count. So:
 *
 * - the **order** is the `cdt` table's frame column (`Sword1ProjectAnimTable`);
 * - the **rate** is one entry a game cycle, and a game cycle is
 *   `SWORD1_TICKS_PER_STEP` sixtieths of a second — twelve a second.
 *
 * Neither number is chosen here. Both are read out of the game.
 *
 * `fnAnim(cdt, 0)` is the third piece: `cdt` then names an eight-entry
 * `AnimSet` indexed by the mega's *current direction*, so one script line
 * animates a mega whichever way it is facing. Which of the eight plays is a
 * run-time fact, so all eight are offered and none is picked — the panel lists
 * them as "facing 0" … "facing 7" rather than guessing at a heading.
 *
 * ## What is refused, and why the count is the result
 *
 * A `cdt` or a `spr` pushed from a variable is never followed: commit
 * `0600015`'s rule, and here it would play some other sprite's animation at
 * this one's panel. `fnSetFrame` and `fnFullSetFrame` are not players — they
 * park one frame and imply no rate. A sprite no script names as a literal gets
 * the sentence saying so where the button would be.
 */

import { SWORD1_TICKS_PER_STEP } from '../../engine/sword1/SwordEngine.js';
import { SWORD1_PLAY_CALLS, sword1Calls } from '../../authoring/sword1/calls.js';
import type { Sword1Project } from '../../authoring/sword1/project.js';
import type { SwordPlayback } from '../swordPictureView.js';

/** One game cycle in milliseconds, at the sixty-a-second tick both Swords run. */
export const SWORD1_CYCLE_MS = (SWORD1_TICKS_PER_STEP * 1000) / 60;

/** Why a sprite has no preview, in the author's terms. */
export const SWORD1_NO_PLAYER =
  'No script in this project plays this sprite, so there is no rate to play it at. A Broken ' +
  'Sword sprite resource carries frames and no timing: the order and the speed both come from ' +
  'the fnAnim call that names it, and nothing here names this one as a constant. Rather than ' +
  'loop it at a speed chosen here — which would teach you something false about your own game ' +
  '— the button is not offered.';

/** One way a script plays one sprite. */
export interface Sword1PlayerCall {
  /** The script module the call is in, and the word index of the call. */
  readonly module: number;
  readonly at: number;
  /** `fnAnim`, `fnFullAnim` or `fnISpeak`. */
  readonly opcode: string;
  /** The `cdt` table whose frame column is the order. */
  readonly table: number;
  /** The direction set it was reached through, and which of the eight. */
  readonly via: { readonly set: number; readonly direction: number } | null;
}

/**
 * Every `(table, sprite)` pair the demo's scripts state, direction sets resolved.
 *
 * Built once per call rather than cached on the project: it is a few thousand
 * calls over a whole install, and a cache keyed on a document the editor mutates
 * is a cache that goes stale on the first undo.
 */
export function sword1Players(sword1: Sword1Project): Map<number, Sword1PlayerCall[]> {
  const sets = new Map((sword1.animSets ?? []).map((set) => [set.resource, set]));
  const players = new Map<number, Sword1PlayerCall[]>();
  const add = (sprite: number, call: Sword1PlayerCall): void => {
    if (!sprite) return;
    const list = players.get(sprite) ?? [];
    list.push(call);
    players.set(sprite, list);
  };

  for (const script of sword1.scripts) {
    for (const call of sword1Calls(script.instructions, script.entries)) {
      const player = SWORD1_PLAY_CALLS[call.name];
      if (!player) continue;
      const cdt = call.arguments[player.cdt];
      const spr = call.arguments[player.spr];
      // Both as literals or neither: a value pushed from a variable is decided
      // at run time, and following it would name the wrong resource.
      if (!cdt || !spr || cdt.push !== 'number' || spr.push !== 'number') continue;
      if (cdt.value === 0) continue;
      const base = { module: script.resource, at: call.at, opcode: call.name };
      if (spr.value !== 0) {
        add(spr.value, { ...base, table: cdt.value, via: null });
        continue;
      }
      const set = sets.get(cdt.value);
      if (!set) continue;
      set.entries.forEach((entry, direction) => {
        if (!entry.table || !entry.sprite) return;
        add(entry.sprite, {
          ...base,
          table: entry.table,
          via: { set: set.resource, direction },
        });
      });
    }
  }
  return players;
}

/** Every animation of one sprite the scripts name, in a stable order. */
export function sword1SpritePlaybacks(
  sword1: Sword1Project,
  resource: number,
): { playbacks: SwordPlayback[]; refusal: string | null } {
  const tables = new Map((sword1.animTables ?? []).map((table) => [table.resource, table]));
  const calls = sword1Players(sword1).get(resource) ?? [];
  const playbacks: SwordPlayback[] = [];
  const seen = new Set<number>();

  for (const call of calls) {
    if (seen.has(call.table)) continue;
    const table = tables.get(call.table);
    if (!table || table.frames.length === 0) continue;
    seen.add(call.table);
    playbacks.push({
      label: call.via
        ? `${call.opcode} facing ${call.via.direction}`
        : `${call.opcode} 0x${call.table.toString(16)}`,
      frames: table.frames,
      frameMs: SWORD1_CYCLE_MS,
      why:
        `${table.frames.length} frames at one a game cycle — twelve a second, the rate ` +
        `SwordLogic's anim driver runs at. The order is animation table ` +
        `0x${call.table.toString(16)}, named by ${call.opcode} in script module ` +
        `0x${call.module.toString(16)}` +
        (call.via
          ? `, through direction set 0x${call.via.set.toString(16)} entry ${call.via.direction}.`
          : '.'),
    });
  }

  return { playbacks, refusal: playbacks.length === 0 ? SWORD1_NO_PLAYER : null };
}
