/**
 * Which of Broken Sword II's objects are characters, and what art they wear.
 *
 * The same question `sword1/actors.ts` answers, and a different answer, which
 * is why it is a second file (ADR 0036). Sword 1 stamps a type on every
 * compact, so "is this a character?" is one word at a fixed offset. Sword II
 * has no type word anywhere an editor can reach: a character is an object whose
 * local variables happen to contain an `ObjectMega`, at an offset only that
 * object's own code knows.
 *
 * So the evidence is the code. `fnWalk`, `fnStandAt`, `fnMegaTableAnim` and
 * their neighbours take a pointer to an `ObjectMega`, and an object whose
 * script calls one is an object that has one — there is nothing else those
 * opcodes can be pointed at. That is a *derivation from the game's own
 * bytecode* rather than a list transcribed from somewhere, which is the
 * standard ADR 0029 sets for a table this project would otherwise have to
 * invent.
 *
 * `SWORD2_CUR_PLAYER_ID` is Revolution's own constant for the player, and its
 * comment says why it is a constant: object 8 is George, and it is Nico too
 * when the game is playing her.
 */

import type { Sword2Project, Sword2ProjectObject } from '../../authoring/sword2/project.js';
import { sword2OpcodeName } from '../../engine/sword2/script/opcodeNames.js';
import { SWORD2_CUR_PLAYER_ID } from '../../engine/sword2/script/sword2Vars.js';
import { CP } from '../../engine/sword2/script/sword2Tokens.js';
import { sword2Calls, type Sword2Call } from '../../authoring/sword2/calls.js';

/**
 * The opcodes that only make sense pointed at an `ObjectMega`.
 *
 * Deliberately the narrow set. `fnSetValue` also writes through a mega pointer
 * and is left out, because it is pointed at other structures too and would
 * catch objects that are not characters at all.
 */
export const SWORD2_MEGA_OPCODES: readonly string[] = [
  'fnWalk',
  'fnWalkToAnim',
  'fnTurn',
  'fnStandAt',
  'fnStand',
  'fnStandAfterAnim',
  'fnStandAtAnim',
  'fnMegaTableAnim',
  'fnReverseMegaTableAnim',
  'fnWalkToTalkToMega',
  'fnFaceMega',
  'fnFaceXY',
  'fnPassMega',
  'fnSetWalkGrid',
  'fnSetScaling',
  'fnSetStandbyCoords',
];

/** A character, as the evidence an editor shows it by. */
export interface Sword2Actor {
  readonly id: number;
  readonly name: string;
  readonly isPlayer: boolean;
  /** The mega opcodes this object's own code calls, in table order. */
  readonly evidence: readonly string[];
  /** Animation resources its code names, which is the art it is drawn from. */
  readonly animations: readonly number[];
}

/** Every `fnX` this object's code calls, by name. */
function opcodesCalled(object: Sword2ProjectObject): Set<string> {
  const names = new Set<string>();
  for (const instruction of object.instructions) {
    if (instruction.token !== CP.CALL_MCODE) continue;
    const opcode = instruction.operands[0];
    if (opcode !== undefined) names.add(sword2OpcodeName(opcode));
  }
  return names;
}

/**
 * `fnSetValue`'s second parameter is a megaset resource, and a megaset resource
 * is an animation.
 *
 * Two steps, both of them the game's own code rather than a guess:
 *
 * 1. `fnSetValue` writes exactly one field — `ObjectMega::megaset_res`
 *    (`function.cpp`, and `Sword2Logic`'s case 58 pokes `MEGA.MEGASET_RES`).
 *    It has no other effect, so its second argument is *always* a megaset.
 * 2. `Router::standAt` copies `megaset_res` straight into the graphic's
 *    `anim_resource` (`Sword2Logic.fnStandAt`), and `Sword2Screen.frame()`
 *    then draws it as an animation. So the number `fnSetValue` writes is the
 *    resource the renderer later draws the character from.
 *
 * Which is why it must be followed here and cannot be followed by the rule
 * above it: Revolution's `// params:` block calls this one "value to set it
 * to", so `sword2ArgumentKind` reads it as a plain number, correctly — that
 * table is a faithful transcription of the comments and not the place to put
 * an interpretation of them.
 *
 * The cost of not following it was the whole of the owner's complaint. George
 * is object 8, his four megasets are `GeoMega`, `GeoMegaB`, `NicMegaB` and
 * `NicMegaC`, and every one of them is pushed as a literal — so the player's
 * 1,730 frames of art were sitting in the project, reachable only by typing a
 * raw resource number into the Animations list, while his own page said there
 * was nothing to export.
 */
const MEGASET_SETTER = 'fnSetValue';
/** Which of `fnSetValue`'s parameters is the megaset, in push order. */
const MEGASET_ARGUMENT = 1;

/**
 * The animation resources an object's code names, filtered to ones we hold.
 *
 * Through `sword2Calls` rather than off raw pushes: a pushed integer is a
 * resource id only where the opcode's own `// params:` block says so — or
 * where {@link MEGASET_SETTER} says so, which is the one case the block's own
 * wording hides — and the project's animation list is the second half of the
 * check. A number that matches nothing is not offered, because an editor that
 * showed a made-up picture for an object would be worse than one that showed
 * none.
 */
export function sword2ObjectAnimations(
  sword2: Sword2Project,
  object: Sword2ProjectObject,
  calls: readonly Sword2Call[] = sword2Calls(object.instructions, object.entries),
): number[] {
  const held = new Set(sword2.animations.map((animation) => animation.resource));
  const found: number[] = [];
  for (const call of calls) {
    for (const argument of call.arguments) {
      const isMegaset = call.name === MEGASET_SETTER && argument.index === MEGASET_ARGUMENT;
      // `push === 'int'` as well as the kind: a resource id pushed from a
      // variable is decided at run time, and reading the variable's *number*
      // as a resource id would draw whichever animation shares that number.
      if (!isMegaset && argument.kind !== 'resource') continue;
      if (argument.push !== 'int') continue;
      if (!held.has(argument.value)) continue;
      if (!found.includes(argument.value)) found.push(argument.value);
    }
  }
  return found;
}

/**
 * Every character in the project, the player first.
 *
 * An object with no mega opcode in it is not here even when it walks on screen:
 * a mega driven entirely by another object's script would be missed, and the
 * surface says as much rather than claiming the list is the whole cast.
 */
export function sword2Actors(sword2: Sword2Project): Sword2Actor[] {
  const actors: Sword2Actor[] = [];
  for (const object of sword2.objects) {
    const called = opcodesCalled(object);
    const evidence = SWORD2_MEGA_OPCODES.filter((name) => called.has(name));
    if (evidence.length === 0) continue;
    actors.push({
      id: object.id,
      name: object.name,
      isPlayer: object.id === SWORD2_CUR_PLAYER_ID,
      evidence,
      animations: sword2ObjectAnimations(sword2, object),
    });
  }
  actors.sort((left, right) => Number(right.isPlayer) - Number(left.isPlayer));
  return actors;
}
