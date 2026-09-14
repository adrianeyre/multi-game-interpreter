/**
 * Broken Sword's bytecode, turned into instructions and back.
 *
 * ## Why this family reaches Decompilation and not only Disassembly
 *
 * `CONTEXT.md` separates the two by whether the *structure* survives the trip:
 * Disassembly is a listing, Decompilation is "an editable form that re-emits
 * byte-identically". Sword clears that bar for a reason stated in
 * `swordTokens.ts` and worth repeating here, because it is the whole basis of
 * the claim:
 *
 * - Every token is a 32-bit word and so is every operand.
 * - An instruction's length follows from its opcode, with the two variadic
 *   cases (`IT_MCODE`, `IT_SWITCH`) carrying their own counts as operands.
 * - Nothing outside the game decides how to decode — there is no arity table
 *   to be wrong about, which is the thing that keeps AGI's Decompilation
 *   conditional on a Target (ADR 0013).
 *
 * So a script splits into instructions deterministically, each instruction
 * re-emits to exactly the words it came from, and the module's own offset table
 * is rebuilt from the instruction stream. `roundTripsSword1Script` is the check,
 * and it is run over every shipped script by the test suite rather than
 * asserted here.
 *
 * ## What "editable" means concretely
 *
 * An instruction is `{ token, operands }` with names attached for display. An
 * edit changes an operand — a coordinate, a script id, a variable number — or
 * inserts and deletes whole instructions. Jump operands are **relative word
 * counts**, so inserting an instruction invalidates every jump across it;
 * `reassembleSword1Script` therefore works from *labels* rather than from the
 * raw relative numbers, which is what makes an insert safe. That is the one
 * place this module does more than transcribe.
 */

import {
  instructionWords,
  isSword1Token,
  IT,
  parseSword1ScriptModule,
  sword1TokenName,
  type Sword1ScriptModule,
} from '../../engine/sword1/script/swordTokens.js';
import { sword1McodeName } from '../../engine/sword1/script/mcodeNames.js';
import { sword1ScriptVarName } from '../../engine/sword1/script/scriptVars.js';
import {
  SWORD1_RETAIL_VAR_LAYOUT,
  type SwordVarLayout,
} from '../../engine/sword1/script/swordVarLayout.js';
import { CPT } from '../../engine/sword1/resource/swordCompact.js';

/** One decoded instruction. */
export interface Sword1Instruction {
  /** Word index within the module, which is what a jump target resolves to. */
  readonly at: number;
  readonly token: number;
  readonly operands: readonly number[];
  /** How many words it occupies, token included. */
  readonly words: number;
}

/** A script's instructions, and where the scripts start. */
export interface Sword1Disassembly {
  readonly instructions: readonly Sword1Instruction[];
  /** Word index of each script's first instruction, from the module header. */
  readonly entries: readonly number[];
  /**
   * Words the walk could not turn into instructions.
   *
   * `CONTEXT.md`'s **Unrecovered**: a word that is not a token, or a jump that
   * lands between instructions. Zero for every shipped script this project has
   * read; non-zero is what would make a script uneditable rather than quietly
   * mis-edited.
   */
  readonly unrecovered: readonly {
    readonly at: number;
    readonly word: number;
    readonly why: string;
  }[];
}

/** The compact field a byte offset names, for a readable listing. */
const COMPACT_FIELD_NAMES: ReadonlyMap<number, string> = new Map(
  Object.entries(CPT).map(([name, offset]) => [offset as number, `o_${name.toLowerCase()}`]),
);

/** `o_ycoord` for 48, or `cpt+48` for an offset with no name. */
export function sword1CompactFieldName(offset: number): string {
  return COMPACT_FIELD_NAMES.get(offset) ?? `cpt+${offset}`;
}

/**
 * Walks a module into instructions from its own entry points.
 *
 * Entry-point driven rather than linear, and that matters: a module's words are
 * a *count, an offset table and then code*, so a linear walk from word 0 reads
 * the offset table as instructions. Following the table is the only correct
 * start, and a word never reached from any entry is data rather than code.
 *
 * Walking forward from each entry rather than following jumps, because the
 * scripts are compiled as straight-line blocks with relative skips inside them
 * and every word between one entry and the next is code. A word that is not a
 * token is recorded as Unrecovered rather than skipped.
 */
export function disassembleSword1Script(module: Sword1ScriptModule): Sword1Disassembly {
  const instructions: Sword1Instruction[] = [];
  const unrecovered: { at: number; word: number; why: string }[] = [];
  const { code, scriptCount, offsets } = module;

  // Where the code starts: past the count and the offset table.
  const codeStart = 1 + scriptCount;
  // Sorted entries with the module's end appended, so each script's extent is
  // the gap to the next one.
  const bounds = [...offsets]
    .filter((at) => at >= codeStart && at < code.length)
    .sort((a, b) => a - b);
  bounds.push(code.length);

  const seen = new Set<number>();
  for (let entry = 0; entry < bounds.length - 1; entry++) {
    let at = bounds[entry];
    const end = bounds[entry + 1];
    while (at < end) {
      if (seen.has(at)) break;
      seen.add(at);
      const words = instructionWords(code, at);
      if (words === 0) {
        unrecovered.push({
          at,
          word: code[at],
          why: isSword1Token(code[at])
            ? `${sword1TokenName(code[at])} has an operand count this decoder cannot derive`
            : `${code[at]} is not a Broken Sword token`,
        });
        break;
      }
      instructions.push({
        at,
        token: code[at],
        operands: Array.from(code.subarray(at + 1, at + words)),
        words,
      });
      at += words;
    }
  }

  instructions.sort((left, right) => left.at - right.at);
  return { instructions, entries: [...offsets], unrecovered };
}

/** Reads a script resource's payload and disassembles it in one step. */
export function disassembleSword1Resource(
  payload: Uint8Array,
  bigEndian = false,
): { module: Sword1ScriptModule; disassembly: Sword1Disassembly } {
  const module = parseSword1ScriptModule(payload, bigEndian);
  return { module, disassembly: disassembleSword1Script(module) };
}

/**
 * One instruction as a line of text.
 *
 * The names are what makes this Decompilation rather than a hex dump:
 * `IT_PUSHVARIABLE 909` prints as `SCREEN`, `IT_MCODE 69 4` as `fnWalk/4`, and
 * `IT_PUSHLONGOFFSET 48` as `o_ycoord`. Every one of those names comes from a
 * generated table, so none of them can drift from the reference by hand.
 */
export function formatSword1Instruction(
  instruction: Sword1Instruction,
  layout: SwordVarLayout = SWORD1_RETAIL_VAR_LAYOUT,
): string {
  const name = sword1TokenName(instruction.token);
  switch (instruction.token) {
    case IT.MCODE:
      return `${name} ${sword1McodeName(instruction.operands[0])}/${instruction.operands[1]}`;
    case IT.PUSHVARIABLE:
    case IT.POPVAR:
      return `${name} ${sword1ScriptVarName(layout.toRetail[instruction.operands[0]] ?? instruction.operands[0])}`;
    case IT.PUSHLONGOFFSET:
    case IT.POPLONGOFFSET:
    case IT.PUSHWORDOFFSET:
    case IT.POPWORDOFFSET:
      return `${name} ${sword1CompactFieldName(instruction.operands[0])}`;
    case IT.SKIP:
    case IT.SKIPONFALSE:
    case IT.SKIPONTRUE:
      // A relative jump printed as its absolute destination, because a reader
      // matching a listing against a control flow needs the target and can
      // work out the delta from it.
      return `${name} -> ${instruction.at + 1 + instruction.operands[0]}`;
    case IT.SWITCH: {
      const cases: string[] = [];
      for (let at = 1; at + 1 < instruction.operands.length; at += 2) {
        cases.push(
          `${instruction.operands[at]} -> ${instruction.at + 1 + at + instruction.operands[at + 1]}`,
        );
      }
      return `${name} ${instruction.operands[0]} cases: ${cases.join(', ')}`;
    }
    default:
      return instruction.operands.length > 0 ? `${name} ${instruction.operands.join(', ')}` : name;
  }
}

/** A whole script module as a listing, one instruction per line. */
export function formatSword1Disassembly(
  disassembly: Sword1Disassembly,
  layout: SwordVarLayout = SWORD1_RETAIL_VAR_LAYOUT,
): string[] {
  const entryAt = new Map<number, number[]>();
  disassembly.entries.forEach((at, script) => {
    const list = entryAt.get(at) ?? [];
    list.push(script);
    entryAt.set(at, list);
  });

  const lines: string[] = [];
  for (const instruction of disassembly.instructions) {
    for (const script of entryAt.get(instruction.at) ?? []) {
      lines.push(`script ${script}:`);
    }
    lines.push(`  ${instruction.at}: ${formatSword1Instruction(instruction, layout)}`);
  }
  for (const bad of disassembly.unrecovered) {
    lines.push(`  ${bad.at}: [unrecovered] ${bad.why}`);
  }
  return lines;
}

/**
 * Re-emits instructions to words, rebuilding the offset table.
 *
 * The **entry points move with their instructions**, which is the property that
 * makes an insert safe: `entries` is given as word indexes into the *old*
 * module, they are matched to instructions, and the new table holds wherever
 * those instructions ended up. A jump is re-emitted from its resolved
 * destination rather than from its old delta, for the same reason.
 *
 * Throws when an edit left a jump pointing at no instruction, because writing
 * such a module produces a game that runs into the middle of an instruction —
 * a fault that shows up hours later as a corrupted room.
 */
export function reassembleSword1Script(
  instructions: readonly Sword1Instruction[],
  entries: readonly number[],
): Int32Array {
  const ordered = [...instructions].sort((left, right) => left.at - right.at);

  // Pass one: where each instruction lands, given the offset table's size.
  const codeStart = 1 + entries.length;
  const newAt = new Map<number, number>();
  let at = codeStart;
  for (const instruction of ordered) {
    newAt.set(instruction.at, at);
    at += instruction.words;
  }
  const total = at;

  const resolve = (oldTarget: number, what: string): number => {
    const moved = newAt.get(oldTarget);
    if (moved === undefined) {
      throw new Error(
        `${what} points at word ${oldTarget}, which is not the start of an instruction after ` +
          `this edit. Writing it would produce a script that runs into the middle of an ` +
          `instruction, so the export is refused.`,
      );
    }
    return moved;
  };

  const out = new Int32Array(total);
  out[0] = entries.length;
  entries.forEach((entry, script) => {
    // An entry beyond the code is a script the module declares and does not
    // hold, which the shipped modules do: it is preserved as-is.
    out[script + 1] = newAt.get(entry) ?? entry;
  });

  for (const instruction of ordered) {
    const position = newAt.get(instruction.at) ?? codeStart;
    out[position] = instruction.token;
    if (
      instruction.token === IT.SKIP ||
      instruction.token === IT.SKIPONFALSE ||
      instruction.token === IT.SKIPONTRUE
    ) {
      const oldTarget = instruction.at + 1 + instruction.operands[0];
      const target = resolve(
        oldTarget,
        `a ${sword1TokenName(instruction.token)} at ${instruction.at}`,
      );
      out[position + 1] = target - (position + 1);
    } else if (instruction.token === IT.SWITCH) {
      out[position + 1] = instruction.operands[0];
      for (let index = 1; index + 1 < instruction.operands.length; index += 2) {
        out[position + 1 + index] = instruction.operands[index];
        const oldTarget = instruction.at + 1 + index + instruction.operands[index + 1];
        const target = resolve(oldTarget, `a switch case at ${instruction.at}`);
        out[position + 1 + index + 1] = target - (position + 1 + index);
      }
      // The default jump is the last operand.
      const last = instruction.operands.length - 1;
      if (last >= 1 && (last - 1) % 2 === 0) {
        const oldTarget = instruction.at + 1 + last + instruction.operands[last];
        out[position + 1 + last] =
          resolve(oldTarget, `a switch default at ${instruction.at}`) - (position + 1 + last);
      }
    } else {
      instruction.operands.forEach((operand, index) => {
        out[position + 1 + index] = operand;
      });
    }
  }

  return out;
}

/**
 * Whether a module re-emits to exactly the words it was read from.
 *
 * The claim this file's header makes, made checkable. Returns the first
 * disagreement rather than a boolean, because "it differs" is not actionable
 * and "word 412 was 25 and is now 26" is.
 */
export function roundTripsSword1Script(
  module: Sword1ScriptModule,
  disassembly: Sword1Disassembly = disassembleSword1Script(module),
): { ok: true } | { ok: false; at: number; expected: number; actual: number } {
  const rebuilt = reassembleSword1Script(disassembly.instructions, disassembly.entries);
  const length = Math.max(rebuilt.length, module.code.length);
  for (let at = 0; at < length; at++) {
    const expected = module.code[at] ?? 0;
    const actual = rebuilt[at] ?? 0;
    if (expected !== actual) return { ok: false, at, expected, actual };
  }
  return { ok: true };
}
