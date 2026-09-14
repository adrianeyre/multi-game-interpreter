import { VAR } from '../engine/constants.js';
import { isVar, operandValue, type Operand, type VarRef } from './values.js';

/** A patchable forward jump target. */
interface PendingJump {
  /** Offset of the 16-bit displacement field to patch. */
  at: number;
}

export class Label {
  /** Resolved byte offset, or -1 until `place()` is called. */
  offset = -1;
  readonly pending: PendingJump[] = [];
}

/**
 * Emits SCUMM v5 bytecode.
 *
 * The addressing-mode bits are derived from the argument types rather than
 * being passed in, so `move(global(5), 10)` and `move(global(5), global(6))`
 * both do the obvious thing and emit different opcodes. Getting those bits
 * wrong is the single easiest way to produce bytecode that runs but reads the
 * wrong operands, and it is silent — hence encoding it in the type system.
 *
 * Jumps are written through `Label`s and back-patched, so scripts can branch
 * forward without the caller counting bytes.
 */
export class Assembler {
  private readonly bytes: number[] = [];

  // --------------------------------------------------------------- output --

  build(): Uint8Array {
    for (const label of this.labels) {
      if (label.pending.length > 0 && label.offset < 0) {
        throw new Error('A label was jumped to but never placed');
      }
    }
    return new Uint8Array(this.bytes);
  }

  get length(): number {
    return this.bytes.length;
  }

  private readonly labels = new Set<Label>();

  /**
   * Appends bytecode verbatim.
   *
   * For script bytes that came out of a published game and were never turned
   * into actions. Emitting them unchanged is what makes an imported script
   * safe to keep: whatever the editor could not read, the game still runs
   * exactly as it did, because these are the same bytes it shipped with.
   *
   * Jumps inside the block are relative and survive being moved; a jump *into*
   * one from outside could not have existed, because nothing else knows where
   * its instructions are.
   */
  raw(bytes: Uint8Array): this {
    for (const byte of bytes) this.bytes.push(byte & 0xff);
    return this;
  }

  // ------------------------------------------------------------ primitives --

  private u8(value: number): void {
    this.bytes.push(value & 0xff);
  }

  private u16(value: number): void {
    this.bytes.push(value & 0xff, (value >> 8) & 0xff);
  }

  /** Emits a NUL-terminated message, encoding newlines as the 0xFF 01 escape. */
  private message(text: string): void {
    for (const character of text) {
      if (character === '\n') {
        this.bytes.push(0xff, 1);
        continue;
      }
      const code = character.charCodeAt(0);
      // The high half of the byte range is escape territory in SCUMM strings.
      this.bytes.push(code > 0xfd ? 0x3f : code);
    }
    this.bytes.push(0);
  }

  /**
   * Computes the opcode for an instruction from its operands.
   *
   * Bit 7 flags operand 1 as a variable, bit 6 operand 2, bit 5 operand 3.
   */
  private opcode(base: number, ...operands: Operand[]): void {
    let opcode = base;
    const masks = [0x80, 0x40, 0x20];
    for (let i = 0; i < operands.length && i < 3; i++) {
      if (isVar(operands[i])) opcode |= masks[i];
    }
    this.u8(opcode);
  }

  /** Writes an operand in the width the instruction expects. */
  private argByte(value: Operand): void {
    if (isVar(value)) this.u16(operandValue(value));
    else this.u8(value);
  }

  private argWord(value: Operand): void {
    this.u16(operandValue(value));
  }

  /** A result destination is always a bare 16-bit variable index. */
  private result(target: VarRef): void {
    this.u16(target.index);
  }

  /** A variable-length operand list, terminated by 0xFF. */
  private list(values: Operand[]): void {
    for (const value of values) {
      this.u8(isVar(value) ? 0x81 : 0x01);
      this.u16(operandValue(value));
    }
    this.u8(0xff);
  }

  // ----------------------------------------------------------------- labels --

  label(): Label {
    const label = new Label();
    this.labels.add(label);
    return label;
  }

  /** Marks where a label points, patching every jump already made to it. */
  place(label: Label): this {
    label.offset = this.bytes.length;
    for (const jump of label.pending) {
      const displacement = label.offset - (jump.at + 2);
      this.bytes[jump.at] = displacement & 0xff;
      this.bytes[jump.at + 1] = (displacement >> 8) & 0xff;
    }
    label.pending.length = 0;
    return this;
  }

  /** Writes a displacement to `label`, deferring it if not yet placed. */
  private displacement(label: Label): void {
    const at = this.bytes.length;
    this.u16(0);
    if (label.offset >= 0) {
      const value = label.offset - (at + 2);
      this.bytes[at] = value & 0xff;
      this.bytes[at + 1] = (value >> 8) & 0xff;
    } else {
      label.pending.push({ at });
    }
  }

  jump(label: Label): this {
    this.u8(0x18);
    this.displacement(label);
    return this;
  }

  // ------------------------------------------------------------ comparisons --
  //
  // SCUMM's conditionals jump when the test FAILS, so `jumpUnless*` is the
  // honest name for what the instruction does.

  private comparison(base: number, left: VarRef, right: Operand, label: Label): this {
    this.opcode(base, right);
    this.u16(left.index);
    this.argWord(right);
    this.displacement(label);
    return this;
  }

  jumpUnlessEqual(left: VarRef, right: Operand, label: Label): this {
    return this.comparison(0x48, left, right, label);
  }

  jumpUnlessNotEqual(left: VarRef, right: Operand, label: Label): this {
    return this.comparison(0x08, left, right, label);
  }

  jumpUnlessLess(left: VarRef, right: Operand, label: Label): this {
    return this.comparison(0x44, left, right, label);
  }

  jumpUnlessLessEqual(left: VarRef, right: Operand, label: Label): this {
    return this.comparison(0x38, left, right, label);
  }

  jumpUnlessGreater(left: VarRef, right: Operand, label: Label): this {
    return this.comparison(0x78, left, right, label);
  }

  jumpUnlessGreaterEqual(left: VarRef, right: Operand, label: Label): this {
    return this.comparison(0x04, left, right, label);
  }

  /**
   * Jumps when `value <= limit`.
   *
   * SCUMM's comparisons read the variable first and the operand second, then
   * test operand-against-variable — so `isLess` with a variable and a literal
   * asks "is the literal less than the variable", which is the reverse of how
   * the call reads. This wraps that, named for what actually happens.
   */
  jumpIfAtMost(value: VarRef, limit: number, label: Label): this {
    return this.comparison(0x44, value, limit, label);
  }

  jumpUnlessZero(value: VarRef, label: Label): this {
    this.u8(0x28);
    this.u16(value.index);
    this.displacement(label);
    return this;
  }

  jumpUnlessNotZero(value: VarRef, label: Label): this {
    this.u8(0xa8);
    this.u16(value.index);
    this.displacement(label);
    return this;
  }

  // ------------------------------------------------------------- arithmetic --

  move(target: VarRef, value: Operand): this {
    this.opcode(0x1a, value);
    this.result(target);
    this.argWord(value);
    return this;
  }

  add(target: VarRef, value: Operand): this {
    this.opcode(0x5a, value);
    this.result(target);
    this.argWord(value);
    return this;
  }

  subtract(target: VarRef, value: Operand): this {
    this.opcode(0x3a, value);
    this.result(target);
    this.argWord(value);
    return this;
  }

  multiply(target: VarRef, value: Operand): this {
    this.opcode(0x1b, value);
    this.result(target);
    this.argWord(value);
    return this;
  }

  divide(target: VarRef, value: Operand): this {
    this.opcode(0x5b, value);
    this.result(target);
    this.argWord(value);
    return this;
  }

  and(target: VarRef, value: Operand): this {
    this.opcode(0x17, value);
    this.result(target);
    this.argWord(value);
    return this;
  }

  or(target: VarRef, value: Operand): this {
    this.opcode(0x57, value);
    this.result(target);
    this.argWord(value);
    return this;
  }

  increment(target: VarRef): this {
    this.u8(0x46);
    this.result(target);
    return this;
  }

  decrement(target: VarRef): this {
    this.u8(0xc6);
    this.result(target);
    return this;
  }

  randomNumber(target: VarRef, max: Operand): this {
    this.opcode(0x16, max);
    this.result(target);
    this.argByte(max);
    return this;
  }

  // ------------------------------------------------------------------ flow --

  stop(): this {
    this.u8(0x00);
    return this;
  }

  breakHere(): this {
    this.u8(0x80);
    return this;
  }

  startScript(script: Operand, args: Operand[] = []): this {
    this.opcode(0x0a, script);
    this.argByte(script);
    this.list(args);
    return this;
  }

  stopScript(script: Operand): this {
    this.opcode(0x62, script);
    this.argByte(script);
    return this;
  }

  startObject(object: Operand, entry: Operand, args: Operand[] = []): this {
    this.opcode(0x37, object, entry);
    this.argWord(object);
    this.argByte(entry);
    this.list(args);
    return this;
  }

  isScriptRunning(target: VarRef, script: Operand): this {
    this.opcode(0x68, script);
    this.result(target);
    this.argByte(script);
    return this;
  }

  /** Sleeps for `frames` engine ticks. The count is stored inverted. */
  delay(frames: number): this {
    const value = 0xffffff - Math.max(0, Math.min(0xffffff, frames));
    this.u8(0x2e);
    this.u8(value & 0xff);
    this.u8((value >> 8) & 0xff);
    this.u8((value >> 16) & 0xff);
    return this;
  }

  /**
   * Blocks until an actor stops walking.
   *
   * `wait` is one of the few instructions whose addressing-mode bit lives on
   * the sub-opcode rather than the opcode, so the outer byte is always 0xAE.
   */
  waitForActor(actor: Operand): this {
    this.u8(0xae);
    this.u8(isVar(actor) ? 0x81 : 0x01);
    this.argByte(actor);
    return this;
  }

  waitForMessage(): this {
    this.u8(0xae);
    this.u8(0x02);
    return this;
  }

  waitForCamera(): this {
    this.u8(0xae);
    this.u8(0x03);
    return this;
  }

  waitForSentence(): this {
    this.u8(0xae);
    this.u8(0x04);
    return this;
  }

  cutscene(args: Operand[] = []): this {
    this.u8(0x40);
    this.list(args);
    return this;
  }

  endCutscene(): this {
    this.u8(0xc0);
    return this;
  }

  freezeScripts(flag: Operand): this {
    this.opcode(0x60, flag);
    this.argByte(flag);
    return this;
  }

  // ---------------------------------------------------------------- actors --

  putActor(actor: Operand, x: Operand, y: Operand): this {
    this.opcode(0x01, actor, x, y);
    this.argByte(actor);
    this.argWord(x);
    this.argWord(y);
    return this;
  }

  putActorInRoom(actor: Operand, room: Operand): this {
    this.opcode(0x2d, actor, room);
    this.argByte(actor);
    this.argByte(room);
    return this;
  }

  walkActorTo(actor: Operand, x: Operand, y: Operand): this {
    this.opcode(0x1e, actor, x, y);
    this.argByte(actor);
    this.argWord(x);
    this.argWord(y);
    return this;
  }

  /** Walks one actor to another, stopping `distance` pixels short. */
  walkActorToActor(actor: Operand, target: Operand, distance = 0xff): this {
    this.opcode(0x0d, actor, target);
    this.argByte(actor);
    this.argByte(target);
    this.u8(distance);
    return this;
  }

  walkActorToObject(actor: Operand, object: Operand): this {
    this.opcode(0x36, actor, object);
    this.argByte(actor);
    this.argWord(object);
    return this;
  }

  faceActorTowards(actor: Operand, target: Operand): this {
    this.opcode(0x09, actor, target);
    this.argByte(actor);
    this.argWord(target);
    return this;
  }

  animateActor(actor: Operand, animation: Operand): this {
    this.opcode(0x11, actor, animation);
    this.argByte(actor);
    this.argByte(animation);
    return this;
  }

  getActorRoom(target: VarRef, actor: Operand): this {
    this.opcode(0x03, actor);
    this.result(target);
    this.argByte(actor);
    return this;
  }

  getActorX(target: VarRef, actor: Operand): this {
    this.opcode(0x43, actor);
    this.result(target);
    this.argWord(actor);
    return this;
  }

  getActorY(target: VarRef, actor: Operand): this {
    this.opcode(0x23, actor);
    this.result(target);
    this.argWord(actor);
    return this;
  }

  getActorMoving(target: VarRef, actor: Operand): this {
    this.opcode(0x56, actor);
    this.result(target);
    this.argByte(actor);
    return this;
  }

  /** Opens an `actorOps` block; call methods on the returned builder. */
  actorOps(actor: Operand): ActorOps {
    this.opcode(0x13, actor);
    this.argByte(actor);
    return new ActorOps(this, {
      u8: (v) => this.u8(v),
      u16: (v) => this.u16(v),
      argByte: (v) => this.argByte(v),
      argWord: (v) => this.argWord(v),
      message: (v) => this.message(v),
    });
  }

  // --------------------------------------------------------------- objects --

  setState(object: Operand, state: Operand): this {
    this.opcode(0x07, object, state);
    this.argWord(object);
    this.argByte(state);
    return this;
  }

  getState(target: VarRef, object: Operand): this {
    this.opcode(0x0f, object);
    this.result(target);
    this.argWord(object);
    return this;
  }

  setOwner(object: Operand, owner: Operand): this {
    this.opcode(0x29, object, owner);
    this.argWord(object);
    this.argByte(owner);
    return this;
  }

  getOwner(target: VarRef, object: Operand): this {
    this.opcode(0x10, object);
    this.result(target);
    this.argWord(object);
    return this;
  }

  /** Draws an object in a given state, stamping it into the background. */
  drawObject(object: Operand, state: Operand): this {
    this.opcode(0x05, object);
    this.argWord(object);
    // Sub-opcode 2 selects "set state"; its own operand carries a mode bit.
    this.u8(isVar(state) ? 0x82 : 0x02);
    this.argWord(state);
    return this;
  }

  pickupObject(object: Operand, room: Operand = 0): this {
    this.opcode(0x25, object, room);
    this.argWord(object);
    this.argByte(room);
    return this;
  }

  setClass(object: Operand, classes: Operand[]): this {
    this.opcode(0x5d, object);
    this.argWord(object);
    this.list(classes);
    return this;
  }

  jumpUnlessClassOfIs(object: Operand, classes: Operand[], label: Label): this {
    this.opcode(0x1d, object);
    this.argWord(object);
    this.list(classes);
    this.displacement(label);
    return this;
  }

  /**
   * The object at a point, as the input script asks it of the cursor.
   *
   * Both coordinates are byte operands, which for a variable reference still
   * means a 16-bit index — so a room wider than the screen is fine as long as
   * the coordinates arrive in variables, which is the only form the games use.
   */
  findObject(target: VarRef, x: Operand, y: Operand): this {
    this.opcode(0x35, x, y);
    this.result(target);
    this.argByte(x);
    this.argByte(y);
    return this;
  }

  getInventoryCount(target: VarRef, owner: Operand): this {
    this.opcode(0x31, owner);
    this.result(target);
    this.argByte(owner);
    return this;
  }

  findInventory(target: VarRef, owner: Operand, index: Operand): this {
    this.opcode(0x3d, owner, index);
    this.result(target);
    this.argByte(owner);
    this.argByte(index);
    return this;
  }

  getVerbEntrypoint(target: VarRef, object: Operand, entry: Operand): this {
    this.opcode(0x0b, object, entry);
    this.result(target);
    this.argWord(object);
    this.argWord(entry);
    return this;
  }

  // ----------------------------------------------------------------- rooms --

  loadRoom(room: Operand): this {
    this.opcode(0x72, room);
    this.argByte(room);
    return this;
  }

  loadRoomWithEgo(object: Operand, room: Operand, x: number, y: number): this {
    this.opcode(0x24, object, room);
    this.argWord(object);
    this.argByte(room);
    this.u16(x);
    this.u16(y);
    return this;
  }

  setCameraAt(x: Operand): this {
    this.opcode(0x32, x);
    this.argWord(x);
    return this;
  }

  panCameraTo(x: Operand): this {
    this.opcode(0x12, x);
    this.argWord(x);
    return this;
  }

  actorFollowCamera(actor: Operand): this {
    this.opcode(0x52, actor);
    this.argByte(actor);
    return this;
  }

  /** `roomOps` sub-opcode 3: sets the text/room/verb screen split. */
  setScreen(top: number, bottom: number): this {
    this.u8(0x33);
    this.u8(0x03);
    this.u16(top);
    this.u16(bottom);
    return this;
  }

  /** `roomOps` sub-opcode 1: clamps the camera to a horizontal range. */
  setCameraBounds(min: number, max: number): this {
    this.u8(0x33);
    this.u8(0x01);
    this.u16(min);
    this.u16(max);
    return this;
  }

  // ------------------------------------------------------------------ text --

  /** Speech from an actor, centred over them. */
  say(actor: Operand, text: string): this {
    this.opcode(0x14, actor);
    this.argByte(actor);
    this.u8(0x0f); // sub-opcode "text", which must come last
    this.message(text);
    return this;
  }

  /** Speech from the player character. */
  sayEgo(text: string): this {
    this.u8(0xd8);
    this.u8(0x0f);
    this.message(text);
    return this;
  }

  /** A caption at a fixed screen position, with no speaker. */
  printAt(x: number, y: number, color: number, text: string): this {
    this.u8(0x14);
    this.u8(255); // actor 255 means "narrator"
    this.u8(0x00);
    this.u16(x);
    this.u8(0x01);
    this.u16(y);
    this.u8(0x02);
    this.u16(color);
    this.u8(0x0f);
    this.message(text);
    return this;
  }

  // ----------------------------------------------------------------- verbs --

  verbOps(verb: Operand): VerbOps {
    this.opcode(0x7a, verb);
    this.argByte(verb);
    return new VerbOps({
      u8: (v) => this.u8(v),
      u16: (v) => this.u16(v),
      argByte: (v) => this.argByte(v),
      argWord: (v) => this.argWord(v),
      message: (v) => this.message(v),
    });
  }

  cursorOn(): this {
    this.u8(0x2c);
    this.u8(0x01);
    return this;
  }

  cursorOff(): this {
    this.u8(0x2c);
    this.u8(0x02);
    return this;
  }

  userputOn(): this {
    this.u8(0x2c);
    this.u8(0x03);
    return this;
  }

  userputOff(): this {
    this.u8(0x2c);
    this.u8(0x04);
    return this;
  }

  /** `resourceRoutines` sub-opcode 18: makes a charset current. */
  loadCharset(id: number): this {
    this.u8(0x0c);
    this.u8(18);
    this.u8(id);
    return this;
  }

  // ------------------------------------------------------------- sentences --

  doSentence(verb: Operand, objectA: Operand, objectB: Operand = 0): this {
    this.opcode(0x19, verb, objectA, objectB);
    this.argByte(verb);
    this.argWord(objectA);
    this.argWord(objectB);
    return this;
  }

  /** Verb 0xFE cancels the pending sentence. */
  stopSentence(): this {
    this.u8(0x19);
    this.u8(0xfe);
    return this;
  }

  // ----------------------------------------------------------------- sound --

  startSound(sound: Operand): this {
    this.opcode(0x1c, sound);
    this.argByte(sound);
    return this;
  }

  stopSound(sound: Operand): this {
    this.opcode(0x3c, sound);
    this.argByte(sound);
    return this;
  }

  // ----------------------------------------------------------- convenience --

  /** Runs `body` only when `left == right`. */
  ifEqual(left: VarRef, right: Operand, body: (a: Assembler) => void): this {
    const end = this.label();
    this.jumpUnlessEqual(left, right, end);
    body(this);
    this.place(end);
    return this;
  }

  /** Runs `body` only when `left != right`. */
  ifNotEqual(left: VarRef, right: Operand, body: (a: Assembler) => void): this {
    const end = this.label();
    this.jumpUnlessNotEqual(left, right, end);
    body(this);
    this.place(end);
    return this;
  }

  /** Two-armed conditional. */
  ifElse(
    condition: (a: Assembler, target: Label) => void,
    thenBody: (a: Assembler) => void,
    elseBody: (a: Assembler) => void,
  ): this {
    const otherwise = this.label();
    const end = this.label();
    condition(this, otherwise);
    thenBody(this);
    this.jump(end);
    this.place(otherwise);
    elseBody(this);
    this.place(end);
    return this;
  }
}

/** Low-level emit hooks handed to the sub-opcode builders. */
interface Emitter {
  u8(value: number): void;
  u16(value: number): void;
  argByte(value: Operand): void;
  argWord(value: Operand): void;
  message(text: string): void;
}

/**
 * The `actorOps` sub-opcode stream.
 *
 * Terminated by `end()`, which writes the 0xFF that closes the block. Forgetting
 * it corrupts everything after, so the builder is deliberately awkward to leave
 * open: the parent assembler is only returned by `end()`.
 */
export class ActorOps {
  private readonly parent: Assembler;
  private readonly emit: Emitter;

  constructor(parent: Assembler, emit: Emitter) {
    this.parent = parent;
    this.emit = emit;
  }

  private sub(base: number, ...operands: Operand[]): void {
    let opcode = base;
    const masks = [0x80, 0x40, 0x20];
    for (let i = 0; i < operands.length && i < 3; i++) {
      if (isVar(operands[i])) opcode |= masks[i];
    }
    this.emit.u8(opcode);
  }

  costume(id: Operand): this {
    this.sub(0x01, id);
    this.emit.argByte(id);
    return this;
  }

  walkSpeed(x: Operand, y: Operand): this {
    this.sub(0x02, x, y);
    this.emit.argByte(x);
    this.emit.argByte(y);
    return this;
  }

  walkFrame(frame: Operand): this {
    this.sub(0x04, frame);
    this.emit.argByte(frame);
    return this;
  }

  standFrame(frame: Operand): this {
    this.sub(0x06, frame);
    this.emit.argByte(frame);
    return this;
  }

  talkFrames(start: Operand, stop: Operand): this {
    // Sub-opcode 5, "talk animation". Sub-opcode 14 is "init animation" and
    // takes one byte, so emitting the pair there left an operand behind for the
    // interpreter to execute.
    this.sub(0x05, start, stop);
    this.emit.argByte(start);
    this.emit.argByte(stop);
    return this;
  }

  init(): this {
    this.sub(0x08);
    return this;
  }

  elevation(value: Operand): this {
    this.sub(0x09, value);
    this.emit.argWord(value);
    return this;
  }

  /** Overrides one costume colour, for recolouring a shared costume. */
  paletteEntry(index: Operand, color: Operand): this {
    this.sub(0x0b, color, index);
    this.emit.argByte(color);
    this.emit.argByte(index);
    return this;
  }

  talkColor(color: Operand): this {
    this.sub(0x0c, color);
    this.emit.argByte(color);
    return this;
  }

  name(text: string): this {
    this.sub(0x0d);
    this.emit.message(text);
    return this;
  }

  // 20 and 21, not 15 and 16. The interpreter reads walk-box handling from the
  // pair either side of 20, and has no sub-opcode 15 at all — so `ignoreBoxes`
  // was silently discarded, while `followBoxes` landed on 16, which is actor
  // width and takes a byte: it swallowed the next instruction's first byte and
  // the script carried on from the middle of it.
  ignoreBoxes(): this {
    this.sub(20);
    return this;
  }

  followBoxes(): this {
    this.sub(21);
    return this;
  }

  scale(value: Operand): this {
    this.sub(0x11, value);
    this.emit.argByte(value);
    return this;
  }

  end(): Assembler {
    this.emit.u8(0xff);
    return this.parent;
  }
}

/** The `verbOps` sub-opcode stream. Terminated by `end()`. */
export class VerbOps {
  private readonly emit: Emitter;

  constructor(emit: Emitter) {
    this.emit = emit;
  }

  private sub(base: number, ...operands: Operand[]): void {
    let opcode = base;
    const masks = [0x80, 0x40, 0x20];
    for (let i = 0; i < operands.length && i < 3; i++) {
      if (isVar(operands[i])) opcode |= masks[i];
    }
    this.emit.u8(opcode);
  }

  /** Creates the verb slot. Must come before anything else touches it. */
  create(): this {
    this.sub(0x09);
    return this;
  }

  text(value: string): this {
    this.sub(0x02);
    this.emit.message(value);
    return this;
  }

  at(x: Operand, y: Operand): this {
    this.sub(0x05, x, y);
    this.emit.argWord(x);
    this.emit.argWord(y);
    return this;
  }

  color(value: Operand): this {
    this.sub(0x03, value);
    this.emit.argByte(value);
    return this;
  }

  hiColor(value: Operand): this {
    this.sub(0x04, value);
    this.emit.argByte(value);
    return this;
  }

  dimColor(value: Operand): this {
    this.sub(0x10, value);
    this.emit.argByte(value);
    return this;
  }

  key(code: Operand): this {
    this.sub(0x12, code);
    this.emit.argByte(code);
    return this;
  }

  on(): this {
    this.sub(0x06);
    return this;
  }

  off(): this {
    this.sub(0x07);
    return this;
  }

  remove(): this {
    this.sub(0x08);
    return this;
  }

  center(): this {
    this.sub(0x13);
    return this;
  }

  end(): void {
    this.emit.u8(0xff);
  }
}

export { VAR };
