/**
 * Beneath a Steel Sky's script encoding, and the listing built on it.
 *
 * ## The encoding, and why Disassembly here never has to guess
 *
 * A Sky script is an array of 16-bit words. **The first word of an instruction
 * is its opcode, and the opcode alone says how many words follow it.** Nine
 * take one operand, one takes two, one is variable but declares its own length
 * in its first operand, and the rest take none.
 *
 * That makes an instruction boundary **derived rather than measured**, which is
 * the distinction `CONTEXT.md` draws between Decompilation and Disassembly and
 * the question the Sky encoding spike (#248) exists to answer. The answer this
 * table represents is: *derivable* — the same property SCI's PMachine encoding
 * has and AGI's does not.
 *
 * Two consequences, and the second is the one worth being careful about:
 *
 * 1. A listing can walk a whole script without ever stopping, and `listSkyScript`
 *    does. The stopping behaviour is kept anyway, for the one thing that can
 *    still go wrong — see below.
 * 2. **Derivable lengths do not make Decompilation available.** ADR 0025 keeps
 *    the two apart deliberately: knowing where instructions begin is not knowing
 *    what the control flow means, and promotion needs its own ADR. Nothing here
 *    says "decompile".
 *
 * ## What can still go wrong, and why the listing stops rather than guessing
 *
 * The word *before* the first instruction is not marked. A script is reached
 * through its module's offset table, so a listing that is handed the wrong
 * offset reads operands as opcodes. That produces an opcode number the encoding
 * does not define, and the listing stops there and says which number and which
 * word offset — rather than resynchronising, which would produce a plausible
 * listing of instructions that are not there.
 */

/** Every opcode the encoding defines, by number. */
export const SKY_OPCODES: readonly (SkyOpcodeSpec | undefined)[] = [
  { name: 'push_variable', operands: 1, note: 'pushes a script variable, indexed by byte offset' },
  { name: 'less_than', operands: 0 },
  { name: 'push_number', operands: 1 },
  { name: 'not_equal', operands: 0 },
  { name: 'if_and', operands: 0 },
  { name: 'skip_zero', operands: 1, branch: true },
  { name: 'pop_variable', operands: 1 },
  { name: 'minus', operands: 0 },
  { name: 'plus', operands: 0 },
  { name: 'skip_always', operands: 1, branch: true },
  { name: 'if_or', operands: 0 },
  { name: 'call_mcode', operands: 2, note: 'argument count, then the mcode number' },
  { name: 'more_than', operands: 0 },
  { name: 'script_exit', operands: 0, terminal: true },
  { name: 'switch', operands: -1, note: 'a case count, then that many case/offset pairs' },
  { name: 'push_offset', operands: 1, note: 'pushes a field of the compact being run' },
  { name: 'pop_offset', operands: 1 },
  { name: 'is_equal', operands: 0 },
  { name: 'skip_not_zero', operands: 1, branch: true },
  { name: 'script_exit', operands: 0, terminal: true },
  { name: 'restart_script', operands: 0, terminal: true },
];

export interface SkyOpcodeSpec {
  readonly name: string;
  /** Operand words after the opcode; -1 when the instruction declares its own. */
  readonly operands: number;
  /** The operand is a signed byte distance, which a listing resolves. */
  readonly branch?: boolean;
  /** Control does not continue to the next word. */
  readonly terminal?: boolean;
  readonly note?: string;
}

/** One decoded instruction, in words. */
export interface SkyInstruction {
  /** Word offset within the script data this was decoded from. */
  readonly at: number;
  readonly opcode: number;
  readonly name: string;
  /** Operand words, in order. A `switch` carries its case count and pairs. */
  readonly operands: readonly number[];
  /** Total words, opcode included, so a walker never adds anything up itself. */
  readonly words: number;
  /** Where a branch lands, in words, when the instruction is one. */
  readonly target?: number;
  readonly terminal: boolean;
}

export class SkyScriptError extends Error {}

/**
 * The operand of a skip is a **byte** distance added to a word pointer.
 *
 * The game divides it by two before adding, so a listing has to as well. It is
 * the one place in this encoding where a unit changes, and it is worth stating
 * rather than hiding in an expression: a listing that forgets the division
 * reports branch targets at twice their real distance and every one of them
 * looks plausible.
 *
 * ## Signed, and the measurement that settles it
 *
 * The distance is read as signed here, for all three skips. ScummVM reads
 * `skip_zero` and `skip_always` as *unsigned* and `skip_not_zero` as signed,
 * which is a real difference — an unsigned 0xFFF0 is 32,760 words forward where
 * a signed one is 8 words back — so it is worth knowing which is right rather
 * than picking one.
 *
 * Measured over every branch in the shipped bytecode:
 *
 * | Instruction | Count | Distances with the high bit set |
 * | --- | --- | --- |
 * | `skip_zero` | 3,309 | **0** |
 * | `skip_always` | 2,382 | **0** |
 * | `skip_not_zero` | 708 | **708** |
 * | `switch` cases and defaults | 573 | **0** |
 *
 * So the two readings agree on every `skip_zero` and `skip_always` the game
 * ships — the question is untestable there, and signed is chosen because that
 * is what the original's own pointer arithmetic does in a 16-bit segment. And
 * `skip_not_zero` is the loop: every one of its 708 uses goes backwards, which
 * is why reading *that* one unsigned would break the game rather than being a
 * matter of taste.
 *
 * Every distance in the shipped scripts is even, so the division is exact.
 */
function branchTarget(after: number, byteDistance: number): number {
  // Signed: a skip can go backwards, which is how a script loops.
  const signed = byteDistance >= 0x8000 ? byteDistance - 0x10000 : byteDistance;
  return after + signed / 2;
}

/**
 * Decodes one instruction at a word offset.
 *
 * Throws rather than returning something partial. An instruction that runs off
 * the end of its script is the signal that the offset it started from was
 * wrong, and continuing would list words belonging to the next script.
 */
export function decodeSkyInstruction(words: Uint16Array, at: number): SkyInstruction {
  if (at >= words.length) {
    throw new SkyScriptError(
      `Word ${at} is past the end of a ${words.length}-word script, so there is no ` +
        `instruction there. The offset this listing started from was wrong.`,
    );
  }

  const opcode = words[at];
  const spec = SKY_OPCODES[opcode];
  if (!spec) {
    throw new SkyScriptError(
      `Word ${at} holds ${opcode}, which is not one of this encoding's ${SKY_OPCODES.length} ` +
        `opcodes. The listing stops here rather than guessing at a boundary: resynchronising ` +
        `would produce a plausible listing of instructions that are not in the script.`,
    );
  }

  if (spec.operands === -1) {
    // switch: a case count, then that many (value, byte-distance) pairs, then a
    // default distance. Its length is declared rather than fixed, and it is
    // still derived — nothing here is measured by looking for what comes next.
    const cases = words[at + 1];
    const total = 2 + cases * 2 + 1;
    if (at + total > words.length) {
      throw new SkyScriptError(
        `The switch at word ${at} declares ${cases} cases, which needs ${total} words and ` +
          `runs past the end of a ${words.length}-word script.`,
      );
    }
    return {
      at,
      opcode,
      name: spec.name,
      operands: Array.from(words.subarray(at + 1, at + total)),
      words: total,
      terminal: false,
    };
  }

  const total = 1 + spec.operands;
  if (at + total > words.length) {
    throw new SkyScriptError(
      `The ${spec.name} at word ${at} needs ${spec.operands} operand words and the script ` +
        `has ${words.length - at - 1} left.`,
    );
  }

  const operands = Array.from(words.subarray(at + 1, at + total));
  return {
    at,
    opcode,
    name: spec.name,
    operands,
    words: total,
    target: spec.branch ? branchTarget(at + total, operands[0]) : undefined,
    terminal: spec.terminal === true,
  };
}

/** A listing, and the reason it stopped if it did. */
export interface SkyListing {
  readonly instructions: readonly SkyInstruction[];
  /** Null when the listing reached a terminal instruction or the end. */
  readonly stoppedBecause: string | null;
  /** Word offset the listing stopped at, when it stopped early. */
  readonly stoppedAt: number | null;
}

/**
 * Lists a script from a word offset until it ends or cannot continue.
 *
 * Read-only, and linear: it follows words in order rather than following
 * branches, so a `skip_always` over a table of data is listed as whatever those
 * words decode to. That is the honest behaviour for a listing — the alternative
 * is a control-flow walk, which is the first half of Decompilation and needs
 * ADR 0025's promotion rather than a quiet change here.
 */
export function listSkyScript(words: Uint16Array, from = 0, limit = 100_000): SkyListing {
  const instructions: SkyInstruction[] = [];
  let at = from;

  while (at < words.length && instructions.length < limit) {
    let instruction: SkyInstruction;
    try {
      instruction = decodeSkyInstruction(words, at);
    } catch (error) {
      return {
        instructions,
        stoppedBecause: error instanceof SkyScriptError ? error.message : String(error),
        stoppedAt: at,
      };
    }
    instructions.push(instruction);
    at += instruction.words;
    if (instruction.terminal) break;
  }

  return { instructions, stoppedBecause: null, stoppedAt: null };
}

/**
 * A module's table of script entry points.
 *
 * A module begins with one word per script: the word offset of that script's
 * first instruction, from the module's own start. The game indexes it with the
 * low twelve bits of a script number and the top four select the module.
 *
 * **Entry 0 is the table's own length, not a script.** It is the offset of the
 * first script, so a module that holds *n* entries has its first script at word
 * *n* — and asking for "script 0" lands on the word before it, which is data.
 * That is not a guess: listing every entry of all seven shipped modules gives
 * 1,768 scripts that run to an exit and exactly seven that do not, one per
 * module, each of them entry 0.
 */
export function skyScriptOffset(module: Uint16Array, scriptNumber: number): number {
  const index = scriptNumber & 0x0fff;
  if (index >= module.length) {
    throw new SkyScriptError(
      `Script ${scriptNumber} indexes entry ${index} of a module holding ${module.length} ` +
        `words, so this module does not hold it.`,
    );
  }
  if (index === 0) {
    throw new SkyScriptError(
      `Entry 0 of a script module is the offset table's own length rather than a script, so ` +
        `there is no script 0. Scripts are numbered from 1.`,
    );
  }
  if (index >= module[0]) {
    throw new SkyScriptError(
      `Script ${scriptNumber} indexes entry ${index} of a table holding ${module[0]} entries.`,
    );
  }
  return module[index];
}

/** How many entries the module's table has, entry 0 included. */
export function skyScriptCount(module: Uint16Array): number {
  return module.length > 0 ? module[0] : 0;
}

/** The resource number of module 0. Modules run consecutively from here. */
export const SKY_MODULE_0 = 60_400;

/** `(module << 12) | script`, which is how everything names a script. */
export function skyScriptModule(scriptNumber: number): number {
  return scriptNumber >> 12;
}
