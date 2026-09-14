/**
 * Changing an AGOS game.
 *
 * Every edit here returns a **new** game rather than mutating one, for a reason
 * particular to this family: ADR 0030 rebuilds `GAMEPC` whole because the file
 * has no index, so an edit is not a patch to a resource — it is a new value for
 * the whole file. Making that explicit in the types stops the editor from
 * holding a half-edited game that has no file it corresponds to.
 *
 * ## Editing a string is not a local act
 *
 * AGOS pools its strings and refers to them by index, which is ADR 0009's shape
 * rather than AGI's. So "rename this item" means "change the string its noun
 * points at", and every other item and every Subroutine pointing at that same
 * string changes with it. `stringReferences` in `project.ts` is what lets the
 * editor show that before the edit rather than after.
 *
 * The alternative — appending a new string and repointing this one item — is
 * available and deliberately not the default: it grows the pool on every rename
 * and quietly changes what a shared line means for one caller only, which is
 * the kind of edit an author cannot see the shape of.
 */

import type { AgosGamePc } from '../../engine/agos/resource/gamePc.js';
import {
  defaultOperandsFor,
  type AgosInstruction,
  type AgosOperand,
} from '../../engine/agos/script/subroutines.js';
import { OPCODE_ARG_TABLES } from '../../engine/agos/script/opcodeArgTables.js';
import { hasWideOpcodes, opcodeTableFor, type AgosTarget } from '../../engine/agos/agosVersion.js';
import { linkTo } from '../../engine/agos/world/itemTree.js';

/** The pool, rebuilt from a list of strings. */
function poolFrom(strings: readonly string[]): Uint8Array {
  const encoder = new TextEncoder();
  const parts = strings.map((each) => encoder.encode(each));
  const total = parts.reduce((sum, part) => sum + part.length + 1, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
    // Every string is NUL-terminated, including the last: the count in the
    // header says how many to read, and a missing terminator runs the last one
    // into whatever follows the pool.
    out[at] = 0;
    at += 1;
  }
  return out;
}

/**
 * Replaces one pooled string.
 *
 * Reaches every user of that string by design. The caller is expected to have
 * shown the author which ones.
 */
export function editString(game: AgosGamePc, index: number, text: string): AgosGamePc {
  if (index < 0 || index >= game.strings.length) {
    throw new Error(`there is no string ${index}: the game has ${game.strings.length}`);
  }
  const strings = [...game.strings];
  strings[index] = text;
  return { ...game, strings, textBytes: poolFrom(strings) };
}

/**
 * Adds a string and returns the game and the index it landed at.
 *
 * The header's string count grows with it, because the count is what says how
 * many to read back out of the pool — a pool with one more string in it and an
 * unchanged count silently loses the new one on reload.
 */
export function addString(game: AgosGamePc, text: string): { game: AgosGamePc; index: number } {
  const strings = [...game.strings, text];
  return {
    game: {
      ...game,
      strings,
      textBytes: poolFrom(strings),
      header: { ...game.header, stringTableNum: game.header.stringTableNum + 1 },
    },
    index: strings.length - 1,
  };
}

/**
 * Moves an item to a new parent.
 *
 * The only structural edit that matters in an AGOS world, because moving items
 * is how the games themselves change anything. Item 0 means nowhere, which is
 * how a game destroys something.
 */
export function reparentItem(game: AgosGamePc, id: number, parent: number): AgosGamePc {
  const at = id - 2;
  const item = game.items[at];
  if (!item) throw new Error(`there is no item ${id}`);
  const items = [...game.items];
  items[at] = { ...item, parent: linkTo(parent) };
  return { ...game, items };
}

/** Changes an item's state, the other thing a game rewrites about one. */
export function setItemState(game: AgosGamePc, id: number, state: number): AgosGamePc {
  const at = id - 2;
  const item = game.items[at];
  if (!item) throw new Error(`there is no item ${id}`);
  const items = [...game.items];
  items[at] = { ...item, state };
  return { ...game, items };
}

/**
 * Points an item's noun at a different string, which is how it is renamed
 * without changing what every other user of the old string says.
 */
export function renameItem(game: AgosGamePc, id: number, text: string): AgosGamePc {
  const at = id - 2;
  const item = game.items[at];
  if (!item) throw new Error(`there is no item ${id}`);
  const { game: withString, index } = addString(game, text);
  const items = [...withString.items];
  items[at] = { ...item, noun: index };
  return { ...withString, items };
}

/**
 * Changes one value inside an item's typed sub-structure.
 *
 * A room's exits, an object's flag values, a container's volume: the values are
 * held as a list beside the mask that sized them (`AgosItemChild`), because the
 * layouts differ per Version in ways that are *counted* rather than fixed. So
 * an edit here changes a value and never the count — changing the count would
 * mean changing the mask, which relays the record and is a different operation
 * with different consequences for the file.
 */
export function editItemChildValue(
  game: AgosGamePc,
  id: number,
  type: number,
  valueIndex: number,
  value: number,
): AgosGamePc {
  const at = id - 2;
  const item = game.items[at];
  if (!item) throw new Error(`there is no item ${id}`);

  const childIndex = item.children.findIndex((child) => child.type === type);
  if (childIndex < 0) throw new Error(`item ${id} has no sub-structure of type ${type}`);

  const child = item.children[childIndex]!;
  if (valueIndex < 0 || valueIndex >= child.values.length) {
    throw new Error(
      `sub-structure ${type} on item ${id} has ${child.values.length} values, not ${valueIndex + 1}`,
    );
  }

  const values = [...child.values];
  values[valueIndex] = value;
  const children = [...item.children];
  children[childIndex] = { ...child, values };
  const items = [...game.items];
  items[at] = { ...item, children };
  return { ...game, items };
}

/**
 * Changing one operand of one instruction.
 *
 * ADR 0029 stores instructions rather than source text, so an instruction edit
 * is a change to a value in a tree and not a re-parse. That makes this the
 * cheapest useful edit in the family — and the *only* safe one at the moment,
 * for a reason about width rather than about ambition.
 *
 * ## Why the kind is preserved and only the value changes
 *
 * An AGOS operand's encoded width is not a property of the operand alone. A
 * `T` string operand is one word when it stands alone and *three* when its lead
 * introduces a 32-bit id, and the same is true of `I`. So changing an operand's
 * kind, or giving a lead-carrying operand an id it did not have, changes how
 * many bytes the instruction occupies — and every jump target after it in the
 * Subroutine then points at the middle of an instruction.
 *
 * Preserving the kind and refusing a value that does not fit the width it
 * arrived at is what keeps an operand edit from changing an instruction's
 * length, and it is checked rather than documented: `outOfRange` below is the
 * guard. That keeps an operand edit a pure substitution.
 *
 * **A correction, because this used to give the wrong reason.** It said the
 * wider edit — inserting and deleting instructions — had to wait for jump
 * renumbering, since moving an instruction would strand every jump target
 * after it. That is true of the *VGA* bytecode, which has `JUMP_REL` and
 * `END_REPEAT` measured in bytes. It is not true of the bytecode this file
 * edits: AGOS's game bytecode has **no byte-offset jumps at all**. A line runs
 * until one of its conditions fails, and the one opcode that looks like a
 * jump, `o_goto`, moves the *player* rather than the program counter.
 *
 * So nothing referred to an instruction by offset, nothing had to be
 * renumbered, and {@link insertInstruction} and {@link deleteInstruction} below
 * are safe. The gate was imaginary.
 */
export function editInstructionOperand(
  game: AgosGamePc,
  subroutineId: number,
  lineIndex: number,
  instructionIndex: number,
  operandIndex: number,
  value: number,
): AgosGamePc {
  const subroutineAt = game.subroutines.subroutines.findIndex((each) => each.id === subroutineId);
  if (subroutineAt < 0) throw new Error(`there is no subroutine ${subroutineId}`);
  const subroutine = game.subroutines.subroutines[subroutineAt]!;

  const line = subroutine.lines[lineIndex];
  if (!line) {
    throw new Error(
      `subroutine ${subroutineId} has ${subroutine.lines.length} lines, not ${lineIndex + 1}`,
    );
  }

  const instruction = line.instructions[instructionIndex];
  if (!instruction) {
    throw new Error(
      `line ${lineIndex} of subroutine ${subroutineId} has ` +
        `${line.instructions.length} instructions, not ${instructionIndex + 1}`,
    );
  }

  const operand = instruction.operands[operandIndex];
  if (!operand) {
    throw new Error(
      `instruction ${instructionIndex} has ${instruction.operands.length} operands, ` +
        `not ${operandIndex + 1}`,
    );
  }

  const edited = operandWithValue(operand, value);

  const operands = [...instruction.operands];
  operands[operandIndex] = edited;
  const instructions = [...line.instructions];
  instructions[instructionIndex] = { ...instruction, operands };
  const lines = [...subroutine.lines];
  lines[lineIndex] = { ...line, instructions };
  const subroutines = [...game.subroutines.subroutines];
  subroutines[subroutineAt] = { ...subroutine, lines };

  return { ...game, subroutines: { ...game.subroutines, subroutines } };
}

/** Whether a value fits the field it is going into. */
function outOfRange(value: number, bits: 8 | 16): boolean {
  if (!Number.isInteger(value)) return true;
  // Signed or unsigned: a word operand is read signed in some opcodes and
  // unsigned in others, and the table does not say which, so the accepted
  // range is the union rather than one of the two.
  const limit = bits === 8 ? 0xff : 0xffff;
  const floor = bits === 8 ? -0x80 : -0x8000;
  return value < floor || value > limit;
}

/**
 * The same operand with a new value, or a thrown error when it would not fit.
 *
 * Exported because the editor needs the *same* width rules rather than its own
 * copy of them: the editor mutates a Project's instruction tree in place (the
 * pattern `AgosEditor` already uses for items) while the functions above return
 * a new `AgosGamePc`, and two implementations of "does this value fit" would
 * eventually disagree — with the editor being the permissive one, which is the
 * wrong way round.
 *
 * Split out so every kind's width rule is in one place. The two lead-carrying
 * kinds are the interesting ones: the value edited is whichever field the
 * operand actually used on disk, so an operand that arrived as a bare lead
 * stays a bare lead and one that arrived with a 32-bit id keeps it.
 */
export function operandWithValue(operand: AgosOperand, value: number): AgosOperand {
  switch (operand.kind) {
    case 'word':
    case 'raw':
      if (outOfRange(value, 16)) throw new Error(`${value} does not fit a 16-bit operand`);
      return { ...operand, value };
    case 'byte':
      if (outOfRange(value, 8)) throw new Error(`${value} does not fit an 8-bit operand`);
      return { ...operand, value };
    case 'item':
    case 'string':
      // A bare lead is one word; a lead with an id behind it is three. Editing
      // whichever field was used keeps the width it arrived at.
      if (operand.id === undefined) {
        if (outOfRange(value, 16)) throw new Error(`${value} does not fit a 16-bit lead`);
        return { ...operand, lead: value };
      }
      if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
        throw new Error(`${value} does not fit a 32-bit id`);
      }
      return { ...operand, id: value };
  }
}

/**
 * Inserts an instruction into a line.
 *
 * Safe because AGOS's game bytecode refers to nothing by offset — see the
 * correction on {@link editInstructionOperand} for why this was wrongly thought
 * to need jump renumbering first. ADR 0030 rebuilds `GAMEPC` whole, so every
 * instruction after this one is simply re-encoded at its new position.
 *
 * The new instruction gets **blank operands of the right shapes**, built from
 * the same argument table the reader dispatches on. An opcode is not given
 * operands it does not take, and one that takes operands is not left without
 * them — either would produce a line that re-emits as bytes the reader cannot
 * walk.
 */
export function insertInstruction(
  game: AgosGamePc,
  target: AgosTarget,
  subroutineId: number,
  lineIndex: number,
  at: number,
  opcode: number,
): AgosGamePc {
  const letters = OPCODE_ARG_TABLES[opcodeTableFor(target)][opcode];
  if (letters === null || letters === undefined) {
    throw new Error(`opcode ${opcode} is not in ${target.version}'s table`);
  }

  const operands = defaultOperandsFor(letters, hasWideOpcodes(target.version));
  return withLine(game, subroutineId, lineIndex, (instructions) => {
    if (at < 0 || at > instructions.length) {
      throw new Error(`cannot insert at ${at}: the line has ${instructions.length} instructions`);
    }
    const next = [...instructions];
    next.splice(at, 0, { opcode, operands });
    return next;
  });
}

/**
 * Removes an instruction from a line.
 *
 * The mirror of the insert, and safe for the same reason. Removing the *last*
 * instruction of a line is allowed and leaves an empty line rather than
 * deleting the line: a line is what a verb-table guard points at, so dropping
 * one would silently unhook a verb.
 */
export function deleteInstruction(
  game: AgosGamePc,
  subroutineId: number,
  lineIndex: number,
  at: number,
): AgosGamePc {
  return withLine(game, subroutineId, lineIndex, (instructions) => {
    if (at < 0 || at >= instructions.length) {
      throw new Error(`there is no instruction ${at}: the line has ${instructions.length}`);
    }
    const next = [...instructions];
    next.splice(at, 1);
    return next;
  });
}

/**
 * Replaces one line's instructions, rebuilding the tree above it.
 *
 * Shared by the insert and the delete because the walk down to a line and the
 * rebuild back up is the whole of both, and duplicating it is how the two would
 * come to disagree about which subroutine they had found.
 */
function withLine(
  game: AgosGamePc,
  subroutineId: number,
  lineIndex: number,
  change: (instructions: readonly AgosInstruction[]) => AgosInstruction[],
): AgosGamePc {
  const subroutineAt = game.subroutines.subroutines.findIndex((each) => each.id === subroutineId);
  if (subroutineAt < 0) throw new Error(`there is no subroutine ${subroutineId}`);
  const subroutine = game.subroutines.subroutines[subroutineAt]!;

  const line = subroutine.lines[lineIndex];
  if (!line) {
    throw new Error(
      `subroutine ${subroutineId} has ${subroutine.lines.length} lines, not ${lineIndex + 1}`,
    );
  }

  const lines = [...subroutine.lines];
  lines[lineIndex] = { ...line, instructions: change(line.instructions) };
  const subroutines = [...game.subroutines.subroutines];
  subroutines[subroutineAt] = { ...subroutine, lines };
  return { ...game, subroutines: { ...game.subroutines, subroutines } };
}
