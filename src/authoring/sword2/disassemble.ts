/**
 * Broken Sword II's bytecode, turned into instructions and back.
 *
 * ## Decompilation, on the same grounds as Sword1's and with one more wrinkle
 *
 * Every operand width follows from the opcode, and the three variable-length
 * cases carry their own counts (`sword2Tokens.ts` lists them). So a script
 * splits into instructions deterministically and re-emits to the bytes it came
 * from.
 *
 * The wrinkle is that Sword2's jumps are **byte deltas relative to the
 * operand's own position**, not to the instruction's end — `CP_SKIPONFALSE`
 * peeks its operand and adds it without consuming, so the delta is measured
 * from where the operand sits. Reassembly therefore resolves a jump to an
 * absolute byte offset and re-derives the delta from the operand's new
 * position, which is what makes an insert safe.
 *
 * `CP_JUMP_ON_RETURNED` is the exception inside the exception, and it is worth
 * stating because getting it wrong is invisible: its table's deltas are all
 * measured from the *table's start* rather than from each entry's own position,
 * so the index scales where a delta is read and never what it is relative to.
 * Entry 0 is identical under either reading, which is why a wrong base breaks a
 * minority of objects rather than all of them.
 *
 * ## What an instruction carries
 *
 * `{ at, token, operands, bytes }`, where `operands` are already widened to
 * numbers — a 16-bit variable index and a 32-bit constant both arrive as one
 * entry, and `reassemble` writes each back at its own width. A `CP_PUSH_STRING`
 * additionally carries its text, because an editable script wants the string
 * and not a byte count.
 */

import {
  CP,
  isSword2Token,
  sword2InstructionLength,
  sword2TokenName,
} from '../../engine/sword2/script/sword2Tokens.js';
import { sword2OpcodeName } from '../../engine/sword2/script/opcodeNames.js';
import {
  parseSword2Object,
  type Sword2ObjectLayout,
} from '../../engine/sword2/script/Sword2Interpreter.js';

/** One decoded instruction. */
export interface Sword2Instruction {
  /** Byte offset within the code block, which a jump target resolves to. */
  readonly at: number;
  readonly token: number;
  readonly operands: readonly number[];
  /** Total bytes, token included. */
  readonly bytes: number;
  /** A `CP_PUSH_STRING`'s text, so an edit can change the words. */
  readonly text?: string;
}

export interface Sword2Disassembly {
  readonly instructions: readonly Sword2Instruction[];
  /** Byte offset of each script's first instruction, from the module header. */
  readonly entries: readonly number[];
  readonly unrecovered: readonly {
    readonly at: number;
    readonly byte: number;
    readonly why: string;
  }[];
}

/**
 * Walks an object's code into instructions, from its own entry points.
 *
 * Entry-point driven for the same reason Sword1's is: the bytes between the
 * offset table and the first entry are not code, and a linear walk from zero
 * reads them as instructions.
 */
export function disassembleSword2Object(object: Sword2ObjectLayout): Sword2Disassembly {
  const code = object.bytes.subarray(object.codeAt, object.codeAt + object.codeBytes);
  const view = new DataView(code.buffer, code.byteOffset, code.byteLength);
  const instructions: Sword2Instruction[] = [];
  const unrecovered: { at: number; byte: number; why: string }[] = [];

  const bounds = [...object.offsets].filter((at) => at < code.length).sort((a, b) => a - b);
  bounds.push(code.length);

  const seen = new Set<number>();
  for (let entry = 0; entry < bounds.length - 1; entry++) {
    let at = bounds[entry];
    const end = bounds[entry + 1];
    while (at < end) {
      if (seen.has(at)) break;
      seen.add(at);
      const bytes = sword2InstructionLength(code, at);
      if (bytes === 0) {
        unrecovered.push({
          at,
          byte: code[at],
          why: isSword2Token(code[at])
            ? `${sword2TokenName(code[at])} has a length this decoder cannot derive`
            : `${code[at]} is not a Broken Sword II token`,
        });
        break;
      }

      const token = code[at];
      const operands: number[] = [];
      let text: string | undefined;

      switch (token) {
        case CP.PUSH_LOCAL_VAR32:
        case CP.PUSH_GLOBAL_VAR32:
        case CP.POP_LOCAL_VAR32:
        case CP.POP_GLOBAL_VAR32:
        case CP.PUSH_LOCAL_ADDR:
        case CP.ADDNPOP_LOCAL_VAR32:
        case CP.SUBNPOP_LOCAL_VAR32:
        case CP.ADDNPOP_GLOBAL_VAR32:
        case CP.SUBNPOP_GLOBAL_VAR32:
          operands.push(view.getInt16(at + 1, true));
          break;
        case CP.CALL_MCODE:
          operands.push(view.getInt16(at + 1, true));
          operands.push(code[at + 3]);
          break;
        case CP.PUSH_INT32:
        case CP.SKIPONFALSE:
        case CP.SKIPONTRUE:
        case CP.SKIPALWAYS:
        case CP.PUSH_DEREFERENCED_STRUCTURE:
        case CP.TEMP_TEXT_PROCESS:
          operands.push(view.getInt32(at + 1, true));
          break;
        case CP.PUSH_STRING: {
          const length = code[at + 1];
          operands.push(length);
          let end2 = at + 2;
          while (end2 < code.length && code[end2] !== 0) end2++;
          text = new TextDecoder('latin1').decode(code.subarray(at + 2, end2));
          break;
        }
        case CP.SWITCH: {
          const cases = view.getInt32(at + 1, true);
          operands.push(cases);
          for (let index = 0; index < cases; index++) {
            operands.push(view.getInt32(at + 5 + index * 8, true));
            operands.push(view.getInt32(at + 5 + index * 8 + 4, true));
          }
          operands.push(view.getInt32(at + 5 + cases * 8, true));
          break;
        }
        case CP.JUMP_ON_RETURNED: {
          const entries = code[at + 1];
          operands.push(entries);
          for (let index = 0; index < entries; index++) {
            operands.push(view.getInt32(at + 2 + index * 4, true));
          }
          break;
        }
        default:
          break;
      }

      instructions.push({ at, token, operands, bytes, ...(text !== undefined ? { text } : {}) });
      at += bytes;
    }
  }

  instructions.sort((left, right) => left.at - right.at);
  return { instructions, entries: [...object.offsets], unrecovered };
}

/** Reads a `GAME_OBJECT` resource and disassembles it in one step. */
export function disassembleSword2Resource(bytes: Uint8Array): {
  object: Sword2ObjectLayout;
  disassembly: Sword2Disassembly;
} {
  const object = parseSword2Object(bytes);
  return { object, disassembly: disassembleSword2Object(object) };
}

/** One instruction as a line of text, with names rather than numbers. */
export function formatSword2Instruction(instruction: Sword2Instruction): string {
  const name = sword2TokenName(instruction.token);
  switch (instruction.token) {
    case CP.CALL_MCODE:
      return `${name} ${sword2OpcodeName(instruction.operands[0])}/${instruction.operands[1]}`;
    case CP.PUSH_STRING:
      return `${name} "${instruction.text ?? ''}"`;
    case CP.SKIPONFALSE:
    case CP.SKIPONTRUE:
    case CP.SKIPALWAYS:
      // The delta is from the operand's own position, so the destination is
      // `at + 1 + delta`. Printed absolute, because a reader tracing control
      // flow wants the target.
      return `${name} -> ${instruction.at + 1 + instruction.operands[0]}`;
    case CP.SWITCH: {
      const cases: string[] = [];
      const count = instruction.operands[0];
      for (let index = 0; index < count; index++) {
        const value = instruction.operands[1 + index * 2];
        const delta = instruction.operands[2 + index * 2];
        cases.push(`${value} -> ${instruction.at + 5 + index * 8 + delta}`);
      }
      return `${name} ${count} cases: ${cases.join(', ')}`;
    }
    case CP.JUMP_ON_RETURNED: {
      const count = instruction.operands[0];
      const targets: string[] = [];
      for (let index = 0; index < count; index++) {
        targets.push(`${index} -> ${instruction.at + 2 + instruction.operands[1 + index]}`);
      }
      return `${name} ${count} entries: ${targets.join(', ')}`;
    }
    default:
      return instruction.operands.length > 0 ? `${name} ${instruction.operands.join(', ')}` : name;
  }
}

/** A whole object's scripts as a listing. */
export function formatSword2Disassembly(
  object: Sword2ObjectLayout,
  disassembly: Sword2Disassembly,
): string[] {
  const entryAt = new Map<number, number[]>();
  disassembly.entries.forEach((at, script) => {
    const list = entryAt.get(at) ?? [];
    list.push(script);
    entryAt.set(at, list);
  });

  const lines: string[] = [`object "${object.name}":`];
  for (const instruction of disassembly.instructions) {
    for (const script of entryAt.get(instruction.at) ?? []) lines.push(`  script ${script}:`);
    lines.push(`    ${instruction.at}: ${formatSword2Instruction(instruction)}`);
  }
  for (const bad of disassembly.unrecovered) {
    lines.push(`    ${bad.at}: [unrecovered] ${bad.why}`);
  }
  return lines;
}

/**
 * Re-emits instructions to a code block, rebuilding the offset table.
 *
 * The entries move with their instructions and every jump is resolved through
 * the *old* byte offsets before being re-derived from the new ones, which is
 * what makes inserting an instruction safe. A jump that resolves to nothing
 * throws rather than being written, for the reason Sword1's reassembler gives:
 * a script that runs into the middle of an instruction fails hours later as a
 * corrupted room.
 */
export function reassembleSword2Code(
  instructions: readonly Sword2Instruction[],
  entries: readonly number[],
): { code: Uint8Array; entries: number[] } {
  const ordered = [...instructions].sort((left, right) => left.at - right.at);

  const newAt = new Map<number, number>();
  let at = 0;
  for (const instruction of ordered) {
    newAt.set(instruction.at, at);
    at += instruction.bytes;
  }
  const code = new Uint8Array(at);
  const view = new DataView(code.buffer);

  const resolve = (oldTarget: number, what: string): number => {
    const moved = newAt.get(oldTarget);
    if (moved === undefined) {
      throw new Error(
        `${what} points at byte ${oldTarget}, which is not the start of an instruction after ` +
          `this edit. Writing it would produce a script that runs into the middle of an ` +
          `instruction, so the export is refused.`,
      );
    }
    return moved;
  };

  for (const instruction of ordered) {
    const position = newAt.get(instruction.at) ?? 0;
    code[position] = instruction.token;
    switch (instruction.token) {
      case CP.PUSH_LOCAL_VAR32:
      case CP.PUSH_GLOBAL_VAR32:
      case CP.POP_LOCAL_VAR32:
      case CP.POP_GLOBAL_VAR32:
      case CP.PUSH_LOCAL_ADDR:
      case CP.ADDNPOP_LOCAL_VAR32:
      case CP.SUBNPOP_LOCAL_VAR32:
      case CP.ADDNPOP_GLOBAL_VAR32:
      case CP.SUBNPOP_GLOBAL_VAR32:
        view.setInt16(position + 1, instruction.operands[0], true);
        break;
      case CP.CALL_MCODE:
        view.setInt16(position + 1, instruction.operands[0], true);
        code[position + 3] = instruction.operands[1];
        break;
      case CP.PUSH_INT32:
      case CP.PUSH_DEREFERENCED_STRUCTURE:
      case CP.TEMP_TEXT_PROCESS:
        view.setInt32(position + 1, instruction.operands[0], true);
        break;
      case CP.SKIPONFALSE:
      case CP.SKIPONTRUE:
      case CP.SKIPALWAYS: {
        const target = resolve(
          instruction.at + 1 + instruction.operands[0],
          `a ${sword2TokenName(instruction.token)} at ${instruction.at}`,
        );
        view.setInt32(position + 1, target - (position + 1), true);
        break;
      }
      case CP.PUSH_STRING: {
        const length = instruction.operands[0];
        code[position + 1] = length;
        const text = instruction.text ?? '';
        for (let index = 0; index < length; index++) {
          const ch = text.charCodeAt(index);
          code[position + 2 + index] = Number.isNaN(ch) ? 0 : ch <= 0xff ? ch : 0x3f;
        }
        code[position + 2 + length] = 0;
        break;
      }
      case CP.SWITCH: {
        const count = instruction.operands[0];
        view.setInt32(position + 1, count, true);
        for (let index = 0; index < count; index++) {
          const value = instruction.operands[1 + index * 2];
          const delta = instruction.operands[2 + index * 2];
          const oldFrom = instruction.at + 5 + index * 8;
          const target = resolve(oldFrom + delta, `a switch case at ${instruction.at}`);
          view.setInt32(position + 5 + index * 8, value, true);
          view.setInt32(position + 5 + index * 8 + 4, target - (position + 5 + index * 8), true);
        }
        const defaultDelta = instruction.operands[1 + count * 2];
        const oldDefaultFrom = instruction.at + 5 + count * 8;
        const target = resolve(
          oldDefaultFrom + defaultDelta,
          `a switch default at ${instruction.at}`,
        );
        view.setInt32(position + 5 + count * 8, target - (position + 5 + count * 8), true);
        break;
      }
      case CP.JUMP_ON_RETURNED: {
        // Every entry's delta is relative to the *table's start* and not to the
        // entry's own position, which is the one place this differs from
        // `CP_SWITCH` above. ScummVM's `interpreter.cpp` reads the delta from
        // `code + ip + index * 4` and adds it to `ip`, where `Read8ip` has left
        // `ip` at `at + 2` — so the index scales where the delta is read from
        // and never what it is measured against.
        const count = instruction.operands[0];
        code[position + 1] = count;
        for (let index = 0; index < count; index++) {
          const delta = instruction.operands[1 + index];
          const target = resolve(
            instruction.at + 2 + delta,
            `a jump table entry at ${instruction.at}`,
          );
          view.setInt32(position + 2 + index * 4, target - (position + 2), true);
        }
        break;
      }
      default:
        break;
    }
  }

  return {
    code,
    entries: entries.map((entry) => newAt.get(entry) ?? entry),
  };
}

/**
 * Whether an object's code re-emits to exactly the bytes it was read from.
 *
 * Returns the first disagreement rather than a boolean, because "it differs" is
 * not actionable and "byte 412 was 25 and is now 26" is.
 */
export function roundTripsSword2Object(
  object: Sword2ObjectLayout,
  disassembly: Sword2Disassembly = disassembleSword2Object(object),
): { ok: true } | { ok: false; at: number; expected: number; actual: number } {
  const rebuilt = reassembleSword2Code(disassembly.instructions, disassembly.entries);
  const original = object.bytes.subarray(object.codeAt, object.codeAt + object.codeBytes);
  const length = Math.max(rebuilt.code.length, original.length);
  for (let at = 0; at < length; at++) {
    const expected = original[at] ?? 0;
    const actual = rebuilt.code[at] ?? 0;
    if (expected !== actual) return { ok: false, at, expected, actual };
  }
  return { ok: true };
}
