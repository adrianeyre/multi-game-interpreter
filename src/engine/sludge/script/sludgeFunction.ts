/**
 * Reads a SLUDGE compiled function — its header and its instruction listing.
 *
 * This is **Disassembly** and not **Decompilation** (`CONTEXT.md`): it recovers
 * the instructions a function is made of, in order, and says nothing about the
 * structure they came from. That is the same place Sky's script listing starts
 * and the same place ADR 0025 puts a Virtual Theatre Project's bytecode.
 *
 * ## The encoding is fixed-width, which is unusual here and worth saying
 *
 * Every other family in this project has variable-length instructions whose
 * operands are decided by the opcode, so a reader that gets one arity wrong
 * desynchronises and every instruction after it is nonsense — which is what
 * `npm run unrecovered`'s jump-following exists to catch. SLUDGE has none of
 * that. An instruction is exactly three bytes: a command byte and a 16-bit
 * big-endian parameter, always, for every command.
 *
 * So the listing cannot desynchronise, and the check that matters for the other
 * families does not apply. What can still go wrong is the *count*: the header
 * says how many instructions follow, and a function whose listing runs past the
 * end of the file is a header read at the wrong offset. That is what this
 * checks instead.
 *
 * ## The commands are numbered, not named
 *
 * A command's number is what the file carries and what this reports. Names are
 * deliberately absent: ScummVM has a table of them, and ADR 0029 settled for
 * AGOS that such a table is **generated** from the reference rather than typed
 * out by hand, because a name table transcribed by a person is a table with a
 * typo in it and the typo reads as a decoding fault. Naming SLUDGE's commands
 * is that generation step, and it is not this commit.
 *
 * A listing of numbered commands is still worth having: it establishes that
 * every function in a game resolves, that its instruction count is honest, and
 * which commands a real game actually uses — which is the shortlist an
 * interpreter has to implement first.
 */

import { SLUDGE_COMMAND_COUNT, sludgeCommandName } from './commandNames.js';
import type { SludgeFile } from '../resource/sludgeFile.js';
import { SludgeFormatError, locateSubroutine } from '../resource/sludgeFile.js';

/** One instruction: what to do, and its single operand. */
export interface SludgeInstruction {
  /** The command's number. Unnamed on purpose — see the note above. */
  readonly command: number;
  readonly parameter: number;
}

export interface SludgeFunction {
  /** Which Sub index entry this came from. */
  readonly number: number;
  /** The author's name for it, where the file carries a name table. */
  readonly name: string;
  /** Where the function's header starts, as an absolute file offset. */
  readonly offset: number;
  /**
   * Whether the function survives a freeze — SLUDGE's word for the state a
   * save is taken from. Carried through rather than acted on.
   */
  readonly unfreezable: boolean;
  readonly argumentCount: number;
  readonly localCount: number;
  readonly instructions: readonly SludgeInstruction[];
  /** Total bytes: the seven-byte header plus three per instruction. */
  readonly byteLength: number;
}

/** The header ahead of the instructions: a flag byte and three counts. */
const HEADER_BYTES = 7;
const INSTRUCTION_BYTES = 3;

/** Reads the function the Sub index addresses at `number`. */
export function readSludgeFunction(
  bytes: Uint8Array,
  file: SludgeFile,
  number: number,
): SludgeFunction {
  if (number < 0 || number >= file.userFunctionNames.length) {
    // The Sub index has no length of its own, so the name table is what bounds
    // it. A game compiled without name tables has no bound to offer and every
    // number is refused rather than read from wherever the arithmetic lands.
    throw new SludgeFormatError(
      file.userFunctionNames.length === 0
        ? `this game carries no function name table, so the Sub index has no known extent and ` +
            `function ${number} cannot be located`
        : `function ${number} is outside this game's ${file.userFunctionNames.length} functions`,
    );
  }

  const offset = locateSubroutine(bytes, file, number);
  if (offset + HEADER_BYTES > bytes.length) {
    throw new SludgeFormatError(
      `function ${number}'s header at byte ${offset} runs past the end of the file ` +
        `(file is ${bytes.length} bytes)`,
    );
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const unfreezable = bytes[offset] !== 0;
  const instructionCount = view.getUint16(offset + 1, false);
  const argumentCount = view.getUint16(offset + 3, false);
  const localCount = view.getUint16(offset + 5, false);

  const byteLength = HEADER_BYTES + instructionCount * INSTRUCTION_BYTES;
  if (offset + byteLength > bytes.length) {
    throw new SludgeFormatError(
      `function ${number} at byte ${offset} declares ${instructionCount} instructions, which ` +
        `would end at byte ${offset + byteLength} in a ${bytes.length}-byte file — its header ` +
        `was read at the wrong offset`,
    );
  }

  const instructions: SludgeInstruction[] = [];
  for (let index = 0; index < instructionCount; index += 1) {
    const at = offset + HEADER_BYTES + index * INSTRUCTION_BYTES;
    instructions.push({
      command: bytes[at] as number,
      parameter: view.getUint16(at + 1, false),
    });
  }

  return {
    number,
    name: file.userFunctionNames[number] ?? '',
    offset,
    unfreezable,
    argumentCount,
    localCount,
    instructions,
    byteLength,
  };
}

/** Every function the Sub index addresses, in index order. */
export function readAllSludgeFunctions(bytes: Uint8Array, file: SludgeFile): SludgeFunction[] {
  const out: SludgeFunction[] = [];
  for (let number = 0; number < file.userFunctionNames.length; number += 1) {
    out.push(readSludgeFunction(bytes, file, number));
  }
  return out;
}

/**
 * Which commands a game actually uses, and how often.
 *
 * The shortlist an interpreter has to implement first, measured off the game
 * rather than off the size of the command space. Sorted by count, descending,
 * because that is the order the work is worth doing in.
 */
export function commandHistogram(
  functions: readonly SludgeFunction[],
): { command: number; count: number }[] {
  const counts = new Map<number, number>();
  for (const fn of functions) {
    for (const instruction of fn.instructions) {
      counts.set(instruction.command, (counts.get(instruction.command) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([command, count]) => ({ command, count }))
    .sort((a, b) => b.count - a.count || a.command - b.command);
}

/**
 * One instruction as a line of a listing: its number, name and parameter.
 *
 * The name comes from the generated table (`commandNames.ts`), so a command
 * this project has no name for prints its number in angle brackets rather than
 * an empty string — a listing whose unknown lines are blank is a listing that
 * hides exactly what a reader is looking for.
 */
export function describeInstruction(instruction: SludgeInstruction): string {
  return `${sludgeCommandName(instruction.command)} ${instruction.parameter}`;
}

/** A function as a listing, one instruction per line, addresses included. */
export function disassemble(fn: SludgeFunction): string[] {
  return fn.instructions.map((instruction, index) => {
    const at = fn.offset + 7 + index * 3;
    return `${at.toString(10).padStart(8)}  ${describeInstruction(instruction)}`;
  });
}

/**
 * Command numbers a game uses that the generated table has no name for.
 *
 * Empty is the expected answer and a non-empty one is a finding rather than a
 * curiosity: it means either the game was built by a SLUDGE newer than the
 * reference this project generated its names from, or the listing is being read
 * at the wrong offset. Reporting the numbers says which — a handful of high
 * numbers is the first, and a scatter across the whole byte is the second.
 */
export function unnamedCommands(functions: readonly SludgeFunction[]): number[] {
  const seen = new Set<number>();
  for (const fn of functions) {
    for (const instruction of fn.instructions) {
      if (instruction.command >= SLUDGE_COMMAND_COUNT) seen.add(instruction.command);
    }
  }
  return [...seen].sort((a, b) => a - b);
}
