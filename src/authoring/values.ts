/**
 * Operand model for the assembler.
 *
 * A SCUMM instruction encodes, in the top bits of its opcode byte, whether each
 * of its first three operands is a literal or a variable reference. Modelling
 * that as a type rather than as a flag the caller passes means the assembler
 * can work the opcode out from the arguments, and it becomes impossible to
 * write `walkActorTo(literal, variable)` with the wrong mask.
 */

/** A reference to a variable, in one of SCUMM's three address spaces. */
export class VarRef {
  readonly index: number;

  constructor(index: number) {
    this.index = index;
  }

  toString(): string {
    if (this.index & 0x8000) return `bit[${this.index & 0x7fff}]`;
    if (this.index & 0x4000) return `local[${this.index & 0xfff}]`;
    return `var[${this.index}]`;
  }
}

/** Anything an instruction can take where a number is expected. */
export type Operand = number | VarRef;

/** A global variable, `VAR[n]`. */
export function global(index: number): VarRef {
  return new VarRef(index);
}

/** A script-local variable; scripts get 25 of them, and arguments land in 0.. */
export function local(index: number): VarRef {
  if (index < 0 || index > 24) throw new RangeError(`Local variable ${index} is out of range 0-24`);
  return new VarRef(0x4000 | index);
}

/** A single-bit flag, of which games have thousands. */
export function bit(index: number): VarRef {
  return new VarRef(0x8000 | index);
}

export function isVar(value: Operand): value is VarRef {
  return value instanceof VarRef;
}

export function operandValue(value: Operand): number {
  return isVar(value) ? value.index : value;
}
