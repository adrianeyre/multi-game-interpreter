/**
 * A Broken Sword script read as *calls*, which is how a person edits one.
 *
 * `disassemble.ts` gives instructions, and an instruction listing is the wrong
 * unit of work for an author: `IT_PUSHNUMBER 384`, `IT_PUSHNUMBER 216`,
 * `IT_PUSHNUMBER 3`, `IT_PUSHNUMBER 0`, `IT_MCODE 69 4` is one thing happening
 * — George walks to (384, 216) facing down — spread over five rows of numbers
 * with nothing saying which number is the direction. The SCUMM side solved this
 * years ago by editing *actions* rather than bytes, and this is the same move
 * for this family.
 *
 * ## The grouping is read from the bytecode, not guessed
 *
 * `IT_MCODE` carries the mcode number **and its argument count**, and the
 * arguments were pushed by the instructions immediately before it. So a call is
 * the mcode plus the `count` instructions preceding it — provided each of those
 * is a plain push. When one is not (an argument computed with `IT_PLUS`, say,
 * or a `SKIP` landing between them), the arguments cannot be attributed to
 * single instructions and the call is reported as one whose arguments are
 * computed. That is a real category, not a parse failure: the listing still
 * shows every instruction, and only the named-operand view is withheld.
 *
 * Two rules keep this honest:
 *
 * - A push is never claimed twice, and the walk gets that for free rather than
 *   by bookkeeping: the call that claimed it sits between it and any later
 *   call, and an `IT_MCODE` is not a push, so the later call's run ends there.
 * - A jump target landing inside a claimed run would make the grouping wrong,
 *   so any instruction that is a jump destination ends the run.
 *
 * ## What the names come from
 *
 * `SWORD1_MCODE_PARAMS`, which is generated from the mcode definitions in
 * ScummVM's `logic.cpp` (ADR 0029). The *kind* of an argument — whether the
 * editor shows a screen picker or a plain number — is derived here from that
 * generated name by a rule list. The rules are ours; the names are not.
 */

import { IT } from '../../engine/sword1/script/swordTokens.js';
import { sword1McodeName } from '../../engine/sword1/script/mcodeNames.js';
import { SWORD1_MCODE_PARAMS } from '../../engine/sword1/script/mcodeParams.js';
import type { Sword1Instruction } from './disassemble.js';

/**
 * What an argument *is*, which decides the editor shown for it.
 *
 * Derived from the generated parameter name by `sword1ArgumentKind`. `number`
 * is the honest default and the commonest answer: most of Broken Sword's
 * arguments are counts, flags and speeds with nothing to pick from.
 */
export type Sword1ArgumentKind =
  | 'number'
  | 'screen'
  | 'text'
  | 'script'
  | 'object'
  | 'sequence'
  | 'sound'
  | 'music'
  | 'resource'
  | 'direction'
  | 'coordinate';

/** How the argument reached the stack, which decides what an edit writes. */
export type Sword1PushKind = 'number' | 'variable' | 'longOffset' | 'wordOffset';

/** The four tokens that push exactly one value and consume none. */
const PUSH_KINDS: ReadonlyMap<number, Sword1PushKind> = new Map([
  [IT.PUSHNUMBER, 'number'],
  [IT.PUSHVARIABLE, 'variable'],
  [IT.PUSHLONGOFFSET, 'longOffset'],
  [IT.PUSHWORDOFFSET, 'wordOffset'],
]);

/**
 * The rule list that turns a generated parameter name into an editor.
 *
 * Ours, and deliberately small: each entry is a name the generator emits and
 * what an author would want to pick from when changing it. A name with no rule
 * falls through to `number`, which is a working editor and not a gap.
 */
const ARGUMENT_KINDS: ReadonlyMap<string, Sword1ArgumentKind> = new Map<string, Sword1ArgumentKind>(
  [
    ['screen', 'screen'],
    ['oldScreen', 'screen'],
    ['textNo', 'text'],
    ['script', 'script'],
    ['instruc', 'script'],
    ['target', 'object'],
    ['targetId', 'object'],
    ['tar', 'object'],
    ['objectNo', 'object'],
    ['sendId', 'object'],
    ['sequenceId', 'sequence'],
    ['fxNo', 'sound'],
    ['tuneId', 'music'],
    ['resId', 'resource'],
    ['anim', 'resource'],
    ['graphic', 'resource'],
    ['cdt', 'resource'],
    ['spr', 'resource'],
    ['walk_data', 'resource'],
    ['spritePal', 'resource'],
    ['dir', 'direction'],
    ['x', 'coordinate'],
    ['y', 'coordinate'],
  ],
);

/** `'direction'` for `dir`, `'number'` for a name with no rule or no name. */
export function sword1ArgumentKind(name: string | null): Sword1ArgumentKind {
  return (name && ARGUMENT_KINDS.get(name)) || 'number';
}

/** One argument of one call, with where its value is written back. */
export interface Sword1CallArgument {
  /** Its position in the call, which is its index into the generated row. */
  readonly index: number;
  /** The generated name, or null where ScummVM's source has a placeholder. */
  readonly name: string | null;
  /** What to call it on screen: the name, or `argument 3`. */
  readonly label: string;
  readonly kind: Sword1ArgumentKind;
  /** The pushing instruction's word index — where an edit is written. */
  readonly at: number;
  readonly push: Sword1PushKind;
  /** The pushed word: a literal, a variable number or a compact offset. */
  readonly value: number;
}

/** One `IT_MCODE` and the pushes that fed it. */
export interface Sword1Call {
  /** The mcode instruction's word index. */
  readonly at: number;
  readonly mcode: number;
  readonly name: string;
  /** The count the instruction carries. */
  readonly count: number;
  /**
   * The located arguments — empty when they could not be attributed.
   *
   * Never partially filled: either every argument is a plain push or none is
   * offered, because an editor that names three arguments out of four has
   * numbered them wrong.
   */
  readonly arguments: readonly Sword1CallArgument[];
  /** Word indexes of the pushes this call claims, so a listing can fold them. */
  readonly consumes: readonly number[];
  /** Why the arguments were not attributed, or null when they were. */
  readonly trouble: string | null;
}

/** Every word a jump or a switch can land on, which ends an argument run. */
function jumpTargets(instructions: readonly Sword1Instruction[]): Set<number> {
  const targets = new Set<number>();
  for (const instruction of instructions) {
    if (
      instruction.token === IT.SKIP ||
      instruction.token === IT.SKIPONFALSE ||
      instruction.token === IT.SKIPONTRUE
    ) {
      targets.add(instruction.at + 1 + instruction.operands[0]);
    } else if (instruction.token === IT.SWITCH) {
      for (let index = 1; index < instruction.operands.length; index += 2) {
        const delta = instruction.operands[index + 1];
        if (delta !== undefined) targets.add(instruction.at + 1 + index + delta);
      }
      const last = instruction.operands.length - 1;
      if (last >= 1 && (last - 1) % 2 === 0) {
        targets.add(instruction.at + 1 + last + instruction.operands[last]);
      }
    }
  }
  return targets;
}

/**
 * Groups a script's instructions into calls.
 *
 * `entries` are the module's script entry points: an entry inside a run of
 * pushes means a script *starts* there, so the pushes before it belong to a
 * different script and the run ends.
 */
export function sword1Calls(
  instructions: readonly Sword1Instruction[],
  entries: readonly number[] = [],
): Sword1Call[] {
  const targets = jumpTargets(instructions);
  for (const entry of entries) targets.add(entry);

  const calls: Sword1Call[] = [];

  for (let index = 0; index < instructions.length; index++) {
    const instruction = instructions[index];
    if (instruction.token !== IT.MCODE) continue;
    const mcode = instruction.operands[0];
    const count = instruction.operands[1];
    const name = sword1McodeName(mcode);
    const params = SWORD1_MCODE_PARAMS[mcode] ?? [];

    if (count === 0) {
      calls.push({
        at: instruction.at,
        mcode,
        name,
        count,
        arguments: [],
        consumes: [],
        trouble: null,
      });
      continue;
    }

    const pushes: Sword1Instruction[] = [];
    let trouble: string | null = null;
    // The word the walk is standing on. Stepping back past a jump destination
    // is what must not happen: a script that can arrive *at* this word without
    // running what precedes it has not necessarily pushed those arguments.
    let boundary = instruction.at;
    for (let back = 1; back <= count; back++) {
      const candidate = instructions[index - back];
      if (!candidate) {
        trouble = `it wants ${count} arguments and only ${back - 1} instructions precede it`;
        break;
      }
      if (targets.has(boundary)) {
        trouble =
          `word ${boundary} can be jumped to, so the instructions before it are not ` +
          `reliably this call's arguments`;
        break;
      }
      const push = PUSH_KINDS.get(candidate.token);
      if (!push) {
        trouble = `argument ${count - back} is computed at run time rather than pushed as a value`;
        break;
      }
      pushes.push(candidate);
      boundary = candidate.at;
    }

    if (trouble) {
      calls.push({ at: instruction.at, mcode, name, count, arguments: [], consumes: [], trouble });
      continue;
    }

    pushes.reverse();
    const args = pushes.map((push, at): Sword1CallArgument => {
      const named = params[at];
      const label = named ? named : `argument ${at}`;
      return {
        index: at,
        name: named ? named : null,
        label,
        kind: sword1ArgumentKind(named ? named : null),
        at: push.at,
        push: PUSH_KINDS.get(push.token) as Sword1PushKind,
        value: push.operands[0],
      };
    });
    calls.push({
      at: instruction.at,
      mcode,
      name,
      count,
      arguments: args,
      consumes: pushes.map((push) => push.at),
      trouble: null,
    });
  }

  return calls;
}

/** The calls indexed by their mcode instruction's word, for a listing. */
export function sword1CallsByWord(calls: readonly Sword1Call[]): Map<number, Sword1Call> {
  return new Map(calls.map((call) => [call.at, call]));
}

/** Every word a call has folded into itself, so a listing skips those rows. */
export function sword1ConsumedWords(calls: readonly Sword1Call[]): Set<number> {
  const consumed = new Set<number>();
  for (const call of calls) for (const at of call.consumes) consumed.add(at);
  return consumed;
}

/**
 * The mcodes that *play* a sprite, and which argument names what.
 *
 * Three, and not five. `fnSetFrame` and `fnFullSetFrame` take the same
 * `(cdt, spr)` pair and park a single frame: they state a pose and imply no
 * rate at all, so counting them here would be counting a still picture as an
 * animation. Each of the three below hands the compact to a driver that
 * advances `o_anim_pc` by exactly one a game cycle — `animDriver`,
 * `fullAnimDriver` and `speechDriver` in `SwordLogic` — which is where the
 * editor's preview gets its rate from rather than inventing one.
 */
export const SWORD1_PLAY_CALLS: Readonly<
  Record<string, { readonly cdt: number; readonly spr: number }>
> = {
  fnAnim: { cdt: 0, spr: 1 },
  fnFullAnim: { cdt: 0, spr: 1 },
  fnISpeak: { cdt: 0, spr: 2 },
};
