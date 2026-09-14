import { VAR, VAR_V6 } from '../../constants.js';
import { MF_TURN } from '../../actor/Actor.js';
import type { ScummEngine } from '../../ScummEngine.js';
import type { ScriptEngine as ScriptEngineInterface } from '../ScriptEngine.js';
import type { ScriptState } from '../ScriptState.js';
import { StackScriptEngine } from '../StackScriptEngine.js';
import { measureV6Message } from './message.js';

const WAIT_OP = {
  ForActor: 168,
  ForMessage: 169,
  ForCamera: 170,
  ForSentence: 171,
  ForAnimation: 226,
  ForTurn: 232,
} as const;

/** `dimArray`'s one form that destroys rather than creates. */

/** Kernel sub-functions, whose first list element selects the operation. */
const KERNEL_SET = {
  Dummy: 3,
  GrabCursor: 4,
  FadeOut: 5,
  FadeIn: 6,
  StartManiac: 8,
  KillAllScripts: 9,
  NukeFloatingObjects: 104,
  ActorScale: 107,
  ShadowPalette: 108,
  ShadowPaletteAlt: 109,
  ClearCharsetMask: 110,
  ActorShadowMode: 111,
  PaletteShift: 112,
  Grayscale: 114,
  ScreenSaverFreeze: 117,
  BlastObject: 119,
  SwapPaletteColors: 120,
  ImuseCommand: 122,
  CopyPaletteColor: 123,
  SaveSound: 124,
} as const;

const KERNEL_GET = {
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

/** Bit variables and locals share the address space with globals, by mask. */

/**
 * The SCUMM v6 bytecode interpreter — Day of the Tentacle, Sam & Max.
 *
 * v6 is a **stack machine**, and that is the whole of the difference from v5.
 * Where v5 packs operand modes into the opcode byte (`0x1E` and `0x9E` are the
 * same instruction reading its actor number from different places), v6 pushes
 * operands and then runs an instruction that consumes them:
 *
 *     0x00 0x07        pushByte 7
 *     0x43 0xFA 0x00   writeWordVar var250      -- pops the 7
 *
 * That makes decoding regular: an instruction's length depends on the opcode
 * alone, never on a mode bit, which is why a v6 script can be disassembled
 * exactly where a v5 one cannot always be.
 *
 * What is *running* lives in `ScriptState`, shared with the v5 engine and owned
 * by `ScummEngine` (ADR 0001), so a diagnostic or a saved game sees the same
 * slots whichever version is playing. What is here is decoding and the opcode
 * set.
 *
 * **Coverage is deliberately partial, and says so at runtime.** An opcode with
 * no handler stops its script and reports through
 * `ScummEngine.reportUnknownOpcode`, naming the opcode, script and offset. It
 * is not skipped: v6 operands come off a stack, so skipping an instruction
 * leaves the stack misaligned and every instruction after it reads someone
 * else's operands. A script that stops with a named opcode is a bug report; one
 * that continues on a corrupt stack is a mystery.
 *
 * Opcode numbering follows ScummVM's `setupOpcodes` in `script_v6.cpp`, which
 * is a fact about the bytecode rather than part of its implementation; no
 * ScummVM code is reproduced here.
 */
export class ScriptEngineV6 extends StackScriptEngine implements ScriptEngineInterface {
  /** v6 keeps the last random number drawn in a variable of its own. */
  protected get randomNumberVariable(): number {
    return VAR_V6.RANDOM_NR;
  }

  constructor(engine: ScummEngine, state: ScriptState) {
    super(engine, state);

    this.installOpcodes();
  }

  // ----------------------------------------------------------------- text --

  /**
   * Reads the inline message that follows a talk instruction.
   *
   * The measuring is shared with the reader that decodes scripts back into
   * instructions (`measureV6Message`), because the two have to agree exactly:
   * a reader that measured a string differently would re-emit an edited script
   * that this engine then read as something else.
   *
   * An unterminated string is an overrun rather than a short string — the
   * program counter is not where it is thought to be, and decoding whatever
   * follows would hide that behind text that happens to read.
   */
  private fetchMessage(): number[] {
    const code = this.code;
    if (!code) return [];

    const length = measureV6Message(code, this.pc);
    if (length === null) {
      this.codeOverrun = true;
      this.pc = code.length;
      return [];
    }

    // The terminator is part of the instruction but not part of the message.
    const raw = Array.from(code.subarray(this.pc, this.pc + length - 1));
    this.pc += length;
    return raw;
  }

  /** Decodes the inline message that follows, with any speech it points at. */
  /** v6's inline string, with its embedded control codes decoded. */
  protected fetchInlineText(): string {
    return this.fetchDecodedMessage().text;
  }

  /**
   * v6's spoken message: the words, and where the recording of them is.
   *
   * A talkie keeps its speech in `MONSTER.SOU` addressed by byte offset, and
   * the offset is carried inside the message itself — so reading the message
   * and finding the recording are one act here.
   */
  protected fetchSpokenMessage(): { text: string; speechOffset: number; speechSize: number } {
    return this.fetchDecodedMessage();
  }

  private fetchDecodedMessage(): { text: string; speechOffset: number; speechSize: number } {
    const raw = this.fetchMessage();
    const speech = { offset: 0, size: 0 };
    const text = this.engine.decodeMessage(raw, speech);
    return { text, speechOffset: speech.offset, speechSize: speech.size };
  }

  // -------------------------------------------------------------- opcodes --

  protected installOpcodes(): void {
    // The encoding, then everything v6 and v7 read the same way, then v6's own.
    // Installing in that order is what lets a version replace a shared handler
    // by number rather than by the shared code knowing about it.
    this.installStackCoreOpcodes();
    this.installStackSharedOpcodes();

    const op = (code: number, handler: (this: ScriptEngineV6) => void) => {
      this.dispatch[code] = handler;
    };

    op(0x85, function () {
      const y = this.pop();
      const x = this.pop();
      const room = this.pop();
      this.engine.loadRoomWithEgo(this.pop(), room, x, y);
    });
    op(0x78, function () {
      this.engine.panCameraTo(this.pop());
    });
    op(0x79, function () {
      this.engine.actorFollowCamera(this.pop());
    });
    op(0x7a, function () {
      this.engine.setCameraAt(this.pop());
    });
    op(0x74, function () {
      this.engine.sound.startSound(this.pop());
    });
    op(0x75, function () {
      this.engine.sound.stopSound(this.pop());
    });
    op(0x76, function () {
      this.engine.sound.startSound(this.pop());
    });
    op(0xcd, function () {
      // `stampObject`. The original burns the artwork into the background so
      // it survives without an object entry; here it is an ordinary draw,
      // which looks the same until something redraws the background under it.
      const state = this.pop();
      const y = this.pop();
      const x = this.pop();
      const object = this.pop();
      // `-1` for x means "leave it where it is", which is how the original
      // tells a stamp-in-place from a stamp-somewhere-else.
      if (x !== -1) this.engine.setObjectPosition(object, x, y);
      this.engine.drawObject(object, state === 0 ? 1 : state);
    });
    op(0x9b, function () {
      this.resourceRoutines();
    });
    op(0xe4, function () {
      // Numbered from *two* in the script, oddly: the original counts one
      // `BOXD` block per step and starts counting at the operand minus one, so
      // set 2 selects the room's first box set — the one it loaded with — and
      // set 3 the next. Set 1 is not a set at all.
      this.engine.setBoxSet(this.pop() - 2);
    });
    op(0xa9, function () {
      this.wait();
    });
    op(0xc9, function () {
      this.kernelSetFunction(this.popList(30));
    });
    op(0xc8, function () {
      this.push(this.kernelGetFunction(this.popList(30)));
    });
  }
  // ------------------------------------------------------- sub-opcodes ------

  /**
   * `wait`: block until a condition holds.
   *
   * Implemented by rewinding and yielding, so the test runs again next frame.
   * The actor forms carry their own displacement — the offset to resume at when
   * the wait is over — while the rest rewind to the instruction itself, which
   * is the two bytes the original's default displacement of -2 covers.
   */
  protected wait(): void {
    const instructionAddress = this.pc - 1;
    const subOp = this.fetchByte();

    let keepWaiting: boolean;
    let resumeAt = instructionAddress;

    switch (subOp) {
      case WAIT_OP.ForActor:
      case WAIT_OP.ForAnimation:
      case WAIT_OP.ForTurn: {
        const displacement = this.fetchWordSigned();
        resumeAt = this.pc + displacement;
        const actor = this.engine.getActor(this.pop());
        const here = Boolean(actor?.isInCurrentRoom(this.engine.currentRoom));
        // In the room *and* moving. An actor that has left the room is not
        // going to arrive, so the original stops waiting for it rather than
        // waiting for ever — which is what a script does when a scene sends
        // the actor it is waiting on somewhere else.
        if (subOp === WAIT_OP.ForActor) keepWaiting = here && Boolean(actor && actor.moving);
        else if (subOp === WAIT_OP.ForAnimation) keepWaiting = here && Boolean(actor?.needRedraw);
        else keepWaiting = here && Boolean(actor && actor.moving & MF_TURN);
        break;
      }
      case WAIT_OP.ForMessage:
        keepWaiting = this.readVar(VAR.HAVE_MSG) !== 0;
        break;
      case WAIT_OP.ForCamera:
        // Compared in strips, as the original does: the camera settles to
        // within a strip of its destination, so an exact comparison can wait
        // for a position it never reaches.
        keepWaiting =
          Math.floor(this.engine.camera.current / 8) !==
          Math.floor(this.engine.camera.destination / 8);
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
   * script running — which is where a cutscene leaves things. Waiting there
   * waits for something nothing will finish, so the original does not, and
   * neither does this.
   */
  protected isSentenceStillGoing(): boolean {
    const sentenceScript = this.engine.variables[VAR.SENTENCE_SCRIPT];
    const scriptRunning = sentenceScript !== 0 && this.isScriptRunning(sentenceScript);
    const queue = this.engine.sentenceQueue;

    if (queue.length > 0) {
      const pending = queue[queue.length - 1];
      return !(pending.freezeCount > 0 && !scriptRunning);
    }
    return scriptRunning;
  }

  /**
   * `kernelSetFunctions`: the hatch the interpreter's own routines hang off.
   *
   * A numbered call rather than an opcode, with the number as the first element
   * of an argument list — which is how LucasArts added features without
   * renumbering the instruction set. Sam & Max leans on it hardest: its film
   * noir mode, its screensaver and its verb coin all come through here.
   */
  protected kernelSetFunction(args: number[]): void {
    switch (args[0]) {
      case KERNEL_SET.Dummy:
      case KERNEL_SET.SaveSound:
        break;
      case KERNEL_SET.GrabCursor:
        this.engine.grabCursor(args[1], args[2], args[3], args[4]);
        break;
      case KERNEL_SET.FadeOut:
      case KERNEL_SET.FadeIn:
        this.engine.setScreenEffect(args[1]);
        this.engine.markScreenDirty();
        break;
      case KERNEL_SET.KillAllScripts:
        this.killAllScriptsExceptCurrent();
        break;
      case KERNEL_SET.NukeFloatingObjects:
        this.engine.nukeFloatingObjects(args[2], args[3]);
        break;
      case KERNEL_SET.ActorScale: {
        // Horizontal only: the original passes -1 for the vertical scale,
        // meaning "leave it", and an actor scaled on both axes by this call
        // would shrink where the game only asked it to narrow.
        const actor = this.engine.getActor(args[1]);
        if (actor) {
          actor.scaleX = args[2] & 0xff;
          actor.needRedraw = true;
        }
        break;
      }
      case KERNEL_SET.ShadowPalette:
      case KERNEL_SET.ShadowPaletteAlt:
        this.engine.setShadowPalette(args[3], args[4], args[5], args[1], args[2]);
        break;
      case KERNEL_SET.PaletteShift:
        this.engine.setShadowPalette(args[3], args[4], args[5], args[1], args[2], args[6], args[7]);
        break;
      case KERNEL_SET.ClearCharsetMask:
        this.engine.clearCharsetMask();
        break;
      case KERNEL_SET.ActorShadowMode: {
        const actor = this.engine.getActor(args[1]);
        if (actor) actor.shadowMode = args[2] + args[3];
        break;
      }
      case KERNEL_SET.Grayscale:
        // Sam & Max's film noir mode. The palette is desaturated in place
        // rather than swapped, so anything drawn afterwards is grey too.
        this.engine.applyGrayscale(0, 254);
        break;
      case KERNEL_SET.ScreenSaverFreeze:
        // Everything stops while the screensaver runs, including the scripts
        // that would otherwise notice the player has gone.
        this.freezeScripts(0x80);
        break;
      case KERNEL_SET.BlastObject:
        // Eight arguments, not three: the size, the scale in each axis and
        // which of the object's images. Dropping the last three drew the wrong
        // picture at full size wherever a script asked for a scaled or a
        // highlighted one, which reads as artwork trouble rather than as a call
        // decoded short.
        this.engine.enqueueBlastObject(
          args[1] ?? 0,
          args[2] ?? 0,
          args[3] ?? 0,
          args[4] ?? 0,
          args[5] ?? 0,
          args[6] ?? 255,
          args[7] ?? 255,
          args[8] ?? 1,
          0,
        );
        break;
      case KERNEL_SET.SwapPaletteColors:
        this.engine.swapPaletteColors(args[1], args[2]);
        break;
      case KERNEL_SET.CopyPaletteColor:
        // Source first, destination second: the original's own argument order
        // is the other way round.
        this.engine.copyPaletteColor(args[1], args[2]);
        break;
      case KERNEL_SET.ImuseCommand:
        // An iMUSE command routed through the kernel rather than through
        // `soundKludge`, and this form expects an answer back. Nothing here can
        // answer a query — the music is rendered up front rather than
        // sequenced — so it reports success: a script told its command failed
        // reissues it, and would do so every frame.
        this.engine.sound.kludge(args.slice(1));
        this.engine.variables[VAR.SOUNDRESULT] = 0;
        break;
      case KERNEL_SET.StartManiac:
        // DOTT ships Maniac Mansion inside itself and this launches it. That
        // is a second game, not a feature of this one.
        this.engine.warn(
          'A script asked to start Maniac Mansion on the mansion computer. Running the ' +
            'game inside the game is not supported, so the screen stays as it is.',
        );
        break;
      default:
        // The whole argument list was popped before this dispatch, so an
        // unimplemented kernel function costs exactly itself.
        this.reportUnknownSubOpcode('kernelSetFunctions', args[0] ?? -1, 'consumed');
        break;
    }
  }

  /** `kernelGetFunctions`: the same hatch, for the answers rather than the acts. */
  protected kernelGetFunction(args: number[]): number {
    switch (args[0]) {
      case KERNEL_GET.Pixel:
        return this.engine.getScreenPixel(args[1], args[2]);
      case KERNEL_GET.SpecialBox:
        return this.engine.getSpecialBox(args[1], args[2]);
      case KERNEL_GET.PointInBox:
        return this.engine.isPointInBox(args[3], args[1], args[2]) ? 1 : 0;
      case KERNEL_GET.RemapPaletteColor:
        return this.engine.remapPaletteColor(args[1], args[2], args[3]);
      case KERNEL_GET.ObjectX:
        return this.engine.getObjectGeometry(args[1])?.x ?? 0;
      case KERNEL_GET.ObjectY:
        return this.engine.getObjectGeometry(args[1])?.y ?? 0;
      case KERNEL_GET.ObjectWidth:
        return this.engine.getObjectGeometry(args[1])?.width ?? 0;
      case KERNEL_GET.ObjectHeight:
        return this.engine.getObjectGeometry(args[1])?.height ?? 0;
      case KERNEL_GET.KeyState:
        return this.engine.getKeyState(args[1]);
      case KERNEL_GET.ActorFrame:
        // Read by walk scripts, which drive an actor's legs frame by frame.
        return this.engine.getActor(args[1])?.frame ?? 0;
      case KERNEL_GET.VerbX:
        return this.engine.verbs.get(args[1])?.bounds.left ?? 0;
      case KERNEL_GET.VerbY:
        return this.engine.verbs.get(args[1])?.bounds.top ?? 0;
      case KERNEL_GET.BoxFlags:
        return this.engine.getBoxFlags(args[1]);
      default:
        this.reportUnknownSubOpcode('kernelGetFunctions', args[0] ?? -1, 'consumed');
        return 0;
    }
  }
}
