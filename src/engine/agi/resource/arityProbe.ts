/**
 * Which arity table this game's own bytecode admits.
 *
 * **The problem ADR 0013 states.** An AGI instruction's argument count is not
 * in the bytecode; it comes from a table that varies by interpreter build.
 * Decode with the wrong table and every boundary after the first mismatch is
 * wrong — and re-emitting with the same wrong table writes the misreading back
 * byte for byte, so a round-trip check passes while the structure is nonsense.
 * So a game whose copy ships no `AGIDATA.OVL` and no interpreter was refused
 * for editing, and a great many dumps in circulation are exactly that.
 *
 * **What this adds.** ADR 0013's bar was *reading* a version out of the game.
 * There is a second way to clear it, and it is the one ADR 0020 takes for SCI:
 * probe. A wrong arity table is not quietly wrong, because AGI's bytecode has
 * three properties that a misread boundary breaks —
 *
 * 1. every byte of a Logic's code section is an instruction, an `if`/`goto`
 *    structure byte, or nothing at all;
 * 2. every opcode is in the build's table;
 * 3. every `if` and `goto` lands on an instruction boundary;
 * 4. every Logic's code section **ends on `return`**.
 *
 * — and the candidate space is tiny. On DOS there are **three** possible v2
 * tables (below 2.089, exactly 2.089, above it) and **two** v3 ones, because
 * every other difference the opcode set knows about is a platform's rather
 * than a build's.
 *
 * So: decode every Logic under every candidate, keep the ones that broke none
 * of the three, and say what happened. One survivor is an identification. Two
 * is a **narrowing**, reported as one and still a fallback — "one of these two"
 * is a guess between them, and this file's whole purpose is not to make one.
 *
 * **King's Quest III is the case this was written against, and the fourth check
 * is the one that settled it.** Its copy ships no `AGIDATA.OVL`. The first
 * three rule out the pre-2.089 table — five unknown opcodes, seven truncated
 * Logics, twenty jumps into the middle of an instruction — and leave 2.089 and
 * 2.917 both standing, differing only in `quit`'s arity. Nothing about a jump
 * or an opcode separates those two, because `quit`'s operand byte happens to
 * decode as a valid instruction: under 2.089 the game reads
 * `quit(); increment(254); decrement(0)` where under 2.917 it reads
 * `quit(1); goto`, and both are self-consistent.
 *
 * What is not self-consistent is where a Logic *ends*. Under 2.917 all 125 of
 * this game's Logics end their code section on `return`. Under 2.089 logic 98
 * ends on `increment` — its three bytes `86 01 00` read as `quit()` followed
 * by `increment(0)`, and then the section stops. A Logic that runs off the end
 * of its code has no `return` to stop the interpreter and would execute its own
 * message table, so that reading is refuted by the game rather than merely
 * disliked. **125 of 125 against 124 of 125 is the whole difference**, and it
 * is enough, which is why the check is worth its own arm.
 */

import { disassembleLogic } from '../../../authoring/agi/disassembleLogic.js';
import {
  agiMajor,
  type AgiPlatform,
  type InterpreterVersion,
  type Target,
} from '../../../authoring/target.js';
import { opcodeSetFor } from '../script/opcodes.js';

/** One candidate table, and what decoding the game under it did. */
export interface AgiArityCandidate {
  interpreter: InterpreterVersion;
  /** Instructions decoded across every Logic. */
  instructions: number;
  /** Opcode numbers this table has no entry for. */
  unknownOpcodes: number;
  /** Logics whose code section did not decode to the end. */
  truncated: number;
  /** Jumps that landed inside an instruction rather than on one. */
  strayJumps: number;
  /**
   * Logics whose code section does not end on `return`.
   *
   * Sierra's compiler ends every one with it, and the interpreter needs it: a
   * Logic that falls off the end of its code has nothing to stop it and reads
   * its own message table as instructions. So a table under which some Logic
   * lacks one is a table this game was not compiled against.
   */
  unterminated: number;
  /** Nothing broke, so this table is possible for this game. */
  consistent: boolean;
}

export interface AgiArityProbe {
  candidates: AgiArityCandidate[];
  /** The tables the bytecode did not rule out. */
  survivors: AgiArityCandidate[];
  /** Lines for the log, in the order they should be read. */
  notes: string[];
}

/**
 * The tables a DOS release could be using, one representative version each.
 *
 * Representatives rather than every declarable version, because the question is
 * which *table* the game admits and several versions share one: 2.272, 2.440
 * and 2.917 build the same table, so probing all three would report three
 * survivors that are one answer. `opcodeSetFor`'s own branches are the list of
 * what actually differs.
 */
function candidatesFor(major: number): InterpreterVersion[] {
  return major === 3
    ? [0x3086, 0x3149]
    : // Below 2.089, exactly 2.089, and above — the three arms of
      // `opcodeSetFor`'s v2 branch.
      [0x2072, 0x2089, 0x2917];
}

/**
 * What two surviving tables actually disagree about, by name.
 *
 * The point of saying it: "2.089 or 2.917" is a version number a reader cannot
 * act on, and "they differ only in `quit`'s arity, and this game calls `quit`
 * three times" is. Derived from the tables rather than written down, so it
 * cannot drift from `opcodeSetFor`.
 */
function disagreements(
  a: InterpreterVersion,
  b: InterpreterVersion,
  platform: AgiPlatform,
  gameId: string,
): string[] {
  const target = (interpreter: InterpreterVersion): Target => ({
    engine: 'agi',
    interpreter,
    platform,
    identification: 'declared',
    gameId,
  });
  const left = opcodeSetFor(target(a));
  const right = opcodeSetFor(target(b));
  const found: string[] = [];
  for (let code = 0; code < 256; code++) {
    const one = left.actions[code];
    const two = right.actions[code];
    if (!one || !two) continue;
    if (one.operands.length === two.operands.length && one.name === two.name) continue;
    found.push(
      `${one.name} (0x${code.toString(16)}) takes ${one.operands.length} argument(s) under ` +
        `${versionName(a)} and ${two.operands.length} under ${versionName(b)}`,
    );
  }
  return found;
}

function versionName(interpreter: InterpreterVersion): string {
  const build = (interpreter & 0x0fff).toString(16).padStart(3, '0');
  return agiMajor(interpreter) === 3 ? `3.002.${build}` : `2.${build}`;
}

/**
 * Decodes every Logic under every candidate table and reports what held.
 *
 * `logics` is the numbers the index carries and `read` hands over one's bytes,
 * so this needs no resource layer of its own — the caller already has one, and
 * a probe that opened the volumes again would be a second reading of them.
 */
export function probeArityTable(options: {
  major: number;
  platform: AgiPlatform;
  gameId: string;
  logics: readonly number[];
  read(logic: number): Uint8Array;
  encrypted(logic: number): boolean;
}): AgiArityProbe {
  const { major, platform, gameId, logics } = options;
  const candidates: AgiArityCandidate[] = [];

  for (const interpreter of candidatesFor(major)) {
    const target: Target = {
      engine: 'agi',
      interpreter,
      platform,
      identification: 'declared',
      gameId,
    };
    const opcodes = opcodeSetFor(target);

    let instructions = 0;
    let unknownOpcodes = 0;
    let truncated = 0;
    let strayJumps = 0;
    let unterminated = 0;

    for (const number of logics) {
      let listing;
      try {
        listing = disassembleLogic(options.read(number), target, {
          opcodes,
          encryptedMessages: options.encrypted(number),
        });
      } catch {
        // A resource that will not read at all is not evidence about the table,
        // so it is skipped rather than counted against every candidate equally.
        continue;
      }

      instructions += listing.instructions.length;
      unknownOpcodes += listing.unknownOpcodes.length;
      if (listing.stopped) truncated++;

      // **Where a Logic ends is the check the others cannot make.** An arity
      // that is wrong by one on a command the game calls twice can leave every
      // jump landing correctly — the operand byte decodes as a plausible
      // instruction — and still push the last instruction off the end. Only
      // counted for a Logic that decoded whole, because a truncated one has
      // already been counted against this table and its last instruction says
      // nothing.
      const ending = listing.instructions[listing.instructions.length - 1];
      if (!listing.stopped && ending && !(ending.kind === 'action' && ending.name === 'return')) {
        unterminated++;
      }

      // **The check that does most of the work.** An arity off by one shifts
      // every boundary after it, and the game's own jumps are measured in
      // absolute offsets — so they stop landing on instructions. A game's
      // bytecode disagreeing with itself is the evidence; nothing external is
      // consulted.
      const boundaries = new Set(listing.instructions.map((instruction) => instruction.offset));
      const last = listing.instructions[listing.instructions.length - 1];
      if (last) boundaries.add(last.offset + last.size);
      for (const instruction of listing.instructions) {
        if (instruction.target === undefined) continue;
        if (!boundaries.has(instruction.target)) strayJumps++;
      }
    }

    candidates.push({
      interpreter,
      instructions,
      unknownOpcodes,
      truncated,
      strayJumps,
      unterminated,
      consistent: unknownOpcodes === 0 && truncated === 0 && strayJumps === 0 && unterminated === 0,
    });
  }

  const survivors = candidates.filter((candidate) => candidate.consistent);
  const notes: string[] = [];

  for (const candidate of candidates) {
    notes.push(
      `arity probe ${versionName(candidate.interpreter)}: ${candidate.instructions} ` +
        `instructions, ${candidate.unknownOpcodes} unknown opcodes, ${candidate.truncated} ` +
        `Logics truncated, ${candidate.strayJumps} jumps into the middle of an instruction, ` +
        `${candidate.unterminated} Logics not ending on return` +
        `${candidate.consistent ? ' — possible' : ' — ruled out'}`,
    );
  }

  if (survivors.length === 1) {
    notes.push(
      `Only ${versionName(survivors[0].interpreter)}'s table decodes this game's own ` +
        `bytecode without contradicting it, so the interpreter is identified by probe rather ` +
        `than assumed.`,
    );
  } else if (survivors.length > 1) {
    notes.push(
      `${survivors.length} tables decode this game without contradicting it — ` +
        `${survivors.map((candidate) => versionName(candidate.interpreter)).join(' and ')} — so ` +
        `the version is narrowed rather than identified.`,
    );
    for (let index = 1; index < survivors.length; index++) {
      for (const line of disagreements(
        survivors[0].interpreter,
        survivors[index].interpreter,
        platform,
        gameId,
      )) {
        notes.push(`  they differ only here: ${line}`);
      }
    }
  } else {
    notes.push(
      `No candidate table decodes this game without contradicting it, which is a fault in ` +
        `this project's reading rather than a fact about the game — every shipped AGI game ` +
        `decoded under the table its own interpreter used.`,
    );
  }

  return { candidates, survivors, notes };
}
