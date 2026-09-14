/**
 * An AGOS Subroutine as a listing a person can read.
 *
 * `CONTEXT.md` separates **Disassembly** from **Decompilation**: this is the
 * first. It renders the instruction list the Project already holds (ADR 0029)
 * and reconstructs no control flow, because AGOS's control flow is not in the
 * instructions — a line runs until one of its conditions fails, so an `if` is a
 * property of the line rather than a construct in it. Inventing one would be
 * the guess `CONTEXT.md` says Disassembly stops rather than makes.
 *
 * What it does add is names. `o_carried` instead of `85` is the difference
 * between a listing and a column of numbers, and the names cost nothing: they
 * come from the same reference the argument tables do, generated rather than
 * transcribed.
 */

import { opcodeTableFor, type AgosTarget } from '../../engine/agos/agosVersion.js';
import { opcodeName } from '../../engine/agos/script/opcodeNames.js';
import type {
  AgosInstruction,
  AgosOperand,
  AgosSubroutine,
  AgosSubroutineBlock,
} from '../../engine/agos/script/subroutines.js';

/** The name table a Target's opcodes are named from. */
function nameTableFor(target: AgosTarget): string {
  // Names come per game; lengths come per game *and* release kind. A talkie and
  // a floppy disagree about how long two opcodes are, not about what they are
  // called, so the release suffix is dropped here and only here.
  return opcodeTableFor(target).replace(/talkie|dos$/, '');
}

function formatOperand(operand: AgosOperand): string {
  switch (operand.kind) {
    case 'word':
      return String(operand.value);
    case 'byte':
      // 0xFF does not mean 255 here: it says the next byte names a variable.
      return operand.variable === undefined ? String(operand.value) : `var${operand.variable}`;
    case 'item':
      return operand.id === undefined ? `item:special(${operand.lead})` : `item(${operand.id + 2})`;
    case 'string':
      return operand.id === undefined ? `string:special(${operand.lead})` : `string(${operand.id})`;
    case 'raw':
      return `<${operand.value}>`;
  }
}

/** One instruction: its name, then its operands. */
export function formatInstruction(instruction: AgosInstruction, target: AgosTarget): string {
  const name = opcodeName(nameTableFor(target), instruction.opcode);
  const operands = instruction.operands.map(formatOperand).join(', ');
  return operands ? `${name} ${operands}` : name;
}

/**
 * One Subroutine.
 *
 * Subroutine 0 is the verb table, and its lines are printed with the verb and
 * nouns that guard them — that guard is how a click reaches code, so a listing
 * that dropped it would hide the only entry point the game has.
 */
export function formatSubroutine(subroutine: AgosSubroutine, target: AgosTarget): string {
  const lines: string[] = [
    `subroutine ${subroutine.id}${subroutine.id === 0 ? '  ; verb table' : ''}`,
  ];
  for (const [index, line] of subroutine.lines.entries()) {
    const guard = line.guard
      ? `  line ${index}  ; verb ${line.guard.verb}, nouns ${line.guard.noun1}/${line.guard.noun2}`
      : `  line ${index}`;
    lines.push(guard);
    for (const instruction of line.instructions) {
      lines.push(`    ${formatInstruction(instruction, target)}`);
    }
  }
  return lines.join('\n');
}

/** A whole block, in the order the game holds it. */
export function formatSubroutineBlock(block: AgosSubroutineBlock, target: AgosTarget): string {
  return block.subroutines.map((subroutine) => formatSubroutine(subroutine, target)).join('\n\n');
}

/**
 * Every opcode a block uses that this project cannot name.
 *
 * A count worth having for its own sake: a Version whose dispatch table stops
 * short of an opcode a game actually calls is either a wrong Target or a gap in
 * the reference, and both are worth knowing before an interpreter is written
 * against them.
 */
export function unnamedOpcodes(block: AgosSubroutineBlock, target: AgosTarget): number[] {
  const table = nameTableFor(target);
  const unnamed = new Set<number>();
  // **The inversion marker has no name on purpose**, and counting it as a gap
  // made every real game report one. It is not an instruction with behaviour:
  // it changes what the *next* one's condition means, which is why
  // `AgosInterpreter` handles it before dispatch and why the generated table
  // has no entry for it. Every Simon 1 game therefore listed "opcodes this
  // project cannot name: 0", which reads as a defect and is the opposite — it
  // is the one opcode whose absence from the table is correct.
  const inversion = target.version === 'Elvira1' ? 203 : 0;
  for (const subroutine of block.subroutines) {
    for (const line of subroutine.lines) {
      for (const instruction of line.instructions) {
        if (instruction.opcode === inversion) continue;
        const name = opcodeName(table, instruction.opcode);
        if (name.startsWith('opcode_') || name === 'o_invalid') unnamed.add(instruction.opcode);
      }
    }
  }
  return [...unnamed].sort((a, b) => a - b);
}
