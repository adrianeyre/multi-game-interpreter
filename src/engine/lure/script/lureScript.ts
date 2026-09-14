/**
 * Disassembles Lure of the Temptress's script bytecode.
 *
 * This is **Disassembly** and not **Decompilation** (`CONTEXT.md`), which is
 * where ADR 0025 puts a Virtual Theatre Project's bytecode: "bytecode is
 * Disassembly until each encoding says otherwise". Until this file existed
 * Lure's bytecode was not read at all — `LureEngine` reads the eight
 * containers and the world state and runs nothing — so this is the first thing
 * in this family to look at an instruction.
 *
 * ## The encoding, and the bit that makes it unlike every other family here
 *
 * An instruction is **one byte, or three**. The byte is not the opcode: its
 * **low bit is a has-parameter flag** and the opcode is what is left after
 * shifting it off. When the flag is set, a 16-bit little-endian parameter
 * follows.
 *
 *     byte 0x0d  ->  flag 1, opcode 6 (notEquals), then two more bytes
 *     byte 0x0c  ->  flag 0, opcode 6 (notEquals), and nothing follows
 *
 * So the same opcode appears as two different bytes depending on whether it
 * carries an operand, and **reading the byte as the opcode gives a listing
 * that is wrong in a way that still decodes** — every value is doubled and the
 * lengths are all one. That is the trap this encoding sets, and it is why the
 * shift is named here rather than folded into a table lookup.
 *
 * ## Where the scripts are
 *
 * Two resources, and both are one blob rather than a directory of scripts:
 * `0x3f0c` and `0x3f0d`. There is no length and no index inside them — an
 * entry point is an offset somebody else supplies, and a script ends when it
 * runs an `abort`. So a caller disassembles *from an offset*, and this file
 * deliberately offers no "read every script" function, because the set of
 * entry points is not in the script data and inventing one by walking from
 * zero would produce a listing whose first wrong byte desynchronises the rest
 * with nothing to say so.
 *
 * ## Where the bytecode is not, by measurement
 *
 * ADR 0033 refused `0x3f0c`/`0x3f0d` as `lure.dat`'s own numbering — nothing in
 * `0x3f00`-`0x3fff` is on any shipped disk — and asked for the directory to be
 * **derived from the shipped bytes instead**. Three shape-based derivations
 * have now been tried against the shipped data and all three failed. Their
 * numbers are here so nobody spends the day again:
 *
 * 1. **Every container resource, disassembled from offset 0.** 626 resources;
 *    17 reach an `abort` with every opcode nameable. All 17 are noise: each
 *    consumes between 5 and 19 bytes of a resource of 1,395 to 73,692. `abort`
 *    is opcode 0, so any resource with a zero byte near the front satisfies
 *    this by chance, which makes the test far too weak to locate anything.
 * 2. **Every container resource, tiled.** ADR 0033's own strongest gate — the
 *    resources tile without overlapping and the last ends where the file does —
 *    applied by walking scripts back to back. One resource tiles completely and
 *    eleven pass halfway, and every one is degenerate for the same reason:
 *    `0x9bff` "tiles" 384 bytes into **189 scripts**, and the rest run to about
 *    1,000 scripts over 1,024 bytes. One instruction per script is a run of
 *    zeros, not a program.
 * 3. **`Lure.exe`, scanned for runs of substantial scripts** — at least twelve
 *    instructions each, at least one carrying a parameter, three or more in a
 *    row, which is what rules out the degeneracy above. One run in 136,956
 *    bytes: 141 bytes at `0x1d02b`, three scripts. **0.1% of the file**, and
 *    x86 decodes as almost anything, so that is incidental rather than a hit.
 *
 * **What that leaves is not another shape search.** The remaining route is the
 * one ADR 0024 names and `lureWorldState.ts` walked successfully for the world
 * state: read the **consuming routine** — find the code in `Lure.exe` that
 * loads a script pointer, and follow it to its data. That is an x86 disassembly
 * task rather than a pattern match, and it is the honest next step. Until it is
 * done this file has a reader and no located entry point, and the refusal
 * stands where ADR 0033 put it.
 */

import { LURE_OPCODE_COUNT, lureOpcodeName } from './opcodeNames.js';

/** The two resources holding script bytecode. Neither carries an index. */
export const LURE_SCRIPT_RESOURCE_ID = 0x3f0c;
export const LURE_SCRIPT2_RESOURCE_ID = 0x3f0d;

/** The opcode that ends a script. */
const OPCODE_ABORT = 0;

/** Thrown for bytecode this reader will not guess at. */
export class LureScriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LureScriptError';
  }
}

export interface LureInstruction {
  /** Where the instruction's first byte sits in the resource. */
  readonly offset: number;
  /** The opcode, after the has-parameter bit has been shifted off. */
  readonly opcode: number;
  /** The opcode's generated name, or its number where there is none. */
  readonly name: string;
  /** The 16-bit operand, where the low bit of the opcode byte asked for one. */
  readonly parameter: number | null;
  /** One or three. */
  readonly byteLength: number;
}

export interface LureScript {
  readonly entryOffset: number;
  readonly instructions: readonly LureInstruction[];
  /** Bytes from the entry point to just past the terminating `abort`. */
  readonly byteLength: number;
  /**
   * Opcode numbers in this script that the generated table has no name for.
   *
   * A non-empty list is a finding rather than a curiosity: either the entry
   * offset was not the start of an instruction, or the reference the names came
   * from is older than the game. A scatter of high numbers means the first.
   */
  readonly unnamedOpcodes: readonly number[];
}

/**
 * Disassembles one script, from `entryOffset` to its terminating `abort`.
 *
 * `limit` bounds a runaway walk. A script with no `abort` inside the limit is
 * refused by name rather than returned truncated: a truncated listing looks
 * like a short script, and "this did not terminate" is a different fact worth
 * a different message.
 */
export function disassembleLureScript(
  bytes: Uint8Array,
  entryOffset: number,
  limit = 4096,
): LureScript {
  if (entryOffset < 0 || entryOffset >= bytes.length) {
    throw new LureScriptError(
      `entry offset ${entryOffset} is outside the script resource (${bytes.length} bytes)`,
    );
  }

  const instructions: LureInstruction[] = [];
  const unnamed = new Set<number>();
  let at = entryOffset;

  for (let read = 0; read < limit; read += 1) {
    if (at >= bytes.length) {
      throw new LureScriptError(
        `the script at ${entryOffset} ran past the end of the resource at byte ${at} ` +
          `without reaching an abort`,
      );
    }

    const raw = bytes[at] as number;
    // The low bit is the flag and the rest is the opcode. Reading `raw` as the
    // opcode is the trap this encoding sets — see the note at the top.
    const hasParameter = (raw & 1) !== 0;
    const opcode = raw >> 1;

    let parameter: number | null = null;
    let byteLength = 1;
    if (hasParameter) {
      if (at + 3 > bytes.length) {
        throw new LureScriptError(
          `the instruction at byte ${at} asks for a parameter that runs past the end of the ` +
            `resource (${bytes.length} bytes)`,
        );
      }
      parameter = (bytes[at + 1] as number) | ((bytes[at + 2] as number) << 8);
      byteLength = 3;
    }

    if (opcode >= LURE_OPCODE_COUNT) unnamed.add(opcode);

    instructions.push({
      offset: at,
      opcode,
      name: lureOpcodeName(opcode),
      parameter,
      byteLength,
    });
    at += byteLength;

    if (opcode === OPCODE_ABORT) {
      return {
        entryOffset,
        instructions,
        byteLength: at - entryOffset,
        unnamedOpcodes: [...unnamed].sort((a, b) => a - b),
      };
    }
  }

  throw new LureScriptError(
    `the script at ${entryOffset} ran ${limit} instructions without reaching an abort`,
  );
}

/** One instruction as a line of a listing: address, name and operand. */
export function describeLureInstruction(instruction: LureInstruction): string {
  const operand = instruction.parameter === null ? '' : ` ${instruction.parameter}`;
  return `${String(instruction.offset).padStart(6)}  ${instruction.name}${operand}`;
}

/** A script as a listing, one instruction per line. */
export function disassembleLureListing(script: LureScript): string[] {
  return script.instructions.map(describeLureInstruction);
}

/**
 * Which opcodes a set of scripts uses, and how often.
 *
 * The shortlist an interpreter implements first, measured off the game rather
 * than off the size of the opcode space. Commonest first, because that is the
 * order the work is worth doing in.
 */
export function lureOpcodeHistogram(
  scripts: readonly LureScript[],
): { opcode: number; name: string; count: number }[] {
  const counts = new Map<number, number>();
  for (const script of scripts) {
    for (const instruction of script.instructions) {
      counts.set(instruction.opcode, (counts.get(instruction.opcode) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([opcode, count]) => ({ opcode, name: lureOpcodeName(opcode), count }))
    .sort((a, b) => b.count - a.count || a.opcode - b.opcode);
}
