import type { Action } from './actions.js';
import { toBase64 } from './base64.js';
import {
  disassembleClassic,
  formatClassicListing,
  type ClassicVersion,
} from './disassembleClassic.js';
import { disassembleV6, disassembleV7, disassembleV8, formatV6Listing } from './disassembleV6.js';

/**
 * Brings a published game's script into a project.
 *
 * The script arrives as one preserved block carrying both its bytes and a
 * reading of them, and for every Version this project supports that reading is
 * now a *complete* one: one row per instruction, each with its own measured
 * length, re-emitting byte for byte.
 *
 * That was not always true, and the reason it was not is worth keeping. This
 * file used to say:
 *
 * > In SCUMM v5 many opcodes carry argument lists, sub-opcodes or inline
 * > strings whose lengths cannot be derived from the encoding, and a single
 * > wrong length shifts every boundary after it. Bytes split in the wrong place
 * > do not compile to the same game — they compile to a different one,
 * > silently.
 *
 * Every clause of that is true. What it got wrong is the conclusion: lengths
 * that cannot be *derived* can still be *measured*, and `disassembleClassic`
 * measures them, one opcode at a time, against the interpreter that has been
 * running these scripts correctly for a year. Splitting waited until they were,
 * which was the right order to do it in.
 *
 * The two encodings still get separate readers, because they share no decoding
 * at all (`CONTEXT.md`): the Classic reader walks operand modes packed into the
 * opcode byte, and the Stack reader walks pushes.
 */

export interface DecompiledScript {
  actions: Action[];
  /** Instructions the reader could follow. */
  readable: number;
  /** True when the reading stopped before the end of the script. */
  partial: boolean;
}

/**
 * Which encoding's reader to use, named by Version.
 *
 * Defaults to v5, as every caller did before v6 existed. v2, v3 and v4 select
 * the Classic reader with their own opcode table; 6 and 7 select the Stack one.
 */
export type ScriptDialect = 2 | 3 | 4 | 5 | 6 | 7 | 8;

function isClassic(dialect: ScriptDialect): dialect is ClassicVersion {
  return dialect <= 5;
}

export function decompileScript(
  code: Uint8Array,
  label?: string,
  dialect: ScriptDialect = 5,
): DecompiledScript {
  if (code.length === 0) return { actions: [], readable: 0, partial: false };

  const classic = isClassic(dialect);
  // v7 shares v6's opcode numbering and disagrees with it about how an inline
  // message is measured, so reading v7 bytes with the v6 reader is wrong only
  // where a script talks — which is most of them, and silently.
  const listing = classic
    ? disassembleClassic(code, dialect)
    : dialect === 8
      ? disassembleV8(code)
      : dialect === 7
        ? disassembleV7(code)
        : disassembleV6(code);
  const partial = listing.undecodedFrom !== null;

  const note = partial
    ? `${label ? `${label}. ` : ''}Read as far as it could be followed; the rest is kept exactly as the game had it.`
    : label;

  return {
    actions: [
      {
        type: 'raw',
        listing: classic
          ? formatClassicListing(listing as ReturnType<typeof disassembleClassic>, code)
          : formatV6Listing(listing as ReturnType<typeof disassembleV6>, code),
        bytes: toBase64(code),
        ...(note ? { note } : {}),
      },
    ],
    readable: listing.instructions.length,
    partial,
  };
}
