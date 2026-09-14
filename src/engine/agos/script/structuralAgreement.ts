/**
 * The whole-game check that an AGOS argument table is the right one.
 *
 * `CONTEXT.md` calls this **Structural agreement**, and ADR 0029 makes it one of
 * the three things that have to be true before a game is offered for editing.
 *
 * ## What it is for
 *
 * An AGOS instruction's length comes from a table outside the bytecode, and
 * that table is this project's rather than the game's. ADR 0013 named the
 * failure that produces: decode with a wrong table and every boundary after the
 * first mismatch is wrong, then re-emit the misreading byte for byte and the
 * byte-identity check passes over a structure that is nonsense.
 *
 * AGOS fails that way *loudly*, which is the one advantage it has over AGI here.
 * Lines end on a terminator and Subroutines are introduced by a zero word, so a
 * decode that has lost its place walks into an opcode with no table entry, or
 * past the end of the data, or reads a terminator where a marker belongs. Over
 * hundreds of Subroutines it will do so almost immediately.
 *
 * ## What it is not
 *
 * Not a proof. A table can be wrong about an opcode no game uses, or wrong in a
 * way that happens to stay in step. `CONTEXT.md` says so in the term itself, and
 * the honest claim is the one ADR 0029 makes: a falsifier that runs over an
 * entire game before any of its behaviour is implemented — cheap, early, and
 * unable to prove the positive.
 */

import type { AgosTarget } from '../agosVersion.js';
import { AgosDecodeError, readSubroutineBlock, writeSubroutineBlock } from './subroutines.js';

export interface StructuralAgreementFinding {
  /** Where the block came from — a file name, or a resource number. */
  readonly source: string;
  readonly reason: string;
  /** The byte offset the decode stopped at, where there is one. */
  readonly offset?: number;
}

export interface StructuralAgreementReport {
  readonly blocksChecked: number;
  readonly subroutinesDecoded: number;
  readonly instructionsDecoded: number;
  readonly findings: readonly StructuralAgreementFinding[];
  /** True only when every block decoded and every block re-emitted identically. */
  readonly agrees: boolean;
}

export interface BytecodeBlock {
  readonly source: string;
  readonly data: Uint8Array;
  /** Where the block starts, for data that carries bytecode after a header. */
  readonly startOffset?: number;
}

/**
 * Checks every block of bytecode in a game against the Target's argument table.
 *
 * Re-emission is part of the check rather than a separate step, because a block
 * that decodes and does not write back identically has told you the same thing a
 * failed decode has: the model of it is incomplete. ADR 0030 needs that property
 * anyway — `GAMEPC` has no index, so it is rebuilt whole or not at all.
 */
export function checkStructuralAgreement(
  blocks: readonly BytecodeBlock[],
  target: AgosTarget,
): StructuralAgreementReport {
  const findings: StructuralAgreementFinding[] = [];
  let subroutinesDecoded = 0;
  let instructionsDecoded = 0;

  for (const block of blocks) {
    const start = block.startOffset ?? 0;
    try {
      const { block: decoded, endOffset } = readSubroutineBlock(block.data, target, start);
      subroutinesDecoded += decoded.subroutines.length;
      for (const subroutine of decoded.subroutines) {
        for (const line of subroutine.lines) instructionsDecoded += line.instructions.length;
      }

      const rewritten = writeSubroutineBlock(decoded, target);
      const original = block.data.subarray(start, endOffset);
      if (!sameBytes(original, rewritten)) {
        findings.push({
          source: block.source,
          reason: `re-emitted ${rewritten.length} bytes where ${original.length} were read, or the bytes differ`,
          offset: firstDifference(original, rewritten),
        });
      }
    } catch (error) {
      findings.push({
        source: block.source,
        reason: error instanceof Error ? error.message : String(error),
        ...(error instanceof AgosDecodeError ? { offset: error.offset } : {}),
      });
    }
  }

  return {
    blocksChecked: blocks.length,
    subroutinesDecoded,
    instructionsDecoded,
    findings,
    agrees: findings.length === 0,
  };
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function firstDifference(left: Uint8Array, right: Uint8Array): number {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    if (left[index] !== right[index]) return index;
  }
  return shared;
}
