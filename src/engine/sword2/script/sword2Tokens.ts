/**
 * Broken Sword II's script encoding: its tokens and their operand widths.
 *
 * ## A byte-oriented encoding, unlike Sword1's
 *
 * Sword1 is words all the way down: every token and every operand is 32 bits.
 * Sword2 is **byte-oriented with mixed operand widths** — an opcode is one
 * byte, and its operands are 8, 16 or 32 bits depending on which opcode it is.
 * That is the sharpest single difference between the two families' bytecode and
 * it is why `CONTEXT.md`'s "one script engine per encoding" rule gives them one
 * each rather than a base and a delta.
 *
 * Two of ScummVM's own macro names say it plainly: `Read8ip`, `Read16ip`,
 * `Read32ip`. A variable reference is a 16-bit index; a pushed constant is a
 * 32-bit value; a string is a length byte then that many bytes inline.
 *
 * ## Still derivable, so still Decompilation
 *
 * Every operand width follows from the opcode, and the two variadic-looking
 * cases carry their own counts:
 *
 * - `CP_CALL_MCODE` — a 16-bit opcode number then an 8-bit argument count. The
 *   arguments come off the stack, so the instruction's own length is fixed at
 *   four bytes.
 * - `CP_SWITCH` — a 32-bit case count, then that many `(value, jump)` pairs,
 *   then a default jump.
 * - `CP_PUSH_STRING` — a length byte then `length + 1` bytes of string.
 *
 * So `instructionLength` below is total, and this family reaches Decompilation
 * on the same grounds Sword1 does: nothing outside the game decides how to
 * decode.
 */

/** The compiled tokens, by their byte value. */
export const CP = {
  END_SCRIPT: 0,
  PUSH_LOCAL_VAR32: 1,
  PUSH_GLOBAL_VAR32: 2,
  POP_LOCAL_VAR32: 3,
  CALL_MCODE: 4,
  PUSH_LOCAL_ADDR: 5,
  PUSH_INT32: 6,
  SKIPONFALSE: 7,
  SKIPALWAYS: 8,
  SWITCH: 9,
  ADDNPOP_LOCAL_VAR32: 10,
  SUBNPOP_LOCAL_VAR32: 11,
  SKIPONTRUE: 12,
  POP_GLOBAL_VAR32: 13,
  ADDNPOP_GLOBAL_VAR32: 14,
  SUBNPOP_GLOBAL_VAR32: 15,
  DEBUGON: 16,
  DEBUGOFF: 17,
  QUIT: 18,
  TERMINATE: 19,
  OP_ISEQUAL: 20,
  OP_PLUS: 21,
  OP_MINUS: 22,
  OP_TIMES: 23,
  OP_DIVIDE: 24,
  OP_NOTEQUAL: 25,
  OP_ANDAND: 26,
  OP_GTTHAN: 27,
  OP_LSTHAN: 28,
  JUMP_ON_RETURNED: 29,
  TEMP_TEXT_PROCESS: 30,
  SAVE_MCODE_START: 31,
  RESTART_SCRIPT: 32,
  PUSH_STRING: 33,
  PUSH_DEREFERENCED_STRUCTURE: 34,
  OP_GTTHANE: 35,
  OP_LSTHANE: 36,
  OP_OROR: 37,
} as const;

/** What the interpreter answers its caller. */
export const IR = {
  /** Quit for a cycle; the offset has been written back. */
  STOP: 0,
  CONT: 1,
  /** Return without updating the offset. */
  TERMINATE: 2,
  /** Return; the offset is at the start of the function call. */
  REPEAT: 3,
  GOSUB: 4,
} as const;

/** Token -> name, for a listing. Revolution's own spellings. */
export const SWORD2_TOKEN_NAMES: Readonly<Record<number, string>> = {
  [CP.END_SCRIPT]: 'CP_END_SCRIPT',
  [CP.PUSH_LOCAL_VAR32]: 'CP_PUSH_LOCAL_VAR32',
  [CP.PUSH_GLOBAL_VAR32]: 'CP_PUSH_GLOBAL_VAR32',
  [CP.POP_LOCAL_VAR32]: 'CP_POP_LOCAL_VAR32',
  [CP.CALL_MCODE]: 'CP_CALL_MCODE',
  [CP.PUSH_LOCAL_ADDR]: 'CP_PUSH_LOCAL_ADDR',
  [CP.PUSH_INT32]: 'CP_PUSH_INT32',
  [CP.SKIPONFALSE]: 'CP_SKIPONFALSE',
  [CP.SKIPALWAYS]: 'CP_SKIPALWAYS',
  [CP.SWITCH]: 'CP_SWITCH',
  [CP.ADDNPOP_LOCAL_VAR32]: 'CP_ADDNPOP_LOCAL_VAR32',
  [CP.SUBNPOP_LOCAL_VAR32]: 'CP_SUBNPOP_LOCAL_VAR32',
  [CP.SKIPONTRUE]: 'CP_SKIPONTRUE',
  [CP.POP_GLOBAL_VAR32]: 'CP_POP_GLOBAL_VAR32',
  [CP.ADDNPOP_GLOBAL_VAR32]: 'CP_ADDNPOP_GLOBAL_VAR32',
  [CP.SUBNPOP_GLOBAL_VAR32]: 'CP_SUBNPOP_GLOBAL_VAR32',
  [CP.DEBUGON]: 'CP_DEBUGON',
  [CP.DEBUGOFF]: 'CP_DEBUGOFF',
  [CP.QUIT]: 'CP_QUIT',
  [CP.TERMINATE]: 'CP_TERMINATE',
  [CP.OP_ISEQUAL]: 'OP_ISEQUAL',
  [CP.OP_PLUS]: 'OP_PLUS',
  [CP.OP_MINUS]: 'OP_MINUS',
  [CP.OP_TIMES]: 'OP_TIMES',
  [CP.OP_DIVIDE]: 'OP_DIVIDE',
  [CP.OP_NOTEQUAL]: 'OP_NOTEQUAL',
  [CP.OP_ANDAND]: 'OP_ANDAND',
  [CP.OP_GTTHAN]: 'OP_GTTHAN',
  [CP.OP_LSTHAN]: 'OP_LSTHAN',
  [CP.JUMP_ON_RETURNED]: 'CP_JUMP_ON_RETURNED',
  [CP.TEMP_TEXT_PROCESS]: 'CP_TEMP_TEXT_PROCESS',
  [CP.SAVE_MCODE_START]: 'CP_SAVE_MCODE_START',
  [CP.RESTART_SCRIPT]: 'CP_RESTART_SCRIPT',
  [CP.PUSH_STRING]: 'CP_PUSH_STRING',
  [CP.PUSH_DEREFERENCED_STRUCTURE]: 'CP_PUSH_DEREFERENCED_STRUCTURE',
  [CP.OP_GTTHANE]: 'OP_GTTHANE',
  [CP.OP_LSTHANE]: 'OP_LSTHANE',
  [CP.OP_OROR]: 'OP_OROR',
};

/** `CP_QUIT` for 18, or `token<n>` for a byte that is not a token. */
export function sword2TokenName(token: number): string {
  return SWORD2_TOKEN_NAMES[token] ?? `token${token}`;
}

export function isSword2Token(token: number): boolean {
  return SWORD2_TOKEN_NAMES[token] !== undefined;
}

/** Operand bytes for the tokens whose length is fixed. Token byte excluded. */ const OPERAND_BYTES: Readonly<
  Record<number, number>
> = {
  [CP.END_SCRIPT]: 0,
  [CP.PUSH_LOCAL_VAR32]: 2,
  [CP.PUSH_GLOBAL_VAR32]: 2,
  [CP.POP_LOCAL_VAR32]: 2,
  /** A 16-bit opcode number and an 8-bit argument count. */
  [CP.CALL_MCODE]: 3,
  [CP.PUSH_LOCAL_ADDR]: 2,
  [CP.PUSH_INT32]: 4,
  [CP.SKIPONFALSE]: 4,
  [CP.SKIPALWAYS]: 4,
  [CP.ADDNPOP_LOCAL_VAR32]: 2,
  [CP.SUBNPOP_LOCAL_VAR32]: 2,
  [CP.SKIPONTRUE]: 4,
  [CP.POP_GLOBAL_VAR32]: 2,
  [CP.ADDNPOP_GLOBAL_VAR32]: 2,
  [CP.SUBNPOP_GLOBAL_VAR32]: 2,
  [CP.DEBUGON]: 0,
  [CP.DEBUGOFF]: 0,
  [CP.QUIT]: 0,
  [CP.TERMINATE]: 0,
  [CP.OP_ISEQUAL]: 0,
  [CP.OP_PLUS]: 0,
  [CP.OP_MINUS]: 0,
  [CP.OP_TIMES]: 0,
  [CP.OP_DIVIDE]: 0,
  [CP.OP_NOTEQUAL]: 0,
  [CP.OP_ANDAND]: 0,
  [CP.OP_GTTHAN]: 0,
  [CP.OP_LSTHAN]: 0,
  [CP.TEMP_TEXT_PROCESS]: 4,
  [CP.SAVE_MCODE_START]: 0,
  [CP.RESTART_SCRIPT]: 0,
  [CP.PUSH_DEREFERENCED_STRUCTURE]: 4,
  [CP.OP_GTTHANE]: 0,
  [CP.OP_LSTHANE]: 0,
  [CP.OP_OROR]: 0,
};

/**
 * How many bytes the instruction at `ip` occupies, token byte included.
 *
 * Zero when the byte is not a token, which is how a caller tells "not code"
 * from "code I cannot decode" — the distinction that decides whether a
 * disassembly is Unrecovered or merely unfinished.
 */
export function sword2InstructionLength(code: Uint8Array, ip: number): number {
  const token = code[ip];
  if (token === undefined || !isSword2Token(token)) return 0;

  if (token === CP.PUSH_STRING) {
    const length = code[ip + 1];
    if (length === undefined) return 0;
    // A length byte, then `length + 1` bytes: the string and its NUL.
    return 2 + length + 1;
  }
  if (token === CP.SWITCH) {
    if (ip + 5 > code.length) return 0;
    const cases = new DataView(code.buffer, code.byteOffset, code.byteLength).getUint32(
      ip + 1,
      true,
    );
    if (cases > 0xffff) return 0;
    // The token, the count, `cases` pairs of (value, jump), then the default.
    return 1 + 4 + cases * 8 + 4;
  }
  if (token === CP.JUMP_ON_RETURNED) {
    // A table of jumps indexed by the last mcode's return value. Its size is
    // the *first* byte's worth of entries, which is how the compiler emits it.
    const entries = code[ip + 1];
    if (entries === undefined) return 0;
    return 2 + entries * 4;
  }

  const operands = OPERAND_BYTES[token];
  return operands === undefined ? 0 : 1 + operands;
}

/** Raised with something a person can act on. */
export class Sword2ScriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Sword2ScriptError';
  }
}
