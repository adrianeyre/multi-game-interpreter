import type { ScummEngine } from '../../ScummEngine.js';
import { ClassicScriptEngine, PARAM_1, PARAM_2, PARAM_3 } from '../ClassicScriptEngine.js';
import type { ScriptState } from '../ScriptState.js';

/**
 * v2 stores a coordinate in eighths of a pixel, as its object headers do.
 *
 * Every coordinate an instruction takes is a byte, so a room's 320 pixels would
 * not fit in one otherwise. Reading them unscaled puts every actor in the
 * leftmost fortieth of the room, which reads as a walk-box fault rather than an
 * arithmetic one.
 */
const V2_X_SCALE = 8;

/**
 * The bits v2 keeps an object's state in.
 *
 * v5 passes a state as an operand; v2 spends eight opcode pairs on setting
 * these and eight more on branching on them, which is most of what makes its
 * table a renumbering rather than an extension.
 * (`kObjectState*` in ScummVM's `object.h`.)
 */
const V2_STATE = {
  Pickupable: 1,
  Untouchable: 2,
  Locked: 4,
  Intrinsic: 8,
} as const;

/**
 * The SCUMM v2 bytecode interpreter — Maniac Mansion and Zak McKracken, in
 * their enhanced DOS releases.
 *
 * The largest Classic delta, and last on this side deliberately: it is the only
 * step where the encoding is substantially new rather than renumbered.
 *
 * **A variable reference is one byte.** `ScummEngine_v2::getVar` reads a byte
 * where every later Version reads a word, `getResultPos` does the same, and
 * there is no indexed form at all. That reaches every comparison, every
 * getter's destination and every operand whose mode bit is set — most of a
 * script — so it is a seam on the base (`fetchVarRef`) rather than a
 * per-handler difference. It is also the one thing a Version-agnostic reader
 * gets wrong on the very first instruction that touches a variable.
 *
 * **Sixteen instructions where later Versions have two.** v5 has `setState` and
 * `getObjectState` and passes the state as an operand; v2 has
 * `setStateIntrinsicOn`, `setStateLocked`, `setStateUntouchable`,
 * `setStatePickupable`, their four opposites, and eight matching `ifState`
 * forms — each a distinct opcode with the state baked in. That is why the table
 * is renumbered rather than extended: v2 spent the numbers.
 *
 * **Bit variables are instructions, not an address space.** v5 folds them into
 * `readVar` behind the 0x8000 mask; v2 has `getBitVar` and `setBitVar`, and
 * they name their bit with a *word* where everything else in the Version names
 * a variable with a byte.
 *
 * A delta on the Classic base rather than a subclass of v3, which #203 left
 * open to be decided with the table in hand. With the table in hand the answer
 * is clear: v2 shares v3's *encoding* and almost none of its numbering, so a
 * subclass would inherit a table it then had to overwrite in nearly every
 * entry — and would carry every later v3 correction into v2 unasked, which is
 * the shape ADR 0006 refused for v7-over-v6.
 */
export class ScriptEngine extends ClassicScriptEngine {
  constructor(engine: ScummEngine, state: ScriptState) {
    super(engine, state);
    this.installOpcodes();
  }

  protected override get classicVersion(): number {
    return 2;
  }

  /** One byte, and no indexed form. The whole of v2's addressing. */
  protected override fetchVarRef(): number {
    return this.fetchByte();
  }

  /**
   * v2's opcode table, written out rather than layered over a later one.
   *
   * Nothing is inherited: neither shared installer is called, because a v2
   * script reaching an instruction v2 does not have should be reported as such
   * rather than run as v5's. The numbers that coincide with a later Version's
   * do so by accident of history and are bound here on their own account.
   */
  protected installOpcodes(): void {
    const bind = (handler: (this: this) => void, ...codes: number[]): void => {
      for (const code of codes) this.dispatch[code] = handler;
    };

    // Flow control
    bind(this.o_stopObjectCode, 0x00, 0xa0);
    bind(this.o_breakHere, 0x80);
    bind(this.o_jumpRelative, 0x18);
    bind(this.o_startScriptV2, 0x42, 0xc2);
    bind(this.o_stopScript, 0x62, 0xe2);
    bind(this.o_chainScriptV2, 0x4a, 0xca);
    bind(this.o_isScriptRunning, 0x68, 0xe8);
    bind(this.o_delay, 0x2e);
    bind(this.o_delayVariable, 0x2b);
    bind(this.o_waitForActorV2, 0x3b, 0xbb);
    bind(this.o_waitForMessageV2, 0xae);
    bind(this.o_waitForSentenceV2, 0x4c);
    bind(this.o_cutsceneV2, 0x40);
    bind(this.o_endCutscene, 0xc0);
    bind(this.o_beginOverrideV2, 0x58);
    bind(this.o_pseudoRoom, 0xcc);
    bind(this.o_restart, 0x98);
    bind(this.o_dummy, 0x5c, 0x6b, 0x6e, 0xdc, 0xeb, 0xee);

    // Arithmetic and comparison
    bind(this.o_move, 0x1a, 0x9a);
    bind(this.o_assignVarByte, 0x2c);
    bind(this.o_assignVarWordIndirect, 0x0a, 0x8a);
    bind(this.o_add, 0x5a, 0xda);
    bind(this.o_subtract, 0x3a, 0xba);
    bind(this.o_addIndirect, 0x2a, 0xaa);
    bind(this.o_subIndirect, 0x6a, 0xea);
    bind(this.o_increment, 0x46);
    bind(this.o_decrement, 0xc6);
    bind(this.o_setVarRange, 0x26, 0xa6);
    bind(this.o_isEqual, 0x48, 0xc8);
    bind(this.o_isNotEqual, 0x08, 0x88);
    bind(this.o_isGreater, 0x78, 0xf8);
    bind(this.o_isGreaterEqual, 0x04, 0x84);
    bind(this.o_isLess, 0x44, 0xc4);
    bind(this.o_isLessEqual, 0x38, 0xb8);
    bind(this.o_equalZero, 0x28);
    bind(this.o_notEqualZero, 0xa8);
    bind(this.o_getRandomNr, 0x16, 0x96);
    bind(this.o_getBitVar, 0x31, 0xb1);
    bind(this.o_setBitVar, 0x1b, 0x5b, 0x9b, 0xdb);

    // Actors
    bind(this.o_putActorV2, 0x01, 0x21, 0x41, 0x61, 0x81, 0xa1, 0xc1, 0xe1);
    bind(this.o_putActorInRoom, 0x2d, 0x6d, 0xad, 0xed);
    bind(this.o_putActorAtObject, 0x0e, 0x4e, 0x8e, 0xce);
    bind(this.o_walkActorToV2, 0x1e, 0x3e, 0x5e, 0x7e, 0x9e, 0xbe, 0xde, 0xfe);
    bind(this.o_walkActorToActor, 0x0d, 0x4d, 0x8d, 0xcd);
    bind(this.o_walkActorToObject, 0x36, 0x76, 0xb6, 0xf6);
    bind(this.o_faceActor, 0x09, 0x49, 0x89, 0xc9);
    bind(this.o_animateActor, 0x11, 0x51, 0x91, 0xd1);
    bind(this.o_actorFromPosV2, 0x15, 0x55, 0x95, 0xd5);
    bind(this.o_actorOpsV2, 0x13, 0x53, 0x93, 0xd3);
    bind(this.o_getActorMoving, 0x56, 0xd6);
    bind(this.o_getActorRoom, 0x03, 0x83);
    bind(this.o_getActorXV2, 0x43, 0xc3);
    bind(this.o_getActorYV2, 0x23, 0xa3);
    bind(this.o_getActorFacing, 0x63, 0xe3);
    bind(this.o_getActorCostume, 0x71, 0xf1);
    bind(this.o_getActorElevation, 0x06, 0x86);
    bind(this.o_setActorElevation, 0x3d, 0x7d, 0xbd, 0xfd);
    bind(this.o_getActorWalkBox, 0x7b, 0xfb);
    bind(this.o_getClosestObjActor, 0x66, 0xe6);
    bind(this.o_getDist, 0x34, 0x74, 0xb4, 0xf4);
    bind(this.o_actorFollowCamera, 0x52, 0xd2);

    // Objects. The state instructions are eight pairs rather than one
    // instruction with an operand, which is where v2 spends the numbers a
    // later Version uses for something else.
    bind(this.o_drawObjectV2, 0x05, 0x25, 0x45, 0x65, 0x85, 0xa5, 0xc5, 0xe5);
    bind(this.o_setStateIntrinsicOn, 0x07, 0x87);
    bind(this.o_setStateIntrinsicOff, 0x47, 0xc7);
    bind(this.o_setStateLocked, 0x27, 0xa7);
    bind(this.o_setStateUnlocked, 0x67, 0xe7);
    bind(this.o_setStateTouchable, 0x17, 0x97);
    bind(this.o_setStateUntouchable, 0x57, 0xd7);
    bind(this.o_setStatePickupable, 0x37, 0xb7);
    bind(this.o_setStateUnpickupable, 0x77, 0xf7);
    bind(this.o_ifStateIntrinsicOn, 0x0f, 0x8f);
    bind(this.o_ifStateIntrinsicOff, 0x4f, 0xcf);
    bind(this.o_ifStateLocked, 0x2f, 0xaf);
    bind(this.o_ifStateUnlocked, 0x6f, 0xef);
    bind(this.o_ifStateTouchable, 0x1f, 0x9f);
    bind(this.o_ifStateUntouchable, 0x5f, 0xdf);
    bind(this.o_ifStatePickupable, 0x3f, 0xbf);
    bind(this.o_ifStateUnpickupable, 0x7f, 0xff);
    bind(this.o_getObjectOwner, 0x10, 0x90);
    bind(this.o_setOwnerOf, 0x29, 0x69, 0xa9, 0xe9);
    bind(this.o_ifClassOfIsV2, 0x1d, 0x5d, 0x9d, 0xdd);
    bind(this.o_findObjectV2, 0x35, 0x75, 0xb5, 0xf5);
    bind(this.o_setObjectName, 0x54, 0xd4);
    bind(this.o_pickupObjectV2, 0x50, 0xd0);
    bind(this.o_setObjPreposition, 0x0b, 0x4b, 0x8b, 0xcb);
    bind(this.o_getObjPreposition, 0x6c, 0xec);

    // Rooms, camera and boxes
    bind(this.o_loadRoom, 0x72, 0xf2);
    bind(this.o_loadRoomWithEgoV2, 0x24, 0x64, 0xa4, 0xe4);
    bind(this.o_panCameraToV2, 0x12, 0x92);
    bind(this.o_setCameraAtV2, 0x32, 0xb2);
    bind(this.o_setBoxFlagsV2, 0x30, 0xb0);
    bind(this.o_roomOpsV2, 0x33, 0x73, 0xb3, 0xf3);
    bind(this.o_lights, 0x70, 0xf0);

    // Text, verbs and sentences
    bind(this.o_print, 0x14, 0x94);
    bind(this.o_printEgo, 0xd8);
    bind(this.o_doSentenceV2, 0x19, 0x39, 0x59, 0x79, 0x99, 0xb9, 0xd9, 0xf9);
    bind(this.o_drawSentence, 0xac);
    bind(this.o_verbOpsV2, 0x7a, 0xfa);
    bind(this.o_cursorCommandV2, 0x60, 0xe0);
    bind(this.o_switchCostumeSet, 0xab);

    // Sound, resources and saving
    bind(this.o_startSound, 0x1c, 0x9c);
    bind(this.o_stopSound, 0x3c, 0xbc);
    bind(this.o_startMusic, 0x02, 0x82);
    bind(this.o_stopMusic, 0x20);
    bind(this.o_isSoundRunning, 0x7c, 0xfc);
    bind(this.o_resourceRoutinesV2, 0x0c, 0x8c);
    bind(this.o_saveLoadGameV2, 0x22, 0xa2);
  }

  // ------------------------------------------------------ v2's own forms --

  /** `startScript`: a script number and no argument list. v2 has none. */
  protected o_startScriptV2(): void {
    this.runScript(this.getVarOrDirectByte(PARAM_1), false, false, []);
  }

  protected o_chainScriptV2(): void {
    const script = this.getVarOrDirectByte(PARAM_1);
    this.stopObjectCode();
    this.runScript(script, false, false, []);
  }

  /** `cutscene`: no argument list, where v3 and later take one. */
  protected o_cutsceneV2(): void {
    this.engine.beginCutscene([]);
  }

  /**
   * `beginOverride`: a flag and then a *two byte* jump, not three bytes.
   *
   * v3 and later step over a whole jump instruction — an opcode and a
   * displacement. v2 stores only the displacement.
   */
  protected o_beginOverrideV2(): void {
    const enable = this.fetchByte() !== 0;
    if (!enable) {
      this.engine.endOverride();
      return;
    }
    this.engine.beginOverride(this.state.currentSlot, this.pc);
    this.pc += 2;
  }

  protected o_restart(): void {
    this.engine.restart();
  }

  /** `assignVarByte`: a destination and a literal byte, never a variable. */
  protected o_assignVarByte(): void {
    this.getResultPos();
    this.setResult(this.fetchByte());
  }

  /**
   * A destination named by a variable rather than given directly.
   *
   * `ScummEngine_v2::getResultPosIndirect` reads a byte and uses the *contents*
   * of that variable as the destination. The byte count matches the direct
   * form, which is why this is a behaviour difference rather than a boundary
   * one — and why a reader can measure both identically.
   */
  protected getResultPosIndirect(): void {
    this.resultVar = this.readVar(this.fetchByte());
  }

  protected o_assignVarWordIndirect(): void {
    this.getResultPosIndirect();
    this.setResult(this.getVarOrDirectWord(PARAM_1));
  }

  protected o_addIndirect(): void {
    this.getResultPosIndirect();
    this.setResult(this.readVar(this.resultVar) + this.getVarOrDirectWord(PARAM_1));
  }

  protected o_subIndirect(): void {
    this.getResultPosIndirect();
    this.setResult(this.readVar(this.resultVar) - this.getVarOrDirectWord(PARAM_1));
  }

  /** Bit variables, which v2 addresses with a *word* and an instruction. */
  protected o_getBitVar(): void {
    this.getResultPos();
    const bit = this.fetchWord() + this.getVarOrDirectByte(PARAM_1);
    this.setResult((this.engine.bitVariables[bit >> 3] >> (bit & 7)) & 1);
  }

  protected o_setBitVar(): void {
    const bit = this.fetchWord() + this.getVarOrDirectByte(PARAM_1);
    const value = this.getVarOrDirectByte(PARAM_2);
    const byte = bit >> 3;
    const mask = 1 << (bit & 7);
    if (value) this.engine.bitVariables[byte] |= mask;
    else this.engine.bitVariables[byte] &= ~mask;
  }

  /** Actors, whose coordinates are bytes at v2 and words later. */
  protected o_putActorV2(): void {
    const actor = this.getVarOrDirectByte(PARAM_1);
    const x = this.getVarOrDirectByte(PARAM_2);
    const y = this.getVarOrDirectByte(PARAM_3);
    this.engine.putActor(actor, x * V2_X_SCALE, y);
  }

  protected o_walkActorToV2(): void {
    const actor = this.getVarOrDirectByte(PARAM_1);
    const x = this.getVarOrDirectByte(PARAM_2);
    const y = this.getVarOrDirectByte(PARAM_3);
    this.engine.startWalkActor(actor, x * V2_X_SCALE, y, -1);
  }

  protected o_actorFromPosV2(): void {
    this.getResultPos();
    const x = this.getVarOrDirectByte(PARAM_1) * V2_X_SCALE;
    const y = this.getVarOrDirectByte(PARAM_2);
    this.setResult(this.engine.actorFromPos(x, y));
  }

  protected o_findObjectV2(): void {
    this.getResultPos();
    const x = this.getVarOrDirectByte(PARAM_1) * V2_X_SCALE;
    const y = this.getVarOrDirectByte(PARAM_2);
    this.setResult(this.engine.findObjectAt(x, y));
  }

  protected o_getActorXV2(): void {
    this.getResultPos();
    this.setResult(this.engine.getObjectOrActorX(this.getVarOrDirectByte(PARAM_1)));
  }

  protected o_getActorYV2(): void {
    this.getResultPos();
    this.setResult(this.engine.getObjectOrActorY(this.getVarOrDirectByte(PARAM_1)));
  }

  protected o_setActorElevation(): void {
    const actor = this.engine.getActor(this.getVarOrDirectByte(PARAM_1));
    const elevation = this.getVarOrDirectByte(PARAM_2);
    if (actor) {
      actor.elevation = elevation;
      actor.needRedraw = true;
    }
  }

  protected o_panCameraToV2(): void {
    this.engine.panCameraTo(this.getVarOrDirectByte(PARAM_1) * V2_X_SCALE);
  }

  protected o_setCameraAtV2(): void {
    this.engine.setCameraAt(this.getVarOrDirectByte(PARAM_1) * V2_X_SCALE);
  }

  /**
   * `actorOps`: an actor, a value, and two fixed bytes.
   *
   * Not a stream terminated by 0xFF, which is what makes it a different
   * instruction from v3's rather than a narrowing: it is exactly five bytes
   * long whatever it does. (`ScummEngine_v2::o2_actorOps`.)
   */
  protected o_actorOpsV2(): void {
    this.getVarOrDirectByte(PARAM_1);
    this.getVarOrDirectByte(PARAM_2);
    this.fetchByte();
    const property = this.fetchByte();
    this.reportUnknownSubOpcode('actorOps', property);
  }

  /** `drawObject`: an object and where to put it, both bytes. */
  protected o_drawObjectV2(): void {
    const object = this.getVarOrDirectWord(PARAM_1);
    const x = this.getVarOrDirectByte(PARAM_2);
    const y = this.getVarOrDirectByte(PARAM_3);
    if (x !== 0xff) this.engine.setObjectPosition(object, x * V2_X_SCALE, y, true);
    this.engine.clearObjectsSharingBox(object);
    this.engine.putState(object, 1);
  }

  /** The eight state instructions, and their eight branching twins. */
  protected setObjectStateBit(bit: number, set: boolean): void {
    const object = this.getVarOrDirectWord(PARAM_1);
    const state = this.engine.getState(object);
    this.engine.putState(object, set ? state | bit : state & ~bit);
  }

  protected branchOnObjectStateBit(bit: number, wanted: boolean): void {
    const object = this.getVarOrDirectWord(PARAM_1);
    const set = (this.engine.getState(object) & bit) !== 0;
    this.jumpRelative(set === wanted);
  }

  protected o_setStateIntrinsicOn(): void {
    this.setObjectStateBit(V2_STATE.Intrinsic, true);
  }
  protected o_setStateIntrinsicOff(): void {
    this.setObjectStateBit(V2_STATE.Intrinsic, false);
  }
  protected o_setStateLocked(): void {
    this.setObjectStateBit(V2_STATE.Locked, true);
  }
  protected o_setStateUnlocked(): void {
    this.setObjectStateBit(V2_STATE.Locked, false);
  }
  protected o_setStateTouchable(): void {
    this.setObjectStateBit(V2_STATE.Untouchable, false);
  }
  protected o_setStateUntouchable(): void {
    this.setObjectStateBit(V2_STATE.Untouchable, true);
  }
  protected o_setStatePickupable(): void {
    this.setObjectStateBit(V2_STATE.Pickupable, true);
  }
  protected o_setStateUnpickupable(): void {
    this.setObjectStateBit(V2_STATE.Pickupable, false);
  }

  protected o_ifStateIntrinsicOn(): void {
    this.branchOnObjectStateBit(V2_STATE.Intrinsic, true);
  }
  protected o_ifStateIntrinsicOff(): void {
    this.branchOnObjectStateBit(V2_STATE.Intrinsic, false);
  }
  protected o_ifStateLocked(): void {
    this.branchOnObjectStateBit(V2_STATE.Locked, true);
  }
  protected o_ifStateUnlocked(): void {
    this.branchOnObjectStateBit(V2_STATE.Locked, false);
  }
  protected o_ifStateTouchable(): void {
    this.branchOnObjectStateBit(V2_STATE.Untouchable, false);
  }
  protected o_ifStateUntouchable(): void {
    this.branchOnObjectStateBit(V2_STATE.Untouchable, true);
  }
  protected o_ifStatePickupable(): void {
    this.branchOnObjectStateBit(V2_STATE.Pickupable, true);
  }
  protected o_ifStateUnpickupable(): void {
    this.branchOnObjectStateBit(V2_STATE.Pickupable, false);
  }

  /** `ifClassOfIs`: one class byte tested against the object's own. */
  protected o_ifClassOfIsV2(): void {
    const object = this.getVarOrDirectWord(PARAM_1);
    const wanted = this.getVarOrDirectByte(PARAM_2);
    const classes = this.engine.resources.classData[object] ?? 0;
    this.jumpRelative((classes & wanted) === wanted);
  }

  protected o_pickupObjectV2(): void {
    const object = this.getVarOrDirectWord(PARAM_1);
    this.engine.pickupObject(object, this.engine.currentRoom);
  }

  /**
   * An object's preposition, which v2 stores and later Versions do not.
   *
   * Read and dropped. The words a v2 sentence line is built from come from the
   * game's own verb scripts, and the preposition is a number into a table this
   * engine does not keep — but the *bytes* still have to be consumed.
   */
  protected o_setObjPreposition(): void {
    this.getVarOrDirectWord(PARAM_1);
    this.fetchByte();
  }

  protected o_getObjPreposition(): void {
    this.getResultPos();
    this.getVarOrDirectWord(PARAM_1);
    this.setResult(0);
  }

  protected o_loadRoomWithEgoV2(): void {
    const object = this.getVarOrDirectWord(PARAM_1);
    const room = this.getVarOrDirectByte(PARAM_2);
    const x = this.fetchByte();
    const y = this.fetchByte();
    this.engine.loadRoomWithEgo(object, room, x * V2_X_SCALE, y);
  }

  /** `roomOps`: two operands and *then* a sub-opcode byte, in that order. */
  protected o_roomOpsV2(): void {
    this.getVarOrDirectByte(PARAM_1);
    this.getVarOrDirectByte(PARAM_2);
    const subOp = this.fetchByte();
    this.reportUnknownSubOpcode('roomOps', subOp);
  }

  protected o_doSentenceV2(): void {
    const verb = this.getVarOrDirectByte(PARAM_1);
    const objectA = this.getVarOrDirectWord(PARAM_2);
    const objectB = this.getVarOrDirectWord(PARAM_3);
    this.fetchByte();
    if (verb === 0xfe) this.engine.stopSentence();
    else this.engine.doSentence(verb, objectA, objectB);
  }

  /** The sentence line, redrawn from the engine's own state. */
  protected o_drawSentence(): void {}

  /**
   * `verbOps`: a fixed record, not a stream.
   *
   * A verb slot, a position, a colour and a name — five bytes and a
   * NUL-terminated string, always. v3 and later replaced it with the
   * 0xFF-terminated sub-opcode stream `verbOps` is everywhere else, which is
   * why measuring this one as that one runs off the end of the record and into
   * the instruction after it.
   */
  protected o_verbOpsV2(): void {
    const slot = this.fetchByte();
    this.getVarOrDirectByte(PARAM_1);
    this.fetchByte();
    this.fetchByte();
    this.fetchByte();
    this.fetchFilename();
    this.reportUnknownSubOpcode('verbOps', slot);
  }

  /** `cursorCommand`: a single word of flags rather than a sub-opcode. */
  protected o_cursorCommandV2(): void {
    this.getVarOrDirectWord(PARAM_1);
  }

  protected o_switchCostumeSet(): void {
    this.fetchByte();
    this.fetchByte();
  }

  /** `resourceRoutines`: a resource and a type byte, in that order. */
  protected o_resourceRoutinesV2(): void {
    this.getVarOrDirectByte(PARAM_1);
    this.fetchByte();
  }

  protected o_waitForActorV2(): void {
    const start = this.pc - 1;
    const actor = this.engine.getActor(this.getVarOrDirectByte(PARAM_1));
    if (actor && actor.moving) {
      this.pc = start;
      this.breakHere();
    }
  }

  protected o_waitForMessageV2(): void {
    if (this.readVar(this.engine.vars.HAVE_MSG) === 0) return;
    this.pc -= 1;
    this.breakHere();
  }

  protected o_waitForSentenceV2(): void {
    if (!this.engine.isSentencePending()) return;
    this.pc -= 1;
    this.breakHere();
  }

  protected o_setBoxFlagsV2(): void {
    const box = this.getVarOrDirectByte(PARAM_1);
    this.engine.setBoxFlags(box, this.fetchByte());
  }

  protected o_saveLoadGameV2(): void {
    this.getResultPos();
    this.getVarOrDirectByte(PARAM_1);
    this.setResult(0);
  }
}
