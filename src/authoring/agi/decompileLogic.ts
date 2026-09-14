/**
 * Decompiling Logic bytecode into a typed tree, and emitting it back.
 *
 * `CONTEXT.md` separates **Disassembly** — a listing to be understood — from
 * **Decompilation**, "reconstructing bytecode into editable structure a Project
 * can hold and an assembler can re-emit". This is the stronger claim, and it is
 * the one #115 hangs its justification on: AGI can clear a bar the SCUMM editor
 * structurally cannot, full round-trip with no **Preserved bytes**.
 *
 * Per ADR 0013 **the tree is the truth**, not source text. Text is a *view*.
 * Storing text would be diffable and would match the dialect the AGI community
 * types, but it makes byte-identity a property of a text round trip and needs a
 * full parser before anything can be edited at all.
 *
 * ## Byte-identity is necessary and not sufficient
 *
 * The sharpest thing in ADR 0013, and it changes what this file can claim.
 * Decode a Logic with the wrong arity table and every boundary after the first
 * mismatch is wrong — an instruction swallows the opcode that follows it. Re-emit
 * with the **same wrong table** and it writes that misreading back byte for
 * byte. The check passes. The tree is nonsense. The Unrecovered count reads
 * zero.
 *
 * So this module's round-trip proves that nothing was *lost*. It does not prove
 * anything was *understood*, and the thing that does is positive identification
 * of the interpreter version — which happens before a game is offered for
 * editing at all (`describeUneditableTarget`), not here.
 */

import type { Target } from '../target.js';
import {
  disassembleLogic,
  type AgiCondition,
  type AgiInstruction,
  type AgiLogicListing,
  type AgiOperand,
} from './disassembleLogic.js';
import { writeLogicMessages } from '../../engine/agi/resource/logicMessages.js';

/**
 * One step of a decompiled Logic.
 *
 * Every statement carries the offset it was decompiled from, when it was
 * decompiled from anything. That is what lets a `goto` be re-emitted: its
 * target is an offset in the *original* bytecode, so emission has to know where
 * each original offset landed in the new output. A statement an author wrote
 * from nothing has no offset, and a jump to one is refused rather than guessed.
 */
export type AgiStatement =
  | { kind: 'command'; offset?: number; opcode: number; name: string; operands: AgiOperand[] }
  | {
      kind: 'if';
      offset?: number;
      conditions: AgiCondition[];
      then: AgiStatement[];
      /** Empty when the source had no `else`, which is the common case. */
      otherwise: AgiStatement[];
    }
  /**
   * A jump the structuring pass could not fold into an `if` or an `else`.
   *
   * Kept rather than dropped, and kept as an *absolute* target so re-emission
   * can restore it. A Logic containing one is still round-trippable; it is just
   * not fully structured, which is a weaker claim than the rest of the tree and
   * is why it has its own kind rather than being smuggled in as a command.
   */
  | { kind: 'goto'; offset?: number; target: number };

export interface AgiLogicTree {
  readonly statements: AgiStatement[];
  /** The Logic's own messages, 1-indexed as `print` addresses them. */
  readonly messages: Array<string | undefined>;
  /** Whether the message table was obfuscated, which a re-emit must match. */
  readonly messagesEncrypted: boolean;
}

export interface DecompileResult {
  tree: AgiLogicTree | null;
  /**
   * Why this Logic is **Unrecovered**, or null when it decompiled.
   *
   * `CONTEXT.md`: a resource that could not be decompiled, or that re-emitted
   * as different bytes than it arrived as. Held as-is, shown read-only, and
   * counted. Deliberately not Preserved bytes — those are byte-identical *by
   * design* and will always exist in SCUMM, whereas an Unrecovered Logic is a
   * bug with a target of zero. The fix is a better decompiler, never a wider
   * fallback.
   */
  unrecovered: string | null;
  /** The listing, kept so the editor can show a read-only view either way. */
  listing: AgiLogicListing;
}

export interface DecompileOptions {
  encryptedMessages?: boolean;
}

/**
 * Decompiles one Logic, and checks its own work by re-emitting it.
 *
 * The check is not optional and not a debug mode: a tree that does not re-emit
 * to the bytes it came from is one an author must not be allowed to edit,
 * because their change would be written into a structure that was misread.
 */
export function decompileLogic(
  bytes: Uint8Array,
  target: Target,
  options: DecompileOptions = {},
): DecompileResult {
  const encrypted = options.encryptedMessages ?? true;
  const listing = disassembleLogic(bytes, target, { encryptedMessages: encrypted });

  if (listing.stopped) {
    return {
      tree: null,
      listing,
      unrecovered: `The disassembler stopped at ${listing.stopped.offset}: ${listing.stopped.reason}`,
    };
  }

  const structured = structure(listing.instructions);
  if ('reason' in structured) {
    return { tree: null, listing, unrecovered: structured.reason };
  }

  const tree: AgiLogicTree = {
    statements: structured.statements,
    messages: [...listing.messages.texts],
    messagesEncrypted: encrypted,
  };

  let emitted: Uint8Array;
  try {
    emitted = emitLogic(tree);
  } catch (error) {
    // One odd resource must not take the game down. ADR 0013 rejects "refusing
    // the whole game on any failure" explicitly, so an emitter that cannot
    // write this tree makes this one resource Unrecovered and nothing else.
    return {
      tree: null,
      listing,
      unrecovered: `This Logic could not be re-emitted: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  if (!sameBytes(emitted, bytes)) {
    return {
      tree: null,
      listing,
      unrecovered:
        `This Logic re-emitted as ${emitted.length} bytes where it arrived as ` +
        `${bytes.length}, or differed within them. It is held as its original ` +
        `bytes and shown read-only. ${describeFirstDifference(emitted, bytes)}`,
    };
  }

  return { tree, listing, unrecovered: null };
}

/**
 * Folds a flat instruction list into nested blocks.
 *
 * An `if` carries the offset control reaches when its condition is false, which
 * is where its block ends. An `else` is the shape where that block's last
 * instruction is a forward `goto` — so:
 *
 *   if (c) { A } else { B }
 *
 * compiles to `IF conds SKIP=len(A)+3` then `A` then `GOTO len(B)` then `B`,
 * and reading it back means noticing that the instruction immediately before
 * the if's target is a `goto` that lands after it. Anything else stays a
 * `goto` statement rather than being forced into a shape it is not, because
 * `if`/`else` reconstruction "verified by round-trip" (#133) means the round
 * trip decides, not the reader's optimism.
 */
function structure(
  instructions: readonly AgiInstruction[],
): { statements: AgiStatement[] } | { reason: string } {
  const byOffset = new Map<number, number>();
  for (const [index, instruction] of instructions.entries()) {
    byOffset.set(instruction.offset, index);
  }
  /** The offset just past the last instruction, which a jump may target. */
  const endOffset =
    instructions.length > 0
      ? instructions[instructions.length - 1].offset + instructions[instructions.length - 1].size
      : 0;

  /** Reads statements from `index` up to (not including) the instruction at `stop`. */
  function readBlock(
    index: number,
    stop: number,
  ): { statements: AgiStatement[]; next: number } | { reason: string } {
    const statements: AgiStatement[] = [];

    while (index < instructions.length) {
      const instruction = instructions[index];
      if (instruction.offset >= stop) break;

      if (instruction.kind === 'if') {
        const target = instruction.target!;
        const targetIndex = target === endOffset ? instructions.length : byOffset.get(target);
        if (targetIndex === undefined) {
          return {
            reason:
              `An if at ${instruction.offset} jumps to ${target}, which is not an ` +
              `instruction boundary. The block structure cannot be reconstructed.`,
          };
        }
        if (target > stop) {
          return {
            reason:
              `An if at ${instruction.offset} jumps to ${target}, past the end of ` +
              `the block it is inside. AGI blocks nest, so this does not.`,
          };
        }

        const thenBlock = readBlock(index + 1, target);
        if ('reason' in thenBlock) return thenBlock;

        // An `else` is the shape where the then-block ends with a forward goto
        // that lands past the if's own target.
        const last = thenBlock.statements[thenBlock.statements.length - 1];
        const lastInstruction = instructions[thenBlock.next - 1];
        let otherwise: AgiStatement[] = [];
        let next = thenBlock.next;

        if (
          last?.kind === 'goto' &&
          lastInstruction?.kind === 'goto' &&
          last.target > target &&
          last.target <= stop
        ) {
          // **The shape is a candidate, not a conclusion, and the bytecode can
          // refute it.** That trailing `goto` might be the else's own jump, or
          // it might be an ordinary `goto` that leaves the block — the two are
          // identical instructions and only what follows tells them apart. So
          // the else reading is *tried*, and kept only if the region it claims
          // structures.
          //
          // King's Quest III is where taking it on faith failed. Logic 66's
          // `if` at 678 is a plain `if` whose block ends with `goto 718`, and
          // reading that as an else claimed 698-717 as the else-block — inside
          // which the `if` at 701 jumps to 767, well past it. Three of the
          // game's Logics were Unrecovered on "an if jumps past the end of the
          // block it is inside", and in every one of them the block it was
          // said to be inside had been invented one step earlier.
          const elseEnd = last.target;
          const elseBlock = readBlock(thenBlock.next, elseEnd);
          if (!('reason' in elseBlock)) {
            // The goto is the else's own jump and is not a statement.
            thenBlock.statements.pop();
            otherwise = elseBlock.statements;
            next = elseBlock.next;
          }
        }

        statements.push({
          kind: 'if',
          offset: instruction.offset,
          conditions: instruction.conditions ?? [],
          then: thenBlock.statements,
          otherwise,
        });
        index = next;
        continue;
      }

      if (instruction.kind === 'goto') {
        statements.push({ kind: 'goto', offset: instruction.offset, target: instruction.target! });
        index++;
        continue;
      }

      if (instruction.kind === 'unknown') {
        return {
          reason: `An unknown opcode at ${instruction.offset} cannot be decompiled.`,
        };
      }

      statements.push({
        kind: 'command',
        offset: instruction.offset,
        opcode: instruction.opcode!,
        name: instruction.name,
        operands: instruction.operands,
      });
      index++;
    }

    return { statements, next: index };
  }

  const result = readBlock(0, Number.MAX_SAFE_INTEGER);
  if ('reason' in result) return result;
  return { statements: result.statements };
}

// ----------------------------------------------------------------- emitting --

/**
 * Turns a tree back into a Logic resource.
 *
 * Deterministic by construction: every statement has exactly one encoding, so
 * there is no choice to make and therefore no way for two runs to disagree.
 * That is what makes byte-identity a testable property of one resource rather
 * than a property of the whole pipeline (ADR 0013).
 */
export function emitLogic(tree: AgiLogicTree): Uint8Array {
  const code = emitCode(tree.statements);
  const messages = writeLogicMessages(tree.messages, tree.messagesEncrypted);

  const out = new Uint8Array(2 + code.length + messages.length);
  out[0] = code.length & 0xff;
  out[1] = (code.length >> 8) & 0xff;
  out.set(code, 2);
  out.set(messages, 2 + code.length);
  return out;
}

/** The two structure bytes, named so the emitter reads like the format. */
const IF_BYTE = 0xff;
const GOTO_BYTE = 0xfe;

/** A `goto` whose displacement is not known until every statement is placed. */
interface PendingJump {
  /** Where the two-byte displacement sits in the output. */
  at: number;
  /** The offset in the *original* bytecode this jump goes to. */
  target: number;
}

/**
 * Emits the code section, resolving jumps in a second pass.
 *
 * A `goto`'s displacement is measured from the byte after it and its target is
 * an absolute offset in the original resource, so it cannot be written until
 * every statement has been placed. The first pass emits a placeholder and
 * records where each *original* offset landed; the second patches.
 *
 * This is why statements carry their original offset. The alternative — leaving
 * a `goto` unemittable and marking any Logic containing one Unrecovered — was
 * the first attempt, and a real fan game showed why it is no good: 56 of its 86
 * Logic resources contain jumps, so the count would have measured a known gap
 * in this emitter rather than anything about the game. A count that reports a
 * defect of ours as a property of the data is worse than no count (ADR 0013).
 */
function emitCode(statements: readonly AgiStatement[]): number[] {
  const out: number[] = [];
  const jumps: PendingJump[] = [];
  /** Original offset to where it landed here. Identity when nothing changed. */
  const placed = new Map<number, number>();

  const walk = (list: readonly AgiStatement[]): void => {
    for (const statement of list) {
      if (statement.offset !== undefined) placed.set(statement.offset, out.length);

      switch (statement.kind) {
        case 'command':
          out.push(statement.opcode, ...statement.operands.map((operand) => operand.value & 0xff));
          break;

        case 'goto':
          out.push(GOTO_BYTE);
          jumps.push({ at: out.length, target: statement.target });
          out.push(0, 0);
          break;

        case 'if': {
          // A block's length is not known until it is emitted, so the skip is
          // written back after the body rather than computed before it.
          out.push(IF_BYTE, ...emitConditions(statement.conditions), IF_BYTE);
          const skipAt = out.length;
          out.push(0, 0);

          const bodyStart = out.length;
          walk(statement.then);

          if (statement.otherwise.length === 0) {
            const skip = out.length - bodyStart;
            out[skipAt] = skip & 0xff;
            out[skipAt + 1] = (skip >> 8) & 0xff;
            break;
          }

          // With an else, the false branch skips the body *and* the goto that
          // ends it — three more bytes.
          out.push(GOTO_BYTE);
          const elseSkipAt = out.length;
          out.push(0, 0);

          const skip = out.length - bodyStart;
          out[skipAt] = skip & 0xff;
          out[skipAt + 1] = (skip >> 8) & 0xff;

          const elseStart = out.length;
          walk(statement.otherwise);
          const elseSkip = out.length - elseStart;
          out[elseSkipAt] = elseSkip & 0xff;
          out[elseSkipAt + 1] = (elseSkip >> 8) & 0xff;
          break;
        }
      }
    }
  };

  walk(statements);

  const endOfCode = highestOffset(statements);
  for (const jump of jumps) {
    // A jump to the end of the code is legitimate and has no statement of its
    // own to have been placed, so it resolves against the output's length.
    const landed = placed.get(jump.target) ?? (jump.target > endOfCode ? out.length : undefined);
    if (landed === undefined) {
      throw new Error(
        `A goto targets offset ${jump.target}, which is not the start of any ` +
          `statement in this Logic. The statement it jumped to has been removed, ` +
          `and there is no honest displacement to write.`,
      );
    }
    // Measured from the byte after the displacement.
    const displacement = landed - (jump.at + 2);
    out[jump.at] = displacement & 0xff;
    out[jump.at + 1] = (displacement >> 8) & 0xff;
  }

  return out;
}

/** The last original offset in a tree, so a jump past it is the code's end. */
function highestOffset(statements: readonly AgiStatement[]): number {
  let highest = -1;
  const walk = (list: readonly AgiStatement[]): void => {
    for (const statement of list) {
      if (statement.offset !== undefined) highest = Math.max(highest, statement.offset);
      if (statement.kind === 'if') {
        walk(statement.then);
        walk(statement.otherwise);
      }
    }
  };
  walk(statements);
  return highest;
}

function emitConditions(conditions: readonly AgiCondition[]): number[] {
  const out: number[] = [];
  for (const condition of conditions) {
    if (condition.kind === 'or') {
      out.push(0xfc);
      for (const term of condition.terms ?? []) out.push(...emitCondition(term));
      out.push(0xfc);
      continue;
    }
    out.push(...emitCondition(condition));
  }
  return out;
}

function emitCondition(condition: AgiCondition): number[] {
  const out: number[] = [];
  if (condition.negated) out.push(0xfd);

  if (condition.kind === 'said') {
    const words = condition.words ?? [];
    out.push(0x0e, words.length);
    for (const word of words) out.push(word & 0xff, (word >> 8) & 0xff);
    return out;
  }

  out.push(condition.opcode!, ...condition.operands.map((operand) => operand.value & 0xff));
  return out;
}

// --------------------------------------------------------------- structuring --

/**
 * Re-emits a tree that contains unstructured `goto`s.
 *
 * Kept separate from `emitStatement` because it needs a second pass: a goto's
 * displacement depends on where every statement lands, and where they land
 * depends on the sizes of the statements before them. A tree with no gotos —
 * which is almost all of them — never reaches this.
 */
export function treeHasUnstructuredJumps(tree: AgiLogicTree): boolean {
  const walk = (statements: readonly AgiStatement[]): boolean =>
    statements.some((statement) => {
      if (statement.kind === 'goto') return true;
      if (statement.kind === 'if') return walk(statement.then) || walk(statement.otherwise);
      return false;
    });
  return walk(tree.statements);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
  return true;
}

/** Where two byte strings first differ, for an Unrecovered report. */
function describeFirstDifference(emitted: Uint8Array, original: Uint8Array): string {
  const shortest = Math.min(emitted.length, original.length);
  for (let index = 0; index < shortest; index++) {
    if (emitted[index] === original[index]) continue;
    return (
      `First difference at byte ${index}: emitted ` +
      `0x${emitted[index].toString(16).padStart(2, '0')}, original ` +
      `0x${original[index].toString(16).padStart(2, '0')}.`
    );
  }
  return `The first ${shortest} bytes match and the lengths differ.`;
}

// ------------------------------------------------------------- a source view --

/**
 * The tree as AGI-style source, for reading and for the editor.
 *
 * A **view** over the tree, not the stored form (ADR 0013). Nothing parses this
 * back: editing happens on the tree, and this is what an author reads while
 * doing it.
 */
export function formatLogicTree(tree: AgiLogicTree): string {
  const lines: string[] = [];

  const formatOperand = (operand: AgiOperand): string => {
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
  };

  const formatCondition = (condition: AgiCondition): string => {
    if (condition.kind === 'or') {
      return `(${(condition.terms ?? []).map(formatCondition).join(' || ')})`;
    }
    const negate = condition.negated ? '!' : '';
    if (condition.kind === 'said') {
      return `${negate}said(${(condition.words ?? []).map((word) => `w${word}`).join(', ')})`;
    }
    return `${negate}${condition.name}(${condition.operands.map(formatOperand).join(', ')})`;
  };

  const walk = (statements: readonly AgiStatement[], depth: number): void => {
    const pad = '  '.repeat(depth);
    for (const statement of statements) {
      if (statement.kind === 'command') {
        lines.push(`${pad}${statement.name}(${statement.operands.map(formatOperand).join(', ')});`);
        continue;
      }
      if (statement.kind === 'goto') {
        lines.push(`${pad}goto ${statement.target};`);
        continue;
      }
      lines.push(`${pad}if (${statement.conditions.map(formatCondition).join(' && ')}) {`);
      walk(statement.then, depth + 1);
      if (statement.otherwise.length > 0) {
        lines.push(`${pad}} else {`);
        walk(statement.otherwise, depth + 1);
      }
      lines.push(`${pad}}`);
    }
  };

  walk(tree.statements, 0);

  const messages = tree.messages
    .map((text, number) =>
      text === undefined ? null : `#message ${number} ${JSON.stringify(text)}`,
    )
    .filter((line): line is string => line !== null);
  if (messages.length > 0) lines.push('', ...messages);

  return lines.join('\n');
}
