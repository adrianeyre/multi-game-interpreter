/**
 * Which of Broken Sword's objects are characters, and what art they wear.
 *
 * The SCUMM surface has an Actors section because SCUMM has an actor table.
 * Broken Sword has no such table: George, Nico and every walking extra are
 * compacts, sitting in the same sections as the doors and the floor patches,
 * and the only thing that separates them is `o_type`. So this is the derivation
 * rather than a list — `MEGA` and `PLAYER` are the two types the interpreter
 * treats as characters, and `SWORD1_PLAYER` is the one compact the scripts
 * address as "the player".
 *
 * Kept out of `Sword1Editor.ts` because it is a fact about the family and not
 * about a panel: `npm test` can check which compacts come back without a DOM.
 */

import type { Sword1Project, Sword1ProjectCompact } from '../../authoring/sword1/project.js';
import { CPT } from '../../engine/sword1/resource/swordCompact.js';
import { SWORD1_PLAYER, SwordType } from '../../engine/sword1/resource/swordDefs.js';
import { sword1CompactWords } from './screenScene.js';

/** A character, as the fields an editor shows it by. */
export interface Sword1Actor {
  readonly id: number;
  readonly section: number;
  readonly index: number;
  /** `SwordType.MEGA` or `SwordType.PLAYER`. */
  readonly type: number;
  /** True for the one compact the scripts call the player. */
  readonly isPlayer: boolean;
  readonly screen: number;
  readonly x: number;
  readonly y: number;
  readonly dir: number;
  /**
   * `o_resource`: the sprite the character is drawn from *right now*.
   *
   * Run-time state, and 0 on every character in a freshly imported project:
   * the scripts write it when a mega walks on. {@link walkResource} is the
   * durable answer to the same question.
   */
  readonly resource: number;
  /** `o_frame`: which frame of it. */
  readonly frame: number;
  /**
   * `o_mega_resource`: walk *geometry*, not art.
   *
   * `Router::setupWalkData` reads a walk-frame count, a turn-frame count and
   * then an x and a y step per direction out of it. There is no resource id
   * anywhere in it, so nothing in it can be drawn.
   */
  readonly megaResource: number;
  /**
   * `o_walk_resource`: the sprite this character stands and walks in.
   *
   * Named for the walk and used for both. `Logic::fnMegaSet` writes it from a
   * parameter its own signature calls `spr`, and `Logic::fnStand` and
   * `Logic::logicArAnimate` both begin `o_resource = o_walk_resource` \u2014 so
   * this, and not {@link resource}, is the word that says what a character
   * looks like on a project nothing has run yet.
   */
  readonly walkResource: number;
}

/** Whether a compact's `o_type` is one the interpreter walks and draws. */
export function sword1IsActor(compact: Sword1ProjectCompact): boolean {
  const words = sword1CompactWords(compact);
  const type = words[CPT.TYPE >> 2] ?? 0;
  return type === SwordType.MEGA || type === SwordType.PLAYER;
}

/**
 * Every character in the project, the player first.
 *
 * The player leads because that is the one an author opens the section to find,
 * and it is the same courtesy the SCUMM sidebar does by marking actor 1.
 */
export function sword1Actors(sword1: Sword1Project): Sword1Actor[] {
  const actors: Sword1Actor[] = [];
  for (const section of sword1.sections) {
    for (const compact of section.compacts) {
      if (!sword1IsActor(compact)) continue;
      const words = sword1CompactWords(compact);
      const word = (offset: number): number => words[offset >> 2] ?? 0;
      actors.push({
        id: compact.id,
        section: compact.section,
        index: compact.index,
        type: word(CPT.TYPE),
        isPlayer: compact.id === SWORD1_PLAYER,
        screen: word(CPT.SCREEN),
        x: word(CPT.XCOORD),
        y: word(CPT.YCOORD),
        dir: word(CPT.DIR),
        resource: word(CPT.RESOURCE),
        frame: word(CPT.FRAME),
        megaResource: word(CPT.MEGA_RESOURCE),
        walkResource: word(CPT.WALK_RESOURCE),
      });
    }
  }
  actors.sort((left, right) => Number(right.isPlayer) - Number(left.isPlayer));
  return actors;
}
