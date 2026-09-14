/**
 * The Logic interpreter: AGI's ~180 opcodes over 256 flags and 256 vars.
 *
 * A sibling of `src/engine/script/v5`, `v6` and `v7`, and a sibling only. It
 * does **not** extend `StackScriptEngine`: that is the stack machine v6 and v7
 * share (ADR 0006) and AGI is not a stack machine — there is no operand stack,
 * no script slots, no cutscene stack and no `ScriptState` to reuse (#129).
 *
 * One engine covers AGI v2 and v3, because they share an instruction encoding
 * outright. That is ADR 0012's rule — one script engine per *encoding* — and
 * ADR 0001's "one per version" turns out to have been the special case where no
 * two Targets agreed.
 */

import { readS16LE, readU16LE } from '../../util/ByteStream.js';
import {
  GOTO,
  IF_START,
  NOT,
  OR,
  SAID_OPCODE,
  actionAt,
  testAt,
  type AgiOpcodeSet,
} from './opcodes.js';
import { F, V, type AgiState } from './AgiState.js';
import { readLogicMessages, type AgiLogicMessages } from '../resource/logicMessages.js';
import { ANY_WORD_GROUP, REST_OF_LINE_GROUP } from '../resource/words.js';
import { formatAgiMessage, type AgiMessageContext } from './messageFormat.js';
import { DIRECTION_STEPS, EGO, type ScreenObject } from '../ScreenObject.js';

/**
 * What the interpreter needs from the Engine around it.
 *
 * An interface rather than the Engine itself, so the interpreter is testable
 * without a canvas, a sound context or a loaded game — which is what lets the
 * opcode semantics be asserted one at a time.
 */
export interface LogicHost {
  readonly state: AgiState;
  readonly opcodes: AgiOpcodeSet;

  /** A Logic's bytecode, or null when the game has not got that number. */
  logicBytes(number: number): Uint8Array | null;
  /** Whether that Logic's messages are obfuscated, which v3 changes. */
  logicMessagesEncrypted(number: number): boolean;

  loadPicture(number: number): void;
  drawPicture(number: number): void;
  overlayPicture(number: number): void;
  discardPicture(number: number): void;
  showPicture(): void;
  showPriorityScreen(): void;
  /** Stamps a View's cel permanently into the picture, as `add.to.pic` does. */
  addToPicture(
    view: number,
    loop: number,
    cel: number,
    x: number,
    y: number,
    priority: number,
    margin: number,
  ): void;

  loadView(number: number): void;
  discardView(number: number): void;
  /** Loops in a View, so `set.loop` and `end.of.loop` can be bounded. */
  viewLoopCount(number: number): number;
  viewCelCount(number: number, loop: number): number;
  /** Applies a View's cel size to an object, which `set.cel` needs. */
  applyCelSize(object: ScreenObject): void;

  loadSound(number: number): void;
  playSound(number: number, endFlag: number): void;
  stopSound(): void;
  discardSound(number: number): void;

  loadLogic(number: number): void;
  discardLogic(number: number): void;

  /** An inventory item's name, for `%0` in a message. */
  itemName(item: number): string;
  /** A word of the player's last line, for `%w` in a message. */
  spokenWord(index: number): string;
  /** A Logic's bytes, so `%m` and `%g` can reach another Logic's messages. */
  logicBytes(logic: number): Uint8Array | null;

  /** Shows a message in a window, which pauses until dismissed. */
  print(text: string): void;
  /** Draws text straight onto the screen at a row and column. */
  display(row: number, column: number, text: string): void;
  clearLines(from: number, to: number, colour: number): void;
  clearTextRect(row1: number, column1: number, row2: number, column2: number, colour: number): void;
  setTextAttribute(foreground: number, background: number): void;
  setCursorCharacter(character: string): void;
  configureScreen(playTop: number, inputLine: number, statusLine: number): void;
  statusLine(visible: boolean): void;
  textScreen(): void;
  graphicsScreen(): void;
  shakeScreen(count: number): void;
  closeWindow(): void;

  /** Asks the player for a number, as `get.num` does. */
  getNumber(prompt: string, into: number): void;
  /** Asks the player for a line, as `get.string` does. */
  getString(slot: number, prompt: string, row: number, column: number, length: number): void;
  /** Re-parses a string slot as a command line, which `parse` does. */
  parseString(slot: number): void;
  /** The word group numbers the player's last line resolved to. */
  saidWords(): readonly number[];
  /** Marks the player's line as consumed, so later `said`s stop matching. */
  acceptSaid(): void;
  wordToString(slot: number, wordIndex: number): void;

  /** Inventory: whether the player is carrying an item. */
  itemRoom(item: number): number;
  setItemRoom(item: number, room: number): void;
  /** The room number that means "in the player's inventory". */
  readonly carriedRoom: number;
  showInventoryItem(item: number): void;
  showInventoryScreen(): void;

  saveGame(): void;
  restoreGame(): void;
  restartGame(): void;
  showMemory(): void;
  pauseGame(): void;
  showVersion(): void;

  setMenu(text: string): void;
  setMenuItem(text: string, controller: number): void;
  submitMenu(): void;
  menuInput(): void;

  /** Random number in `[low, high]`, injectable so tests are deterministic. */
  random(low: number, high: number): number;

  /** Reports an opcode this engine has no implementation for, once by name. */
  reportUnimplemented(name: string, opcode: number): void;
  /** A line for the log. */
  log(message: string): void;
}

/** One entry of the trace ring buffer, for Tier 3 diagnosis. */
export interface TraceEntry {
  logic: number;
  offset: number;
  opcode: number;
  name: string;
  operands: number[];
}

/** How many instructions the ring buffer keeps. */
const TRACE_SIZE = 256;

/**
 * How deep `call` may nest before the interpreter refuses.
 *
 * AGI itself had a fixed stack and games stay well inside it. A game that
 * exceeds this has recursed, which in a single-threaded interpreter means the
 * tab freezes rather than the game misbehaves — so it is refused with a name.
 */
const MAX_CALL_DEPTH = 32;

/** How many instructions one logic may run in one cycle. */
const MAX_INSTRUCTIONS_PER_LOGIC = 500_000;

export class LogicEngine {
  private readonly host: LogicHost;
  private readonly state: AgiState;

  /**
   * The last few instructions executed, oldest overwritten.
   *
   * `docs/processes/verifying-version-support.md` Tier 3 asks every script
   * engine for this and a trace hook, and the reason is sharper for AGI than
   * for SCUMM: when a checkpoint fails the question is "what should this script
   * have done", and answering it means comparing against a reference
   * interpreter instruction by instruction.
   */
  private readonly trace: TraceEntry[] = [];
  private tracePosition = 0;

  /** Called per instruction when set, for a live trace. */
  onInstruction: ((entry: TraceEntry) => void) | null = null;

  private callDepth = 0;

  constructor(host: LogicHost) {
    this.host = host;
    this.state = host.state;
  }

  /** The trace ring buffer, oldest first. */
  recentInstructions(): TraceEntry[] {
    return [...this.trace.slice(this.tracePosition), ...this.trace.slice(0, this.tracePosition)];
  }

  /**
   * Runs one Logic to its `return`, or until something asks every logic to exit.
   *
   * Returns true when the logic ran to completion and false when it was cut
   * short — by `new.room`, by `quit`, or by a refusal. The caller uses that to
   * decide whether to run the cycle's remaining work.
   */
  run(number: number): boolean {
    const bytes = this.host.logicBytes(number);
    if (!bytes) {
      this.host.log(`Logic ${number} was called and this game has not got it.`);
      return false;
    }

    if (this.callDepth >= MAX_CALL_DEPTH) {
      this.host.log(
        `Logic ${number} was called ${MAX_CALL_DEPTH} deep, which means a script ` +
          `is calling itself. Refused rather than freezing the page.`,
      );
      return false;
    }

    this.callDepth++;
    try {
      return this.execute(number, bytes);
    } finally {
      this.callDepth--;
    }
  }

  private execute(logic: number, bytes: Uint8Array): boolean {
    const { state, host } = this;
    // The code section ends where the message section begins, which the first
    // two bytes name. Running past it would execute the message table.
    const end = 2 + readU16LE(bytes, 0);
    let at = 2;
    let instructions = 0;

    while (at < end) {
      if (state.exitAllLogics || state.quitRequested) return false;
      if (++instructions > MAX_INSTRUCTIONS_PER_LOGIC) {
        host.log(
          `Logic ${logic} ran ${MAX_INSTRUCTIONS_PER_LOGIC} instructions in one ` +
            `cycle without returning, so it has been stopped. A goto is looping.`,
        );
        return false;
      }

      const opcode = bytes[at];

      if (opcode === IF_START) {
        const condition = this.evaluateIf(bytes, at, end);
        if (condition === null) {
          host.log(`Logic ${logic} has a malformed if at ${at}; it has been stopped.`);
          return false;
        }
        this.record(logic, at, opcode, 'if', []);
        at = condition.result ? condition.bodyAt : condition.elseAt;
        continue;
      }

      if (opcode === GOTO) {
        if (at + 3 > end) return false;
        const displacement = readS16LE(bytes, at + 1);
        this.record(logic, at, opcode, 'goto', [displacement]);
        at = at + 3 + displacement;
        // A goto out of the code section is a corrupt resource rather than a
        // loop, and following it would execute the message table.
        if (at < 2 || at > end) {
          host.log(`Logic ${logic} jumped to ${at}, which is outside its code.`);
          return false;
        }
        continue;
      }

      const action = actionAt(host.opcodes, opcode);
      if (!action) {
        // Loudly, by byte value. An unknown opcode has an unknown length, so
        // there is no safe next byte and continuing would execute nonsense.
        host.reportUnimplemented(`unknown 0x${opcode.toString(16).padStart(2, '0')}`, opcode);
        return false;
      }

      const count = action.operands.length;
      if (at + 1 + count > end) {
        host.log(
          `Logic ${logic}'s ${action.name} at ${at} wants ${count} operands and ` +
            `the code ends at ${end}.`,
        );
        return false;
      }

      const operands: number[] = [];
      for (let index = 0; index < count; index++) operands.push(bytes[at + 1 + index]);
      this.record(logic, at, opcode, action.name, operands);
      at += 1 + count;

      if (opcode === 0x00) return true; // return
      this.perform(logic, opcode, action.name, operands, bytes);

      if (state.exitAllLogics || state.quitRequested) return false;
    }

    return true;
  }

  private record(
    logic: number,
    offset: number,
    opcode: number,
    name: string,
    operands: number[],
  ): void {
    const entry: TraceEntry = { logic, offset, opcode, name, operands };
    if (this.trace.length < TRACE_SIZE) {
      this.trace.push(entry);
      this.tracePosition = this.trace.length % TRACE_SIZE;
    } else {
      this.trace[this.tracePosition] = entry;
      this.tracePosition = (this.tracePosition + 1) % TRACE_SIZE;
    }
    this.onInstruction?.(entry);
  }

  // ------------------------------------------------------------ conditions --

  /**
   * Evaluates an `if` header and says where to go.
   *
   * `bodyAt` is the first instruction of the block and `elseAt` where control
   * goes when the condition is false — which is the block's end, and which is
   * also where an `else`'s `goto` will have been written.
   */
  private evaluateIf(
    bytes: Uint8Array,
    start: number,
    end: number,
  ): { result: boolean; bodyAt: number; elseAt: number } | null {
    let at = start + 1;
    let result = true;
    let negate = false;
    /** Collected `or` terms, or null outside a group. */
    let orTerms: boolean[] | null = null;

    for (;;) {
      if (at >= end) return null;
      const byte = bytes[at];

      if (byte === IF_START) {
        // The closing 0xFF, then the two-byte forward jump.
        if (at + 3 > end) return null;
        if (orTerms) return null;
        const skip = readU16LE(bytes, at + 1);
        const bodyAt = at + 3;
        return { result, bodyAt, elseAt: bodyAt + skip };
      }

      if (byte === NOT) {
        negate = !negate;
        at++;
        continue;
      }

      if (byte === OR) {
        if (orTerms) {
          // An `or` group's value is true when any term is, and it joins the
          // surrounding `and` chain as one term.
          result = result && orTerms.some((term) => term);
          orTerms = null;
        } else {
          orTerms = [];
        }
        at++;
        continue;
      }

      const term = this.evaluateTerm(bytes, at, end);
      if (!term) return null;
      const value = negate ? !term.value : term.value;
      negate = false;

      if (orTerms) orTerms.push(value);
      else result = result && value;
      at += term.size;
    }
  }

  private evaluateTerm(
    bytes: Uint8Array,
    at: number,
    end: number,
  ): { value: boolean; size: number } | null {
    const { state, host } = this;
    const opcode = bytes[at];

    if (opcode === SAID_OPCODE) {
      // The one instruction whose length is in the stream: a count byte, then
      // that many 16-bit word group numbers.
      if (at + 2 > end) return null;
      const count = bytes[at + 1];
      const size = 2 + count * 2;
      if (at + size > end) return null;

      const wanted: number[] = [];
      for (let index = 0; index < count; index++) wanted.push(readU16LE(bytes, at + 2 + index * 2));
      return { value: this.said(wanted), size };
    }

    const test = testAt(host.opcodes, opcode);
    if (!test) return null;
    const size = 1 + test.operands.length;
    if (at + size > end) return null;

    const a = bytes[at + 1];
    const b = bytes[at + 2];
    const c = bytes[at + 3];
    const d = bytes[at + 4];
    const e = bytes[at + 5];

    let value: boolean;
    switch (opcode) {
      case 0x01: // equaln(var, num)
        value = state.var(a) === b;
        break;
      case 0x02: // equalv(var, var)
        value = state.var(a) === state.var(b);
        break;
      case 0x03: // lessn
        value = state.var(a) < b;
        break;
      case 0x04: // lessv
        value = state.var(a) < state.var(b);
        break;
      case 0x05: // greatern
        value = state.var(a) > b;
        break;
      case 0x06: // greaterv
        value = state.var(a) > state.var(b);
        break;
      case 0x07: // isset(flag)
        value = state.flag(a);
        break;
      case 0x08: // issetv(var) — the flag whose number is in a variable
        value = state.flag(state.var(a));
        break;
      case 0x09: // has(item)
        value = host.itemRoom(a) === host.carriedRoom;
        break;
      case 0x0a: // obj.in.room(item, var)
        value = host.itemRoom(a) === state.var(b);
        break;
      case 0x0b: // posn(obj, x1, y1, x2, y2)
        value = inBox(state.object(a), b, c, d, e);
        break;
      case 0x0c: // controller(num)
        value = state.firedControllers.has(a);
        break;
      case 0x0d: // have.key
        value = state.var(V.KEY) !== 0;
        break;
      case 0x0f: // compare.strings(s1, s2)
        value = normaliseForCompare(state.strings[a]) === normaliseForCompare(state.strings[b]);
        break;
      case 0x10: {
        // obj.in.box — the whole cel inside the box, not just its origin.
        const object = state.object(a);
        value = object.x >= b && object.x + object.width - 1 <= d && object.y >= c && object.y <= e;
        break;
      }
      case 0x11: {
        // center.posn — the cel's middle column inside the box.
        const object = state.object(a);
        const centre = object.x + (object.width >> 1);
        value = centre >= b && centre <= d && object.y >= c && object.y <= e;
        break;
      }
      case 0x12: {
        // right.posn — the cel's right edge inside the box.
        const object = state.object(a);
        const right = object.x + object.width - 1;
        value = right >= b && right <= d && object.y >= c && object.y <= e;
        break;
      }
      case 0x13: // in.motion.using.mouse — no mouse motion here, so never
        value = false;
        break;
      default:
        host.reportUnimplemented(`condition ${test.name}`, opcode);
        value = false;
        break;
    }

    return { value, size };
  }

  /**
   * `said`: does the player's line match this list of word groups?
   *
   * Two special group numbers, and both matter: **1** is "any word" and **9999**
   * is "the rest of the line, whatever it is". A `said` that ignores them fails
   * to match half the phrases a game accepts, which reads as the parser not
   * understanding rather than as an engine fault.
   *
   * Only matches while the player's line is unconsumed: `SAID_ACCEPTED` is set
   * by the first `said` that matches, so a room's later `said`s do not fire on
   * the same input.
   */
  private said(wanted: readonly number[]): boolean {
    const { state, host } = this;
    if (!state.flag(F.ENTERED_COMMAND) || state.flag(F.SAID_ACCEPTED)) return false;

    const spoken = host.saidWords();
    let index = 0;

    for (const group of wanted) {
      // "The rest of the line" matches whatever follows, so the phrase is
      // satisfied here however much more the player typed.
      if (group === REST_OF_LINE_GROUP) {
        host.acceptSaid();
        return true;
      }
      if (index >= spoken.length) return false;
      // The wildcard group, which every game's vocabulary defines.
      if (group !== ANY_WORD_GROUP && group !== spoken[index]) return false;
      index++;
    }

    // Every wanted group matched and the player said nothing more.
    if (index !== spoken.length) return false;
    host.acceptSaid();
    return true;
  }

  // --------------------------------------------------------------- actions --

  private perform(
    logic: number,
    opcode: number,
    name: string,
    operands: number[],
    bytes: Uint8Array,
  ): void {
    const { state, host } = this;
    const [a, b, c, d, e, f, g] = operands;

    switch (opcode) {
      // ------------------------------------------------- arithmetic and flags
      case 0x01:
        state.setVar(a, state.var(a) + 1);
        break;
      case 0x02:
        // Decrement stops at zero rather than wrapping to 255, which is AGI's
        // own behaviour and something games rely on for countdowns.
        if (state.var(a) > 0) state.setVar(a, state.var(a) - 1);
        break;
      case 0x03:
        state.setVar(a, b);
        break;
      case 0x04:
        state.setVar(a, state.var(b));
        break;
      case 0x05:
        state.setVar(a, state.var(a) + b);
        break;
      case 0x06:
        state.setVar(a, state.var(a) + state.var(b));
        break;
      case 0x07:
        state.setVar(a, state.var(a) - b);
        break;
      case 0x08:
        state.setVar(a, state.var(a) - state.var(b));
        break;
      case 0x09:
        // lindirectv: the variable *named by* a gets b's value.
        state.setVar(state.var(a), state.var(b));
        break;
      case 0x0a:
        // rindirect, which AGI's own table calls `lindirect`: a gets the value
        // of the variable named by b.
        state.setVar(a, state.var(state.var(b)));
        break;
      case 0x0b:
        state.setVar(state.var(a), b);
        break;
      case 0x0c:
        state.setFlag(a, true);
        break;
      case 0x0d:
        state.setFlag(a, false);
        break;
      case 0x0e:
        state.setFlag(a, !state.flag(a));
        break;
      case 0x0f:
        state.setFlag(state.var(a), true);
        break;
      case 0x10:
        state.setFlag(state.var(a), false);
        break;
      case 0x11:
        state.setFlag(state.var(a), !state.flag(state.var(a)));
        break;

      // ------------------------------------------------------- rooms and calls
      case 0x12:
        this.requestRoom(a);
        break;
      case 0x13:
        this.requestRoom(state.var(a));
        break;
      case 0x14:
        host.loadLogic(a);
        break;
      case 0x15:
        host.loadLogic(state.var(a));
        break;
      case 0x16:
        this.run(a);
        break;
      case 0x17:
        this.run(state.var(a));
        break;

      // -------------------------------------------------------------- pictures
      case 0x18:
        host.loadPicture(state.var(a));
        break;
      case 0x19:
        host.drawPicture(state.var(a));
        break;
      case 0x1a:
        host.showPicture();
        break;
      case 0x1b:
        host.discardPicture(state.var(a));
        break;
      case 0x1c:
        host.overlayPicture(state.var(a));
        break;
      case 0x1d:
        host.showPriorityScreen();
        break;

      // ----------------------------------------------------------------- views
      case 0x1e:
        host.loadView(a);
        break;
      case 0x1f:
        host.loadView(state.var(a));
        break;
      case 0x20:
        host.discardView(a);
        break;
      case 0x99:
        host.discardView(state.var(a));
        break;

      // --------------------------------------------------------------- objects
      case 0x21: {
        const object = state.object(a);
        object.animated = true;
        object.updating = true;
        object.cycling = false;
        object.motion = 'none';
        break;
      }
      case 0x22:
        for (const object of state.objects) {
          object.animated = false;
          object.drawn = false;
        }
        break;
      case 0x23: {
        const object = state.object(a);
        object.drawn = true;
        object.updating = true;
        host.applyCelSize(object);
        break;
      }
      case 0x24:
        state.object(a).drawn = false;
        break;
      case 0x25:
        state.object(a).x = b;
        state.object(a).y = c;
        break;
      case 0x26:
        state.object(a).x = state.var(b);
        state.object(a).y = state.var(c);
        break;
      case 0x27:
        state.setVar(b, state.object(a).x);
        state.setVar(c, state.object(a).y);
        break;
      case 0x28: {
        // reposition: a *relative* move, and the operands are signed. Read
        // unsigned, a step of -1 becomes +255 and the object leaves the room.
        const object = state.object(a);
        object.x = clampByte(object.x + signedByte(state.var(b)));
        object.y = clampByte(object.y + signedByte(state.var(c)));
        break;
      }
      case 0x93:
        state.object(a).x = b;
        state.object(a).y = c;
        break;
      case 0x94:
        state.object(a).x = state.var(b);
        state.object(a).y = state.var(c);
        break;
      case 0x29:
        this.setObjectView(a, b);
        break;
      case 0x2a:
        this.setObjectView(a, state.var(b));
        break;
      case 0x2b:
        this.setObjectLoop(a, b);
        break;
      case 0x2c:
        this.setObjectLoop(a, state.var(b));
        break;
      case 0x2d:
        state.object(a).fixedLoop = true;
        break;
      case 0x2e:
        state.object(a).fixedLoop = false;
        break;
      case 0x2f:
        this.setObjectCel(a, b);
        break;
      case 0x30:
        this.setObjectCel(a, state.var(b));
        break;
      case 0x31:
        state.setVar(b, Math.max(0, state.object(a).celCount - 1));
        break;
      case 0x32:
        state.setVar(b, state.object(a).cel);
        break;
      case 0x33:
        state.setVar(b, state.object(a).loop);
        break;
      case 0x34:
        state.setVar(b, state.object(a).view);
        break;
      case 0x35:
        state.setVar(b, state.object(a).loopCount);
        break;
      case 0x36:
        state.object(a).priority = b;
        state.object(a).fixedPriority = true;
        break;
      case 0x37:
        state.object(a).priority = state.var(b);
        state.object(a).fixedPriority = true;
        break;
      case 0x38:
        state.object(a).fixedPriority = false;
        break;
      case 0x39:
        state.setVar(b, state.object(a).priority);
        break;
      case 0x3a:
        state.object(a).updating = false;
        break;
      case 0x3b:
        state.object(a).updating = true;
        break;
      case 0x3c:
        // force.update draws the object now rather than at the end of the
        // cycle. Here that is the same thing, because rendering happens once
        // per cycle after the logics — so it is a no-op with a reason rather
        // than an unimplemented opcode.
        break;
      case 0x3d:
        state.object(a).ignoreHorizon = true;
        break;
      case 0x3e:
        state.object(a).ignoreHorizon = false;
        break;
      case 0x3f:
        state.horizon = a;
        break;
      case 0x40:
        state.object(a).restriction = 'water';
        break;
      case 0x41:
        state.object(a).restriction = 'land';
        break;
      case 0x42:
        state.object(a).restriction = 'none';
        break;
      case 0x43:
        state.object(a).ignoreObjects = true;
        break;
      case 0x44:
        state.object(a).ignoreObjects = false;
        break;
      case 0x45: {
        // distance: Manhattan, and 255 when either object is not drawn — which
        // games test for, so returning a real distance there breaks them.
        const first = state.object(a);
        const second = state.object(b);
        const answer =
          first.drawn && second.drawn
            ? Math.min(254, Math.abs(first.x - second.x) + Math.abs(first.y - second.y))
            : 255;
        state.setVar(c, answer);
        break;
      }

      // ------------------------------------------------------------ animation
      case 0x46:
        state.object(a).cycling = false;
        break;
      case 0x47:
        state.object(a).cycling = true;
        break;
      case 0x48: {
        const object = state.object(a);
        object.cycleDirection = 1;
        object.cycleUntilEnd = 'none';
        object.cycling = true;
        break;
      }
      case 0x49: {
        // end.of.loop: cycle forward to the last cel, then set a flag. This is
        // how a script waits for an animation — it returns and tests the flag
        // next cycle rather than blocking.
        const object = state.object(a);
        object.cycling = true;
        object.cycleDirection = 1;
        object.cycleUntilEnd = 'forward';
        object.cycleEndFlag = b;
        state.setFlag(b, false);
        break;
      }
      case 0x4a: {
        const object = state.object(a);
        object.cycleDirection = -1;
        object.cycleUntilEnd = 'none';
        object.cycling = true;
        break;
      }
      case 0x4b: {
        const object = state.object(a);
        object.cycling = true;
        object.cycleDirection = -1;
        object.cycleUntilEnd = 'reverse';
        object.cycleEndFlag = b;
        state.setFlag(b, false);
        break;
      }
      case 0x4c:
        state.object(a).cycleTime = Math.max(1, state.var(b));
        break;

      // --------------------------------------------------------------- motion
      case 0x4d:
        state.object(a).motion = 'none';
        state.object(a).direction = 0;
        if (a === EGO) state.setVar(V.EGO_DIRECTION, 0);
        break;
      case 0x4e:
        state.object(a).motion = 'none';
        break;
      case 0x4f:
        state.object(a).stepSize = Math.max(1, state.var(b));
        break;
      case 0x50:
        state.object(a).stepTime = Math.max(1, state.var(b));
        break;
      case 0x51: {
        const object = state.object(a);
        object.motion = 'move.obj';
        object.moveTo = { x: b, y: c, endFlag: e };
        object.stepSize = Math.max(1, d);
        state.setFlag(e, false);
        break;
      }
      case 0x52: {
        const object = state.object(a);
        object.motion = 'move.obj';
        object.moveTo = { x: state.var(b), y: state.var(c), endFlag: e };
        object.stepSize = Math.max(1, state.var(d));
        state.setFlag(e, false);
        break;
      }
      case 0x53: {
        const object = state.object(a);
        object.motion = 'follow.ego';
        object.stepSize = Math.max(1, b);
        object.followFlag = c;
        state.setFlag(c, false);
        break;
      }
      case 0x54: {
        const object = state.object(a);
        object.motion = 'wander';
        if (a === EGO) state.playerControl = false;
        break;
      }
      case 0x55:
        state.object(a).motion = 'none';
        break;
      case 0x56:
        state.object(a).direction = state.var(b) & 0x0f;
        break;
      case 0x57:
        state.setVar(b, state.object(a).direction);
        break;
      case 0x58:
        state.object(a).ignoreBlocks = true;
        break;
      case 0x59:
        state.object(a).ignoreBlocks = false;
        break;
      case 0x5a:
        state.block = { active: true, x1: a, y1: b, x2: c, y2: d };
        break;
      case 0x5b:
        state.block = { active: false, x1: 0, y1: 0, x2: 0, y2: 0 };
        break;

      // ------------------------------------------------------------ inventory
      case 0x5c:
        host.setItemRoom(a, host.carriedRoom);
        break;
      case 0x5d:
        host.setItemRoom(state.var(a), host.carriedRoom);
        break;
      case 0x5e:
        // drop puts an item nowhere, not in the current room: AGI uses room 0
        // to mean "out of the game", and a game that wants it droppable puts it
        // back with `put` explicitly.
        host.setItemRoom(a, 0);
        break;
      case 0x5f:
        host.setItemRoom(a, b);
        break;
      case 0x60:
        host.setItemRoom(a, state.var(b));
        break;
      case 0x61:
        state.setVar(b, host.itemRoom(state.var(a)));
        break;
      case 0x81:
        host.showInventoryItem(a);
        break;
      case 0xa2:
        host.showInventoryItem(state.var(a));
        break;
      case 0x7c:
        host.showInventoryScreen();
        break;

      // ---------------------------------------------------------------- sound
      case 0x62:
        host.loadSound(a);
        break;
      case 0x63:
        host.playSound(a, b);
        state.setFlag(b, false);
        break;
      case 0x64:
        host.stopSound();
        break;
      case 0xaf:
        host.discardSound(a);
        break;

      // ----------------------------------------------------------------- text
      case 0x65:
        host.print(this.message(bytes, logic, a));
        break;
      case 0x66:
        host.print(this.message(bytes, logic, state.var(a)));
        break;
      case 0x67:
        host.display(a, b, this.message(bytes, logic, c));
        break;
      case 0x68:
        host.display(state.var(a), state.var(b), this.message(bytes, logic, state.var(c)));
        break;
      case 0x69:
        host.clearLines(a, b, c);
        break;
      case 0x6a:
        host.textScreen();
        break;
      case 0x6b:
        host.graphicsScreen();
        break;
      case 0x6c:
        host.setCursorCharacter(this.message(bytes, logic, a).charAt(0) || ' ');
        break;
      case 0x6d:
        host.setTextAttribute(a, b);
        break;
      case 0x6e:
        host.shakeScreen(a);
        break;
      case 0x6f:
        host.configureScreen(a, b, c);
        break;
      case 0x70:
        host.statusLine(true);
        break;
      case 0x71:
        host.statusLine(false);
        break;
      case 0x9a:
        host.clearTextRect(a, b, c, d, e);
        break;
      case 0x9b:
        // set.upper.left positions the text window, which this renderer places
        // by the message's own size instead. A no-op with a reason.
        break;
      case 0xa9:
        host.closeWindow();
        break;
      case 0x97:
        // print.at takes a row, a column and a width after the message, and
        // four operands at or above 2.089 and three below it — which the arity
        // table has already resolved, so this reads whatever it was given.
        host.print(this.message(bytes, logic, a));
        break;
      case 0x98:
        host.print(this.message(bytes, logic, state.var(a)));
        break;

      // -------------------------------------------------------------- strings
      case 0x72:
        state.strings[a] = this.message(bytes, logic, b);
        break;
      case 0x73:
        host.getString(a, this.message(bytes, logic, b), c, d, e);
        break;
      case 0x74:
        host.wordToString(a, b);
        break;
      case 0x75:
        host.parseString(a);
        break;
      case 0x76:
        host.getNumber(this.message(bytes, logic, a), b);
        break;

      // ------------------------------------------------------ input and menus
      case 0x77:
        state.inputEnabled = false;
        break;
      case 0x78:
        state.inputEnabled = true;
        break;
      case 0x79:
        // set.key binds a key to a controller. Two bytes of key code — the low
        // byte is ASCII and the high byte a scan code — then the controller.
        state.keyBindings.set(c, a | (b << 8));
        break;
      case 0x9c:
        host.setMenu(this.message(bytes, logic, a));
        break;
      case 0x9d:
        host.setMenuItem(this.message(bytes, logic, a), b);
        break;
      case 0x9e:
        host.submitMenu();
        break;
      case 0x9f:
        state.disabledControllers.delete(a);
        break;
      case 0xa0:
        state.disabledControllers.add(a);
        break;
      case 0xa1:
        host.menuInput();
        break;
      case 0xb1:
        state.setFlag(F.MENU_ALLOWED, a !== 0);
        break;

      // ---------------------------------------------------------- the picture
      case 0x7a:
        host.addToPicture(a, b, c, d, e, f, g);
        break;
      case 0x7b:
        host.addToPicture(
          state.var(a),
          state.var(b),
          state.var(c),
          state.var(d),
          state.var(e),
          state.var(f),
          state.var(g),
        );
        break;
      case 0xae:
        // set.pri.base moves the horizon the priority bands are cut from, so
        // the band table has to be rebuilt rather than the value merely stored.
        host.log(`set.pri.base ${a}`);
        this.priorityBase = a;
        break;

      // ------------------------------------------------------- game lifecycle
      case 0x7d:
        host.saveGame();
        break;
      case 0x7e:
        host.restoreGame();
        break;
      case 0x7f:
        // init.disk asked the player to insert a floppy. Nothing to do.
        break;
      case 0x80:
        host.restartGame();
        break;
      case 0x82:
        state.setVar(c, host.random(a, b));
        break;
      case 0x83:
        state.playerControl = false;
        break;
      case 0x84:
        state.playerControl = true;
        break;
      case 0x85:
        // obj.status.v shows a debugging dump of one object. Diagnostic only.
        host.log(`obj.status ${state.var(a)}: ${describeObject(state.object(state.var(a)))}`);
        break;
      case 0x86:
        // `quit` takes one operand at every build except exactly 2.089, where
        // it takes none — so `a` may be undefined, and a non-zero value means
        // "quit without asking".
        state.quitRequested = true;
        break;
      case 0x87:
        host.showMemory();
        break;
      case 0x88:
        host.pauseGame();
        break;
      case 0x8d:
        host.showVersion();
        break;
      case 0x8e:
        // script.size sized the interpreter's own script buffer. Nothing here
        // has a fixed buffer to size.
        break;
      case 0x8f:
        state.gameId = this.message(bytes, logic, a);
        host.log(`Game id is "${state.gameId}"`);
        break;
      case 0x90:
        host.log(`log: ${this.message(bytes, logic, a)}`);
        break;
      case 0xaa:
        // set.simple names a save file. Recorded rather than acted on: saves
        // here are ours and are keyed by the game id (ADR 0002).
        break;

      // ------------------------------------------------------------ arithmetic
      case 0xa5:
        state.setVar(a, state.var(a) * b);
        break;
      case 0xa6:
        state.setVar(a, state.var(a) * state.var(b));
        break;
      case 0xa7:
        // Division by zero leaves the variable alone rather than producing
        // Infinity, which would then be written as a byte and become 0.
        if (b !== 0) state.setVar(a, Math.floor(state.var(a) / b));
        break;
      case 0xa8:
        if (state.var(b) !== 0) state.setVar(a, Math.floor(state.var(a) / state.var(b)));
        break;

      // ----------------------------- Sierra's own debugger, which is not here
      //
      // `trace.on` opens the interpreter's trace window and `trace.info` names
      // the Logic and the buffer size it should use. Neither has any effect on
      // the game: they are the hooks Sierra's developers used, left in the
      // shipped bytecode, and a released game calling one wants nothing to
      // happen. So these two are *deliberately* nothing rather than missing —
      // King's Quest III calls `trace.info` in its first cycle, and reporting
      // it left every run of that game claiming an unimplemented opcode with
      // nothing behind the claim.
      case 0x95: // trace.on
      case 0x96: // trace.info
        break;

      // ------------------------------------ things with nothing to do here
      case 0x89: // echo.line
      case 0x8a: // cancel.line
      case 0x8b: // init.joy
      case 0x8c: // toggle.monitor
      case 0x91: // set.scan.start
      case 0x92: // reset.scan.start
      case 0xa3: // open.dialogue
      case 0xa4: // close.dialogue
      case 0xab: // push.script
      case 0xac: // pop.script
      case 0xad: // hold.key
      case 0xb0: // hide.mouse
      case 0xb2: // show.mouse
      case 0xb3: // fence.mouse
      case 0xb4: // get.mse.posn
      case 0xb5: // release.key
      case 0xb6: // adj.ego.move.to.x.y
        // Each of these is either a debugging aid, a joystick or mouse feature
        // no DOS game's puzzles depend on, or an interpreter-internal buffer
        // operation. Reported by name rather than dropped, so a game that turns
        // out to need one says so in the log instead of behaving oddly (#129).
        host.reportUnimplemented(name, opcode);
        break;

      default:
        host.reportUnimplemented(name, opcode);
        break;
    }
  }

  /** The base `set.pri.base` last asked for, which the Engine reads. */
  priorityBase = 0;

  private requestRoom(room: number): void {
    // A room change cannot happen inside a logic: the logic is running out of a
    // resource the change would unload. So it is recorded and every logic on
    // the stack is asked to return.
    this.state.pendingRoom = room;
    this.state.exitAllLogics = true;
  }

  private setObjectView(number: number, view: number): void {
    const object = this.state.object(number);
    object.view = view;
    object.loopCount = this.host.viewLoopCount(view);
    object.loop = Math.min(object.loop, Math.max(0, object.loopCount - 1));
    object.celCount = this.host.viewCelCount(view, object.loop);
    object.cel = Math.min(object.cel, Math.max(0, object.celCount - 1));
    this.host.applyCelSize(object);
    if (number === EGO) this.state.setVar(V.EGO_VIEW, view);
  }

  private setObjectLoop(number: number, loop: number): void {
    const object = this.state.object(number);
    // Clamped rather than trusted: a script setting a loop a View has not got
    // would otherwise index past the loop array every frame after.
    object.loop = object.loopCount > 0 ? Math.min(loop, object.loopCount - 1) : 0;
    object.celCount = this.host.viewCelCount(object.view, object.loop);
    object.cel = Math.min(object.cel, Math.max(0, object.celCount - 1));
    this.host.applyCelSize(object);
  }

  private setObjectCel(number: number, cel: number): void {
    const object = this.state.object(number);
    object.cel = object.celCount > 0 ? Math.min(cel, object.celCount - 1) : 0;
    this.host.applyCelSize(object);
  }

  /**
   * One of this Logic's own messages, by the number `print` uses.
   *
   * Read through the shared `readLogicMessages` rather than decoded here.
   * There used to be a second decryptor on this path, and it restarted the
   * Avis Durgan key at each message instead of at the start of the text region
   * — so the first message in every Logic came out right and the rest came out
   * as noise. It passed every test, because the tests exercised the *other*
   * decryptor; a real fan game found it in one run. One implementation is the
   * fix, and this is the caller that made it two.
   *
   * Cached per Logic: a resource's bytes do not change while the game runs, and
   * `print` is called every time a script talks.
   */
  private message(bytes: Uint8Array, logic: number, number: number): string {
    let table = this.messageCache.get(logic);
    if (!table) {
      table = readLogicMessages(bytes, this.host.logicMessagesEncrypted(logic));
      this.messageCache.set(logic, table);
    }

    const text = table.texts[number];
    if (text === undefined) {
      this.host.log(
        `Logic ${logic} printed message ${number}, which it has not got ` +
          `(it has ${table.texts.length - 1}).`,
      );
      return '';
    }
    // **Formatted here, which is the one place every message passes through.**
    // A message is a template — `%v`, `%s`, `%m`, `%g`, `%0`, `%w` — and the
    // codes resolve against state that changes, so they are expanded at the
    // moment the message is fetched rather than when the Logic was read. That
    // is also what makes King's Quest III's clock tick: its Logic calls
    // `display` every cycle, and each call re-reads the variables.
    return formatAgiMessage(text, logic, this.messageContext());
  }

  /**
   * What a message's codes resolve against.
   *
   * Built per call rather than held, because every accessor reads live state
   * and a cached context would be a cached view of it. Cheap: six closures.
   */
  private messageContext(): AgiMessageContext {
    return {
      variable: (number) => this.state.var(number),
      string: (number) => this.state.strings[number] ?? '',
      objectName: (item) => this.host.itemName(item),
      word: (index) => this.host.spokenWord(index),
      message: (logic, number) => {
        const bytes = this.host.logicBytes(logic);
        if (!bytes) return '';
        let table = this.messageCache.get(logic);
        if (!table) {
          table = readLogicMessages(bytes, this.host.logicMessagesEncrypted(logic));
          this.messageCache.set(logic, table);
        }
        return table.texts[number] ?? '';
      },
    };
  }

  /** Message tables already read, keyed by Logic number. */
  private readonly messageCache = new Map<number, AgiLogicMessages>();
}

function inBox(object: ScreenObject, x1: number, y1: number, x2: number, y2: number): boolean {
  return object.x >= x1 && object.x <= x2 && object.y >= y1 && object.y <= y2;
}

/** A one-byte operand read as signed, which relative moves need. */
function signedByte(value: number): number {
  return value >= 0x80 ? value - 0x100 : value;
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, value));
}

/** Case- and space-insensitive, which is what `compare.strings` is. */
function normaliseForCompare(text: string): string {
  return (text ?? '').replace(/\s+/g, '').toLowerCase();
}

function describeObject(object: ScreenObject): string {
  return (
    `view ${object.view} loop ${object.loop} cel ${object.cel} at ` +
    `(${object.x}, ${object.y}) priority ${object.priority}` +
    `${object.drawn ? '' : ', not drawn'}${object.cycling ? ', cycling' : ''}`
  );
}

export { DIRECTION_STEPS };
