import { VAR_V7 } from '../../constants.js';
import type { ScummEngine } from '../../ScummEngine.js';
import type { ScriptEngine as ScriptEngineInterface } from '../ScriptEngine.js';
import type { ScriptState } from '../ScriptState.js';
import { StackScriptEngine } from '../StackScriptEngine.js';
import { resolveLine } from './language.js';
import { measureV7Message, v7MessageFallback, v7MessageKey } from './message.js';

/**
 * v7's `wait` sub-opcodes.
 *
 * The numbering is v6's, but two of them mean something different: waiting for
 * an actor checks that the actor is in the *current room* as well as moving,
 * and waiting for the camera compares both axes rather than v6's eighth-of-a-
 * screen comparison on x alone. Named here rather than inlined for the reason
 * v6's are: a sub-opcode that consumes the wrong operands fails somewhere else.
 * (`ScummEngine_v6::o6_wait`, and its `_game.version >= 7` branches.)
 */
const WAIT_OP = {
  ForActor: 168,
  ForMessage: 169,
  ForCamera: 170,
  ForSentence: 171,
} as const;

/**
 * Where v7 stops treating a `stampObject` operand as an object number.
 *
 * Below this it is an actor. ScummVM's own constant, and it is a v7 fact rather
 * than a general one: v6 has no such overload.
 */
const V7_ACTOR_OBJECT_BOUNDARY = 30;

/**
 * v7's kernel sub-functions, which are **not** v6's numbers.
 *
 * ScummVM gives v7 its own `o6_kernelSetFunctions` rather than branching inside
 * v6's, and the numbering differs from the first entry: 6 plays a video in v7
 * and fades in for v6. So this is a table of its own, and the overlap at 107,
 * 108, 109 and 124 is a coincidence rather than a shared rule.
 *
 * From `ScummEngine_v7::o6_kernelSetFunctions`.
 */
const KERNEL_SET_V7 = {
  GrabCursor: 4,
  /** Plays the `.SAN` named by `VAR_VIDEONAME`. */
  PlayVideo: 6,
  CursorFromImage: 12,
  RemapActorPalette: 13,
  RemapActorPaletteAlt: 14,
  /** Sets the frame rate the *next* video plays at, not the current one. */
  VideoFrameRate: 15,
  BlastTextCentred: 16,
  BlastTextLeft: 17,
  RadioChatter: 20,
  ActorScale: 107,
  ShadowPalette: 108,
  ShadowPaletteAlt: 109,
  /** An error in the original interpreter; reaching it means a script bug. */
  Invalid: 114,
  ScreenSaverFreeze: 117,
  BlastObjectMode3: 118,
  BlastObject: 119,
  SaveSound: 124,
  Subtitles: 215,
} as const;

/**
 * v7's kernel queries, which *are* v6's numbers.
 *
 * ScummVM does not override `o6_kernelGetFunctions` for v7, so the answers side
 * is shared where the acts side is not. Restated here rather than imported from
 * the v6 engine, for the reason `isSentenceStillGoing` is restated: a version
 * boundary that can be crossed for a table will be crossed for behaviour.
 */
const KERNEL_GET_V7 = {
  Pixel: 113,
  SpecialBox: 115,
  PointInBox: 116,
  RemapPaletteColor: 206,
  ObjectX: 207,
  ObjectY: 208,
  ObjectWidth: 209,
  ObjectHeight: 210,
  KeyState: 211,
  ActorFrame: 212,
  VerbX: 213,
  VerbY: 214,
  BoxFlags: 215,
} as const;

/**
 * The SCUMM v7 script engine: the delta over the shared stack base.
 *
 * v7 is v6's stack machine. ScummVM records this by deriving `ScummEngine_v7`
 * from `ScummEngine_v6`, inheriting the whole opcode table, replacing one
 * handler and expressing the rest of the difference as `version >= 7` branches
 * inside shared ones — so the opcode *numbers* are identical throughout and
 * what differs is behaviour at about a dozen of them. This class is the shape
 * ADR 0006 chose instead of that inheritance: the shared instructions come from
 * `StackScriptEngine`, and everything below is v7's own.
 *
 * **Scoped to booting and reaching a first room.** The rest of the surface
 * arrives through #107 and #108, driven by the unimplemented-opcode report
 * against a real game rather than by transcribing ScummVM's table — which is
 * how v6 was built, and which spends effort only on what the games execute.
 *
 * **Sound is deliberately absent rather than approximated.** v7 routes
 * `startSound` into iMUSE Digital and never calls `startMusic` at all. The
 * bundles and the sequencer both exist now, but which cue a v7 sound number
 * names is a fact about a real game rather than about the format, so these two
 * instructions still report by number — a line in a log instead of the wrong
 * music. #107.
 *
 * Camera and video are no longer among the gaps. `panCameraTo` and
 * `setCameraAt` take both axes below, and `kernelSetFunctions` 6 plays a `.SAN`
 * while 15 sets the rate the *next* one plays at. What is still missing on the
 * video side is Full Throttle's INSANE branch: the same sub-function runs a
 * playable *scene* rather than a cutscene for the bike fights (#103).
 */
export class ScriptEngineV7 extends StackScriptEngine implements ScriptEngineInterface {
  /**
   * Where v7 keeps the last random number drawn: 34, not v6's 118.
   *
   * v6 layers a few overrides onto the base variable table; v7 assigns the
   * whole table from scratch and agrees with v6 almost nowhere. 118 is
   * `VAR_KEYPRESS` under v7, so drawing a random number here at v6's slot
   * overwrites the last key pressed — which is not a wrong number but a
   * control that stops answering.
   */
  protected get randomNumberVariable(): number {
    return VAR_V7.RANDOM_NR;
  }

  constructor(engine: ScummEngine, state: ScriptState) {
    super(engine, state);
    this.installOpcodes();
  }

  protected installOpcodes(): void {
    const op = (code: number, handler: (this: ScriptEngineV7) => void) => {
      this.dispatch[code] = handler;
    };

    // The encoding, then everything v6 and v7 read the same way, then v7's own.
    // Installing in that order is what lets this class replace a shared handler
    // by number rather than by the shared code knowing which versions differ.
    this.installStackCoreOpcodes();
    this.installStackSharedOpcodes();

    // --- the delta ---------------------------------------------------------

    /**
     * `wait`, whose sub-opcodes v7 reads the same way and answers differently.
     */
    op(0xa9, function () {
      this.wait();
    });

    // Sound. v7's music is streamed out of the `.BUN` bundles and sequenced by
    // iMUSE Digital, which is #104 and #106; ScummVM's v6 `startMusic` is an
    // outright error under v7 rather than a different code path.
    op(0x74, function () {
      // `startSound`. v7 hands the number to iMUSE Digital rather than looking
      // for a resource, and the index's `ANAM` table says which bundle cue the
      // number names — so this is a fact about the index, not about the game,
      // and it does not need a real one to be written.
      const id = this.pop();
      if (!this.engine.sound.startBundleSound(id)) {
        // Not a sub-opcode, so not reported as one: the number is a cue, and
        // saying its operands went unconsumed described a stream desync that
        // could not happen here — the number is the whole operand and it was
        // popped above.
        this.engine.warnOnce(
          `startSound:${id}`,
          `A script's startSound asked for sound ${id}, and the index names no bundle cue ` +
            `for that number, so nothing played. A release that ships no audio bundles — a ` +
            `demo, or an incomplete copy — has nothing here for the instruction to play.`,
        );
      }
    });
    op(0x75, function () {
      // `stopSound`, which v7 reads exactly as v6 does — it was reported here
      // as `startMusic`, which is the *next* opcode, so a v7 game could not
      // stop a sound and was told the wrong instruction's name while failing.
      this.engine.sound.stopSound(this.pop());
    });
    op(0x76, function () {
      // `startMusic`, which under v7 is an error in the original rather than a
      // different code path: v7's music is a state the sequencer is asked for
      // through iMUSE, never started by this instruction.
      const track = this.pop();
      this.engine.warnOnce(
        'startMusic',
        `A script reached startMusic with ${track}, which the original v7 interpreter ` +
          `treats as an error: v7 music is a state asked for through iMUSE rather than ` +
          `a track started here. Nothing was done, and the number was consumed.`,
      );
    });
    op(0xac, function () {
      // `soundKludge`, which is the same opcode as v6's and not the same
      // command set. v6 packs a scope byte and a command byte into the first
      // argument for a MIDI sequencer; v7's first argument is a single
      // sixteen-bit iMUSE *Digital* command, so it goes to the digital
      // dispatch. Read through v6's split, The Dig's 0x1000 — "set the musical
      // state" — arrived as "command 0, scope 16" and was reported
      // unimplemented, because that number was never a scope and a command.
      this.engine.sound.digital.command(this.popList(16));
    });

    // Camera. Both take a y in v7 and only an x in v6, so consuming one operand
    // would leave the other on the stack for the next instruction to read as
    // its own — a fault that surfaces somewhere else entirely.
    // At v6's numbers, because v6 and v7 are one encoding: `panCameraTo` is
    // 0x78, `actorFollowCamera` 0x79 and `setCameraAt` 0x7a. These were
    // installed at 0x79, 0x7f and 0x7b — its neighbours — which is worse than
    // three missing instructions, because 0x7b is `loadRoom` and 0x7f is
    // `putActorAtXY`. A v7 game could not change rooms: every `loadRoom` set a
    // camera follow instead, silently, and reported nothing.
    op(0x78, function () {
      const y = this.pop();
      const x = this.pop();
      this.engine.panCameraTo(x, y);
    });
    op(0x79, function () {
      // `actorFollowCamera`: v7 sets a follow rather than jumping to the actor,
      // which is a camera behaviour rather than a script one.
      this.engine.camera.following = this.pop();
    });
    op(0x7a, function () {
      const y = this.pop();
      const x = this.pop();
      this.engine.setCameraAt(x, y);
    });

    // The shared instructions v7 answers differently. Installed after the
    // shared set, which is what replaces them.
    op(0x85, function () {
      const y = this.pop();
      const x = this.pop();
      const room = this.pop();
      // v7 does not set a camera follow here, where v6 does: the camera is
      // told who to follow by `actorFollowCamera` and not as a side effect of
      // walking an actor into a room.
      this.engine.loadRoomWithEgo(this.pop(), room, x, y);
    });

    op(0xcd, function () {
      // `stampObject`, where v7 overloads the object number: below thirty it
      // names an *actor*, and the instruction draws that actor's costume
      // instead of an object's artwork. Read as an object number it addresses
      // whichever object happens to be numbered the same, which is a wrong
      // sprite rather than a missing one.
      const state = this.pop();
      const y = this.pop();
      const x = this.pop();
      const object = this.pop();

      if (object < V7_ACTOR_OBJECT_BOUNDARY) {
        const actor = this.engine.getActor(object);
        if (actor) {
          actor.scaleX = 0xff;
          actor.scaleY = 0xff;
          this.engine.putActor(actor.number, x, y);
          actor.needRedraw = true;
        }
        return;
      }

      this.engine.setObjectPosition(object, x, y);
      this.engine.drawObject(object, state === 0 ? 1 : state);
    });

    op(0xe4, function () {
      // Numbered from two, as in v6. v7 additionally puts the actors back on
      // the new boxes: a box set decides where walking is allowed, and an actor
      // left standing where only the old set permitted has no valid box to walk
      // from, so every walk request from that position fails silently.
      this.engine.setBoxSet(this.pop() - 2);
      this.engine.putActorsOnValidBoxes();
    });

    // --- the kernel hatch --------------------------------------------------
    //
    // Same two opcode numbers as v6 and a different table behind them, which
    // is the whole reason this is installed here rather than shared.
    op(0xc9, function () {
      this.kernelSetFunction(this.popList(30));
    });
    op(0xc8, function () {
      this.push(this.kernelGetFunction(this.popList(30)));
    });
  }

  /**
   * The rate the next video plays at, when a script sets one.
   *
   * Kept until a video is asked for rather than applied on the spot: v7 sets
   * the rate and plays the file as two separate calls, and the file's own
   * header is the fallback for both.
   */
  private videoFrameRate = 0;

  /**
   * `kernelSetFunctions` under v7.
   *
   * The one that matters here is 6. A script does not pass a file name as an
   * operand — it writes the name into a string array and leaves the array's
   * handle in `VAR_VIDEONAME`, so playing a video is two instructions that have
   * to agree about a variable number. That is why the number is named in
   * `VAR_V7` with a comment rather than inlined: reading the wrong slot plays
   * nothing and looks exactly like a missing file.
   */
  protected kernelSetFunction(args: number[]): void {
    switch (args[0]) {
      case KERNEL_SET_V7.PlayVideo: {
        // One sub-function, two interaction models. A zero argument means a
        // cutscene, named by `VAR_VIDEONAME` and watched. Anything else is
        // Full Throttle asking for an INSANE *scene* — the bike fights and the
        // derby, which are played rather than watched, drive the video from
        // scripts and read input against it.
        //
        // Named with its argument rather than ignored, because a bike fight
        // that silently does nothing is a game that stops with no explanation,
        // and because the numbers a real playthrough reports here are the input
        // #103 needs.
        if (args[1] !== 0) {
          this.engine.warn(
            `A script asked for an interactive SMUSH scene (kernelSetFunctions 6, ` +
              `argument ${args[1]}), which Full Throttle's bike combat and derby use. ` +
              `Interactive sequences are not driven yet (#103), so nothing was played.`,
          );
          break;
        }
        const name = this.arrays.readStringByHandle(this.readVar(VAR_V7.VIDEONAME));
        if (name === '') {
          this.engine.warn(
            'A script asked to play a video without naming one, so nothing was played. ' +
              `Variable ${VAR_V7.VIDEONAME} held ${this.readVar(VAR_V7.VIDEONAME)}.`,
          );
          break;
        }
        // The rate a previous call set, if any. The file's own header still
        // overrides it, which is the original's order of precedence.
        this.engine.playVideo(name, this.videoFrameRate > 0 ? this.videoFrameRate : undefined);
        break;
      }

      case KERNEL_SET_V7.VideoFrameRate:
        this.videoFrameRate = args[1] ?? 0;
        break;

      case KERNEL_SET_V7.GrabCursor:
        this.engine.grabCursor(args[1], args[2], args[3], args[4]);
        break;

      case KERNEL_SET_V7.ActorScale: {
        // Horizontal only, as in v6: the original passes -1 for the vertical
        // scale meaning "leave it", and scaling both axes shrinks an actor the
        // game only asked to narrow.
        const actor = this.engine.getActor(args[1]);
        if (actor) {
          actor.scaleX = args[2] & 0xff;
          actor.needRedraw = true;
        }
        break;
      }

      case KERNEL_SET_V7.ShadowPalette:
      case KERNEL_SET_V7.ShadowPaletteAlt:
        // v7 and v6 call two different overloads here, and the argument order
        // is not the same in each. v6 sends the three channel scales first and
        // the colour range after: `(r, g, b, startColor, endColor)`. v7 sends a
        // *slot* first — it keeps several shadow tables, not one — and the range
        // last: `(slot, r, g, b, startColor, endColor)`. Reading v7's arguments
        // in v6's order takes the slot number for a red scale and shifts
        // everything after it, which is what this used to do.
        //
        // 109 is the same act against slot 0, which is why the two share a case
        // and differ only in where the arguments start.
        {
          const named = args[0] === KERNEL_SET_V7.ShadowPalette;
          const at = named ? 2 : 1;
          this.engine.setShadowPaletteSlot(
            named ? (args[1] ?? 0) : 0,
            args[at] ?? 0,
            args[at + 1] ?? 0,
            args[at + 2] ?? 0,
            args[at + 3] ?? 0,
            args[at + 4] ?? 0,
          );
        }
        break;

      case KERNEL_SET_V7.CursorFromImage:
        // The cursor bitmap comes from an object's artwork. The room is -1,
        // meaning "wherever it is", and the third argument picks which of the
        // object's images — neither of which this can act on, because the
        // browser draws its own pointer; the object number is what a diagnostic
        // wants and what `setCursorFromObject` records.
        this.engine.setCursorFromObject(args[1] ?? 0, -1);
        break;

      case KERNEL_SET_V7.RemapActorPalette:
      case KERNEL_SET_V7.RemapActorPaletteAlt:
        // The same act with and without a threshold. Without one (13) the
        // actor takes the nearest colour the room has, however far off it is;
        // with one (14) a colour further away than the threshold gets a spare
        // palette entry written for it instead, which is how a costume keeps a
        // tint the room has no colour for.
        this.engine.remapActorPalette(
          args[1] ?? 0,
          args[2] ?? 0,
          args[3] ?? 0,
          args[4] ?? 0,
          args[0] === KERNEL_SET_V7.RemapActorPaletteAlt ? (args[5] ?? -1) : -1,
        );
        break;

      case KERNEL_SET_V7.RadioChatter:
        this.engine.setRadioChatter(args[1] !== 0);
        break;

      case KERNEL_SET_V7.BlastTextCentred:
      case KERNEL_SET_V7.BlastTextLeft: {
        // The text is not an operand. As with a video's file name, a script
        // writes the line into a string array and leaves the array's handle in
        // a variable — so this reads `VAR_STRING2DRAW` for the same reason
        // sub-function 6 reads `VAR_VIDEONAME`, and getting the slot wrong
        // draws nothing while looking like a script that said nothing.
        //
        // The argument order is the part worth naming: the charset comes
        // first and the position last, so it is charset, colour, x, y — not
        // the x, y, colour a caller would expect.
        const text = this.arrays.readStringByHandle(this.readVar(VAR_V7.STRING2DRAW));
        this.engine.enqueueBlastText(
          text,
          args[3] ?? 0,
          args[4] ?? 0,
          args[2] ?? 0,
          args[1] ?? 0,
          args[0] === KERNEL_SET_V7.BlastTextCentred,
        );
        break;
      }

      case KERNEL_SET_V7.Subtitles:
        // The options screen writing the player's choice into the interpreter.
        this.engine.setSubtitles(args[1] !== 0);
        break;

      case KERNEL_SET_V7.ScreenSaverFreeze:
        // v7 freezes with flag 2 where v6 uses 0x80. Not interchangeable: the
        // flag is what a later thaw matches against.
        this.freezeScripts(2);
        break;

      case KERNEL_SET_V7.BlastObjectMode3:
      case KERNEL_SET_V7.BlastObject:
        // Eight arguments, not three: the size, the scale in each axis and
        // which of the object's images — which is how The Dig lights an
        // inventory slot and Full Throttle a spoke of its wheel. The two
        // sub-functions differ only in the shadow mode they ask for, and that
        // only applies at full scale.
        this.engine.enqueueBlastObject(
          args[1] ?? 0,
          args[2] ?? 0,
          args[3] ?? 0,
          args[4] ?? 0,
          args[5] ?? 0,
          args[6] ?? 255,
          args[7] ?? 255,
          args[8] ?? 1,
          args[0] === KERNEL_SET_V7.BlastObjectMode3 ? 3 : 0,
        );
        break;

      case KERNEL_SET_V7.SaveSound:
        // Acknowledged and dropped, as in v6: nothing here writes a sound into
        // a saved game, and this asks for exactly that.
        break;

      case KERNEL_SET_V7.Invalid:
        // The original interpreter errors here, so a script reaching it is a
        // script bug rather than a missing feature. Named as such.
        this.engine.warn(
          'A script reached kernelSetFunctions 114, which the original interpreter ' +
            'treats as an error. Nothing was done.',
        );
        break;

      default:
        this.reportUnknownSubOpcode('kernelSetFunctions', args[0] ?? -1, 'consumed');
        break;
    }
  }

  /**
   * `kernelGetFunctions` under v7, whose numbers are v6's.
   *
   * Installed rather than left to report, because this instruction pushes an
   * answer: an unhandled query that pushes nothing leaves the stack one short
   * and the *next* instruction reads an operand that belonged to this one. So
   * an unknown query is named and answers zero.
   */
  protected kernelGetFunction(args: number[]): number {
    switch (args[0]) {
      case KERNEL_GET_V7.Pixel:
        return this.engine.getScreenPixel(args[1], args[2]);
      case KERNEL_GET_V7.SpecialBox:
        return this.engine.getSpecialBox(args[1], args[2]);
      case KERNEL_GET_V7.PointInBox:
        return this.engine.isPointInBox(args[3], args[1], args[2]) ? 1 : 0;
      case KERNEL_GET_V7.RemapPaletteColor:
        return this.engine.remapPaletteColor(args[1], args[2], args[3]);
      case KERNEL_GET_V7.ObjectX:
        return this.engine.getObjectGeometry(args[1])?.x ?? 0;
      case KERNEL_GET_V7.ObjectY:
        return this.engine.getObjectGeometry(args[1])?.y ?? 0;
      case KERNEL_GET_V7.ObjectWidth:
        return this.engine.getObjectGeometry(args[1])?.width ?? 0;
      case KERNEL_GET_V7.ObjectHeight:
        return this.engine.getObjectGeometry(args[1])?.height ?? 0;
      case KERNEL_GET_V7.KeyState:
        return this.engine.getKeyState(args[1]);
      case KERNEL_GET_V7.ActorFrame:
        return this.engine.getActor(args[1])?.frame ?? 0;
      case KERNEL_GET_V7.VerbX:
        return this.engine.verbs.get(args[1])?.bounds.left ?? 0;
      case KERNEL_GET_V7.VerbY:
        return this.engine.verbs.get(args[1])?.bounds.top ?? 0;
      case KERNEL_GET_V7.BoxFlags:
        return this.engine.getBoxFlags(args[1]);
      default:
        this.reportUnknownSubOpcode('kernelGetFunctions', args[0] ?? -1, 'consumed');
        return 0;
    }
  }

  /**
   * v7 pushes only the object and looks its room up; v6 pushes both.
   *
   * Overridden rather than special-cased at one opcode, because more than one
   * shared instruction asks — `getState`, `putActorAtObject`, the cursor and
   * resource routines. Getting it wrong does not fail: it pops one operand too
   * many, and the *next* instruction reads a value that belonged to this one.
   * (`ScummEngine_v6::popRoomAndObj`, which branches on version.)
   */
  protected override popRoomAndObject(): { room: number; object: number } {
    const object = this.pop();
    return { object, room: this.engine.resources.objectRoom[object] ?? 0 };
  }

  /**
   * `wait`, whose sub-opcodes v7 numbers as v6 does and answers differently.
   *
   * The rewind rule is v6's and is not a v7 difference: the forms that carry a
   * displacement resume at it, and the rest rewind to the instruction itself.
   */
  protected wait(): void {
    const instructionAddress = this.pc - 1;
    const subOp = this.fetchByte();

    let keepWaiting: boolean;
    let resumeAt = instructionAddress;

    switch (subOp) {
      case WAIT_OP.ForActor: {
        const displacement = this.fetchWordSigned();
        resumeAt = this.pc + displacement;
        const actor = this.engine.getActor(this.pop());
        // v7 also requires the actor to be in the room being drawn, where v6
        // asks only whether it is moving. Without the room check a script waits
        // on an actor who has left, which is a hang rather than a wrong frame.
        keepWaiting = Boolean(
          actor && actor.isInCurrentRoom(this.engine.currentRoom) && actor.moving,
        );
        break;
      }
      case WAIT_OP.ForMessage:
        keepWaiting = this.readVar(VAR_V7.HAVE_MSG) !== 0;
        break;
      case WAIT_OP.ForCamera:
        // v7 compares the camera's destination exactly, on both axes, where v6
        // compares x in strips. Only x exists here until #99 lands, so the
        // comparison is v7's on the axis that does exist and the missing one is
        // named rather than assumed equal.
        keepWaiting = this.engine.camera.current !== this.engine.camera.destination;
        break;
      case WAIT_OP.ForSentence:
        keepWaiting = this.isSentenceStillGoing();
        break;
      default:
        this.reportUnknownSubOpcode('wait', subOp, 'unclear');
        return;
    }

    if (!keepWaiting) return;

    this.pc = resumeAt;
    this.breakHere();
  }

  /**
   * Whether `wait.forSentence` should keep waiting.
   *
   * The awkward case is a queued sentence that is *frozen* with no sentence
   * script running, which is where a cutscene leaves things: waiting there
   * waits for something nothing will finish. Not a v7 difference — this is v6's
   * rule, restated rather than imported, because the version boundary forbids
   * importing a sibling and because a rule that happens to be shared today is
   * not the same as one that is shared by construction.
   */
  private isSentenceStillGoing(): boolean {
    const sentenceScript = this.engine.variables[VAR_V7.SENTENCE_SCRIPT];
    const scriptRunning = sentenceScript !== 0 && this.isScriptRunning(sentenceScript);
    const queue = this.engine.sentenceQueue;

    if (queue.length > 0) {
      const pending = queue[queue.length - 1];
      return !(pending.freezeCount > 0 && !scriptRunning);
    }
    return scriptRunning;
  }

  /**
   * Reads the inline message that follows a talk instruction.
   *
   * The measuring is shared with the reader that decodes scripts back into
   * instructions, because the two have to agree exactly: a reader that measured
   * a string differently would re-emit an edited script that this engine then
   * read as something else.
   */
  /**
   * v7's inline string, which names a bundle entry rather than carrying words.
   *
   * Resolving it is `resolveMessage`'s job and not this one: an array
   * assignment stores what the code stream holds — a file name, a tag — and a
   * line looked up in the language bundle is not what a script asked to store.
   */
  protected fetchInlineText(): string {
    return this.fetchDecodedMessage().text;
  }

  /**
   * The message's bytes, terminator excluded.
   *
   * Raw rather than decoded, because the control codes inside a v7 message
   * carry meaning that a string cannot hold — code 10 is fourteen bytes naming
   * where a line's recording lives — and `decodeMessage` is the one reader that
   * knows how long each code is. This used to filter the payload out by
   * dropping bytes below 0x20, which kept the `0xff` markers and whichever
   * payload bytes happened to be printable: The Dig demo's first line displayed
   * as `ÿÿÿWÿI can't use these things together.`
   */
  protected fetchMessage(): number[] {
    const code = this.code;
    if (!code) return [];

    const length = measureV7Message(code, this.pc);
    if (length === null) {
      this.codeOverrun = true;
      return [];
    }

    const raw = Array.from(code.subarray(this.pc, this.pc + length - 1));
    this.pc += length;
    return raw;
  }

  private fetchDecodedMessage(): { text: string; speechOffset: number; speechSize: number } {
    const raw = this.fetchMessage();
    const speech = { offset: 0, size: 0 };
    const text = this.engine.decodeMessage(raw, speech);
    return { text, speechOffset: speech.offset, speechSize: speech.size };
  }

  /**
   * v7's spoken message: the line the tag resolves to, and where it was recorded.
   *
   * The words come from the bundle rather than from the code stream, so this is
   * where the tag is resolved — an array assignment stores the tag itself and a
   * spoken line shows what it means, which is why the two hooks differ.
   *
   * The speech fields are whatever the message's control code 10 carried, and
   * what they *mean* depends on the release rather than on the version. Full
   * Throttle's are an ordinary byte offset into `MONSTER.SOU` and a VCTL size,
   * exactly as a v6 talkie's are. The Dig's demo reuses the same two fields for
   * a room number and a line number, and keeps the recordings as one `.voc`
   * per line under `audio/<room name>.<room>/`. The full releases carry the
   * pair too but address their speech by cue name inside a `.BUN`, so for those
   * the numbers lead nowhere and the line plays with subtitles.
   *
   * Deciding between them is `showText`'s job: reporting the fields is not the
   * same as claiming to know which file they point into.
   */
  protected fetchSpokenMessage(): { text: string; speechOffset: number; speechSize: number } {
    const message = this.fetchDecodedMessage();
    return { ...message, text: this.resolveMessage(message.text) };
  }

  /**
   * What a v7 message actually displays.
   *
   * The string in the code names a bundle entry rather than carrying the words.
   * A tag that resolves gives the line; one that does not gives the fallback
   * carried beside it, which is what the original does and is the normal case
   * for Full Throttle, which ships no bundle at all.
   */
  resolveMessage(text: string): string {
    const tag = v7MessageKey(text);
    if (tag === null) return text;
    return resolveLine(this.engine.languageBundle, tag, v7MessageFallback(text));
  }
}
