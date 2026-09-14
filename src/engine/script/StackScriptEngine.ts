import { ObjectWhere, ScriptStatus, TEXT_SLOT, TEXT_SLOT_COUNT } from '../constants.js';
import type { ScummEngine, SubOpcodeEffect } from '../ScummEngine.js';
import type { ScriptState } from './ScriptState.js';
import type { DeclaredArrayKind } from './ScriptArrays.js';
import type { TextOptions } from '../ScummEngine.js';
import { Actor, MF_FROZEN, MF_TURN, V7_CLIP_FROM_BOX } from '../actor/Actor.js';
import { SCREEN_WIDTH } from '../gfx/Screen.js';
import { ScriptScheduler } from './ScriptScheduler.js';

/**
 * Thrown to unwind out of a script that killed itself mid-opcode.
 *
 * An instruction that ends its own script cannot simply return: it is called
 * from inside the decode loop, which would carry on reading bytes from a slot
 * that no longer exists. Throwing leaves the loop from wherever the handler
 * was, and the two places that run a slot catch it.
 */
export class ScriptStopped extends Error {
  constructor() {
    super('script stopped');
    this.name = 'ScriptStopped';
  }
}

/** The three address spaces a variable number can name. */
const VAR_BIT = 0x8000;
const VAR_LOCAL = 0x4000;

/**
 * True for the room operands that mean "leave the actor's room alone".
 *
 * Only these two: 0xFF as a byte, and the same sentinel widened when it comes
 * through a variable. Every other value is a room to move the actor to, room 0
 * included.
 */
function isKeepRoom(room: number): boolean {
  return room === 0xff || room === 0x7fffffff || room === -1;
}
const VAR_SPACE = 0xf000;

/**
 * The stack machine v6 and v7 share.
 *
 * ADR 0001 gave each SCUMM version its own script engine because v5 and v6
 * share nothing: v5 packs operand modes into the opcode byte, v6 pushes
 * operands onto a stack. v7 is not that relationship. v7 *is* v6's stack
 * machine, and ScummVM records the fact by deriving `ScummEngine_v7` from
 * `ScummEngine_v6` — it inherits v6's whole opcode table, overrides one
 * handler, and expresses the rest of its delta as version branches inside
 * shared ones. So the decode loop, the operand stack, variable and array
 * addressing, the opcode budget and the instruction trail live here, and each
 * version installs its own opcodes over the top (ADR 0006).
 *
 * Deliberately *not* here: anything whose numbering is a fact about one
 * version. Sub-opcode tables, message encoding and the variable map are all
 * per-version even where the machinery reading them is not.
 *
 * The boundary rule in `eslint.config.js` is unchanged by this: a version still
 * may not import a sibling, because the shared code is not in a sibling.
 */
/**
 * `dimArray` and `dim2dimArray` name the element type they want.
 *
 * Shared rather than per version: these are sub-opcodes of the *encoding*, and
 * v6 and v7 are one encoding. ScummVM gives v7 no opcode table of its own for
 * the same reason.
 */
const ARRAY_KIND: Record<number, DeclaredArrayKind> = {
  199: 'int',
  200: 'bit',
  201: 'nibble',
  202: 'byte',
  203: 'string',
};

/** `dimArray`'s one destructive form. */
const UNDIM_ARRAY = 204;

const ARRAY_OP = { AssignString: 205, AssignIntList: 208, Assign2DimList: 212 } as const;

/**
 * Sub-opcode numbers for the v6 instructions that carry a stream of them.
 *
 * Named rather than inlined for the reason the v5 engine's are: a sub-opcode
 * whose operand count is wrong does not fail where it is written. It leaves the
 * stack one deep and the *next* instruction reads someone else's operand, so
 * the symptom is always somewhere else. Numbering is from ScummVM's
 * `scumm_v6.h`, which is a fact about the bytecode rather than part of its
 * implementation.
 *
 * Two habits of the format are worth knowing before reading any of these:
 *
 * - **The numbers are shared across instructions, not per instruction.** 197 is
 *   "set the current actor" in `actorOps` and 196 is "set the current verb" in
 *   `verbOps`, from one flat table, which is why these are grouped by
 *   instruction here but not renumbered.
 * - **`print` reads exactly one sub-opcode per instruction**, unlike v5's
 *   0xFF-terminated stream. `printLine.begin()`, `.at(x,y)` and `.text("…")`
 *   are three separate instructions, and the settings persist between them.
 */
const ACTOR_OP = {
  Costume: 76,
  StepDist: 77,
  Sound: 78,
  WalkAnimation: 79,
  TalkAnimation: 80,
  StandAnimation: 81,
  /** Three operands and no effect, even in the original. */
  Animation: 82,
  Default: 83,
  Elevation: 84,
  AnimationDefault: 85,
  Palette: 86,
  TalkColor: 87,
  Name: 88,
  InitAnimation: 89,
  Width: 91,
  Scale: 92,
  NeverZClip: 93,
  AlwaysZClip: 94,
  IgnoreBoxes: 95,
  FollowBoxes: 96,
  AnimationSpeed: 97,
  Shadow: 98,
  TextOffset: 99,
  /** Selects the actor the rest of the sub-opcodes apply to. */
  Init: 197,
  Variable: 198,
  IgnoreTurnsOn: 215,
  IgnoreTurnsOff: 216,
  New: 217,
  /**
   * The Full Throttle demo's own number for `AlwaysZClip`.
   *
   * ScummVM carries it as a separate constant handled by the same case, and
   * only that release emits it, which is why a full copy of the game never
   * reveals it missing. The demo's boot script reaches it, so without this
   * every actor in the demo kept the default clip plane and the value the
   * instruction meant to consume stayed on the stack for a later instruction
   * to read as its own.
   */
  AlwaysZClipFtDemo: 225,
  Depth: 227,
  WalkScript: 228,
  Stop: 229,
  Face: 230,
  Turn: 231,
  WalkPause: 233,
  WalkResume: 234,
  TalkScript: 235,
} as const;

const VERB_OP = {
  Image: 124,
  Name: 125,
  Color: 126,
  HiColor: 127,
  At: 128,
  On: 129,
  Off: 130,
  Delete: 131,
  New: 132,
  DimColor: 133,
  Dim: 134,
  Key: 135,
  Center: 136,
  NameFromString: 137,
  ImageInRoom: 139,
  BackColor: 140,
  /** Selects the verb the rest of the sub-opcodes apply to. */
  Init: 196,
  End: 255,
} as const;

const ROOM_OP = {
  Scroll: 172,
  Screen: 174,
  Palette: 175,
  ShakeOn: 176,
  ShakeOff: 177,
  Intensity: 179,
  SaveGame: 180,
  Fade: 181,
  RgbIntensity: 182,
  Shadow: 183,
  SaveString: 184,
  LoadString: 185,
  Transform: 186,
  CycleSpeed: 187,
  NewPalette: 213,
} as const;

const CURSOR_OP = {
  On: 144,
  Off: 145,
  UserPutOn: 146,
  UserPutOff: 147,
  SoftOn: 148,
  SoftOff: 149,
  UserPutSoftOn: 150,
  UserPutSoftOff: 151,
  Image: 153,
  Hotspot: 154,
  CharsetSet: 156,
  CharsetColor: 157,
  Transparent: 214,
} as const;

const SYSTEM_OP = { Restart: 158, Pause: 159, Quit: 160 } as const;

const SAVE_VERBS_OP = { Save: 141, Restore: 142, Delete: 143 } as const;

const RESOURCE_OP = {
  LoadScript: 100,
  LoadSound: 101,
  LoadCostume: 102,
  LoadRoom: 103,
  NukeScript: 104,
  NukeSound: 105,
  NukeCostume: 106,
  NukeRoom: 107,
  LockScript: 108,
  LockSound: 109,
  LockCostume: 110,
  LockRoom: 111,
  UnlockScript: 112,
  UnlockSound: 113,
  UnlockCostume: 114,
  UnlockRoom: 115,
  ClearHeap: 116,
  LoadCharset: 117,
  NukeCharset: 118,
  LoadObject: 119,
} as const;

/** The sub-opcodes of the `print` family, which addresses four text slots. */
export const STRING_OP = {
  At: 65,
  Color: 66,
  Clipped: 67,
  Center: 69,
  Left: 71,
  Overhead: 72,
  Mumble: 74,
  TextString: 75,
  /** Resets the slot to its saved defaults, and takes the actor if there is one. */
  BaseOp: 254,
  /** Saves the slot's current settings as its defaults. */
  End: 255,
} as const;

/** `printLine`'s actor number, meaning "nobody is speaking this". */
export const NARRATOR = 0xff;

export abstract class StackScriptEngine extends ScriptScheduler {
  /**
   * Opcode -> handler. Sparse: an empty entry is an unimplemented opcode.
   *
   * Typed on the polymorphic `this`, so a subclass installing handlers gets
   * its own type inside them without a cast, and the decode loop here can
   * still call any of them.
   */
  protected readonly dispatch: Array<((this: this) => void) | undefined> = new Array(256);

  /** The operand stack, shared by every instruction in the running script. */
  protected readonly stack: number[] = [];

  protected pc = 0;
  protected code: Uint8Array | null = null;
  protected opcode = 0;

  /** Offset of the instruction currently running, for `delayFrames`. */
  protected instructionStart = 0;
  protected codeOverrun = false;

  /** As v5: a script that never yields is wedged, and the tab must survive it. */
  private static readonly OPCODES_PER_EXECUTION = 100_000;
  private static readonly OPCODES_PER_ENTRY = 400_000;
  private budgetRemaining = StackScriptEngine.OPCODES_PER_ENTRY;

  /**
   * The last sixteen instructions executed, newest last.
   *
   * v5 has had one of these since it was written and v6 never did, which meant
   * the version with four faults beaten out of it against real game data was
   * the one that could not say what it had just run. A fault surfaces a long
   * way from its cause in a stack machine — an instruction that consumes the
   * wrong number of operands leaves the stack misaligned and the *next* one
   * reads someone else's value — so the trail is what turns "a script ran off
   * its end" into a named instruction.
   *
   * Offset and opcode are kept in one word. v5 does the same, but v5's packing
   * assumes a one-byte opcode, which is a fact about v5's encoding rather than
   * a general one; here it is true of both versions that use this base.
   */
  private readonly trail = new Uint32Array(16);
  private trailNext = 0;

  constructor(engine: ScummEngine, state: ScriptState) {
    super(engine, state);
    // Defining an array writes a handle into its variable, and only the engine
    // knows whether that variable is a global or a script local.
    state.arrays.bindVariables((variable, handle) => this.writeVar(variable, handle));

    // The text slots, here rather than per version: both versions have four,
    // both address them by the same numbers, and a version that forgot to fill
    // them would fail at the first printed line with nothing to point at.
    for (let slot = 0; slot < TEXT_SLOT_COUNT; slot++) {
      this.textSlots.push(engine.beginTextOptions(NARRATOR));
      this.textDefaults.push(engine.beginTextOptions(NARRATOR));
    }
  }

  /** Installs this version's opcode table. Called by the subclass constructor. */
  protected abstract installOpcodes(): void;

  /**
   * Where this version keeps the last random number drawn.
   *
   * The instruction is shared; the variable it writes is a fact about one
   * version's variable map, so the base asks rather than assumes.
   */
  protected abstract get randomNumberVariable(): number;

  /**
   * The inline string that follows an instruction, as this version reads it.
   *
   * The one part of an array assignment that is *not* shared. Both versions put
   * a string in the code stream after the opcode, and they measure it
   * differently — v6 decodes embedded control codes, v7's are a bundle tag and
   * a fallback. So the instruction is shared and the measuring is not, which is
   * also why the disassembler has to agree with whichever runs: a reader that
   * measured it differently would re-emit an edited script this engine then
   * read as something else.
   */
  protected abstract fetchInlineText(): string;

  /**
   * The inline message an instruction speaks, and any recording of it.
   *
   * The one part of the talk and print family that is *not* shared. Both
   * versions put a message in the code stream and they mean different things
   * by it: v6's carries embedded control codes and a byte offset into
   * `MONSTER.SOU`, and v7's is a tag naming a line in the language bundle with
   * a fallback beside it, whose recording is found by cue name in a `.BUN`
   * rather than by offset. Everything around it — the slots, the sub-opcodes,
   * which form takes an actor — is one implementation.
   */
  protected abstract fetchSpokenMessage(): {
    text: string;
    speechOffset: number;
    speechSize: number;
  };

  /**
   * The `print` family's four text slots, and the defaults each remembers.
   *
   * A script configures a slot with one instruction and prints to it with
   * another, several instructions later — `printLine.begin()`, then a colour,
   * then a position, then the text — so the settings have to survive between
   * them. `begin` restores the defaults and `end` saves them, which is how a
   * game sets up a caption style once and reuses it.
   */
  protected readonly textSlots: TextOptions[] = [];

  protected readonly textDefaults: TextOptions[] = [];

  /** Actor the next printed line speaks as, or `NARRATOR` for a caption. */
  protected actorToPrintFor = NARRATOR;

  /** Says the message that follows, as an actor. */
  protected talk(actorNumber: number): void {
    const message = this.fetchSpokenMessage();
    this.engine.showText({
      ...this.textDefaults[TEXT_SLOT.Speech],
      actor: actorNumber,
      text: message.text,
      speechOffset: message.speechOffset,
      speechSize: message.speechSize,
    });
  }

  /**
   * One sub-opcode of the `print` family.
   *
   * Exactly one, which is the whole difference from v5: v5's `print` reads an
   * 0xFF-terminated stream of sub-opcodes in a single instruction, and v6's
   * reads one per instruction and keeps the settings between them. A loop here
   * would swallow the instructions that follow.
   *
   * `takesActor` distinguishes the forms that speak for somebody — `printActor`
   * and `printEgo` — from the ones that do not, because only those pop an actor
   * number at `begin`.
   */
  protected decodeParseString(slotIndex: number, takesActor: boolean): void {
    const options = this.textSlots[slotIndex];
    const subOp = this.fetchByte();

    switch (subOp) {
      case STRING_OP.At:
        options.y = this.pop();
        options.x = this.pop();
        options.hasPosition = true;
        options.overhead = false;
        break;
      case STRING_OP.Color:
        options.color = this.pop();
        break;
      case STRING_OP.Clipped:
        options.right = this.pop();
        break;
      case STRING_OP.Center:
        options.center = true;
        options.overhead = false;
        break;
      case STRING_OP.Left:
        options.center = false;
        options.left = true;
        options.overhead = false;
        break;
      case STRING_OP.Overhead:
        options.overhead = true;
        break;
      case STRING_OP.Mumble:
        // The line is shown without the speaker's talk animation running.
        // Nothing here animates on a printed line anyway, so it only has to
        // consume its (absent) operands and not be reported as unknown.
        break;
      case STRING_OP.TextString: {
        const message = this.fetchSpokenMessage();
        // The debug channel is not the screen. `printDebug` is what a script
        // uses to talk to whoever was building the game — "LEAVING verify
        // start sound" — and the original sends it to the interpreter's own
        // debug output. Drawing it put the game's development notes across the
        // picture, and Day of the Tentacle's scripts are full of them.
        if (slotIndex === TEXT_SLOT.Debug) {
          // Only while tracing: a game prints these constantly, and a log that
          // repeats them buries the lines a person is reading it for.
          if (this.engine.traceScripts && message.text.trim() !== '') {
            this.engine.trace(`script debug: ${message.text}`);
          }
          break;
        }
        this.engine.showText({
          ...options,
          actor: this.actorToPrintFor,
          text: message.text,
          speechOffset: message.speechOffset,
          speechSize: message.speechSize,
        });
        break;
      }
      case STRING_OP.BaseOp:
        Object.assign(options, this.textDefaults[slotIndex]);
        if (takesActor) this.actorToPrintFor = this.pop();
        break;
      case STRING_OP.End:
        this.textDefaults[slotIndex] = { ...options };
        break;
      default:
        // `parseString` reads a message out of the code for one sub-opcode
        // and pops the rest off the stack, so an unidentified one could be
        // either and the report says so rather than picking.
        this.reportUnknownSubOpcode('parseString', subOp, 'unclear');
        break;
    }
  }

  /**
   * The actor and verb the sub-opcode instructions apply to.
   *
   * v6 splits what v5 did in one instruction across many: `actorOps` selects an
   * actor once and then a run of instructions each set one of its properties.
   * So the selection outlives the instruction that made it.
   */
  protected currentActor = 0;

  protected currentVerb = 0;

  /**
   * The instructions v6 and v7 read the same way.
   *
   * v6 and v7 are one encoding — ScummVM gives v7 no opcode table of its own
   * and expresses the difference as version branches inside shared handlers —
   * so the great majority of the instruction set is one implementation, and it
   * belongs here rather than being transcribed a second time. ADR 0006 put a
   * base beneath both versions for exactly this.
   *
   * Installed *before* a version's own, so a version replaces a handler by
   * number rather than by this method knowing which versions differ. What is
   * deliberately absent, and installed per version instead:
   *
   * - **Sound and the camera**, which take different operands under v7.
   * - **`loadRoomWithEgo`, `stampObject`, `setBoxSet` and `resourceRoutines`**,
   *   which each behave differently under v7.
   * - **`wait` and the kernel hatch**, which answer differently.
   * - **Everything carrying an inline message** — talk and the print family —
   *   because measuring and decoding one is a version fact, and a reader that
   *   measured it differently would re-emit an edited script as something else.
   */
  /**
   * The room and object a pair of operands names, in that order on the stack.
   *
   * v6 pushes the room first and the object second, so the object comes off
   * the top. v7 dropped the room operand entirely and looks it up — which is
   * why this is worth naming rather than inlining as two pops.
   */
  protected popRoomAndObject(): { room: number; object: number } {
    const room = this.pop();
    return { room, object: this.pop() };
  }

  /**
   * `actorOps`: everything about one actor, one instruction at a time.
   *
   * The actor is *not* an operand of each instruction. Sub-opcode 197 sets it
   * and the rest apply to whichever was set last, so a script says "actor 3"
   * once and then follows it with a dozen instructions. That state has to
   * outlive the instruction, which is why it is a field.
   */
  protected actorOps(): void {
    const subOp = this.fetchByte();
    if (subOp === ACTOR_OP.Init) {
      this.currentActor = this.pop();
      return;
    }

    const actor = this.engine.getActor(this.currentActor);

    switch (subOp) {
      case ACTOR_OP.Costume: {
        const costume = this.pop();
        if (actor) this.engine.setActorCostume(actor, costume);
        break;
      }
      case ACTOR_OP.StepDist: {
        const speedY = this.pop();
        const speedX = this.pop();
        if (actor) {
          actor.speedX = speedX;
          actor.speedY = speedY;
        }
        break;
      }
      case ACTOR_OP.Sound: {
        const sounds = this.popList(8);
        if (actor) {
          actor.sounds.length = 0;
          actor.sounds.push(...sounds);
        }
        break;
      }
      case ACTOR_OP.WalkAnimation: {
        const frame = this.pop();
        if (actor) actor.walkFrame = frame;
        break;
      }
      case ACTOR_OP.TalkAnimation: {
        // Stop frame first: it is the one pushed last.
        const stop = this.pop();
        const start = this.pop();
        if (actor) {
          actor.talkStartFrame = start;
          actor.talkStopFrame = stop;
        }
        break;
      }
      case ACTOR_OP.StandAnimation: {
        const frame = this.pop();
        if (actor) actor.standFrame = frame;
        break;
      }
      case ACTOR_OP.Animation:
        // Three operands and no effect, in the original as well. They still
        // have to come off the stack.
        this.pop();
        this.pop();
        this.pop();
        break;
      case ACTOR_OP.Default:
        if (actor) this.engine.initActor(actor, 0);
        break;
      case ACTOR_OP.New:
        if (actor) this.engine.initActor(actor, 2);
        break;
      case ACTOR_OP.Elevation: {
        const elevation = this.pop();
        if (actor) {
          actor.elevation = elevation;
          actor.needRedraw = true;
        }
        break;
      }
      case ACTOR_OP.AnimationDefault:
        if (actor) {
          actor.initFrame = 1;
          actor.walkFrame = 2;
          actor.standFrame = 3;
          actor.talkStartFrame = 4;
          actor.talkStopFrame = 5;
        }
        break;
      case ACTOR_OP.Palette: {
        const color = this.pop();
        const index = this.pop();
        if (actor && index >= 0 && index < actor.palette.length) actor.palette[index] = color;
        break;
      }
      case ACTOR_OP.TalkColor: {
        const color = this.pop();
        if (actor) actor.talkColor = color;
        break;
      }
      case ACTOR_OP.Name: {
        // The name is inline, and is read whether or not the actor exists —
        // skipping it would leave its letters to be executed as instructions.
        const text = this.fetchInlineText();
        if (actor) actor.name = text;
        break;
      }
      case ACTOR_OP.InitAnimation: {
        const frame = this.pop();
        if (actor) actor.initFrame = frame;
        break;
      }
      case ACTOR_OP.Width: {
        const width = this.pop();
        if (actor) actor.width = width;
        break;
      }
      case ACTOR_OP.Scale: {
        // One operand for both axes, where v5 takes two.
        const scale = this.pop();
        if (actor) {
          actor.scaleX = scale;
          actor.scaleY = scale;
          actor.needRedraw = true;
        }
        break;
      }
      case ACTOR_OP.NeverZClip:
        // No operand: v6 splits v5's one instruction into "never" with none
        // and "always" with a value.
        if (actor) actor.forceClip = 0;
        break;
      case ACTOR_OP.AlwaysZClipFtDemo:
      case ACTOR_OP.AlwaysZClip: {
        const value = this.pop();
        if (actor) actor.forceClip = value;
        break;
      }
      case ACTOR_OP.IgnoreBoxes:
      case ACTOR_OP.FollowBoxes:
        if (actor) {
          actor.ignoreBoxes = subOp === ACTOR_OP.IgnoreBoxes;
          // v7 has no second "never clip" field, so where v6 clears the
          // override to fall back to the box, v7 writes the value that *means*
          // the box. Zero is a real plane number there.
          actor.forceClip = this.engine.scummVersion >= 7 ? V7_CLIP_FROM_BOX : 0;
          // Re-placing the actor recomputes its walk box, which is now either
          // required or irrelevant; without this it keeps the old one for ever.
          if (actor.isInCurrentRoom(this.engine.currentRoom)) {
            this.engine.putActor(actor.number, actor.x, actor.y);
          }
        }
        break;
      case ACTOR_OP.AnimationSpeed: {
        const speed = this.pop();
        if (actor) {
          actor.animSpeed = speed;
          actor.animProgress = speed;
        }
        break;
      }
      case ACTOR_OP.Shadow: {
        const mode = this.pop();
        if (actor) actor.shadowMode = mode;
        break;
      }
      case ACTOR_OP.TextOffset: {
        const y = this.pop();
        const x = this.pop();
        if (actor) {
          actor.talkPosX = x;
          actor.talkPosY = y;
        }
        break;
      }
      case ACTOR_OP.Variable: {
        const value = this.pop();
        const index = this.pop();
        if (actor && index >= 0 && index < actor.animVars.length) {
          actor.animVars[index] = value;
        }
        break;
      }
      case ACTOR_OP.IgnoreTurnsOn:
      case ACTOR_OP.IgnoreTurnsOff:
        if (actor) actor.ignoreTurns = subOp === ACTOR_OP.IgnoreTurnsOn;
        break;
      case ACTOR_OP.Depth: {
        const layer = this.pop();
        if (actor) actor.layer = layer;
        break;
      }
      case ACTOR_OP.WalkScript: {
        const script = this.pop();
        if (actor) actor.walkScript = script;
        break;
      }
      case ACTOR_OP.TalkScript: {
        const script = this.pop();
        if (actor) actor.talkScript = script;
        break;
      }
      case ACTOR_OP.Stop:
        if (actor) {
          actor.stopMoving();
          this.engine.startAnimActor(actor, actor.standFrame);
        }
        break;
      case ACTOR_OP.Face: {
        // Snaps to a direction rather than turning towards it, so the turn
        // flag has to be cleared or the actor keeps rotating afterwards.
        const direction = this.pop();
        if (actor) {
          actor.moving &= ~MF_TURN;
          this.engine.turnToDirection(actor, direction);
          this.engine.setActorDirection(actor, direction);
        }
        break;
      }
      case ACTOR_OP.Turn: {
        const direction = this.pop();
        if (actor) this.engine.turnToDirection(actor, direction);
        break;
      }
      case ACTOR_OP.WalkPause:
        if (actor) actor.moving |= MF_FROZEN;
        break;
      case ACTOR_OP.WalkResume:
        if (actor) actor.moving &= ~MF_FROZEN;
        break;
      default:
        // Every `actorOps` argument is pushed by a preceding instruction, so
        // the sub-opcode byte is the whole of what is read here and the code
        // after it is fine. What is left is a stack value nobody claimed.
        this.reportUnknownSubOpcode('actorOps', subOp, 'stack');
        break;
    }
  }

  /**
   * `verbOps`: one verb at a time, the same way `actorOps` takes one actor.
   *
   * Sub-opcode 196 selects the verb; 255 says the description is finished and
   * the panel should be redrawn.
   */
  protected verbOps(): void {
    const subOp = this.fetchByte();
    if (subOp === VERB_OP.Init) {
      this.currentVerb = this.pop();
      return;
    }

    const verbNumber = this.currentVerb;
    const verb = this.engine.verbs.getOrCreate(verbNumber);

    switch (subOp) {
      case VERB_OP.Image:
        verb.image = this.pop();
        verb.type = 'image';
        break;
      case VERB_OP.Name: {
        const text = this.fetchInlineText();
        verb.text = text;
        verb.type = 'text';
        // A game that writes its own sentence line owns it from here on.
        if (verbNumber === 0) this.engine.claimSentenceLine();
        break;
      }
      case VERB_OP.NameFromString: {
        // v6 has no string table apart from its arrays, and what the script
        // pushes is the array's handle rather than its variable number.
        const handle = this.pop();
        verb.text = this.arrays.readStringByHandle(handle);
        verb.type = 'text';
        if (verbNumber === 0) this.engine.claimSentenceLine();
        break;
      }
      case VERB_OP.Color:
        verb.color = this.pop();
        break;
      case VERB_OP.HiColor:
        verb.hiColor = this.pop();
        break;
      case VERB_OP.DimColor:
        verb.dimColor = this.pop();
        break;
      case VERB_OP.BackColor:
        verb.bakColor = this.pop();
        break;
      case VERB_OP.At:
        verb.y = this.pop();
        verb.x = this.pop();
        break;
      case VERB_OP.On:
        verb.enabled = true;
        break;
      case VERB_OP.Off:
        verb.enabled = false;
        break;
      case VERB_OP.Dim:
        verb.dim = true;
        break;
      case VERB_OP.Delete:
        this.engine.verbs.remove(verbNumber);
        break;
      case VERB_OP.New:
        this.engine.verbs.create(verbNumber, this.engine.currentCharsetId);
        break;
      case VERB_OP.Key:
        verb.key = this.pop();
        break;
      case VERB_OP.Center:
        verb.center = true;
        break;
      case VERB_OP.ImageInRoom: {
        const room = this.pop();
        const image = this.pop();
        verb.image = image;
        verb.imageRoom = room;
        verb.type = 'image';
        break;
      }
      case VERB_OP.End:
        this.engine.verbs.markDirty(verbNumber);
        break;
      default:
        this.reportUnknownSubOpcode('verbOps', subOp, 'unclear');
        break;
    }
  }

  /** `roomOps`: the camera bounds, the palette, and the screen itself. */
  protected roomOps(): void {
    const subOp = this.fetchByte();

    switch (subOp) {
      case ROOM_OP.Scroll: {
        // Clamped to half a screen from each edge, because the camera centre
        // cannot come closer than that without showing past the room.
        const max = this.pop();
        const min = this.pop();
        const roomWidth = this.engine.currentRoomData?.width ?? SCREEN_WIDTH;
        const half = SCREEN_WIDTH / 2;
        const clamp = (value: number) => Math.min(Math.max(value, half), roomWidth - half);
        this.engine.setCameraBounds(clamp(min), clamp(max));
        break;
      }
      case ROOM_OP.Screen: {
        const bottom = this.pop();
        this.engine.setScreenLayout(this.pop(), bottom);
        break;
      }
      case ROOM_OP.Palette: {
        const index = this.pop();
        const blue = this.pop();
        const green = this.pop();
        this.engine.setPaletteColor(index, this.pop(), green, blue);
        break;
      }
      case ROOM_OP.ShakeOn:
        this.engine.setShake(true);
        break;
      case ROOM_OP.ShakeOff:
        this.engine.setShake(false);
        break;
      case ROOM_OP.Intensity: {
        const end = this.pop();
        const start = this.pop();
        const scale = this.pop();
        this.engine.darkenPalette(scale, scale, scale, start, end);
        break;
      }
      case ROOM_OP.RgbIntensity: {
        const end = this.pop();
        const start = this.pop();
        const blue = this.pop();
        const green = this.pop();
        this.engine.darkenPalette(this.pop(), green, blue, start, end);
        break;
      }
      case ROOM_OP.Shadow: {
        const end = this.pop();
        const start = this.pop();
        const blue = this.pop();
        const green = this.pop();
        this.engine.setShadowPalette(this.pop(), green, blue, start, end);
        break;
      }
      case ROOM_OP.SaveGame: {
        const slot = this.pop();
        this.engine.scriptSaveLoad(this.pop(), slot);
        break;
      }
      case ROOM_OP.Fade: {
        // Zero means "fade in with whatever effect is already set", which is
        // what ends a room transition.
        this.engine.setScreenEffect(this.pop());
        break;
      }
      case ROOM_OP.Transform: {
        const d = this.pop();
        const c = this.pop();
        const b = this.pop();
        this.engine.palManipulate(this.pop(), b, c, d);
        break;
      }
      case ROOM_OP.CycleSpeed: {
        const delay = this.pop();
        this.engine.setCycleSpeed(this.pop(), delay);
        break;
      }
      case ROOM_OP.NewPalette:
        this.engine.setCurrentPalette(this.pop());
        break;
      case ROOM_OP.SaveString:
      case ROOM_OP.LoadString:
        // Unimplemented in the original too, and used by no v6 release. Named
        // rather than guessed at, because its operand count is not established.
        this.reportUnknownSubOpcode('roomOps', subOp, 'stack');
        break;
      default:
        this.reportUnknownSubOpcode('roomOps', subOp, 'stack');
        break;
    }
  }

  /**
   * `cursorCommand`: the pointer, and whether the player has control.
   *
   * The two variables written at the end are the ones scripts read to find out
   * what state they left these in — and they read them after *any* form of
   * this instruction, not only the ones that change them.
   */
  protected cursorCommand(): void {
    const subOp = this.fetchByte();

    switch (subOp) {
      case CURSOR_OP.On:
        this.engine.setCursorVisible(true);
        break;
      case CURSOR_OP.Off:
        this.engine.setCursorVisible(false);
        break;
      case CURSOR_OP.SoftOn:
        this.engine.setCursorVisible(true, true);
        break;
      case CURSOR_OP.SoftOff:
        this.engine.setCursorVisible(false, true);
        break;
      case CURSOR_OP.UserPutOn:
        this.engine.setUserPut(true);
        break;
      case CURSOR_OP.UserPutOff:
        this.engine.setUserPut(false);
        break;
      case CURSOR_OP.UserPutSoftOn:
        this.engine.setUserPut(true, true);
        break;
      case CURSOR_OP.UserPutSoftOff:
        this.engine.setUserPut(false, true);
        break;
      case CURSOR_OP.Image: {
        const { room, object } = this.popRoomAndObject();
        this.engine.setCursorFromObject(object, room);
        break;
      }
      case CURSOR_OP.Hotspot: {
        const y = this.pop();
        this.engine.setCursorHotspot(0, this.pop(), y);
        break;
      }
      case CURSOR_OP.CharsetSet:
        this.engine.setCharsetResource(this.pop());
        break;
      case CURSOR_OP.CharsetColor:
        this.engine.setCharsetColors(this.popList(16));
        break;
      case CURSOR_OP.Transparent:
        this.engine.setCursorTransparency(this.pop());
        break;
      default:
        this.reportUnknownSubOpcode('cursorCommand', subOp, 'stack');
        break;
    }

    this.engine.variables[this.engine.vars.CURSORSTATE] = this.engine.cursorState;
    this.engine.variables[this.engine.vars.USERPUT] = this.engine.userPut ? 1 : 0;
  }

  /**
   * `resourceRoutines`: load, lock and discard hints.
   *
   * Everything is resident, so most of these have nothing to do. The two that
   * matter are the ones that make something available before a later
   * instruction uses it.
   */
  protected resourceRoutines(): void {
    const subOp = this.fetchByte();

    switch (subOp) {
      case RESOURCE_OP.LoadScript:
      case RESOURCE_OP.NukeScript:
      case RESOURCE_OP.LockScript:
      case RESOURCE_OP.UnlockScript: {
        const script = this.pop();
        // v7 stops at the global script boundary: above it a number names a
        // *room* script, which lives in the room's own resource and is not
        // something the index can be asked for. v5 and v6 do reach for it, so
        // this is a version branch rather than a bounds check.
        if (this.engine.scummVersion >= 7 && script >= this.engine.numGlobalScripts) break;
        this.engine.ensureResource('script', script);
        break;
      }
      case RESOURCE_OP.LoadSound:
      case RESOURCE_OP.NukeSound:
      case RESOURCE_OP.LockSound:
      case RESOURCE_OP.UnlockSound:
        this.engine.ensureResource('sound', this.pop());
        break;
      case RESOURCE_OP.LoadCostume:
      case RESOURCE_OP.NukeCostume:
      case RESOURCE_OP.LockCostume:
      case RESOURCE_OP.UnlockCostume:
        this.engine.ensureResource('costume', this.pop());
        break;
      case RESOURCE_OP.LoadRoom:
      case RESOURCE_OP.NukeRoom:
      case RESOURCE_OP.LockRoom:
      case RESOURCE_OP.UnlockRoom:
        this.engine.ensureResource('room', this.pop());
        break;
      case RESOURCE_OP.LoadCharset:
      case RESOURCE_OP.NukeCharset:
        this.engine.setCharsetResource(this.pop());
        break;
      case RESOURCE_OP.ClearHeap:
        // A message to the memory manager. There is no heap to clear.
        break;
      case RESOURCE_OP.LoadObject: {
        const { room, object } = this.popRoomAndObject();
        this.engine.loadFloatingObject(object, room);
        break;
      }
      default:
        this.reportUnknownSubOpcode('resourceRoutines', subOp, 'stack');
        break;
    }
  }

  protected installStackSharedOpcodes(): void {
    const op = (code: number, handler: (this: this) => void) => {
      this.dispatch[code] = handler;
    };

    // The encoding-level instructions v6 and v7 share, installed from the base
    // (ADR 0006). v7 uses the same numbering for all of them, so they are
    // written once; what follows is v6's own.
    this.installStackCoreOpcodes();

    // --- delays ------------------------------------------------------------
    const delay = (code: number, scale: number, mask: number) =>
      op(code, function () {
        const slot = this.state.current;
        if (slot) {
          slot.delay = (this.pop() & mask) * scale;
          slot.delayed = true;
          slot.status = ScriptStatus.Paused;
          slot.offset = this.pc;
        }
        this.state.currentSlot = -1;
      });
    // Frames and minutes are read as 16-bit, seconds as 32-bit, which is what
    // decides whether a negative operand means "no wait" or "wait for ever".
    //
    // All three are counted in *sixtieths*, which is why a second is sixty and
    // a minute thirty-six hundred: `decreaseScriptDelay` is handed the length
    // of the cycle, not the number one.
    delay(0xb0, 1, 0xffff); // delay
    delay(0xb1, 60, 0xffffffff); // delaySeconds
    delay(0xb2, 3600, 0xffff); // delayMinutes

    // `delayFrames` is the odd one out and has its own counter in the original
    // (`ScriptSlot::delayFrameCount`), because it waits a number of *cycles*
    // rather than a length of time. Routed through the sixtieths above it
    // waited a sixtieth of the frames it was asked for once the cycle rate was
    // the game's — a wait of ten frames served in under two.
    //
    // The instruction re-reads itself: it decrements the counter and steps the
    // program counter back so the same opcode runs again next cycle, which is
    // how the original spends no stack on it.
    op(0xca, function () {
      const slot = this.state.current;
      if (!slot) {
        this.pop();
        return;
      }
      if (slot.delayFrameCount === 0) slot.delayFrameCount = this.pop() & 0xffff;
      else slot.delayFrameCount--;

      if (slot.delayFrameCount > 0) {
        // Back onto this instruction, then break, exactly as the original does.
        this.pc = this.instructionStart;
        slot.status = ScriptStatus.Paused;
        slot.offset = this.pc;
        this.state.currentSlot = -1;
      }
    });

    // --- objects -----------------------------------------------------------
    op(0x6f, function () {
      this.push(this.engine.getState(this.pop()));
    });
    op(0x70, function () {
      const state = this.pop();
      this.engine.putState(this.pop(), state);
    });
    op(0x71, function () {
      const owner = this.pop();
      this.engine.setOwnerOf(this.pop(), owner);
    });
    op(0x72, function () {
      this.push(this.engine.getOwner(this.pop()));
    });
    op(0x6d, function () {
      // Bit 7 of each entry says which way the test runs: set asks for the
      // class to hold, clear asks for it *not* to. Every entry must agree.
      const classes = this.popList(16);
      const object = this.pop();
      const holds = classes.every(
        (entry) => this.engine.getClass(object, entry & 0x7f) === ((entry & 0x80) !== 0),
      );
      this.push(holds ? 1 : 0);
    });
    op(0x6e, function () {
      // Bit 7 again, and a class of zero means "forget every class".
      const classes = this.popList(16);
      const object = this.pop();
      for (const entry of classes) {
        if ((entry & 0x7f) === 0) this.engine.clearClasses(object);
        else this.engine.putClass(object, entry & 0x7f, (entry & 0x80) !== 0);
      }
    });
    op(0x84, function () {
      const room = this.pop();
      this.engine.pickupObject(this.pop(), room);
    });
    op(0x8d, function () {
      this.push(this.engine.getObjectOrActorX(this.pop()));
    });
    op(0x8e, function () {
      this.push(this.engine.getObjectOrActorY(this.pop()));
    });
    op(0x92, function () {
      const index = this.pop();
      this.push(this.engine.findInventory(this.pop(), index));
    });
    op(0x93, function () {
      this.push(this.engine.getInventoryCount(this.pop()));
    });

    // --- actors ------------------------------------------------------------
    op(0x7e, function () {
      const y = this.pop();
      const x = this.pop();
      this.engine.startWalkActor(this.pop(), x, y, -1);
    });
    op(0x7f, function () {
      // Four operands, not three: v6 added the room, and 0xFF in it means
      // "wherever the actor already is". Reading only three left the room
      // number on the stack for the next instruction to consume as its own.
      const room = this.pop();
      const y = this.pop();
      const x = this.pop();
      const number = this.pop();
      // Room 0 is a room like any other here — it is how a script parks an
      // actor nowhere, and `putActorAtXY(actor, 0, 0, 0)` is the idiom for it
      // throughout Day of the Tentacle. Treating it as "leave the room alone"
      // meant the actor stayed in the room it was in: DOTT's walk helper
      // borrows actor 12 as a pathfinding stand-in and parks it in room 0 when
      // it is done, and every later caller waits for actor 12 to be free, so
      // one unparked stand-in deadlocked the intro.
      if (!isKeepRoom(room)) this.engine.putActorInRoom(number, room);
      this.engine.putActor(number, x, y);
    });
    op(0x81, function () {
      const target = this.pop();
      this.engine.faceActorTowards(this.pop(), target);
    });
    op(0x82, function () {
      const animation = this.pop();
      this.engine.animateActor(this.pop(), animation);
    });
    op(0x8c, function () {
      this.push(this.engine.getActor(this.pop())?.room ?? 0);
    });

    // --- rooms and camera --------------------------------------------------
    op(0x7b, function () {
      this.engine.startScene(this.pop(), null, 0);
    });

    // --- cutscenes ---------------------------------------------------------
    op(0x68, function () {
      this.engine.beginCutscene(this.popList());
    });
    op(0x67, function () {
      this.engine.endCutscene();
    });
    op(0x95, function () {
      // The resume point is the `jump` that follows, and this instruction
      // steps over it: the jump is the *skip* path, taken only when the
      // player asks to cut the scene short, and running it here plays the
      // whole scene's worth of nothing. Day of the Tentacle's driver script
      // is `beginOverride; jump past the intro`, so without the step the
      // intro was skipped before its first frame — and with it went every
      // room it loads, leaving the game on an empty screen with the verbs
      // drawn over it.
      this.engine.beginOverride(this.state.currentSlot, this.pc);
      this.pc += 3;
    });
    op(0x96, function () {
      this.engine.endOverride();
    });
    op(0x6a, function () {
      const flag = this.pop();
      if (flag !== 0) this.freezeScripts(flag);
      else this.thawAllScripts();
    });

    // --- sound -------------------------------------------------------------
    op(0x69, function () {
      this.engine.sound.stopAll();
    });
    op(0x98, function () {
      this.push(this.engine.sound.isSoundRunning(this.pop()) ? 1 : 0);
    });
    op(0xac, function () {
      // iMUSE. The sound-scope commands are acted on; the ones that need a live
      // sequencer are recorded and named once each.
      this.engine.sound.kludge(this.popList(16));
    });

    // --- numbers -----------------------------------------------------------
    op(0x87, function () {
      this.pushRandom(this.engine.random(this.pop()));
    });
    op(0x88, function () {
      const max = this.pop();
      const min = this.pop();
      this.pushRandom(min + this.engine.random(max - min));
    });
    op(0xad, function () {
      const list = this.popList(100);
      const value = this.pop();
      this.push(list.includes(value) ? 1 : 0);
    });
    op(0xcb, function () {
      const list = this.popList(100);
      const index = this.pop();
      this.push(list[index] ?? 0);
    });
    op(0xcc, function () {
      const fallback = this.pop();
      const list = this.popList(100);
      const index = this.pop();
      this.push(list[index] ?? fallback);
    });

    // --- speech ------------------------------------------------------------

    // --- sentence ----------------------------------------------------------
    op(0x83, function () {
      // Four operands, not three. The one between the two objects is unused —
      // in Sam & Max it is always 0 or 130 — but it is pushed, so leaving it
      // on the stack makes every instruction after this one read the wrong
      // operand.
      const objectB = this.pop();
      this.pop();
      const objectA = this.pop();
      this.engine.doSentence(this.pop(), objectA, objectB);
    });
    op(0xb3, function () {
      this.engine.stopSentence();
    });

    // --- arrays, continued -------------------------------------------------
    const arrayStep = (code: number, wide: boolean, by: number) =>
      op(code, function () {
        const variable = wide ? this.fetchWord() : this.fetchByte();
        const index = this.pop();
        this.writeArray(variable, index, this.readArray(variable, index) + by);
      });
    arrayStep(0x52, false, 1); // byteArrayInc
    arrayStep(0x53, true, 1); // wordArrayInc
    arrayStep(0x5a, false, -1); // byteArrayDec
    arrayStep(0x5b, true, -1); // wordArrayDec

    op(0xd4, function () {
      // `shuffle`, whose range is inclusive at both ends.
      const to = this.pop();
      const from = this.pop();
      this.arrays.shuffle(this.fetchWord(), from, to, (max) => this.engine.random(max));
    });

    op(0xe3, function () {
      // `pickVarRandom`: deal from a shuffled deck, reshuffling when it runs
      // out, so a line is never repeated until every other one has been used.
      // Element 0 is the deal position, which is why the values start at 1.
      const values = this.popList(100);
      const variable = this.fetchWord();

      if (!this.arrays.has(variable)) {
        this.defineArray(variable, 'int', 0, values.length);
        for (let i = 0; i < values.length; i++) this.writeArray(variable, i + 1, values[i]);
        this.arrays.shuffle(variable, 1, values.length, (max) => this.engine.random(max));
        this.writeArray(variable, 0, 2);
        this.push(this.readArray(variable, 1));
        return;
      }

      let next = this.readArray(variable, 0);
      const length = (this.arrays.get(variable)?.dim1 ?? 1) - 1;

      if (length < next) {
        // The deck is exhausted. Reshuffle, and avoid dealing the card that
        // was just played twice in a row.
        const lastPlayed = this.readArray(variable, next - 1);
        this.arrays.shuffle(variable, 1, length, (max) => this.engine.random(max));
        next = this.readArray(variable, 1) === lastPlayed ? 2 : 1;
      }

      this.writeArray(variable, 0, next + 1);
      this.push(this.readArray(variable, next));
    });

    op(0xdd, function () {
      // `findAllObjects`: the room's object numbers, in array variable 0 with
      // the count in element 0. The handle is pushed, not the array.
      const room = this.pop();
      const objects = this.engine.currentRoomData?.objects ?? [];
      if (room !== this.engine.currentRoom) {
        this.engine.warn(
          `Script asked for every object in room ${room} while room ` +
            `${this.engine.currentRoom} is loaded. Only the loaded room's objects can be ` +
            `listed, so the list is empty.`,
        );
      }

      const found = room === this.engine.currentRoom ? objects : [];
      this.defineArray(0, 'int', 0, found.length + 1);
      this.writeArray(0, 0, found.length);
      for (let i = 0; i < found.length; i++) this.writeArray(0, i + 1, found[i].id);
      this.push(this.readVar(0));
    });

    // --- objects, continued ------------------------------------------------
    op(0x60, function () {
      const args = this.popList();
      const entry = this.pop();
      const script = this.pop();
      const flags = this.pop();
      this.runObjectScript(script, entry, (flags & 1) !== 0, (flags & 2) !== 0, args);
    });
    op(0xbe, function () {
      // `startObjectQuick`: always recursive, never freeze-resistant.
      const args = this.popList();
      const entry = this.pop();
      this.runObjectScript(this.pop(), entry, false, true, args);
    });
    op(0x77, function () {
      this.stopObjectScript(this.pop());
    });
    op(0x61, function () {
      // State 0 means "as it is", which is state 1 for a drawn object.
      const state = this.pop();
      this.engine.drawObject(this.pop(), state === 0 ? 1 : state);
    });
    op(0x62, function () {
      const y = this.pop();
      const x = this.pop();
      const object = this.pop();
      this.engine.setObjectPosition(object, x, y);
      this.engine.drawObject(object, 1);
    });
    op(0x63, function () {
      // `drawBlastObject`: drawn straight to the screen for one frame. The
      // list is the original's too — it reads one and uses none.
      this.popList(16);
      const height = this.pop();
      const width = this.pop();
      const y = this.pop();
      const x = this.pop();
      // This form fixes the rest: full scale, the object's first image, and no
      // shadow. Only the kernel call lets a script choose them.
      this.engine.enqueueBlastObject(this.pop(), x, y, width, height, 255, 255, 1, 0);
    });
    op(0x64, function () {
      // `setBlastObjectWindow`. The original ignores its four operands too:
      // the window it would set is the whole screen.
      this.pop();
      this.pop();
      this.pop();
      this.pop();
    });
    op(0x97, function () {
      const object = this.pop();
      this.engine.setObjectName(object, this.fetchInlineText());
    });
    op(0xa0, function () {
      const y = this.pop();
      this.push(this.engine.findObjectAt(this.pop(), y));
    });
    op(0x8f, function () {
      this.push(this.engine.getObjectDirection(this.pop()));
    });
    op(0xed, function () {
      this.push(this.engine.getObjectDirection(this.pop()));
    });

    // --- actors, continued -------------------------------------------------
    op(0x7d, function () {
      const distance = this.pop();
      const object = this.pop();
      const actor = this.pop();
      if (object < this.engine.actors.length) {
        this.engine.walkActorToActor(actor, object, distance);
      } else {
        this.engine.walkActorToObject(actor, object);
      }
    });
    op(0x80, function () {
      const { room, object } = this.popRoomAndObject();
      const actor = this.pop();
      this.engine.putActorAtObject(actor, object);
      // 0xFF means "wherever the actor already is", which is the common case:
      // the object is in the room and the actor is not being moved out of it.
      if (!isKeepRoom(room)) this.engine.putActorInRoom(actor, room);
    });
    const actorGetter = (code: number, read: (actor: Actor | null) => number) =>
      op(code, function () {
        this.push(read(this.engine.getActor(this.pop())));
      });
    actorGetter(0x8a, (actor) => actor?.moving ?? 0);
    actorGetter(0x90, (actor) => (!actor || actor.ignoreBoxes ? 0 : actor.walkbox));
    actorGetter(0x91, (actor) => actor?.costume ?? 0);
    actorGetter(0xa2, (actor) => actor?.elevation ?? 0);
    actorGetter(0xa8, (actor) => actor?.width ?? 0);
    actorGetter(0xaa, (actor) => actor?.scaleX ?? 255);
    actorGetter(0xab, (actor) => actor?.cost.animCounter ?? 0);
    actorGetter(0xec, (actor) => actor?.layer ?? 0);
    op(0x9f, function () {
      const y = this.pop();
      this.push(this.engine.actorFromPos(this.pop(), y));
    });
    op(0xaf, function () {
      const box = this.pop();
      const actor = this.engine.getActor(this.pop());
      this.push(actor && this.engine.isPointInBox(box, actor.x, actor.y) ? 1 : 0);
    });
    op(0xd2, function () {
      const index = this.pop();
      const actor = this.engine.getActor(this.pop());
      this.push(actor && index >= 0 && index < actor.animVars.length ? actor.animVars[index] : 0);
    });
    op(0xd1, function () {
      this.engine.stopTalk();
    });
    op(0x9d, function () {
      this.actorOps();
    });

    // --- verbs -------------------------------------------------------------
    op(0x9e, function () {
      this.verbOps();
    });
    op(0x94, function () {
      const y = this.pop();
      this.push(this.engine.verbs.hitTest(this.pop(), y));
    });
    op(0xa3, function () {
      const entry = this.pop();
      this.push(this.engine.getVerbEntrypoint(this.pop(), entry));
    });
    op(0xa5, function () {
      // The range and save id come off the stack *before* the sub-opcode is
      // read, which is the reverse of every other sub-opcode instruction.
      const saveId = this.pop();
      const to = this.pop();
      const from = this.pop();
      const subOp = this.fetchByte();

      switch (subOp) {
        case SAVE_VERBS_OP.Save:
          this.engine.verbs.saveRange(from, to, saveId);
          break;
        case SAVE_VERBS_OP.Restore:
          this.engine.verbs.restoreRange(from, to, saveId);
          break;
        case SAVE_VERBS_OP.Delete:
          this.engine.verbs.deleteRange(from, to, saveId);
          break;
        default:
          this.reportUnknownSubOpcode('saveRestoreVerbs', subOp, 'stack');
          break;
      }
    });

    // --- rooms, boxes and resources ---------------------------------------
    // --- talk and the print family -----------------------------------------
    //
    // Shared, with only the message reading left to the version. The slots,
    // the sub-opcodes and which forms take an actor are the same in both.
    op(0xba, function () {
      this.talk(this.pop());
    });
    op(0xbb, function () {
      // `talkEgo`: the player's actor, whichever that currently is.
      this.talk(this.engine.variables[this.engine.vars.EGO]);
    });
    op(0xb4, function () {
      // `printLine`: a caption with no speaker.
      this.actorToPrintFor = NARRATOR;
      this.decodeParseString(TEXT_SLOT.Speech, false);
    });
    op(0xb5, function () {
      this.decodeParseString(TEXT_SLOT.Painted, false);
    });
    op(0xb6, function () {
      this.decodeParseString(TEXT_SLOT.Debug, false);
    });
    op(0xb7, function () {
      this.decodeParseString(TEXT_SLOT.System, false);
    });
    op(0xb8, function () {
      this.decodeParseString(TEXT_SLOT.Speech, true);
    });
    op(0xb9, function () {
      this.push(this.engine.variables[this.engine.vars.EGO]);
      this.decodeParseString(TEXT_SLOT.Speech, true);
    });

    op(0x9c, function () {
      this.roomOps();
    });
    op(0x9b, function () {
      this.resourceRoutines();
    });
    op(0x99, function () {
      // The flag value is on top, above the list of boxes it applies to.
      const value = this.pop();
      for (const box of this.popList(65)) this.engine.setBoxFlags(box, value);
    });
    op(0x9a, function () {
      // `createBoxMatrix`. The Dig also puts every actor back on a valid box
      // afterwards, and Full Throttle does not — so this is one of the few
      // places the two v7 games disagree with each other rather than with v6.
      //
      // A rebuilt matrix changes where walking is allowed, and an actor left
      // standing where only the previous one permitted has no valid box to
      // walk from: every walk request from that position fails, silently, for
      // the rest of the scene. The same fault `setBoxSet` had.
      this.engine.rebuildBoxMatrix();
      if (this.engine.replacesActorsOnRebuild) this.engine.putActorsOnValidBoxes();
    });
    op(0xa1, function () {
      const rooms = this.popList(100);
      const value = this.pop();
      for (const room of rooms) {
        if (room > 0x7f) this.engine.setPseudoRoom(room & 0x7f, value);
      }
    });
    op(0xa6, function () {
      const color = this.pop();
      const y2 = this.pop();
      const x2 = this.pop();
      const y = this.pop();
      this.engine.drawBox(this.pop(), y, x2, y2, color);
    });

    // --- cursor, system and waiting ---------------------------------------
    op(0x6b, function () {
      this.cursorCommand();
    });
    op(0xae, function () {
      const subOp = this.fetchByte();
      switch (subOp) {
        case SYSTEM_OP.Restart:
          this.engine.restart();
          break;
        case SYSTEM_OP.Pause:
          this.engine.pauseGame();
          break;
        case SYSTEM_OP.Quit:
          this.engine.quitGame();
          break;
        default:
          this.reportUnknownSubOpcode('systemOps', subOp, 'unclear');
          break;
      }
    });

    // --- printing ----------------------------------------------------------

    // --- distances and the clock ------------------------------------------
    op(0xc5, function () {
      const b = this.pop();
      this.push(this.engine.getObjectOrActorDistance(this.pop(), b));
    });
    op(0xc6, function () {
      const y = this.pop();
      const x = this.pop();
      this.push(this.engine.getDistanceToPoint(this.pop(), x, y));
    });
    op(0xc7, function () {
      const y2 = this.pop();
      const x2 = this.pop();
      const y1 = this.pop();
      this.push(this.engine.distanceBetweenPoints(this.pop(), y1, x2, y2));
    });
    op(0xd0, function () {
      // The wall clock, which Sam & Max reads for its screensaver timeout and
      // DOTT for nothing at all. Seconds are v8's; neither v6 nor v7 has a slot
      // for them. The slots themselves move between versions — 119 and 125-129
      // for v6, 16-21 for v7 — so they come from the running version's table.
      const now = new Date();
      const variables = this.engine.variables;
      variables[this.engine.vars.TIMEDATE_YEAR] = now.getFullYear() - 1900;
      variables[this.engine.vars.TIMEDATE_MONTH] = now.getMonth();
      variables[this.engine.vars.TIMEDATE_DAY] = now.getDate();
      variables[this.engine.vars.TIMEDATE_HOUR] = now.getHours();
      variables[this.engine.vars.TIMEDATE_MINUTE] = now.getMinutes();
    });

    // --- scripts, continued ------------------------------------------------
    op(0xd5, function () {
      // `jumpToScript`: end this script and start another in its place. The
      // slot is freed before the new script looks for one, as the original
      // does, so a game that chains through scripts does not exhaust them.
      const args = this.popList();
      const script = this.pop();
      const flags = this.pop();
      const slot = this.state.current;
      if (slot) slot.reset();
      this.state.currentSlot = -1;
      this.runScript(script, (flags & 1) !== 0, (flags & 2) !== 0, args);
      throw new ScriptStopped();
    });
    op(0xd8, function () {
      this.push(this.isRoomScriptRunning(this.pop()) ? 1 : 0);
    });

    // --- the kernel hatch --------------------------------------------------
    op(0xe1, function () {
      const y = this.pop();
      this.push(this.engine.getScreenPixel(this.pop(), y));
    });
  }

  /** Script arrays, by the variable number that addresses them. */
  protected get arrays() {
    return this.state.arrays;
  }

  /** Creates the arrays the index declared, before any script runs. */
  seedDeclaredArrays(): void {
    for (const declaration of this.engine.resources.arrayDeclarations) {
      this.defineArray(declaration.variable, declaration.kind, declaration.dim2, declaration.dim1);
    }
  }

  // ------------------------------------------------------------- variables --

  /**
   * Reads a SCUMM variable.
   *
   * Three address spaces — globals, bit variables, script locals — and no
   * indexed form, which arrays replaced.
   */
  readVar(variable: number): number {
    const index = variable;

    if (!(index & VAR_SPACE)) return this.engine.variables[index] ?? 0;

    if (index & VAR_BIT) {
      const bit = index & 0x7fff;
      return (this.engine.bitVariables[bit >> 3] >> (bit & 7)) & 1;
    }
    if (index & VAR_LOCAL) {
      const slot = this.state.current;
      return slot ? slot.locals[index & 0xfff] : 0;
    }
    return 0;
  }

  writeVar(variable: number, value: number): void {
    const index = variable;

    if (!(index & VAR_SPACE)) {
      if (index >= 0 && index < this.engine.variables.length) {
        this.engine.variables[index] = value;
      }
      return;
    }
    if (index & VAR_BIT) {
      const bit = index & 0x7fff;
      const byte = bit >> 3;
      const mask = 1 << (bit & 7);
      if (value) this.engine.bitVariables[byte] |= mask;
      else this.engine.bitVariables[byte] &= ~mask;
      if (this.engine.watchedBits.size > 0) {
        this.engine.reportBitWrite(bit, value ? 1 : 0, this.state.current?.number);
      }
      return;
    }
    if (index & VAR_LOCAL) {
      const local = index & 0xfff;
      const slot = this.state.current;
      if (slot && local < slot.locals.length) slot.locals[local] = value;
    }
  }

  // ----------------------------------------------------------------- code --

  /**
   * Reads the next code byte, or 0 once the script's code is exhausted.
   *
   * Bounded for the same reason v5's is: a drifted program counter otherwise
   * reads `undefined`, and any loop waiting for a terminator never sees one.
   * Recording the overrun ends the script with a report instead.
   */
  protected fetchByte(): number {
    const code = this.code;
    if (!code || this.pc < 0 || this.pc >= code.length) {
      this.codeOverrun = true;
      this.pc = code ? code.length : 0;
      return 0;
    }
    return code[this.pc++];
  }

  protected fetchWord(): number {
    return this.fetchByte() | (this.fetchByte() << 8);
  }

  protected fetchWordSigned(): number {
    const value = this.fetchWord();
    return value & 0x8000 ? value - 0x10000 : value;
  }

  // ---------------------------------------------------------------- stack --

  protected push(value: number): void {
    this.stack.push(value | 0);
  }

  /**
   * Pops a value, or 0 on an empty stack.
   *
   * An empty stack means the script was decoded wrongly — a real one always
   * pushes before it consumes. Reporting it and continuing with 0 keeps the
   * failure attributable to the script and offset that caused it.
   */
  protected pop(): number {
    if (this.stack.length === 0) {
      this.engine.warn(
        `A stack-machine instruction read an operand from an empty stack in script ` +
          `${this.state.current?.number ?? -1} at offset ${this.pc}. The script was ` +
          `decoded wrongly at some earlier instruction.`,
      );
      return 0;
    }
    return this.stack.pop() as number;
  }

  /**
   * Pushes a random number and leaves it where scripts look for it.
   *
   * v6 added a variable holding the last random number drawn, and its scripts
   * read that instead of the pushed value more often than not — a dialogue
   * picker draws once and then tests the variable several times.
   */
  protected pushRandom(value: number): void {
    this.engine.variables[this.randomNumberVariable] = value;
    this.push(value);
  }

  /** A counted argument list, pushed count-last, as `startScript` takes. */
  protected popList(limit = 25): number[] {
    const count = Math.min(this.pop(), limit);
    const args = new Array<number>(Math.max(count, 0));
    for (let i = count - 1; i >= 0; i--) args[i] = this.pop();
    return args;
  }

  // --------------------------------------------------------------- arrays --

  protected defineArray(
    variable: number,
    kind: DeclaredArrayKind,
    dim2: number,
    dim1: number,
  ): void {
    this.arrays.define(variable, kind, dim2, dim1);
  }

  protected readArray(variable: number, index: number, row = 0): number {
    return this.arrays.read(variable, index, row);
  }

  protected writeArray(variable: number, index: number, value: number, row = 0): void {
    this.arrays.write(variable, index, value, row);
  }

  // ------------------------------------------------------------ scheduling --

  runScript(script: number, freezeResistant: boolean, recursive: boolean, args: number[]): void {
    if (this.engine.traceScripts) this.engine.trace(`script ${script} started`);
    if (script === 0) return;
    if (!recursive) this.stopScript(script);

    let where: ObjectWhere;
    let data: Uint8Array | null;
    let base: number;

    if (script < this.engine.numGlobalScripts) {
      const resource = this.engine.resources.getScript(script);
      if (!resource) {
        this.reportMissingScript(script, 'global');
        return;
      }
      where = ObjectWhere.Global;
      data = resource;
      base = 8; // past the SCRP chunk header
    } else {
      const local = this.engine.currentRoomData?.scripts.local.get(script);
      if (!local || !this.engine.currentRoomData) {
        this.reportMissingScript(script, 'local');
        return;
      }
      where = ObjectWhere.Local;
      // v8 keeps a room's local scripts in its `RMSC` block rather than in
      // `ROOM`, and `scriptData` is that block where there is one.
      data = this.engine.currentRoomData.scriptData;
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

    for (let i = 0; i < args.length && i < slot.locals.length; i++) slot.locals[i] = args[i];

    this.runScriptNested(index);
  }

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
    this.runScriptNested(index);
  }

  /**
   * Runs a slot to its next yield, then restores whoever was running.
   *
   * A script that starts another does not lose its turn: the original runs the
   * new one to completion or to its first `breakHere`, then carries on. Decode
   * state is saved with the slot index, or the caller resumes reading from the
   * callee's program counter — and the operand stack is truncated back, or a
   * script that stopped mid-expression leaves its operands for the caller to
   * pop as its own.
   */
  protected runScriptNested(index: number): void {
    const previousSlot = this.state.currentSlot;
    const previousPc = this.pc;
    const previousCode = this.code;
    const stackDepth = this.stack.length;

    this.state.currentSlot = index;
    try {
      this.executeSlot();
    } catch (error) {
      if (!(error instanceof ScriptStopped)) throw error;
    } finally {
      this.state.currentSlot = previousSlot;
      this.pc = previousPc;
      this.code = previousCode;
      this.stack.length = Math.min(this.stack.length, stackDepth);
    }
  }

  /** Runs the current slot until it yields, ends, or runs out of budget. */
  protected executeSlot(): void {
    const slot = this.state.current;
    if (!slot) return;

    const myIndex = this.state.currentSlot;
    // What this slot is running, so a nested instruction that recycles it for
    // another script can be recognised rather than followed.
    const myNumber = slot.number;
    const myBase = slot.base;
    const myData = slot.data;
    this.code = slot.data;
    this.pc = slot.offset;
    slot.didExec = true;

    let executed = 0;

    while (slot.status === ScriptStatus.Running && this.state.currentSlot !== -1) {
      if (++executed > StackScriptEngine.OPCODES_PER_EXECUTION) {
        this.engine.reportRunawayScript(slot.number, this.pc, executed);
        slot.reset();
        this.state.currentSlot = -1;
        return;
      }
      if (--this.budgetRemaining <= 0) {
        this.engine.reportScriptBudgetExhausted(StackScriptEngine.OPCODES_PER_ENTRY);
        slot.offset = this.pc;
        return;
      }

      const opcodeOffset = this.pc;
      // Where the instruction being run begins, for the one instruction that
      // re-runs itself: `delayFrames` counts down across cycles and steps the
      // counter back onto its own opcode rather than pushing anything.
      this.instructionStart = opcodeOffset;
      this.opcode = this.fetchByte();
      this.recordTrail(opcodeOffset, this.opcode);
      const handler = this.dispatch[this.opcode];

      if (!handler) {
        // Not skippable: operands come off the stack, so an instruction of
        // unknown length misaligns everything after it.
        this.engine.reportUnknownOpcode(
          this.opcode,
          slot.number,
          opcodeOffset,
          this.describeTrail(),
        );
        slot.reset();
        this.state.currentSlot = -1;
        return;
      }

      handler.call(this);

      // The slot may no longer be this script. An instruction can stop the
      // script it is in and hand the slot straight to another — `startObject`
      // on the object whose own verb script is running does exactly that, and
      // so does a room change under a local script. The original survives it
      // because its program counter lives beside the interpreter rather than
      // in the slot; here the slot *is* where the counter is kept, so once the
      // slot belongs to somebody else there is nothing of this script left to
      // resume, and carrying on would read the new script's bytes as this
      // one's. Ending here is what the original's `_currentScript` going away
      // amounts to.
      if (slot.number !== myNumber || slot.base !== myBase || slot.data !== myData) return;

      // Only while this slot still owns the decoder. `pc` is shared decode
      // state, so an instruction that ended this script, yielded, or changed
      // room under it has left `pc` describing somebody else's code — and
      // whichever slot that is has already stored its own resume point.
      // Writing it back unconditionally put a foreign program counter into a
      // live slot, which then resumed in the middle of another script's bytes:
      // the symptom is an unknown opcode or an empty operand stack at an offset
      // with no relation to the script named, several rooms away from the cause.
      if (this.state.currentSlot === myIndex) slot.offset = this.pc;

      if (this.codeOverrun) {
        this.engine.reportScriptOverrun(slot.number, this.pc, this.describeTrail());
        slot.reset();
        this.state.currentSlot = -1;
        this.codeOverrun = false;
        return;
      }
    }
  }

  runAllScripts(): void {
    this.budgetRemaining = StackScriptEngine.OPCODES_PER_ENTRY;
    for (const slot of this.state.slots) slot.didExec = false;

    for (let i = 0; i < this.state.slots.length; i++) {
      const slot = this.state.slots[i];
      if (slot.status !== ScriptStatus.Running || slot.didExec) continue;
      if (slot.freezeCount > 0) continue;

      this.state.currentSlot = i;
      this.stack.length = 0;
      try {
        this.executeSlot();
      } catch (error) {
        if (!(error instanceof ScriptStopped)) throw error;
      }
      this.state.currentSlot = -1;
    }
  }

  /**
   * Runs an object's verb script, the way `runScript` runs a global one.
   *
   * The difference is where the code is found: an object script is addressed by
   * object number and verb entry, and its bytes live inside whichever resource
   * currently holds the object.
   */
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

    for (let i = 0; i < args.length && i < slot.locals.length; i++) slot.locals[i] = args[i];

    this.runScriptNested(index);
  }

  /** Yields to the frame loop, resuming at the current program counter. */
  protected breakHere(): void {
    const slot = this.state.current;
    if (slot) {
      slot.offset = this.pc;
      slot.status = ScriptStatus.Running;
    }
    this.state.currentSlot = -1;
  }

  /** Ends the running script from inside an instruction. */
  protected stopObjectCode(): void {
    const slot = this.state.current;
    if (slot) slot.reset();
    this.state.currentSlot = -1;
    throw new ScriptStopped();
  }

  /** Names a sub-opcode with no handler, against the running script. */
  protected reportUnknownSubOpcode(
    instruction: string,
    subOpcode: number,
    effect: SubOpcodeEffect,
  ): void {
    this.engine.reportUnknownSubOpcode(
      instruction,
      subOpcode,
      this.state.current?.number ?? -1,
      this.pc,
      effect,
      '',
      this.describeTrail(),
    );
  }

  // ------------------------------------------------------------------ trail --

  private recordTrail(offset: number, opcode: number): void {
    this.trail[this.trailNext % this.trail.length] = ((offset & 0xffffff) << 8) | (opcode & 0xff);
    this.trailNext++;
  }

  /** The recent instructions as "offset:opcode", oldest first. */
  protected describeTrail(): string {
    const count = Math.min(this.trailNext, this.trail.length);
    const parts: string[] = [];
    for (let i = count; i >= 1; i--) {
      const value = this.trail[(this.trailNext - i) % this.trail.length];
      const offset = value >>> 8;
      const opcode = value & 0xff;
      parts.push(`${offset}:0x${opcode.toString(16).padStart(2, '0')}`);
    }
    return parts.join(' ');
  }

  // -------------------------------------------------------------- coverage --

  /** Opcodes with no handler, for the coverage report. */
  get unimplementedOpcodes(): number[] {
    const missing: number[] = [];
    for (let code = 0; code < this.dispatch.length; code++) {
      if (!this.dispatch[code]) missing.push(code);
    }
    return missing;
  }

  /** How many opcodes have handlers, for the coverage report. */
  get implementedOpcodes(): number {
    return this.dispatch.reduce((count, handler) => (handler ? count + 1 : count), 0);
  }

  // -------------------------------------------------------- shared opcodes --

  /**
   * The instructions v6 and v7 genuinely share, at the numbers both use.
   *
   * The encoding-level half of the opcode table: the stack itself, variable
   * reads and writes, array access, jumps and script control. ScummVM gives v7
   * no opcode table of its own — `ScummEngine_v7` inherits v6's `setupOpcodes`
   * and replaces a handler — so sharing these is not an inference about the two
   * versions, it is what the reference implementation does.
   *
   * What is deliberately *not* here is everything whose behaviour reaches into
   * the engine through a sub-opcode table: actors, verbs, printing, sound. The
   * numbering of those is per-version even where the instruction is not, and a
   * shared handler reading the wrong table is the kind of fault that surfaces
   * as something unrelated much later.
   *
   * Each version calls this from its own `installOpcodes`, before installing
   * its own, so a version that needs to replace one of these can.
   */
  protected installStackCoreOpcodes(): void {
    const op = (code: number, handler: (this: this) => void) => {
      this.dispatch[code] = handler;
    };

    op(0x00, function () {
      this.push(this.fetchByte());
    });

    op(0xbc, function () {
      // `dimArray`. One form destroys instead of creating, and it reads its
      // variable from the code stream rather than the stack, so the operand
      // order differs from every other form here.
      const subOp = this.fetchByte();
      if (subOp === UNDIM_ARRAY) {
        this.arrays.undefine(this.fetchWord());
        return;
      }
      const kind = ARRAY_KIND[subOp];
      if (!kind) {
        this.reportUnknownSubOpcode('dimArray', subOp, 'inline');
        return;
      }
      this.defineArray(this.fetchWord(), kind, 0, this.pop());
    });

    op(0xc0, function () {
      // `dim2dimArray`: rows and columns, popped columns-first.
      const subOp = this.fetchByte();
      const kind = ARRAY_KIND[subOp];
      if (!kind) {
        this.reportUnknownSubOpcode('dim2dimArray', subOp, 'inline');
        return;
      }
      const dim1 = this.pop();
      const dim2 = this.pop();
      this.defineArray(this.fetchWord(), kind, dim2, dim1);
    });

    op(0xa4, function () {
      const subOp = this.fetchByte();
      const array = this.fetchWord();

      switch (subOp) {
        case ARRAY_OP.AssignString: {
          // The string is inline, and its length decides the array's size, so
          // the array is defined after the text has been read rather than
          // before.
          const at = this.pop();
          const text = this.fetchInlineText();
          this.defineArray(array, 'string', 0, at + text.length + 1);
          this.arrays.writeString(array, at, text);
          break;
        }
        case ARRAY_OP.AssignIntList: {
          // Values arrive on the stack, last one on top, and are written back
          // to front for that reason.
          const at = this.pop();
          const count = this.pop();
          if (!this.arrays.has(array)) this.defineArray(array, 'int', 0, at + count);
          for (let i = count - 1; i >= 0; i--) this.writeArray(array, at + i, this.pop());
          break;
        }
        case ARRAY_OP.Assign2DimList: {
          const at = this.pop();
          const values = this.popList(128);
          if (!this.arrays.has(array)) {
            // The original treats this as fatal, and it is a real script bug:
            // a two-dimensional assignment cannot invent the row count.
            this.engine.warn(
              `Script ${this.state.current?.number ?? -1} assigned a list to row ` +
                `${at} of array ${array} without dimensioning it first, so nothing ` +
                `was stored.`,
            );
            this.pop();
            break;
          }
          const row = this.pop();
          for (let i = values.length - 1; i >= 0; i--) {
            this.writeArray(array, at + i, values[i], row);
          }
          break;
        }
        default:
          this.reportUnknownSubOpcode('arrayOps', subOp, 'unclear');
          break;
      }
    });

    op(0x01, function () {
      this.push(this.fetchWordSigned());
    });
    op(0x02, function () {
      this.push(this.readVar(this.fetchByte()));
    });
    op(0x03, function () {
      this.push(this.readVar(this.fetchWord()));
    });
    op(0x0c, function () {
      const value = this.pop();
      this.push(value);
      this.push(value);
    });
    op(0x0d, function () {
      this.push(this.pop() ? 0 : 1);
    });
    op(0x1a, function () {
      this.pop();
    });
    op(0xa7, function () {
      this.pop();
    });
    op(0xbd, function () {
      // `dummy`: a real instruction that does nothing, not a gap in the table.
    });

    // Binary operators, second operand on top.
    const binary = (code: number, apply: (a: number, b: number) => number) =>
      op(code, function () {
        const b = this.pop();
        const a = this.pop();
        this.push(apply(a, b));
      });

    binary(0x0e, (a, b) => (a === b ? 1 : 0));
    binary(0x0f, (a, b) => (a !== b ? 1 : 0));
    binary(0x10, (a, b) => (a > b ? 1 : 0));
    binary(0x11, (a, b) => (a < b ? 1 : 0));
    binary(0x12, (a, b) => (a <= b ? 1 : 0));
    binary(0x13, (a, b) => (a >= b ? 1 : 0));
    binary(0x14, (a, b) => a + b);
    binary(0x15, (a, b) => a - b);
    binary(0x16, (a, b) => a * b);
    // Division by zero is a script bug; yielding 0 keeps the game running, and
    // the original does not trap it either.
    binary(0x17, (a, b) => (b === 0 ? 0 : Math.trunc(a / b)));
    binary(0x18, (a, b) => (a && b ? 1 : 0));
    binary(0x19, (a, b) => (a || b ? 1 : 0));
    binary(0xd6, (a, b) => a & b);
    binary(0xd7, (a, b) => a | b);
    op(0xc4, function () {
      this.push(Math.abs(this.pop()));
    });

    // --- variables ---------------------------------------------------------
    op(0x42, function () {
      this.writeVar(this.fetchByte(), this.pop());
    });
    op(0x43, function () {
      this.writeVar(this.fetchWord(), this.pop());
    });
    op(0x4e, function () {
      const variable = this.fetchByte();
      this.writeVar(variable, this.readVar(variable) + 1);
    });
    op(0x4f, function () {
      const variable = this.fetchWord();
      this.writeVar(variable, this.readVar(variable) + 1);
    });
    op(0x56, function () {
      const variable = this.fetchByte();
      this.writeVar(variable, this.readVar(variable) - 1);
    });
    op(0x57, function () {
      const variable = this.fetchWord();
      this.writeVar(variable, this.readVar(variable) - 1);
    });

    // --- arrays ------------------------------------------------------------
    op(0x06, function () {
      const variable = this.fetchByte();
      this.push(this.readArray(variable, this.pop()));
    });
    op(0x07, function () {
      const variable = this.fetchWord();
      this.push(this.readArray(variable, this.pop()));
    });
    op(0x0a, function () {
      const variable = this.fetchByte();
      const index = this.pop();
      this.push(this.readArray(variable, index, this.pop()));
    });
    op(0x0b, function () {
      const variable = this.fetchWord();
      const index = this.pop();
      this.push(this.readArray(variable, index, this.pop()));
    });
    op(0x46, function () {
      const variable = this.fetchByte();
      const value = this.pop();
      this.writeArray(variable, this.pop(), value);
    });
    op(0x47, function () {
      const variable = this.fetchWord();
      const value = this.pop();
      this.writeArray(variable, this.pop(), value);
    });
    op(0x4a, function () {
      const variable = this.fetchByte();
      const value = this.pop();
      const index = this.pop();
      this.writeArray(variable, index, value, this.pop());
    });
    op(0x4b, function () {
      const variable = this.fetchWord();
      const value = this.pop();
      const index = this.pop();
      this.writeArray(variable, index, value, this.pop());
    });

    // --- flow --------------------------------------------------------------
    op(0x73, function () {
      // The displacement counts from the end of the instruction, so it has to
      // be fetched into a variable first. `this.pc += this.fetchWordSigned()`
      // reads `this.pc` *before* the fetch advances it, which lands two bytes
      // early — and two bytes early in a backward jump is the middle of the
      // instruction the loop starts with. Every loop in a real game missed.
      const displacement = this.fetchWordSigned();
      this.pc += displacement;
    });
    op(0x5c, function () {
      const offset = this.fetchWordSigned();
      if (this.pop()) this.pc += offset;
    });
    op(0x5d, function () {
      const offset = this.fetchWordSigned();
      if (!this.pop()) this.pc += offset;
    });
    op(0x65, function () {
      this.stopObjectCode();
    });
    op(0x66, function () {
      this.stopObjectCode();
    });
    op(0x6c, function () {
      // `breakHere`: yield to the frame loop, resuming at the next instruction.
      const slot = this.state.current;
      if (slot) {
        slot.offset = this.pc;
        slot.status = ScriptStatus.Running;
      }
      this.state.currentSlot = -1;
    });
    op(0x5e, function () {
      const args = this.popList();
      const script = this.pop();
      const flags = this.pop();
      this.runScript(script, (flags & 1) !== 0, (flags & 2) !== 0, args);
    });
    op(0x5f, function () {
      const args = this.popList();
      this.runScript(this.pop(), false, false, args);
    });
    op(0xbf, function () {
      const args = this.popList();
      this.runScript(this.pop(), false, false, args);
    });
    op(0x7c, function () {
      const script = this.pop();
      if (script === 0) this.stopObjectCode();
      else this.stopScript(script);
    });
    op(0x8b, function () {
      this.push(this.isScriptRunning(this.pop()) ? 1 : 0);
    });
  }
}
