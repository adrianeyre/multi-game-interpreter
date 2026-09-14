/**
 * Reading and re-emitting AGOS bytecode.
 *
 * A **Subroutine** (`CONTEXT.md`) is AGOS's unit of behaviour: a numbered list
 * of lines, each a list of instructions. It is not owned by a room and not
 * owned by an item, which is why behaviour has to be found through the item
 * tree rather than by opening a room.
 *
 * ## Why reading and writing live in one file
 *
 * ADR 0029 makes byte-identity the gate for editing an AGOS game at all, and
 * ADR 0030 makes the whole of `GAMEPC` a rebuild rather than a patch. Both
 * depend on re-emission being the exact inverse of reading, instruction by
 * instruction — including the bytes an interpreter throws away. So every
 * operand keeps what was on disk rather than only what it means: an item
 * operand records the word that preceded its id even though the interpreter
 * overwrites it, because a Project that drops it cannot write the file back.
 *
 * ## How an instruction's length is known
 *
 * It is not in the bytecode. The opcode indexes an argument table
 * (`opcodeArgTables.ts`) whose letters give the operand widths, and that table
 * is this project's rather than the game's (ADR 0029). Two consequences run
 * through everything below:
 *
 * - a wrong table misreads every boundary after the first mismatch, so the
 *   reader stops at the first thing it cannot explain instead of resynchronising
 * - the check that the table is right is **Structural agreement** over a whole
 *   game (`structuralAgreement.ts`), not a plausible-looking listing
 */

import {
  hasWideOpcodes,
  lineTerminator,
  opcodeTableFor,
  rawWordOpcode,
  type AgosTarget,
} from '../agosVersion.js';
import { OPCODE_ARG_TABLES } from './opcodeArgTables.js';

/**
 * One operand, as it was on disk.
 *
 * `kind` is the letter from the argument table rather than a meaning, because
 * the meaning belongs to the opcode and the bytes belong here.
 */
export type AgosOperand =
  /** `F N S a n p v 3`, and `B` in Elvira 1: a 16-bit word. */
  | { readonly kind: 'word'; readonly value: number }
  /** `B`: a byte, or 0xFF followed by the byte that names a variable. */
  | { readonly kind: 'byte'; readonly value: number; readonly variable?: number }
  /** `I`: a word that either stands for a special item or introduces a 32-bit id. */
  | { readonly kind: 'item'; readonly lead: number; readonly id?: number }
  /** `T`: a word that either stands alone or introduces a 32-bit string id. */
  | { readonly kind: 'string'; readonly lead: number; readonly id?: number }
  /** The word after the condition opcode, read raw rather than through the table. */
  | { readonly kind: 'raw'; readonly value: number };

/**
 * The word a guard uses for "any", as it is stored.
 *
 * **`0xFFFF`, not `-1`**, and the difference was a bug rather than a detail.
 * A guard's three words are read unsigned, so the sentinel arrives as 65535 —
 * while `runVerb` compared against `-1`, which is the same bits read signed.
 * The comparison therefore never recognised a wildcard: it saw 65535, decided
 * that was a real noun, found it did not equal the noun a player had clicked,
 * and skipped the line.
 *
 * That is not a rare case. In Simon 1's DOS floppy demo **every** noun slot in
 * the verb table is this value — 74 of 74 — and no guard anywhere contains
 * `-1`, so on real data almost nothing a player did could match a line.
 *
 * Exported so the interpreter and anything reading the table share one notion
 * of it. Two copies of a sentinel is how the two halves came to disagree in the
 * first place.
 */
export const GUARD_ANY = 0xffff;

/** Whether a stored guard word means "any", in either spelling. */
export function isGuardWildcard(word: number): boolean {
  // Both, deliberately. The stored form is `GUARD_ANY`; `-1` is what a *caller*
  // passes for "I have no noun", and a fixture written before this was
  // understood may carry it too.
  return word === GUARD_ANY || word === -1;
}

export interface AgosInstruction {
  readonly opcode: number;
  readonly operands: readonly AgosOperand[];
}

/**
 * One line of a Subroutine.
 *
 * Subroutine 0 is the game's verb table: each of its lines is guarded by a verb
 * and two nouns, which is how a click reaches code. Every other Subroutine is
 * called by number and has no guard — except in Elvira 1, which writes three
 * words there anyway and ignores them. Those three are kept for re-emission,
 * which is the whole reason this type has a field for something meaningless.
 */
export interface AgosSubroutineLine {
  readonly guard?: { readonly verb: number; readonly noun1: number; readonly noun2: number };
  /** Elvira 1's three ignored words, present only where the game wrote them. */
  readonly padding?: readonly [number, number, number];
  readonly instructions: readonly AgosInstruction[];
}

export interface AgosSubroutine {
  readonly id: number;
  readonly lines: readonly AgosSubroutineLine[];
  /**
   * The non-zero word that ended this Subroutine's lines.
   *
   * Read and kept rather than assumed, because it is written back and the games
   * do not all use the same value.
   */
  readonly endMarker: number;
}

export interface AgosSubroutineBlock {
  readonly subroutines: readonly AgosSubroutine[];
  /** The non-zero word that ended the block. */
  readonly endMarker: number;
}

/** A decode that could not continue, named at the offset it stopped. */
export class AgosDecodeError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(`${message} (at offset ${offset})`);
    this.name = 'AgosDecodeError';
  }
}

/** A big-endian cursor over a game's bytes. AGOS files are big-endian throughout. */
class Cursor {
  offset = 0;
  constructor(private readonly data: Uint8Array) {}

  get atEnd(): boolean {
    return this.offset >= this.data.length;
  }

  byte(): number {
    if (this.offset >= this.data.length) throw new AgosDecodeError('ran past the end', this.offset);
    return this.data[this.offset++]!;
  }

  word(): number {
    return (this.byte() << 8) | this.byte();
  }

  long(): number {
    return this.word() * 0x10000 + this.word();
  }
}

class Writer {
  private readonly bytes: number[] = [];

  byte(value: number): void {
    this.bytes.push(value & 0xff);
  }

  word(value: number): void {
    this.byte(value >> 8);
    this.byte(value);
  }

  long(value: number): void {
    this.word(Math.floor(value / 0x10000));
    this.word(value & 0xffff);
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

/** The item ids that stand for themselves rather than introducing a 32-bit id. */
const SPECIAL_ITEM_LEADS = new Set([1, 3, 5, 7, 9]);
/** The string ids that do the same. */
const SPECIAL_STRING_LEADS = new Set([0, 3]);

function readOperand(cursor: Cursor, letter: string, wide: boolean): AgosOperand {
  switch (letter) {
    case 'F':
    case 'N':
    case 'S':
    case 'a':
    case 'n':
    case 'p':
    case 'v':
    case '3':
      return { kind: 'word', value: cursor.word() };
    case 'B': {
      if (wide) return { kind: 'word', value: cursor.word() };
      const value = cursor.byte();
      // 0xFF is not a value: it says the next byte names a variable. Reading it
      // as a value is the single easiest way to desynchronise a whole line.
      if (value === 0xff) return { kind: 'byte', value, variable: cursor.byte() };
      return { kind: 'byte', value };
    }
    case 'I': {
      const lead = cursor.word();
      if (SPECIAL_ITEM_LEADS.has(lead)) return { kind: 'item', lead };
      return { kind: 'item', lead, id: cursor.long() };
    }
    case 'T': {
      const lead = cursor.word();
      if (SPECIAL_STRING_LEADS.has(lead)) return { kind: 'string', lead };
      return { kind: 'string', lead, id: cursor.long() };
    }
    default:
      throw new AgosDecodeError(`unknown operand letter '${letter}'`, cursor.offset);
  }
}

/**
 * Blank operands for an opcode about to be inserted.
 *
 * An inserted instruction needs operands of the right *shapes* before it can
 * be written back, and the shapes come from the same letters the reader
 * dispatches on — so this sits beside `readOperand` rather than in the editor,
 * where it would be a second reading of the same table.
 *
 * The two lead-carrying letters are given a **special lead**, which is the
 * spelling that stands alone rather than introducing a 32-bit id. That is the
 * shorter encoding and the one with nothing undefined in it: a lead that
 * expected an id would need an id invented to go with it.
 */
export function defaultOperandsFor(letters: string, wide: boolean): AgosOperand[] {
  const operands: AgosOperand[] = [];
  for (const letter of letters) {
    // The tables pad their letter strings, and a space is not an operand. The
    // reader skips them the same way; treating one as a letter here would ask
    // for a blank operand of a kind that does not exist.
    if (letter === ' ') continue;
    switch (letter) {
      case 'F':
      case 'N':
      case 'S':
      case 'a':
      case 'n':
      case 'p':
      case 'v':
      case '3':
        operands.push({ kind: 'word', value: 0 });
        break;
      case 'B':
        operands.push(wide ? { kind: 'word', value: 0 } : { kind: 'byte', value: 0 });
        break;
      case 'I':
        // A lead in SPECIAL_ITEM_LEADS, so it carries no id behind it.
        operands.push({ kind: 'item', lead: 1 });
        break;
      case 'T':
        // Likewise for strings: 0 is a lead that stands alone.
        operands.push({ kind: 'string', lead: 0 });
        break;
      default:
        throw new Error(`cannot build a blank operand for letter '${letter}'`);
    }
  }
  return operands;
}

function writeOperand(writer: Writer, operand: AgosOperand, wide: boolean): void {
  switch (operand.kind) {
    case 'word':
    case 'raw':
      writer.word(operand.value);
      return;
    case 'byte':
      if (wide) {
        writer.word(operand.value);
        return;
      }
      writer.byte(operand.value);
      if (operand.variable !== undefined) writer.byte(operand.variable);
      return;
    case 'item':
    case 'string':
      writer.word(operand.lead);
      if (operand.id !== undefined) writer.long(operand.id);
      return;
  }
}

function readInstruction(cursor: Cursor, target: AgosTarget): AgosInstruction {
  const wide = hasWideOpcodes(target.version);
  const table = OPCODE_ARG_TABLES[opcodeTableFor(target)];
  const opcode = wide ? cursor.word() : cursor.byte();

  // The condition opcode's word is read raw. Sending it through the table
  // decodes the *next* instruction at the wrong offset, and the resulting mess
  // is indistinguishable from a wrong table — so it is handled first.
  if (opcode === rawWordOpcode(target.version)) {
    return { opcode, operands: [{ kind: 'raw', value: cursor.word() }] };
  }

  const argumentString = table[opcode];
  if (argumentString === null || argumentString === undefined) {
    throw new AgosDecodeError(
      `opcode ${opcode} has no entry in the ${opcodeTableFor(target)} table`,
      cursor.offset,
    );
  }

  const operands: AgosOperand[] = [];
  for (const letter of argumentString) {
    if (letter === ' ') break;
    operands.push(readOperand(cursor, letter, wide));
  }
  return { opcode, operands };
}

function writeInstruction(writer: Writer, instruction: AgosInstruction, target: AgosTarget): void {
  const wide = hasWideOpcodes(target.version);
  if (wide) writer.word(instruction.opcode);
  else writer.byte(instruction.opcode);
  for (const operand of instruction.operands) writeOperand(writer, operand, wide);
}

function readLine(cursor: Cursor, target: AgosTarget, isVerbTable: boolean): AgosSubroutineLine {
  const wide = hasWideOpcodes(target.version);
  let guard: AgosSubroutineLine['guard'];
  let padding: AgosSubroutineLine['padding'];

  if (isVerbTable) {
    guard = { verb: cursor.word(), noun1: cursor.word(), noun2: cursor.word() };
  } else if (wide) {
    padding = [cursor.word(), cursor.word(), cursor.word()];
  }

  const terminator = lineTerminator(target.version);
  const instructions: AgosInstruction[] = [];
  for (;;) {
    const at = cursor.offset;
    const next = wide ? cursor.word() : cursor.byte();
    if (next === terminator) break;
    cursor.offset = at;
    instructions.push(readInstruction(cursor, target));
  }
  return { ...(guard ? { guard } : {}), ...(padding ? { padding } : {}), instructions };
}

function writeLine(
  writer: Writer,
  line: AgosSubroutineLine,
  target: AgosTarget,
  isVerbTable: boolean,
): void {
  const wide = hasWideOpcodes(target.version);
  if (isVerbTable) {
    if (!line.guard) throw new Error('a line of the verb table has no guard to write');
    writer.word(line.guard.verb);
    writer.word(line.guard.noun1);
    writer.word(line.guard.noun2);
  } else if (wide) {
    const padding = line.padding ?? [0, 0, 0];
    for (const value of padding) writer.word(value);
  }
  for (const instruction of line.instructions) writeInstruction(writer, instruction, target);
  const terminator = lineTerminator(target.version);
  if (wide) writer.word(terminator);
  else writer.byte(terminator);
}

/**
 * Reads a whole block of Subroutines.
 *
 * The shape on disk is a run of `0x0000`-introduced records: a zero word means
 * "another Subroutine follows", and a zero word inside one means "another line
 * follows". Anything else ends the run and is kept so it can be written back.
 */
export function readSubroutineBlock(
  data: Uint8Array,
  target: AgosTarget,
  startOffset = 0,
): { block: AgosSubroutineBlock; endOffset: number } {
  const cursor = new Cursor(data);
  cursor.offset = startOffset;
  const subroutines: AgosSubroutine[] = [];

  let blockMarker = cursor.word();
  while (blockMarker === 0) {
    const id = cursor.word();
    const lines: AgosSubroutineLine[] = [];
    let lineMarker = cursor.word();
    while (lineMarker === 0) {
      lines.push(readLine(cursor, target, id === 0));
      lineMarker = cursor.word();
    }
    subroutines.push({ id, lines, endMarker: lineMarker });
    blockMarker = cursor.word();
  }

  return { block: { subroutines, endMarker: blockMarker }, endOffset: cursor.offset };
}

/** Writes a block back, byte for byte, from what `readSubroutineBlock` kept. */
export function writeSubroutineBlock(block: AgosSubroutineBlock, target: AgosTarget): Uint8Array {
  const writer = new Writer();
  for (const subroutine of block.subroutines) {
    writer.word(0);
    writer.word(subroutine.id);
    for (const line of subroutine.lines) {
      writer.word(0);
      writeLine(writer, line, target, subroutine.id === 0);
    }
    writer.word(subroutine.endMarker);
  }
  writer.word(block.endMarker);
  return writer.finish();
}
