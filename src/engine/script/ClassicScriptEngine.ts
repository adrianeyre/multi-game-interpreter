import { ObjectWhere, ScriptStatus, TEXT_SLOT, TEXT_SLOT_FOR_ACTOR, VAR } from '../constants.js';
import type { ScummEngine, TextOptions } from '../ScummEngine.js';
import { hexWindow } from '../util/ByteStream.js';
import type { ScriptState } from './ScriptState.js';
import { ScriptScheduler } from './ScriptScheduler.js';

export const PARAM_1 = 0x80;
export const PARAM_2 = 0x40;
export const PARAM_3 = 0x20;

/** Thrown to unwind out of a script that killed itself mid-opcode. */
export class ScriptStopped extends Error {
  constructor() {
    super('script stopped');
    this.name = 'ScriptStopped';
  }
}

/**
 * The Classic SCUMM bytecode interpreter — the base v2, v3, v4 and v5 share.
 *
 * Instruction encoding (`CONTEXT.md` calls it the **Classic encoding**): a
 * single opcode byte whose top three bits say whether each of the first three
 * operands is a literal or a variable reference. So `0x1E walkActorTo` and
 * `0x9E walkActorTo` are the same instruction, differing only in where the
 * actor number comes from. That is why the dispatch table has 256 entries but
 * far fewer distinct handlers.
 *
 * ADR 0001 said one script engine per Version, on the premise that v5 shares
 * nothing with its neighbours. ADR 0014 records the correction: that premise
 * holds forwards to v6, which is a stack machine, and **not** backwards. v2
 * through v5 pack operand modes into the opcode byte exactly as this does;
 * they differ by instructions added, removed and renumbered, which is a delta
 * over a table rather than a second interpreter.
 *
 * So this is the Classic side of the shape `StackScriptEngine` already has on
 * the other: an abstract base holding the decode loop, operand-mode handling,
 * variable addressing and the instructions the four Versions genuinely share,
 * with each Version installing its own table on top.
 *
 * What is *running* is not kept here. Slots, locals and the cutscene stack live
 * in `ScriptState`, owned by the engine and lent to whichever version's script
 * engine the game needs (ADR 0001) — so a v6 stack machine reads and writes the
 * same running scripts this one does. What stays here is decode state: the
 * program counter, the current opcode, the operand stack, the instruction
 * trail. Those are shaped by the encoding, and the encoding is the thing that
 * differs between versions.
 */
export abstract class ClassicScriptEngine extends ScriptScheduler {
  /**
   * Opcode -> handler. Sparse: an empty entry is an opcode this Version does
   * not have, which the decode loop reports rather than running.
   *
   * Typed on the polymorphic `this`, as `StackScriptEngine`'s is, so a Version
   * installing handlers gets its own type inside them without a cast.
   */
  protected readonly dispatch: Array<((this: this) => void) | undefined> = new Array(256);

  /** Program counter of the running script. */
  protected pc = 0;
  protected code: Uint8Array | null = null;

  protected opcode = 0;
  /** Variable index the current getter opcode should write to. */
  protected resultVar = 0;

  protected readonly stack: number[] = [];

  /**
   * Opcodes one slot may run in a single execution before it is made to yield.
   *
   * A SCUMM script loops by jumping backwards and yielding with `breakHere`, so
   * a script that never yields is either wedged or being fed data this engine
   * misreads. Either way the browser gets no chance to paint and the tab dies
   * with "Page Unresponsive", which tells the player nothing. The budget turns
   * that into a log line and a still-usable page. Real scripts run a few
   * thousand opcodes per frame at the very most.
   */
  protected static readonly OPCODES_PER_EXECUTION = 100_000;

  /**
   * Opcodes all scripts together may run per frame, or per call into the VM
   * from outside it (booting, a verb click).
   *
   * The per-slot budget alone is not a bound on wall-clock time: scripts nest,
   * and one stuck script per slot would still add up to millions of opcodes
   * before control came back. This caps the whole batch.
   */
  protected static readonly OPCODES_PER_ENTRY = 400_000;

  /** Opcodes left in the current frame or entry. */
  protected budgetRemaining = ClassicScriptEngine.OPCODES_PER_ENTRY;

  /** Set when a fetch ran past the end of the running script's code. */
  protected codeOverrun = false;

  /**
   * The last few instructions executed, as `(offset << 8) | opcode`.
   *
   * A ring rather than a list so the cost is one store per opcode with no
   * allocation. It is what turns "a script ran off its end" into "this is the
   * instruction that consumed the wrong number of bytes".
   */
  protected readonly trail = new Uint32Array(16);
  protected trailNext = 0;

  /**
   * What is running, owned by the engine and shared with every script engine.
   *
   * Borrowed rather than created here: per ADR 0001 a v6 engine will read and
   * write the same slots and cutscene stack, so neither version's decoder can
   * be the thing that owns them.
   */
  constructor(engine: ScummEngine, state: ScriptState) {
    super(engine, state);
  }

  /**
   * Installs this Version's opcode table. Called by the subclass constructor.
   *
   * Not called from here, for the reason `StackScriptEngine` does the same: a
   * subclass's field initialisers run after `super()` returns, so a table
   * installed from the base constructor would bind handlers that then read
   * undefined fields. The Version calls it once its own fields exist.
   */
  protected abstract installOpcodes(): void;

  /**
   * Which Classic Version this is, for the handfuls of shared instructions
   * that read a different number of operands depending on it.
   *
   * Three of them, and each is a desync rather than a wrong value: `actorOps`
   * scale takes one byte before v5 and two at v5, and two of `roomOps`'s forms
   * take a pair of words before v5 and nothing (or five operands) at it. A
   * Version that answered wrongly here would read the next instruction out of
   * the middle of this one.
   */
  protected get classicVersion(): number {
    return 5;
  }

  // ------------------------------------------------------------- variables --

  /**
   * Reads a SCUMM variable.
   *
   * The top nibble of the index selects the address space: plain globals, bit
   * variables (0x8000), script locals (0x4000), or an indexed global (0x2000)
   * whose subscript follows in the instruction stream.
   */
  readVar(variable: number): number {
    let index = variable;

    if (index & 0x2000) {
      const offset = this.fetchWord();
      if (offset & 0x2000) {
        index += this.readVar(offset & ~0x2000);
      } else {
        index += offset & 0xfff;
      }
      index &= ~0x2000;
    }

    if (!(index & 0xf000)) {
      return this.engine.variables[index] ?? 0;
    }
    if (index & 0x8000) {
      const bit = index & 0x7fff;
      return (this.engine.bitVariables[bit >> 3] >> (bit & 7)) & 1;
    }
    if (index & 0x4000) {
      const slot = this.state.slots[this.state.currentSlot];
      return slot ? slot.locals[index & 0xfff] : 0;
    }
    return 0;
  }

  writeVar(variable: number, value: number): void {
    let index = variable;

    if (!(index & 0xf000)) {
      if (index >= 0 && index < this.engine.variables.length) {
        this.engine.variables[index] = value;
      }
      return;
    }
    if (index & 0x8000) {
      const bit = index & 0x7fff;
      const byte = bit >> 3;
      const mask = 1 << (bit & 7);
      if (value) this.engine.bitVariables[byte] |= mask;
      else this.engine.bitVariables[byte] &= ~mask;
      // A script parked on a bit variable is waiting for whichever other script
      // sets it, and the whole question is which one that is. Reporting every
      // write would bury it, so only watched bits are named.
      if (this.engine.watchedBits.size > 0) {
        this.engine.reportBitWrite(
          bit,
          value ? 1 : 0,
          this.state.slots[this.state.currentSlot]?.number,
        );
      }
      return;
    }
    if (index & 0x4000) {
      index &= 0xfff;
      const slot = this.state.slots[this.state.currentSlot];
      if (slot && index < slot.locals.length) slot.locals[index] = value;
    }
  }

  // ------------------------------------------------------- code access ------

  /**
   * Reads the next code byte, or 0 once the script's code is exhausted.
   *
   * The bound is not cosmetic. An out-of-range index on a `Uint8Array` yields
   * `undefined`, and the several instruction loops below run until they read a
   * sentinel byte — so a program counter that has drifted off the end (a
   * misread operand width is enough) turned into a loop that could never see
   * its terminator, inside a single opcode handler where the per-opcode budget
   * never gets a look. Returning 0 and recording the overrun ends those loops
   * and stops the script instead.
   */
  protected fetchByte(): number {
    const code = this.code;
    if (!code || this.pc < 0 || this.pc >= code.length) {
      this.codeOverrun = true;
      this.pc = code ? code.length : 0;
      return 0;
    }
    const value = code[this.pc];
    this.pc += 1;
    return value;
  }

  protected fetchWord(): number {
    const low = this.fetchByte();
    const high = this.fetchByte();
    return low | (high << 8);
  }

  /**
   * Reports a sub-opcode this engine does not know.
   *
   * Its operands are still sitting in the code, so the program counter is now
   * pointing at them rather than at the next instruction: everything after it
   * is misread, and the script eventually runs off its own end. That failure
   * shows up far from its cause, which is why the instruction gets named here
   * rather than left to fall through quietly.
   */
  protected reportUnknownSubOpcode(instruction: string, subOpcode: number): void {
    const slot = this.state.slots[this.state.currentSlot];
    this.engine.reportUnknownSubOpcode(
      instruction,
      subOpcode,
      slot?.number ?? 0,
      this.pc,
      // v5 has no operand stack: every sub-opcode's operands are inline, so an
      // unknown one leaves the program counter pointing at them.
      'inline',
      this.code ? hexWindow(this.code, this.pc - 1) : '',
      this.describeTrail(),
    );
  }

  /**
   * Reads the next sub-opcode of a multi-part instruction.
   *
   * Reports the 0xFF terminator when the code ran out, which is what every
   * caller's loop already breaks on.
   */
  protected fetchSubOpcode(): number {
    this.opcode = this.fetchByte();
    if (this.codeOverrun) this.opcode = 0xff;
    return this.opcode;
  }

  protected fetchWordSigned(): number {
    const value = this.fetchWord();
    return value >= 0x8000 ? value - 0x10000 : value;
  }

  protected getVarOrDirectByte(mask: number): number {
    if (this.opcode & mask) return this.readVar(this.fetchVarRef());
    return this.fetchByte();
  }

  protected getVarOrDirectWord(mask: number): number {
    if (this.opcode & mask) return this.readVar(this.fetchVarRef());
    return this.fetchWordSigned();
  }

  /** Reads a variable-length argument list terminated by 0xFF. */
  protected getStackList(max: number): number[] {
    const values: number[] = [];
    for (;;) {
      if (this.fetchSubOpcode() === 0xff) break;
      if (values.length < max) values.push(this.getVarOrDirectWord(PARAM_1));
      else this.getVarOrDirectWord(PARAM_1);
    }
    return values;
  }

  /**
   * How wide a *variable reference* in the code stream is.
   *
   * Two bytes at v3 and later, and **one** at v2 — `ScummEngine_v2::getVar`
   * reads a byte where every later Version reads a word, and
   * `ScummEngine_v2::getResultPos` does the same. It reaches every comparison,
   * every getter's destination and every operand whose mode bit is set, which
   * is most of a script, so a Version that answered wrongly here would not
   * misread one instruction — it would misread the first one that touches a
   * variable and everything after it.
   *
   * v2 also has no indexed form: the 0x2000 subscript that costs a later
   * Version two more bytes does not exist there, which is why the caller asks
   * for the whole reference rather than only its width.
   */
  protected fetchVarRef(): number {
    return this.fetchWord();
  }

  protected getResultPos(): void {
    this.resultVar = this.fetchVarRef();
    if (this.resultVar & 0x2000) {
      const offset = this.fetchWordSigned();
      if (offset & 0x2000) {
        this.resultVar += this.readVar(offset & ~0x2000);
      } else {
        this.resultVar += offset & 0xfff;
      }
      this.resultVar &= ~0x2000;
    }
  }

  protected setResult(value: number): void {
    this.writeVar(this.resultVar, value);
  }

  /** Reads a NUL-terminated message, decoding the 0xFF escape sequences. */
  /**
   * A plain NUL-terminated name in the code stream, with no escape handling.
   *
   * The one string form in the Classic encoding that is not a message. Kept
   * separate rather than folded into `fetchMessage` because the difference is
   * the whole point: a message's 0xFF introduces a control code and consumes
   * bytes after it, and a filename's 0xFF is a character.
   */
  protected fetchFilename(): string {
    let name = '';
    for (;;) {
      const byte = this.fetchByte();
      if (byte === 0 || this.codeOverrun) break;
      name += String.fromCharCode(byte);
    }
    return name;
  }

  protected fetchMessage(): { text: string; raw: number[] } {
    const raw: number[] = [];
    for (;;) {
      const byte = this.fetchByte();
      if (byte === 0) break;
      raw.push(byte);
      if (byte === 0xff || byte === 0xfe) {
        const code = raw.length > 0 ? this.fetchByte() : 0;
        raw.push(code);
        // Codes 1-3 and 8 take no argument; the rest take a 16 bit one.
        if (!(code === 1 || code === 2 || code === 3 || code === 8)) {
          raw.push(this.fetchByte(), this.fetchByte());
        }
      }
    }
    return { text: this.engine.decodeMessage(raw), raw };
  }

  // ------------------------------------------------------ slot management ---

  /** Stops the script that is currently executing. */
  stopObjectCode(): void {
    const slot = this.state.slots[this.state.currentSlot];
    if (!slot) return;
    if (slot.where !== ObjectWhere.Global && slot.where !== ObjectWhere.Local) {
      this.engine.stopTalkIfObject(slot.number);
    }
    slot.reset();
    this.state.currentSlot = -1;
    throw new ScriptStopped();
  }

  /**
   * Starts a global or local script.
   *
   * `recursive` allows a second copy of an already-running script; without it
   * SCUMM kills the existing instance first, which is how scripts restart
   * themselves on room changes without piling up.
   */
  runScript(script: number, freezeResistant: boolean, recursive: boolean, args: number[]): void {
    if (this.engine.traceScripts) this.engine.trace(`script ${script} started`);
    if (script === 0) return;

    if (!recursive) this.stopScript(script);

    let where: ObjectWhere;
    let data: Uint8Array | null;
    let base: number;

    if (script < this.engine.numGlobalScripts) {
      const resource = this.engine.resources.getScript(script);
      // A script that is not there is how a game quietly does nothing: the
      // caller carries on as though it ran, and the scene it was supposed to
      // set up simply never happens. It is the commonest shape of "the room is
      // drawn and nobody is in it" for a game imported room by room, whose own
      // global scripts were never brought across.
      if (!resource) {
        this.reportMissingScript(script, 'global');
        return;
      }
      where = ObjectWhere.Global;
      data = resource;
      // Past this Version's chunk header: eight bytes for v5's `SCRP` and six
      // for v4's `SC`. Two bytes, and they are the difference between a script
      // and its own size field executed as instructions.
      base = this.classicVersion >= 5 ? 8 : 6;
    } else {
      const local = this.engine.currentRoomData?.scripts.local.get(script);
      if (!local || !this.engine.currentRoomData) {
        this.reportMissingScript(script, 'local');
        return;
      }
      where = ObjectWhere.Local;
      data = this.engine.currentRoomData.data;
      base = local.offset;
    }

    const index = this.findFreeSlot();
    const slot = this.state.slots[index];
    slot.reset();
    slot.number = script;
    slot.status = ScriptStatus.Running;
    slot.where = where;
    slot.data = data;
    slot.base = base;
    slot.offset = base;
    slot.freezeResistant = freezeResistant;
    slot.recursive = recursive;
    slot.didExec = false;
    slot.cutsceneOverride = 0;

    for (let i = 0; i < args.length && i < slot.locals.length; i++) {
      slot.locals[i] = args[i];
    }

    this.updateScriptPointer();
    this.runScriptNested(index);
  }

  /** Starts the verb script attached to an object. */
  runObjectScript(
    object: number,
    entry: number,
    freezeResistant: boolean,
    recursive: boolean,
    args: number[],
  ): void {
    if (object === 0) return;
    if (!recursive) this.stopObjectScript(object);

    const found = this.engine.findObjectVerbCode(object, entry);
    if (!found) return;

    const index = this.findFreeSlot();
    const slot = this.state.slots[index];
    slot.reset();
    slot.number = object;
    slot.status = ScriptStatus.Running;
    slot.where = found.where;
    slot.data = found.data;
    slot.base = found.base;
    slot.offset = found.offset;
    slot.freezeResistant = freezeResistant;
    slot.recursive = recursive;
    slot.cutsceneOverride = 0;

    for (let i = 0; i < args.length && i < slot.locals.length; i++) {
      slot.locals[i] = args[i];
    }

    this.updateScriptPointer();
    this.runScriptNested(index);
  }

  /**
   * Runs a code block that has no script id of its own — a room's ENCD/EXCD.
   *
   * These live inline in the room resource and are identified by a synthetic
   * number so the slot bookkeeping (and any `stopScript` aimed at them) still
   * works.
   */
  runInlineScript(
    pseudoNumber: number,
    data: Uint8Array,
    offset: number,
    where: ObjectWhere,
  ): void {
    const index = this.findFreeSlot();
    const slot = this.state.slots[index];
    slot.reset();
    slot.number = pseudoNumber;
    slot.status = ScriptStatus.Running;
    slot.where = where;
    slot.data = data;
    slot.base = offset;
    slot.offset = offset;

    this.updateScriptPointer();
    this.runScriptNested(index);
  }

  /** Saves the caller's program counter so a nested script can run. */
  protected updateScriptPointer(): void {
    const slot = this.state.slots[this.state.currentSlot];
    if (slot) slot.offset = this.pc;
  }

  protected runScriptNested(index: number): void {
    const previous = this.state.currentSlot;
    if (previous !== -1) this.updateScriptPointer();
    // Entering from outside the VM — booting, a click — starts a fresh budget.
    else this.budgetRemaining = ClassicScriptEngine.OPCODES_PER_ENTRY;

    this.state.currentSlot = index;
    try {
      this.executeSlot();
    } catch (error) {
      if (!(error instanceof ScriptStopped)) throw error;
    }

    this.state.currentSlot = previous;
    if (previous !== -1) this.loadCurrentScript();
  }

  protected loadCurrentScript(): void {
    const slot = this.state.slots[this.state.currentSlot];
    if (!slot || !slot.data) {
      this.code = null;
      return;
    }
    this.code = slot.data;
    this.pc = slot.offset;
  }

  /** Runs one slot until it blocks or ends. */
  protected executeSlot(): void {
    const slot = this.state.slots[this.state.currentSlot];
    if (!slot || !slot.data) return;

    this.loadCurrentScript();
    slot.didExec = true;
    this.codeOverrun = false;

    let executed = 0;

    for (;;) {
      if (slot.status !== ScriptStatus.Running) return;

      if (++executed > ClassicScriptEngine.OPCODES_PER_EXECUTION) {
        this.engine.reportRunawayScript(slot.number, this.pc, executed - 1);
        // Pause rather than kill: if the script is merely slow it carries on
        // next frame, and if it is stuck the page still responds.
        this.breakHere();
      }

      if (--this.budgetRemaining <= 0) {
        this.engine.reportScriptBudgetExhausted(ClassicScriptEngine.OPCODES_PER_ENTRY);
        this.breakHere();
      }

      if (this.pc >= this.code!.length) {
        slot.reset();
        this.state.currentSlot = -1;
        return;
      }

      const opcodeOffset = this.pc;
      this.opcode = this.fetchByte();
      this.trail[this.trailNext % this.trail.length] =
        ((opcodeOffset & 0xffffff) << 8) | this.opcode;
      this.trailNext++;
      const handler = this.dispatch[this.opcode];
      if (!handler) {
        // An unimplemented opcode cannot be skipped safely because operand
        // widths vary, so stop this script rather than execute garbage.
        this.engine.reportUnknownOpcode(this.opcode, slot.number, this.pc - 1);
        slot.reset();
        this.state.currentSlot = -1;
        return;
      }
      handler.call(this);

      // Re-read the slot rather than trusting the one captured above: an
      // instruction is free to change which slot is current. `chainScript`
      // kills the caller's slot and hands it to the script it chains to, and
      // the caller's program counter written into it afterwards leaves the new
      // script running from an offset that belongs to the old one — with the
      // old one's base, so it decodes the room's own header as instructions.
      // That is what turned a room change in Atlantis into a cutscene that
      // never ended.
      const current = this.state.slots[this.state.currentSlot];
      if (current !== slot) return;
      slot.offset = this.pc;

      if (this.codeOverrun) {
        this.engine.reportScriptOverrun(
          slot.number,
          this.pc,
          this.describeTrail(),
          this.dumpCode(),
        );
        slot.reset();
        this.state.currentSlot = -1;
        this.codeOverrun = false;
        return;
      }
    }
  }

  /** "171:0x2f 168:0x1a …", oldest first, for a report. */
  protected describeTrail(): string {
    const entries: string[] = [];
    const count = Math.min(this.trailNext, this.trail.length);
    for (let i = count; i > 0; i--) {
      const value = this.trail[(this.trailNext - i) % this.trail.length];
      const offset = value >>> 8;
      const opcode = value & 0xff;
      entries.push(`${offset}:0x${opcode.toString(16).padStart(2, '0')}`);
    }
    return entries.join(' ');
  }

  /**
   * Hex of the running script's code, so it can be disassembled by hand.
   *
   * Capped: a room script is a few hundred bytes, but a global one can be
   * large, and the interesting part is always near the start of the drift.
   */
  protected dumpCode(limit = 512): string {
    const code = this.code;
    if (!code) return '';
    const slot = this.state.slots[this.state.currentSlot];
    const start = slot?.base ?? 0;
    const end = Math.min(code.length, start + limit);
    const bytes: string[] = [];
    for (let i = start; i < end; i++) bytes.push(code[i].toString(16).padStart(2, '0'));
    return `${bytes.join(' ')}${end < code.length ? ' …' : ''}`;
  }

  // ------------------------------------------------------------ main loop --

  /**
   * Runs every runnable slot once.
   *
   * `didExec` prevents a script started mid-frame by another script from also
   * being stepped by this loop, which would let it run twice in one frame.
   */
  runAllScripts(): void {
    this.budgetRemaining = ClassicScriptEngine.OPCODES_PER_ENTRY;
    for (const slot of this.state.slots) slot.didExec = false;

    for (let i = 0; i < this.state.slots.length; i++) {
      const slot = this.state.slots[i];
      if (slot.status !== ScriptStatus.Running || slot.didExec) continue;
      if (slot.freezeCount > 0) continue;

      this.state.currentSlot = i;
      try {
        this.executeSlot();
      } catch (error) {
        if (!(error instanceof ScriptStopped)) throw error;
      }
      this.state.currentSlot = -1;
    }
  }

  unfreezeScripts(): void {
    for (const slot of this.state.slots) {
      if (slot.status !== ScriptStatus.Dead && slot.freezeCount > 0) slot.freezeCount--;
    }
    this.engine.unfreezeSentence();
  }

  protected jumpRelative(condition: boolean): void {
    const offset = this.fetchWordSigned();
    if (!condition) this.pc += offset;
  }

  protected push(value: number): void {
    this.stack.push(value | 0);
  }

  protected pop(): number {
    return this.stack.pop() ?? 0;
  }

  protected breakHere(): void {
    const slot = this.state.slots[this.state.currentSlot];
    if (!slot) return;
    slot.offset = this.pc;
    slot.status = ScriptStatus.Paused;
    slot.delayed = false;
    // Leaving `status` as Paused (not Dead) means the outer loop resumes it
    // next frame from the saved program counter.
    throw new ScriptStopped();
  }

  // ================================================================ opcodes ==
  //
  // Handlers are grouped the way the opcode table is: flow control, then
  // arithmetic, actors, objects, rooms, verbs, sound and system.

  // --- flow control ---------------------------------------------------------

  protected o_stopObjectCode(): void {
    this.stopObjectCode();
  }

  protected o_breakHere(): void {
    this.breakHere();
  }

  protected o_jumpRelative(): void {
    this.jumpRelative(false);
  }

  protected o_startScript(): void {
    // Read before anything else: bits 0x20 and 0x40 of *this* opcode choose
    // "survives freezing" and "allow recursion", and `getStackList` overwrites
    // `this.opcode` with each list entry's own byte — ending on the 0xFF
    // terminator, which has both bits set. Read afterwards, as this did, every
    // script in every game started freeze-resistant and recursive: a cutscene
    // then froze nothing, so the background scripts a cutscene exists to
    // silence kept running through it. Atlantis's hover-name script is one of
    // them, and it reprints the name under the cursor every frame — which held
    // `VAR_HAVE_MSG` set for ever and hung the first `waitForMessage` after the
    // player fell through the attic floor.
    const freezeResistant = (this.opcode & 0x20) !== 0;
    const recursive = (this.opcode & 0x40) !== 0;
    const script = this.getVarOrDirectByte(PARAM_1);
    const args = this.getStackList(16);
    this.runScript(script, freezeResistant, recursive, args);
  }

  protected o_stopScript(): void {
    const script = this.getVarOrDirectByte(PARAM_1);
    if (script === 0) this.stopObjectCode();
    else this.stopScript(script);
  }

  protected o_chainScript(): void {
    const script = this.getVarOrDirectByte(PARAM_1);
    const args = this.getStackList(16);
    const slot = this.state.slots[this.state.currentSlot];

    // The chained script inherits the caller's cutscene ownership, then the
    // caller dies. Doing it in this order keeps `endCutscene` balanced.
    const cutsceneOverride = slot ? slot.cutsceneOverride : 0;
    const number = slot ? slot.number : 0;

    if (slot) {
      slot.cutsceneOverride = 0;
      slot.number = 0;
      slot.status = ScriptStatus.Dead;
    }
    this.state.currentSlot = -1;

    this.runScript(script, false, false, args);

    const newSlot = this.state.slots.find(
      (candidate) => candidate.number === script && candidate.status !== ScriptStatus.Dead,
    );
    if (newSlot) newSlot.cutsceneOverride = cutsceneOverride;
    void number;

    throw new ScriptStopped();
  }

  protected o_startObject(): void {
    const object = this.getVarOrDirectWord(PARAM_1);
    const entry = this.getVarOrDirectByte(PARAM_2);
    const args = this.getStackList(16);
    this.runObjectScript(object, entry, false, false, args);
  }

  protected o_stopObjectScript(): void {
    this.stopObjectScript(this.getVarOrDirectWord(PARAM_1));
  }

  protected o_isScriptRunning(): void {
    this.getResultPos();
    this.setResult(this.isScriptRunning(this.getVarOrDirectByte(PARAM_1)) ? 1 : 0);
  }

  protected o_freezeScripts(): void {
    const flag = this.getVarOrDirectByte(PARAM_1);
    if (flag) this.freezeScripts(flag);
    else this.unfreezeScripts();
  }

  protected o_delay(): void {
    // A plain 24 bit little-endian frame count.
    //
    // Not inverted: `0xFFFFFF - delay` is how SCUMM v2 stores it, and applying
    // it here turned every delay in a v5 game into about 16.7 million frames —
    // 77 hours. Nothing reports that, because a script sleeping is not an
    // error; the game simply never continues. A logo screen that pauses for two
    // seconds before loading the next room holds for ever.
    let delay = this.fetchByte();
    delay |= this.fetchByte() << 8;
    delay |= this.fetchByte() << 16;

    const slot = this.state.slots[this.state.currentSlot];
    if (slot) {
      slot.delay = delay;
      slot.delayed = true;
      slot.status = ScriptStatus.Paused;
      slot.offset = this.pc;
    }
    throw new ScriptStopped();
  }

  protected o_delayVariable(): void {
    const slot = this.state.slots[this.state.currentSlot];
    if (slot) {
      slot.delay = this.readVar(this.fetchVarRef());
      slot.delayed = true;
      slot.status = ScriptStatus.Paused;
      slot.offset = this.pc;
    }
    throw new ScriptStopped();
  }

  /**
   * Blocks until a condition holds.
   *
   * Implemented by rewinding the program counter to the `wait` opcode itself
   * and yielding, so the test is re-run each frame — exactly what the original
   * does, and why waiting costs nothing while the condition is false.
   */
  protected o_wait(): void {
    const waitOpcodeAddress = this.pc - 1;
    this.opcode = this.fetchByte();

    let keepWaiting = false;
    switch (this.opcode & 0x1f) {
      case 1: {
        const actor = this.engine.getActor(this.getVarOrDirectByte(PARAM_1));
        keepWaiting = Boolean(
          actor && actor.isInCurrentRoom(this.engine.currentRoom) && actor.moving,
        );
        break;
      }
      case 2:
        keepWaiting = this.readVar(VAR.HAVE_MSG) !== 0;
        break;
      case 3:
        // Compared in strips, as the original does: the camera settles to
        // within a strip of its destination, so an exact comparison can wait
        // for a position it never reaches.
        keepWaiting =
          Math.floor(this.engine.camera.current / 8) !==
          Math.floor(this.engine.camera.destination / 8);
        break;
      case 4:
        keepWaiting = this.engine.isSentencePending();
        break;
      default:
        this.reportUnknownSubOpcode('wait', this.opcode);
        break;
    }

    if (!keepWaiting) return;

    this.pc = waitOpcodeAddress;
    this.breakHere();
  }

  protected o_cutscene(): void {
    const args = this.getStackList(25);
    this.engine.beginCutscene(args);
  }

  protected o_endCutscene(): void {
    this.engine.endCutscene();
  }

  /**
   * Marks a resume point for a cutscene the player skips.
   *
   * When the player presses escape the engine jumps here rather than to the
   * end of the script, so state the cutscene set up is still applied.
   */
  protected o_beginOverride(): void {
    const enable = this.fetchByte() !== 0;
    if (enable) {
      this.engine.beginOverride(this.state.currentSlot, this.pc);
      // The override target is the instruction after a fixed 3 byte prologue.
      this.pc += 3;
    } else {
      this.engine.endOverride();
    }
  }

  protected o_pseudoRoom(): void {
    const value = this.fetchByte();
    for (;;) {
      const room = this.fetchByte();
      if (room === 0) break;
      if (room & 0x80) this.engine.setPseudoRoom(room & 0x7f, value);
    }
  }

  protected o_debug(): void {
    this.getVarOrDirectWord(PARAM_1);
  }

  protected o_dummy(): void {
    // Present in the table but unused by shipped scripts.
  }

  // --- arithmetic and comparison -------------------------------------------

  protected o_move(): void {
    this.getResultPos();
    this.setResult(this.getVarOrDirectWord(PARAM_1));
  }

  protected o_add(): void {
    this.getResultPos();
    const value = this.getVarOrDirectWord(PARAM_1);
    this.setResult(this.readVar(this.resultVar) + value);
  }

  protected o_subtract(): void {
    this.getResultPos();
    const value = this.getVarOrDirectWord(PARAM_1);
    this.setResult(this.readVar(this.resultVar) - value);
  }

  protected o_multiply(): void {
    this.getResultPos();
    const value = this.getVarOrDirectWord(PARAM_1);
    this.setResult(Math.trunc(this.readVar(this.resultVar) * value));
  }

  protected o_divide(): void {
    this.getResultPos();
    const value = this.getVarOrDirectWord(PARAM_1);
    this.setResult(value === 0 ? 0 : Math.trunc(this.readVar(this.resultVar) / value));
  }

  protected o_increment(): void {
    this.getResultPos();
    this.setResult(this.readVar(this.resultVar) + 1);
  }

  protected o_decrement(): void {
    this.getResultPos();
    this.setResult(this.readVar(this.resultVar) - 1);
  }

  protected o_and(): void {
    this.getResultPos();
    const value = this.getVarOrDirectWord(PARAM_1);
    this.setResult(this.readVar(this.resultVar) & value);
  }

  protected o_or(): void {
    this.getResultPos();
    const value = this.getVarOrDirectWord(PARAM_1);
    this.setResult(this.readVar(this.resultVar) | value);
  }

  protected o_setVarRange(): void {
    this.getResultPos();
    let count = this.fetchByte();
    const wide = (this.opcode & 0x80) !== 0;
    let target = this.resultVar;

    do {
      const value = wide ? this.fetchWordSigned() : this.fetchByte();
      this.writeVar(target, value);
      target++;
    } while (--count > 0);
  }

  /**
   * A tiny stack machine, used for expressions the simple opcodes cannot
   * express. Sub-opcode 6 runs a nested instruction and pushes its result.
   */
  protected o_expression(): void {
    this.stack.length = 0;
    this.getResultPos();
    const destination = this.resultVar;

    for (;;) {
      if (this.fetchSubOpcode() === 0xff) break;

      switch (this.opcode & 0x1f) {
        case 1:
          this.push(this.getVarOrDirectWord(PARAM_1));
          break;
        case 2: {
          const b = this.pop();
          this.push(this.pop() + b);
          break;
        }
        case 3: {
          const b = this.pop();
          this.push(this.pop() - b);
          break;
        }
        case 4: {
          const b = this.pop();
          this.push(this.pop() * b);
          break;
        }
        case 5: {
          const b = this.pop();
          this.push(b === 0 ? 0 : Math.trunc(this.pop() / b));
          break;
        }
        case 6: {
          this.opcode = this.fetchByte();
          const handler = this.dispatch[this.opcode];
          if (handler) handler.call(this);
          this.push(this.engine.variables[0]);
          break;
        }
        default:
          this.reportUnknownSubOpcode('expression', this.opcode);
          break;
      }
    }

    this.writeVar(destination, this.pop());
  }

  protected o_isEqual(): void {
    const a = this.readVar(this.fetchVarRef());
    const b = this.getVarOrDirectWord(PARAM_1);
    this.jumpRelative(b === a);
  }

  protected o_isNotEqual(): void {
    const a = this.readVar(this.fetchVarRef());
    const b = this.getVarOrDirectWord(PARAM_1);
    this.jumpRelative(b !== a);
  }

  protected o_isGreater(): void {
    const a = this.readVar(this.fetchVarRef());
    const b = this.getVarOrDirectWord(PARAM_1);
    this.jumpRelative(b > a);
  }

  protected o_isGreaterEqual(): void {
    const a = this.readVar(this.fetchVarRef());
    const b = this.getVarOrDirectWord(PARAM_1);
    this.jumpRelative(b >= a);
  }

  protected o_isLess(): void {
    const a = this.readVar(this.fetchVarRef());
    const b = this.getVarOrDirectWord(PARAM_1);
    this.jumpRelative(b < a);
  }

  protected o_isLessEqual(): void {
    const a = this.readVar(this.fetchVarRef());
    const b = this.getVarOrDirectWord(PARAM_1);
    this.jumpRelative(b <= a);
  }

  protected o_equalZero(): void {
    this.jumpRelative(this.readVar(this.fetchVarRef()) === 0);
  }

  protected o_notEqualZero(): void {
    this.jumpRelative(this.readVar(this.fetchVarRef()) !== 0);
  }

  protected o_getRandomNr(): void {
    this.getResultPos();
    const max = this.getVarOrDirectByte(PARAM_1);
    this.setResult(this.engine.random(max));
  }

  // --- actors ---------------------------------------------------------------

  protected o_putActor(): void {
    const actorNumber = this.getVarOrDirectByte(PARAM_1);
    const x = this.getVarOrDirectWord(PARAM_2);
    const y = this.getVarOrDirectWord(PARAM_3);
    this.engine.putActor(actorNumber, x, y);
  }

  protected o_putActorInRoom(): void {
    const actorNumber = this.getVarOrDirectByte(PARAM_1);
    const room = this.getVarOrDirectByte(PARAM_2);
    this.engine.putActorInRoom(actorNumber, room);
  }

  protected o_putActorAtObject(): void {
    const actorNumber = this.getVarOrDirectByte(PARAM_1);
    const object = this.getVarOrDirectWord(PARAM_2);
    this.engine.putActorAtObject(actorNumber, object);
  }

  protected o_walkActorTo(): void {
    const actorNumber = this.getVarOrDirectByte(PARAM_1);
    const x = this.getVarOrDirectWord(PARAM_2);
    const y = this.getVarOrDirectWord(PARAM_3);
    this.engine.startWalkActor(actorNumber, x, y, -1);
  }

  protected o_walkActorToActor(): void {
    const actorNumber = this.getVarOrDirectByte(PARAM_1);
    const targetNumber = this.getVarOrDirectByte(PARAM_2);
    const distance = this.fetchByte();
    this.engine.walkActorToActor(actorNumber, targetNumber, distance);
  }

  protected o_walkActorToObject(): void {
    const actorNumber = this.getVarOrDirectByte(PARAM_1);
    const object = this.getVarOrDirectWord(PARAM_2);
    this.engine.walkActorToObject(actorNumber, object);
  }

  protected o_faceActor(): void {
    const actorNumber = this.getVarOrDirectByte(PARAM_1);
    const object = this.getVarOrDirectWord(PARAM_2);
    this.engine.faceActorTowards(actorNumber, object);
  }

  protected o_animateActor(): void {
    const actorNumber = this.getVarOrDirectByte(PARAM_1);
    const animation = this.getVarOrDirectByte(PARAM_2);
    this.engine.animateActor(actorNumber, animation);
  }

  protected o_actorFromPos(): void {
    this.getResultPos();
    const x = this.getVarOrDirectWord(PARAM_1);
    const y = this.getVarOrDirectWord(PARAM_2);
    this.setResult(this.engine.actorFromPos(x, y));
  }

  protected o_getActorMoving(): void {
    this.getResultPos();
    const actor = this.engine.getActor(this.getVarOrDirectByte(PARAM_1));
    this.setResult(actor ? actor.moving : 0);
  }

  protected o_getActorRoom(): void {
    this.getResultPos();
    const actor = this.engine.getActor(this.getVarOrDirectByte(PARAM_1));
    this.setResult(actor ? actor.room : 0);
  }

  protected o_getActorX(): void {
    this.getResultPos();
    this.setResult(this.engine.getObjectOrActorX(this.getVarOrDirectWord(PARAM_1)));
  }

  protected o_getActorY(): void {
    this.getResultPos();
    this.setResult(this.engine.getObjectOrActorY(this.getVarOrDirectWord(PARAM_1)));
  }

  protected o_getActorFacing(): void {
    this.getResultPos();
    const actor = this.engine.getActor(this.getVarOrDirectByte(PARAM_1));
    this.setResult(actor ? actor.facing : 0);
  }

  protected o_getActorCostume(): void {
    this.getResultPos();
    const actor = this.engine.getActor(this.getVarOrDirectByte(PARAM_1));
    this.setResult(actor ? actor.costume : 0);
  }

  protected o_getActorElevation(): void {
    this.getResultPos();
    const actor = this.engine.getActor(this.getVarOrDirectByte(PARAM_1));
    this.setResult(actor ? actor.elevation : 0);
  }

  protected o_getActorWidth(): void {
    this.getResultPos();
    const actor = this.engine.getActor(this.getVarOrDirectByte(PARAM_1));
    this.setResult(actor ? actor.width : 0);
  }

  protected o_getActorScale(): void {
    this.getResultPos();
    const actor = this.engine.getActor(this.getVarOrDirectByte(PARAM_1));
    this.setResult(actor ? actor.scaleX : 255);
  }

  protected o_getActorWalkBox(): void {
    this.getResultPos();
    const actor = this.engine.getActor(this.getVarOrDirectByte(PARAM_1));
    this.setResult(actor && !actor.ignoreBoxes ? actor.walkbox : 0);
  }

  protected o_getAnimCounter(): void {
    this.getResultPos();
    const actor = this.engine.getActor(this.getVarOrDirectByte(PARAM_1));
    this.setResult(actor ? actor.cost.animCounter : 0);
  }

  protected o_isActorInBox(): void {
    const actor = this.engine.getActor(this.getVarOrDirectByte(PARAM_1));
    const box = this.getVarOrDirectByte(PARAM_2);
    const inside = Boolean(actor && this.engine.boxes?.contains(box, actor.x, actor.y));
    this.jumpRelative(inside);
  }

  protected o_getClosestObjActor(): void {
    this.getResultPos();
    const target = this.getVarOrDirectWord(PARAM_1);
    this.setResult(this.engine.getClosestObjOrActor(target));
  }

  protected o_getDist(): void {
    this.getResultPos();
    const a = this.getVarOrDirectWord(PARAM_1);
    const b = this.getVarOrDirectWord(PARAM_2);
    this.setResult(this.engine.getObjectOrActorDistance(a, b));
  }

  /**
   * The actor property setter: a sub-opcode stream terminated by 0xFF.
   *
   * This is where scripts configure costumes, walk speed, animation frames,
   * palette overrides and talk colours.
   */
  /**
   * This Version's number for an `actorOps` sub-opcode, as v5 numbers them.
   *
   * Identity for v5, which is where the numbering comes from. v2, v3 and v4
   * use their own and run it through a conversion table
   * (`ScummEngine_v5::o5_actorOps`), and the reason it has to be applied
   * *before* the switch rather than after is the operand count: their
   * sub-opcode 4 is v5's 2, which takes two bytes where v5's 4 takes one. One
   * byte short is a desync, and every sub-opcode after it is read out of the
   * middle of something else — which is what the remaining Loom scripts looked
   * like before this existed.
   */
  protected actorOpFor(sub: number): number {
    return sub;
  }

  protected o_actorOps(): void {
    const actorNumber = this.getVarOrDirectByte(PARAM_1);
    const actor = this.engine.getActor(actorNumber);

    for (;;) {
      if (this.fetchSubOpcode() === 0xff) break;

      switch (this.actorOpFor(this.opcode & 0x1f)) {
        case 0: {
          // Unused in v5, but the operand must still be consumed.
          this.getVarOrDirectByte(PARAM_1);
          break;
        }
        case 1: {
          const costume = this.getVarOrDirectByte(PARAM_1);
          if (actor) this.engine.setActorCostume(actor, costume);
          break;
        }
        case 2: {
          const x = this.getVarOrDirectByte(PARAM_1);
          const y = this.getVarOrDirectByte(PARAM_2);
          if (actor) {
            actor.speedX = x;
            actor.speedY = y;
          }
          break;
        }
        case 3: {
          const sound = this.getVarOrDirectByte(PARAM_1);
          void sound;
          break;
        }
        case 4: {
          const frame = this.getVarOrDirectByte(PARAM_1);
          if (actor) actor.walkFrame = frame;
          break;
        }
        case 5: {
          // Talk animation: the frames to start and stop talking on.
          const start = this.getVarOrDirectByte(PARAM_1);
          const stop = this.getVarOrDirectByte(PARAM_2);
          if (actor) {
            actor.talkStartFrame = start;
            actor.talkStopFrame = stop;
          }
          break;
        }
        case 6: {
          const frame = this.getVarOrDirectByte(PARAM_1);
          if (actor) actor.standFrame = frame;
          break;
        }
        case 7: {
          this.getVarOrDirectByte(PARAM_1);
          this.getVarOrDirectByte(PARAM_2);
          this.getVarOrDirectByte(PARAM_3);
          break;
        }
        case 8:
          if (actor) this.engine.initActor(actor, 0);
          break;
        case 9: {
          const elevation = this.getVarOrDirectWord(PARAM_1);
          if (actor) {
            actor.elevation = elevation;
            actor.needRedraw = true;
          }
          break;
        }
        case 10:
          if (actor) {
            actor.walkFrame = 2;
            actor.standFrame = 3;
            actor.talkStartFrame = 4;
            actor.talkStopFrame = 5;
            actor.initFrame = 1;
          }
          break;
        case 11: {
          // Palette override: high byte is the index, low byte the colour.
          const value = this.getVarOrDirectByte(PARAM_1);
          const index = this.getVarOrDirectByte(PARAM_2);
          if (actor && index < actor.palette.length) actor.palette[index] = value;
          break;
        }
        case 12: {
          const talkColor = this.getVarOrDirectByte(PARAM_1);
          if (actor) actor.talkColor = talkColor;
          break;
        }
        case 13: {
          const { text } = this.fetchMessage();
          if (actor) actor.name = text;
          break;
        }
        case 14: {
          // Init animation: one byte. Reading the two that "talk animation"
          // takes left a byte behind, and the instruction after this one was
          // then read from the middle of it.
          const frame = this.getVarOrDirectByte(PARAM_1);
          if (actor) actor.initFrame = frame;
          break;
        }
        case 16: {
          // Actor width, one byte. Reading no operand at all left it to be
          // executed as the next sub-opcode.
          const width = this.getVarOrDirectByte(PARAM_1);
          if (actor) actor.width = width;
          break;
        }
        case 17: {
          // Scale, separately for x and y: two bytes in v5, and *one* before
          // it, applied to both axes. Reading two on a v4 game takes a byte
          // that belongs to the next sub-opcode.
          const scaleX = this.getVarOrDirectByte(PARAM_1);
          const scaleY = this.classicVersion >= 5 ? this.getVarOrDirectByte(PARAM_2) : scaleX;
          if (actor) {
            actor.scaleX = scaleX;
            actor.scaleY = scaleY;
            actor.needRedraw = true;
          }
          break;
        }
        case 18:
          if (actor) actor.neverZClip = 0;
          break;
        case 19: {
          const value = this.getVarOrDirectByte(PARAM_1);
          if (actor) actor.neverZClip = value;
          break;
        }
        case 20:
        case 21: {
          // Ignore or follow walk boxes. Sub-opcode 20 ignores them, 21 follows
          // them, which the low bit distinguishes.
          const ignore = (this.opcode & 1) === 0;
          if (actor) {
            actor.ignoreBoxes = ignore;
            actor.forceClip = 0;
            this.engine.putActor(actor.number, actor.x, actor.y);
          }
          break;
        }
        case 22: {
          // Animation speed, which takes a byte. Reading no operand at all
          // left that byte to be executed as the next instruction. (The frame
          // defaults this used to set belong to sub-opcode 10, which already
          // does it.)
          const speed = this.getVarOrDirectByte(PARAM_1);
          if (actor) {
            actor.animSpeed = speed;
            actor.animProgress = speed;
          }
          break;
        }
        case 23: {
          // Shadow mode: a byte. Recorded but not yet used — the shadow
          // palettes it selects are not implemented — while still consuming
          // the right number of bytes, which is what the rest of the script
          // depends on.
          const mode = this.getVarOrDirectByte(PARAM_1);
          if (actor) actor.shadowMode = mode;
          break;
        }
        default:
          this.reportUnknownSubOpcode('actorOps', this.opcode);
          break;
      }
    }
  }

  // --- objects --------------------------------------------------------------

  protected o_drawObject(): void {
    const object = this.getVarOrDirectWord(PARAM_1);
    let state = 1;

    this.opcode = this.fetchByte();
    switch (this.opcode & 0x1f) {
      case 1: {
        const x = this.getVarOrDirectWord(PARAM_1);
        const y = this.getVarOrDirectWord(PARAM_2);
        // The walk-to point travels with it: v5 moves `walk_x`/`walk_y` by the
        // same delta so an actor sent to the object still arrives at the same
        // spot on it.
        this.engine.setObjectPosition(object, x, y, true);
        break;
      }
      case 2:
        state = this.getVarOrDirectWord(PARAM_1);
        break;
      case 0x1f:
        // "Neither": drawn where and as it already is. Not a missing case.
        break;
      default:
        this.reportUnknownSubOpcode('drawObject', this.opcode);
        break;
    }

    // Whatever else stands on this rectangle is put away first. A room keeps
    // each appearance of a thing as a separate object on the same box, and
    // v5's `drawObject` hides the rest before drawing the one it wants —
    // otherwise the previous picture is still stamped underneath and the two
    // show through each other.
    this.engine.clearObjectsSharingBox(object);
    this.engine.putState(object, state);
  }

  protected o_setState(): void {
    const object = this.getVarOrDirectWord(PARAM_1);
    const state = this.getVarOrDirectByte(PARAM_2);
    this.engine.putState(object, state);
  }

  protected o_getObjectState(): void {
    this.getResultPos();
    this.setResult(this.engine.getState(this.getVarOrDirectWord(PARAM_1)));
  }

  protected o_getObjectOwner(): void {
    this.getResultPos();
    this.setResult(this.engine.getOwner(this.getVarOrDirectWord(PARAM_1)));
  }

  protected o_setOwnerOf(): void {
    const object = this.getVarOrDirectWord(PARAM_1);
    const owner = this.getVarOrDirectByte(PARAM_2);
    this.engine.setOwnerOf(object, owner);
  }

  protected o_setClass(): void {
    const object = this.getVarOrDirectWord(PARAM_1);
    for (const value of this.getStackList(16)) {
      if ((value & 0x7f) === 0) {
        this.engine.clearClasses(object);
      } else {
        this.engine.putClass(object, value & 0x7f, (value & 0x80) !== 0);
      }
    }
  }

  protected o_ifClassOfIs(): void {
    const object = this.getVarOrDirectWord(PARAM_1);
    const classes = this.getStackList(16);
    let matches = true;
    for (const value of classes) {
      const wanted = (value & 0x80) !== 0;
      if (this.engine.getClass(object, value & 0x7f) !== wanted) matches = false;
    }
    this.jumpRelative(matches);
  }

  /**
   * The object at a point, for a script hunting what the cursor is over.
   *
   * Both coordinates are *byte* operands, as `o5_findObject` reads them: a
   * variable reference is still a word, so the shipped form
   * `findObject Var[..] Var[..]` decodes the same either way, but an immediate
   * pair does not — read as words it swallows two bytes too many and every
   * instruction after it is nonsense.
   */
  protected o_findObject(): void {
    this.getResultPos();
    const x = this.getVarOrDirectByte(PARAM_1);
    const y = this.getVarOrDirectByte(PARAM_2);
    this.setResult(this.engine.findObjectAt(x, y));
  }

  protected o_setObjectName(): void {
    const object = this.getVarOrDirectWord(PARAM_1);
    const { text } = this.fetchMessage();
    this.engine.setObjectName(object, text);
  }

  protected o_pickupObject(): void {
    const object = this.getVarOrDirectWord(PARAM_1);
    const room = this.getVarOrDirectByte(PARAM_2);
    this.engine.pickupObject(object, room || this.engine.currentRoom);
  }

  protected o_getInventoryCount(): void {
    this.getResultPos();
    this.setResult(this.engine.getInventoryCount(this.getVarOrDirectByte(PARAM_1)));
  }

  protected o_findInventory(): void {
    this.getResultPos();
    const owner = this.getVarOrDirectByte(PARAM_1);
    const index = this.getVarOrDirectByte(PARAM_2);
    this.setResult(this.engine.findInventory(owner, index));
  }

  protected o_getVerbEntrypoint(): void {
    this.getResultPos();
    const object = this.getVarOrDirectWord(PARAM_1);
    const entry = this.getVarOrDirectWord(PARAM_2);
    this.setResult(this.engine.getVerbEntrypoint(object, entry));
  }

  // --- rooms and camera -----------------------------------------------------

  protected o_loadRoom(): void {
    const room = this.getVarOrDirectByte(PARAM_1);
    this.engine.startScene(room, null, 0);
  }

  protected o_loadRoomWithEgo(): void {
    const object = this.getVarOrDirectWord(PARAM_1);
    const room = this.getVarOrDirectByte(PARAM_2);
    const x = this.fetchWordSigned();
    const y = this.fetchWordSigned();
    this.engine.loadRoomWithEgo(object, room, x, y);
  }

  protected o_panCameraTo(): void {
    this.engine.panCameraTo(this.getVarOrDirectWord(PARAM_1));
  }

  protected o_setCameraAt(): void {
    this.engine.setCameraAt(this.getVarOrDirectWord(PARAM_1));
  }

  protected o_actorFollowCamera(): void {
    this.engine.actorFollowCamera(this.getVarOrDirectByte(PARAM_1));
  }

  protected o_lights(): void {
    const a = this.getVarOrDirectByte(PARAM_1);
    const b = this.fetchByte();
    const c = this.fetchByte();
    this.engine.setLights(a, b, c);
  }

  /** Walk box flags, scales and the routing matrix. */
  protected o_matrixOps(): void {
    this.opcode = this.fetchByte();
    switch (this.opcode & 0x1f) {
      case 1: {
        const box = this.getVarOrDirectByte(PARAM_1);
        const value = this.getVarOrDirectByte(PARAM_2);
        this.engine.setBoxFlags(box, value);
        break;
      }
      case 2: {
        const box = this.getVarOrDirectByte(PARAM_1);
        const value = this.getVarOrDirectByte(PARAM_2);
        this.engine.setBoxScale(box, value);
        break;
      }
      case 3: {
        const box = this.getVarOrDirectByte(PARAM_1);
        const value = this.getVarOrDirectByte(PARAM_2);
        this.engine.setBoxScale(box, (value - 1) | 0x8000);
        break;
      }
      case 4:
        this.engine.rebuildBoxMatrix();
        break;
      default:
        this.reportUnknownSubOpcode('matrixOps', this.opcode);
        break;
    }
  }

  /** Palette effects, screen layout, shadow palettes and scale slots. */
  protected o_roomOps(): void {
    // v3 reads this instruction's first two operands *before* its sub-opcode,
    // and every Version after it reads them after. Same instruction, same
    // operands, opposite order — so a reader taking v5's order on a v3 game
    // reads the sub-opcode out of the middle of the first operand and then
    // reads two more from wherever that leaves it.
    // (`paramsBeforeOpcode` in `ScummEngine_v5::o5_roomOps`.)
    let first = 0;
    let second = 0;
    const early = this.classicVersion === 3;
    if (early) {
      first = this.getVarOrDirectWord(PARAM_1);
      second = this.getVarOrDirectWord(PARAM_2);
    }

    this.opcode = this.fetchByte();

    switch (this.opcode & 0x1f) {
      case 1: {
        const min = early ? first : this.getVarOrDirectWord(PARAM_1);
        const max = early ? second : this.getVarOrDirectWord(PARAM_2);
        this.engine.setCameraBounds(min, max);
        break;
      }
      case 2: {
        // "Room colour" *is* a v3/v4 instruction and has no v5 form, so which
        // way this reads depends on the Version: two words before v5, and
        // nothing at all at v5, where reading a pair would consume the next
        // instruction's bytes.
        if (this.classicVersion >= 5) {
          this.reportUnknownSubOpcode('roomOps', this.opcode);
          break;
        }
        const colour = early ? first : this.getVarOrDirectWord(PARAM_1);
        const slot = early ? second : this.getVarOrDirectWord(PARAM_2);
        this.engine.setRoomColour(slot, colour);
        break;
      }
      case 3: {
        const b = early ? first : this.getVarOrDirectWord(PARAM_1);
        const h = early ? second : this.getVarOrDirectWord(PARAM_2);
        this.engine.setScreenLayout(b, h);
        break;
      }
      case 4: {
        // Before v5 this is a shadow-palette slot written as two words; at v5
        // it grew into a full colour and an index behind a second sub-opcode.
        if (this.classicVersion < 5) {
          const colour = early ? first : this.getVarOrDirectWord(PARAM_1);
          const slot = early ? second : this.getVarOrDirectWord(PARAM_2);
          this.engine.setRoomShadowColour(slot, colour);
          break;
        }
        const red = this.getVarOrDirectWord(PARAM_1);
        const green = this.getVarOrDirectWord(PARAM_2);
        const blue = this.getVarOrDirectWord(PARAM_3);
        this.opcode = this.fetchByte();
        const index = this.getVarOrDirectByte(PARAM_1);
        this.engine.setPaletteColor(index, red, green, blue);
        break;
      }
      case 5:
        this.engine.markScreenDirty();
        break;
      case 6:
        this.engine.markScreenDirty();
        break;
      case 7: {
        const a = this.getVarOrDirectByte(PARAM_1);
        const b = this.getVarOrDirectByte(PARAM_2);
        this.opcode = this.fetchByte();
        const c = this.getVarOrDirectByte(PARAM_1);
        const d = this.getVarOrDirectByte(PARAM_2);
        this.opcode = this.fetchByte();
        const e = this.getVarOrDirectByte(PARAM_2);
        this.engine.setScaleSlot(e, 0, b, a, 0, d, c);
        break;
      }
      case 8: {
        const scale = this.getVarOrDirectByte(PARAM_1);
        const start = this.getVarOrDirectByte(PARAM_2);
        const end = this.getVarOrDirectByte(PARAM_3);
        this.engine.setPaletteIntensity(start, end, scale, scale, scale);
        break;
      }
      case 9: {
        const a = this.getVarOrDirectByte(PARAM_1);
        const b = this.getVarOrDirectByte(PARAM_2);
        this.engine.saveLoadRoom(a, b);
        break;
      }
      case 10: {
        const effect = this.getVarOrDirectWord(PARAM_1);
        this.engine.setScreenEffect(effect);
        break;
      }
      case 11: {
        const red = this.getVarOrDirectWord(PARAM_1);
        const green = this.getVarOrDirectWord(PARAM_2);
        const blue = this.getVarOrDirectWord(PARAM_3);
        this.opcode = this.fetchByte();
        const start = this.getVarOrDirectByte(PARAM_1);
        const end = this.getVarOrDirectByte(PARAM_2);
        this.engine.darkenPalette(red, green, blue, start, end);
        break;
      }
      case 12: {
        const red = this.getVarOrDirectWord(PARAM_1);
        const green = this.getVarOrDirectWord(PARAM_2);
        const blue = this.getVarOrDirectWord(PARAM_3);
        this.opcode = this.fetchByte();
        const start = this.getVarOrDirectByte(PARAM_1);
        const end = this.getVarOrDirectByte(PARAM_2);
        this.engine.setShadowPalette(red, green, blue, start, end);
        break;
      }
      case 13:
      case 14: {
        // Save or load a string to a file. What follows the index is a plain
        // NUL-terminated *filename*, not a message: `o5_roomOps` reads it with
        // bare `fetchScriptByte` calls and no escape handling, so a 0xFF in it
        // is a character rather than a control code. The two readings agree on
        // every real script — filenames are ASCII — and disagreeing about why
        // is how a reader ends up right by accident.
        //
        // There is no file to write to here, so the name is kept in the string
        // table under the index the instruction gave. Indy 4 uses this for its
        // IQ points and nothing this engine does yet depends on the contents.
        const index = this.getVarOrDirectByte(PARAM_1);
        this.engine.setString(index, this.fetchFilename());
        break;
      }
      case 15: {
        // Four operands behind three sub-opcode bytes, not three behind two.
        //
        // Found by the disassembler rather than by play: reading only `a`, `b`
        // and `c` left two bytes of every `roomOps 15` behind, and the next
        // instruction was then read from the middle of them. It survived
        // because Atlantis uses the instruction in one room's local script,
        // where the two stray bytes happen to decode as a getter nobody reads —
        // which is exactly the silent, cascading failure a measured boundary
        // exists to prevent. `ScummEngine_v5::o5_roomOps` case 15 is the
        // reference.
        const a = this.getVarOrDirectByte(PARAM_1);
        this.opcode = this.fetchByte();
        const b = this.getVarOrDirectByte(PARAM_1);
        const c = this.getVarOrDirectByte(PARAM_2);
        this.opcode = this.fetchByte();
        const d = this.getVarOrDirectByte(PARAM_1);
        this.engine.palManipulate(a, b, c, d);
        break;
      }
      case 16: {
        const cycle = this.getVarOrDirectByte(PARAM_1);
        const delay = this.getVarOrDirectByte(PARAM_2);
        this.engine.setCycleSpeed(cycle, delay);
        break;
      }
      default:
        this.reportUnknownSubOpcode('roomOps', this.opcode);
        break;
    }
  }

  // --- text and sentences ---------------------------------------------------

  protected o_print(): void {
    const actorNumber = this.getVarOrDirectByte(PARAM_1);
    this.decodeParseString(actorNumber);
  }

  protected o_printEgo(): void {
    this.decodeParseString(this.readVar(VAR.EGO));
  }

  /**
   * Each slot's settings, remembered between the instruction that sets them
   * and the one that prints.
   *
   * A script configures a slot with a `print` that carries a position and a
   * colour but no text, and prints to it later with one that carries only
   * text — the original saves the settings when a `print` ends without a
   * message and reloads them at the start of the next. Filled lazily, because
   * a game that never addresses a slot should not pay for it.
   */
  private readonly textDefaults = new Map<number, TextOptions>();

  /**
   * The text sub-opcode stream shared by `print` and `printEgo`.
   *
   * Sub-opcode 15 ("text") is terminal: the message runs to the end of the
   * instruction, so nothing may follow it — and it is also the one that does
   * *not* save the slot's settings, which is why the save happens after the
   * loop rather than on the way out of it.
   */
  protected decodeParseString(actorNumber: number): void {
    // 252, 253 and 254 are not actors. v3 to v5 have one `print` instruction
    // for all four destinations and choose between them here, so the operand
    // is a slot number as often as it is a speaker.
    const slot = this.slotFor(actorNumber);
    const options = this.engine.beginTextOptions(actorNumber);
    const saved = this.textDefaults.get(slot);
    if (saved) Object.assign(options, saved, { actor: actorNumber, text: '' });
    options.slot = slot;

    for (;;) {
      if (this.fetchSubOpcode() === 0xff) break;

      switch (this.opcode & 0xf) {
        case 0:
          // "At": both coordinates, in one instruction. Reading only x left the
          // y word to be taken as the next sub-opcode, which is how a string's
          // own letters ended up being executed as instructions.
          options.x = this.getVarOrDirectWord(PARAM_1);
          options.y = this.getVarOrDirectWord(PARAM_2);
          options.hasPosition = true;
          options.overhead = false;
          break;
        case 1:
          // Colour, as a byte.
          options.color = this.getVarOrDirectByte(PARAM_1);
          break;
        case 2:
          // "Clipped": the right edge the text wraps at.
          options.right = this.getVarOrDirectWord(PARAM_1);
          break;
        case 3:
          // "Erase" a region. Not implemented, but its two words are still
          // part of the instruction and have to be consumed.
          this.getVarOrDirectWord(PARAM_1);
          this.getVarOrDirectWord(PARAM_2);
          break;
        case 4:
          options.center = true;
          options.overhead = false;
          break;
        case 6:
          options.center = false;
          options.left = true;
          options.overhead = false;
          break;
        case 7:
          options.overhead = true;
          break;
        case 8: {
          // "Play sound then talk" — the two words are a sound offset and size.
          const offset = this.getVarOrDirectWord(PARAM_1);
          const size = this.getVarOrDirectWord(PARAM_2);
          options.speechOffset = offset;
          options.speechSize = size;
          break;
        }
        case 15: {
          const { text } = this.fetchMessage();
          options.text = text;
          this.engine.showText(options);
          return;
        }
        default:
          this.reportUnknownSubOpcode('parseString', this.opcode);
          break;
      }
    }

    this.textDefaults.set(slot, { ...options });
    this.engine.applyTextOptions(options);
  }

  /**
   * Which text slot a `print` operand names.
   *
   * v3, v4 and v5 read three of the numbers as slots. v2 reads none of them
   * that way — its `print` always speaks — and Maniac Mansion's scripts do use
   * high actor numbers, so answering as v3 would send a line an actor says to
   * the painted slot and leave it on the screen for good.
   */
  private slotFor(actorNumber: number): number {
    if (this.classicVersion < 3) return TEXT_SLOT.Speech;
    return TEXT_SLOT_FOR_ACTOR[actorNumber] ?? TEXT_SLOT.Speech;
  }

  protected o_getStringWidth(): void {
    this.getResultPos();
    const charset = this.getVarOrDirectByte(PARAM_1);
    const index = this.getVarOrDirectByte(PARAM_2);
    this.setResult(this.engine.getStringWidth(charset, index));
  }

  protected o_stringOps(): void {
    this.opcode = this.fetchByte();
    switch (this.opcode & 0x1f) {
      case 1: {
        const index = this.getVarOrDirectByte(PARAM_1);
        const { text } = this.fetchMessage();
        this.engine.setString(index, text);
        break;
      }
      case 2: {
        const from = this.getVarOrDirectByte(PARAM_1);
        const to = this.getVarOrDirectByte(PARAM_2);
        this.engine.copyString(from, to);
        break;
      }
      case 3: {
        const index = this.getVarOrDirectByte(PARAM_1);
        const position = this.getVarOrDirectByte(PARAM_2);
        const value = this.getVarOrDirectByte(PARAM_3);
        this.engine.setStringChar(index, position, value);
        break;
      }
      case 4: {
        this.getResultPos();
        const index = this.getVarOrDirectByte(PARAM_1);
        const position = this.getVarOrDirectByte(PARAM_2);
        this.setResult(this.engine.getStringChar(index, position));
        break;
      }
      case 5: {
        const index = this.getVarOrDirectByte(PARAM_1);
        const size = this.getVarOrDirectByte(PARAM_2);
        this.engine.createString(index, size);
        break;
      }
      default:
        this.reportUnknownSubOpcode('stringOps', this.opcode);
        break;
    }
  }

  protected o_doSentence(): void {
    const verb = this.getVarOrDirectByte(PARAM_1);
    if (verb === 0xfe) {
      this.engine.stopSentence();
      return;
    }
    const objectA = this.getVarOrDirectWord(PARAM_2);
    const objectB = this.getVarOrDirectWord(PARAM_3);
    this.engine.doSentence(verb, objectA, objectB);
  }

  // --- verbs ----------------------------------------------------------------

  protected o_verbOps(): void {
    const verbNumber = this.getVarOrDirectByte(PARAM_1);
    const verb = this.engine.verbs.getOrCreate(verbNumber);

    for (;;) {
      if (this.fetchSubOpcode() === 0xff) break;

      switch (this.opcode & 0x1f) {
        case 1: {
          // The image, and the room it has to be fetched from — which the
          // instruction does not carry. The original copies the picture out of
          // the *room resource* into a resource of the verb's own
          // (`setVerbObject(_roomResource, a, slot)`), and only when that room
          // is the one holding the object: found nowhere, it copies nothing and
          // the verb keeps the picture it already had. Nothing is copied here,
          // so the room is remembered and the lookup deferred — and remembered
          // under the same condition, or the copy the original keeps would be
          // thrown away.
          //
          // Loom is what this is for. Every piece of its distaff is an object
          // in room 1, defined there once; then the game re-positions the same
          // verbs from whichever room the player is in, twenty-odd times a
          // game. Recorded unconditionally, the second definition points the
          // staff at a room that has never heard of it and the interface goes
          // blank — and unclickable with it, because a verb that draws nothing
          // has no bounds to hit.
          const image = this.getVarOrDirectWord(PARAM_1);
          const room = this.readVar(VAR.ROOM_RESOURCE);
          verb.type = 'image';
          if (this.engine.roomHasObjectImage(room, image)) {
            verb.image = image;
            verb.imageRoom = room;
          }
          break;
        }
        case 2: {
          const { text } = this.fetchMessage();
          verb.text = text;
          verb.type = 'text';
          // A game that writes its own sentence line owns it from here on;
          // the interpreter stops composing one of its own.
          if (verbNumber === 0) this.engine.claimSentenceLine();
          break;
        }
        case 3:
          verb.color = this.getVarOrDirectByte(PARAM_1);
          break;
        case 4:
          verb.hiColor = this.getVarOrDirectByte(PARAM_1);
          break;
        case 5:
          verb.x = this.getVarOrDirectWord(PARAM_1);
          verb.y = this.getVarOrDirectWord(PARAM_2);
          break;
        case 6:
          verb.enabled = true;
          break;
        case 7:
          verb.enabled = false;
          break;
        case 8:
          this.engine.verbs.remove(verbNumber);
          break;
        case 9:
          this.engine.verbs.create(verbNumber, this.engine.currentCharsetId);
          break;
        case 16:
          verb.dimColor = this.getVarOrDirectByte(PARAM_1);
          break;
        case 17:
          verb.dim = true;
          break;
        case 18:
          verb.key = this.getVarOrDirectByte(PARAM_1);
          break;
        case 19:
          verb.center = true;
          break;
        case 20: {
          const stringIndex = this.getVarOrDirectWord(PARAM_1);
          verb.text = this.engine.getString(stringIndex);
          verb.type = 'text';
          if (verbNumber === 0) this.engine.claimSentenceLine();
          break;
        }
        case 22: {
          // "Assign object": the image, then the room it lives in — a word and
          // a byte, not two words. Reading a word for the room consumed one
          // byte too many and put the program counter mid-instruction.
          const image = this.getVarOrDirectWord(PARAM_1);
          const room = this.getVarOrDirectByte(PARAM_2);
          verb.image = image;
          verb.imageRoom = room;
          verb.type = 'image';
          break;
        }
        case 23:
          verb.bakColor = this.getVarOrDirectByte(PARAM_1);
          break;
        default:
          this.reportUnknownSubOpcode('verbOps', this.opcode);
          break;
      }
    }
    this.engine.verbs.markDirty(verbNumber);
  }

  protected o_saveRestoreVerbs(): void {
    this.opcode = this.fetchByte();
    const a = this.getVarOrDirectByte(PARAM_1);
    const b = this.getVarOrDirectByte(PARAM_2);
    const c = this.getVarOrDirectByte(PARAM_3);

    switch (this.opcode) {
      case 1:
        this.engine.verbs.saveRange(a, b, c);
        break;
      case 2:
        this.engine.verbs.restoreRange(a, b, c);
        break;
      case 3:
        this.engine.verbs.deleteRange(a, b, c);
        break;
      default:
        this.reportUnknownSubOpcode('saveRestoreVerbs', this.opcode);
        break;
    }
  }

  protected o_cursorCommand(): void {
    this.opcode = this.fetchByte();
    switch (this.opcode & 0x1f) {
      case 1:
        this.engine.setCursorVisible(true);
        break;
      case 2:
        this.engine.setCursorVisible(false);
        break;
      case 3:
        this.engine.setUserPut(true);
        break;
      case 4:
        this.engine.setUserPut(false);
        break;
      case 5:
        this.engine.setCursorVisible(true, true);
        break;
      case 6:
        this.engine.setCursorVisible(false, true);
        break;
      case 7:
        this.engine.setUserPut(true, true);
        break;
      case 8:
        this.engine.setUserPut(false, true);
        break;
      case 10: {
        const index = this.getVarOrDirectByte(PARAM_1);
        const shape = this.getVarOrDirectByte(PARAM_2);
        this.engine.setCursorImage(index, shape);
        break;
      }
      case 11: {
        const index = this.getVarOrDirectByte(PARAM_1);
        const x = this.getVarOrDirectByte(PARAM_2);
        const y = this.getVarOrDirectByte(PARAM_3);
        this.engine.setCursorHotspot(index, x, y);
        break;
      }
      case 12:
        this.engine.setCurrentCursor(this.getVarOrDirectByte(PARAM_1));
        break;
      case 13:
        // Selects the charset — a single byte. Reading a 0xFF-terminated list
        // here (as sub-opcode 14 legitimately does) swallowed whatever
        // followed until it happened to find an 0xFF, which left the program
        // counter mid-instruction and every later read in the script wrong.
        this.engine.setCharsetResource(this.getVarOrDirectByte(PARAM_1));
        break;
      case 14:
        if (this.classicVersion === 3) {
          // v3 initialises the charset with two bytes here; v4 and v5 write a
          // whole colour table as an 0xFF-terminated list. A list read where
          // two bytes were written swallows everything up to the next 0xFF.
          this.getVarOrDirectByte(PARAM_1);
          this.getVarOrDirectByte(PARAM_2);
          break;
        }
        this.engine.setCharsetColors(this.getStackList(16));
        break;
      default:
        this.reportUnknownSubOpcode('cursorCommand', this.opcode);
        break;
    }

    this.engine.variables[VAR.CURSORSTATE] = this.engine.cursorState;
    this.engine.variables[VAR.USERPUT] = this.engine.userPut ? 1 : 0;
  }

  // --- sound ----------------------------------------------------------------

  protected o_startSound(): void {
    this.engine.sound.startSound(this.getVarOrDirectByte(PARAM_1));
  }

  protected o_stopSound(): void {
    this.engine.sound.stopSound(this.getVarOrDirectByte(PARAM_1));
  }

  protected o_startMusic(): void {
    this.engine.sound.startSound(this.getVarOrDirectByte(PARAM_1));
  }

  protected o_stopMusic(): void {
    this.engine.sound.stopAll();
  }

  protected o_isSoundRunning(): void {
    this.getResultPos();
    this.setResult(this.engine.sound.isSoundRunning(this.getVarOrDirectByte(PARAM_1)) ? 1 : 0);
  }

  protected o_soundKludge(): void {
    this.engine.sound.kludge(this.getStackList(16));
  }

  // --- resources and system -------------------------------------------------

  /**
   * Resource load/lock/unlock hints.
   *
   * Everything is already resident, so most of these are no-ops; the ones that
   * matter are the "load charset" and "load costume" forms, which need to make
   * the resource available before a later opcode uses it.
   */
  protected o_resourceRoutines(): void {
    this.opcode = this.fetchByte();
    const subOp = this.opcode & 0x3f;

    if (subOp === 17) {
      // "Heap-space check" — always report success.
      return;
    }

    const resourceId = this.getVarOrDirectByte(PARAM_1);
    switch (subOp) {
      case 1:
      case 5:
      case 9:
      case 13:
        this.engine.ensureResource('script', resourceId);
        break;
      case 2:
      case 6:
      case 10:
      case 14:
        this.engine.ensureResource('sound', resourceId);
        break;
      case 3:
      case 7:
      case 11:
      case 15:
        this.engine.ensureResource('costume', resourceId);
        break;
      case 4:
      case 8:
      case 12:
      case 16:
        this.engine.ensureResource('room', resourceId);
        break;
      case 18:
        this.engine.setCharsetResource(resourceId);
        break;
      case 19:
        break;
      case 20:
        // "Load object": the object id, then the room it lives in as a word.
        // Reading a byte here left one byte of the room behind to be executed.
        this.getVarOrDirectWord(PARAM_2);
        break;
      default:
        this.reportUnknownSubOpcode('resourceRoutines', subOp);
        break;
    }
  }

  protected o_systemOps(): void {
    const subOp = this.fetchByte();
    switch (subOp) {
      case 1:
        this.engine.restart();
        break;
      case 2:
        this.engine.pauseGame();
        break;
      case 3:
        this.engine.quitGame();
        break;
      default:
        this.reportUnknownSubOpcode('systemOps', subOp);
        break;
    }
  }

  protected o_drawBox(): void {
    const x = this.getVarOrDirectWord(PARAM_1);
    const y = this.getVarOrDirectWord(PARAM_2);
    this.opcode = this.fetchByte();
    const x2 = this.getVarOrDirectWord(PARAM_1);
    const y2 = this.getVarOrDirectWord(PARAM_2);
    const color = this.getVarOrDirectByte(PARAM_3);
    this.engine.drawBox(x, y, x2, y2, color);
  }

  // ------------------------------------------------------- dispatch table ---

  /**
   * Builds the 256 entry opcode table.
   *
   * Most instructions appear at several opcodes because the top three bits are
   * addressing-mode flags, not part of the instruction identity. Listing every
   * entry explicitly (rather than masking at dispatch time) keeps the hot loop
   * to a single array index and makes the gaps — genuinely unused opcodes —
   * visible.
   */
  /**
   * The instructions v2, v3 and v4 share and v5 does not have.
   *
   * A second shared installer rather than three copies, and the boundary is
   * the one ADR 0014 draws: these are not "v4's opcodes", they are the ones
   * every Version before v5 has and v5 either dropped or spent elsewhere. A
   * Version calls this after `installClassicSharedOpcodes` and then binds its
   * own table over both.
   *
   * Two of them would fail silently if a Version inherited v5's binding
   * instead. `0x0f` is `getObjectState` at v5 and `ifState` here, so the wrong
   * table runs a getter where the script expects a jump; and `0x25` is
   * `pickupObject` at v5 and `drawObject` here, because this form of
   * `drawObject` takes three operands and therefore claims all eight
   * combinations of the mode bits.
   */
  protected installPreV5Opcodes(): void {
    const bind = (handler: (this: this) => void, ...codes: number[]): void => {
      for (const code of codes) this.dispatch[code] = handler;
    };

    bind(this.o_drawObjectOld, 0x05, 0x25, 0x45, 0x65, 0x85, 0xa5, 0xc5, 0xe5);
    bind(this.o_pickupObjectOld, 0x50, 0xd0);
    bind(this.o_ifState, 0x0f, 0x4f, 0x8f, 0xcf);
    bind(this.o_ifNotState, 0x2f, 0x6f, 0xaf, 0xef);
    bind(this.o_oldRoomEffect, 0x5c, 0xdc);
    bind(this.o_saveLoadVars, 0xa7);
    bind(this.o_saveLoadGame, 0x22, 0xa2);

    // Three v5 instructions no earlier Version has. Cleared rather than left
    // inherited, so a script that reaches one is reported as running an opcode
    // this Version does not have — which is the truth — instead of running
    // v5's and consuming the wrong number of bytes after it.
    for (const code of [0x3b, 0xbb, 0x4c]) this.dispatch[code] = undefined;
  }

  /**
   * `drawObject`, v4's form: an object and where to put it.
   *
   * v5 replaced the two coordinates with a sub-opcode that chooses between
   * "draw at" and "set state", which is why the two are different
   * instructions rather than the same one with a flag.
   * (`ScummEngine_v5::o5_drawObject`, `GF_SMALL_HEADER` branch.)
   */
  protected o_drawObjectOld(): void {
    const object = this.getVarOrDirectWord(PARAM_1);
    const x = this.getVarOrDirectWord(PARAM_2);
    const y = this.getVarOrDirectWord(PARAM_3);

    // 0xFF in the x position means "where it already is", which is how a
    // script redraws an object without moving it.
    if (x !== 0xff) this.engine.setObjectPosition(object, x, y, true);
    this.engine.clearObjectsSharingBox(object);
    this.engine.putState(object, 1);
  }

  /** `pickupObject`, v4's form: the object alone, taken into the ego's hands. */
  protected o_pickupObjectOld(): void {
    const object = this.getVarOrDirectWord(PARAM_1);
    if (object < 1) return;
    this.engine.pickupObject(object, this.engine.currentRoom);
  }

  /** Branches on an object's state matching a value. */
  protected o_ifState(): void {
    const object = this.getVarOrDirectWord(PARAM_1);
    const state = this.getVarOrDirectByte(PARAM_2);
    this.jumpRelative(this.engine.getState(object) === state);
  }

  protected o_ifNotState(): void {
    const object = this.getVarOrDirectWord(PARAM_1);
    const state = this.getVarOrDirectByte(PARAM_2);
    this.jumpRelative(this.engine.getState(object) !== state);
  }

  /**
   * The room transition v5 moved into `roomOps`.
   *
   * Only sub-opcode 3 carries an operand, and the rest carry none — so the
   * instruction is two bytes or four, decided by a byte in the stream.
   */
  protected o_oldRoomEffect(): void {
    this.opcode = this.fetchByte();
    if ((this.opcode & 0x1f) !== 3) return;
    const effect = this.getVarOrDirectWord(PARAM_1);
    this.engine.setScreenEffect(effect);
  }

  /**
   * Saving and loading variables to a file of the game's own.
   *
   * Indy 3 keeps its IQ points this way and Monkey Island keeps a settings
   * file. There is no file to write to here, so the stream is walked and
   * nothing is stored — but it has to be walked *exactly*, because it is a
   * sub-opcode list terminated by a zero and getting its length wrong leaves
   * the program counter mid-instruction.
   * (`ScummEngine_v4::saveVars` and `loadVars`.)
   */
  protected o_saveLoadVars(): void {
    this.fetchByte();

    for (;;) {
      const op = this.fetchByte();
      if (op === 0 || this.codeOverrun) return;
      this.opcode = op;

      switch (op & 0x1f) {
        case 1:
          // A range of variables, given as two result positions.
          this.getResultPos();
          this.getResultPos();
          break;
        case 2:
          this.getVarOrDirectByte(PARAM_1);
          this.getVarOrDirectByte(PARAM_2);
          break;
        case 3:
          // A filename, plain and NUL-terminated.
          this.fetchFilename();
          break;
        case 4:
        case 0x1f:
          return;
        default:
          break;
      }
    }
  }

  /**
   * The save and load menu, which in v4 is an instruction rather than a script.
   *
   * Answers "not done" rather than opening anything: this project has its own
   * save format (ADR 0002) and a game's own menu would write the original's.
   * The operands are still read, which is the part that matters here.
   */
  protected o_saveLoadGame(): void {
    this.getResultPos();
    this.getVarOrDirectByte(PARAM_1);
    this.setResult(0);
    this.engine.variables[VAR.SOUNDRESULT] = 0;
  }

  /**
   * The instructions v2-v5 share, at the opcode numbers they share.
   *
   * Every Version calls this from its own `installOpcodes` and then binds its
   * own table over the top, which is the same two-step `StackScriptEngine`
   * uses. What is *not* here is anything a later Version renumbered or gave a
   * different meaning: `getAnimCounter` at 0x22 is v5's, because v3 and v4 put
   * `saveLoadGame` there and a shared binding would run the wrong handler
   * silently rather than reporting an opcode it does not have.
   */
  protected installClassicSharedOpcodes(): void {
    const table = this.dispatch;

    const bind = (handler: (this: this) => void, ...codes: number[]): void => {
      for (const code of codes) table[code] = handler;
    };

    // Flow control
    bind(this.o_stopObjectCode, 0x00, 0xa0);
    bind(this.o_breakHere, 0x80);
    bind(this.o_jumpRelative, 0x18);
    bind(this.o_startScript, 0x0a, 0x2a, 0x4a, 0x6a, 0x8a, 0xaa, 0xca, 0xea);
    bind(this.o_stopScript, 0x62, 0xe2);
    bind(this.o_chainScript, 0x42, 0xc2);
    bind(this.o_startObject, 0x37, 0x77, 0xb7, 0xf7);
    bind(this.o_stopObjectScript, 0x6e, 0xee);
    bind(this.o_isScriptRunning, 0x68, 0xe8);
    bind(this.o_freezeScripts, 0x60, 0xe0);
    bind(this.o_delay, 0x2e);
    bind(this.o_delayVariable, 0x2b);
    bind(this.o_wait, 0xae);
    bind(this.o_cutscene, 0x40);
    bind(this.o_endCutscene, 0xc0);
    bind(this.o_beginOverride, 0x58);
    bind(this.o_pseudoRoom, 0xcc);
    bind(this.o_debug, 0x6b, 0xeb);

    // Arithmetic and comparison
    bind(this.o_move, 0x1a, 0x9a);
    bind(this.o_add, 0x5a, 0xda);
    bind(this.o_subtract, 0x3a, 0xba);
    bind(this.o_multiply, 0x1b, 0x9b);
    bind(this.o_divide, 0x5b, 0xdb);
    bind(this.o_increment, 0x46);
    bind(this.o_decrement, 0xc6);
    bind(this.o_and, 0x17, 0x97);
    bind(this.o_or, 0x57, 0xd7);
    bind(this.o_setVarRange, 0x26, 0xa6);
    bind(this.o_expression, 0xac);
    bind(this.o_isEqual, 0x48, 0xc8);
    bind(this.o_isNotEqual, 0x08, 0x88);
    bind(this.o_isGreater, 0x78, 0xf8);
    bind(this.o_isGreaterEqual, 0x04, 0x84);
    bind(this.o_isLess, 0x44, 0xc4);
    bind(this.o_isLessEqual, 0x38, 0xb8);
    bind(this.o_equalZero, 0x28);
    bind(this.o_notEqualZero, 0xa8);
    bind(this.o_getRandomNr, 0x16, 0x96);

    // Actors
    bind(this.o_putActor, 0x01, 0x21, 0x41, 0x61, 0x81, 0xa1, 0xc1, 0xe1);
    bind(this.o_putActorInRoom, 0x2d, 0x6d, 0xad, 0xed);
    bind(this.o_putActorAtObject, 0x0e, 0x4e, 0x8e, 0xce);
    bind(this.o_walkActorTo, 0x1e, 0x3e, 0x5e, 0x7e, 0x9e, 0xbe, 0xde, 0xfe);
    bind(this.o_walkActorToActor, 0x0d, 0x4d, 0x8d, 0xcd);
    bind(this.o_walkActorToObject, 0x36, 0x76, 0xb6, 0xf6);
    bind(this.o_faceActor, 0x09, 0x49, 0x89, 0xc9);
    bind(this.o_animateActor, 0x11, 0x51, 0x91, 0xd1);
    bind(this.o_actorFromPos, 0x15, 0x55, 0x95, 0xd5);
    bind(this.o_actorOps, 0x13, 0x53, 0x93, 0xd3);
    bind(this.o_getActorMoving, 0x56, 0xd6);
    bind(this.o_getActorRoom, 0x03, 0x83);
    bind(this.o_getActorX, 0x43, 0xc3);
    bind(this.o_getActorY, 0x23, 0xa3);
    bind(this.o_getActorFacing, 0x63, 0xe3);
    bind(this.o_getActorCostume, 0x71, 0xf1);
    bind(this.o_getActorElevation, 0x06, 0x86);
    bind(this.o_getActorWidth, 0x6c, 0xec);
    bind(this.o_getActorWalkBox, 0x7b, 0xfb);
    bind(this.o_isActorInBox, 0x1f, 0x5f, 0x9f, 0xdf);
    bind(this.o_getClosestObjActor, 0x66, 0xe6);
    bind(this.o_getDist, 0x34, 0x74, 0xb4, 0xf4);

    // Objects
    // Every combination of the parameter bits maps to the same instruction,
    // and a game emits the ones it emits: Atlantis's hover script uses 0x45,
    // where the second parameter bit is set on an instruction that has no
    // second parameter. Binding only the combinations that "make sense" leaves
    // the rest reported as unknown opcodes, which stops the script dead.
    bind(this.o_drawObject, 0x05, 0x45, 0x85, 0xc5);
    bind(this.o_setState, 0x07, 0x47, 0x87, 0xc7);
    bind(this.o_getObjectState, 0x0f, 0x8f);
    bind(this.o_getObjectOwner, 0x10, 0x90);
    bind(this.o_setOwnerOf, 0x29, 0x69, 0xa9, 0xe9);
    bind(this.o_setClass, 0x5d, 0xdd);
    bind(this.o_ifClassOfIs, 0x1d, 0x9d);
    bind(this.o_findObject, 0x35, 0x75, 0xb5, 0xf5);
    bind(this.o_setObjectName, 0x54, 0xd4);
    bind(this.o_pickupObject, 0x25, 0x65, 0xa5, 0xe5);
    bind(this.o_getInventoryCount, 0x31, 0xb1);
    bind(this.o_findInventory, 0x3d, 0x7d, 0xbd, 0xfd);
    bind(this.o_getVerbEntrypoint, 0x0b, 0x4b, 0x8b, 0xcb);

    // Rooms, camera and boxes
    bind(this.o_loadRoom, 0x72, 0xf2);
    bind(this.o_loadRoomWithEgo, 0x24, 0x64, 0xa4, 0xe4);
    bind(this.o_panCameraTo, 0x12, 0x92);
    bind(this.o_setCameraAt, 0x32, 0xb2);
    bind(this.o_actorFollowCamera, 0x52, 0xd2);
    bind(this.o_lights, 0x70, 0xf0);
    bind(this.o_roomOps, 0x33, 0x73, 0xb3, 0xf3);

    // Text and sentences
    bind(this.o_print, 0x14, 0x94);
    bind(this.o_printEgo, 0xd8);
    bind(this.o_getStringWidth, 0x67, 0xe7);
    bind(this.o_stringOps, 0x27);
    bind(this.o_doSentence, 0x19, 0x39, 0x59, 0x79, 0x99, 0xb9, 0xd9, 0xf9);

    // Verbs and cursor
    bind(this.o_verbOps, 0x7a, 0xfa);
    bind(this.o_saveRestoreVerbs, 0xab);
    bind(this.o_cursorCommand, 0x2c);

    // Sound
    bind(this.o_startSound, 0x1c, 0x9c);
    bind(this.o_stopSound, 0x3c, 0xbc);
    bind(this.o_startMusic, 0x02, 0x82);
    bind(this.o_stopMusic, 0x20);
    bind(this.o_isSoundRunning, 0x7c, 0xfc);
    bind(this.o_soundKludge, 0x4c);

    // Resources and system
    bind(this.o_resourceRoutines, 0x0c, 0x8c);
    bind(this.o_systemOps, 0x98);
    bind(this.o_drawBox, 0x3f, 0x7f, 0xbf, 0xff);
  }
}
