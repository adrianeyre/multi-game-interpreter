/**
 * The PMachine instruction table — one encoding, SCI0 to SCI3 (ADR 0017).
 *
 * `CONTEXT.md` distinguishes an encoding by how instruction length is
 * determined, and by that test SCI has one: **the low bit of the opcode byte
 * selects 8-bit or 16-bit operands**, so a boundary is derived rather than
 * measured. That single fact is why Decompilation is available for SCI and only
 * Disassembly for AGI, and it is load-bearing for ADR 0018.
 *
 * #214 checked the part of that claim nobody had: `readPMachineInstruction`
 * (`engines/sci/engine/vm.cpp`) is one function for every Version with no
 * `getSciVersion()` in it, so SCI3 rides on this table with a two-opcode delta
 * rather than a second engine.
 *
 * The opcode numbers below are ScummVM's `SciOpcodes` enum
 * (`engines/sci/engine/vm.h`), transcribed value by value.
 */

import { atLeast, type SciVersion } from '../sciVersion.js';

/**
 * What an operand is, which is the whole of what decides an instruction's
 * length.
 *
 * Three kinds and the distinction matters: `sized` operands take their width
 * from the opcode's low bit, `byte` operands are always one byte whatever the
 * low bit says, and `none` means the instruction is one byte. An `sized`
 * operand read as a `byte` desynchronises everything after it, which is the
 * fault ADR 0017 names twice over.
 */
export type SciOperand =
  /** Width from the opcode's low bit: 1 byte when set, 2 when clear. */
  | 'sized'
  /** Same, read as signed — a jump displacement, a negative immediate. */
  | 'sized-signed'
  /** Always one byte: a parameter-byte count, never a value. */
  | 'byte';

export interface SciInstructionSpec {
  name: string;
  operands: readonly SciOperand[];
}

/** No operands, which is most of the arithmetic and stack table. */
const NONE: readonly SciOperand[] = [];

/**
 * Every opcode, indexed by its number.
 *
 * `undefined` is a slot Sierra left unused — 0x29 and 0x2f, both marked
 * "dummy" in ScummVM's own enum. Left as holes rather than filled with a
 * plausible name, because an instruction stream reaching one of them means the
 * decode has gone wrong several bytes earlier and a name would hide that.
 */
export const SCI_OPCODES: ReadonlyArray<SciInstructionSpec | undefined> = buildTable();

function buildTable(): Array<SciInstructionSpec | undefined> {
  const table: Array<SciInstructionSpec | undefined> = new Array(0x80).fill(undefined);
  const put = (code: number, name: string, operands: readonly SciOperand[] = NONE): void => {
    table[code] = { name, operands };
  };

  // 0x00-0x16: arithmetic, bitwise and comparison, all on the stack.
  const nullary = [
    'bnot',
    'add',
    'sub',
    'mul',
    'div',
    'mod',
    'shr',
    'shl',
    'xor',
    'and',
    'or',
    'neg',
    'not',
    'eq?',
    'ne?',
    'gt?',
    'ge?',
    'lt?',
    'le?',
    'ugt?',
    'uge?',
    'ult?',
    'ule?',
  ];
  nullary.forEach((name, index) => put(index, name));

  // 0x17-0x19: the branches. Signed, and relative to the byte *after* the
  // instruction — this repo has been bitten by an off-by-two on exactly this
  // shape of operand in SCUMM v6, which ADR 0017 cites.
  put(0x17, 'bt', ['sized-signed']);
  put(0x18, 'bnt', ['sized-signed']);
  put(0x19, 'jmp', ['sized-signed']);

  put(0x1a, 'ldi', ['sized-signed']);
  put(0x1b, 'push');
  put(0x1c, 'pushi', ['sized-signed']);
  put(0x1d, 'toss');
  put(0x1e, 'dup');
  put(0x1f, 'link', ['sized']);

  // The call family. Every one of them ends in a *byte* count of parameter
  // bytes on the stack, which is not sized by the low bit.
  put(0x20, 'call', ['sized-signed', 'byte']);
  put(0x21, 'callk', ['sized', 'byte']);
  put(0x22, 'callb', ['sized', 'byte']);
  put(0x23, 'calle', ['sized', 'sized', 'byte']);
  put(0x24, 'ret');
  put(0x25, 'send', ['byte']);

  // 0x26 and 0x27 are SCI3's, and dummies before it (#214). They are in the
  // table at every Version because their *length* is the same either way, and
  // length is what this table is for; whether they run is the Version delta's
  // business.
  put(0x26, 'info', NONE);
  put(0x27, 'superP', NONE);

  put(0x28, 'class', ['sized']);
  // 0x29 stays a hole.
  put(0x2a, 'self', ['byte']);
  put(0x2b, 'super', ['sized', 'byte']);
  put(0x2c, 'rest', ['sized']);
  put(0x2d, 'lea', ['sized', 'sized']);
  put(0x2e, 'selfID');
  // 0x2f stays a hole.
  put(0x30, 'pprev');

  // 0x31-0x38: property access, one property index each.
  const properties = ['pToa', 'aTop', 'pTos', 'sTop', 'ipToa', 'dpToa', 'ipTos', 'dpTos'];
  properties.forEach((name, index) => put(0x31 + index, name, ['sized']));

  // `lofsa`/`lofss` load an address of something in the script. The operand's
  // *resolution* is the one thing SCI3 changes about the encoding's meaning
  // and not its shape (#214) — pre-SCI1.1 adds a base, SCI3 goes through a
  // relocation table — so it is decoded here and resolved elsewhere.
  // Unsigned here, and sign-extended by the machine only when the Version
  // resolves it relatively. An absolute offset into a script is never negative,
  // and reading one as signed turns every offset above 0x7fff — or above 0x7f
  // in the narrow form — into a send to somewhere before the start of the
  // script. That is what Space Quest III did: `send to 994:-528`.
  put(0x39, 'lofsa', ['sized']);
  put(0x3a, 'lofss', ['sized']);

  put(0x3b, 'push0');
  put(0x3c, 'push1');
  put(0x3d, 'push2');
  put(0x3e, 'pushSelf');
  put(0x3f, 'line', ['sized']);

  // 0x40-0x7f: load, store, increment and decrement, over four variable kinds
  // and four addressing modes. Sixty-four opcodes generated rather than
  // written, because they *are* a grid — the low two bits of the high nibble
  // pick global/local/temp/param and the bit above picks indexed or not — and
  // spelling out sixty-four names invites one of them being wrong in a way
  // nothing would notice.
  const families = ['l', 's', '+', '-'];
  const kinds = ['ag', 'al', 'at', 'ap'];
  for (let family = 0; family < 4; family++) {
    for (let variant = 0; variant < 4; variant++) {
      for (let kind = 0; kind < 4; kind++) {
        const code = 0x40 + family * 0x10 + variant * 4 + kind;
        const suffix = ['', 's', 'i', 'si'][variant];
        put(code, `${families[family]}${kinds[kind]}${suffix}`, ['sized']);
      }
    }
  }

  return table;
}

/** One decoded instruction. */
export interface SciInstruction {
  /** Offset of the opcode byte within the code block. */
  offset: number;
  /** Bytes the whole instruction occupies. */
  length: number;
  /** The opcode number, with its low bit already removed. */
  opcode: number;
  /** The raw byte, low bit included, because the low bit is the operand width. */
  raw: number;
  name: string;
  operands: number[];
  /**
   * The source file name a `0x7d` carries, without its NUL.
   *
   * Held rather than skipped because an instruction list is the only record of
   * the script there is (ADR 0018) — a decode that measures the name and drops
   * it re-emits the opcode alone, and every byte after it in the method moves.
   * Absent on every other opcode.
   */
  text?: string;
}

/**
 * Decodes one instruction at `at`.
 *
 * Returns null for an opcode Sierra left unused, which means the decode
 * desynchronised earlier — reporting it here rather than inventing a length is
 * what stops one bad byte turning into a whole method of plausible nonsense.
 */
export function decodeSciInstruction(
  code: Uint8Array,
  at: number,
  version?: SciVersion,
): SciInstruction | null {
  const raw = code[at];
  const opcode = raw >> 1;
  const spec = SCI_OPCODES[opcode];
  if (!spec) return null;

  const narrow = (raw & 1) !== 0;
  const wordBlock = sciParameterBlockIsWord(opcode, version);
  const operands: number[] = [];
  let cursor = at + 1;

  for (const operand of spec.operands) {
    if (operand === 'byte') {
      // **A parameter block is a word from SCI2 on.** ScummVM's
      // `script_adjust_opcode_formats` rewrites seven opcodes at
      // `SCI_VERSION_2`: `call`, `callk`, `callb`, `calle`, `send`, `self` and
      // `super` all take their block size as `Script_Word` rather than a byte,
      // whatever the low bit of the opcode says.
      //
      // Read as a byte, every one of those instructions is a byte short and
      // the decode walks into its own operand. Torin's `super 0, 4` at
      // 64920:199 is four bytes and was read as three, so the machine executed
      // the high half of the block size as a `bnot` and stored *that* where the
      // superclass's return belonged — which is the `send to 0:1` every SCI2
      // and SCI2.1 game stopped on.
      if (wordBlock) {
        operands.push(code[cursor] | (code[cursor + 1] << 8));
        cursor += 2;
        continue;
      }
      operands.push(code[cursor]);
      cursor += 1;
      continue;
    }
    if (narrow) {
      const value = code[cursor];
      operands.push(operand === 'sized-signed' && value > 0x7f ? value - 0x100 : value);
      cursor += 1;
    } else {
      const value = code[cursor] | (code[cursor + 1] << 8);
      operands.push(operand === 'sized-signed' && value > 0x7fff ? value - 0x10000 : value);
      cursor += 2;
    }
  }

  // **The debug opcode that carries a source file name is `0x7d`, and the low
  // bit is what says so.**
  //
  // Sierra's debug builds record where each method came from: `line 221`, then
  // this opcode, then a NUL-terminated string. `run_vm` decides which it is the
  // same way it decides every operand width — `if (!(extOpcode & 1)) PUSH32(objp)
  // else` skip a file name (`vm.cpp`, `op_pushSelf`). So `0x7c` is a real
  // `pushSelf` and `0x7d` is a name, and nothing about the bytes after it is
  // consulted.
  //
  // **This was a printable-run heuristic keyed on the Version, and it was
  // wrong in the one way that matters.** It asked whether the bytes that follow
  // look like text, and in King's Quest VII's script 64998 they do: a real
  // `0x7c pushSelf` is followed by `67 5c 34 00`, which reads as `"g\4"` and
  // swallowed five bytes of live code. The machine uses this same decoder, so
  // that is not a cosmetic disassembly fault — execution desynchronised inside
  // the SCI32 system script that builds `IsOnMe`'s arguments, and every menu
  // button in the game was hit-tested against a garbage object.
  //
  // Keyed on the low bit it needs no Version test at all, which also retires
  // the measurement the old rule rested on: Leisure Suit Larry 7 and Torin
  // carry names and Castle of Dr. Brain does not, and the opcode byte says
  // which in every one of them.
  if (opcode === PUSH_SELF && narrow) {
    const length = fileNameAfter(code, cursor);
    let text = '';
    for (let i = 0; i < length && code[cursor + i] !== 0; i++) {
      text += String.fromCharCode(code[cursor + i]);
    }
    return {
      offset: at,
      length: cursor + length - at,
      opcode,
      raw,
      name: 'fileName',
      operands,
      text,
    };
  }

  return { offset: at, length: cursor - at, opcode, raw, name: spec.name, operands };
}

/** Opcode 0x3e, which SCI2.1's debug builds gave a string to. */
const PUSH_SELF = 0x3e;

/**
 * The opcodes whose parameter-block size becomes a word at SCI2.
 *
 * `call`, `callk`, `callb`, `calle`, `send`, `self` and `super` — the seven
 * `script_adjust_opcode_formats` rewrites, and no others. A block is a count of
 * *bytes* on the stack, and SCI32's are large enough to need two.
 */
const WORD_BLOCK_OPCODES = new Set([0x20, 0x21, 0x22, 0x23, 0x25, 0x2a, 0x2b]);

/**
 * Whether this opcode's parameter block is two bytes rather than one.
 *
 * Exported because **the emitter has to make the same decision the decoder
 * did**, and making it twice from two lists is how the two drift. It drifted
 * once already in the other direction: the decoder knew and the emitter did
 * not, so every `send` in a SCI2-or-later script re-emitted a byte short.
 */
export function sciParameterBlockIsWord(opcode: number, version?: SciVersion): boolean {
  return version !== undefined && atLeast(version, 'sci2') && WORD_BLOCK_OPCODES.has(opcode);
}

/**
 * How many bytes the file name after a `0x7d` occupies, including its NUL.
 *
 * The opcode has already said there is one, so this only measures it — bounded
 * by the resource so a missing terminator cannot walk off the end, and at least
 * one byte so the instruction always advances.
 */
function fileNameAfter(code: Uint8Array, from: number): number {
  let at = from;
  while (at < code.length && code[at] !== 0) at++;
  return Math.min(code.length - from, at - from + 1);
}

/** Disassembles a whole code block, stopping at the first byte it cannot read. */
export function decodeSciBlock(
  code: Uint8Array,
  from = 0,
  to = code.length,
  version?: SciVersion,
): SciInstruction[] {
  const out: SciInstruction[] = [];
  let at = from;
  while (at < to) {
    const instruction = decodeSciInstruction(code, at, version);
    if (!instruction || instruction.length === 0) break;
    if (at + instruction.length > to) break;
    out.push(instruction);
    at += instruction.length;
  }
  return out;
}

/** "pushi 5", "send 4", "jmp -12" — for the trace and the Source view. */
export function formatSciInstruction(instruction: SciInstruction): string {
  if (instruction.operands.length === 0) return instruction.name;
  return `${instruction.name} ${instruction.operands.join(', ')}`;
}
