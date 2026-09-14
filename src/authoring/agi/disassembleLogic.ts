/**
 * Reading AGI Logic bytecode back as a listing.
 *
 * `CONTEXT.md`'s **Disassembly**: a listing to be understood but not edited,
 * which "stops rather than guessing when an instruction's length cannot be
 * measured". That rule needs reading carefully for AGI, because an AGI
 * instruction's length is *never* measurable from the bytecode — it is always a
 * lookup in a table outside it. So the honest reading, and the one implemented
 * here, is: **stop when the Target does not name an interpreter, rather than
 * decode on a default.**
 *
 * Deliberately ahead of the interpreter. #115 put all the reading tools after
 * the engine and this reverses that, for the reason
 * `docs/processes/verifying-version-support.md` gives: building the AGI
 * interpreter without a way to read Logic is how v6 would have gone without
 * `descumm`.
 *
 * A sibling of `disassemble.ts` (v5) and `disassembleV6.ts` (v6 and v7), and a
 * sibling only. v7 reused v6's walker because v7 *is* v6's stack machine plus a
 * delta (ADR 0006); AGI has no delta with anything, so there is nothing to
 * share but the shape.
 */

import { hexWindow, readS16LE, readU16LE } from '../../engine/util/ByteStream.js';
import {
  GOTO,
  IF_END,
  IF_START,
  NOT,
  OR,
  SAID_OPCODE,
  actionAt,
  opcodeSetFor,
  testAt,
  type AgiOpcodeSet,
  type AgiOperandKind,
} from '../../engine/agi/script/opcodes.js';
import { describeTarget, type Target } from '../target.js';
import {
  readLogicMessages,
  type AgiLogicMessages,
} from '../../engine/agi/resource/logicMessages.js';

/** One operand, with what it means, so a listing can print `v12` or `f3`. */
export interface AgiOperand {
  kind: AgiOperandKind;
  value: number;
}

/** One term of an `if` condition. */
export interface AgiCondition {
  /** A plain test command. */
  kind: 'test' | 'said' | 'or' | 'unknown';
  /** The opcode, absent for an `or` group. */
  opcode?: number;
  name: string;
  operands: AgiOperand[];
  /** `not` applied to this term. */
  negated: boolean;
  /** `said`'s word group numbers, which are two bytes each. */
  words?: number[];
  /** An `or` group's terms, which are joined with `or` rather than `and`. */
  terms?: AgiCondition[];
}

export type AgiInstructionKind = 'action' | 'if' | 'goto' | 'unknown';

export interface AgiInstruction {
  offset: number;
  /** Bytes this instruction occupies, header and operands together. */
  size: number;
  kind: AgiInstructionKind;
  /** Absent for `if` and `goto`, which are structure rather than opcodes. */
  opcode?: number;
  name: string;
  operands: AgiOperand[];
  /** For an `if`: the condition list, already grouped and negated. */
  conditions?: AgiCondition[];
  /**
   * Where control goes when this instruction jumps.
   *
   * For an `if`, the offset reached when the condition is false — which is
   * where the block ends. For a `goto`, where it goes unconditionally. Both are
   * absolute offsets into the bytecode, worked out here so nothing downstream
   * has to redo the arithmetic that makes an `else` reconstructable.
   */
  target?: number;
}

export interface AgiLogicListing {
  readonly target: Target;
  readonly instructions: readonly AgiInstruction[];
  readonly messages: AgiLogicMessages;
  /** What the arity table was adjusted by, so a listing can be attributed. */
  readonly adjustments: readonly string[];
  /**
   * Why the walk stopped early, when it did.
   *
   * Absent means every byte of the code section decoded. Present means the
   * listing is incomplete and says where and why — never a resync on a guess,
   * because a resync produces a plausible listing of instructions that are not
   * there.
   */
  readonly stopped?: { offset: number; reason: string };
  /** Opcode numbers this build has no entry for, in the order met. */
  readonly unknownOpcodes: readonly number[];
}

export interface DisassembleOptions {
  /**
   * Whether the message table is obfuscated.
   *
   * False for a resource that arrived LZW-compressed. Ask the resource layer's
   * `wasCompressed` rather than guessing: getting it backwards turns every
   * message into noise.
   */
  encryptedMessages?: boolean;
  /** A pre-built opcode set, so a whole game shares one rather than one each. */
  opcodes?: AgiOpcodeSet;
}

/**
 * Refuses a Target that cannot name an instruction's length.
 *
 * This is `CONTEXT.md`'s "stops rather than guessing", moved to the only place
 * it can live for AGI. `parseTarget` already refuses an interpreter version
 * outside the DOS band, so what is left to refuse here is the wrong family
 * entirely — a programming error rather than a data one, and worth saying so.
 */
function opcodesFor(target: Target, options: DisassembleOptions): AgiOpcodeSet {
  if (options.opcodes) return options.opcodes;
  if (target.engine !== 'agi') {
    throw new Error(
      `${describeTarget(target)} is not AGI, so its bytecode cannot be read as ` +
        `AGI Logic. An instruction's argument count comes from a table keyed on ` +
        `an AGI interpreter version, and there is no such version here.`,
    );
  }
  return opcodeSetFor(target);
}

/**
 * Reads one Logic resource as a listing.
 *
 * The walk is linear over the code section and never resyncs. Every byte is
 * either an instruction this build knows, an `if`/`goto` structure byte, or a
 * reason to stop — which is what makes the listing's completeness a fact rather
 * than an impression.
 */
export function disassembleLogic(
  bytes: Uint8Array,
  target: Target,
  options: DisassembleOptions = {},
): AgiLogicListing {
  const opcodes = opcodesFor(target, options);
  const messages = readLogicMessages(bytes, options.encryptedMessages ?? true);

  const instructions: AgiInstruction[] = [];
  const unknownOpcodes: number[] = [];
  let stopped: { offset: number; reason: string } | undefined;

  // The code section runs from just past the length field to the message
  // section, which is where `readLogicMessages` says it ends.
  const start = 2;
  const end = messages.sectionAt;
  let at = start;

  const stop = (offset: number, reason: string): void => {
    stopped = { offset, reason: `${reason}\n${hexWindow(bytes, offset)}` };
  };

  while (at < end) {
    const opcode = bytes[at];

    if (opcode === IF_START) {
      const parsed = readIf(bytes, at, end, opcodes);
      if ('reason' in parsed) {
        stop(parsed.offset, parsed.reason);
        break;
      }
      instructions.push(parsed.instruction);
      at += parsed.instruction.size;
      continue;
    }

    if (opcode === GOTO) {
      if (at + 3 > end) {
        stop(
          at,
          `A goto at ${at} needs two bytes of displacement and the code section ends at ${end}.`,
        );
        break;
      }
      // Signed, and measured from the byte after the displacement — so a
      // backwards jump (which is how AGI writes a loop) is negative.
      const displacement = readS16LE(bytes, at + 1);
      instructions.push({
        offset: at,
        size: 3,
        kind: 'goto',
        name: 'goto',
        operands: [{ kind: 'number', value: displacement }],
        target: at + 3 + displacement,
      });
      at += 3;
      continue;
    }

    const action = actionAt(opcodes, opcode);
    if (!action) {
      // Never skipped. An unknown opcode has an unknown length, so there is no
      // safe next byte to try — continuing would produce a listing of
      // instructions that are not in the resource (#126).
      unknownOpcodes.push(opcode);
      instructions.push({
        offset: at,
        size: 1,
        kind: 'unknown',
        opcode,
        name: `unknown 0x${opcode.toString(16).padStart(2, '0')}`,
        operands: [],
      });
      stop(
        at,
        `Opcode 0x${opcode.toString(16).padStart(2, '0')} at ${at} is not in ` +
          `${describeTarget(target)}'s instruction set, so how many operands it ` +
          `takes is unknown and the rest of this resource cannot be measured.`,
      );
      break;
    }

    const size = 1 + action.operands.length;
    if (at + size > end) {
      stop(
        at,
        `${action.name} at ${at} takes ${action.operands.length} operands, which ` +
          `would run past the end of the code section at ${end}.`,
      );
      break;
    }

    instructions.push({
      offset: at,
      size,
      kind: 'action',
      opcode,
      name: action.name,
      operands: action.operands.map((kind, index) => ({ kind, value: bytes[at + 1 + index] })),
    });
    at += size;
  }

  return {
    target,
    instructions,
    messages,
    adjustments: opcodes.adjustments,
    stopped,
    unknownOpcodes,
  };
}

type IfResult = { instruction: AgiInstruction } | { offset: number; reason: string };

/**
 * Reads an `if` header: its condition list and where it jumps when false.
 *
 * The encoding is `FF <conditions> FF <lo> <hi>`, where the 16-bit value is how
 * many bytes to skip when the condition is false, measured from just after it.
 * The same `FF` opens the list and closes it, which is why the two are read by
 * position rather than by value.
 */
function readIf(bytes: Uint8Array, start: number, end: number, opcodes: AgiOpcodeSet): IfResult {
  let at = start + 1;
  const conditions: AgiCondition[] = [];
  let negateNext = false;
  /** The `or` group being collected, or null outside one. */
  let orGroup: AgiCondition[] | null = null;

  for (;;) {
    if (at >= end) {
      return {
        offset: start,
        reason: `An if at ${start} runs to the end of the code section without closing.`,
      };
    }

    const byte = bytes[at];

    if (byte === IF_END) {
      // Closing FF, then the two-byte forward jump.
      if (at + 3 > end) {
        return {
          offset: at,
          reason: `An if at ${start} closes at ${at} without room for its two-byte jump.`,
        };
      }
      if (orGroup) {
        return {
          offset: at,
          reason: `An if at ${start} closes while an "or" group opened earlier is still open.`,
        };
      }
      const skip = readU16LE(bytes, at + 1);
      const size = at + 3 - start;
      return {
        instruction: {
          offset: start,
          size,
          kind: 'if',
          name: 'if',
          operands: [{ kind: 'number', value: skip }],
          conditions,
          target: start + size + skip,
        },
      };
    }

    if (byte === NOT) {
      negateNext = !negateNext;
      at++;
      continue;
    }

    if (byte === OR) {
      // One FC opens an `or` group and the next closes it. AGI has no nesting
      // here, so a second open inside one is malformed rather than deeper.
      if (orGroup) {
        conditions.push({
          kind: 'or',
          name: 'or',
          operands: [],
          negated: false,
          terms: orGroup,
        });
        orGroup = null;
      } else {
        orGroup = [];
      }
      at++;
      continue;
    }

    const term = readCondition(bytes, at, end, opcodes, negateNext);
    if ('reason' in term) return term;
    negateNext = false;

    if (orGroup) orGroup.push(term.condition);
    else conditions.push(term.condition);
    at += term.size;
  }
}

type ConditionResult =
  { condition: AgiCondition; size: number } | { offset: number; reason: string };

function readCondition(
  bytes: Uint8Array,
  at: number,
  end: number,
  opcodes: AgiOpcodeSet,
  negated: boolean,
): ConditionResult {
  const opcode = bytes[at];

  if (opcode === SAID_OPCODE) {
    // `said` is the one self-describing instruction in AGI: its length is a
    // count byte in the stream, then that many 16-bit word group numbers.
    // Every other opcode's length comes from the table.
    if (at + 2 > end) {
      return { offset: at, reason: `A said at ${at} has no room for its word count.` };
    }
    const count = bytes[at + 1];
    const size = 2 + count * 2;
    if (at + size > end) {
      return {
        offset: at,
        reason:
          `A said at ${at} names ${count} word groups, which needs ${size} bytes ` +
          `and the code section ends at ${end}.`,
      };
    }
    const words: number[] = [];
    for (let index = 0; index < count; index++) words.push(readU16LE(bytes, at + 2 + index * 2));
    return {
      size,
      condition: {
        kind: 'said',
        opcode,
        name: 'said',
        operands: [],
        negated,
        words,
      },
    };
  }

  const test = testAt(opcodes, opcode);
  if (!test) {
    return {
      offset: at,
      reason:
        `Condition opcode 0x${opcode.toString(16).padStart(2, '0')} at ${at} is not ` +
        `a test command in this build's set, so its operand count is unknown.`,
    };
  }

  const size = 1 + test.operands.length;
  if (at + size > end) {
    return {
      offset: at,
      reason:
        `${test.name} at ${at} takes ${test.operands.length} operands, which would ` +
        `run past the end of the code section at ${end}.`,
    };
  }

  return {
    size,
    condition: {
      kind: 'test',
      opcode,
      name: test.name,
      operands: test.operands.map((kind, index) => ({ kind, value: bytes[at + 1 + index] })),
      negated,
    },
  };
}

// ------------------------------------------------------------- formatting --

function formatOperand(operand: AgiOperand): string {
  switch (operand.kind) {
    case 'variable':
      return `v${operand.value}`;
    case 'flag':
      return `f${operand.value}`;
    case 'message':
      return `m${operand.value}`;
    case 'string':
      return `s${operand.value}`;
    case 'object':
      return `o${operand.value}`;
    case 'item':
      return `i${operand.value}`;
    case 'controller':
      return `c${operand.value}`;
    case 'word':
      return `w${operand.value}`;
    default:
      return String(operand.value);
  }
}

function formatCondition(condition: AgiCondition): string {
  if (condition.kind === 'or') {
    return `(${(condition.terms ?? []).map(formatCondition).join(' || ')})`;
  }
  const negate = condition.negated ? '!' : '';
  if (condition.kind === 'said') {
    return `${negate}said(${(condition.words ?? []).map((word) => `w${word}`).join(', ')})`;
  }
  return `${negate}${condition.name}(${condition.operands.map(formatOperand).join(', ')})`;
}

/**
 * A listing a person reads.
 *
 * Offsets first, because every jump in the resource is expressed as one and a
 * listing without them cannot be checked against the bytes.
 */
export function formatLogicListing(listing: AgiLogicListing): string {
  const lines: string[] = [];

  lines.push(`; ${describeTarget(listing.target)}`);
  for (const adjustment of listing.adjustments) lines.push(`; arity: ${adjustment}`);

  for (const instruction of listing.instructions) {
    const at = String(instruction.offset).padStart(5);
    if (instruction.kind === 'if') {
      const conditions = (instruction.conditions ?? []).map(formatCondition).join(' && ');
      lines.push(`${at}  if (${conditions}) goto ${instruction.target}`);
      continue;
    }
    if (instruction.kind === 'goto') {
      lines.push(`${at}  goto ${instruction.target}`);
      continue;
    }
    lines.push(`${at}  ${instruction.name}(${instruction.operands.map(formatOperand).join(', ')})`);
  }

  if (listing.stopped) {
    lines.push(`; STOPPED at ${listing.stopped.offset}: ${listing.stopped.reason}`);
  }

  const messages = listing.messages.texts
    .map((text, number) => (text === undefined ? null : `; m${number} = ${JSON.stringify(text)}`))
    .filter((line): line is string => line !== null);
  if (messages.length > 0) lines.push('', ...messages);

  return lines.join('\n');
}
