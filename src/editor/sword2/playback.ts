/**
 * Which object's script plays a Broken Sword II animation, and at what rate.
 *
 * The companion to `sword1/playback.ts`, against a different encoding and a
 * different shape of animation — ADR 0036, and the two share the widget and no
 * record. Where a Sword 1 sprite needs a second resource to say what order its
 * frames go in, a Sword II animation carries its own frame table in its own
 * header, so the script's job here is smaller and more specific: it says
 * *whether* the animation is played at all, and in which direction.
 *
 * `Sword2Logic.doAnimate` is the whole of it. `fnAnim` puts `ANIM_PC` at 0 and
 * adds one a game cycle until it reaches `noAnimFrames`; `fnReverseAnim` starts
 * at the last frame and subtracts one. A game cycle is
 * `SWORD2_TICKS_PER_STEP` sixtieths of a second — twelve a second, the same
 * rate Sword 1 runs at and, like it, read out of the engine rather than chosen.
 *
 * ## What is refused
 *
 * - **A resource pushed from a variable.** Commit `0600015`'s rule: that number
 *   is decided at run time, and following it would play a different animation.
 * - **`fnMegaTableAnim` and `fnReverseMegaTableAnim`.** They are handed a
 *   *table* of animations and pick one by the mega's current direction. Which
 *   one is a run-time fact, and this project will not pick for it. On the demo
 *   that is 595 of the play calls, which is why the count of animations with a
 *   named player is as small as it is — and a small number honestly measured is
 *   the result row 18 asks for.
 * - **`fnSetFrame`, `fnStandAfterAnim`, `fnWalkToAnim`.** They park or aim at a
 *   single frame and imply no rate at all.
 */

import { SWORD2_TICKS_PER_STEP } from '../../engine/sword2/Sword2Engine.js';
import { SWORD2_INS } from '../../engine/sword2/script/Sword2Logic.js';
import { sword2Calls } from '../../authoring/sword2/calls.js';
import type { Sword2Project } from '../../authoring/sword2/project.js';
import type { SwordPlayback } from '../swordPictureView.js';

/** One game cycle in milliseconds, at the sixty-a-second tick the engine runs. */
export const SWORD2_CYCLE_MS = (SWORD2_TICKS_PER_STEP * 1000) / 60;

/** Why an animation has no preview, in the author's terms. */
export const SWORD2_NO_PLAYER =
  'No object in this project plays this animation by name, so there is no rate to play it at. ' +
  'Two thirds of Broken Sword II’s play calls are fnMegaTableAnim, which is handed a table and ' +
  'picks an animation by the mega’s direction while the game runs — this project will not pick ' +
  'one for it, and it will not loop these frames at a speed chosen here, because a preview at ' +
  'an invented speed teaches you something false about your own game.';

/** How the pair of opcodes name their animation, and which way they run it. */
const PLAY_OPCODES: Readonly<Record<string, boolean>> = {
  fnAnim: false,
  fnReverseAnim: true,
};

/** The two speech-script commands that are those same two opcodes. */
const PLAY_COMMANDS: Readonly<Record<number, boolean>> = {
  [SWORD2_INS.ANIM]: false,
  [SWORD2_INS.REVERSE_ANIM]: true,
};

/** One way an object plays one animation. */
export interface Sword2PlayerCall {
  readonly object: number;
  readonly name: string;
  /** The call's byte offset in that object's code. */
  readonly at: number;
  readonly opcode: string;
  readonly reverse: boolean;
}

/** Every animation the demo's objects name as a constant, and who names it. */
export function sword2Players(sword2: Sword2Project): Map<number, Sword2PlayerCall[]> {
  const players = new Map<number, Sword2PlayerCall[]>();
  const add = (resource: number, call: Sword2PlayerCall): void => {
    if (!resource) return;
    const list = players.get(resource) ?? [];
    list.push(call);
    players.set(resource, list);
  };

  for (const object of sword2.objects) {
    for (const call of sword2Calls(object.instructions, object.entries)) {
      const base = { object: object.id, name: object.name, at: call.at, opcode: call.name };
      const reverse = PLAY_OPCODES[call.name];
      if (reverse !== undefined) {
        const resource = call.arguments.find((argument) =>
          /resource id of animation file/i.test(argument.name ?? ''),
        );
        if (resource?.push === 'int') add(resource.value, { ...base, reverse });
        continue;
      }
      if (call.name !== 'fnTheyDo' && call.name !== 'fnTheyDoWeWait') continue;
      // The two take the same list under different leading parameters, so the
      // command is located by name rather than by index: `fnTheyDoWeWait`
      // begins with a pointer to ob_logic and `fnTheyDo` does not.
      const at = call.arguments.findIndex((argument) => argument.name === 'command');
      const command = call.arguments[at];
      const ins1 = call.arguments[at + 1];
      if (!command || !ins1 || command.push !== 'int' || ins1.push !== 'int') continue;
      const viaCommand = PLAY_COMMANDS[command.value];
      if (viaCommand === undefined) continue;
      add(ins1.value, { ...base, reverse: viaCommand });
    }
  }
  return players;
}

/** The previews for one animation: forwards, backwards, or neither. */
export function sword2AnimationPlaybacks(
  sword2: Sword2Project,
  resource: number,
): { playbacks: SwordPlayback[]; refusal: string | null } {
  const animation = sword2.animations.find((candidate) => candidate.resource === resource);
  const calls = sword2Players(sword2).get(resource) ?? [];
  const playbacks: SwordPlayback[] = [];

  if (animation && animation.frames > 0) {
    const forward = Array.from({ length: animation.frames }, (_, index) => index);
    for (const reverse of [false, true]) {
      const players = calls.filter((call) => call.reverse === reverse);
      if (players.length === 0) continue;
      const first = players[0];
      playbacks.push({
        label: reverse ? 'backwards' : 'forwards',
        frames: reverse ? [...forward].reverse() : forward,
        frameMs: SWORD2_CYCLE_MS,
        why:
          `${animation.frames} frames at one a game cycle — twelve a second, the rate ` +
          `Sword2Logic's doAnimate steps ANIM_PC at. Played ${reverse ? 'backwards' : 'forwards'}` +
          ` by ${first.opcode} in ${first.name || `object ${first.object}`}` +
          (players.length > 1 ? ` and ${players.length - 1} more.` : '.'),
      });
    }
  }

  return { playbacks, refusal: playbacks.length === 0 ? SWORD2_NO_PLAYER : null };
}
