import type { ScummEngine } from '../../ScummEngine.js';
import type { ScriptState } from '../ScriptState.js';
import { StackScriptEngine } from '../StackScriptEngine.js';

/**
 * The SCUMM v8 bytecode interpreter — The Curse of Monkey Island.
 *
 * A third delta on `StackScriptEngine`, beside v6 and v7 and **not** beneath
 * v7: ADR 0006 rejected v7-over-v6 and the reason carries. It is the cheapest
 * Version in the v2-v8 widening for exactly the reason the ADR predicted — the
 * base it needs already exists and is already abstract — and the two things
 * that differ are both one seam each.
 *
 * **An immediate is thirty-two bits.** `ScummEngine_v8::fetchScriptWord`
 * returns `fetchScriptDWord`, so every instruction in the shared table that
 * reads a word from the code stream reads four bytes here rather than two:
 * pushed constants, variable numbers, array handles, jump displacements, all
 * of them. That is one override rather than a hundred, and it is the whole of
 * what "32-bit script numbering" means on the bytecode side.
 *
 * **The instruction set is renumbered, not redesigned.** 118 of v8's 142
 * opcodes are instructions v6 already has, at different numbers, and 24 are
 * v8's own. So the table below is a *correspondence* — v8 number to v6 number —
 * applied over the table the base installs, rather than a second copy of a
 * hundred handlers. Derived from ScummVM's two `setupOpcodes` tables by
 * matching handler names, which is also why it is stated as pairs: a pair that
 * is wrong is one instruction in the wrong place, where a re-transcription
 * that drifted would be silently plausible everywhere.
 *
 * What is *not* here is the behaviour of v8's own two dozen. Fifteen of them
 * are sub-opcode dispatchers whose sub-tables are v8's, and they are bound to
 * handlers that consume the right bytes and report themselves unimplemented —
 * which a stack machine makes safe, because an instruction's length follows
 * from its opcode alone and no unimplemented instruction can desynchronise the
 * one after it. That is a deliberate half-measure and it is why #196 is not
 * closed by this.
 */

/**
 * v8 opcode -> the v6 opcode running the same instruction.
 *
 * Read off ScummVM's `ScummEngine_v6::setupOpcodes` and
 * `ScummEngine_v8::setupOpcodes` by handler name. Every v8 entry that names an
 * `o6_` handler is here; the 24 that name an `o8_` one are bound separately
 * below.
 */
const V8_FROM_V6: ReadonlyArray<readonly [v8: number, v6: number]> = [
  [0x01, 0x01],
  [0x02, 0x03],
  [0x03, 0x07],
  [0x04, 0x0b],
  [0x05, 0x0c],
  [0x06, 0x1a],
  [0x07, 0x0d],
  [0x08, 0x0e],
  [0x09, 0x0f],
  [0x0a, 0x10],
  [0x0b, 0x11],
  [0x0c, 0x12],
  [0x0d, 0x13],
  [0x0e, 0x14],
  [0x0f, 0x15],
  [0x10, 0x16],
  [0x11, 0x17],
  [0x12, 0x18],
  [0x13, 0x19],
  [0x14, 0xd6],
  [0x15, 0xd7],
  [0x64, 0x5c],
  [0x65, 0x5d],
  [0x66, 0x73],
  [0x67, 0x6c],
  [0x68, 0xca],
  [0x6a, 0xb0],
  [0x6b, 0xb1],
  [0x6c, 0xb2],
  [0x6d, 0x43],
  [0x6e, 0x4f],
  [0x6f, 0x57],
  [0x71, 0x47],
  [0x72, 0x53],
  [0x73, 0x5b],
  [0x75, 0x4b],
  [0x79, 0x5e],
  [0x7a, 0x5f],
  [0x7b, 0x65],
  [0x7c, 0x7c],
  [0x7d, 0xd5],
  [0x7e, 0xbd],
  [0x7f, 0x60],
  [0x80, 0x77],
  [0x81, 0x68],
  [0x82, 0x67],
  [0x83, 0x6a],
  [0x84, 0x95],
  [0x85, 0x96],
  [0x86, 0xb3],
  [0x89, 0x6e],
  [0x8a, 0x70],
  [0x8b, 0x71],
  [0x8c, 0x78],
  [0x8d, 0x79],
  [0x8e, 0x7a],
  [0x8f, 0xb8],
  [0x90, 0xb9],
  [0x91, 0xba],
  [0x92, 0xbb],
  [0x93, 0xb4],
  [0x94, 0xb5],
  [0x95, 0xb6],
  [0x96, 0xb7],
  [0x9d, 0x7b],
  [0x9e, 0x85],
  [0x9f, 0x7d],
  [0xa0, 0x7e],
  [0xa1, 0x7f],
  [0xa2, 0x80],
  [0xa3, 0x81],
  [0xa4, 0x82],
  [0xa5, 0x83],
  [0xa6, 0x84],
  [0xa7, 0x99],
  [0xa8, 0x9a],
  [0xaf, 0x74],
  [0xb0, 0x76],
  [0xb1, 0x75],
  [0xb2, 0xac],
  [0xb4, 0xa5],
  [0xb5, 0x97],
  [0xb6, 0xd0],
  [0xb7, 0xa6],
  [0xc8, 0xbf],
  [0xc9, 0xbe],
  [0xca, 0xcb],
  [0xcb, 0xcc],
  [0xcd, 0xad],
  [0xce, 0x87],
  [0xcf, 0x88],
  [0xd0, 0x6d],
  [0xd1, 0x6f],
  [0xd2, 0x72],
  [0xd3, 0x8b],
  [0xd5, 0x98],
  [0xd6, 0xc4],
  [0xd9, 0xaf],
  [0xda, 0xa3],
  [0xdb, 0x9f],
  [0xdc, 0xa0],
  [0xdd, 0x94],
  [0xdf, 0x92],
  [0xe0, 0x93],
  [0xe1, 0xd2],
  [0xe2, 0x8c],
  [0xe3, 0x90],
  [0xe4, 0x8a],
  [0xe5, 0x91],
  [0xe6, 0xaa],
  [0xe7, 0xec],
  [0xe8, 0xa2],
  [0xe9, 0xa8],
  [0xea, 0xed],
  [0xeb, 0x8d],
  [0xec, 0x8e],
  [0xee, 0xc5],
  [0xef, 0xc7],
];

/**
 * v8's sub-opcode numbers for the families implemented here.
 *
 * From `ScummEngine_v8`'s own enumeration. They share nothing with v6's, which
 * is why the shared base's tables cannot be reached by renumbering the
 * instruction alone.
 */
const V8_SUB = {
  IntArray: 10,
  StringArray: 11,
  UndimArray: 12,
  AssignString: 20,
  AssignIntList: 21,
  Assign2DimList: 22,
  WaitForActor: 30,
  WaitForMessage: 31,
  WaitForCamera: 32,
  WaitForSentence: 33,
  WaitForAnimation: 34,
  WaitForTurn: 35,

  Restart: 40,
  Quit: 41,

  CameraPause: 50,
  CameraResume: 51,

  HeapLoadCharset: 60,
  HeapLoadCostume: 61,
  HeapLoadObject: 62,
  HeapLoadRoom: 63,
  HeapLoadScript: 64,
  HeapLoadSound: 65,
  HeapLockCostume: 66,
  HeapLockRoom: 67,
  HeapLockScript: 68,
  HeapLockSound: 69,
  HeapUnlockCostume: 70,
  HeapUnlockRoom: 71,
  HeapUnlockScript: 72,
  HeapUnlockSound: 73,
  HeapNukeCostume: 74,
  HeapNukeRoom: 75,
  HeapNukeScript: 76,
  HeapNukeSound: 77,

  CursorOn: 220,
  CursorOff: 221,
  CursorSoftOn: 222,
  CursorSoftOff: 223,
  UserPutOn: 224,
  UserPutOff: 225,
  UserPutSoftOn: 226,
  UserPutSoftOff: 227,
  CursorImage: 228,
  CursorHotspot: 229,
  CursorTransparent: 230,
  CharsetSet: 231,
  CharsetColor: 232,
  CursorPut: 233,

  RoomPalette: 82,
  RoomFade: 87,
  RoomRgbIntensity: 88,
  RoomTransform: 89,
  RoomNewPalette: 92,
  RoomSaveGame: 93,
  RoomLoadGame: 94,
  RoomSaturation: 95,

  Costume: 100,
  StepDist: 101,
  AnimationDefault: 103,
  InitAnimation: 104,
  TalkAnimation: 105,
  WalkAnimation: 106,
  StandAnimation: 107,
  AnimationSpeed: 108,
  ActorDefault: 109,
  Elevation: 110,
  ActorPalette: 111,
  TalkColor: 112,
  ActorName: 113,
  ActorWidth: 114,
  Scale: 115,
  NeverZClip: 116,
  AlwaysZClip: 117,
  IgnoreBoxes: 118,
  FollowBoxes: 119,
  Shadow: 120,
  TextOffset: 121,
  ActorInit: 122,
  ActorVariable: 123,
  ActorIgnoreTurnsOn: 124,
  ActorIgnoreTurnsOff: 125,
  ActorNew: 126,
  ActorDepth: 127,
  ActorStop: 128,
  ActorFace: 129,
  ActorTurn: 130,
  ActorWalkScript: 131,
  ActorTalkScript: 132,
  ActorWalkPause: 133,
  ActorWalkResume: 134,
  ActorVolume: 135,
  ActorFrequency: 136,
  ActorPan: 137,

  VerbInit: 150,
  VerbNew: 151,
  VerbDelete: 152,
  VerbName: 153,
  VerbAt: 154,
  VerbOn: 155,
  VerbOff: 156,
  VerbColor: 157,
  VerbHiColor: 158,
  VerbDimColor: 160,
  VerbDim: 161,
  VerbKey: 162,
  VerbImage: 163,
  VerbNameStr: 164,
  VerbCenter: 165,
  VerbCharset: 166,
  VerbLineSpacing: 167,
} as const;

/**
 * How many values each v8 sub-opcode takes off the stack.
 *
 * The number that matters most in this file, and the one a stack machine
 * punishes hardest. An instruction's *length* is safe whatever happens here —
 * it is one sub-opcode byte — but popping the wrong count leaves the stack
 * misaligned, and the next instruction reads someone else's value. That is a
 * fault with no local symptom at all.
 *
 * Anything absent pops nothing. Taken from `ScummEngine_v8`'s handlers one case
 * at a time.
 */
const V8_POPS = new Map<number, number>([
  // roomOps
  [V8_SUB.RoomPalette, 4],
  [V8_SUB.RoomFade, 1],
  [V8_SUB.RoomRgbIntensity, 5],
  [V8_SUB.RoomTransform, 4],
  [V8_SUB.RoomNewPalette, 1],
  [V8_SUB.RoomLoadGame, 1],
  [V8_SUB.RoomSaturation, 5],
  // actorOps
  [V8_SUB.Costume, 1],
  [V8_SUB.StepDist, 2],
  [V8_SUB.InitAnimation, 1],
  [V8_SUB.TalkAnimation, 2],
  [V8_SUB.WalkAnimation, 1],
  [V8_SUB.StandAnimation, 1],
  [V8_SUB.AnimationSpeed, 1],
  [V8_SUB.Elevation, 1],
  [V8_SUB.ActorPalette, 2],
  [V8_SUB.TalkColor, 1],
  [V8_SUB.ActorWidth, 1],
  [V8_SUB.Scale, 1],
  [V8_SUB.AlwaysZClip, 1],
  [V8_SUB.Shadow, 1],
  [V8_SUB.TextOffset, 2],
  [V8_SUB.ActorVariable, 2],
  [V8_SUB.ActorDepth, 1],
  [V8_SUB.ActorFace, 1],
  [V8_SUB.ActorTurn, 1],
  [V8_SUB.ActorWalkScript, 1],
  [V8_SUB.ActorTalkScript, 1],
  [V8_SUB.ActorVolume, 1],
  [V8_SUB.ActorFrequency, 1],
  [V8_SUB.ActorPan, 1],
  // verbOps
  [V8_SUB.VerbAt, 2],
  [V8_SUB.VerbColor, 1],
  [V8_SUB.VerbHiColor, 1],
  [V8_SUB.VerbDimColor, 1],
  [V8_SUB.VerbKey, 1],
  [V8_SUB.VerbImage, 2],
  [V8_SUB.VerbNameStr, 1],
  [V8_SUB.VerbCharset, 1],
  [V8_SUB.VerbLineSpacing, 1],
]);

/**
 * Which resource type each of v8's eighteen heap sub-opcodes names.
 *
 * v8 spends a number per (verb, type) pair — load, lock, unlock and nuke, times
 * costume, room, script and sound — where v5 spends four numbers and reads the
 * type from the low bits. Written out because there is no arithmetic between
 * them: the loads run 60-65 over six types and the rest run in fours.
 */
const V8_HEAP_TYPES = new Map<number, 'costume' | 'room' | 'script' | 'sound'>([
  [V8_SUB.HeapLoadCostume, 'costume'],
  [V8_SUB.HeapLoadRoom, 'room'],
  [V8_SUB.HeapLoadScript, 'script'],
  [V8_SUB.HeapLoadSound, 'sound'],
  [V8_SUB.HeapLockCostume, 'costume'],
  [V8_SUB.HeapLockRoom, 'room'],
  [V8_SUB.HeapLockScript, 'script'],
  [V8_SUB.HeapLockSound, 'sound'],
  [V8_SUB.HeapUnlockCostume, 'costume'],
  [V8_SUB.HeapUnlockRoom, 'room'],
  [V8_SUB.HeapUnlockScript, 'script'],
  [V8_SUB.HeapUnlockSound, 'sound'],
]);

/**
 * Sub-opcodes that take nothing off the stack, so an empty pop list is right
 * rather than unknown.
 *
 * Kept apart from `V8_POPS` because "pops nothing" and "not in the table" have
 * to be distinguishable: the first is an answer and the second is a gap, and
 * only the second is worth reporting.
 */
const V8_NO_OPERAND = new Set<number>([
  V8_SUB.RoomSaveGame,
  V8_SUB.AnimationDefault,
  V8_SUB.ActorDefault,
  V8_SUB.ActorName,
  V8_SUB.NeverZClip,
  V8_SUB.IgnoreBoxes,
  V8_SUB.FollowBoxes,
  V8_SUB.ActorInit,
  V8_SUB.ActorIgnoreTurnsOn,
  V8_SUB.ActorIgnoreTurnsOff,
  V8_SUB.ActorNew,
  V8_SUB.ActorStop,
  V8_SUB.ActorWalkPause,
  V8_SUB.ActorWalkResume,
  V8_SUB.VerbInit,
  V8_SUB.VerbNew,
  V8_SUB.VerbDelete,
  V8_SUB.VerbName,
  V8_SUB.VerbOn,
  V8_SUB.VerbOff,
  V8_SUB.VerbDim,
  V8_SUB.VerbCenter,
]);

export class ScriptEngine extends StackScriptEngine {
  constructor(engine: ScummEngine, state: ScriptState) {
    super(engine, state);
    this.installOpcodes();
  }

  /**
   * A code-stream word is four bytes at v8 and two everywhere else.
   *
   * The single most load-bearing line in this file. Every shared instruction
   * that reads an immediate goes through here, so getting it wrong does not
   * produce a wrong value — it produces a program counter two bytes out at the
   * first constant and nonsense from there on.
   */
  protected override fetchWord(): number {
    const low = super.fetchWord();
    const high = super.fetchWord();
    return ((high << 16) | low) >>> 0;
  }

  protected override fetchWordSigned(): number {
    return this.fetchWord() | 0;
  }

  /** v8 keeps its last random number where v6 and v7 do not. */
  protected get randomNumberVariable(): number {
    return this.engine.vars.SYNC;
  }

  /**
   * An inline string: bytes up to a zero, with no length in front of it.
   *
   * v8 has no embedded control codes of v6's kind in the code stream — its
   * text carries them differently — so this is the plain reading rather than
   * v6's escape-aware one.
   */
  protected fetchInlineText(): string {
    let text = '';
    for (;;) {
      const byte = this.fetchByte();
      if (byte === 0 || this.codeOverrun) break;
      text += String.fromCharCode(byte);
    }
    return text;
  }

  /**
   * The message an instruction speaks.
   *
   * v8's recorded speech is addressed by cue name in a bundle rather than by
   * an offset into one file, as v7's is, so there is no offset to return here
   * and a caller that waits on speech waits on the text instead.
   */
  protected fetchSpokenMessage(): { text: string; speechOffset: number; speechSize: number } {
    return { text: this.fetchInlineText(), speechOffset: 0, speechSize: 0 };
  }

  /**
   * Takes a sub-opcode's operands off the stack, in pop order.
   *
   * Always the right number, whether or not the sub-opcode is implemented,
   * which is the whole point: an unimplemented instruction that leaves its
   * operands behind is not unimplemented, it is corrupting. Reports once for
   * anything the tables do not name, so a v8 game says what it wanted rather
   * than merely behaving oddly.
   */
  protected takeSubOperands(family: string, subOp: number): number[] {
    const count = V8_POPS.get(subOp) ?? 0;
    const args: number[] = [];
    for (let i = 0; i < count; i++) args.push(this.pop());
    if (!V8_POPS.has(subOp) && !V8_NO_OPERAND.has(subOp)) {
      this.reportUnknownSubOpcode(family, subOp, 'stack');
    }
    return args;
  }

  protected installOpcodes(): void {
    // The shared table first, at v6's numbers, and then moved wholesale to
    // v8's. Snapshotted before the move because the two numberings overlap:
    // writing into `dispatch` while reading from it would let an instruction
    // already moved be read as the source for the next one.
    this.installStackCoreOpcodes();
    this.installStackSharedOpcodes();
    const atV6Numbers = [...this.dispatch];
    this.dispatch.fill(undefined);

    for (const [v8Code, v6Code] of V8_FROM_V6) {
      this.dispatch[v8Code] = atV6Numbers[v6Code];
    }

    // v8's own arithmetic, which v6 has no instruction for at all.
    this.dispatch[0x16] = function () {
      const divisor = this.pop();
      const value = this.pop();
      this.push(divisor === 0 ? 0 : value % divisor);
    };

    // The getters, which take their arguments off the stack and so need
    // nothing from the code stream. Answered rather than left unbound: a
    // getter that pushes nothing leaves the stack short and every instruction
    // after it reads someone else's value.
    for (const code of [0xed, 0xf0, 0xf1, 0xf2, 0xf3, 0xf6, 0xf7]) {
      this.dispatch[code] = function () {
        this.pop();
        this.push(0);
      };
    }

    // The array family: a sub-opcode byte, an array handle from the code
    // stream, and its dimensions off the stack.
    this.dispatch[0x70] = function () {
      const subOp = this.fetchByte();
      const array = this.fetchWord();
      if (subOp === V8_SUB.UndimArray) {
        this.arrays.undefine(array);
        return;
      }
      const kind = subOp === V8_SUB.StringArray ? 'string' : 'int';
      if (subOp !== V8_SUB.IntArray && subOp !== V8_SUB.StringArray) {
        this.reportUnknownSubOpcode('dimArray', subOp, 'stack');
        return;
      }
      this.defineArray(array, kind, 0, this.pop());
    };

    this.dispatch[0x74] = function () {
      const subOp = this.fetchByte();
      const array = this.fetchWord();
      if (subOp === V8_SUB.UndimArray) {
        this.arrays.undefine(array);
        return;
      }
      if (subOp !== V8_SUB.IntArray && subOp !== V8_SUB.StringArray) {
        this.reportUnknownSubOpcode('dim2dimArray', subOp, 'stack');
        return;
      }
      // Columns are on top of the stack and rows beneath, which is the reverse
      // of the order they are declared in.
      const columns = this.pop();
      const rows = this.pop();
      this.defineArray(array, subOp === V8_SUB.StringArray ? 'string' : 'int', rows, columns);
    };

    this.dispatch[0x76] = function () {
      const subOp = this.fetchByte();
      const array = this.fetchWord();

      switch (subOp) {
        case V8_SUB.AssignString: {
          // The string is inline and its length decides the array's size, so
          // the array is defined after the text has been read rather than
          // before.
          const at = this.pop();
          const text = this.fetchInlineText();
          this.defineArray(array, 'string', 0, at + text.length + 1);
          this.arrays.writeString(array, at, text);
          break;
        }
        case V8_SUB.AssignIntList: {
          const at = this.pop();
          const values = this.popList(128);
          if (!this.arrays.has(array)) this.defineArray(array, 'int', 0, at + values.length);
          for (let i = 0; i < values.length; i++) this.writeArray(array, at + i, values[i]);
          break;
        }
        case V8_SUB.Assign2DimList: {
          const at = this.pop();
          const values = this.popList(128);
          const row = this.pop();
          for (let i = 0; i < values.length; i++) {
            this.writeArray(array, at + i, values[i], row);
          }
          break;
        }
        default:
          this.reportUnknownSubOpcode('arrayOps', subOp, 'stack');
      }
    };

    /**
     * `wait`: a sub-opcode, and the three actor forms carry a jump as well.
     *
     * The jump is what makes this worth implementing rather than measuring: it
     * is how the instruction loops back on itself, so a reader that consumed
     * the sub-opcode and stopped would leave four bytes of displacement to be
     * executed as instructions.
     */
    this.dispatch[0x69] = function () {
      const subOp = this.fetchByte();
      const takesActor =
        subOp === V8_SUB.WaitForActor ||
        subOp === V8_SUB.WaitForAnimation ||
        subOp === V8_SUB.WaitForTurn;

      const displacement = takesActor ? this.fetchWordSigned() : -2;
      let keepWaiting: boolean;

      switch (subOp) {
        case V8_SUB.WaitForActor:
        case V8_SUB.WaitForAnimation:
        case V8_SUB.WaitForTurn: {
          const actor = this.engine.getActor(this.pop());
          keepWaiting = Boolean(
            actor && actor.isInCurrentRoom(this.engine.currentRoom) && actor.moving,
          );
          break;
        }
        case V8_SUB.WaitForMessage:
          keepWaiting = this.readVar(this.engine.vars.HAVE_MSG) !== 0;
          break;
        case V8_SUB.WaitForCamera:
          keepWaiting = this.engine.camera.current !== this.engine.camera.destination;
          break;
        case V8_SUB.WaitForSentence:
          keepWaiting = this.engine.isSentencePending();
          break;
        default:
          this.reportUnknownSubOpcode('wait', subOp, 'stack');
          return;
      }

      if (!keepWaiting) return;
      this.pc += displacement;
      this.breakHere();
    };

    /**
     * `systemOps`, `cameraOps`, `cursorCommand` and `resourceRoutines`.
     *
     * Four of v8's dispatchers whose sub-tables map onto things this engine
     * already does. They are worth writing rather than measuring because every
     * operand is on the stack: nothing here can desynchronise, so the only risk
     * is doing nothing where something was asked — and a cursor that never
     * turns off is a game the player cannot use.
     */
    this.dispatch[0xb3] = function () {
      const subOp = this.fetchByte();
      if (subOp === V8_SUB.Restart) this.engine.restart();
      else if (subOp === V8_SUB.Quit) this.engine.quitGame();
      else this.reportUnknownSubOpcode('systemOps', subOp, 'stack');
    };

    this.dispatch[0xad] = function () {
      const subOp = this.fetchByte();
      // Pausing and resuming the camera is a v8 instruction with no equivalent
      // here: the camera follows its destination every frame and has no state
      // to hold. Recorded rather than reported, because it is understood.
      if (subOp !== V8_SUB.CameraPause && subOp !== V8_SUB.CameraResume) {
        this.reportUnknownSubOpcode('cameraOps', subOp, 'stack');
      }
    };

    this.dispatch[0x9c] = function () {
      const subOp = this.fetchByte();
      switch (subOp) {
        case V8_SUB.CursorOn:
          this.engine.setCursorVisible(true);
          break;
        case V8_SUB.CursorOff:
          this.engine.setCursorVisible(false);
          break;
        case V8_SUB.CursorSoftOn:
          this.engine.setCursorVisible(true, true);
          break;
        case V8_SUB.CursorSoftOff:
          this.engine.setCursorVisible(false, true);
          break;
        case V8_SUB.UserPutOn:
          this.engine.setUserPut(true);
          break;
        case V8_SUB.UserPutOff:
          this.engine.setUserPut(false);
          break;
        case V8_SUB.UserPutSoftOn:
          this.engine.setUserPut(true, true);
          break;
        case V8_SUB.UserPutSoftOff:
          this.engine.setUserPut(false, true);
          break;
        case V8_SUB.CursorImage: {
          // The image and the slot, popped in that order.
          const image = this.pop();
          this.engine.setCursorImage(this.pop(), image);
          break;
        }
        case V8_SUB.CursorHotspot: {
          const y = this.pop();
          const x = this.pop();
          this.engine.setCursorHotspot(0, x, y);
          break;
        }
        case V8_SUB.CursorPut:
          this.engine.setCurrentCursor(this.pop());
          break;
        case V8_SUB.CharsetSet:
          this.engine.setCharsetResource(this.pop());
          break;
        case V8_SUB.CharsetColor:
          this.engine.setCharsetColors(this.popList(16));
          break;
        case V8_SUB.CursorTransparent:
          this.pop();
          break;
        default:
          this.reportUnknownSubOpcode('cursorCommand', subOp, 'stack');
      }
    };

    this.dispatch[0xaa] = function () {
      const subOp = this.fetchByte();
      const resource = this.pop();
      const type = V8_HEAP_TYPES.get(subOp);

      if (type) {
        // Loading, locking and unlocking all come to the same thing here: this
        // engine holds the whole container in memory, so a resource is either
        // present or it is not and nothing can be evicted. What matters is that
        // asking for one that is missing is *reported*, which `ensureResource`
        // does.
        this.engine.ensureResource(type, resource);
        return;
      }

      if (subOp === V8_SUB.HeapLoadCharset) {
        this.engine.setCharsetResource(resource);
        return;
      }
      if (
        subOp === V8_SUB.HeapLoadObject ||
        (subOp >= V8_SUB.HeapNukeCostume && subOp <= V8_SUB.HeapNukeSound)
      ) {
        // Nothing is nuked, for the reason above.
        return;
      }
      this.reportUnknownSubOpcode('resourceRoutines', subOp, 'stack');
    };

    /**
     * `roomOps`, `actorOps` and `verbOps` — v8's three largest families.
     *
     * Every operand is on the stack, so the *length* of these instructions is
     * safe whatever happens inside: one sub-opcode byte. What is not safe is
     * the pop count, because a stack machine has no way to notice a
     * misalignment — the next instruction simply reads someone else's value.
     * So `V8_POPS` is the load-bearing part, and it is transcribed one case at
     * a time rather than inferred.
     *
     * Where a sub-opcode maps onto something this engine does, it is done.
     * Where it does not, the operands are still taken off the stack and the
     * sub-opcode is reported once. That is the difference between an
     * unimplemented instruction and a corrupting one.
     */
    this.dispatch[0xab] = function () {
      const subOp = this.fetchByte();
      const args = this.takeSubOperands('roomOps', subOp);
      if (subOp === V8_SUB.RoomFade) this.engine.setScreenEffect(args[0] ?? 0);
    };

    this.dispatch[0xac] = function () {
      const subOp = this.fetchByte();
      // The actor is popped before the switch, for every form.
      const actor = this.engine.getActor(this.pop());
      const args = this.takeSubOperands('actorOps', subOp);
      if (!actor) return;

      switch (subOp) {
        case V8_SUB.Costume:
          this.engine.setActorCostume(actor, args[0]);
          break;
        case V8_SUB.StepDist:
          actor.speedX = args[0];
          actor.speedY = args[1];
          break;
        case V8_SUB.InitAnimation:
          actor.initFrame = args[0];
          break;
        case V8_SUB.TalkAnimation:
          // Popped stop-first, so the pair arrives reversed.
          actor.talkStopFrame = args[0];
          actor.talkStartFrame = args[1];
          break;
        case V8_SUB.WalkAnimation:
          actor.walkFrame = args[0];
          break;
        case V8_SUB.StandAnimation:
          actor.standFrame = args[0];
          break;
        case V8_SUB.AnimationSpeed:
          actor.animSpeed = args[0];
          actor.animProgress = args[0];
          break;
        case V8_SUB.Elevation:
          actor.elevation = args[0];
          actor.needRedraw = true;
          break;
        case V8_SUB.TalkColor:
          actor.talkColor = args[0];
          break;
        case V8_SUB.ActorWidth:
          actor.width = args[0];
          break;
        case V8_SUB.Scale:
          actor.scaleX = args[0];
          actor.scaleY = args[0];
          actor.needRedraw = true;
          break;
        case V8_SUB.NeverZClip:
          actor.neverZClip = 0;
          break;
        case V8_SUB.AlwaysZClip:
          actor.neverZClip = args[0];
          break;
        case V8_SUB.IgnoreBoxes:
        case V8_SUB.FollowBoxes:
          actor.ignoreBoxes = subOp === V8_SUB.IgnoreBoxes;
          actor.forceClip = 0;
          this.engine.putActor(actor.number, actor.x, actor.y);
          break;
        case V8_SUB.Shadow:
          actor.shadowMode = args[0];
          break;
        case V8_SUB.ActorDefault:
        case V8_SUB.ActorNew:
          this.engine.initActor(actor, subOp === V8_SUB.ActorNew ? 2 : 0);
          break;
        case V8_SUB.AnimationDefault:
          actor.walkFrame = 2;
          actor.standFrame = 3;
          actor.talkStartFrame = 4;
          actor.talkStopFrame = 5;
          actor.initFrame = 1;
          break;
        default:
          break;
      }
    };

    this.dispatch[0xae] = function () {
      const subOp = this.fetchByte();
      const verbNumber = this.pop();
      const args = this.takeSubOperands('verbOps', subOp);
      const verb = this.engine.verbs.getOrCreate(verbNumber);

      switch (subOp) {
        case V8_SUB.VerbNew:
          this.engine.verbs.create(verbNumber, this.engine.currentCharsetId);
          break;
        case V8_SUB.VerbDelete:
          this.engine.verbs.remove(verbNumber);
          break;
        case V8_SUB.VerbAt:
          // Popped top-first, so the pair arrives reversed.
          verb.y = args[0];
          verb.x = args[1];
          break;
        case V8_SUB.VerbOn:
          verb.enabled = true;
          break;
        case V8_SUB.VerbOff:
          verb.enabled = false;
          break;
        case V8_SUB.VerbColor:
          verb.color = args[0];
          break;
        case V8_SUB.VerbHiColor:
          verb.hiColor = args[0];
          break;
        case V8_SUB.VerbDimColor:
          verb.dimColor = args[0];
          break;
        case V8_SUB.VerbDim:
          verb.dim = true;
          break;
        case V8_SUB.VerbKey:
          verb.key = args[0];
          break;
        case V8_SUB.VerbCenter:
          verb.center = true;
          break;
        case V8_SUB.VerbImage:
          verb.image = args[1];
          verb.type = 'image';
          break;
        case V8_SUB.VerbNameStr:
          verb.text = this.engine.getString(args[0]);
          verb.type = 'text';
          break;
        default:
          break;
      }
      this.engine.verbs.markDirty(verbNumber);
    };

    /**
     * The kernel families, whose first stack value selects the operation.
     *
     * A counted list rather than a sub-opcode byte, so nothing about the code
     * stream depends on which operation it is — and the stack cannot
     * misalign either, because the list carries its own length. That makes
     * these the two safest families to leave unimplemented, which is what they
     * are: the getter pushes zero so the instruction that reads its answer
     * still finds one.
     */
    this.dispatch[0xba] = function () {
      const args = this.popList(30);
      this.reportUnknownSubOpcode('kernelSetFunctions', args[0] ?? 0, 'stack');
    };

    this.dispatch[0xd8] = function () {
      const args = this.popList(30);
      this.reportUnknownSubOpcode('kernelGetFunctions', args[0] ?? 0, 'stack');
      this.push(0);
    };

    // Three that read more than a sub-opcode byte, and so cannot be left to
    // the loop above without leaving bytes behind.
    this.dispatch[0x97] = function () {
      // `blastText`: an inline string, as v6's print family reads one.
      this.fetchInlineText();
    };
    this.dispatch[0xb9] = function () {
      // `startVideo`: the file name, inline.
      this.fetchInlineText();
    };
    this.dispatch[0x98] = function () {
      // `drawObject`: state and object, both off the stack.
      this.pop();
      this.pop();
    };
  }
}

/** Named for the engine, which selects an interpreter by Version. */
export { ScriptEngine as ScriptEngineV8 };
