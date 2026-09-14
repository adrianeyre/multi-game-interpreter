/**
 * Reading AGOS's **other** bytecode: the VGA script.
 *
 * This is the finding that changes the shape of the family, and it is worth
 * stating before the code: **an AGOS game carries two bytecodes, not one.**
 *
 * `../script/subroutines.ts` reads the one the game's logic is written in —
 * item tests, arithmetic, moving things around the tree. It draws nothing. What
 * draws is a second language, held in the graphics resources rather than in
 * `GAMEPC`: sprites are placed, palettes faded, frames waited on and animations
 * looped by VGA scripts, and a game Subroutine's contribution is to start one.
 *
 * `CONTEXT.md` defines a **Script engine** as one per instruction encoding, and
 * on that definition AGOS needs two. They share nothing:
 *
 * - different opcode numbering and different names
 * - different operand encoding — this one has no 0xFF variable escape, and it
 *   has an operand kind (`q`) that is a variable-length list of coordinate pairs
 * - **and a different rule for how wide an opcode is.** The game bytecode reads
 *   16 bits only in Elvira 1. A VGA script reads 16 bits in every Version
 *   *except* Simon 2, The Feeble Files and the Puzzle Pack. The two rules are
 *   near-opposites, so a reader that borrows the wrong one is wrong for exactly
 *   the Versions where the other is right.
 *
 * That asymmetry is why this is a separate module with its own tables rather
 * than a flag on the existing reader.
 */

import { VGA_OPCODE_TABLES, vgaHasWideOpcodes, vgaPairTerminator } from './vgaOpcodeTables.js';

export type VgaOperand =
  | { readonly kind: 'byte'; readonly value: number }
  | { readonly kind: 'word'; readonly value: number }
  /** A word naming a variable rather than holding a value. */
  | { readonly kind: 'variable'; readonly value: number }
  /** A list of coordinate pairs, ended by a terminator word rather than a count. */
  | { readonly kind: 'pairs'; readonly values: readonly (readonly [number, number])[] };

export interface VgaInstruction {
  readonly opcode: number;
  readonly name: string;
  readonly operands: readonly VgaOperand[];
  /**
   * Where this instruction's first byte sits in the script resource.
   *
   * Carried because the control-flow opcodes are **byte-relative**: `JUMP_REL`
   * and `END_REPEAT` both take a signed displacement measured in bytes, and a
   * decoded instruction list indexed by position has no way to turn that into
   * a destination. Without this the arity of those opcodes is knowable and
   * their target is not.
   */
  readonly offset: number;
}

/** A decode that could not continue, named at the offset it stopped. */
export class VgaDecodeError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(`${message} (at offset ${offset})`);
    this.name = 'VgaDecodeError';
  }
}

class Cursor {
  constructor(
    private readonly data: Uint8Array,
    public offset: number,
  ) {}

  byte(): number {
    if (this.offset >= this.data.length) throw new VgaDecodeError('ran past the end', this.offset);
    return this.data[this.offset++]!;
  }

  word(): number {
    return (this.byte() << 8) | this.byte();
  }

  signedWord(): number {
    return (this.word() << 16) >> 16;
  }
}

/**
 * Reads one VGA script, stopping at the opcode that ends it.
 *
 * `x` in a table entry is that opcode: it takes no operands and the script is
 * over. Scripts are not length-prefixed, so this is the only thing that says
 * where one ends — which makes an unknown opcode unrecoverable rather than
 * skippable, exactly as it is in the game bytecode.
 */
export function readVgaScript(
  data: Uint8Array,
  table: string,
  startOffset = 0,
): { instructions: VgaInstruction[]; endOffset: number } {
  const entries = VGA_OPCODE_TABLES[table];
  if (!entries) throw new Error(`no VGA opcode table called ${table}`);

  const wide = vgaHasWideOpcodes(table);
  const terminator = vgaPairTerminator(table);
  const cursor = new Cursor(data, startOffset);
  const instructions: VgaInstruction[] = [];

  for (;;) {
    const at = cursor.offset;
    const opcode = wide ? cursor.word() : cursor.byte();
    const entry = entries[opcode];
    if (entry === null || entry === undefined) {
      throw new VgaDecodeError(`opcode ${opcode} has no entry in the ${table} VGA table`, at);
    }

    const [letters, name] = splitEntry(entry);
    const operands: VgaOperand[] = [];
    let ends = false;
    for (const letter of letters) {
      switch (letter) {
        case 'x':
          ends = true;
          break;
        case 'b':
          operands.push({ kind: 'byte', value: cursor.byte() });
          break;
        case 'd':
        case 'i':
        case 'w':
          operands.push({ kind: 'word', value: cursor.signedWord() });
          break;
        case 'v':
          operands.push({ kind: 'variable', value: cursor.word() });
          break;
        case 'j':
          // Consumes nothing: a marker that the listing shows as an arrow.
          break;
        case 'q': {
          const values: [number, number][] = [];
          while (cursor.word() !== terminator) {
            cursor.offset -= 2;
            values.push([cursor.word(), cursor.word()]);
          }
          operands.push({ kind: 'pairs', values });
          break;
        }
        default:
          throw new VgaDecodeError(`unknown VGA operand letter '${letter}'`, cursor.offset);
      }
      if (ends) break;
    }

    instructions.push({ opcode, name, operands, offset: at });
    if (ends) break;
  }

  return { instructions, endOffset: cursor.offset };
}

function splitEntry(entry: string): [string, string] {
  const bar = entry.indexOf('|');
  return [entry.slice(0, bar), entry.slice(bar + 1)];
}

/** A VGA script as a listing, in the shape the game-bytecode listing already uses. */
export function formatVgaScript(instructions: readonly VgaInstruction[]): string {
  return instructions
    .map((instruction) => {
      const operands = instruction.operands
        .map((operand) => {
          switch (operand.kind) {
            case 'byte':
            case 'word':
              return String(operand.value);
            case 'variable':
              return `var${operand.value}`;
            case 'pairs':
              return operand.values.map(([x, y]) => `(${x},${y})`).join(' ');
          }
        })
        .join(', ');
      return operands ? `${instruction.name} ${operands}` : instruction.name;
    })
    .join('\n');
}
