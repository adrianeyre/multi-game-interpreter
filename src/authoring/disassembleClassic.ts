/**
 * Reads Classic SCUMM bytecode — v2 through v5 — back into editable
 * instructions.
 *
 * What made this hard, and what changed. `decompile.ts` used to say:
 *
 * > In SCUMM v5 many opcodes carry argument lists, sub-opcodes or inline
 * > strings whose lengths cannot be derived from the encoding, and a single
 * > wrong length shifts every boundary after it.
 *
 * Every clause of that is true and none of it means the boundaries are
 * *unknowable*. They cannot be derived from the encoding; they can be
 * **measured**, one opcode at a time, and the thing that measures them already
 * exists: `ClassicScriptEngine` walks these same bytes at sixty frames a second
 * and has been beaten into shape against a shipped game until it does it right.
 * Its handlers are the specification this file transcribes.
 *
 * So the table below is a 256-entry dispatch, built with the same `bind` shape
 * the interpreter's is, because the interpreter dispatches on the whole opcode
 * byte and not on its low five bits: `0x02` is `startMusic` and `0x22` is
 * `getAnimCounter`, and they share those five bits. A reader keyed on the base
 * would call the same measurement for both, which is the exact class of
 * silent, cascading error the old comment was right to be afraid of.
 *
 * **Editing model.** An instruction keeps its own bytes and a list of the
 * fields inside them that are numbers a person could change, each with its
 * offset and width. Re-emission writes the bytes back and patches the edited
 * fields in place, so an untouched script is byte-identical by construction
 * rather than by luck, and an edited one keeps every length it had. Strings,
 * argument lists and sub-opcode tails are carried verbatim: they are inside the
 * instruction's bytes, they are simply not offered as fields.
 *
 * **Where it stops.** At an opcode with no entry, or a sub-opcode no handler
 * knows. Stopping is not a failure mode to be minimised away — a listing that
 * quietly becomes nonsense half way down is worse than a short one, and the
 * bytes from the stop are kept exactly as they arrived.
 */

/** The Versions that share this encoding (`CONTEXT.md`, ADR 0014). */
export type ClassicVersion = 2 | 3 | 4 | 5;

const PARAM_1 = 0x80;
const PARAM_2 = 0x40;
const PARAM_3 = 0x20;

/** Bit in a variable reference meaning "and then index it". */
const VAR_INDEXED = 0x2000;
/** Bit in a variable reference selecting the bit-variable address space. */
const VAR_BIT = 0x8000;
/** Bit in a variable reference selecting the running script's locals. */
const VAR_LOCAL = 0x4000;

/**
 * Names a variable reference in the address space the interpreter reads it from.
 *
 * The top nibble selects the space — `ClassicScriptEngine.readVar` tests
 * `0x8000` for a bit variable and `0x4000` for a script local before falling
 * through to a plain global — so three different things share one number, and
 * `Var[14]` for all three is not a shorter name for them but a wrong one.
 *
 * Worth more than tidiness, because a listing is read to answer questions about
 * control flow. Loom gates its distaff on `equalZero 0x800e` / `notEqualZero
 * 0x8001`, which are bit variables 14 and 1; printed as `Var[14]` and `Var[1]`
 * those read as the music timer and `VAR_EGO`, and `VAR_EGO` is never zero, so
 * the branch that shows the distaff reads as dead code. It is not dead — it is
 * two bits nothing had set yet. A reader that loses the address space invents a
 * defect in the game and hides the state the engine is actually in.
 */
function variableName(raw: number): string {
  const base = raw & ~VAR_INDEXED;
  if (base & VAR_BIT) return `Bit[${base & 0x7fff}]`;
  if (base & VAR_LOCAL) return `Local[${base & 0xfff}]`;
  return `Var[${base & 0x1fff}]`;
}

/**
 * One number inside an instruction that a person could sensibly change.
 *
 * `at` is relative to the instruction's own first byte, so an edit never has to
 * know where the instruction sits in the script.
 */
export interface ClassicField {
  at: number;
  width: 1 | 2;
  signed: boolean;
  /** True when this is a variable reference rather than a literal value. */
  variable: boolean;
  value: number;
  label: string;
}

export interface ClassicInstruction {
  /** Offset within the script. */
  offset: number;
  /** Total bytes, so a caller can walk or re-emit without re-decoding. */
  length: number;
  opcode: number;
  name: string;
  /** This instruction's own bytes, exactly as they arrived. */
  bytes: number[];
  /** The numbers inside them that are offered for editing. */
  fields: ClassicField[];
  /** `walkActorTo 1, 120, 80`, ready to show. */
  text: string;
}

export interface ClassicListing {
  instructions: ClassicInstruction[];
  /** Where reading stopped, if it did. */
  undecodedFrom: number | null;
  /** Why it stopped, for the note beside the preserved bytes. */
  reason: string | null;
}

/** Thrown when a length cannot be measured. Caught by the walk. */
class CannotMeasure extends Error {}

/**
 * The cursor a decode function reads through.
 *
 * Deliberately shaped like the interpreter's own fetch surface — `vb`, `vw`,
 * `sub`, `message`, `stackList` — so a handler and its measurement can be read
 * side by side and seen to agree. `opcode` is a register for the same reason it
 * is one in the interpreter: a sub-opcode byte replaces it, and the operand
 * mode bits of everything after come from the sub-opcode rather than from the
 * instruction that introduced it.
 */
class Reader {
  /** Offset of the instruction being decoded. */
  readonly start: number;
  at: number;
  opcode = 0;
  readonly fields: ClassicField[] = [];
  readonly parts: string[] = [];

  /**
   * True at v2, where a variable reference is one byte and has no indexed form.
   *
   * The single widest-reaching difference in the Classic encoding: it touches
   * every comparison, every getter's destination and every operand whose mode
   * bit is set, so a reader that got it wrong would not misread one
   * instruction — it would misread the first one that touches a variable and
   * everything after it.
   */
  narrowVars = false;

  constructor(
    private readonly code: Uint8Array,
    start: number,
  ) {
    this.start = start;
    this.at = start;
  }

  private take(count: number): number {
    if (this.at + count > this.code.length) {
      throw new CannotMeasure('the script ends mid-instruction');
    }
    let value = 0;
    for (let i = 0; i < count; i++) value |= this.code[this.at + i] << (8 * i);
    this.at += count;
    return value;
  }

  /** A field, recorded so the editor can offer it. */
  private field(width: 1 | 2, signed: boolean, variable: boolean, label: string): number {
    const at = this.at - this.start;
    let value = this.take(width);
    if (signed && width === 2) value = (value << 16) >> 16;
    this.fields.push({ at, width, signed, variable, value, label });
    return value;
  }

  byte(label: string): number {
    const value = this.field(1, false, false, label);
    this.parts.push(String(value));
    return value;
  }

  /** A byte that selects behaviour rather than carrying a value. */
  rawByte(): number {
    return this.take(1);
  }

  word(label: string): number {
    const value = this.field(2, false, false, label);
    this.parts.push(String(value));
    return value;
  }

  signedWord(label: string): number {
    const value = this.field(2, true, false, label);
    this.parts.push(String(value));
    return value;
  }

  /**
   * A variable reference: two bytes, and two more when it is indexed.
   *
   * The indexed form is the reason a variable cannot be measured as "always a
   * word". `readVar` in the interpreter reads the subscript out of the code
   * stream, so an instruction holding one is two bytes longer than the same
   * instruction holding a plain global — the difference between reading the
   * rest of the script and reading noise.
   */
  variable(label: string): number {
    if (this.narrowVars) {
      const value = this.field(1, false, true, label);
      this.parts.push(`Var[${value}]`);
      return value;
    }
    const raw = this.field(2, false, true, label);
    if (raw & VAR_INDEXED) {
      this.take(2);
      this.parts.push(`${variableName(raw)}[…]`);
    } else {
      this.parts.push(variableName(raw));
    }
    return raw;
  }

  /** A literal byte, or a variable, as this instruction's mode bit says. */
  vb(param: number, label: string): void {
    if (this.opcode & param) this.variable(label);
    else this.byte(label);
  }

  /** A literal word, or a variable, as this instruction's mode bit says. */
  vw(param: number, label: string): void {
    if (this.opcode & param) this.variable(label);
    else this.word(label);
  }

  /** The destination of a getter: a variable, indexed or not. */
  resultPos(): void {
    if (this.narrowVars) {
      const value = this.field(1, false, true, 'result');
      this.parts.push(`-> Var[${value}]`);
      return;
    }
    const raw = this.field(2, false, true, 'result');
    if (raw & VAR_INDEXED) this.take(2);
    this.parts.push(`-> ${variableName(raw)}`);
  }

  /** A jump displacement, which is always a signed word. */
  jump(): void {
    const at = this.at - this.start;
    const value = (this.take(2) << 16) >> 16;
    this.fields.push({ at, width: 2, signed: true, variable: false, value, label: 'jump' });
    this.parts.push(`jump ${value >= 0 ? '+' : ''}${value}`);
  }

  /** Reads the next sub-opcode into `opcode` and returns it. */
  sub(): number {
    this.opcode = this.take(1);
    return this.opcode;
  }

  /**
   * An inline message: bytes up to a zero, with escapes.
   *
   * 0xFF and 0xFE introduce a control code. Codes 1, 2, 3 and 8 stand alone;
   * every other code carries a sixteen-bit argument. Getting that wrong reads a
   * string's own letters as instructions, which is a fault this codebase has
   * already met once.
   */
  message(): void {
    const from = this.at;
    for (;;) {
      const byte = this.take(1);
      if (byte === 0) break;
      if (byte === 0xff || byte === 0xfe) {
        const code = this.take(1);
        if (!(code === 1 || code === 2 || code === 3 || code === 8)) this.take(2);
      }
    }
    this.parts.push(describeMessage(this.code.subarray(from, this.at - 1)));
  }

  /** A plain NUL-terminated name: no escapes, every byte a character. */
  filename(): void {
    const from = this.at;
    for (;;) {
      if (this.take(1) === 0) break;
    }
    this.parts.push(JSON.stringify(String.fromCharCode(...this.code.subarray(from, this.at - 1))));
  }

  /** An 0xFF-terminated list of words, each with its own mode byte. */
  stackList(): void {
    const values: string[] = [];
    for (;;) {
      if (this.sub() === 0xff) break;
      const before = this.parts.length;
      this.vw(PARAM_1, 'arg');
      values.push(this.parts.splice(before).join(''));
    }
    this.parts.push(`[${values.join(', ')}]`);
  }

  /** The next byte without consuming it, for the one instruction that needs it. */
  peek(): number {
    return this.at < this.code.length ? this.code[this.at] : -1;
  }

  fail(reason: string): never {
    throw new CannotMeasure(reason);
  }
}

/** A message's printable characters, for the listing. Never re-emitted from. */
function describeMessage(raw: Uint8Array): string {
  let text = '';
  for (let i = 0; i < raw.length; i++) {
    const byte = raw[i];
    if (byte === 0xff || byte === 0xfe) {
      const code = raw[i + 1];
      i += code === 1 || code === 2 || code === 3 || code === 8 ? 1 : 3;
      text += '·';
      continue;
    }
    text += byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '·';
  }
  return JSON.stringify(text);
}

type Decode = (r: Reader) => void;

interface Entry {
  name: string;
  decode: Decode;
}

// ------------------------------------------------------------- sub-opcodes --

/**
 * `actorOps`: an actor number, then sub-opcodes until 0xFF.
 *
 * Four of these were wrong in the interpreter at one time or another and each
 * cost the same thing — a byte left behind, executed as the next instruction.
 * The comments naming them are still in `ClassicScriptEngine`, and this table
 * is the same measurements written once more where a reader can use them.
 */
/**
 * v3 and v4's `actorOps` sub-opcode numbering, as v5 numbers them.
 *
 * ScummVM's `convertTable`, indexed by the sub-opcode minus one. Applied
 * before the switch and not after, because the numbers disagree about operand
 * *counts*: their 4 is v5's 2, which takes two bytes where v5's 4 takes one.
 */
const V3_ACTOR_OPS = [1, 0, 0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 20];

function actorOps(small: boolean): Decode {
  return (r) => {
    r.vb(PARAM_1, 'actor');
    for (;;) {
      if (r.sub() === 0xff) break;
      const raw = r.opcode & 0x1f;
      const sub = small ? (V3_ACTOR_OPS[raw - 1] ?? raw) : raw;
      actorOpsBody(r, sub, small);
    }
  };
}

function actorOpsBody(r: Reader, sub: number, small: boolean): void {
  {
    switch (sub) {
      case 0:
      case 1:
      case 3:
      case 4:
      case 6:
      case 12:
      case 14:
      case 16:
      case 19:
      case 22:
      case 23:
        r.vb(PARAM_1, 'value');
        break;
      case 2:
      case 5:
      case 11:
        r.vb(PARAM_1, 'value');
        r.vb(PARAM_2, 'value');
        break;
      case 17:
        // Scale: one byte before v5, applied to both axes, and two at v5.
        r.vb(PARAM_1, 'scaleX');
        if (!small) r.vb(PARAM_2, 'scaleY');
        break;
      case 7:
        r.vb(PARAM_1, 'value');
        r.vb(PARAM_2, 'value');
        r.vb(PARAM_3, 'value');
        break;
      case 9:
        r.vw(PARAM_1, 'elevation');
        break;
      case 13:
        r.message();
        break;
      case 8:
      case 10:
      case 18:
      case 20:
      case 21:
        break;
      default:
        r.fail(`actorOps sub-opcode 0x${sub.toString(16)} has no known layout`);
    }
  }
}

/** `verbOps`: a verb number, then sub-opcodes until 0xFF. */
function verbOps(r: Reader): void {
  r.vb(PARAM_1, 'verb');
  for (;;) {
    if (r.sub() === 0xff) break;
    switch (r.opcode & 0x1f) {
      case 1:
        r.vw(PARAM_1, 'image');
        break;
      case 2:
        r.message();
        break;
      case 3:
      case 4:
      case 16:
      case 18:
      case 23:
        r.vb(PARAM_1, 'value');
        break;
      case 5:
        r.vw(PARAM_1, 'x');
        r.vw(PARAM_2, 'y');
        break;
      case 6:
      case 7:
      case 8:
      case 9:
      case 17:
      case 19:
        break;
      case 20:
        r.vw(PARAM_1, 'string');
        break;
      case 22:
        // A word and a byte, not two words. Reading a word for the room
        // consumed one byte too many and put the program counter
        // mid-instruction.
        r.vw(PARAM_1, 'image');
        r.vb(PARAM_2, 'room');
        break;
      default:
        r.fail(`verbOps sub-opcode 0x${(r.opcode & 0x1f).toString(16)} has no known layout`);
    }
  }
}

/**
 * `roomOps`: one sub-opcode, some of which introduce further ones.
 *
 * Two forms read a different number of operands before v5, and both are
 * desyncs rather than wrong values. Sub-opcode 2 is "room colour", a v2-v4
 * instruction with no v5 form: two words before v5, nothing at v5. Sub-opcode
 * 4 is a shadow-palette slot before v5 — two words — and a full colour behind
 * a second sub-opcode at v5, which is five operands and one more mode byte.
 */
function roomOps(version: ClassicVersion): Decode {
  const small = version < 5;
  // v3 reads the first two operands *before* the sub-opcode and every Version
  // after it reads them after. Same instruction, same operands, opposite
  // order — so a reader taking v5's order on a v3 game reads the sub-opcode
  // out of the middle of the first operand.
  const early = version === 3;

  return (r) => {
    if (early) {
      r.vw(PARAM_1, 'a');
      r.vw(PARAM_2, 'b');
    }
    r.sub();
    switch (r.opcode & 0x1f) {
      case 1:
      case 3:
        if (!early) {
          r.vw(PARAM_1, 'a');
          r.vw(PARAM_2, 'b');
        }
        break;
      case 2:
        // "Room colour" is a v2-v4 instruction with no v5 form at all.
        if (small && !early) {
          r.vw(PARAM_1, 'colour');
          r.vw(PARAM_2, 'slot');
        }
        break;
      case 5:
      case 6:
        break;
      case 4:
        // A shadow-palette slot before v5 — two words — and a full colour
        // behind a second sub-opcode at v5.
        if (small) {
          if (!early) {
            r.vw(PARAM_1, 'colour');
            r.vw(PARAM_2, 'slot');
          }
          break;
        }
        r.vw(PARAM_1, 'red');
        r.vw(PARAM_2, 'green');
        r.vw(PARAM_3, 'blue');
        r.sub();
        r.vb(PARAM_1, 'index');
        break;
      case 7:
        r.vb(PARAM_1, 'a');
        r.vb(PARAM_2, 'b');
        r.sub();
        r.vb(PARAM_1, 'c');
        r.vb(PARAM_2, 'd');
        r.sub();
        r.vb(PARAM_2, 'slot');
        break;
      case 8:
        r.vb(PARAM_1, 'scale');
        r.vb(PARAM_2, 'start');
        r.vb(PARAM_3, 'end');
        break;
      case 9:
        r.vb(PARAM_1, 'a');
        r.vb(PARAM_2, 'b');
        break;
      case 10:
        r.vw(PARAM_1, 'effect');
        break;
      case 11:
      case 12:
        r.vw(PARAM_1, 'red');
        r.vw(PARAM_2, 'green');
        r.vw(PARAM_3, 'blue');
        r.sub();
        r.vb(PARAM_1, 'start');
        r.vb(PARAM_2, 'end');
        break;
      case 13:
      case 14:
        // A plain NUL-terminated filename, not a message: no escapes, so an
        // 0xFF here is a character rather than a control code.
        r.vb(PARAM_1, 'index');
        r.filename();
        break;
      case 15:
        // Four operands behind three sub-opcode bytes. Measuring this as three
        // behind two is what the round-trip over Fate of Atlantis caught.
        r.vb(PARAM_1, 'a');
        r.sub();
        r.vb(PARAM_1, 'b');
        r.vb(PARAM_2, 'c');
        r.sub();
        r.vb(PARAM_1, 'd');
        break;
      case 16:
        r.vb(PARAM_1, 'cycle');
        r.vb(PARAM_2, 'delay');
        break;
      default:
        r.fail(`roomOps sub-opcode 0x${(r.opcode & 0x1f).toString(16)} has no known layout`);
    }
  };
}

/** `cursorCommand`: one sub-opcode. */
function cursorCommand(version: ClassicVersion): Decode {
  return (r) => {
    r.sub();
    switch (r.opcode & 0x1f) {
      case 1:
      case 2:
      case 3:
      case 4:
      case 5:
      case 6:
      case 7:
      case 8:
        break;
      case 10:
        r.vb(PARAM_1, 'index');
        r.vb(PARAM_2, 'shape');
        break;
      case 11:
        r.vb(PARAM_1, 'index');
        r.vb(PARAM_2, 'x');
        r.vb(PARAM_3, 'y');
        break;
      case 12:
      case 13:
        r.vb(PARAM_1, 'value');
        break;
      case 14:
        if (version === 3) {
          // v3 initialises the charset with two bytes here; v4 and v5 write a
          // whole colour table as an 0xFF-terminated list. A list read where
          // two bytes were written swallows everything up to the next 0xFF.
          r.vb(PARAM_1, 'a');
          r.vb(PARAM_2, 'b');
          break;
        }
        r.stackList();
        break;
      default:
        r.fail(`cursorCommand sub-opcode 0x${(r.opcode & 0x1f).toString(16)} has no known layout`);
    }
  };
}

/** `resourceRoutines`: the sub-opcode selects the type, mostly uniformly. */
function resourceRoutines(r: Reader): void {
  r.sub();
  const subOp = r.opcode & 0x3f;
  // "Heap-space check" reads nothing at all.
  if (subOp === 17) return;
  r.vb(PARAM_1, 'resource');
  // "Load object" is the one form with a second operand: the room, as a word.
  if (subOp === 20) r.vw(PARAM_2, 'room');
}

/** `matrixOps`: box flags, box scale, or a rebuild. */
function matrixOps(r: Reader): void {
  r.sub();
  switch (r.opcode & 0x1f) {
    case 1:
    case 2:
    case 3:
      r.vb(PARAM_1, 'box');
      r.vb(PARAM_2, 'value');
      break;
    case 4:
      break;
    default:
      r.fail(`matrixOps sub-opcode 0x${(r.opcode & 0x1f).toString(16)} has no known layout`);
  }
}

/** `stringOps`: the string table. */
function stringOps(r: Reader): void {
  r.sub();
  switch (r.opcode & 0x1f) {
    case 1:
      r.vb(PARAM_1, 'index');
      r.message();
      break;
    case 2:
    case 5:
      r.vb(PARAM_1, 'a');
      r.vb(PARAM_2, 'b');
      break;
    case 3:
      r.vb(PARAM_1, 'index');
      r.vb(PARAM_2, 'position');
      r.vb(PARAM_3, 'value');
      break;
    case 4:
      r.resultPos();
      r.vb(PARAM_1, 'index');
      r.vb(PARAM_2, 'position');
      break;
    default:
      r.fail(`stringOps sub-opcode 0x${(r.opcode & 0x1f).toString(16)} has no known layout`);
  }
}

/** `wait`: one sub-opcode, and only the actor form takes an operand. */
function wait(r: Reader): void {
  r.sub();
  switch (r.opcode & 0x1f) {
    case 1:
      r.vb(PARAM_1, 'actor');
      break;
    case 2:
    case 3:
    case 4:
      break;
    default:
      r.fail(`wait sub-opcode 0x${(r.opcode & 0x1f).toString(16)} has no known layout`);
  }
}

/**
 * The `print` family's sub-opcode stream.
 *
 * Switched on the low *four* bits rather than five, which is a detail worth
 * spelling out: `parseString` is the one place in the encoding where the mask
 * differs, and reading it as 0x1f would make sub-opcode 0x1f something other
 * than the terminator it is.
 */
function parseString(r: Reader): void {
  for (;;) {
    if (r.sub() === 0xff) break;
    switch (r.opcode & 0xf) {
      case 0:
      case 3:
      case 8:
        r.vw(PARAM_1, 'a');
        r.vw(PARAM_2, 'b');
        break;
      case 1:
        r.vb(PARAM_1, 'colour');
        break;
      case 2:
        r.vw(PARAM_1, 'right');
        break;
      case 4:
      case 6:
      case 7:
        break;
      case 15:
        // The message ends the instruction: the interpreter returns here
        // rather than looking for another sub-opcode.
        r.message();
        return;
      default:
        r.fail(`parseString sub-opcode 0x${(r.opcode & 0xf).toString(16)} has no known layout`);
    }
  }
}

/** `drawObject`: an object, then one sub-opcode saying where or what state. */
function drawObject(r: Reader): void {
  r.vw(PARAM_1, 'object');
  r.sub();
  switch (r.opcode & 0x1f) {
    case 1:
      r.vw(PARAM_1, 'x');
      r.vw(PARAM_2, 'y');
      break;
    case 2:
      r.vw(PARAM_1, 'state');
      break;
    case 0x1f:
      break;
    default:
      r.fail(`drawObject sub-opcode 0x${(r.opcode & 0x1f).toString(16)} has no known layout`);
  }
}

/** `saveRestoreVerbs`: a sub-opcode and three operands, whatever it selects. */
function saveRestoreVerbs(r: Reader): void {
  r.sub();
  r.vb(PARAM_1, 'a');
  r.vb(PARAM_2, 'b');
  r.vb(PARAM_3, 'c');
}

/** `systemOps`: restart, pause or quit. One byte, no operands. */
function systemOps(r: Reader): void {
  r.rawByte();
}

/** `setVarRange`: a count, then that many values, byte or word by mode bit. */
function setVarRange(r: Reader): void {
  r.resultPos();
  const count = r.byte('count');
  const wide = (r.opcode & 0x80) !== 0;
  // A do-while in the interpreter, so a count of zero still writes one value.
  // No release emits one; matching it anyway is cheaper than a reader and a
  // runner that disagree about a case neither will meet.
  for (let i = 0; i < Math.max(count, 1); i++) {
    if (wide) r.signedWord('value');
    else r.byte('value');
  }
}

/** `pseudoRoom`: a value, then room numbers until a zero. */
function pseudoRoom(r: Reader): void {
  r.byte('value');
  for (;;) {
    if (r.rawByte() === 0) break;
  }
}

/**
 * `beginOverride`: a flag, and when it is set, the jump it steps over.
 *
 * The interpreter advances the program counter by three when the flag is on,
 * because what follows is a jump the override machinery replaces. The flag is a
 * literal in the code stream, so this is measurable without running anything —
 * which is the only reason `beginOverride` is not a stopping point.
 */
function beginOverride(r: Reader): void {
  const enable = r.byte('enable');
  if (enable !== 0) {
    r.rawByte();
    r.rawByte();
    r.rawByte();
  }
}

/**
 * `doSentence`: 0xFE means "stop", and stops before its two objects.
 *
 * Only decidable because the verb is in the code stream when it is a literal.
 * When it is a variable the interpreter cannot take the early exit either — it
 * compares the *value*, and a variable holding 0xFE would exit — so the two
 * disagree in exactly one case, which is why the operands are still measured
 * there rather than guessed at.
 */
function doSentence(r: Reader): void {
  const literal = (r.opcode & PARAM_1) === 0;
  const verb = literal ? r.peek() : -1;
  r.vb(PARAM_1, 'verb');
  if (literal && verb === 0xfe) return;
  r.vw(PARAM_2, 'objectA');
  r.vw(PARAM_3, 'objectB');
}

/** `expression`: a nested stream that can contain a whole instruction. */
function expression(table: readonly (Entry | undefined)[]): Decode {
  return (r) => {
    r.resultPos();
    for (;;) {
      if (r.sub() === 0xff) break;
      switch (r.opcode & 0x1f) {
        case 1:
          r.vw(PARAM_1, 'value');
          break;
        case 2:
        case 3:
        case 4:
        case 5:
          break;
        case 6: {
          // A complete instruction, decoded by the same table. The interpreter
          // does exactly this — `dispatch[fetchByte()]` — and its result is
          // taken from variable 0.
          const nested = table[r.sub()];
          if (!nested) {
            throw new CannotMeasure(
              `expression calls opcode 0x${r.opcode.toString(16)}, which has no known layout`,
            );
          }
          nested.decode(r);
          break;
        }
        default:
          r.fail(`expression sub-opcode 0x${(r.opcode & 0x1f).toString(16)} has no known layout`);
      }
    }
  };
}

// ------------------------------------------------------------ the v5 table --

/** Nothing after the opcode. */
const none: Decode = () => {};

function seq(...steps: Decode[]): Decode {
  return (r) => {
    for (const step of steps) step(r);
  };
}

const vb =
  (param: number, label: string): Decode =>
  (r) =>
    r.vb(param, label);
const vw =
  (param: number, label: string): Decode =>
  (r) =>
    r.vw(param, label);
const b =
  (label: string): Decode =>
  (r) =>
    void r.byte(label);
const sw =
  (label: string): Decode =>
  (r) =>
    void r.signedWord(label);
const w =
  (label: string): Decode =>
  (r) =>
    void r.word(label);
const result: Decode = (r) => r.resultPos();
const varRef =
  (label: string): Decode =>
  (r) =>
    void r.variable(label);
const jump: Decode = (r) => r.jump();
const list: Decode = (r) => r.stackList();
const message: Decode = (r) => r.message();
const filename: Decode = (r) => r.filename();

/**
 * Builds the opcode table for one Classic Version.
 *
 * Written with the same `bind(handler, ...codes)` shape as
 * `ClassicScriptEngine.installClassicSharedOpcodes`, and in the same order, so
 * the two can be read side by side. A Version's delta binds over the shared
 * table exactly as the interpreter's does.
 */
function classicTable(version: ClassicVersion): readonly (Entry | undefined)[] {
  const table: (Entry | undefined)[] = new Array(256);
  const bind = (name: string, decode: Decode, ...codes: number[]): void => {
    for (const code of codes) table[code] = { name, decode };
  };

  // Flow control
  bind('stopObjectCode', none, 0x00, 0xa0);
  bind('breakHere', none, 0x80);
  bind('jump', jump, 0x18);
  bind(
    'startScript',
    seq(vb(PARAM_1, 'script'), list),
    0x0a,
    0x2a,
    0x4a,
    0x6a,
    0x8a,
    0xaa,
    0xca,
    0xea,
  );
  bind('stopScript', vb(PARAM_1, 'script'), 0x62, 0xe2);
  bind('chainScript', seq(vb(PARAM_1, 'script'), list), 0x42, 0xc2);
  bind(
    'startObject',
    seq(vw(PARAM_1, 'object'), vb(PARAM_2, 'entry'), list),
    0x37,
    0x77,
    0xb7,
    0xf7,
  );
  bind('stopObjectScript', vw(PARAM_1, 'object'), 0x6e, 0xee);
  bind('isScriptRunning', seq(result, vb(PARAM_1, 'script')), 0x68, 0xe8);
  bind('freezeScripts', vb(PARAM_1, 'flag'), 0x60, 0xe0);
  bind('delay', seq(b('low'), b('mid'), b('high')), 0x2e);
  bind('delayVariable', varRef('frames'), 0x2b);
  bind('wait', wait, 0xae);
  bind('cutscene', list, 0x40);
  bind('endCutscene', none, 0xc0);
  bind('beginOverride', beginOverride, 0x58);
  bind('pseudoRoom', pseudoRoom, 0xcc);
  bind('debug', vw(PARAM_1, 'value'), 0x6b, 0xeb);

  // Arithmetic and comparison
  bind('move', seq(result, vw(PARAM_1, 'value')), 0x1a, 0x9a);
  bind('add', seq(result, vw(PARAM_1, 'value')), 0x5a, 0xda);
  bind('subtract', seq(result, vw(PARAM_1, 'value')), 0x3a, 0xba);
  bind('multiply', seq(result, vw(PARAM_1, 'value')), 0x1b, 0x9b);
  bind('divide', seq(result, vw(PARAM_1, 'value')), 0x5b, 0xdb);
  bind('increment', result, 0x46);
  bind('decrement', result, 0xc6);
  bind('and', seq(result, vw(PARAM_1, 'value')), 0x17, 0x97);
  bind('or', seq(result, vw(PARAM_1, 'value')), 0x57, 0xd7);
  bind('setVarRange', setVarRange, 0x26, 0xa6);
  bind('isEqual', seq(varRef('a'), vw(PARAM_1, 'b'), jump), 0x48, 0xc8);
  bind('isNotEqual', seq(varRef('a'), vw(PARAM_1, 'b'), jump), 0x08, 0x88);
  bind('isGreater', seq(varRef('a'), vw(PARAM_1, 'b'), jump), 0x78, 0xf8);
  bind('isGreaterEqual', seq(varRef('a'), vw(PARAM_1, 'b'), jump), 0x04, 0x84);
  bind('isLess', seq(varRef('a'), vw(PARAM_1, 'b'), jump), 0x44, 0xc4);
  bind('isLessEqual', seq(varRef('a'), vw(PARAM_1, 'b'), jump), 0x38, 0xb8);
  bind('equalZero', seq(varRef('a'), jump), 0x28);
  bind('notEqualZero', seq(varRef('a'), jump), 0xa8);
  bind('getRandomNr', seq(result, vb(PARAM_1, 'max')), 0x16, 0x96);

  // Actors
  bind(
    'putActor',
    seq(vb(PARAM_1, 'actor'), vw(PARAM_2, 'x'), vw(PARAM_3, 'y')),
    0x01,
    0x21,
    0x41,
    0x61,
    0x81,
    0xa1,
    0xc1,
    0xe1,
  );
  bind('putActorInRoom', seq(vb(PARAM_1, 'actor'), vb(PARAM_2, 'room')), 0x2d, 0x6d, 0xad, 0xed);
  bind(
    'putActorAtObject',
    seq(vb(PARAM_1, 'actor'), vw(PARAM_2, 'object')),
    0x0e,
    0x4e,
    0x8e,
    0xce,
  );
  bind(
    'walkActorTo',
    seq(vb(PARAM_1, 'actor'), vw(PARAM_2, 'x'), vw(PARAM_3, 'y')),
    0x1e,
    0x3e,
    0x5e,
    0x7e,
    0x9e,
    0xbe,
    0xde,
    0xfe,
  );
  bind(
    'walkActorToActor',
    seq(vb(PARAM_1, 'actor'), vb(PARAM_2, 'target'), b('distance')),
    0x0d,
    0x4d,
    0x8d,
    0xcd,
  );
  bind(
    'walkActorToObject',
    seq(vb(PARAM_1, 'actor'), vw(PARAM_2, 'object')),
    0x36,
    0x76,
    0xb6,
    0xf6,
  );
  bind('faceActor', seq(vb(PARAM_1, 'actor'), vw(PARAM_2, 'object')), 0x09, 0x49, 0x89, 0xc9);
  bind('animateActor', seq(vb(PARAM_1, 'actor'), vb(PARAM_2, 'animation')), 0x11, 0x51, 0x91, 0xd1);
  bind('actorFromPos', seq(result, vw(PARAM_1, 'x'), vw(PARAM_2, 'y')), 0x15, 0x55, 0x95, 0xd5);
  bind('actorOps', actorOps(version < 5), 0x13, 0x53, 0x93, 0xd3);
  bind('getActorMoving', seq(result, vb(PARAM_1, 'actor')), 0x56, 0xd6);
  bind('getActorRoom', seq(result, vb(PARAM_1, 'actor')), 0x03, 0x83);
  bind('getActorX', seq(result, vw(PARAM_1, 'actor')), 0x43, 0xc3);
  bind('getActorY', seq(result, vw(PARAM_1, 'actor')), 0x23, 0xa3);
  bind('getActorFacing', seq(result, vb(PARAM_1, 'actor')), 0x63, 0xe3);
  bind('getActorCostume', seq(result, vb(PARAM_1, 'actor')), 0x71, 0xf1);
  bind('getActorElevation', seq(result, vb(PARAM_1, 'actor')), 0x06, 0x86);
  bind('getActorWidth', seq(result, vb(PARAM_1, 'actor')), 0x6c, 0xec);
  bind('getActorWalkBox', seq(result, vb(PARAM_1, 'actor')), 0x7b, 0xfb);
  bind('isActorInBox', seq(vb(PARAM_1, 'actor'), vb(PARAM_2, 'box'), jump), 0x1f, 0x5f, 0x9f, 0xdf);
  bind('getClosestObjActor', seq(result, vw(PARAM_1, 'object')), 0x66, 0xe6);
  bind('getDist', seq(result, vw(PARAM_1, 'a'), vw(PARAM_2, 'b')), 0x34, 0x74, 0xb4, 0xf4);

  // Objects
  bind('drawObject', drawObject, 0x05, 0x45, 0x85, 0xc5);
  bind('setState', seq(vw(PARAM_1, 'object'), vb(PARAM_2, 'state')), 0x07, 0x47, 0x87, 0xc7);
  bind('getObjectState', seq(result, vw(PARAM_1, 'object')), 0x0f, 0x8f);
  bind('getObjectOwner', seq(result, vw(PARAM_1, 'object')), 0x10, 0x90);
  bind('setOwnerOf', seq(vw(PARAM_1, 'object'), vb(PARAM_2, 'owner')), 0x29, 0x69, 0xa9, 0xe9);
  bind('setClass', seq(vw(PARAM_1, 'object'), list), 0x5d, 0xdd);
  bind('ifClassOfIs', seq(vw(PARAM_1, 'object'), list, jump), 0x1d, 0x9d);
  bind('findObject', seq(result, vb(PARAM_1, 'x'), vb(PARAM_2, 'y')), 0x35, 0x75, 0xb5, 0xf5);
  bind('setObjectName', seq(vw(PARAM_1, 'object'), message), 0x54, 0xd4);
  bind('pickupObject', seq(vw(PARAM_1, 'object'), vb(PARAM_2, 'room')), 0x25, 0x65, 0xa5, 0xe5);
  bind('getInventoryCount', seq(result, vb(PARAM_1, 'owner')), 0x31, 0xb1);
  bind(
    'findInventory',
    seq(result, vb(PARAM_1, 'owner'), vb(PARAM_2, 'index')),
    0x3d,
    0x7d,
    0xbd,
    0xfd,
  );
  bind(
    'getVerbEntrypoint',
    seq(result, vw(PARAM_1, 'object'), vw(PARAM_2, 'entry')),
    0x0b,
    0x4b,
    0x8b,
    0xcb,
  );

  // Rooms, camera and boxes
  bind('loadRoom', vb(PARAM_1, 'room'), 0x72, 0xf2);
  bind(
    'loadRoomWithEgo',
    seq(vw(PARAM_1, 'object'), vb(PARAM_2, 'room'), sw('x'), sw('y')),
    0x24,
    0x64,
    0xa4,
    0xe4,
  );
  bind('panCameraTo', vw(PARAM_1, 'x'), 0x12, 0x92);
  bind('setCameraAt', vw(PARAM_1, 'x'), 0x32, 0xb2);
  bind('actorFollowCamera', vb(PARAM_1, 'actor'), 0x52, 0xd2);
  bind('lights', seq(vb(PARAM_1, 'a'), b('b'), b('c')), 0x70, 0xf0);
  bind('roomOps', roomOps(version), 0x33, 0x73, 0xb3, 0xf3);

  // Text and sentences
  bind('print', seq(vb(PARAM_1, 'actor'), parseString), 0x14, 0x94);
  bind('printEgo', parseString, 0xd8);
  bind('getStringWidth', seq(result, vb(PARAM_1, 'charset'), vb(PARAM_2, 'index')), 0x67, 0xe7);
  bind('stringOps', stringOps, 0x27);
  bind('doSentence', doSentence, 0x19, 0x39, 0x59, 0x79, 0x99, 0xb9, 0xd9, 0xf9);

  // Verbs and cursor
  bind('verbOps', verbOps, 0x7a, 0xfa);
  bind('saveRestoreVerbs', saveRestoreVerbs, 0xab);
  bind('cursorCommand', cursorCommand(version), 0x2c);

  // Sound
  bind('startSound', vb(PARAM_1, 'sound'), 0x1c, 0x9c);
  bind('stopSound', vb(PARAM_1, 'sound'), 0x3c, 0xbc);
  bind('startMusic', vb(PARAM_1, 'music'), 0x02, 0x82);
  bind('stopMusic', none, 0x20);
  bind('isSoundRunning', seq(result, vb(PARAM_1, 'sound')), 0x7c, 0xfc);
  bind('soundKludge', list, 0x4c);

  // Resources and system
  bind('resourceRoutines', resourceRoutines, 0x0c, 0x8c);
  bind('systemOps', systemOps, 0x98);
  bind('drawBox', drawBox, 0x3f, 0x7f, 0xbf, 0xff);

  // `expression` needs the finished table to decode the instruction it nests,
  // so it is bound last and closes over the array rather than a copy of it.
  bind('expression', expression(table), 0xac);

  if (version === 5) {
    bind('getAnimCounter', seq(result, vb(PARAM_1, 'actor')), 0x22, 0xa2);
    bind('getActorScale', seq(result, vb(PARAM_1, 'actor')), 0x3b, 0xbb);
    bind('matrixOps', matrixOps, 0x30, 0xb0);
    bind('dummy', none, 0xa7);
  }

  if (version < 5) {
    // Everything v2, v3 and v4 have and v5 does not, mirroring
    // `ClassicScriptEngine.installPreV5Opcodes` binding for binding.
    // `drawObject` reads its position from the stream rather than behind a
    // sub-opcode, which uses all three mode bits and so all eight numbers —
    // four of them v5's `pickupObject`.
    bind(
      'drawObject',
      seq(vw(PARAM_1, 'object'), vw(PARAM_2, 'x'), vw(PARAM_3, 'y')),
      0x05,
      0x25,
      0x45,
      0x65,
      0x85,
      0xa5,
      0xc5,
      0xe5,
    );
    bind('pickupObject', vw(PARAM_1, 'object'), 0x50, 0xd0);

    // v5 reads an object's state at 0x0f; v4 branches on it.
    bind('ifState', seq(vw(PARAM_1, 'object'), vb(PARAM_2, 'state'), jump), 0x0f, 0x4f, 0x8f, 0xcf);
    bind(
      'ifNotState',
      seq(vw(PARAM_1, 'object'), vb(PARAM_2, 'state'), jump),
      0x2f,
      0x6f,
      0xaf,
      0xef,
    );

    bind('oldRoomEffect', oldRoomEffect, 0x5c, 0xdc);
    bind('saveLoadVars', saveLoadVars, 0xa7);
    bind('saveLoadGame', seq(result, vb(PARAM_1, 'slot')), 0x22, 0xa2);

    // Three v5 instructions no earlier Version has. Cleared rather than
    // inherited, so a script reaching one stops the reader instead of being
    // measured with a layout this Version never wrote.
    for (const code of [0x3b, 0xbb, 0x4c]) table[code] = undefined;
  }

  if (version === 4) {
    // v4 keeps v5's `matrixOps` and `getActorScale`; v3 spends those numbers
    // on `setBoxFlags` and `waitForActor`.
    bind('matrixOps', matrixOps, 0x30, 0xb0);
    bind('getActorScale', seq(result, vb(PARAM_1, 'actor')), 0x3b, 0xbb);
  }

  if (version === 3) {
    // `setBoxFlags`'s second operand has no mode bit of its own — a plain
    // literal byte — which is what makes it a different instruction from
    // `matrixOps` rather than a narrowing of it.
    bind('setBoxFlags', seq(vb(PARAM_1, 'box'), b('flags')), 0x30, 0xb0);
    // Indy 3 reads an actor here and Loom and Zak read nothing at all, which
    // is a difference between *titles* rather than Versions. The operand form
    // is taken, because a reader that skipped it on Indy 3 would take the next
    // instruction's first byte as an actor number.
    bind('waitForActor', vb(PARAM_1, 'actor'), 0x3b, 0xbb);
    bind('waitForSentence', none, 0x4c);
  }

  if (version === 2) return v2Table();

  return table;
}

/**
 * v2's table, built from nothing rather than layered over a later Version's.
 *
 * Every other Classic Version is a delta because every other Classic Version
 * *is* one. v2 is not: sixteen of its opcodes are state instructions with the
 * state baked into the number, its bit variables are instructions rather than
 * an address space, and half its sub-opcode streams are fixed records. A
 * reader that started from v5's table and corrected it would be correcting
 * nearly every entry, and the entries it forgot would be the ones that failed
 * silently.
 *
 * Transcribed from `ScummEngine_v2::setupOpcodes` and the operand reads of each
 * handler it names.
 */
function v2Table(): readonly (Entry | undefined)[] {
  const table: (Entry | undefined)[] = new Array(256);
  const bind = (name: string, decode: Decode, ...codes: number[]): void => {
    for (const code of codes) table[code] = { name, decode };
  };

  // Flow control
  bind('stopObjectCode', none, 0x00, 0xa0);
  bind('breakHere', none, 0x80);
  bind('jump', jump, 0x18);
  bind('startScript', vb(PARAM_1, 'script'), 0x42, 0xc2);
  bind('stopScript', vb(PARAM_1, 'script'), 0x62, 0xe2);
  bind('chainScript', vb(PARAM_1, 'script'), 0x4a, 0xca);
  bind('isScriptRunning', seq(result, vb(PARAM_1, 'script')), 0x68, 0xe8);
  bind('delay', seq(b('low'), b('mid'), b('high')), 0x2e);
  bind('delayVariable', varRef('frames'), 0x2b);
  bind('waitForActor', vb(PARAM_1, 'actor'), 0x3b, 0xbb);
  bind('waitForMessage', none, 0xae);
  bind('waitForSentence', none, 0x4c);
  // No argument list, where v3 and later take one.
  bind('cutscene', none, 0x40);
  bind('endCutscene', none, 0xc0);
  // A flag and a *two byte* jump, where v3 and later step over three.
  bind('beginOverride', beginOverrideV2, 0x58);
  bind('pseudoRoom', pseudoRoom, 0xcc);
  bind('restart', none, 0x98);
  bind('dummy', none, 0x5c, 0x6b, 0x6e, 0xdc, 0xeb, 0xee);

  // Arithmetic and comparison
  bind('move', seq(result, vw(PARAM_1, 'value')), 0x1a, 0x9a);
  bind('assignVarByte', seq(result, b('value')), 0x2c);
  bind('assignVarWordIndirect', seq(result, vw(PARAM_1, 'value')), 0x0a, 0x8a);
  bind('add', seq(result, vw(PARAM_1, 'value')), 0x5a, 0xda);
  bind('subtract', seq(result, vw(PARAM_1, 'value')), 0x3a, 0xba);
  bind('addIndirect', seq(result, vw(PARAM_1, 'value')), 0x2a, 0xaa);
  bind('subIndirect', seq(result, vw(PARAM_1, 'value')), 0x6a, 0xea);
  bind('increment', result, 0x46);
  bind('decrement', result, 0xc6);
  bind('setVarRange', setVarRange, 0x26, 0xa6);
  bind('isEqual', seq(varRef('a'), vw(PARAM_1, 'b'), jump), 0x48, 0xc8);
  bind('isNotEqual', seq(varRef('a'), vw(PARAM_1, 'b'), jump), 0x08, 0x88);
  bind('isGreater', seq(varRef('a'), vw(PARAM_1, 'b'), jump), 0x78, 0xf8);
  bind('isGreaterEqual', seq(varRef('a'), vw(PARAM_1, 'b'), jump), 0x04, 0x84);
  bind('isLess', seq(varRef('a'), vw(PARAM_1, 'b'), jump), 0x44, 0xc4);
  bind('isLessEqual', seq(varRef('a'), vw(PARAM_1, 'b'), jump), 0x38, 0xb8);
  bind('equalZero', seq(varRef('a'), jump), 0x28);
  bind('notEqualZero', seq(varRef('a'), jump), 0xa8);
  bind('getRandomNr', seq(result, vb(PARAM_1, 'max')), 0x16, 0x96);
  // A bit is named by a *word* where every variable in the Version is a byte.
  bind('getBitVar', seq(result, w('bit'), vb(PARAM_1, 'index')), 0x31, 0xb1);
  bind(
    'setBitVar',
    seq(w('bit'), vb(PARAM_1, 'index'), vb(PARAM_2, 'value')),
    0x1b,
    0x5b,
    0x9b,
    0xdb,
  );

  // Actors. Every coordinate is a byte, in eighths of a pixel.
  bind(
    'putActor',
    seq(vb(PARAM_1, 'actor'), vb(PARAM_2, 'x'), vb(PARAM_3, 'y')),
    0x01,
    0x21,
    0x41,
    0x61,
    0x81,
    0xa1,
    0xc1,
    0xe1,
  );
  bind('putActorInRoom', seq(vb(PARAM_1, 'actor'), vb(PARAM_2, 'room')), 0x2d, 0x6d, 0xad, 0xed);
  bind(
    'putActorAtObject',
    seq(vb(PARAM_1, 'actor'), vw(PARAM_2, 'object')),
    0x0e,
    0x4e,
    0x8e,
    0xce,
  );
  bind(
    'walkActorTo',
    seq(vb(PARAM_1, 'actor'), vb(PARAM_2, 'x'), vb(PARAM_3, 'y')),
    0x1e,
    0x3e,
    0x5e,
    0x7e,
    0x9e,
    0xbe,
    0xde,
    0xfe,
  );
  bind(
    'walkActorToActor',
    seq(vb(PARAM_1, 'actor'), vb(PARAM_2, 'target'), b('distance')),
    0x0d,
    0x4d,
    0x8d,
    0xcd,
  );
  bind(
    'walkActorToObject',
    seq(vb(PARAM_1, 'actor'), vw(PARAM_2, 'object')),
    0x36,
    0x76,
    0xb6,
    0xf6,
  );
  bind('faceActor', seq(vb(PARAM_1, 'actor'), vw(PARAM_2, 'object')), 0x09, 0x49, 0x89, 0xc9);
  bind('animateActor', seq(vb(PARAM_1, 'actor'), vb(PARAM_2, 'animation')), 0x11, 0x51, 0x91, 0xd1);
  bind('actorFromPos', seq(result, vb(PARAM_1, 'x'), vb(PARAM_2, 'y')), 0x15, 0x55, 0x95, 0xd5);
  // A fixed five byte record, not an 0xFF-terminated stream.
  bind(
    'actorOps',
    seq(vb(PARAM_1, 'actor'), vb(PARAM_2, 'value'), b('a'), b('property')),
    0x13,
    0x53,
    0x93,
    0xd3,
  );
  bind('getActorMoving', seq(result, vb(PARAM_1, 'actor')), 0x56, 0xd6);
  bind('getActorRoom', seq(result, vb(PARAM_1, 'actor')), 0x03, 0x83);
  bind('getActorX', seq(result, vb(PARAM_1, 'actor')), 0x43, 0xc3);
  bind('getActorY', seq(result, vb(PARAM_1, 'actor')), 0x23, 0xa3);
  bind('getActorFacing', seq(result, vb(PARAM_1, 'actor')), 0x63, 0xe3);
  bind('getActorCostume', seq(result, vb(PARAM_1, 'actor')), 0x71, 0xf1);
  bind('getActorElevation', seq(result, vb(PARAM_1, 'actor')), 0x06, 0x86);
  bind(
    'setActorElevation',
    seq(vb(PARAM_1, 'actor'), vb(PARAM_2, 'elevation')),
    0x3d,
    0x7d,
    0xbd,
    0xfd,
  );
  bind('getActorWalkBox', seq(result, vb(PARAM_1, 'actor')), 0x7b, 0xfb);
  bind('getClosestObjActor', seq(result, vw(PARAM_1, 'object')), 0x66, 0xe6);
  bind('getDist', seq(result, vw(PARAM_1, 'a'), vw(PARAM_2, 'b')), 0x34, 0x74, 0xb4, 0xf4);
  bind('actorFollowCamera', vb(PARAM_1, 'actor'), 0x52, 0xd2);

  // Objects. Sixteen numbers on state, where v5 spends two and an operand.
  bind(
    'drawObject',
    seq(vw(PARAM_1, 'object'), vb(PARAM_2, 'x'), vb(PARAM_3, 'y')),
    0x05,
    0x25,
    0x45,
    0x65,
    0x85,
    0xa5,
    0xc5,
    0xe5,
  );
  const setState = (name: string, ...codes: number[]) =>
    bind(name, vw(PARAM_1, 'object'), ...codes);
  setState('setStateIntrinsicOn', 0x07, 0x87);
  setState('setStateIntrinsicOff', 0x47, 0xc7);
  setState('setStateLocked', 0x27, 0xa7);
  setState('setStateUnlocked', 0x67, 0xe7);
  setState('setStateTouchable', 0x17, 0x97);
  setState('setStateUntouchable', 0x57, 0xd7);
  setState('setStatePickupable', 0x37, 0xb7);
  setState('setStateUnpickupable', 0x77, 0xf7);

  const ifState = (name: string, ...codes: number[]) =>
    bind(name, seq(vw(PARAM_1, 'object'), jump), ...codes);
  ifState('ifStateIntrinsicOn', 0x0f, 0x8f);
  ifState('ifStateIntrinsicOff', 0x4f, 0xcf);
  ifState('ifStateLocked', 0x2f, 0xaf);
  ifState('ifStateUnlocked', 0x6f, 0xef);
  ifState('ifStateTouchable', 0x1f, 0x9f);
  ifState('ifStateUntouchable', 0x5f, 0xdf);
  ifState('ifStatePickupable', 0x3f, 0xbf);
  ifState('ifStateUnpickupable', 0x7f, 0xff);

  bind('getObjectOwner', seq(result, vw(PARAM_1, 'object')), 0x10, 0x90);
  bind('setOwnerOf', seq(vw(PARAM_1, 'object'), vb(PARAM_2, 'owner')), 0x29, 0x69, 0xa9, 0xe9);
  bind(
    'ifClassOfIs',
    seq(vw(PARAM_1, 'object'), vb(PARAM_2, 'class'), jump),
    0x1d,
    0x5d,
    0x9d,
    0xdd,
  );
  bind('findObject', seq(result, vb(PARAM_1, 'x'), vb(PARAM_2, 'y')), 0x35, 0x75, 0xb5, 0xf5);
  bind('setObjectName', seq(vw(PARAM_1, 'object'), message), 0x54, 0xd4);
  bind('pickupObject', vw(PARAM_1, 'object'), 0x50, 0xd0);
  bind('setObjPreposition', seq(vw(PARAM_1, 'object'), b('preposition')), 0x0b, 0x4b, 0x8b, 0xcb);
  bind('getObjPreposition', seq(result, vw(PARAM_1, 'object')), 0x6c, 0xec);

  // Rooms, camera and boxes
  bind('loadRoom', vb(PARAM_1, 'room'), 0x72, 0xf2);
  bind(
    'loadRoomWithEgo',
    seq(vw(PARAM_1, 'object'), vb(PARAM_2, 'room'), b('x'), b('y')),
    0x24,
    0x64,
    0xa4,
    0xe4,
  );
  bind('panCameraTo', vb(PARAM_1, 'x'), 0x12, 0x92);
  bind('setCameraAt', vb(PARAM_1, 'x'), 0x32, 0xb2);
  bind('setBoxFlags', seq(vb(PARAM_1, 'box'), b('flags')), 0x30, 0xb0);
  // Two operands and *then* the sub-opcode, which is the reverse of v3's.
  bind('roomOps', seq(vb(PARAM_1, 'a'), vb(PARAM_2, 'b'), b('op')), 0x33, 0x73, 0xb3, 0xf3);
  bind('lights', seq(vb(PARAM_1, 'a'), b('b'), b('c')), 0x70, 0xf0);

  // Text, verbs and sentences
  bind('print', seq(vb(PARAM_1, 'actor'), parseString), 0x14, 0x94);
  bind('printEgo', parseString, 0xd8);
  bind(
    'doSentence',
    seq(vb(PARAM_1, 'verb'), vw(PARAM_2, 'objectA'), vw(PARAM_3, 'objectB'), b('flag')),
    0x19,
    0x39,
    0x59,
    0x79,
    0x99,
    0xb9,
    0xd9,
    0xf9,
  );
  bind('drawSentence', none, 0xac);
  // A fixed record and a name, not an 0xFF-terminated stream.
  bind(
    'verbOps',
    seq(b('slot'), vb(PARAM_1, 'verb'), b('x'), b('y'), b('colour'), filename),
    0x7a,
    0xfa,
  );
  bind('cursorCommand', vw(PARAM_1, 'flags'), 0x60, 0xe0);
  bind('switchCostumeSet', seq(b('a'), b('b')), 0xab);

  // Sound, resources and saving
  bind('startSound', vb(PARAM_1, 'sound'), 0x1c, 0x9c);
  bind('stopSound', vb(PARAM_1, 'sound'), 0x3c, 0xbc);
  bind('startMusic', vb(PARAM_1, 'music'), 0x02, 0x82);
  bind('stopMusic', none, 0x20);
  bind('isSoundRunning', seq(result, vb(PARAM_1, 'sound')), 0x7c, 0xfc);
  bind('resourceRoutines', seq(vb(PARAM_1, 'resource'), b('type')), 0x0c, 0x8c);
  bind('saveLoadGame', seq(result, vb(PARAM_1, 'slot')), 0x22, 0xa2);

  return table;
}

/** `beginOverride` at v2: a flag, and a bare two byte jump when it is set. */
function beginOverrideV2(r: Reader): void {
  const enable = r.byte('enable');
  if (enable !== 0) {
    r.rawByte();
    r.rawByte();
  }
}

/** `oldRoomEffect`: a sub-opcode, and only form 3 carries an operand. */
function oldRoomEffect(r: Reader): void {
  r.sub();
  if ((r.opcode & 0x1f) === 3) r.vw(PARAM_1, 'effect');
}

/**
 * `saveLoadVars`: a mode byte, then a sub-opcode list terminated by a zero.
 *
 * Form 1 is two *result positions* rather than two operands, which is the part
 * a reader gets wrong: a result position is a variable reference and carries a
 * subscript when it is indexed, so it is not a fixed two bytes.
 */
function saveLoadVars(r: Reader): void {
  r.byte('mode');
  for (;;) {
    const op = r.rawByte();
    if (op === 0) return;
    r.opcode = op;
    switch (op & 0x1f) {
      case 1:
        r.resultPos();
        r.resultPos();
        break;
      case 2:
        r.vb(PARAM_1, 'from');
        r.vb(PARAM_2, 'to');
        break;
      case 3:
        r.filename();
        break;
      case 4:
      case 0x1f:
        return;
      default:
        break;
    }
  }
}

/** `drawBox`: two corners, with a second mode byte between them. */
function drawBox(r: Reader): void {
  r.vw(PARAM_1, 'x');
  r.vw(PARAM_2, 'y');
  r.sub();
  r.vw(PARAM_1, 'x2');
  r.vw(PARAM_2, 'y2');
  r.vb(PARAM_3, 'colour');
}

const TABLES = new Map<ClassicVersion, readonly (Entry | undefined)[]>();

function tableFor(version: ClassicVersion): readonly (Entry | undefined)[] {
  let table = TABLES.get(version);
  if (!table) {
    table = classicTable(version);
    TABLES.set(version, table);
  }
  return table;
}

/** Reads a Classic script as far as it can measure it. */
export function disassembleClassic(code: Uint8Array, version: ClassicVersion = 5): ClassicListing {
  const table = tableFor(version);
  const instructions: ClassicInstruction[] = [];
  let at = 0;

  while (at < code.length) {
    const entry = table[code[at]];
    if (!entry) {
      return {
        instructions,
        undecodedFrom: at,
        reason: `stops at 0x${code[at].toString(16).padStart(2, '0')}, which SCUMM v${version} has no instruction for`,
      };
    }

    const reader = new Reader(code, at);
    reader.narrowVars = version === 2;
    reader.opcode = reader.rawByte();
    try {
      entry.decode(reader);
    } catch (error) {
      if (!(error instanceof CannotMeasure)) throw error;
      return {
        instructions,
        undecodedFrom: at,
        reason: `stops at ${entry.name} (0x${code[at].toString(16).padStart(2, '0')}): ${error.message}`,
      };
    }

    const length = reader.at - at;
    instructions.push({
      offset: at,
      length,
      opcode: code[at],
      name: entry.name,
      bytes: [...code.subarray(at, reader.at)],
      fields: reader.fields,
      text: reader.parts.length > 0 ? `${entry.name} ${reader.parts.join(', ')}` : entry.name,
    });
    at = reader.at;
  }

  return { instructions, undecodedFrom: null, reason: null };
}

/**
 * Re-emits a decoded Classic script.
 *
 * Byte-identity is structural rather than lucky: each instruction carries the
 * bytes it was decoded from, and only a field a person edited is written back
 * over them. An untouched script therefore cannot come out different, and an
 * edited one keeps every length it had — which is what makes the offsets in
 * every jump around it still correct.
 */
export function assembleClassic(listing: ClassicListing, original: Uint8Array): Uint8Array {
  let size = 0;
  for (const instruction of listing.instructions) size += instruction.bytes.length;
  const tail =
    listing.undecodedFrom === null ? 0 : Math.max(0, original.length - listing.undecodedFrom);

  const out = new Uint8Array(size + tail);
  let at = 0;
  for (const instruction of listing.instructions) {
    out.set(instruction.bytes, at);
    for (const field of instruction.fields) {
      out[at + field.at] = field.value & 0xff;
      if (field.width === 2) out[at + field.at + 1] = (field.value >> 8) & 0xff;
    }
    at += instruction.bytes.length;
  }

  if (tail > 0) out.set(original.subarray(listing.undecodedFrom!), at);

  return out;
}

/** The listing as text, one instruction per line, with offsets. */
export function formatClassicListing(listing: ClassicListing, code: Uint8Array): string {
  const lines = listing.instructions.map(
    (instruction) => `${instruction.offset.toString().padStart(5)}  ${instruction.text}`,
  );

  if (listing.undecodedFrom !== null) {
    const rest = code.subarray(listing.undecodedFrom);
    lines.push(`${listing.undecodedFrom.toString().padStart(5)}  ; ${listing.reason}`);
    lines.push(`${' '.repeat(5)}  ; ${rest.length} bytes follow, kept exactly as they were`);
    for (let i = 0; i < rest.length; i += 16) {
      const row = Array.from(rest.subarray(i, i + 16), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join(' ');
      lines.push(`${(listing.undecodedFrom + i).toString().padStart(5)}  ${row}`);
    }
  }

  return lines.join('\n');
}
