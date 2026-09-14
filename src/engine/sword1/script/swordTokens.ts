/**
 * Broken Sword's script encoding: its tokens, and what each one's operands are.
 *
 * ## Why this family gets Decompilation and Lure does not
 *
 * `CONTEXT.md` draws the line at whether an instruction's length follows from
 * its opcode. The SCUMM Classic encoding packs operand modes into the opcode
 * byte, so "boundaries are measured rather than derived"; the Stack encoding
 * does not, "which is what makes a script splittable into editable
 * instructions".
 *
 * Broken Sword is on the derivable side, and more cleanly than either. Every
 * token is a **32-bit word**, every operand is a 32-bit word, and the operand
 * count is a property of the token alone — with one exception that is itself
 * self-describing: `IT_MCODE` carries the mcode number *and its argument count*
 * as its two operands, so even the variadic case is measured from the
 * instruction rather than from a table. And `IT_SWITCH`'s case count is its
 * first operand, so its length is derived too.
 *
 * That is the strongest form of the claim this project makes anywhere, and it
 * is what `OPERAND_WORDS` below encodes. A disassembler needs no arity table
 * from outside the game, which is why `mcodeNames.ts` carries names and no
 * arities.
 *
 * ## The script resource's own shape
 *
 * A script resource (`SCRIPTS.CLU`) is a 20-byte header then a run of signed
 * 32-bit words:
 *
 * ```text
 * int32    scriptCount
 * int32[]  scriptOffset     scriptCount of them, in words from the run's start
 * …        the instruction words
 * ```
 *
 * A script *id* is `section * 0x10000 + number`. Its program counter is a word
 * index into the run — and the interpreter accepts either a script number
 * (below `scriptCount`, resolved through the offset table) or a raw pc, which
 * is how a resumed script picks up mid-instruction-stream. That dual meaning is
 * `interpretScript`'s first branch and it is worth knowing before reading it.
 */

/** The tokens, by their word value. Revolution's own names. */
export const IT = {
  MCODE: 1,
  PUSHNUMBER: 2,
  PUSHVARIABLE: 3,
  NOTEQUAL: 4,
  ISEQUAL: 5,
  PLUS: 6,
  TIMES: 7,
  ANDAND: 8,
  OROR: 9,
  LESSTHAN: 10,
  NOT: 11,
  MINUS: 12,
  AND: 13,
  OR: 14,
  GTE: 15,
  LTE: 16,
  DEVIDE: 17,
  GT: 18,
  SCRIPTEND: 20,
  POPVAR: 21,
  POPLONGOFFSET: 22,
  PUSHLONGOFFSET: 23,
  SKIPONFALSE: 24,
  SKIP: 25,
  SWITCH: 26,
  SKIPONTRUE: 27,
  PRINTF: 28,
  RESTARTSCRIPT: 30,
  POPWORDOFFSET: 31,
  PUSHWORDOFFSET: 32,
} as const;

/**
 * Token -> name, for a listing.
 *
 * `DEVIDE` is spelled the way Revolution spelled it. Correcting it here would
 * make this table disagree with `sworddefs.h`, which is the one thing a person
 * cross-checking a listing against the reference cannot afford.
 */
export const SWORD1_TOKEN_NAMES: Readonly<Record<number, string>> = {
  [IT.MCODE]: 'IT_MCODE',
  [IT.PUSHNUMBER]: 'IT_PUSHNUMBER',
  [IT.PUSHVARIABLE]: 'IT_PUSHVARIABLE',
  [IT.NOTEQUAL]: 'IT_NOTEQUAL',
  [IT.ISEQUAL]: 'IT_ISEQUAL',
  [IT.PLUS]: 'IT_PLUS',
  [IT.TIMES]: 'IT_TIMES',
  [IT.ANDAND]: 'IT_ANDAND',
  [IT.OROR]: 'IT_OROR',
  [IT.LESSTHAN]: 'IT_LESSTHAN',
  [IT.NOT]: 'IT_NOT',
  [IT.MINUS]: 'IT_MINUS',
  [IT.AND]: 'IT_AND',
  [IT.OR]: 'IT_OR',
  [IT.GTE]: 'IT_GTE',
  [IT.LTE]: 'IT_LTE',
  [IT.DEVIDE]: 'IT_DEVIDE',
  [IT.GT]: 'IT_GT',
  [IT.SCRIPTEND]: 'IT_SCRIPTEND',
  [IT.POPVAR]: 'IT_POPVAR',
  [IT.POPLONGOFFSET]: 'IT_POPLONGOFFSET',
  [IT.PUSHLONGOFFSET]: 'IT_PUSHLONGOFFSET',
  [IT.SKIPONFALSE]: 'IT_SKIPONFALSE',
  [IT.SKIP]: 'IT_SKIP',
  [IT.SWITCH]: 'IT_SWITCH',
  [IT.SKIPONTRUE]: 'IT_SKIPONTRUE',
  [IT.PRINTF]: 'IT_PRINTF',
  [IT.RESTARTSCRIPT]: 'IT_RESTARTSCRIPT',
  [IT.POPWORDOFFSET]: 'IT_POPWORDOFFSET',
  [IT.PUSHWORDOFFSET]: 'IT_PUSHWORDOFFSET',
};

/**
 * Fixed operand words per token, for the tokens whose length is fixed.
 *
 * The two that are not are handled by `instructionWords`: `IT_MCODE` (two fixed
 * operands, and no more — its arguments come off the stack) and `IT_SWITCH`
 * (a count then that many pairs then a default). Both are derivable from the
 * instruction, which is the whole point of this module's opening note.
 */
export const OPERAND_WORDS: Readonly<Record<number, number>> = {
  [IT.MCODE]: 2,
  [IT.PUSHNUMBER]: 1,
  [IT.PUSHVARIABLE]: 1,
  [IT.NOTEQUAL]: 0,
  [IT.ISEQUAL]: 0,
  [IT.PLUS]: 0,
  [IT.TIMES]: 0,
  [IT.ANDAND]: 0,
  [IT.OROR]: 0,
  [IT.LESSTHAN]: 0,
  [IT.NOT]: 0,
  [IT.MINUS]: 0,
  [IT.AND]: 0,
  [IT.OR]: 0,
  [IT.GTE]: 0,
  [IT.LTE]: 0,
  [IT.DEVIDE]: 0,
  [IT.GT]: 0,
  [IT.SCRIPTEND]: 0,
  [IT.POPVAR]: 1,
  [IT.POPLONGOFFSET]: 1,
  [IT.PUSHLONGOFFSET]: 1,
  [IT.SKIPONFALSE]: 1,
  [IT.SKIP]: 1,
  [IT.SWITCH]: -1,
  [IT.SKIPONTRUE]: 1,
  [IT.PRINTF]: 0,
  [IT.RESTARTSCRIPT]: 0,
  [IT.POPWORDOFFSET]: 1,
  [IT.PUSHWORDOFFSET]: 1,
};

/** `IT_WALK` for 69, or `token<n>` for a word that is not a token. */
export function sword1TokenName(token: number): string {
  return SWORD1_TOKEN_NAMES[token] ?? `token${token}`;
}

/** True when the word is a token this encoding defines. */
export function isSword1Token(token: number): boolean {
  return SWORD1_TOKEN_NAMES[token] !== undefined;
}

/**
 * How many words the instruction at `pc` occupies, token word included.
 *
 * Zero when the word at `pc` is not a token, which is how a caller tells "this
 * is not code" from "this is code I have not implemented" — the distinction
 * that decides whether a disassembly is Unrecovered or merely unfinished.
 */
export function instructionWords(code: Int32Array, pc: number): number {
  const token = code[pc];
  if (token === undefined || !isSword1Token(token)) return 0;

  if (token === IT.SWITCH) {
    // `pc+1` is the case count; each case is a value and a relative jump; the
    // default jump follows. So `1 + 1 + 2 * cases + 1`.
    const cases = code[pc + 1];
    if (cases === undefined || cases < 0) return 0;
    return 3 + cases * 2;
  }

  const operands = OPERAND_WORDS[token];
  return operands === undefined || operands < 0 ? 0 : 1 + operands;
}

/** A script resource's own header: how many scripts, and where each begins. */
export interface Sword1ScriptModule {
  /** Words after the 20-byte resource header. Host-order, signed. */
  readonly code: Int32Array;
  readonly scriptCount: number;
  /** Word index into `code` of each script's first instruction. */
  readonly offsets: readonly number[];
}

/** Raised with something a person can act on. */
export class Sword1ScriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Sword1ScriptError';
  }
}

/** The script version every shipped release carries. Checked, never assumed. */
export const SWORD1_SCRIPT_VERSION = 13;

/**
 * Reads a script resource's payload into words and its offset table.
 *
 * `big` selects the Macintosh clusters' byte order; the swap happens once here,
 * the same arrangement `swordCompact.ts` uses and for the same reason.
 */
export function parseSword1ScriptModule(payload: Uint8Array, big = false): Sword1ScriptModule {
  if (payload.length < 4 || payload.length % 4 !== 0) {
    throw new Sword1ScriptError(
      `A script resource's payload is ${payload.length} bytes, which is not a whole number of ` +
        `32-bit words. Broken Sword's bytecode is words all the way down.`,
    );
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const code = new Int32Array(payload.length / 4);
  for (let at = 0; at < code.length; at++) code[at] = view.getInt32(at * 4, !big);

  const scriptCount = code[0];
  if (scriptCount < 0 || scriptCount + 1 > code.length) {
    throw new Sword1ScriptError(
      `A script resource declares ${scriptCount} scripts, which does not fit in the ` +
        `${code.length} words it holds.`,
    );
  }
  const offsets: number[] = [];
  for (let script = 0; script < scriptCount; script++) offsets.push(code[script + 1]);
  return { code, scriptCount, offsets };
}
