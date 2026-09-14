/**
 * A Broken Sword II object's code read as *calls*.
 *
 * The same move `sword1/calls.ts` makes, against a different encoding and a
 * different source of names. `CP_CALL_MCODE` carries the opcode number and the
 * parameter count, and the parameters were pushed by the instructions before
 * it, so a call is recoverable from the bytecode alone.
 *
 * ## Where the two families genuinely differ
 *
 * - **Names are sentences.** Sword1's are C identifiers (`dir`, `textNo`);
 *   Sword2's come from the `// params:` blocks Revolution wrote, and read
 *   "pointer to object's graphic structure". So a label here is prose, and the
 *   kind rules match on words inside it rather than on an exact identifier.
 * - **Most parameters are pointers.** `CP_PUSH_LOCAL_ADDR` pushes the address
 *   of a structure inside the object's own local variables — an offset only
 *   that object's script knows. Those are shown and not offered as pickers:
 *   there is nothing to pick from, and changing one by hand points a call at a
 *   different structure, which is a thing an author may want to do and must do
 *   with their eyes open.
 * - **A string is an argument.** `CP_PUSH_STRING` pushes one, and it carries
 *   its text rather than a number, so an argument's value is `number | string`
 *   here and `number` there. Collapsing that would mean an editor that shows a
 *   `fnRegisterStartPoint` message as a byte count.
 *
 * Kept separate from Sword1's for ADR 0036's reason: these two families share
 * no bytecode, and a shared grouping function would be the place the two get
 * confused for one.
 */

import { CP } from '../../engine/sword2/script/sword2Tokens.js';
import { sword2OpcodeName } from '../../engine/sword2/script/opcodeNames.js';
import { SWORD2_OPCODE_PARAMS } from '../../engine/sword2/script/opcodeParams.js';
import type { Sword2Instruction } from './disassemble.js';

/** What a parameter is, which decides the editor shown for it. */
export type Sword2ArgumentKind =
  | 'number'
  | 'pointer'
  | 'resource'
  | 'object'
  | 'script'
  | 'text'
  | 'sound'
  | 'music'
  | 'coordinate'
  | 'direction'
  | 'string';

/** How the argument reached the stack. */
export type Sword2PushKind =
  'int' | 'localVar' | 'globalVar' | 'localAddr' | 'structure' | 'string';

/** The tokens that push exactly one value and consume none. */
const PUSH_KINDS: ReadonlyMap<number, Sword2PushKind> = new Map([
  [CP.PUSH_INT32, 'int'],
  [CP.PUSH_LOCAL_VAR32, 'localVar'],
  [CP.PUSH_GLOBAL_VAR32, 'globalVar'],
  [CP.PUSH_LOCAL_ADDR, 'localAddr'],
  [CP.PUSH_DEREFERENCED_STRUCTURE, 'structure'],
  [CP.PUSH_STRING, 'string'],
]);

/**
 * The rule list that turns a description into an editor.
 *
 * Ordered, because the descriptions overlap: "id of walkgrid resource" is a
 * resource and "id of target mega to face" is an object, and both say "id of".
 * First match wins, so the specific patterns come first.
 */
const KIND_RULES: ReadonlyArray<readonly [RegExp, Sword2ArgumentKind]> = [
  [/^(pointer|address) (to|of)\b|^ob_/i, 'pointer'],
  [/encoded text number|\btext\b/i, 'text'],
  [/\bid of fx\b|\bfx\b/i, 'sound'],
  [/\bmusic\b/i, 'music'],
  [/\bscript\b/i, 'script'],
  [/x-coord|y-coord/i, 'coordinate'],
  [/direction/i, 'direction'],
  [
    /res(ource)? id|\bres id\b|resource to|\bres\b|run.?list|walkgrid|animation file|anim table/i,
    'resource',
  ],
  [/ascii message|straight animation/i, 'string'],
  [/\bid of target\b|\brecipient\b|^target$|^id$/i, 'object'],
];

/** `'coordinate'` for "target x-coord", `'number'` where no rule matches. */
export function sword2ArgumentKind(description: string | null): Sword2ArgumentKind {
  if (!description) return 'number';
  for (const [pattern, kind] of KIND_RULES) {
    if (pattern.test(description)) return kind;
  }
  return 'number';
}

/** One parameter of one call, with where its value is written back. */
export interface Sword2CallArgument {
  readonly index: number;
  /** The description from the generated table, or null where none is given. */
  readonly name: string | null;
  /** What to call it on screen: the description, or `parameter 3`. */
  readonly label: string;
  readonly kind: Sword2ArgumentKind;
  /** The pushing instruction's byte offset — where an edit is written. */
  readonly at: number;
  readonly push: Sword2PushKind;
  readonly value: number;
  /** A `CP_PUSH_STRING`'s text, where that is what was pushed. */
  readonly text: string | null;
}

/** One `CP_CALL_MCODE` and the pushes that fed it. */
export interface Sword2Call {
  /** The call instruction's byte offset. */
  readonly at: number;
  readonly opcode: number;
  readonly name: string;
  readonly count: number;
  readonly arguments: readonly Sword2CallArgument[];
  readonly consumes: readonly number[];
  readonly trouble: string | null;
}

/** Every byte offset a jump or a switch can land on. */
function jumpTargets(instructions: readonly Sword2Instruction[]): Set<number> {
  const targets = new Set<number>();
  for (const instruction of instructions) {
    switch (instruction.token) {
      case CP.SKIPONFALSE:
      case CP.SKIPONTRUE:
      case CP.SKIPALWAYS:
        targets.add(instruction.at + 1 + instruction.operands[0]);
        break;
      case CP.SWITCH: {
        const count = instruction.operands[0];
        for (let index = 0; index < count; index++) {
          const delta = instruction.operands[2 + index * 2];
          if (delta !== undefined) targets.add(instruction.at + 5 + index * 8 + delta);
        }
        const fallback = instruction.operands[1 + count * 2];
        if (fallback !== undefined) targets.add(instruction.at + 5 + count * 8 + fallback);
        break;
      }
      case CP.JUMP_ON_RETURNED: {
        const count = instruction.operands[0];
        for (let index = 0; index < count; index++) {
          const delta = instruction.operands[1 + index];
          if (delta !== undefined) targets.add(instruction.at + 2 + delta);
        }
        break;
      }
      default:
        break;
    }
  }
  return targets;
}

/** Groups an object's instructions into calls. */
export function sword2Calls(
  instructions: readonly Sword2Instruction[],
  entries: readonly number[] = [],
): Sword2Call[] {
  const targets = jumpTargets(instructions);
  for (const entry of entries) targets.add(entry);

  const calls: Sword2Call[] = [];

  for (let index = 0; index < instructions.length; index++) {
    const instruction = instructions[index];
    if (instruction.token !== CP.CALL_MCODE) continue;
    const opcode = instruction.operands[0];
    const count = instruction.operands[1];
    const name = sword2OpcodeName(opcode);
    const params = SWORD2_OPCODE_PARAMS[opcode] ?? [];

    if (count === 0) {
      calls.push({
        at: instruction.at,
        opcode,
        name,
        count,
        arguments: [],
        consumes: [],
        trouble: null,
      });
      continue;
    }

    const pushes: Sword2Instruction[] = [];
    let trouble: string | null = null;
    let boundary = instruction.at;
    for (let back = 1; back <= count; back++) {
      const candidate = instructions[index - back];
      if (!candidate) {
        trouble = `it wants ${count} parameters and only ${back - 1} instructions precede it`;
        break;
      }
      if (targets.has(boundary)) {
        trouble =
          `byte ${boundary} can be jumped to, so the instructions before it are not ` +
          `reliably this call's parameters`;
        break;
      }
      const push = PUSH_KINDS.get(candidate.token);
      if (!push) {
        trouble = `parameter ${count - back} is computed at run time rather than pushed as a value`;
        break;
      }
      pushes.push(candidate);
      boundary = candidate.at;
    }

    if (trouble) {
      calls.push({ at: instruction.at, opcode, name, count, arguments: [], consumes: [], trouble });
      continue;
    }

    pushes.reverse();
    const args = pushes.map((push, at): Sword2CallArgument => {
      const described = params[at] ?? null;
      const kind = PUSH_KINDS.get(push.token) as Sword2PushKind;
      return {
        index: at,
        name: described,
        label: described ?? `parameter ${at}`,
        // A pushed string is a string whatever the comment block calls it, and
        // a pushed local address is a pointer whatever it calls it: what the
        // bytecode did outranks what the comment says it means.
        kind:
          kind === 'string'
            ? 'string'
            : kind === 'localAddr'
              ? 'pointer'
              : sword2ArgumentKind(described),
        at: push.at,
        push: kind,
        value: push.operands[0],
        text: push.text ?? null,
      };
    });
    calls.push({
      at: instruction.at,
      opcode,
      name,
      count,
      arguments: args,
      consumes: pushes.map((push) => push.at),
      trouble: null,
    });
  }

  return calls;
}

/** The calls indexed by their call instruction's byte offset, for a listing. */
export function sword2CallsByByte(calls: readonly Sword2Call[]): Map<number, Sword2Call> {
  return new Map(calls.map((call) => [call.at, call]));
}

/** Every byte offset a call has folded into itself. */
export function sword2ConsumedBytes(calls: readonly Sword2Call[]): Set<number> {
  const consumed = new Set<number>();
  for (const call of calls) for (const at of call.consumes) consumed.add(at);
  return consumed;
}
