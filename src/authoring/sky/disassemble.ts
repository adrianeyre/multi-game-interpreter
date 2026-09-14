/**
 * A Sky Compact record as a listing a person can read.
 *
 * `CONTEXT.md` separates **Disassembly** from **Decompilation**, and this is
 * neither — a Compact is data, not code, and this renders its named fields. It
 * is the analogue of `authoring/agos/disassemble.ts` for the object table rather
 * than the bytecode: names instead of a column of numbers, `xcood: 160` instead
 * of word 6.
 *
 * The names come from the same reference the reader's field table does
 * (`skyCompacts.ts`), so a listing and an edit agree about what a field is
 * called. A record shorter than the field list stops where the record stops,
 * which is the difference between a short record and a misread one.
 *
 * Sky's *bytecode* is Disassembly proper and lives in `listSkyScript`
 * (`skyOpcodes.ts`), read-only and held as Preserved bytes (ADR 0025). It is not
 * reached from a Compact's JSON — a Compact points at a script by number, and
 * the script lives in a module the object table does not carry — so this listing
 * leads with the fields, which is where ADR 0025 says the editable surface is.
 */

import {
  SKY_COMPACT_FIELDS,
  SKY_MEGA_SET_FIELDS,
  SKY_TURN_TABLE_FIELDS,
  type SkyCompactRecord,
  type SkyCompactType,
} from '../../engine/sky/resource/skyCompacts.js';
import {
  listSkyScript,
  skyScriptOffset,
  skyScriptCount,
} from '../../engine/sky/script/skyOpcodes.js';
import { skyMcodeName, SKY_MCODE_STRIDE } from '../../engine/sky/script/skyMcodes.js';

/** A record: its identity, then each named field it actually holds. */
export function formatCompactRecord(record: SkyCompactRecord): string {
  const lines: string[] = [
    `${record.name}  ; ${record.type}, id ${record.id.toString(16)} ` +
      `(list ${record.list}, index ${record.index}), ${record.words.length} words`,
  ];

  if (record.type === 'compact') {
    for (const [name, value] of record.fields) lines.push(`  ${name}: ${value}`);
    record.megaSets.forEach((set, index) => {
      lines.push(`  megaSet ${index}:`);
      for (const [name, value] of set) lines.push(`    ${name}: ${value}`);
    });
    return lines.join('\n');
  }

  if (record.type === 'turnTable') {
    for (const [name, frames] of record.turns) lines.push(`  ${name}: ${frames.join(', ')}`);
    return lines.join('\n');
  }

  // The array kinds — route buffers, animation sequences — have no field layout,
  // and inventing names for their slots would be the guess this family refuses.
  // They are listed as the words they are.
  lines.push(`  words: ${Array.from(record.words).join(', ')}`);
  return lines.join('\n');
}

/**
 * The name of word `index` in a record of this type, for the editor's grid.
 *
 * A Compact's first 55 words are its named fields, and each animation set after
 * them repeats the 14 mega-set fields; a turn table is five names of five frames.
 * Anything past what the type names is `word N`, which is honest rather than a
 * guessed label.
 */
export function compactWordName(record: { type: SkyCompactType }, index: number): string {
  if (record.type === 'compact') {
    if (index < SKY_COMPACT_FIELDS.length) return SKY_COMPACT_FIELDS[index]!;
    const past = index - SKY_COMPACT_FIELDS.length;
    const withinSet = past % SKY_MEGA_SET_FIELDS.length;
    const setNumber = Math.floor(past / SKY_MEGA_SET_FIELDS.length);
    return `megaSet${setNumber}.${SKY_MEGA_SET_FIELDS[withinSet]}`;
  }
  if (record.type === 'turnTable') {
    const field = Math.floor(index / 5);
    const frame = index % 5;
    if (field < SKY_TURN_TABLE_FIELDS.length) return `${SKY_TURN_TABLE_FIELDS[field]}[${frame}]`;
  }
  return `word ${index}`;
}

/**
 * One instruction of a script, as a line a person reads.
 *
 * A record rather than a string so the editor can align columns and a test can
 * assert on a field instead of on formatting. `target` is filled for a branch
 * and `mcode` for a call, because those are the two things a reader following a
 * listing actually chases.
 */
export interface SkyDisassemblyLine {
  /** Word offset within the module, which is what a stall report quotes. */
  readonly at: number;
  readonly name: string;
  readonly operands: readonly number[];
  /** Where a branch lands, in words. */
  readonly target?: number;
  /** The mcode a call names, for a `call_mcode`. */
  readonly mcode?: string;
}

export interface SkyDisassembly {
  readonly scriptNumber: number;
  readonly module: number;
  /** Word offset of the script's first instruction. */
  readonly start: number;
  readonly lines: readonly SkyDisassemblyLine[];
  /**
   * Why the listing stopped early, or null when it reached an exit.
   *
   * **A listing that stops is the honest outcome, not a failure.** `CONTEXT.md`
   * defines Disassembly as stopping rather than guessing when an instruction's
   * length cannot be measured, because resynchronising produces a plausible
   * listing of instructions that are not in the script.
   */
  readonly stoppedBecause: string | null;
}

/**
 * Lists one script as read-only Disassembly.
 *
 * **Disassembly and never Decompilation** (ADR 0025). It follows words in order
 * rather than following branches, so a `skip_always` over a table of data is
 * listed as whatever those words decode to; a control-flow walk is the first
 * half of Decompilation and needs that ADR's promotion rather than a quiet
 * change here.
 */
export function disassembleSkyScript(module: Uint16Array, scriptNumber: number): SkyDisassembly {
  const start = skyScriptOffset(module, scriptNumber);
  const listing = listSkyScript(module, start);

  return {
    scriptNumber,
    module: scriptNumber >> 12,
    start,
    stoppedBecause: listing.stoppedBecause,
    lines: listing.instructions.map((instruction) => ({
      at: instruction.at,
      name: instruction.name,
      operands: instruction.operands,
      ...(instruction.target === undefined ? {} : { target: instruction.target }),
      ...(instruction.name === 'call_mcode'
        ? { mcode: skyMcodeName(instruction.operands[1] / SKY_MCODE_STRIDE) }
        : {}),
    })),
  };
}

/** Every script a module holds, by number. Entry 0 is the table, not a script. */
export function skyScriptNumbers(module: Uint16Array, moduleNumber: number): number[] {
  const out: number[] = [];
  for (let index = 1; index < skyScriptCount(module); index += 1) {
    out.push((moduleNumber << 12) | index);
  }
  return out;
}

/** One listing line as text, for a listing pane or a report. */
export function formatSkyDisassemblyLine(line: SkyDisassemblyLine): string {
  const operands = line.operands.length > 0 ? ` ${line.operands.join(', ')}` : '';
  const target = line.target === undefined ? '' : `  → ${line.target}`;
  const mcode = line.mcode === undefined ? '' : `  ${line.mcode}`;
  return `${String(line.at).padStart(6)}  ${line.name}${operands}${mcode}${target}`;
}
