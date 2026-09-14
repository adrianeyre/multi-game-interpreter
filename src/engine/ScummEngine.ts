import {
  ANIMATE_FRAME,
  ANIMATE_FRAME_V7,
  ClickArea,
  MouseButton,
  NUM_SENTENCE_SLOTS,
  OBJECT_CLASS,
  OFF_SCREEN_POSITION,
  OF_OWNER_ROOM,
  OF_OWNER_ROOM_V7,
  ObjectWhere,
  ScriptStatus,
  TEXT_SLOT,
  variablesFor,
  type VariableMap,
} from './constants.js';
import {
  Actor,
  MF_IN_LEG,
  MF_LAST_LEG,
  MF_NEW_LEG,
  MF_TURN,
  normalizeAngle,
  V7_CLIP_FROM_BOX,
} from './actor/Actor.js';
import { buildCostumePalette, drawCel } from './gfx/CostumeRenderer.js';
import { choreFor, decodeAkosCel, parseAkos, type AkosCostume } from './gfx/costume/akos.js';
import { stepChore, type ChoreVars } from './gfx/costume/chore.js';
import { Charset, layoutSpeech, wrapText } from './gfx/Charset.js';
import {
  Costume,
  costumeDecodeData,
  decodeCel,
  getLimbCel,
  increaseAnims,
  newDirToOldDir,
  oldDirToNewDir,
} from './gfx/Costume.js';
import { Palette } from './gfx/Palette.js';
import { RoomGraphics, findObjectImage } from './gfx/RoomGraphics.js';
import { bompScaleMask, decodeBomp } from './gfx/costume/bomp.js';
import { SCREEN_HEIGHT, SCREEN_WIDTH, Screen } from './gfx/Screen.js';
import { hexWindow } from './util/ByteStream.js';
import { SMALL_CHUNK_HEADER_SIZE, findChunk, readChunkHeader } from './resource/Chunk.js';
import type { DataSource } from './resource/DataSource.js';
import { VideoPlayback } from './video/VideoPlayback.js';
import { IACT_SAMPLE_RATE } from './video/iact.js';
import { readNutFont, type NutFont } from './video/nut.js';
import { readSmushStrings, stringTableNameFor } from './video/trs.js';
import { DEFAULT_SMUSH_FPS } from './video/SmushPlayer.js';
import { detectGame } from './resource/GameDetector.js';
import { LoadProgressTracker } from './resource/progress.js';
import { ResourceManager, type ResourceType } from './resource/ResourceManager.js';
import { BoxMatrix } from './room/BoxMatrix.js';
import { INVALID_BOX, Room, type RoomObject } from './room/Room.js';
import { captureState, restoreState, SAVE_FORMAT, type SavedGame } from './save/SaveState.js';
import { SAVE_LOCATION_NOTE } from './save/SaveStore.js';
import { speechDurationFrames, textDurationFrames } from './sound/speech.js';
import { ScriptEngine as ScriptEngineV2 } from './script/v2/ScriptEngine.js';
import { ScriptEngine as ScriptEngineV3 } from './script/v3/ScriptEngine.js';
import { ScriptEngine as ScriptEngineV4 } from './script/v4/ScriptEngine.js';
import { ScriptEngine } from './script/v5/ScriptEngine.js';
import { StackScriptEngine } from './script/StackScriptEngine.js';
import { ScriptEngineV6 } from './script/v6/ScriptEngine.js';
import { ScriptEngineV7 } from './script/v7/ScriptEngine.js';
import { ScriptEngineV8 } from './script/v8/ScriptEngine.js';
import {
  readDigLanguageBundle,
  readTabLanguageBundle,
  type LanguageBundle,
} from './script/v7/language.js';
import type { ScriptEngine as ScriptEngineInterface } from './script/ScriptEngine.js';
import { MAX_CUTSCENE_DEPTH, ScriptState } from './script/ScriptState.js';
import { SoundEngine } from './sound/SoundEngine.js';
import { VerbTable, type Verb } from './verbs/Verbs.js';
import type {
  AdventureEngine,
  EditableGame,
  EditableGameOptions,
  SavedGameEnvelope,
} from './AdventureEngine.js';
import { ScummInput } from './ScummInput.js';
import { SCUMM_VERSION_TARGETS, describeTarget, type Target } from '../authoring/target.js';

export interface TextOptions {
  actor: number;
  /**
   * Which of the `print` family's four destinations the line is bound for.
   *
   * Not a property of the text: it is what the original's `printString`
   * switches on, and the four are genuinely four different things — speech
   * that expires, a string painted into the picture and left there, a line
   * for whoever was building the game, and a system dialogue. Slot 0 is
   * speech, and a caller that says nothing gets it.
   *
   * A version reaches the slots by its own route. v6 and v7 have an
   * instruction per slot; v3 to v5 have one instruction and read the slot out
   * of the actor number, which is why `TEXT_SLOT_FOR_ACTOR` exists.
   */
  slot: number;
  x: number;
  y: number;
  color: number;
  right: number;
  center: boolean;
  left: boolean;
  overhead: boolean;
  hasPosition: boolean;
  text: string;
  speechOffset: number;
  speechSize: number;
}

/**
 * A string a script painted into the picture, which stays until something
 * paints over it.
 *
 * Not speech and not a queued caption: the original writes these straight into
 * the main framebuffer and never takes them down, so they last until the
 * background under them is redrawn. Here the background is re-composited every
 * frame, so lasting has to be modelled — the line is kept and drawn again each
 * frame instead.
 */
export interface PaintedString {
  text: string;
  x: number;
  y: number;
  color: number;
  charset: number;
}

/**
 * One line a v7 script asked to be drawn straight to the screen.
 *
 * v7 has no verb panel and no persistent interface: its inventory, dialogue
 * menus and Full Throttle's action wheel are all text a script re-queues every
 * frame. `centred` is the whole of its layout — the original passes an
 * alignment flag and nothing else, so `x` is either the left edge or the
 * middle depending on it. (`ScummEngine_v7::enqueueText`.)
 */
/**
 * One object a script asked to be drawn straight to the screen.
 *
 * Sam & Max's verb coin and its minigame pieces, The Dig's inventory and Full
 * Throttle's action wheel are all drawn this way: outside the room's own object
 * list, over the frame, and gone the next. `image` selects between an object's
 * several pictures, which is how one queued object becomes a highlighted verb
 * rather than an unhighlighted one. (`ScummEngine_v6::enqueueObject`.)
 */
export interface BlastObject {
  objectId: number;
  x: number;
  y: number;
  /**
   * The size a script asked for, or zero for the object's own.
   *
   * Recorded and not drawn with, because the original does not draw with it
   * either: the size only ever sized the rectangle it marked dirty, while the
   * picture's own header decides how much is decoded. A renderer that repaints
   * the whole frame has no dirty rectangle to size, so nothing is left for
   * these two to do — but they are kept, because a script that passes them is
   * not passing something we failed to read.
   */
  width: number;
  /** As `width`: the height a script asked for, or zero for the object's own. */
  height: number;
  /** 0..255, where 255 is full size. Below that, rows and columns are dropped. */
  scaleX: number;
  scaleY: number;
  /** Which of the object's images, one-based, as `IM01` upwards. */
  image: number;
  /** The original's shadow mode, which only applies at full scale. */
  mode: number;
}

export interface BlastText {
  text: string;
  x: number;
  y: number;
  color: number;
  /** The font the line is drawn in, which the queue entry carries per line. */
  charset: number;
  centred: boolean;
}

interface Sentence {
  verb: number;
  objectA: number;
  objectB: number;
  preposition: boolean;
  freezeCount: number;
}

export interface EngineOptions {
  /** Called with diagnostics the player should see. */
  onLog?: (message: string) => void;
  /**
   * Called as the engine starts each substantial piece of work.
   *
   * A freeze inside the engine stops the page repainting, so nothing already
   * written to the DOM can be read afterwards. A hook that the shell can send
   * to the console leaves a breadcrumb that survives it: the last activity
   * logged is where the engine stopped.
   */
  onActivity?: (activity: string) => void;
  /** Deterministic random source, for tests. */
  random?: () => number;
  /**
   * Collects load progress, for a status line and progress bar.
   *
   * The caller owns the tracker so it can report its own steps — booting the
   * game, say — on the same bar, instead of the bar jumping back to zero
   * between the engine's work and the shell's.
   */
  progress?: LoadProgressTracker;
  /**
   * Called when a script asks to save or load, from v6's in-game menu.
   *
   * A v6 game's save menu is its own scripts: it draws the slot list itself and
   * then reaches this opcode, so an interpreter without a hook here shows the
   * player a menu whose buttons do nothing. `flag` is 1 to save and 2 to load;
   * `slot` is the game's own slot number, not ours.
   */
  onScriptSaveLoad?: (flag: number, slot: number) => void;
}

/**
 * Where an unimplemented sub-opcode's arguments were left, and so what it cost.
 *
 * A sub-opcode is a byte after the opcode, but the arguments it describes are
 * not all read the same way, and the difference decides whether the script is
 * still readable afterwards. Saying which one it was is the difference between
 * a report that points at the fault and one that invents a second, worse fault
 * for the reader to go looking for.
 */
export type SubOpcodeEffect =
  /** Operands sit inline, and an unknown sub-opcode cannot be skipped past. */
  | 'inline'
  /** The arguments were pushed, and are still on the stack. */
  | 'stack'
  /** Every argument was read before the dispatch. */
  | 'consumed'
  /**
   * The family mixes both, so an unknown member's encoding is not knowable.
   *
   * `wait` takes a jump displacement inline for some sub-opcodes and its actor
   * off the stack for others; `parseString` reads a message out of the code for
   * one and pops the rest. Claiming either answer for a sub-opcode nobody has
   * identified is a guess, and the wrong one costs a reader a hunt.
   */
  | 'unclear';

const SUB_OPCODE_COST: Record<SubOpcodeEffect, string> = {
  inline:
    'Its operands are inline and were not consumed, so the program counter is pointing into ' +
    'them and the rest of this script is being misread.',
  stack:
    'Its arguments are still on the stack, so a later instruction will read one of them as ' +
    'its own. The instruction stream itself is intact.',
  consumed:
    'Its arguments were all read before the dispatch, so nothing after it is misread — only ' +
    'this one instruction did nothing.',
  unclear:
    'Sub-opcodes of this instruction take their operands inline or off the stack depending on ' +
    'which one it is, so whether the rest of this script is misread depends on the encoding of ' +
    'a sub-opcode nothing here knows.',
};

/**
 * How many lines of blast text one frame may carry.
 *
 * The original interpreter's queue holds fifty and asserts on the fifty-first,
 * so this is a real limit of the games rather than a chosen one: any v7 screen
 * that fits inside it in the original fits inside it here.
 * (`ScummEngine_v7::_blastTextQueue`.)
 */
const BLAST_TEXT_QUEUE_SIZE = 50;

/**
 * How many objects one frame may carry.
 *
 * The original's queue holds two hundred and errors on the two hundred and
 * first, so this is a limit of the games rather than a chosen one.
 * (`ScummEngine_v6::_blastObjectQueue`.)
 */
const BLAST_OBJECT_QUEUE_SIZE = 200;

/**
 * Bytes of header a `BOMP` carries before its runs.
 *
 * Two unused, then the width and height, then a two-byte pad in each axis.
 * v8 uses a different shape, which no game here is.
 */
const BOMP_HEADER_SIZE = 10;

/**
 * The colour a blast object treats as transparent.
 *
 * Not zero, which is what a costume cel uses: the original decodes a blast
 * object's runs with zeros written and then compares each pixel against 255 on
 * its way to the screen. Getting this the wrong way round leaves a black
 * rectangle behind the verb coin and drops whatever the artwork drew in white.
 * (`drawBlastObject` passes 255 to `bompApplyShadow`, and `drawBomp` decodes
 * with `setZero` left at its default of true.)
 */
const BLAST_OBJECT_TRANSPARENT = 255;

/** Full scale in each axis: the value that means "do not scale at all". */
const BLAST_OBJECT_FULL_SCALE = 255;

/**
 * The SCUMM v5 virtual machine and renderer.
 *
 * Responsibilities are split so each stays comprehensible: resource decoding,
 * room geometry, the bytecode interpreter, sprite rendering and audio each live
 * in their own module. This class is the world state they all operate on, and
 * the frame loop that orders their work — which is the part that has to match
 * the original's ordering to look right.
 */
export class ScummEngine implements AdventureEngine {
  /**
   * What the scripts are doing, independent of how they are encoded.
   *
   * Owned here rather than by the interpreter because ADR 0001 gives each SCUMM
   * version its own script engine over this one shared state. Declared as a
   * field so it exists before the constructor hands it to the interpreter.
   */
  readonly scriptState = new ScriptState();

  /**
   * The variable table of the version being played.
   *
   * The interpreter and the game's scripts share these slots by number, and the
   * numbers are a per-version fact: `VAR_ROOM` is 4 for v5 and v6 and 10 for
   * v7, `VAR_EGO` is 1 and 111, `VAR_KEYPRESS` is 0 and 118 — where 118 is v6's
   * `VAR_RANDOM_NR`. Naming the base table directly here, as this did, means a
   * v7 game agrees with its scripts only where the two tables coincide.
   *
   * v5's until the index says otherwise, because the version is not known until
   * a game is loaded and something has to be answerable before then.
   */
  vars: VariableMap = variablesFor(5, 0);

  /**
   * The SCUMM version being played, from the index rather than the file names.
   *
   * Kept because a handful of *engine* behaviours differ by version where the
   * instruction that asks for them does not — `loadRoomWithEgo` sets a camera
   * follow for v5 and v6 and not for v7, and the resource hints stop at the
   * global script boundary under v7 alone. Branching on it here is what keeps
   * one shared handler serving both rather than a second copy of the
   * instruction existing to carry a one-line difference.
   */
  scummVersion = 5;

  readonly screen = new Screen();
  readonly palette = new Palette();
  /**
   * The interpreter for this game's SCUMM version.
   *
   * Not `readonly`: the version is only known once the index is read, so the
   * v5 engine is built up front and replaced in `load` if the game turns out
   * to be v6. Typed as the interface, so nothing here can reach past what
   * every version provides (ADR 0001).
   */
  scripts: ScriptEngineInterface;
  readonly sound = new SoundEngine();
  readonly verbs = new VerbTable();

  resources!: ResourceManager;

  variables!: Int32Array;
  bitVariables!: Uint8Array;

  readonly actors: Actor[] = [];

  /**
   * Where global script numbers stop and room-local ones begin.
   *
   * Not a limit but a boundary: `runScript` looks a number below this up in the
   * index and one at or above it in the current room, so a number on the wrong
   * side of it is not clamped, it is looked for in the wrong place and reported
   * missing. v5 and v6 draw the line at 200 and v7 at 2000.
   * (`readMAXS` in each of ScummVM's engine classes, which sets
   * `_numGlobalScripts` rather than reading it from the block.)
   */
  numGlobalScripts = 200;

  currentRoom = 0;
  currentRoomData: Room | null = null;
  roomGraphics: RoomGraphics | null = null;
  boxes: BoxMatrix | null = null;

  /** Mutable copies of the global object tables, so scripts can change them. */
  objectState!: Uint8Array;
  objectOwner!: Uint8Array;
  objectClass!: Uint32Array;
  /**
   * Names scripts have changed at runtime. Reachable rather than private
   * because a saved game has to carry them: a renamed object whose name reverts
   * on load is a visible fault, not an internal detail.
   */
  readonly objectNameOverrides = new Map<number, string>();

  /** Object names from every room entered, so inventory items keep theirs. */
  private readonly knownObjectNames = new Map<number, string>();

  /**
   * A copy of each carried object's record, taken when it was picked up.
   *
   * An object's verbs and picture live in the room that defines it, and the
   * room's object list goes when the room does — so once an item is in the
   * player's hands its code is unreachable through `currentRoomData`. The
   * original has the same problem and solves it the same way: `addObjectToInventory`
   * copies the `OBCD` into an `rtInventory` resource that outlives the room.
   *
   * Held as a record carrying its room's buffer in {@link RoomObject.source},
   * which is the mechanism a floating object already uses, so every offset in
   * it keeps meaning something after the room is gone. Without it Day of the
   * Tentacle's panel asks each held item for its icon with
   * `getVerbEntrypoint(item, 91)`, gets nothing, and draws the empty slot.
   */
  private readonly inventoryObjects = new Map<number, RoomObject>();

  /** Object ids held by actors, in inventory order. */
  inventory: number[] = [];

  /**
   * Where the view sits in the room, on both axes.
   *
   * **x is a centre and y is a top.** Not an inconsistency but the two
   * versions' own conventions: v5 and v6 address the camera by the column it is
   * centred on, which is why `min` and `max` start half a screen in and why
   * `cameraLeft` subtracts half a screen; v7 tracks a screen *top* directly and
   * has no notion of a centred y. Reconciling them by making y a centre too
   * would mean converting at every v7 instruction, and the conversion is the
   * thing that would be got wrong.
   *
   * v5 and v6 get a y range one screen tall, so their behaviour is the
   * degenerate case of one model rather than the other side of an `if`. Nothing
   * in `Screen` or here asks which version is running (ADR 0007).
   */
  camera = {
    current: 160,
    destination: 160,
    min: 160,
    max: 160,
    /** Screen top, in room rows. Pinned to 0 for every version before v7. */
    currentY: 0,
    destinationY: 0,
    minY: 0,
    maxY: 0,
    following: 0,
    moving: false,
  };

  readonly strings = new Map<number, string>();

  charsets = new Map<number, Charset>();
  currentCharsetId = 0;

  /** Suspend counter, not a flag: input is allowed while it is positive. */
  cursorState = 1;
  userPutCount = 1;

  get userPut(): boolean {
    return this.userPutCount > 0;
  }

  get cursorVisible(): boolean {
    return this.cursorState > 0;
  }
  currentCursor = 0;

  /** Text currently on screen, in screen coordinates. */
  /**
   * The line of speech on screen, with the font it was laid out in.
   *
   * The charset is carried rather than looked up when the line is drawn: a
   * script is free to change the current font between printing a line and the
   * frames that show it, and Atlantis's title sequence does exactly that — the
   * copyright notice is measured in charset 1 and, two hundred frames later,
   * the credits switch to charset 3 while it is still up. Drawn in whatever
   * font happens to be current, its three lines were laid out eight pixels
   * apart and drawn fifteen pixels tall, overlapping each other and running
   * off the right of the screen.
   */
  private displayedText: Array<{
    text: string;
    x: number;
    y: number;
    color: number;
    charset: number;
  }> = [];
  private talkingActor = 0;
  private messageTimer = 0;

  /**
   * Strings painted into the picture and left there.
   *
   * Keyed by where each one landed, because that is what the original's
   * overwriting amounts to: `drawString` blits pixels, so printing the same
   * line at the same place in a new colour replaces it and printing a
   * different line elsewhere does not. A list would grow a stale copy of every
   * menu label each time a script re-drew it in its highlight colour.
   *
   * Cleared when the room changes, which is the point at which the original's
   * background redraw takes the pixels with it.
   */
  private readonly paintedStrings = new Map<string, PaintedString>();

  /**
   * Text a script asked to be drawn over this frame and no other.
   *
   * Nothing here survives the frame it was queued in: `step` empties the queue
   * before the scripts run, so a caption stays up only while the script keeps
   * re-queueing it. That is the whole of v7's interface text — the inventory,
   * the dialogue menus, Full Throttle's action menu — which is why it is a
   * queue rather than a single line, and why it is separate from
   * `displayedText`: speech has a lifetime of its own and this deliberately
   * does not.
   */
  private readonly blastTexts: BlastText[] = [];

  /**
   * Objects a script asked to be drawn over this frame and no other.
   *
   * Emptied where `blastTexts` is emptied and for the same reason: what a frame
   * shows is what the scripts about to run queue for it, so rendering a frame
   * twice draws it twice.
   */
  private readonly blastObjects: BlastObject[] = [];

  /**
   * Whether speech should be captioned.
   *
   * `kernelSetFunctions` 215 is a v7 script writing the player's subtitle
   * preference into the interpreter, from the options screen. Only *speech* is
   * gated: a line with no recording is the only way that line is readable, and
   * the original suppresses text for spoken lines alone.
   */
  subtitles = true;

  /** Pending sentences, and the freeze counter over them. Saved with the game. */
  readonly sentenceQueue: Sentence[] = [];
  sentenceFrozen = 0;

  /**
   * The verb the player last chose, for the sentence line.
   *
   * The interpreter needs it because it is what composes the line; the host
   * needs it too, to say what a click in the room means. Keeping it here means
   * the two cannot disagree about which verb is selected.
   */
  currentVerb = 0;

  /**
   * Whether a script has taken the sentence line over.
   *
   * A published game writes verb 0's text from its own scripts, and the moment
   * one does, composing a line here would be two authors writing to the same
   * place. A compiled project has no such script, which is the case this is
   * for: without it the verb panel drives nothing and the line stays blank
   * however the player clicks.
   */
  private sentenceLineClaimed = false;

  private readonly costumeCache = new Map<number, Costume>();
  /** Costume ids that could not be drawn, and why, for the actor report. */
  private readonly costumeFailures = new Map<number, string>();

  private pseudoRooms = new Map<number, number>();

  private lights = 0;
  private screenEffect = 0;
  private quitRequested = false;

  private readonly log: (message: string) => void;

  /** Surfaces an engine-level warning on the host's log. */
  warn(message: string): void {
    this.log(message);
  }
  private readonly onActivity: (activity: string) => void;

  /** What the engine is doing, for diagnosing a freeze. */
  activity = 'idle';
  private readonly rng: () => number;
  private readonly reportedOpcodes = new Set<number>();

  /** True while the boot script is running, so a stop there is fatal. */
  private booting = false;

  /**
   * Why the boot script did not finish, or `null` if it did.
   *
   * The engine already knows the reason at the moment it stops the script;
   * keeping it here means the load failure can quote that reason rather than
   * making the player wait for a stuck-state report to infer it.
   */
  private bootFailure: string | null = null;

  /** Scripts that hit the opcode budget, so the shell can say so. */
  readonly stuckScripts = new Set<number>();
  private readonly overrunScripts = new Set<number>();
  private readonly reportedSubOpcodes = new Set<string>();
  /** Opcode -> the script it stopped, so the shell can name the blocker. */
  readonly unknownOpcodes = new Map<number, number>();
  private reportedScriptBudget = false;

  private frameCounter = 0;

  /** Host handler for a script-driven save or load; see `EngineOptions`. */
  private readonly onScriptSaveLoad?: (flag: number, slot: number) => void;

  constructor(options: EngineOptions = {}) {
    this.log = options.onLog ?? (() => undefined);
    this.onActivity = options.onActivity ?? (() => undefined);
    this.rng = options.random ?? Math.random;
    this.onScriptSaveLoad = options.onScriptSaveLoad;
    this.scripts = new ScriptEngine(this, this.scriptState);
    this.sound.onLog = (message) => this.log(message);
  }

  // ------------------------------------------------------------- lifecycle --

  static async create(source: DataSource, options: EngineOptions = {}): Promise<ScummEngine> {
    const engine = new ScummEngine(options);
    await engine.load(source, options.progress);
    return engine;
  }

  async load(source: DataSource, progress = new LoadProgressTracker()): Promise<void> {
    // Kept for the files addressed by name rather than by the index: the audio
    // bundles, the language bundle, and every `.SAN` a script asks for by name
    // long after loading is done.
    this.source = source;
    this.attachVideo();

    const game = await detectGame(source, progress);
    this.log(
      `Detected SCUMM v${game.version} game "${game.id}" ` +
        `(index ${game.indexFile}, data ${game.dataFiles.join(', ')}, XOR 0x${game.xorKey.toString(16)})`,
    );

    this.resources = await ResourceManager.load(source, game, progress);

    // A talkie release keeps its speech in a file beside the game's own, named
    // by the detector. Read once and held whole: scripts address it by byte
    // offset, so there is nothing to index.
    if (game.speechFile) {
      const speech = await source.read(game.speechFile);
      this.sound.attachSpeech(speech ?? null);
      this.log(
        speech
          ? `Loaded ${game.speechFile} (${speech.length} bytes) for recorded speech`
          : `${game.speechFile} could not be read; the game will play with subtitles only`,
      );
    }

    // The index says which version this is, so the interpreter is chosen here
    // rather than guessed at construction.
    //
    // Written as an exact match per version rather than `>=`. A `>=` here is
    // how a later version quietly acquires an earlier one's interpreter, which
    // is the failure the version gate in `GameDetector` exists to prevent and
    // would be reintroduced one layer down.
    if (game.version === 8) {
      this.scripts = new ScriptEngineV8(this, this.scriptState);
      this.log(`Using the SCUMM v8 interpreter for "${game.id}"`);
    }
    if (game.version === 7) {
      this.scripts = new ScriptEngineV7(this, this.scriptState);
      this.log(`Using the SCUMM v7 interpreter for "${game.id}"`);
      await this.loadLanguageBundle(source);
      await this.loadSpeechBundle(source);
      this.loadVoiceFolders(source);
      await this.loadVideoFonts(source);
    }
    if (game.version === 6) {
      this.scripts = new ScriptEngineV6(this, this.scriptState);
      this.log(`Using the SCUMM v6 interpreter for "${game.id}"`);
    }
    if (game.version === 4) {
      this.scripts = new ScriptEngineV4(this, this.scriptState);
      this.log(`Using the SCUMM v4 interpreter for "${game.id}"`);
    }
    if (game.version === 3) {
      this.scripts = new ScriptEngineV3(this, this.scriptState);
      this.log(`Using the SCUMM v3 interpreter for "${game.id}"`);
    }
    if (game.version === 2) {
      this.scripts = new ScriptEngineV2(this, this.scriptState);
      this.log(`Using the SCUMM v2 interpreter for "${game.id}"`);
    }
    this.scummVersion = game.version;
    // The Dig, and nothing else. See `replacesActorsOnRebuild`.
    this.replacesActorsOnRebuild = game.version === 7 && game.id.toLowerCase() === 'dig';
    this.numGlobalScripts = game.version >= 7 ? 2000 : 200;
    this.sound.attach(this.resources);

    progress.report('preparing', 'Setting up actors and variables…');
    const limits = this.resources.limits;
    // One slot past the game's own, as the bin every variable this version has
    // no number for resolves to. A script cannot reach it: its own variables
    // are numbered below the count the index declares.
    const variableCount = Math.max(limits.numVariables, 800);
    this.variables = new Int32Array(variableCount + 1);
    this.vars = variablesFor(game.version, variableCount);
    this.bitVariables = new Uint8Array(Math.ceil(Math.max(limits.numBitVariables, 2048) / 8));

    this.objectState = this.resources.objectState.slice();
    this.objectOwner = this.resources.objectOwner.slice();
    this.objectClass = this.resources.classData.slice();

    this.actors.length = 0;
    for (let i = 0; i < limits.numActors + 1; i++) {
      const actor = new Actor(i);
      // A v7 actor defers to its walkbox from the start, and says so with a
      // value rather than with a zero — zero is a real plane there. Set here
      // as well as in `initActor`, because a script need never call that and
      // most actors are drawn long before one does.
      if (game.version >= 7) {
        actor.defaultForceClip = V7_CLIP_FROM_BOX;
        actor.forceClip = V7_CLIP_FROM_BOX;
      }
      this.actors.push(actor);
    }

    this.inventory = new Array(limits.numInventory).fill(0);

    this.resetGameState();
  }

  private resetGameState(): void {
    this.variables.fill(0);
    this.bitVariables.fill(0);

    this.variables[this.vars.EGO] = 1;
    this.variables[this.vars.NUM_ACTOR] = this.actors.length - 1;
    this.variables[this.vars.MACHINE_SPEED] = 1;
    this.variables[this.vars.CURRENTDRIVE] = 2;
    this.variables[this.vars.FIXEDDISK] = 1;
    this.variables[this.vars.SOUNDCARD] = 3; // AdLib; the value games expect to exist
    this.variables[this.vars.VIDEOMODE] = 19; // VGA
    this.variables[this.vars.HEAPSPACE] = 1400;
    this.variables[this.vars.TALKSTOP_KEY] = 27;
    this.variables[this.vars.CUTSCENEEXIT_KEY] = 27;
    this.variables[this.vars.RESTART_KEY] = 0x13b; // F1
    this.variables[this.vars.PAUSE_KEY] = 32;
    this.variables[this.vars.MAINMENU_KEY] = 0x13f; // F5
    this.variables[this.vars.TIMER_NEXT] = 0;
    this.variables[this.vars.CHARINC] = 4;
    // Lit, because nothing else ever sets this and zero means pitch dark.
    //
    // The interpreter owns the initial value (`resetScummVars`); a game changes
    // it when a room *is* dark and otherwise never touches it. Left at zero,
    // Atlantis answers "It's too dark to see it." to every single look, in
    // every room, for the whole game — the newspaper outside the theatre on a
    // lit New York street included. The value is the conventional "normal
    // lighting" one: actors lit by the room's palette, the background drawn,
    // the screen lit. Which bits those are does not matter to this game, whose
    // scripts test the variable against zero and nothing finer.
    this.variables[this.vars.CURRENT_LIGHTS] = 11;
    this.variables[this.vars.DEBUGMODE] = 0;
    this.variables[this.vars.INPUTMODE] = 3; // mouse
    this.variables[this.vars.MEMORY_PERFORMANCE] = 100;
    this.variables[this.vars.VIDEO_PERFORMANCE] = 100;
    // Expanded memory, in kilobytes, as the original reports it
    // (`VAR_EMS_SPACE = 10000` in `resetScumm`). It is not a number this
    // engine has any use for; it is a number the *game* checks. Left at zero,
    // Day of the Tentacle opens on "WARNING: EMS detects less than 2
    // megabytes." and sits on that screen for the best part of a minute before
    // it will start — which reads exactly like a slow interpreter.
    this.variables[this.vars.EMS_SPACE] = 10000;
    // 0 is voice, 1 voice and text, 2 text only. The interpreter owns the
    // initial value; a talkie's options screen changes it.
    this.variables[this.vars.VOICE_MODE] = this.subtitles ? 1 : 0;
    this.cursorState = 1;
    this.userPutCount = 1;
    this.variables[this.vars.CURSORSTATE] = 1;
    this.variables[this.vars.USERPUT] = 1;

    this.applyGameQuirks();

    // A v6 game's index declares arrays that have to exist before any script
    // runs, and each one's handle lives in a variable this method has just
    // cleared — so they are seeded here rather than at load, and are seeded
    // again by a restart.
    this.scriptState.arrays.clear();
    if (this.scripts instanceof StackScriptEngine) this.scripts.seedDeclaredArrays();

    for (const actor of this.actors) actor.reset();
    this.verbs.reset();
    this.sentenceQueue.length = 0;
    this.screen.setLayout(16, 144);
  }

  /** Records what the engine is about to do. Cheap: a string and a callback. */
  private setActivity(activity: string): void {
    this.activity = activity;
    this.onActivity(activity);
  }

  /**
   * What every live script is doing, one line each.
   *
   * A script waiting for a condition that never becomes true is silent: it
   * yields politely every frame and nothing is wrong enough to report. This is
   * the only way to see one — the offset says where it is parked, and the
   * opcode there says what it is waiting for.
   */
  /**
   * Every actor the game has placed, and whether anything will draw it.
   *
   * `drawActors` needs four things true at once — a non-zero number, a costume,
   * visibility, and the current room — and any one of them missing produces the
   * same thing on screen: nothing at all, with no error. An actor whose costume
   * does not decode, or which stands below the room view and is clipped away
   * entirely, is equally absent and equally quiet. Naming which condition
   * failed is the difference between "the player is not there" and somewhere to
   * look.
   */
  /**
   * Bit variables whose writes are logged, named from the console while tracing.
   *
   * A SCUMM script waits by spinning on a bit variable: yield, re-test, yield.
   * When one never comes true the game sits there with no error and every script
   * behaving correctly, and the only question worth asking is which script was
   * supposed to set it. `scumm.watchedBits.add(35)` answers that, and an empty
   * log answers it too — nothing ever tried.
   */
  readonly watchedBits = new Set<number>();

  /**
   * Logs every script start and stop, set from the console while tracing.
   *
   * A snapshot of the running slots says what is happening now; it cannot say
   * what ran and finished in between, which is where a sequence that never
   * reaches its next step shows up. Off by default because a running game
   * starts scripts constantly.
   */
  traceScripts = false;

  /** A diagnostic line from one of the tracing hooks outside this class. */
  trace(message: string): void {
    this.log(message);
  }

  /** Logs a write to a watched bit, and which script made it. */
  reportBitWrite(bit: number, value: number, script?: number): void {
    if (!this.watchedBits.has(bit)) return;
    this.log(`bit ${bit} = ${value} by script ${script ?? 'unknown'}`);
  }

  /**
   * Whether the player is allowed to do anything, and what is stopping them.
   *
   * A game inside a cutscene ignores clicks by design — `handleRoomClick`
   * returns early on `userPut` — so "the room is drawn and nothing responds" is
   * either a bug or the game working exactly as intended, and the two look
   * identical from the outside. The cutscene depth is what tells them apart: a
   * cutscene that never ends leaves input off for good.
   */
  describeInputState(): string {
    const stack = this.scriptState.cutSceneStack;
    const depth = stack.length;
    // Depth alone does not mean input is off. Nothing in `beginCutscene`
    // touches `userPut`: the game's own cutscene start script is what suspends
    // input, so a depth with input still on is a real and different state, and
    // saying "input is off" on the strength of the depth sent a reader looking
    // for the wrong fault.
    const note =
      depth === 0
        ? ''
        : this.userPut
          ? ' (a cutscene is running, but input is still on)'
          : ' (input is off because a cutscene is running)';
    // The depth-0 skip point is worth saying on its own line's worth of the
    // summary: a game can arm one with no cutscene open at all, and whether
    // the player can escape what is playing is the first thing to know about a
    // scene that will not end.
    const armed = this.scriptState.cutSceneOverrides[depth];
    const skip = armed.pointer >= 0 ? `, skip @${armed.pointer}` : '';
    const summary =
      `userPut ${this.userPut ? 'on' : 'off'}, ` +
      `cursor ${this.cursorVisible ? 'on' : 'off'}, ` +
      `cutscene depth ${depth}${skip}${note}`;

    if (depth === 0) return summary;

    // Which cutscene, not just how many: enough to tell one still running from
    // one whose script has died holding the level open.
    const levels = stack.map((level, index) => {
      const owner = this.scriptState.slots[level.ownerSlot];
      const alive =
        owner && owner.status !== ScriptStatus.Dead && owner.number === level.ownerScript;
      // A level's own skip point is the one armed at its depth, and the first
      // level sits at depth 1.
      const point = this.scriptState.cutSceneOverrides[index + 1];
      return (
        `script ${level.ownerScript}${alive ? '' : ' (gone)'}, data ${level.data}, ` +
        (point.pointer >= 0 ? `skip @${point.pointer}` : 'no skip point')
      );
    });

    return `${summary}; cutscenes: ${levels.join(' | ')}; override ${this.variables[this.vars.OVERRIDE]}`;
  }

  /**
   * Which of the room's objects are on screen, and why the rest are not.
   *
   * The companion to `describeActorState`. A room that draws its background and
   * nothing else is the commonest shape of "the game is stuck", and without
   * this the report could not say whether the objects were missing, hidden by
   * their state, or simply had no artwork to draw.
   */
  describeObjectState(): string {
    const room = this.currentRoomData;
    if (!room) return 'no room loaded';

    const lines: string[] = [];
    let hotspots = 0;

    for (const object of room.objects) {
      // Objects with no artwork are hotspots; they are never drawn and saying
      // so once is more use than a line each.
      if (!object.image) {
        hotspots++;
        continue;
      }

      const state = this.getState(object.id);
      const owner = this.getOwner(object.id);
      const width = object.width || object.image.width;
      const height = object.height || object.image.height;

      const missing: string[] = [];
      // `OF_OWNER_ROOM` is the room itself, so an object owned by it is
      // present. Reading the room as owner 0 reported every object in every
      // room as carried by somebody, which named the wrong fault.
      if (!this.isObjectInRoom(object.id)) missing.push(`owned by ${owner}, so not in the room`);
      if (state === 0) missing.push('state 0');
      else if (
        findObjectImage(this.objectBytes(object, room), object.image.obimOffset, state) === null
      ) {
        missing.push(`no image for state ${state}`);
      }
      if (width === 0 || height === 0) missing.push('zero sized');

      lines.push(
        `object ${object.id}${object.name ? ` (${object.name})` : ''}: ` +
          `at ${object.x},${object.y}, state ${state}, ` +
          (missing.length > 0 ? `NOT DRAWN — ${missing.join('; ')}` : 'drawn'),
      );
    }

    if (hotspots > 0) lines.push(`${hotspots} more with no image of their own`);

    return lines.length > 0 ? lines.join(' | ') : 'no objects in this room';
  }

  describeActorState(): string {
    const ego = this.variables[this.vars.EGO];
    const cameraX = this.cameraLeft();
    const roomWidth = this.roomGraphics?.width ?? SCREEN_WIDTH;
    const lines: string[] = [];

    for (const actor of this.actors) {
      // Actors the game never touched would bury the ones it did.
      if (actor.number === 0 || (actor.costume === 0 && actor.room === 0)) continue;

      const missing: string[] = [];
      if (!actor.visible) missing.push('hidden');
      if (actor.costume === 0) missing.push('no costume');
      else {
        const problem = this.costumeProblem(actor.costume);
        if (problem) missing.push(`costume ${actor.costume} ${problem}`);
      }

      missing.push(...this.actorPlacementProblems(actor.number, cameraX, roomWidth));

      lines.push(
        `actor ${actor.number}${actor.number === ego ? ' (ego)' : ''}: ` +
          `room ${actor.room}, costume ${actor.costume}, at ${actor.x},${actor.y}, ` +
          `box ${actor.walkbox}, ` +
          (missing.length > 0 ? `NOT DRAWN — ${missing.join('; ')}` : 'drawn'),
      );
    }

    return lines.length > 0 ? lines.join(' | ') : 'no actors placed';
  }

  /**
   * Why an actor's position keeps it off screen, in the reader's terms.
   *
   * Separated from the report because the report is not the only caller: the
   * editor's Play has to *decide* whether the player ended up somewhere it can
   * be seen, and a decision made by matching against report text would drift
   * away from the report the first time either was reworded.
   *
   * Empty means the position is fine. It says nothing about the actor's
   * costume or its visibility flag, which are different faults with different
   * fixes; this answers only "is it anywhere the screen shows".
   */
  actorPlacementProblems(
    number: number,
    cameraX: number = this.cameraLeft(),
    roomWidth: number = this.roomGraphics?.width ?? SCREEN_WIDTH,
  ): string[] {
    const actor = this.getActor(number);
    if (!actor) return [];

    if (!actor.isInCurrentRoom(this.currentRoom)) {
      return [`in room ${actor.room}, not ${this.currentRoom}`];
    }

    const problems: string[] = [];
    // Actors draw at `y + view.top`, so anything at or past the view's own
    // height is behind the verb panel: not merely low but absent.
    if (actor.y - actor.elevation >= this.screen.main.height) {
      problems.push(`y ${actor.y} is below the ${this.screen.main.height} row room view`);
    }
    // And the same question sideways, which this verdict never asked. An actor
    // parked off to the side puts no pixel on screen either, so calling it
    // drawn sent a reader into the renderer after a fault that was really a
    // placement one.
    const sideways = this.offScreenHorizontally(actor, cameraX, roomWidth);
    if (sideways) problems.push(sideways);
    return problems;
  }

  /**
   * Why an actor's horizontal position keeps it off screen, if it does.
   *
   * Three answers rather than one, because they send a reader to three
   * different places: parked at the hiding position is a script decision, a
   * position outside the room is a placement fault, and a position the camera
   * is not looking at is neither — the actor is where it should be and the
   * camera is elsewhere.
   */
  private offScreenHorizontally(actor: Actor, cameraX: number, roomWidth: number): string | null {
    if (actor.x <= OFF_SCREEN_POSITION) {
      return `x ${actor.x} is the position scripts park an actor at to hide it`;
    }
    if (actor.x < 0 || actor.x >= roomWidth) {
      return `x ${actor.x} is outside the ${roomWidth} pixel wide room`;
    }
    const screenX = actor.x - cameraX;
    if (screenX < 0 || screenX >= SCREEN_WIDTH) {
      return `x ${actor.x} is off camera, which shows ${cameraX} to ${cameraX + SCREEN_WIDTH - 1}`;
    }
    return null;
  }

  /**
   * Which of the room's objects the cursor could reach, and why the rest not.
   *
   * The companion to `describeObjectState`, which says whether an object is
   * *drawn*. Whether it can be *touched* is a different question with different
   * answers, and it is the one behind a room that responds to nothing: no name
   * on hover, no verb, no click.
   */
  describeTouchability(): string {
    const room = this.currentRoomData;
    if (!room) return 'no room loaded';

    const lines: string[] = [];
    let reachable = 0;

    for (let i = 0; i < room.objects.length; i++) {
      const object = room.objects[i];
      const rejection = this.touchRejection(room, i);
      const sized = object.width > 0 && object.height > 0;

      if (rejection === null && sized) reachable++;

      const why = rejection ?? (sized ? null : 'zero sized, so no point can be inside it');
      lines.push(
        `object ${object.id}${object.name ? ` (${object.name})` : ''}: ` +
          `at ${object.x},${object.y} ${object.width}x${object.height}, ` +
          `parent ${object.parent}/state ${object.parentState}, ` +
          (why === null ? 'reachable' : `UNREACHABLE — ${why}`),
      );
    }

    return `${reachable} of ${room.objects.length} reachable\n${lines.join('\n')}`;
  }

  describeScriptState(): string {
    const lines: string[] = [];
    for (const slot of this.scriptState.slots) {
      if (!slot.isRunning) continue;
      const opcode = slot.data?.[slot.offset];
      const parts = [
        `script ${slot.number}`,
        `offset ${slot.offset}`,
        `opcode 0x${(opcode ?? 0).toString(16).padStart(2, '0')}`,
      ];
      if (slot.delayed) parts.push(`delay ${slot.delay}`);
      if (slot.freezeCount > 0) parts.push(`frozen ${slot.freezeCount}`);
      // A script parked in a polling loop is waiting on the comparison just
      // before its program counter, so the bytes around it name the variable
      // it is waiting for.
      if (slot.data) parts.push(hexWindow(slot.data, slot.offset, 12, 8));
      lines.push(parts.join(', '));
    }
    return lines.length > 0 ? lines.join('; ') : 'no scripts running';
  }

  /**
   * Values a particular release expects the interpreter to have measured.
   *
   * Monkey Island 1 CD will not start until it has checked the length of the
   * second audio track on the disc: its logo script requires variable 74
   * ("track-b-size") to be between 1200 and 1250, and otherwise prints "Game
   * Requires Monkey Island CD in Drive!" and goes no further. There is no disc
   * to measure here, so a value inside the range is reported, which is what
   * ScummVM does too.
   */
  private applyGameQuirks(): void {
    if (this.resources?.game.id !== 'monkey') return;
    this.variables[74] = 1225;
    this.log('Monkey Island 1: reporting a CD audio track length its logo script accepts');
  }

  /**
   * Runs the boot script, which sets everything else up.
   *
   * Throws when the boot script was stopped rather than allowed to finish.
   * It used to return normally either way, so the caller logged "Boot script
   * finished", hid the progress bar and put `Ready` on the status line — three
   * lines after the engine had already said the game could not start. The only
   * thing that eventually contradicted `Ready` was the stuck-state report ten
   * seconds later, which described symptoms the engine had known the cause of
   * all along.
   *
   * The failure is raised rather than exposed as a field so a caller cannot
   * present a dead session as a live one by forgetting to look.
   */
  boot(bootParam = 0): void {
    this.setActivity('running the boot script');
    this.bootFailure = null;
    this.booting = true;
    try {
      this.scripts.runScript(1, false, false, [bootParam]);
    } finally {
      this.booting = false;
      this.setActivity('idle');
    }

    if (this.bootFailure) throw new Error(this.bootFailure);
  }

  // ------------------------------------------------------------ frame loop --

  /**
   * Advances the world by one frame.
   *
   * The ordering matters and mirrors the original: scripts run first and may
   * change the room, then actors move, then everything is composited. Drawing
   * before moving would show a frame of stale positions after every script that
   * teleports an actor.
   */
  step(): void {
    if (this.quitRequested) return;
    this.frameCounter++;

    // A video owns the frame while it plays. The scripts do not run, the actors
    // do not move and the palette does not cycle, because in the original the
    // script that asked for the video is still inside that instruction — this
    // is what "blocking" looks like when the host owns the only loop.
    //
    // The mixer keeps running: its job is to keep audio already queued playing
    // on time, and a cutscene is mostly audio.
    if (this.video.active) {
      this.video.advance(this.screen.pixels);
      this.sound.step(this.ticksPerStep / 60);
      return;
    }

    // Emptied here rather than after drawing, so that `render` may be called
    // more than once for a frame and draw the same thing each time. What a
    // frame shows is what the scripts about to run queue for it.
    this.blastTexts.length = 0;
    this.blastObjects.length = 0;

    // The length of this cycle, in sixtieths. Everything below that counts in
    // sixtieths rather than in cycles is given it, because a cycle is not a
    // sixtieth: at Day of the Tentacle's rate one cycle is six of them, and a
    // counter that ticks down by one per cycle runs six times too slowly.
    const jiffies = this.jiffiesPerStep;

    this.scripts.resumeBrokenScripts();
    this.scripts.updateScriptDelays(jiffies);

    this.updateTimers();
    this.scripts.runAllScripts();
    this.checkAndRunSentenceScript();

    this.moveCamera();
    this.walkActors();
    this.animateActors();
    this.updateTalk(jiffies);

    this.palette.step(this.paletteCycleJiffies);
    this.sound.step(this.ticksPerStep / 60);
    this.updateMusicTimer();
  }

  /**
   * Sixtieths of a second this tick stands for, from the game's own variable.
   *
   * A SCUMM game paces itself: it writes `VAR_TIMER_NEXT` and the interpreter
   * waits that many sixtieths before the next cycle, so the game's cycle rate
   * is `60 / VAR_TIMER_NEXT`. Day of the Tentacle asks for six, which is ten
   * cycles a second — an actor moving ten pixels a cycle crosses the screen in
   * three seconds, as it should. Run at sixty and it crosses in half of one.
   *
   * Clamped at the bottom because a zero would be a cycle of no length and the
   * game would never advance, and at the top so a game that asks for a very
   * long wait still answers a click this side of a second. Both bounds are the
   * original's.
   */
  get ticksPerStep(): number {
    const requested = this.variables[this.vars.TIMER_NEXT];
    if (!Number.isFinite(requested) || requested < 1) return 1;
    return Math.min(requested, 60);
  }

  /**
   * The cycle's length as the countdowns get it, capped the way the original
   * caps it.
   *
   * `scummLoop` clamps its delta to fifteen before it reaches
   * `decreaseScriptDelay` and the talk delay, and only those: the general
   * timers above are given the raw value. The cap matters when a game asks for
   * a very long cycle — without it a single cycle could retire a delay that
   * was meant to outlast several.
   */
  private get jiffiesPerStep(): number {
    return Math.min(this.ticksPerStep, 15);
  }

  /**
   * Sixtieths a colour cycle advances by, which is not simply the cycle length.
   *
   * `cyclePalette` counts `max(VAR_TIMER, VAR_TIMER_NEXT)` rather than the
   * delta the loop was actually run with, so a game that under-reports one of
   * them still cycles at the rate its artwork was drawn for.
   */
  private get paletteCycleJiffies(): number {
    return Math.max(this.variables[this.vars.TIMER], this.variables[this.vars.TIMER_NEXT], 1);
  }

  private updateTimers(): void {
    // The three general-purpose timers count *sixtieths*, not cycles, so they
    // advance by the length of the cycle rather than by one. A game reading
    // them to time something in seconds is otherwise out by whatever rate it
    // happens to be running at.
    const delta = this.ticksPerStep;
    this.variables[this.vars.TMR_1] += delta;
    this.variables[this.vars.TMR_2] += delta;
    this.variables[this.vars.TMR_3] += delta;
    this.variables[this.vars.TIMER] = delta;
    this.variables[this.vars.TIMER_TOTAL] += delta;
  }

  /**
   * Publishes how far into the music the game has got.
   *
   * `VAR_MUSIC_TIMER` is not a clock. It is the *position of the piece that is
   * playing*, in half-beats, and it goes back to zero when the music stops —
   * `Sound::updateMusicTimer` reads it off the sequencer every cycle
   * (`getMusicTimer` is `tick * 2 / PPQN` of the furthest-on player). Games
   * pace scenes against it precisely because it follows the music rather than
   * the wall: a line lands on a beat because the script waited for the beat.
   *
   * Counted here as a free-running total instead, it did neither job. It never
   * returned to zero, so a script waiting for the music to reach a bar was
   * already past it and ran the whole scene at once; and it ran at the cycle
   * rate rather than the score's, so where it did gate something the gate
   * opened at the wrong moment.
   */
  private updateMusicTimer(): void {
    const position = this.sound.musicTimer();
    if (position !== null) {
      this.variables[this.vars.MUSIC_TIMER] = position;
      return;
    }

    // There is no position to report, so the variable is kept moving instead.
    // Whatever drives this in the original — a sound driver's own tick, iMUSE's
    // sequencer, or the position of a CD — it is a timer, and the one thing a
    // timer never does is stop. A script waiting for it to pass a value waits
    // out the session if it does.
    //
    // Loom CD is the game that proves the point, because its score is not in
    // the game at all: it was pressed as audio tracks, and this interpreter has
    // no disc. Its opening menu prints "Please choose your skill level.", waits
    // for `VAR_MUSIC_TIMER` to pass 26, and only then arms the three buttons —
    // so with the variable pinned, the menu draws, the prompt appears, and
    // clicking STANDARD, PRACTICE or EXPERT does nothing whatsoever. Nothing
    // reports a fault: the scripts are all behaving correctly and one of them
    // is waiting for a piece of music that was never going to play.
    //
    // The condition used to be "is there an audio context", which is a
    // different question and answered yes in every browser — so this ran in the
    // headless tools, where there is no context, and never where a player was.
    this.variables[this.vars.MUSIC_TIMER] += this.ticksPerStep;
  }

  /** Composites the frame: room, objects (already stamped), actors, UI, text. */
  render(): void {
    // `step` has already put the video's frame in the framebuffer, and nothing
    // else may draw over it: a verb panel composited on top of a cutscene is
    // the failure this early return exists to prevent.
    if (this.video.active) return;

    if (this.roomGraphics) {
      this.screen.drawRoom(this.roomGraphics, this.cameraLeft(), this.cameraTop());
    } else {
      this.screen.clear(0);
    }

    this.drawActors();
    this.drawVerbs();
    // Over the actors, because a verb coin is drawn on top of the person it
    // was opened on; under the text, because the coin's own labels are text.
    this.drawBlastObjects();
    // Under the speech and over everything else: these are pixels in the
    // picture in the original, so a line of dialogue is drawn on top of them.
    this.drawPaintedStrings();
    this.drawText();
    this.drawBlastTexts();
  }

  /**
   * The topmost visible room row.
   *
   * Clamped here rather than trusted, for the same reason `cameraLeft` clamps:
   * a room shorter than the band has nowhere to scroll, and a destination past
   * its end would otherwise draw from beyond the artwork.
   */
  private cameraTop(): number {
    const roomHeight = this.currentRoomData?.height ?? 0;
    const visible = this.screen.main.height;
    return Math.max(0, Math.min(this.camera.currentY, roomHeight - visible));
  }

  private cameraLeft(): number {
    const roomWidth = this.roomGraphics?.width ?? SCREEN_WIDTH;
    const half = SCREEN_WIDTH >> 1;
    return Math.max(0, Math.min(this.camera.current - half, roomWidth - SCREEN_WIDTH));
  }

  // ------------------------------------------------------------ saved games --

  /**
   * The whole of the game's state, as plain JSON.
   *
   * Neither v6 game is finishable in one sitting, so this is what "completable"
   * rests on. The format is this interpreter's own and is not interchangeable
   * with ScummVM's (ADR 0002).
   */
  saveState(name = ''): SavedGame {
    return captureState(this, name);
  }

  /**
   * Puts a saved game back, or throws saying why it cannot.
   *
   * Refused rather than half-applied when the format, the game or the SCUMM
   * version does not match: a partly restored game is a set of symptoms with no
   * cause, and every one of them looks like an engine bug.
   */
  loadState(saved: SavedGameEnvelope): void {
    // Taken as the shared envelope rather than as `SavedGame`, so a save from
    // the other Engine family arrives here as data to refuse rather than as a
    // type error nobody sees at runtime. `restoreState` does the refusing, and
    // does it before touching any state (ADR 0002).
    restoreState(this, saved as SavedGame);
  }

  // ----------------------------------------------------------------- rooms --

  /**
   * Switches rooms.
   *
   * The exit script of the old room runs before anything is torn down and the
   * entry script of the new one runs after everything is in place, because both
   * scripts expect to see a fully valid world.
   */
  startScene(room: number, actor: Actor | null, objectId: number): void {
    this.setActivity(`entering room ${room}`);
    this.stopTalk();
    this.clearPaintedStringsOverTheRoom();
    this.runExitScript();

    for (const a of this.actors) {
      if (a.isInCurrentRoom(this.currentRoom)) a.visible = false;
    }

    this.scripts.killScriptsAndResources();
    this.clearRoomObjects();

    this.enterRoomData(room);

    if (actor) actor.room = room;
    void objectId;

    // Every actor already standing in the new room becomes visible, not just
    // the one that brought the player here. A script places its cast *before*
    // it loads the room they are in — Day of the Tentacle puts all three kids
    // in the mansion and then changes room by pointing the camera at Bernard —
    // so a room load that only showed the actor handed to it opened on an
    // empty room, correct in every other respect, with the player invisible.
    this.showActorsInRoom();

    this.runEntryScript();
  }

  /**
   * Makes a room current, without running a script.
   *
   * The half of `startScene` that is about *data*: the room resource, its
   * palette, boxes, background and object images. No exit script before it and
   * no entry script after, which is what a restored saved game needs — the
   * scripts already ran, in the session that saved, and running them again
   * would replay whatever they set up on arrival.
   */
  enterRoomData(room: number): void {
    this.currentRoom = room;
    this.variables[this.vars.ROOM] = room;

    // A room number of 128 or more is a *pseudo-room*: a name the scripts use
    // for a place whose artwork is shared with another room, resolved through
    // the table `pseudoRoom` fills in. The player's room stays the number the
    // script asked for — that is what its own scripts test — but the resource
    // loaded is the one the table names (`ensureResourceLoaded`, which maps
    // `rtRoom` above 0x7F, and `_roomResource`).
    //
    // Unmapped, every one of them is a room the data file does not have.
    // Atlantis leans on them: walking through a door in a dozen rooms asks for
    // 130, 132, 141, 144 and on up to 226, and each was a dead end.
    const resourceRoom = this.pseudoRoomResource(room);
    this.variables[this.vars.ROOM_RESOURCE] = resourceRoom;

    if (room === 0) {
      this.currentRoomData = null;
      this.roomGraphics = null;
      this.boxes = null;
      return;
    }

    const resource = this.resources.getRoom(resourceRoom);
    if (!resource) {
      this.log(
        resourceRoom === room
          ? `Room ${room} is missing from the data file`
          : `Room ${room} maps to room ${resourceRoom}, which is missing from the data file`,
      );
      this.currentRoomData = null;
      return;
    }

    const parsed = new Room(
      resourceRoom,
      resource,
      this.resources.game.version,
      this.resources.roomSources(resourceRoom),
    );
    this.currentRoomData = parsed;

    // The room's size, which its own scripts read: v6 keeps it in variables 41
    // and 54 and `setupRoomSubBlocks` fills them in on every room change. Left
    // at zero, a script that positions anything relative to the room's edge —
    // and Day of the Tentacle's do, for the inventory panel and for objects it
    // places by arithmetic rather than by literal — works from a room it thinks
    // is nothing wide.
    this.variables[this.vars.ROOM_WIDTH] = parsed.width;
    this.variables[this.vars.ROOM_HEIGHT] = parsed.height;

    if (parsed.palette) {
      this.palette.setFromClut(parsed.palette);
      this.palette.normaliseDepth();
    }
    this.palette.setCycles(parsed.cycles.map((cycle) => ({ ...cycle })));

    this.boxes = new BoxMatrix(parsed.boxes, parsed.scaleSlots);

    this.setActivity(
      `decoding room ${room} background (${parsed.width}x${parsed.height}, ` +
        `${parsed.numZPlanes} z-planes)`,
    );
    this.roomGraphics = new RoomGraphics(
      parsed.width,
      parsed.height,
      parsed.numZPlanes,
      parsed.transparentColor,
    );
    this.decodeRoomBackground(parsed);

    this.camera.min = SCREEN_WIDTH >> 1;
    this.camera.max = Math.max(this.camera.min, parsed.width - (SCREEN_WIDTH >> 1));
    this.variables[this.vars.CAMERA_MIN_X] = this.camera.min;
    this.variables[this.vars.CAMERA_MAX_X] = this.camera.max;

    // The y range is the room's height less the visible band, so a room no
    // taller than the screen gets a range of zero and cannot scroll — which is
    // every v5 and v6 room, and is why they need no version check to behave as
    // they always have.
    this.camera.minY = 0;
    this.camera.maxY = Math.max(0, parsed.height - this.screen.main.height);
    this.camera.currentY = Math.min(this.camera.currentY, this.camera.maxY);
    this.camera.destinationY = this.camera.currentY;

    this.resetRoomObjects();
  }

  private runExitScript(): void {
    const exitScript = this.variables[this.vars.EXIT_SCRIPT];
    if (exitScript) this.scripts.runScript(exitScript, false, false, []);

    const local = this.currentRoomData?.scripts.exit;
    if (local && this.currentRoomData) {
      this.runRoomCodeBlock(local.offset, this.currentRoomData.scriptData, 10001);
    }

    const exitScript2 = this.variables[this.vars.EXIT_SCRIPT2];
    if (exitScript2) this.scripts.runScript(exitScript2, false, false, []);
  }

  private runEntryScript(): void {
    const entryScript = this.variables[this.vars.ENTRY_SCRIPT];
    if (entryScript) this.scripts.runScript(entryScript, false, false, []);

    const local = this.currentRoomData?.scripts.entry;
    if (local && this.currentRoomData) {
      this.runRoomCodeBlock(local.offset, this.currentRoomData.scriptData, 10002);
    }

    const entryScript2 = this.variables[this.vars.ENTRY_SCRIPT2];
    if (entryScript2) this.scripts.runScript(entryScript2, false, false, []);
  }

  /** Runs an ENCD/EXCD block, which has no script number of its own. */
  private runRoomCodeBlock(offset: number, data: Uint8Array, pseudoNumber: number): void {
    this.scripts.runInlineScript(pseudoNumber, data, offset, ObjectWhere.Room);
  }

  // --------------------------------------------------------------- objects --

  private clearRoomObjects(): void {
    // Object state lives in the global tables, so only the room-local view of
    // the objects is discarded here.
    this.objectNameOverrides.clear();
  }

  private resetRoomObjects(): void {
    const room = this.currentRoomData;
    if (!room || !this.roomGraphics) return;

    // Remembered before anything else, so an object carried out of here can
    // still be named once the room's own object list is gone.
    for (const object of room.objects) {
      if (object.name !== '') this.knownObjectNames.set(object.id, object.name);
    }

    for (const object of room.objects) {
      object.state = this.getState(object.id);
      if (object.state !== 0 && this.isObjectInRoom(object.id)) {
        this.drawObjectImage(object, object.state);
      }
    }
  }

  /**
   * The buffer an object's offsets are relative to.
   *
   * The room's own, unless the object floated in from another room and brought
   * that room's buffer with it. Every read of an object's image or code goes
   * through here, because reading a floating object against the room it sits in
   * decodes whatever bytes happen to be at that offset.
   */
  private objectBytes(object: RoomObject, room: Room): Uint8Array {
    return object.source ?? room.data;
  }

  /** Stamps an object's current image into the room background. */
  private drawObjectImage(object: RoomObject, state: number): void {
    const room = this.currentRoomData;
    if (!room || !this.roomGraphics || !object.image) return;

    const small = this.resources.game.version < 5;
    const data = this.objectBytes(object, room);
    const imageOffset = findObjectImage(data, object.image.obimOffset, state, small);
    if (imageOffset === null) return;

    const width = object.width || object.image.width;
    const height = object.height || object.image.height;
    if (width === 0 || height === 0) return;

    if (small) {
      // A v2-v4 object picture is the same strip table its room's background
      // is, and it is *not* a `SMAP` — reading it as one finds no chunk and
      // draws nothing, or finds two bytes of the picture that read as a tag
      // and draws that. Both look like an object that is simply absent.
      this.roomGraphics.decodeSmallImage(
        data,
        imageOffset,
        object.x,
        object.y,
        width,
        height,
        room.paletteColours > 0 && room.paletteColours <= 16,
      );
      return;
    }

    this.roomGraphics.decodeImage(data, imageOffset, object.x, object.y, width, height, false);
  }

  /**
   * Draws an object in a state, and *records* that state.
   *
   * The recording is the half that was missing. An object's state lives in the
   * global table, not on the room's copy of the object: `setObjectState` ends
   * in `putState`, and every later reading of the object — a script asking
   * `getState`, the room being restamped after any other object changes,
   * coming back into the room at all — goes to that table. Written only onto
   * the room's copy, the drawing survived exactly until the next thing that
   * redrew the background, and then the object reverted to the picture the
   * table still said it had: a door that shut itself, a lever that sprang
   * back, a machine that undid what a script had just done to it.
   */
  drawObject(objectId: number, state: number): void {
    const object = this.currentRoomData?.findObject(objectId);
    if (!object) return;
    if (objectId >= 0 && objectId < this.objectState.length) {
      this.objectState[objectId] = state;
    }
    object.state = state;
    // Through the background rather than straight on top of it, because the
    // picture being replaced is already stamped there. A new state whose
    // artwork is smaller than the old one's — a closed door where an open one
    // was, a machine with a panel shut — leaves the difference behind when it
    // is only drawn over.
    this.refreshRoomBackground();
  }

  /**
   * Moves an object within its room.
   *
   * Positions arrive in strips and rows of eight, which is the unit every
   * version's instruction passes them in.
   *
   * `withWalkPoint` shifts the object's walk-to point by the same amount, which
   * is v5's rule and only v5's: `o5_drawObject` moves `walk_x`/`walk_y` with
   * the object so an actor still walks to the same place *on* it, while v6's
   * `setObjectState` leaves the point where it was. Moved without it, an actor
   * sent to a relocated object walks to where the object used to be.
   */
  setObjectPosition(objectId: number, x: number, y: number, withWalkPoint = false): void {
    const object = this.currentRoomData?.findObject(objectId);
    if (!object) return;
    const newX = x * 8;
    const newY = y * 8;
    if (withWalkPoint) {
      object.walkX += newX - object.x;
      object.walkY += newY - object.y;
    }
    object.x = newX;
    object.y = newY;
  }

  /**
   * Hides every *other* object that occupies exactly the same box.
   *
   * v5's way of swapping the picture at a spot. `o5_drawObject` puts every
   * object with the same position and size to state 0 before it draws the one
   * it was asked for, because a room stores each appearance of a thing as its
   * own object stacked on the same rectangle — the open door and the shut one,
   * the lit sign and the dark one. Without it both are stamped and the one
   * that happens to come later in the room wins, which is why a door could
   * look open and shut at once.
   *
   * The states are written directly rather than through `putState`, so the
   * caller's own `putState` does the one redraw all of them need.
   */
  clearObjectsSharingBox(objectId: number): void {
    const room = this.currentRoomData;
    const object = room?.findObject(objectId);
    if (!room || !object) return;

    for (const other of room.objects) {
      if (other.id === object.id || other.id <= 0) continue;
      if (other.x !== object.x || other.y !== object.y) continue;
      if (other.width !== object.width || other.height !== object.height) continue;
      if (other.id < this.objectState.length) this.objectState[other.id] = 0;
      other.state = 0;
    }
  }

  getState(objectId: number): number {
    return this.objectState[objectId] ?? 0;
  }

  /**
   * Sets an object's state and redraws it.
   *
   * State drives both logic and appearance — state 1 might be "door closed",
   * state 2 "door open" — so changing it has to restamp the background.
   */
  putState(objectId: number, state: number): void {
    if (objectId < 0 || objectId >= this.objectState.length) return;
    this.objectState[objectId] = state;

    const object = this.currentRoomData?.findObject(objectId);
    if (!object) return;

    // Redrawing over the old image needs the room background restored first,
    // which is cheapest to do by re-decoding the room and all its objects.
    this.refreshRoomBackground();
  }

  /**
   * Decodes a room's background into `roomGraphics`, by the Version's codec.
   *
   * One method for the two places that do it — entering a room and restamping
   * it after an object changed — because they diverged once and the second one
   * kept the v5 reader. A v4 room entered correctly and then redrawn by any
   * script that set an object's state came back blank, which reads as a room
   * whose art is missing rather than as a room whose art was thrown away.
   *
   * The two codecs are not variations on each other: v5 wraps its image in
   * `RMIM`, `IM00` and `SMAP`, and v4 has none of those — `BM` is the strip
   * table itself.
   */
  private decodeRoomBackground(room: Room): void {
    if (!this.roomGraphics || room.backgroundOffset < 0) return;

    if (this.resources.game.version < 5) {
      this.roomGraphics.decodeSmallImage(
        room.data,
        // `BM`'s payload is the strip table, straight after its header.
        room.backgroundOffset + SMALL_CHUNK_HEADER_SIZE,
        0,
        0,
        room.width,
        room.height,
        // Sixteen colours or 256, read off the count the room's own palette
        // carries rather than off the Version or the title: the two eras of v4
        // release ship the same containers and differ here, and the palette
        // says which it is in its first two bytes.
        room.paletteColours > 0 && room.paletteColours <= 16,
      );
      return;
    }

    this.roomGraphics.decodeImage(
      room.data,
      room.backgroundOffset,
      0,
      0,
      room.width,
      room.height,
      true,
    );
  }

  private refreshRoomBackground(): void {
    const room = this.currentRoomData;
    if (!room || !this.roomGraphics) return;

    this.roomGraphics = new RoomGraphics(
      room.width,
      room.height,
      room.numZPlanes,
      room.transparentColor,
    );
    this.decodeRoomBackground(room);
    for (const object of room.objects) {
      const state = this.getState(object.id);
      object.state = state;
      if (state !== 0 && this.isObjectInRoom(object.id)) {
        this.drawObjectImage(object, state);
      }
    }
  }

  getOwner(objectId: number): number {
    return this.objectOwner[objectId] ?? 0;
  }

  /**
   * Whether an object is present in the room rather than in someone's pocket.
   *
   * The owner byte in the index uses `OF_OWNER_ROOM` (15) for "the room has
   * it", 0 for "nobody has it" and an actor number otherwise, so the room is
   * the *high* value here and not zero. Testing this against 0 read every
   * object in every room as belonging to somebody else, which left rooms with
   * nothing to click on and no verbs on hover.
   *
   * v7 records no owner at all and leaves `OF_OWNER_ROOM_V7` in the table, so
   * that counts as the room too — see `isRoomOwner`.
   */
  isObjectInRoom(objectId: number): boolean {
    return this.isRoomOwner(this.getOwner(objectId));
  }

  /**
   * Whether an owner byte names the room rather than an actor or nobody.
   *
   * Two values mean the room, because v7 has no owner column to read and the
   * original fills the table with `OF_OWNER_ROOM_V7` instead. Scripts still
   * put an object back with `OF_OWNER_ROOM`, so both have to answer yes on the
   * versions that can produce either.
   */
  private isRoomOwner(owner: number): boolean {
    if (owner === OF_OWNER_ROOM) return true;
    return this.scummVersion >= 7 && owner === OF_OWNER_ROOM_V7;
  }

  /**
   * Hands an object to an owner, and tells the game its inventory changed.
   *
   * The second half is the part that is easy to leave out and expensive to
   * leave out. A v6 game draws its own inventory panel from a script, so the
   * panel only shows what was true the last time that script ran; `setOwnerOf`
   * is one of the two places the original runs it (`object.cpp:173`), and
   * without it Day of the Tentacle's panel keeps every item slot switched off
   * however many things Bernard is carrying.
   *
   * The argument is the object that moved from v6 on and zero before, which is
   * what the original passes — see {@link runInventoryScript}.
   */
  setOwnerOf(objectId: number, owner: number): void {
    if (objectId < 0 || objectId >= this.objectOwner.length) return;
    this.putOwner(objectId, owner);
    this.runInventoryScript(this.scummVersion >= 6 ? objectId : 0);
  }

  /**
   * The table write alone, with no inventory script — the original's `putOwner`.
   *
   * `room` names where the object's code is to be read from if this is the
   * hand-over that puts it in the inventory; see {@link rememberInventoryObject}.
   */
  private putOwner(objectId: number, owner: number, room = this.currentRoom): void {
    if (objectId < 0 || objectId >= this.objectOwner.length) return;

    // Taking an object away from an actor removes it from their inventory.
    const previous = this.objectOwner[objectId];
    if (previous !== owner) {
      const index = this.inventory.indexOf(objectId);
      if (index >= 0) this.inventory[index] = 0;
    }

    this.objectOwner[objectId] = owner;
    // Only an actor carries things: owner 0 is nobody and `OF_OWNER_ROOM` is
    // the room itself, and putting either in the inventory pool would list
    // scenery as though the player were holding it.
    if (owner !== 0 && !this.isRoomOwner(owner)) this.addToInventory(objectId, room);
  }

  private addToInventory(objectId: number, room = this.currentRoom): void {
    this.rememberInventoryObject(objectId, room);
    if (this.inventory.includes(objectId)) return;
    const free = this.inventory.indexOf(0);
    if (free >= 0) this.inventory[free] = objectId;
    else this.inventory.push(objectId);
  }

  /**
   * Keeps a carried object's record, so it survives leaving its room.
   *
   * Read out of the room the caller names rather than the one on screen, which
   * is the whole point of `pickupObject`'s second argument: a script can put
   * something in the player's hands from a room nobody is standing in, and the
   * original reads that room's resource to copy the `OBCD`
   * (`addObjectToInventory`, `object.cpp:50`). Our engine had been throwing
   * that argument away.
   */
  private rememberInventoryObject(objectId: number, roomNumber: number): void {
    if (this.inventoryObjects.has(objectId)) return;
    const room =
      roomNumber === this.currentRoom || roomNumber === 0
        ? this.currentRoomData
        : (this.floatingObjectRoom(roomNumber) ?? this.currentRoomData);
    const object = room?.findObject(objectId);
    if (!room || !object) return;
    this.inventoryObjects.set(objectId, {
      ...object,
      // Copied for the same reason a floating object copies it: a verb added to
      // the held item must not appear on the one still listed in the room.
      verbs: new Map(object.verbs),
      source: this.objectBytes(object, room),
    });
  }

  /**
   * An object's record, from the room on screen or from the player's hands.
   *
   * The room first, because a room's own copy is the one whose state is being
   * kept up to date, and an object can be both — picked up in this room and
   * still listed in it.
   */
  private findObjectRecord(objectId: number): RoomObject | null {
    return (
      this.currentRoomData?.findObject(objectId) ?? this.inventoryObjects.get(objectId) ?? null
    );
  }

  /**
   * Picks an object up into the ego's hands.
   *
   * The inventory script runs last, once the object is owned and out of the
   * room, so that the panel it draws sees the finished state. v6 passes it the
   * object picked up; earlier versions pass 1, not 0, because their inventory
   * scripts read the argument as "something was taken" rather than as an
   * object number (`script_v5.cpp:2032`).
   */
  pickupObject(objectId: number, room: number): void {
    this.putOwner(objectId, this.variables[this.vars.EGO], room || this.currentRoom);
    this.putClass(objectId, 32, false); // no longer touchable in the room
    this.putState(objectId, 1);
    this.runInventoryScript(this.scummVersion >= 6 ? objectId : 1);
  }

  getInventoryCount(owner: number): number {
    let count = 0;
    for (const objectId of this.inventory) {
      if (objectId !== 0 && this.getOwner(objectId) === owner) count++;
    }
    return count;
  }

  findInventory(owner: number, index: number): number {
    let count = 0;
    for (const objectId of this.inventory) {
      if (objectId === 0 || this.getOwner(objectId) !== owner) continue;
      count++;
      if (count === index) return objectId;
    }
    return 0;
  }

  getClass(objectId: number, classId: number): boolean {
    if (objectId < 0 || objectId >= this.objectClass.length) return false;
    // Classes 1-3 are aliases for the low bits of the object's state.
    if (classId >= 1 && classId <= 3) {
      return (this.getState(objectId) & (1 << (classId - 1))) !== 0;
    }
    return (this.objectClass[objectId] & (1 << (classId - 1))) !== 0;
  }

  putClass(objectId: number, classId: number, set: boolean): void {
    if (objectId < 0 || objectId >= this.objectClass.length) return;
    if (classId >= 1 && classId <= 3) {
      const state = this.getState(objectId);
      const bit = 1 << (classId - 1);
      this.putState(objectId, set ? state | bit : state & ~bit);
      return;
    }
    const bit = 1 << (classId - 1);
    if (set) this.objectClass[objectId] |= bit;
    else this.objectClass[objectId] &= ~bit;
  }

  clearClasses(objectId: number): void {
    if (objectId >= 0 && objectId < this.objectClass.length) this.objectClass[objectId] = 0;
  }

  /**
   * Names an object, including one the player is carrying.
   *
   * A room's objects carry their names in their own `OBNA`, so an object in
   * the inventory has left the only place its name is written down. The
   * original keeps a picked-up object's whole `OBCD` in memory for exactly
   * this reason; remembering the names of every room entered so far is the
   * same guarantee without the resource bookkeeping, because an object cannot
   * be carried out of a room that was never entered.
   */
  getObjectName(objectId: number): string {
    const override = this.objectNameOverrides.get(objectId);
    if (override !== undefined) return override;
    const here = this.currentRoomData?.findObject(objectId)?.name;
    if (here !== undefined && here !== '') return here;
    return this.knownObjectNames.get(objectId) ?? here ?? '';
  }

  /**
   * What a message's "name" escape names: low ids are actors, the rest objects.
   *
   * `getObjOrActorName` splits them on the actor count, and the split matters
   * because both live in one number space. Resolving only actors — which this
   * did — left every object name in every message empty, and Atlantis's attic
   * names what the cursor is over through this escape and nothing else: the
   * whole room read as having nothing in it.
   */
  getObjectOrActorName(id: number): string {
    if (id > 0 && id < this.actors.length) return this.getActor(id)?.name ?? '';
    return this.getObjectName(id);
  }

  setObjectName(objectId: number, name: string): void {
    this.objectNameOverrides.set(objectId, name);
  }

  /**
   * The touchable object under a point, in room coordinates.
   *
   * An object's own state says which picture to draw, not whether it can be
   * touched, so this deliberately does not consult it. Skipping objects in
   * state 0 made every hotspot in Atlantis's opening room unreachable: the
   * room's fifteen objects all start in state 0, having no artwork of their
   * own, so no name appeared on hover and the statue that opens the hatch
   * could not be clicked.
   *
   * What does gate touchability is the `Untouchable` class, and the state of
   * an object's *ancestors*: a child names the parent state it belongs to, so
   * a handle on an open door stops being touchable once the door closes.
   * Objects with no parent are always touchable.
   *
   * Scanned in room order, first match wins, because that is the order the
   * games were authored against where two hotspots overlap.
   */
  findObjectAt(x: number, y: number): number {
    const room = this.currentRoomData;
    if (!room) return 0;

    for (let i = 0; i < room.objects.length; i++) {
      const object = room.objects[i];
      if (this.touchRejection(room, i) !== null) continue;

      if (
        x >= object.x &&
        x < object.x + object.width &&
        y >= object.y &&
        y < object.y + object.height
      ) {
        return object.id;
      }
    }
    return 0;
  }

  /**
   * Why the hit test passes over an object, or null when it does not.
   *
   * The hit test and the report that explains it have to agree, and the way to
   * be sure of that is for both to ask the same question. A room the player
   * cannot touch anything in looks exactly like a room with nothing in it, so
   * the reason is the whole diagnostic.
   */
  private touchRejection(room: Room, index: number): string | null {
    const object = room.objects[index];
    if (object.id === 0) return 'no object id';
    if (this.getClass(object.id, OBJECT_CLASS.Untouchable)) {
      return 'the Untouchable class is set';
    }
    if (!this.isObjectInRoom(object.id)) {
      return `owned by ${this.getOwner(object.id)}, so not in the room`;
    }
    return this.ancestryRejection(room, index);
  }

  /**
   * Why an object's ancestors make it untouchable, or null when they do not.
   *
   * `parent` is a one-based index into the room's own object list, not an
   * object number, and only the low four bits of a state take part in the
   * comparison. Objects with no parent are always touchable.
   */
  private ancestryRejection(room: Room, index: number): string | null {
    let current = room.objects[index];

    // A room whose parent bytes form a cycle would otherwise spin here, and a
    // hung frame is far harder to diagnose than an untouchable object.
    for (let steps = 0; steps <= room.objects.length; steps++) {
      const wantedState = current.parentState;
      const parentIndex = current.parent;
      if (parentIndex === 0) return null;

      const parent = room.objects[parentIndex - 1];
      if (!parent) return `parent slot ${parentIndex} is not one of the room's objects`;

      const parentState = this.getState(parent.id) & 0x0f;
      if (parentState !== wantedState) {
        return `parent ${parent.id} is in state ${parentState}, and this belongs to state ${wantedState}`;
      }
      current = parent;
    }

    return `the parent chain from object ${room.objects[index].id} loops`;
  }

  getObjectRoom(objectId: number): number {
    return this.currentRoomData?.findObject(objectId) ? this.currentRoom : 0;
  }

  /**
   * An object's position and size in the room, or nulls when it is not here.
   *
   * Read directly rather than through `getObjectOrActorXY`, which answers with
   * a hotspot: Sam & Max's verb coin positions itself against the object's
   * *box*, and a hotspot in the middle of a wide object puts the coin in the
   * wrong place.
   */
  getObjectGeometry(
    objectId: number,
  ): { x: number; y: number; width: number; height: number } | null {
    const object = this.currentRoomData?.findObject(objectId);
    if (!object) return null;
    return { x: object.x, y: object.y, width: object.width, height: object.height };
  }

  /** The direction an object faces, from its own `CDHD`. */
  getObjectDirection(objectId: number): number {
    return this.currentRoomData?.findObject(objectId)?.actorDir ?? 0;
  }

  /** Where a verb's code for an object lives, for `runObjectScript`. */
  findObjectVerbCode(
    objectId: number,
    entry: number,
  ): { data: Uint8Array; base: number; offset: number; where: ObjectWhere } | null {
    const room = this.currentRoomData;
    const here = room?.findObject(objectId) ?? null;
    const object = here ?? this.inventoryObjects.get(objectId) ?? null;
    if (!object || object.verbCodeBase < 0) return null;

    const data = here && room ? this.objectBytes(here, room) : object.source;
    if (!data) return null;

    // Entry 0xFF is the catch-all handler used when no specific verb matches.
    let offset = object.verbs.get(entry);
    if (offset === undefined) offset = object.verbs.get(0xff);
    if (offset === undefined) return null;

    return {
      data,
      base: object.obcdOffset,
      offset: object.verbCodeBase + offset,
      // An inventory object's script outlives the room it was read from, and
      // the scheduler keeps it running across a room change on the strength of
      // this — see `ScriptScheduler`, which treats Room and Inventory apart.
      where: here ? ObjectWhere.Room : ObjectWhere.Inventory,
    };
  }

  /**
   * Where an object's handler for a verb starts, as an offset into the object.
   *
   * The table's own numbers count from the `VERB` chunk, and this adds the
   * chunk's position within the object so the answer is relative to the object
   * — which is what `getVerbEntrypoint` returns and what a script comparing
   * two of them expects.
   */
  getVerbEntrypoint(objectId: number, entry: number): number {
    const object = this.findObjectRecord(objectId);
    if (!object) return 0;
    // Not gated on state, for the same reason as `findObjectAt`: a hotspot
    // with no artwork sits in state 0 for the whole game and still has to
    // answer for its verbs.
    const offset = object.verbs.get(entry) ?? object.verbs.get(0xff);
    if (offset === undefined || object.verbCodeBase < 0) return 0;
    // Counted from the object's own first byte, which is what the original
    // hands back — a script mostly only asks whether this is non-zero.
    return object.verbCodeBase - object.obcdOffset + offset;
  }

  // ---------------------------------------------------------------- actors --

  getActor(number: number): Actor | null {
    return this.actors[number] ?? null;
  }

  initActor(actor: Actor, mode: number): void {
    // The modes are three different questions, and only the strongest of them
    // moves the actor. `actorOps`'s "default" form (mode 0) puts the
    // properties back and leaves the actor standing where it is, wearing what
    // it wears — see `Actor.resetProperties`, where the game that proves it is
    // named. Mode 1 is the stronger form that also forgets who the actor is,
    // and mode 2 only faces it front.
    if (mode === 1) actor.clearIdentity();
    else if (mode === 2) {
      actor.facing = 180;
    }
    actor.resetProperties();
    // Every v7 actor starts deferring to its walkbox, whatever the mode: the
    // original sets this outside the mode check, and zero — what v6 means by
    // "no override" — is a real plane number under v7.
    if (this.scummVersion >= 7) actor.forceClip = V7_CLIP_FROM_BOX;
    actor.needRedraw = true;
  }

  setActorCostume(actor: Actor, costumeId: number): void {
    actor.costume = costumeId;
    actor.cost.curpos.fill(0xffff);
    actor.cost.stopped = 0;
    actor.cost.animCounter = 0;
    if (actor.visible) this.startAnimActor(actor, actor.initFrame);
    actor.needRedraw = true;
  }

  /**
   * A costume's cels, or null with the reason recorded.
   *
   * The two ways this fails are not the same fault and used to read as one.
   * "Costume 42 did not decode" describes a costume whose artwork the decoder
   * choked on; a costume the game does not contain at all produces the same
   * words, and sent a reader looking at the decoder for a resource that was
   * never there. Which it is, is the difference between an engine bug and a
   * game built with a costume id nothing was written under.
   *
   * A decode that throws is caught rather than escaping into the render loop,
   * where it took the whole frame — and every frame after it — down over one
   * unreadable character.
   */
  private readonly akosCache = new Map<number, AkosCostume | null>();
  /** Per-actor animation variables, which chores set and test. */
  private readonly choreVars = new Map<number, ChoreVars>();

  /**
   * Whether a costume is in the `AKOS` format rather than v5's `COST`.
   *
   * Read off the resource's own tag. Deciding from the game's version was
   * wrong by exactly one version — ScummVM turns its new-costume flag on in
   * the v7 constructor, so v6's actors wear `COST` — and the symptom was every
   * actor in Day of the Tentacle silently undrawn.
   */
  private costumeIsAkos(id: number): boolean {
    const resource = id === 0 ? null : this.resources.getCostume(id);
    if (!resource || resource.length < 4) return false;
    return String.fromCharCode(resource[0], resource[1], resource[2], resource[3]) === 'AKOS';
  }

  /** An AKOS costume, parsed once and kept. */
  private getAkosCostume(id: number): AkosCostume | null {
    if (id === 0) return null;
    const cached = this.akosCache.get(id);
    if (cached !== undefined) return cached;

    const resource = this.resources.getCostume(id);
    const parsed = resource ? parseAkos(resource) : null;
    if (!parsed) {
      this.costumeFailures.set(
        id,
        resource ? 'is not an AKOS costume' : 'is not in the game files',
      );
    }
    this.akosCache.set(id, parsed);
    return parsed;
  }

  /**
   * Why an actor wearing this costume cannot be drawn, or null when it can.
   *
   * Asked through here so a caller cannot pick the wrong reader. Handing an
   * `AKOS` resource to the classic one throws on AKHD's size field, which
   * records a failure against a costume that is perfectly good and — because
   * the failure is remembered — keeps reporting it.
   */
  private costumeProblem(id: number): string | null {
    const decoded = this.costumeIsAkos(id) ? this.getAkosCostume(id) : this.getCostume(id);
    if (decoded) return null;
    return this.costumeFailures.get(id) ?? 'did not decode';
  }

  /**
   * Recolours an actor by scaling its costume's true colours.
   *
   * This is how Full Throttle tints a biker and how the Dig shades a figure
   * standing in coloured light: the script hands over one multiplier per
   * channel, and every colour the costume owns is scaled by them and then
   * matched back to the nearest colour the room actually has. The result is
   * written into the actor's own palette overrides, which the renderer already
   * consults, so nothing about drawing has to know this happened.
   *
   * Two details are the original's and are not obvious:
   *
   * - the multipliers are 8.8 fixed point, so 256 is "unchanged" and 128 is
   *   "half as bright"; a script passing 255 means *almost* unchanged, and the
   *   shift is what keeps the arithmetic in bytes;
   * - an actor with a shadow mode set has its first sixteen colours left alone.
   *   Those are the shared indices every costume agrees on, and the shadow
   *   effect is already claiming them; remapping them too would fight it.
   *
   * A costume with no `RGBS` block cannot be remapped at all, because there are
   * no true colours to scale — the original bails out there and so does this,
   * with a note, rather than inventing colours from the palette indices.
   */
  remapActorPalette(
    actorId: number,
    red: number,
    green: number,
    blue: number,
    threshold: number,
  ): void {
    const actor = this.actors[actorId];
    if (!actor) return;

    if (!actor.isInCurrentRoom(this.currentRoom)) {
      return this.reportActorRemap(actorId, `is in room ${actor.room}, not ${this.currentRoom}`);
    }

    const costume = this.costumeIsAkos(actor.costume) ? this.getAkosCostume(actor.costume) : null;
    if (!costume || costume.palette.length === 0) {
      return this.reportActorRemap(actorId, `wears costume ${actor.costume}, which has no AKPL`);
    }
    if (costume.rgbs.length < costume.palette.length * 3) {
      return this.reportActorRemap(actorId, `wears costume ${actor.costume}, which has no RGBS`);
    }

    const count = Math.min(costume.palette.length, actor.palette.length);
    for (let i = 0; i < count; i++) {
      if (actor.shadowMode !== 0 && costume.palette[i] < 16) continue;

      actor.palette[i] = this.palette.remapColor(
        (costume.rgbs[i * 3] * red) >> 8,
        (costume.rgbs[i * 3 + 1] * green) >> 8,
        (costume.rgbs[i * 3 + 2] * blue) >> 8,
        threshold,
        // v8 starts at 24, reserving more of the low end; nothing here reads a
        // v8 game, so the one value is written rather than a version test that
        // could never take its other branch.
        1,
        // Only v7 refuses cycled colours. Earlier versions will happily paint an
        // actor in a colour that is about to rotate, and matching that is the
        // point: their artwork was drawn knowing it.
        this.scummVersion === 7,
      );
    }
  }

  /** Says once per actor why a recolour did nothing. */
  private reportActorRemap(actorId: number, why: string): void {
    if (this.reportedActorRemaps.has(actorId)) return;
    this.reportedActorRemaps.add(actorId);
    this.warn(
      `A script asked to recolour actor ${actorId}, which ${why}, so it kept its own colours.`,
    );
  }

  private readonly reportedActorRemaps = new Set<number>();

  /**
   * Draws a v6 actor.
   *
   * The shape is the same as the v5 path — pick a cel per limb, decode it, hand
   * it to the shared renderer — but everything up to "which cel" differs. A v6
   * costume chooses by *chore*: the actor's frame and facing select one, and
   * stepping it through its opcode stream is what says which picture to draw
   * and where the limb has got to.
   *
   * A limb's position within its chore lives in `actor.cost.curpos`, the same
   * array the classic path uses, so an actor's animation state is one thing
   * regardless of which costume format is behind it — which is what lets a
   * saved game store it without knowing the version.
   */
  private drawAkosActor(
    actor: Actor,
    costume: AkosCostume,
    screenX: number,
    screenY: number,
    scale: number,
    zPlane: number,
    cameraX: number,
    roomTop: number,
  ): void {
    const palette = new Uint8Array(256);
    for (let i = 0; i < costume.palette.length && i < 256; i++) {
      // An actor's own palette overrides the costume's where it is set, which
      // is how two actors share one costume and wear different colours.
      palette[i] = actor.palette[i] !== 0xff ? actor.palette[i] : costume.palette[i];
    }

    const vars = this.choreVars.get(actor.number) ?? {};
    this.choreVars.set(actor.number, vars);

    const direction = newDirToOldDir(actor.facing);
    const chore = choreFor(costume, actor.frame, direction);
    const start = costume.chores[chore];
    // Offset 0 means the costume has no chore here — a real value, not a
    // missing one, so it draws nothing rather than falling back to chore zero.
    if (start === undefined || start === 0) return;

    const at = actor.cost.curpos[0] === 0xffff ? start : actor.cost.curpos[0];
    const step = stepChore(costume, costume.sequence, at, vars);
    actor.cost.curpos[0] = step.position;

    if (step.cel === null) return;
    const cel = costume.cels[step.cel];
    const pixels = decodeAkosCel(costume, step.cel);
    if (!cel || !pixels) return;

    drawCel(this.screen, {} as unknown as Costume, cel, pixels, {
      actorX: screenX,
      actorY: screenY,
      xMove: cel.relX,
      yMove: cel.relY,
      scaleX: scale,
      scaleY: scale,
      drawToRight: step.flip ?? direction !== 0,
      palette,
      roomGraphics: this.roomGraphics ?? undefined,
      cameraX,
      roomTop,
      zPlane,
      clipTop: this.screen.main.top,
      clipBottom: this.screen.main.top + this.screen.main.height,
    });
  }

  private getCostume(id: number): Costume | null {
    if (id === 0) return null;
    const cached = this.costumeCache.get(id);
    if (cached) return cached;
    // Asked again every frame an actor is drawn, so the answer is remembered
    // and the log line written once.
    if (this.costumeFailures.has(id)) return null;

    const resource = this.resources.getCostume(id);
    if (!resource) {
      this.noteCostumeFailure(id, 'is not in the game data');
      return null;
    }

    this.setActivity(`decoding costume ${id}`);
    try {
      const costume = new Costume(id, resource, this.resources.game.version);
      this.costumeCache.set(id, costume);
      return costume;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.noteCostumeFailure(id, `could not be decoded: ${reason}`);
      return null;
    }
  }

  private noteCostumeFailure(id: number, reason: string): void {
    this.costumeFailures.set(id, reason);
    this.log(`Costume ${id} ${reason}, so an actor wearing it cannot be drawn`);
  }

  /**
   * Moves an actor immediately, cancelling any walk in progress.
   *
   * An actor stopped mid-walk must be put back into its standing pose. Without
   * that it keeps whatever cel the walk cycle was on and, if the walk pose has
   * several cels, carries on animating on the spot forever — which is what
   * happens every time a script repositions the player, most obviously when
   * walking through a door.
   */
  putActor(number: number, x: number, y: number): void {
    const actor = this.getActor(number);
    if (!actor) return;

    const wasMoving = actor.moving !== 0;

    actor.x = x;
    actor.y = y;
    actor.stopMoving();
    actor.needRedraw = true;
    this.adjustActorPos(actor);

    // Placing an actor is also what shows it. The two are one operation in the
    // original — an actor is on screen because something put it there — and
    // splitting them left this able to position an actor in the room the player
    // is looking at and leave it undrawn. A script that assigns an actor's room
    // before loading that room, then places the actor with `putActor` alone,
    // got a room that renders perfectly with nobody in it, and no error
    // anywhere to say so.
    if (!actor.visible) {
      if (actor.isInCurrentRoom(this.currentRoom)) this.showActor(actor);
      return;
    }
    if (!actor.isInCurrentRoom(this.currentRoom)) {
      this.stopTalkIfActor(number);
      actor.visible = false;
      return;
    }

    if (wasMoving) this.startAnimActor(actor, actor.standFrame);
  }

  /** Shows every actor the new room already contains. */
  private showActorsInRoom(): void {
    for (const actor of this.actors) {
      if (actor.number === 0) continue;
      if (actor.isInCurrentRoom(this.currentRoom)) this.showActor(actor);
    }
  }

  /**
   * Makes an actor in the current room drawable, from a clean animation state.
   *
   * An actor appearing in a room starts standing in its init frame, so it never
   * arrives mid-stride from a walk that was interrupted somewhere else.
   */
  private showActor(actor: Actor): void {
    if (actor.visible) return;
    actor.visible = true;
    actor.cost.curpos.fill(0xffff);
    actor.cost.stopped = 0;
    this.startAnimActor(actor, actor.initFrame);
  }

  putActorInRoom(number: number, room: number): void {
    const actor = this.getActor(number);
    if (!actor) return;

    if (actor.visible && actor.room !== room) {
      this.stopTalkIfActor(number);
      actor.visible = false;
    }
    const wasVisible = actor.visible;
    const wasMoving = actor.moving !== 0;
    actor.room = room;
    actor.stopMoving();

    if (room !== this.currentRoom) return;

    this.adjustActorPos(actor);

    if (!wasVisible) this.showActor(actor);
    else if (wasMoving) this.startAnimActor(actor, actor.standFrame);
  }

  putActorAtObject(number: number, objectId: number): void {
    const actor = this.getActor(number);
    if (!actor) return;
    const position = this.getObjectOrActorXY(objectId);
    if (!position) return;
    this.putActor(number, position.x, position.y);
  }

  /** Snaps a newly placed actor onto the nearest walkable box. */
  private adjustActorPos(actor: Actor): void {
    if (!this.boxes || actor.ignoreBoxes) {
      actor.walkbox = INVALID_BOX;
      return;
    }
    const adjusted = this.boxes.adjustToBeInBox(actor.x, actor.y);
    actor.x = adjusted.x;
    actor.y = adjusted.y;
    actor.setBox(this.boxes, adjusted.box);
    actor.walkdata.destBox = adjusted.box;
    actor.walkdata.destX = adjusted.x;
    actor.walkdata.destY = adjusted.y;
  }

  /**
   * Whether rebuilding the box matrix should re-place the actors.
   *
   * A per-*game* fact rather than a per-version one, which is why it is a flag
   * here rather than a version branch: The Dig does it and Full Throttle does
   * not. Read from the game's identity, which this project already treats as
   * load-bearing — a saved game is refused when it belongs to a different one,
   * because object and script numbers mean different things between titles.
   *
   * Set for the games known to want it rather than inferred from the version,
   * so a v7 game nobody has identified gets v6's behaviour instead of The
   * Dig's. Guessing the other way re-places actors in a game that never asked,
   * which moves them out from under whatever a script had just positioned.
   */
  replacesActorsOnRebuild = false;

  /**
   * Snaps every actor in the room back onto a walkable box.
   *
   * What v7 does after a box set changes, and v6 does not. A box set decides
   * where walking is allowed, so an actor left standing where only the previous
   * set permitted is an actor that cannot move — it has no valid box to walk
   * from, and every walk request from that position fails silently.
   *
   * Actors that ignore boxes are left alone, as they are when placed: the whole
   * point of that flag is that geometry does not apply to them.
   */
  putActorsOnValidBoxes(): void {
    for (const actor of this.actors) {
      if (actor.number === 0 || !actor.isInCurrentRoom(this.currentRoom)) continue;
      this.adjustActorPos(actor);
    }
  }

  actorFromPos(x: number, y: number): number {
    for (const actor of this.actors) {
      if (actor.number === 0 || !actor.isInCurrentRoom(this.currentRoom)) continue;
      if (!actor.visible) continue;
      const halfWidth = actor.width >> 1;
      if (
        x >= actor.x - halfWidth &&
        x <= actor.x + halfWidth &&
        y >= actor.y - 60 &&
        y <= actor.y
      ) {
        return actor.number;
      }
    }
    return 0;
  }

  /**
   * Stops an actor and returns it to its standing pose.
   *
   * The pair always belongs together: stopping without resetting the frame
   * leaves the walk cycle running on the spot.
   */
  stopActorAndStand(actor: Actor): void {
    if (actor.moving === 0) return;
    actor.stopMoving();
    this.startAnimActor(actor, actor.standFrame);
  }

  /**
   * Runs `animateActor`, whose argument is a frame unless it is a command.
   *
   * The argument is almost always the frame to play, passed as it is. Three
   * values are reserved for commands — stand, face a direction, turn to one —
   * and they sit at the *top* of the range rather than the bottom, four
   * arguments each with the direction in the low two bits. `ANIMATE_COMMAND`
   * says why that matters.
   *
   * v7 reads the same argument in thousands: the command is the argument
   * divided by a thousand and the direction is the remainder, already an
   * angle rather than one of four. A version that reads the other's encoding
   * finds a command in every ordinary frame number, or an ordinary frame
   * number in every command.
   */
  animateActor(number: number, animation: number): void {
    const actor = this.getActor(number);
    if (!actor) return;

    let command: number;
    let direction: number;
    if (this.scummVersion >= 7) {
      const argument = animation === 0xff ? 2000 : animation;
      command = Math.trunc(argument / 1000);
      direction = argument % 1000;
    } else {
      // Counted down from the top of the byte, which is what makes the
      // reserved block the last twelve arguments rather than the first twelve.
      command = 0x3f - (animation >> 2) + 2;
      direction = oldDirToNewDir(animation & 3);
    }

    switch (command) {
      case 2:
        this.startAnimActor(actor, actor.standFrame);
        actor.stopMoving();
        break;

      case 3:
        actor.moving &= ~MF_TURN;
        this.setActorDirection(actor, direction);
        break;

      case 4:
        this.turnToDirection(actor, direction);
        break;

      default:
        this.startAnimActor(actor, animation);
        break;
    }
  }

  startAnimActor(actor: Actor, frame: number): void {
    // The pseudo-frames a script uses to name the actor's own poses without
    // knowing which chore each one is. v7 numbers them in thousands, which is
    // the same numbering its `animateActor` argument uses.
    const poses = this.scummVersion >= 7 ? ANIMATE_FRAME_V7 : ANIMATE_FRAME;
    let resolved = frame;
    switch (frame) {
      case poses.Init:
        resolved = actor.initFrame;
        break;
      case poses.Walk:
        resolved = actor.walkFrame;
        break;
      case poses.Stand:
        resolved = actor.standFrame;
        break;
      case poses.TalkStart:
        resolved = actor.talkStartFrame;
        break;
      case poses.TalkStop:
        resolved = actor.talkStopFrame;
        break;
      default:
        break;
    }

    if (!actor.isInCurrentRoom(this.currentRoom) || actor.costume === 0) return;

    // Which reader a costume needs is a fact about the resource, so it is
    // decided here as well as at draw time. Asking the classic reader for an
    // `AKOS` costume threw, and this then returned before assigning
    // `actor.frame` — so every v7 actor kept the frame it was constructed
    // with. They drew, which is what made this hard to see, and stayed in the
    // one pose for the whole game: standing, walking, talking and every
    // scripted animation all select the frame-zero chore.
    const akos = this.costumeIsAkos(actor.costume) ? this.getAkosCostume(actor.costume) : null;
    const costume = akos ? null : this.getCostume(actor.costume);
    if (!akos && !costume) return;

    actor.animProgress = 0;
    actor.needRedraw = true;
    if (resolved === actor.initFrame) {
      actor.cost.curpos.fill(0xffff);
      actor.cost.stopped = 0;
    } else if (akos && resolved !== actor.frame) {
      // An AKOS chore is stepped through `curpos[0]`, so a different frame has
      // to start at its own beginning rather than however far the last one had
      // got. The classic path needs no equivalent: `costumeDecodeData` sets
      // each limb's position as it resolves it.
      actor.cost.curpos.fill(0xffff);
    }
    // An AKOS costume has no per-limb frame table to resolve: the frame *is*
    // the chore selector, and `drawAkosActor` reads it off the actor.
    if (costume) costumeDecodeData(costume, actor.cost, actor.facing, resolved, 0xffff);
    actor.frame = resolved;
  }

  setActorDirection(actor: Actor, direction: number): void {
    if (actor.facing === direction) return;
    actor.facing = normalizeAngle(direction);

    // An AKOS costume keeps no per-facing limb state: `drawAkosActor` picks
    // the chore from the facing it reads off the actor, so setting it above is
    // the whole of the work.
    if (this.costumeIsAkos(actor.costume)) {
      actor.needRedraw = true;
      return;
    }

    const costume = this.getCostume(actor.costume);
    if (!costume) return;

    // Re-decode every limb that has an animation, so the new facing's frames
    // are used without restarting the animation.
    let mask = 0x8000;
    for (let limb = 0; limb < 16; limb++, mask >>= 1) {
      const frame = actor.cost.frame[limb];
      if (frame === 0xffff) continue;
      costumeDecodeData(costume, actor.cost, actor.facing, frame, mask);
    }
    actor.needRedraw = true;
  }

  turnToDirection(actor: Actor, direction: number): void {
    if (direction === -1) return;
    actor.moving &= ~MF_TURN;
    if (direction !== actor.facing) {
      actor.moving |= MF_TURN;
      actor.targetFacing = direction;
    }
  }

  faceActorTowards(number: number, target: number): void {
    const actor = this.getActor(number);
    if (!actor) return;
    const position = this.getObjectOrActorXY(target);
    if (!position) return;
    const direction = position.x < actor.x ? 270 : 90;
    this.turnToDirection(actor, direction);
  }

  startWalkActor(number: number, x: number, y: number, direction: number): void {
    const actor = this.getActor(number);
    if (!actor) return;

    if (!actor.isInCurrentRoom(this.currentRoom)) {
      actor.x = x;
      actor.y = y;
      if (direction !== -1) actor.facing = normalizeAngle(direction);
      return;
    }

    let destX = x;
    let destY = y;
    let destBox = INVALID_BOX as number;

    if (actor.ignoreBoxes) {
      destBox = INVALID_BOX;
    } else if (this.boxes) {
      const adjusted = this.boxes.adjustToBeInBox(x, y);
      destX = adjusted.x;
      destY = adjusted.y;
      destBox = adjusted.box;
    }

    if (actor.x === destX && actor.y === destY) {
      this.turnToDirection(actor, direction);
      return;
    }

    actor.walkdata.destX = destX;
    actor.walkdata.destY = destY;
    actor.walkdata.destBox = destBox;
    actor.walkdata.destDir = direction;
    actor.moving = (actor.moving & MF_IN_LEG) | MF_NEW_LEG;
    actor.walkdata.curBox = actor.walkbox;
  }

  walkActorToActor(number: number, targetNumber: number, distance: number): void {
    const actor = this.getActor(number);
    const target = this.getActor(targetNumber);
    if (!actor || !target) return;
    if (!target.isInCurrentRoom(this.currentRoom) || !actor.isInCurrentRoom(this.currentRoom)) {
      return;
    }

    let gap = distance;
    if (gap === 0xff) {
      gap = (actor.width >> 1) + (target.width >> 1);
    }

    // Approach from whichever side the actor is already on.
    const x = actor.x < target.x ? target.x - gap : target.x + gap;
    this.startWalkActor(number, x, target.y, -1);
  }

  /**
   * Walks an actor to where an object says to stand.
   *
   * Which point that is depends on the version, and `getObjectOrActorXY`
   * already knows: v5 objects carry a walk-to position, v6's have the two
   * fields but nothing writes them, so the point is the object's own position
   * offset by the hotspot for its current state.
   *
   * Reading the walk-to fields regardless asked every v6 object to be
   * approached at (0, 0). The actor then walked to whichever box was nearest
   * the top-left corner of the room — which in Day of the Tentacle's lobby
   * means every click sent Bernard to the same spot by the front door.
   */
  walkActorToObject(number: number, objectId: number): void {
    const object = this.currentRoomData?.findObject(objectId);
    if (!object) return;
    const position = this.getObjectOrActorXY(objectId);
    if (!position) return;
    this.startWalkActor(number, position.x, position.y, oldDirToNewDir(object.actorDir & 3));
  }

  /**
   * Advances every walking actor by one frame.
   *
   * A walk is a sequence of "legs" between walk boxes. Each frame either
   * continues the current leg, or picks the next box on the route and starts a
   * new leg toward the crossing point.
   */
  private walkActors(): void {
    for (const actor of this.actors) {
      if (actor.number === 0 || !actor.isInCurrentRoom(this.currentRoom)) continue;
      this.walkActor(actor);
    }
  }

  private walkActor(actor: Actor): void {
    if (!actor.moving) return;

    if (!(actor.moving & MF_NEW_LEG)) {
      if (actor.moving & MF_IN_LEG && actor.actorWalkStep(this.boxes)) {
        this.updateWalkAnimation(actor);
        return;
      }

      if (actor.moving & MF_LAST_LEG) {
        actor.moving = 0;
        actor.setBox(this.boxes, actor.walkdata.destBox);
        this.startAnimActor(actor, actor.standFrame);
        if (actor.walkdata.destDir !== -1) {
          this.turnToDirection(actor, actor.walkdata.destDir);
        }
        return;
      }

      if (actor.moving & MF_TURN) {
        const next = actor.updateActorDirection();
        if (actor.facing !== next) this.setActorDirection(actor, next);
        else actor.moving = 0;
        return;
      }

      actor.setBox(this.boxes, actor.walkdata.curBox);
      actor.moving &= MF_IN_LEG;
    }

    actor.moving &= ~MF_NEW_LEG;

    // Each pass steps into the next box towards the destination. A box matrix
    // that sends A to B and B back to A would otherwise loop for ever, so the
    // number of boxes is also the number of steps worth trying.
    let steps = (this.boxes?.count ?? 0) + 1;

    for (;;) {
      if (steps-- <= 0) {
        actor.walkdata.destBox = actor.walkbox;
        actor.moving |= MF_LAST_LEG;
        return;
      }
      if (!this.boxes || actor.walkbox === INVALID_BOX) {
        actor.setBox(this.boxes, actor.walkdata.destBox);
        actor.walkdata.curBox = actor.walkdata.destBox;
        break;
      }
      if (actor.walkbox === actor.walkdata.destBox) break;

      const nextBox = this.boxes.getNextBox(actor.walkbox, actor.walkdata.destBox);
      if (nextBox < 0) {
        // Unreachable: finish where we are rather than walking forever.
        actor.walkdata.destBox = actor.walkbox;
        actor.moving |= MF_LAST_LEG;
        return;
      }

      actor.walkdata.curBox = nextBox;

      const crossing = this.boxes.findPathTowards(
        actor.walkbox,
        nextBox,
        actor.walkdata.destBox,
        { x: actor.x, y: actor.y },
        { x: actor.walkdata.destX, y: actor.walkdata.destY },
      );
      if (!crossing) break;

      if (this.beginLeg(actor, crossing.x, crossing.y)) return;

      actor.setBox(this.boxes, actor.walkdata.curBox);
    }

    actor.moving |= MF_LAST_LEG;
    this.beginLeg(actor, actor.walkdata.destX, actor.walkdata.destY);
  }

  /**
   * Starts a leg *and* takes its first step, which is one operation.
   *
   * The original folds the step into the same call that sets the leg up, so an
   * actor told to walk has already moved by the end of that frame. Deferring
   * the step to the next frame is invisible for a walk a player watches — one
   * frame either way — but not for a script that walks an actor and reads the
   * position back after a single `breakHere`: it reads the position the actor
   * started from, and if it then puts the actor there, the walk never
   * advances at all.
   *
   * Day of the Tentacle's walk helper does exactly that. It borrows actor 12
   * as a stand-in, walks it one frame, and teleports the real actor to
   * wherever the stand-in got to — so with the step a frame late, every actor
   * in the game was teleported back to where it began, forever. The intro's
   * two tentacles never reached their marks and the scene never ended.
   *
   * Returns whether the leg is still running, so a caller can carry on to the
   * next box when this one was finished by the step it just took.
   */
  private beginLeg(actor: Actor, x: number, y: number): boolean {
    if (!actor.calcMovementFactor(x, y)) return false;
    this.startWalkAnimation(actor);
    actor.moving |= MF_IN_LEG;
    return actor.actorWalkStep(this.boxes);
  }

  private startWalkAnimation(actor: Actor): void {
    const next = actor.updateActorDirection();
    if (actor.frame !== actor.walkFrame || actor.facing !== next) {
      this.setActorDirection(actor, next);
      this.startAnimActor(actor, actor.walkFrame);
    }
  }

  private updateWalkAnimation(actor: Actor): void {
    const next = actor.updateActorDirection();
    if (actor.facing !== next) this.setActorDirection(actor, next);
  }

  /** Steps costume animations at each actor's own rate. */
  private animateActors(): void {
    for (const actor of this.actors) {
      if (actor.number === 0 || !actor.isInCurrentRoom(this.currentRoom)) continue;
      if (actor.costume === 0) continue;

      if (actor.animSpeed > 0) {
        actor.animProgress -= 1;
        if (actor.animProgress > 0) continue;
        actor.animProgress = actor.animSpeed;
      }

      // An AKOS costume advances where it is drawn — `drawAkosActor` steps the
      // chore — so there is nothing to increase here.
      if (this.costumeIsAkos(actor.costume)) continue;

      const costume = this.getCostume(actor.costume);
      if (!costume) continue;
      if (increaseAnims(costume, actor.cost)) actor.needRedraw = true;
    }
  }

  /**
   * Draws every visible actor, back to front.
   *
   * Sorting by y makes actors nearer the camera overlap those further away,
   * which is the depth cue the games rely on within a single z-plane.
   */
  private drawActors(): void {
    const visible = this.actors
      .filter(
        (actor) =>
          actor.number !== 0 &&
          actor.visible &&
          actor.costume !== 0 &&
          actor.isInCurrentRoom(this.currentRoom),
      )
      .sort((a, b) => a.y - b.y || a.number - b.number);

    const cameraX = this.cameraLeft();
    // Where room row 0 lands on the screen: the top of the room band, less
    // however far the camera has scrolled down. Subtracting the camera's y is
    // what makes an actor scroll with the room rather than stay pinned to the
    // band — zero for every version before v7, whose y range is one screen.
    const roomTop = this.screen.main.top - this.cameraTop();

    for (const actor of visible) {
      // Which costume format an actor wears is a fact about the resource, not
      // about the version: a v6 game carries `COST` costumes, and v7 was where
      // `AKOS` arrived. So the tag decides, and a release that mixes them —
      // or a v6 game with an AKOS costume for one actor — is drawn correctly
      // either way.
      if (this.costumeIsAkos(actor.costume)) {
        const akos = this.getAkosCostume(actor.costume);
        if (akos) {
          this.drawAkosActor(
            actor,
            akos,
            actor.x - cameraX,
            actor.y - actor.elevation + roomTop,
            actor.getScale(this.boxes),
            this.getActorZPlane(actor),
            cameraX,
            roomTop,
          );
        }
        continue;
      }

      const costume = this.getCostume(actor.costume);
      if (!costume) continue;

      const palette = buildCostumePalette(costume, actor.palette);
      const scale = actor.getScale(this.boxes);
      const zPlane = this.getActorZPlane(actor);

      const screenX = actor.x - cameraX;
      const screenY = actor.y - actor.elevation + roomTop;

      // Limb offsets accumulate across limbs, exactly as the original does,
      // which is how attached parts (a held object, a hat) stay aligned.
      let xMove = 0;
      let yMove = 0;

      for (let limb = 0; limb < 16; limb++) {
        const cel = getLimbCel(costume, actor.cost, limb);
        if (!cel) continue;

        const pixels = decodeCel(costume, cel);
        const drawToRight = newDirToOldDir(actor.facing) !== 0 || costume.noMirror;

        drawCel(this.screen, costume, cel, pixels, {
          actorX: screenX,
          actorY: screenY,
          xMove: xMove + cel.relX,
          yMove: yMove + cel.relY,
          scaleX: scale,
          scaleY: scale,
          drawToRight,
          palette,
          roomGraphics: this.roomGraphics ?? undefined,
          cameraX,
          roomTop,
          zPlane,
          clipTop: this.screen.main.top,
          clipBottom: this.screen.main.top + this.screen.main.height,
        });

        xMove += cel.moveX;
        yMove -= cel.moveY;
      }

      actor.needRedraw = false;
    }
  }

  /** Which z-plane occludes an actor: its box's mask, unless overridden. */
  private getActorZPlane(actor: Actor): number {
    // v7 says "not overridden" with a value rather than with a zero, so its
    // clip field is read differently: `V7_CLIP_FROM_BOX` defers to the box,
    // and every other number is meant literally, zero included. There is no
    // `neverZClip` on this path — v7 keeps the one field, and the original
    // reads only that.
    if (this.scummVersion >= 7) {
      if (actor.forceClip !== V7_CLIP_FROM_BOX) return actor.forceClip;
      if (!this.boxes || actor.walkbox === INVALID_BOX) return 0;
      // Clamped, because a box may name a mask the room does not carry, and a
      // plane past the end of the list masks the actor against nothing.
      const planes = this.roomGraphics?.zPlanes.length ?? 0;
      return Math.min(this.boxes.getMask(actor.walkbox), planes);
    }
    if (actor.forceClip > 0) return actor.forceClip;
    if (actor.neverZClip > 0) return actor.neverZClip;
    if (!this.boxes || actor.walkbox === INVALID_BOX) return 0;
    // Clamped for the same reason as v7's: a box may name a mask the room does
    // not carry, and the original clamps to the planes it has rather than
    // masking against nothing (`_zbuf > _numZBuffer - 1`).
    const planes = this.roomGraphics?.zPlanes.length ?? 0;
    return Math.min(this.boxes.getMask(actor.walkbox), planes);
  }

  /**
   * A v7 game's displayable text, or null when it has none.
   *
   * Null is not a failure: ScummVM opens a bundle only for The Dig, and Full
   * Throttle ships none — every one of its lines resolves to the fallback
   * carried beside its tag. So a missing file is reported at the level of
   * "which game is this" rather than as a broken install.
   */
  languageBundle: LanguageBundle | null = null;

  /**
   * SMUSH playback, and the world-stops-while-it-runs rule around it.
   *
   * Held by the engine rather than by the script engine because a video is not
   * a script's private business: it owns the framebuffer, the palette and the
   * frame loop for as long as it runs, and the save path has to know about it.
   */
  readonly video = new VideoPlayback();

  /**
   * Whether a SMUSH sequence is playing.
   *
   * Read by the save path, which refuses while it is set. Saving mid-video is
   * not something the original does, and a save that resumes into the middle of
   * a sequence is a worse answer than one that declines — so the refusal is
   * here rather than left as a bug to be found by whoever tries it.
   *
   * Derived rather than tracked separately: two flags for one fact is how a
   * refusal outlives the thing it was refusing.
   */
  get videoPlaying(): boolean {
    return this.video.active;
  }

  /**
   * Plays a `.SAN` beside the game, stopping the world until it ends.
   *
   * The file is fetched asynchronously and the world is stopped from the moment
   * it is asked for, which is what makes this look synchronous to the script
   * that asked: it called an instruction and the next thing it sees is the
   * frame after the cutscene.
   *
   * Read whole. A `.SAN` is tens of megabytes where the container is hundreds,
   * and a video is decoded strictly forwards, so range-reading one is a real
   * option — but it is the same question as #114 rather than a separate one,
   * and this reads the file the way everything else here reads a file.
   */
  playVideo(name: string, requestedFps = DEFAULT_SMUSH_FPS): void {
    if (!this.source) {
      this.log(`A script asked to play ${name}, but the game's files are no longer open`);
      return;
    }
    if (this.video.active) {
      this.log(`A script asked to play ${name} while ${this.video.playing} is playing; ignored`);
      return;
    }

    this.video.beginLoad(name, this.palette.snapshot(), requestedFps);
    void this.openVideo(name, this.source);
  }

  private async openVideo(name: string, source: DataSource): Promise<void> {
    let bytes: Uint8Array | null;
    try {
      bytes = (await source.read(name)) ?? null;
    } catch (error) {
      this.video.fail(`${name} could not be read (${String(error)}), so the sequence is skipped`);
      return;
    }
    if (!bytes) {
      this.video.fail(`${name} is not beside the game, so the sequence is skipped`);
      return;
    }

    this.video.strings = await this.readVideoStrings(name, source);
    this.video.open(bytes);
  }

  /**
   * The string table a video's `TRES` subtitles are named from.
   *
   * Its own first: a video's table is named after the video, so `FOO.SAN` looks
   * for `FOO.trs`. The Dig then falls back to one shared table for the whole
   * game, obscured with an `ETRS` header, and Full Throttle's road sequences
   * keep theirs in `mineroad.trs` — both tried by name rather than by asking
   * which game this is, because the answer is the same either way and a name
   * that is absent costs one lookup.
   *
   * Null when none is found, which is a cutscene without its words rather than
   * a failure: the video still plays, and the absence is reported once.
   */
  private async readVideoStrings(
    name: string,
    source: DataSource,
  ): Promise<ReadonlyMap<number, string> | null> {
    const own = stringTableNameFor(name);
    if (own) {
      const bytes = await source.read(own);
      // Plain text, not obscured, when it belongs to one video.
      const strings = bytes ? readSmushStrings(bytes, false) : null;
      if (strings) {
        this.log(`Read ${strings.size} subtitle line(s) from ${own}`);
        return strings;
      }
    }

    for (const shared of ['digtxt.trs', 'mineroad.trs']) {
      const bytes = await source.read(shared);
      if (!bytes) continue;
      const strings = readSmushStrings(bytes, true) ?? readSmushStrings(bytes, false);
      if (strings) {
        this.log(`Read ${strings.size} subtitle line(s) from ${shared}`);
        return strings;
      }
      this.log(`${shared} is beside the game but is not a subtitle table`);
    }
    return null;
  }

  /** The game's files, kept open for what is addressed by name after load. */
  private source: DataSource | null = null;

  /**
   * Connects playback to the palette, the mixer and the log.
   *
   * Done once at load rather than per video, so a sequence that fails to open
   * still reports through the same channel as one that plays.
   */
  private attachVideo(): void {
    this.video.onLog = (message) => this.log(message);
    this.video.onPalette = (rgb) => {
      this.palette.setFromClut(rgb);
      this.markScreenDirty();
    };
    this.video.onPaletteRestored = (rgb) => {
      this.palette.setFromClut(rgb);
      this.markScreenDirty();
    };
    // Only when a sequence ended before its audio would have. One that ran to
    // its end has already been waited for.
    this.video.onAudioStopped = () => this.sound.stopVideoAudio();
    this.video.audioRemaining = () => this.sound.videoAudioRemaining();
    this.video.onAudio = (audio) => {
      this.sound.playVideoAudio(audio.samples, IACT_SAMPLE_RATE);
    };
  }

  /**
   * Attaches a v7 speech bundle if one is beside the game.
   *
   * Named by convention rather than by the index, which carries cue names but
   * not file names. Both spellings are tried because releases differ, and a
   * missing bundle is reported rather than left to surface as a game that never
   * speaks.
   */
  private async loadSpeechBundle(source: DataSource): Promise<void> {
    for (const name of ['MUSDISK.BUN', 'MUSIC.BUN']) {
      // Opened by its directory rather than read whole: twelve bytes of header
      // and a few kilobytes of table, against several hundred megabytes (#114).
      // A source with no range support falls back to reading whole, which is
      // what this always did.
      const opened = await SoundEngine.openBundle(source, name);
      if (!opened) continue;
      if (this.sound.attachOpenedMusicBundle(opened.bundle, opened.read)) {
        this.log(`Attached ${name} for music`);
      } else {
        this.log(`${name} is beside the game but is not a bundle, so there will be no music`);
      }
      break;
    }

    for (const name of ['VOXDISK.BUN', 'VOICE.BUN']) {
      const opened = await SoundEngine.openBundle(source, name);
      if (!opened) continue;
      if (this.sound.attachOpenedSpeechBundle(opened.bundle, opened.read)) {
        this.log(`Attached ${name} for recorded speech`);
      } else {
        this.log(`${name} is beside the game but is not a bundle, so there will be no speech`);
      }
      return;
    }
    this.log('No speech bundle beside this game; it will play with subtitles only');
  }

  /**
   * Indexes speech kept as one file per line, if this release keeps it that way.
   *
   * The Dig's demo does, and it is the only release known to: `audio/logo.1/`,
   * `audio/wreck.19/`, `audio/nexus.23/`, one `.voc` per line number. ScummVM
   * hard-codes the eight room names, but the folders are right there in the
   * game's own files, so the names are read rather than assumed — which also
   * covers copies that spell the separator with an underscore instead of a dot,
   * the fallback ScummVM tries second.
   *
   * Only the numbers are kept, because only the numbers are what a script has:
   * control code 10's two fields are the room and the line, and the room *name*
   * exists purely to find the folder.
   *
   * Paths rather than bytes on purpose — see `attachVoiceFiles`.
   */
  private loadVoiceFolders(source: DataSource): void {
    const files = new Map<string, string>();
    // `<anything>/<name><. or _><room>/<line>.voc`. Anchored on the two numbers
    // rather than on `audio/`, so a copy that keeps the folders somewhere else
    // still indexes; a file that happens to sit two folders deep with numeric
    // names is a recording by every test that matters.
    const shape = /(?:^|\/)[^/]+[._](\d+)\/(\d+)\.voc$/i;
    for (const name of source.list()) {
      const match = shape.exec(name.replace(/\\/g, '/'));
      if (!match) continue;
      const key = `${Number(match[1])}/${Number(match[2])}`;
      // First wins, so a duplicate does not silently replace a line that
      // already resolved.
      if (!files.has(key)) files.set(key, name);
    }

    if (files.size === 0) return;
    this.sound.attachVoiceFiles(files, (path) => source.read(path));
    this.log(`Indexed ${files.size} recorded lines held one file per line`);
  }

  /**
   * Reads the `.NUT` fonts a v7 game draws its subtitles with.
   *
   * Named by convention rather than by the index, which does not mention them
   * at all — the same problem the audio bundles have. The two games disagree
   * about the names: The Dig numbers its fonts and Full Throttle names them
   * after what they are for, and a `^f` escape in a subtitle picks between them
   * by number, so the order they are loaded in *is* the numbering.
   *
   * A game with no fonts beside it is a game whose cutscenes play without
   * subtitles, which is reported rather than left to be noticed.
   */
  private async loadVideoFonts(source: DataSource): Promise<void> {
    const sets = [
      ['FONT0.NUT', 'FONT1.NUT', 'FONT2.NUT', 'FONT3.NUT'],
      ['SCUMMFNT.NUT', 'TITLFNT.NUT'],
    ];

    for (const names of sets) {
      const fonts: Array<NutFont | null> = [];
      for (const name of names) {
        const bytes = await source.read(name);
        if (!bytes) {
          fonts.push(null);
          continue;
        }
        const font = readNutFont(bytes);
        if (!font) {
          this.log(`${name} is beside the game but is not a .NUT font`);
          fonts.push(null);
          continue;
        }
        fonts.push(font);
      }

      if (fonts.some((font) => font !== null)) {
        this.video.fonts = fonts;
        const found = names.filter((_, at) => fonts[at] !== null);
        this.log(`Read ${found.length} subtitle font(s) for video: ${found.join(', ')}`);
        return;
      }
    }
    this.log('No .NUT font beside this game, so its cutscenes will have no subtitles');
  }

  private async loadLanguageBundle(source: DataSource): Promise<void> {
    const bnd = await source.read('LANGUAGE.BND');
    if (bnd) {
      const { bundle, unreadable } = readDigLanguageBundle(bnd, 'LANGUAGE.BND');
      this.languageBundle = bundle;
      this.log(`Read ${bundle.lines.size} lines of text from LANGUAGE.BND`);
      // Collected rather than thrown: one odd line should not take a game's
      // whole script down with it, but it should be visible, because a bundle
      // this reader half-understands displays as missing dialogue.
      if (unreadable.length > 0) {
        this.log(
          `${unreadable.length} line(s) of LANGUAGE.BND were not understood and are ` +
            `not available; the first is "${unreadable[0].slice(0, 60)}"`,
        );
      }
      return;
    }

    const tab = await source.read('LANGUAGE.TAB');
    if (tab) {
      this.languageBundle = readTabLanguageBundle(tab, 'LANGUAGE.TAB');
      this.log(`Read ${this.languageBundle.lines.size} lines of text from LANGUAGE.TAB`);
      return;
    }

    this.log(
      `No language bundle beside this game. Full Throttle ships none, and its ` +
        `lines display the text carried beside each tag; The Dig ships ` +
        `LANGUAGE.BND, and without it its dialogue will be missing.`,
    );
  }

  // ---------------------------------------------------------------- camera --

  panCameraTo(x: number, y = this.camera.destinationY): void {
    this.camera.destination = x;
    this.camera.destinationY = Math.max(this.camera.minY, Math.min(y, this.camera.maxY));
    this.camera.moving = true;
    this.camera.following = 0;
  }

  setCameraAt(x: number, y = this.camera.currentY): void {
    const clamped = Math.max(this.camera.min, Math.min(x, this.camera.max));
    this.camera.current = clamped;
    this.camera.destination = clamped;

    const clampedY = Math.max(this.camera.minY, Math.min(y, this.camera.maxY));
    this.camera.currentY = clampedY;
    this.camera.destinationY = clampedY;

    this.camera.moving = false;
    this.variables[this.vars.CAMERA_POS_X] = clamped;
  }

  /**
   * Points the camera at an actor, following them into their room if need be.
   *
   * The room change is not a side effect: it is how a script changes room
   * without naming one. Day of the Tentacle's opening scene places the three
   * kids in the mansion, clears the room with `loadRoom(0)`, and then says
   * "follow Bernard" — and *that* is what loads the mansion. Without it the
   * scene played out correctly with nothing on screen: the actors walked, the
   * dialogue ran, and the room they were in was never drawn. Atlantis ends its
   * attic the same way, dropping Indy through the trapdoor with
   * `putActorInRoom` and handing the camera over, with no `loadRoom` anywhere.
   */
  actorFollowCamera(actorNumber: number): void {
    this.camera.following = actorNumber;

    const actor = this.getActor(actorNumber);
    if (!actor) return;

    // Room 0 is not a room: it is where a script parks an actor to hide them,
    // and `putActorInRoom(ego, 0)` in the middle of a cutscene is ordinary.
    // Following one there would blank the screen the cutscene is playing on,
    // which is what it did to Atlantis's title sequence.
    if (actor.room !== 0 && actor.room !== this.currentRoom) {
      this.startScene(actor.room, null, 0);
      // The room change killed the room's scripts and reset the camera, so the
      // follow has to be re-stated after it rather than before.
      this.camera.following = actorNumber;
      this.camera.current = actor.x;
    }

    this.camera.destination = actor.x;
    this.runInventoryScript(0);
  }

  /**
   * Runs the game's own inventory script.
   *
   * v6 draws its inventory itself, out of verbs it creates and positions, so
   * the panel is only as current as the last run of this script. The original
   * runs it whenever what it shows could have changed: an object changing
   * hands ({@link setOwnerOf}, {@link pickupObject}), and the camera changing
   * who it follows, because in a game with more than one playable character
   * that is a change of whose inventory is on screen.
   */
  private runInventoryScript(argument: number): void {
    const script = this.variables[this.vars.INVENTORY_SCRIPT];
    if (script) this.scripts.runScript(script, false, false, [argument]);
  }

  setCameraBounds(min: number, max: number): void {
    this.camera.min = min;
    this.camera.max = max;
    this.variables[this.vars.CAMERA_MIN_X] = min;
    this.variables[this.vars.CAMERA_MAX_X] = max;
  }

  /**
   * Moves the camera toward its target.
   *
   * When following an actor the camera only starts moving once the actor
   * crosses out of a dead zone in the middle of the screen, which stops the
   * view jittering while the player shuffles about.
   */
  private moveCamera(): void {
    if (this.camera.following !== 0) {
      const actor = this.getActor(this.camera.following);
      if (actor && actor.isInCurrentRoom(this.currentRoom)) {
        const deadZone = SCREEN_WIDTH / 8;
        if (actor.x < this.camera.current - deadZone) {
          this.camera.destination = actor.x + deadZone;
        } else if (actor.x > this.camera.current + deadZone) {
          this.camera.destination = actor.x - deadZone;
        }
      }
    }

    this.camera.destination = Math.max(
      this.camera.min,
      Math.min(this.camera.destination, this.camera.max),
    );

    const delta = this.camera.destination - this.camera.current;
    if (delta === 0) {
      this.camera.moving = false;
    } else {
      const speed = Math.max(1, Math.min(8, Math.abs(delta)));
      this.camera.current += Math.sign(delta) * speed;
      this.camera.moving = true;
    }

    // The second axis moves at the same rate and by the same rule, so a v7
    // room that scrolls both ways settles on both together rather than sliding
    // sideways and then down.
    const deltaY = this.camera.destinationY - this.camera.currentY;
    if (deltaY !== 0) {
      const speed = Math.max(1, Math.min(8, Math.abs(deltaY)));
      this.camera.currentY += Math.sign(deltaY) * speed;
      this.camera.moving = true;
    }

    this.variables[this.vars.CAMERA_POS_X] = this.camera.current;
  }

  // ------------------------------------------------------------------ text --

  private getCharset(id: number): Charset | null {
    const cached = this.charsets.get(id);
    if (cached) return cached;
    const resource = this.resources.getCharset(id);
    if (!resource) return null;
    const charset = new Charset(id, resource, this.resources.game.version);
    this.charsets.set(id, charset);
    return charset;
  }

  setCharsetResource(id: number): void {
    this.currentCharsetId = id;
    this.getCharset(id);
  }

  setCharsetColors(colors: number[]): void {
    const charset = this.getCharset(this.currentCharsetId);
    if (!charset) return;
    for (let i = 0; i < colors.length && i < charset.colorMap.length; i++) {
      charset.colorMap[i] = colors[i];
    }
  }

  beginTextOptions(actorNumber: number): TextOptions {
    return {
      actor: actorNumber,
      slot: TEXT_SLOT.Speech,
      x: 0,
      y: 0,
      color: 15,
      right: SCREEN_WIDTH - 1,
      center: false,
      left: false,
      overhead: false,
      hasPosition: false,
      text: '',
      speechOffset: 0,
      speechSize: 0,
    };
  }

  applyTextOptions(_options: TextOptions): void {
    // Position-only forms just configure the next message; nothing to draw.
  }

  /**
   * Queues a message for display.
   *
   * Actor 255 means "narrator" — a caption not attached to anybody. Anything
   * else is speech, which is centred over the speaker and keeps the actor's
   * talk animation running until it expires.
   */
  showText(options: TextOptions): void {
    const charsetId = this.getCharset(this.currentCharsetId) ? this.currentCharsetId : 0;
    const charset = this.getCharset(charsetId);
    if (!charset) return;

    // The debug channel is not the screen: these are notes to whoever was
    // building the game, and the original sends them to its own debug output.
    if (options.slot === TEXT_SLOT.Debug) {
      if (this.traceScripts && options.text.trim() !== '') {
        this.trace(`script debug: ${options.text}`);
      }
      return;
    }

    // A string the script painted into the picture. Not speech: it has no
    // timer, no speaker and no wrapping, and it stays up until the room
    // changes rather than until a countdown runs out.
    if (options.slot === TEXT_SLOT.Painted) {
      this.paintString(options, charset, charsetId);
      return;
    }

    const isNarrator = options.actor === 255 || options.actor === 0;
    const actor = isNarrator ? null : this.getActor(options.actor);

    const color = actor ? actor.talkColor : options.color;
    const maxWidth = Math.max(64, options.right - 16);
    const lines = wrapText(charset, options.text, maxWidth);

    let centreX: number;
    let topY: number;

    if (options.hasPosition) {
      centreX = options.center ? options.x : options.x + charset.getStringWidth(lines[0] ?? '') / 2;
      topY = options.y + lines.length * charset.fontHeight;
    } else if (actor) {
      centreX = actor.x - this.cameraLeft() + actor.talkPosX;
      topY = actor.y - actor.elevation + this.screen.main.top + actor.talkPosY;
    } else {
      centreX = SCREEN_WIDTH / 2;
      topY = this.screen.main.top + 24;
    }

    // A line placed by the script goes where the script put it. The band the
    // room occupies is the right bound for speech — a caption over an actor is
    // nudged back inside the picture rather than drawn over the verb panel —
    // but a script that names a position has already decided, and the original
    // clamps only in the branch that works the position out for itself
    // (`CHARSET_1`, the `overhead` case). Loom's opening prompt asks for row
    // 152, which is eight rows below its 144-row picture and inside the band
    // beneath it; clamped to the picture it was drawn over the bottom of the
    // menu instead.
    const clipTop = options.hasPosition ? 0 : this.screen.text.top;
    const clipBottom = options.hasPosition
      ? SCREEN_HEIGHT
      : this.screen.main.top + this.screen.main.height;

    const placed = layoutSpeech(charset, lines, centreX, topY, clipTop, clipBottom);

    this.displayedText = placed.map((line) => ({ ...line, color, charset: charsetId }));

    // How long the line stays up.
    //
    // With recorded speech it is the length of the audio, because a script that
    // waits for the line to finish is really waiting for the sample — feed that
    // wait a text-length guess and dialogue either races past unreadably or
    // hangs. Without speech it is the text's own length, which is how the
    // floppy releases paced themselves and what keeps a non-talkie release
    // correct.
    //
    // Which file the message's two numbers point into depends on the release,
    // not on the version. A release that keeps a file per line reads them as a
    // room and a line number; everything else reads them as a byte offset into
    // its speech file and the size of the header there. Asked of the sound
    // engine rather than tested against a game id, because what decides it is
    // which files were found beside the game.
    const speech =
      options.speechOffset > 0
        ? this.sound.hasVoiceFiles()
          ? this.sound.startVoiceFile(options.speechOffset, options.speechSize)
          : this.sound.startSpeech(options.speechOffset, options.speechSize)
        : null;

    // The player turned captions off, and this line is spoken, so it is heard
    // rather than read. Only lines that *have* a recording are dropped: a line
    // with none would otherwise be delivered not at all, and the original
    // suppresses text for spoken lines alone.
    if (speech && !this.subtitles) this.displayedText = [];

    this.messageTimer = speech
      ? speechDurationFrames(speech.duration)
      : textDurationFrames(options.text, this.variables[this.vars.CHARINC]);

    this.variables[this.vars.HAVE_MSG] = 1;

    if (actor) {
      this.talkingActor = actor.number;
      this.variables[this.vars.TALK_ACTOR] = actor.number;
      actor.talking = true;
      this.startAnimActor(actor, actor.talkStartFrame);
    } else {
      this.talkingActor = 0;
      this.variables[this.vars.TALK_ACTOR] = 0;
    }
  }

  /**
   * Ages the line on screen.
   *
   * By the length of the cycle, not by one: the timer is set in sixtieths —
   * `textDurationFrames` counts characters against `VAR_CHARINC`, and a spoken
   * line's is the length of its recording — and `scummLoop` ages it with
   * `_talkDelay -= delta`. Aged one per cycle it outlasts its own audio by the
   * cycle length, which is six times over in Day of the Tentacle: every line
   * sat there long after the voice had finished, and a script waiting on the
   * line waited with it.
   */
  private updateTalk(jiffies: number): void {
    if (this.messageTimer <= 0) return;
    this.messageTimer -= jiffies;
    if (this.messageTimer > 0) return;
    this.stopTalk();
  }

  /**
   * The laid-out speech lines, for a test that has to see the font choice.
   *
   * `currentText` answers what is on screen; this answers *how*, which is the
   * only way to assert that a line kept the charset it was measured in.
   */
  displayedTextForTest(): ReadonlyArray<{ text: string; x: number; y: number; charset: number }> {
    return this.displayedText;
  }

  /** The line currently on screen, joined, for diagnostics and tests. */
  currentText(): string {
    return this.displayedText.map((line) => line.text).join(' ');
  }

  /**
   * Frames the current line still has to run.
   *
   * What a script waiting for speech to finish is really waiting for, so it is
   * worth being able to see from outside when a line's pacing looks wrong.
   */
  messageFramesRemaining(): number {
    return this.messageTimer;
  }

  stopTalk(): void {
    this.displayedText = [];
    this.messageTimer = 0;
    // A line the player skipped takes its audio with it; speech carrying on
    // over the next line is worse than no speech at all.
    this.sound.stopSpeech();
    this.variables[this.vars.HAVE_MSG] = 0;

    const actor = this.getActor(this.talkingActor);
    if (actor && actor.talking) {
      actor.talking = false;
      this.startAnimActor(actor, actor.talkStopFrame);
    }
    this.talkingActor = 0;
    this.variables[this.vars.TALK_ACTOR] = 0;
  }

  stopTalkIfActor(number: number): void {
    if (this.talkingActor === number) this.stopTalk();
  }

  stopTalkIfObject(objectId: number): void {
    if (this.talkingActor === objectId) this.stopTalk();
  }

  /**
   * Paints a string into the picture, where it stays.
   *
   * Three things differ from speech, and all three are visible on Loom's
   * opening menu:
   *
   * - **`y` is the top of the line, not its bottom.** The original sets the
   *   charset's top to the position it was given and draws downwards
   *   (`drawString`), where speech is placed above the speaker's head and
   *   grows upwards. Read as speech, each of the menu's labels is drawn a
   *   line's height below its box.
   * - **Nothing wraps.** `drawString` draws the string it was handed and lets
   *   the clip edge deal with anything past it. Wrapping a label to the
   *   picture's width would break a long one onto a second row that the
   *   original draws off the edge instead.
   * - **Newlines are honoured**, because a script that wants two rows sends
   *   one string with a break in it.
   */
  private paintString(options: TextOptions, charset: Charset, charsetId: number): void {
    let y = options.y;
    for (const line of options.text.split('\n')) {
      const x = options.center ? options.x - (charset.getStringWidth(line) >> 1) : options.x;
      // Keyed on the line's own place, so a re-print in a new colour replaces
      // what is there rather than being drawn beside it.
      this.paintedStrings.set(`${x},${y}`, {
        text: line,
        x,
        y,
        color: options.color,
        charset: charsetId,
      });
      y += charset.fontHeight;
    }
  }

  /**
   * Drops the painted strings a room change would have painted over.
   *
   * The ones over the *picture*, and only those. A room change redraws the main
   * virtual screen and nothing else, so a string drawn into the band above or
   * below it is still there afterwards — the original's own consequence of
   * `drawString` writing into whichever virtual screen holds the row it was
   * given (`printChar`, which starts at `findVirtScreen(_top)`).
   *
   * Loom is the game that tells the two apart. The note names under its distaff
   * are painted at row 169, below a picture that ends at 144, and they belong
   * to the interface rather than to the room: cleared with the room they
   * disappeared the first time the player walked through a door, leaving a
   * staff with no letters on it and no way to get them back.
   */
  private clearPaintedStringsOverTheRoom(): void {
    const top = this.screen.main.top;
    const bottom = top + this.screen.main.height;
    for (const [key, line] of this.paintedStrings) {
      if (line.y >= top && line.y < bottom) this.paintedStrings.delete(key);
    }
  }

  /** Everything painted into the picture so far, for tests, saves and diagnostics. */
  paintedStringsForTest(): ReadonlyArray<PaintedString> {
    return [...this.paintedStrings.values()];
  }

  /** Puts a saved game's painted strings back, replacing whatever is there. */
  restorePaintedStrings(lines: ReadonlyArray<PaintedString>): void {
    this.paintedStrings.clear();
    for (const line of lines) this.paintedStrings.set(`${line.x},${line.y}`, { ...line });
  }

  private drawPaintedStrings(): void {
    for (const line of this.paintedStrings.values()) {
      const charset = this.getCharset(line.charset) ?? this.getCharset(0);
      if (!charset) continue;
      charset.drawString(this.screen, line.text, line.x, line.y, line.color);
    }
  }

  private drawText(): void {
    for (const line of this.displayedText) {
      const charset = this.getCharset(line.charset) ?? this.getCharset(0);
      if (!charset) continue;
      charset.drawString(this.screen, line.text, line.x, line.y, line.color);
    }
  }

  /**
   * Queues a line to be drawn over the frame the scripts are building.
   *
   * Empty and single-space strings are dropped rather than queued, because The
   * Dig sends them constantly — the original interpreter checks for exactly
   * those two and returns — and a queue full of blanks pushes real text out of
   * a bounded queue.
   */
  enqueueBlastText(
    text: string,
    x: number,
    y: number,
    color: number,
    charset: number,
    centred: boolean,
  ): void {
    if (text === '' || text === ' ') return;

    if (this.blastTexts.length >= BLAST_TEXT_QUEUE_SIZE) {
      // The original's queue is the same size and it asserts here, so a script
      // that overruns it is doing something the game never did. Said once: the
      // frame this happens in is a frame that will happen sixty times a second.
      if (!this.reportedBlastTextOverflow) {
        this.reportedBlastTextOverflow = true;
        this.warn(
          `More than ${BLAST_TEXT_QUEUE_SIZE} lines of text were queued for one frame, ` +
            `so the rest were dropped. The original interpreter's queue is the same size.`,
        );
      }
      return;
    }

    this.blastTexts.push({ text, x, y, color, charset, centred });
  }

  private reportedBlastTextOverflow = false;

  /** What is queued for this frame, for tests and diagnostics. */
  currentBlastTexts(): readonly BlastText[] {
    return this.blastTexts;
  }

  /**
   * Draws this frame's queued text.
   *
   * A queued line carries its own font, so the current charset is not consulted
   * and not changed: an interface drawn in one font must not move the font that
   * the next line of speech is measured against. Embedded newlines are drawn as
   * separate lines because the queue holds one entry per *call*, and a script
   * that wants two rows of a menu makes one call with a break in it.
   */
  private drawBlastTexts(): void {
    for (const entry of this.blastTexts) {
      const charset = this.getCharset(entry.charset) ?? this.getCharset(0);
      if (!charset) continue;

      let y = entry.y;
      for (const line of entry.text.split('\n')) {
        // Centred means centred on `x`, not within the screen: the original
        // subtracts half the line's width and lets the clip rectangle deal
        // with anything that falls off the edge.
        const x = entry.centred ? entry.x - (charset.getStringWidth(line) >> 1) : entry.x;
        charset.drawString(this.screen, line, x, y, entry.color);
        y += charset.fontHeight;
      }
    }
  }

  /**
   * Turns captioning of spoken lines on or off.
   *
   * The player's own preference, which a v7 options screen writes through
   * `kernelSetFunctions` 215. Held here rather than in the script engine
   * because it is the text path that has to honour it.
   */
  setSubtitles(on: boolean): void {
    this.subtitles = on;
  }

  /**
   * Full Throttle's radio chatter, on or off.
   *
   * A sound-effect layer iMUSE mixes under the music while a script wants
   * radio traffic audible — the CB voices on the highway. Recorded rather than
   * mixed, because the layer is an iMUSE construct this build's sound stack
   * has no equivalent of: it is not a cue a script starts and stops, it is a
   * standing instruction to the sequencer. Keeping the flag means the state a
   * script set is visible, and means the instruction stops reporting itself as
   * unimplemented on every pass through the highway scripts.
   */
  setRadioChatter(on: boolean): void {
    this.radioChatter = on;
  }

  /** Whether Full Throttle asked for its radio-chatter layer. */
  radioChatter = false;

  getStringWidth(charsetId: number, stringIndex: number): number {
    const charset = this.getCharset(charsetId);
    if (!charset) return 0;
    return charset.getStringWidth(this.getString(stringIndex));
  }

  /**
   * Turns a raw SCUMM message into text.
   *
   * Messages embed escape sequences introduced by 0xFF: line breaks, colour
   * changes, "keep talking" markers, and substitutions that splice in a
   * variable, a string or an actor's name.
   */
  /**
   * Where a line's recorded speech lives, when the message says so.
   *
   * v5 gets this from an operand of the print instruction. v6 puts it *inside
   * the string*, as control code 10, so the only way to find it is to decode
   * the message — which is why this is an output of decoding rather than an
   * argument to it.
   */
  decodeMessage(raw: number[], speech?: { offset: number; size: number }): string {
    let out = '';
    for (let i = 0; i < raw.length; i++) {
      const byte = raw[i];
      if (byte !== 0xff && byte !== 0xfe) {
        out += String.fromCharCode(byte);
        continue;
      }

      const code = raw[++i];
      switch (code) {
        case 1:
        case 2:
          out += '\n';
          break;
        case 3:
          // "Wait" marker: the message pauses here. Treated as a line break.
          out += '\n';
          break;
        case 8:
          break;
        case 4: {
          const value = raw[i + 1] | (raw[i + 2] << 8);
          i += 2;
          out += String(this.scripts.readVar(value));
          break;
        }
        case 5: {
          // A verb's text, not a string: `addVerbToStack` looks the number up
          // in the verb table. Read as a string index it returned whatever
          // string slot happened to share the number, which is usually empty.
          const value = raw[i + 1] | (raw[i + 2] << 8);
          i += 2;
          const verb = this.verbs.get(this.scripts.readVar(value));
          out += verb && verb.type === 'text' ? verb.text : '';
          break;
        }
        case 6: {
          const value = raw[i + 1] | (raw[i + 2] << 8);
          i += 2;
          out += this.getObjectOrActorName(this.scripts.readVar(value));
          break;
        }
        case 7: {
          const value = raw[i + 1] | (raw[i + 2] << 8);
          i += 2;
          out += this.getString(value);
          break;
        }
        case 10: {
          // The speech code. Two 32-bit values, each stored as two 16-bit
          // fields with an `FF 0A` marker pair between them — so the halves sit
          // 4 bytes apart and the whole thing is 14 bytes, not 2. Reading it as
          // 2 leaves twelve bytes of payload to be decoded as text, which is
          // how a talkie line turns into line noise.
          if (this.resources?.game.version >= 6) {
            const at = i + 1;
            if (speech) {
              speech.offset =
                (raw[at] | (raw[at + 1] << 8) | (raw[at + 4] << 16) | (raw[at + 5] << 24)) >>> 0;
              speech.size =
                (raw[at + 8] | (raw[at + 9] << 8) | (raw[at + 12] << 16) | (raw[at + 13] << 24)) >>>
                0;
            }
            i += 14;
          } else {
            i += 2;
          }
          break;
        }
        case 9:
        case 12:
        case 13:
        case 14:
          i += 2;
          break;
        default:
          i += 2;
          break;
      }
    }
    return out;
  }

  // --------------------------------------------------------------- strings --

  getString(index: number): string {
    return this.strings.get(index) ?? '';
  }

  setString(index: number, value: string): void {
    this.strings.set(index, value);
  }

  copyString(from: number, to: number): void {
    this.strings.set(to, this.getString(from));
  }

  createString(index: number, size: number): void {
    this.strings.set(index, ' '.repeat(Math.max(0, size)));
  }

  setStringChar(index: number, position: number, value: number): void {
    const current = this.getString(index).padEnd(position + 1, ' ');
    this.strings.set(
      index,
      current.slice(0, position) + String.fromCharCode(value) + current.slice(position + 1),
    );
  }

  getStringChar(index: number, position: number): number {
    return this.getString(index).charCodeAt(position) || 0;
  }

  // ------------------------------------------------------------- sentences --

  /**
   * Queues a verb/object action for the sentence script to act on.
   *
   * The engine never interprets sentences itself; it hands them to the game's
   * own sentence script, which decides what "use key with door" means.
   */
  doSentence(verb: number, objectA: number, objectB: number): void {
    if (this.sentenceQueue.length >= NUM_SENTENCE_SLOTS) this.sentenceQueue.shift();
    this.sentenceQueue.push({
      verb,
      objectA,
      objectB,
      preposition: objectB !== 0,
      freezeCount: 0,
    });
  }

  stopSentence(): void {
    this.sentenceQueue.length = 0;
    const sentenceScript = this.variables[this.vars.SENTENCE_SCRIPT];
    if (sentenceScript) this.scripts.stopScript(sentenceScript);
  }

  isSentencePending(): boolean {
    if (this.sentenceQueue.length > 0) return true;
    const sentenceScript = this.variables[this.vars.SENTENCE_SCRIPT];
    return sentenceScript !== 0 && this.scripts.isScriptRunning(sentenceScript);
  }

  freezeSentence(): void {
    this.sentenceFrozen++;
    for (const sentence of this.sentenceQueue) sentence.freezeCount++;
  }

  unfreezeSentence(): void {
    if (this.sentenceFrozen > 0) this.sentenceFrozen--;
    for (const sentence of this.sentenceQueue) {
      if (sentence.freezeCount > 0) sentence.freezeCount--;
    }
  }

  /** Hands the oldest queued sentence to the game's sentence script. */
  private checkAndRunSentenceScript(): void {
    const sentenceScript = this.variables[this.vars.SENTENCE_SCRIPT];
    if (sentenceScript !== 0 && this.scripts.isScriptRunning(sentenceScript)) return;

    const sentence = this.sentenceQueue.find((candidate) => candidate.freezeCount === 0);
    if (!sentence) return;
    this.sentenceQueue.splice(this.sentenceQueue.indexOf(sentence), 1);

    this.variables[this.vars.WALKTO_OBJ] = 0;

    if (sentence.preposition && sentence.objectB !== 0) {
      // A two-object sentence needs both to still be reachable.
      this.variables[this.vars.WALKTO_OBJ] = sentence.objectA;
    }

    if (sentenceScript !== 0) {
      this.scripts.runScript(sentenceScript, false, false, [
        sentence.verb,
        sentence.objectA,
        sentence.objectB,
      ]);
    }
  }

  // ----------------------------------------------------------------- verbs --

  private drawVerbs(): void {
    this.updateSentenceLine();

    const verbScreen = this.screen.verb;
    if (verbScreen.height <= 0) return;

    this.screen.clearVirtScreen(verbScreen, 0);

    // A fallback only, for a verb whose charset a game never loaded. Each
    // verb is drawn in its own — see {@link Verb.charsetId}.
    const fallback = this.getCharset(this.currentCharsetId) ?? this.getCharset(0);

    for (const verb of this.verbs.all) {
      if (!verb.enabled) continue;

      // A verb can be a picture rather than a word, and for a v6 game most of
      // them are: Day of the Tentacle's inventory is one image verb per item
      // plus two for the scroll arrows, and its panel is drawn out of them. A
      // draw loop that only handled text left the whole inventory missing over
      // a panel cleared to black, and left the arrows unclickable because
      // nothing set their bounds.
      if (verb.type === 'image') {
        this.drawVerbImage(verb);
        continue;
      }

      if (verb.text === '') continue;

      const charset = this.getCharset(verb.charsetId) ?? fallback;
      if (!charset) continue;

      const width = charset.getStringWidth(verb.text);
      const x = verb.center ? verb.x - (width >> 1) : verb.x;
      const y = verb.y;

      const color = verb.dim ? verb.dimColor : verb.color;
      charset.drawString(this.screen, verb.text, x, y, color);

      verb.bounds = {
        left: x,
        top: y,
        right: x + width,
        bottom: y + charset.fontHeight,
      };
    }

    this.verbs.clearDirty();
  }

  /**
   * Draws one image verb, out of the object it names.
   *
   * This is how Fate of Atlantis draws its inventory: each slot is a verb
   * pointing at an object, and the panel blits that object's image
   * (`drawVerbBitmap`). The object usually lives in another room — an
   * inventory item belongs to wherever it was picked up — so the room it names
   * is parsed if it is not the one on screen, the same way a floating object
   * is. Atlantis keeps all 126 of its inventory pictures in room 98.
   *
   * State 1 rather than the object's current state: a verb's picture is the
   * item's own artwork and does not follow whatever the object is doing in the
   * room it came from.
   */
  private drawVerbImage(verb: Verb): void {
    if (verb.image === 0) return;

    const room =
      verb.imageRoom !== 0 ? this.floatingObjectRoom(verb.imageRoom) : this.currentRoomData;
    const object = room?.findObject(verb.image);
    if (!room || !object?.image) return;

    // The *image* header's size, not the object's box. `drawVerbBitmap` reads
    // both from the `IMHD` it copied into the verb resource and never looks at
    // the `CDHD` at all — a verb has no position in a room, so the box that
    // describes where the object sits there says nothing about the picture.
    // Where the two disagree the box is usually the larger, and the icon came
    // out padded with whatever the panel had underneath it.
    //
    // Both are taken down to a whole number of strips, the way the original
    // counts them (`imgw = width / 8`, `imgh = height / 8`, then eight rows and
    // columns per unit): a picture is stored in strips of eight and a part of
    // one cannot be decoded.
    const width = (object.image.width || object.width) & ~7;
    const height = (object.image.height || object.height) & ~7;
    if (width <= 0 || height <= 0) return;

    // The same two-layout split every other object picture goes through: a
    // v2-v4 object image is an `OI` block holding a strip table, not an `OBIM`
    // holding an `IMxx`. Read as v5's, the search finds no chunk and the verb
    // draws nothing at all.
    const small = this.resources.game.version < 5;
    const imageOffset = findObjectImage(room.data, object.image.obimOffset, 1, small);
    if (imageOffset === null) return;

    // Decoded into a buffer of its own rather than into the room, because the
    // verb panel is a band of the screen and not part of any room — and seeded
    // with what is on screen there, because a transparent codec says "leave the
    // destination alone" by not writing. Seeded with zeroes, an icon arrives in
    // a black box, which is the one thing the transparency exists to prevent.
    // Snapped to a strip, because that is the unit a picture is stored and
    // drawn in: `drawVerbBitmap` works in `x / 8` and puts each strip at a
    // strip boundary, so a verb placed at an odd column is drawn at the one
    // below it rather than sliced.
    const left = verb.x & ~7;

    const scratch = new RoomGraphics(width, height, 0, room.transparentColor);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        scratch.background[y * width + x] = this.screen.getPixel(left + x, verb.y + y);
      }
    }
    if (small) {
      scratch.decodeSmallImage(
        room.data,
        imageOffset,
        0,
        0,
        width,
        height,
        room.paletteColours > 0 && room.paletteColours <= 16,
      );
    } else {
      scratch.decodeImage(room.data, imageOffset, 0, 0, width, height, false);
    }

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const color = scratch.background[y * width + x];
        if (color === room.transparentColor) continue;
        this.screen.putPixel(left + x, verb.y + y, color);
      }
    }

    verb.bounds = {
      left,
      top: verb.y,
      right: left + width,
      bottom: verb.y + height,
    };
  }

  // ---------------------------------------------------------------- cursor --

  setCursorVisible(visible: boolean, soft = false): void {
    if (soft) this.cursorState += visible ? 1 : -1;
    else this.cursorState = visible ? 1 : 0;
    this.variables[this.vars.CURSORSTATE] = this.cursorState;
  }

  /**
   * Suspends or restores player input.
   *
   * Hard calls assign, soft calls count. SCUMM nests these — a cutscene
   * suspends input that an inner sequence suspends again — so collapsing them
   * onto a boolean makes the inner restore hand control back early, or the
   * outer one never hand it back at all.
   */
  setUserPut(enabled: boolean, soft = false): void {
    if (soft) this.userPutCount += enabled ? 1 : -1;
    else this.userPutCount = enabled ? 1 : 0;
    this.variables[this.vars.USERPUT] = this.userPutCount;
  }

  setCursorImage(_index: number, _shape: number): void {
    // Cursor bitmaps come from a charset; the browser draws its own pointer.
  }

  /**
   * The cursor bitmap taken from an object's artwork, which is v6's way.
   *
   * v5 picks a cursor out of a charset; v6 hands one an object and a room. Both
   * end at the same place here — the browser draws its own pointer — but the
   * object number is worth recording, because "which cursor is showing" is
   * something a script decides and a diagnostic wants to say.
   */
  setCursorFromObject(objectId: number, _room: number): void {
    this.currentCursor = objectId;
  }

  setCursorTransparency(_color: number): void {
    // See setCursorImage.
  }

  /** Grabs a screen region as the cursor bitmap. See setCursorImage. */
  grabCursor(_x: number, _y: number, _width: number, _height: number): void {}

  setCursorHotspot(_index: number, _x: number, _y: number): void {
    // See setCursorImage.
  }

  setCurrentCursor(index: number): void {
    this.currentCursor = index;
  }

  // ------------------------------------------------- palette and rendering --

  setLights(a: number, _b: number, c: number): void {
    this.lights = a;
    this.variables[this.vars.CURRENT_LIGHTS] = a;
    void c;
  }

  isLightOn(): boolean {
    return (this.lights & 1) !== 0 || this.variables[this.vars.CURRENT_LIGHTS] !== 0;
  }

  setScreenEffect(effect: number): void {
    this.screenEffect = effect;
  }

  setScreenLayout(b: number, h: number): void {
    this.screen.setLayout(b, h);
  }

  setPaletteColor(index: number, red: number, green: number, blue: number): void {
    this.palette.setColor(index, red, green, blue);
  }

  setPaletteIntensity(start: number, end: number, red: number, green: number, blue: number): void {
    this.palette.setIntensity(start, end, red, green, blue);
  }

  darkenPalette(red: number, green: number, blue: number, start: number, end: number): void {
    this.palette.setIntensity(start, end, red, green, blue);
  }

  /**
   * v7's shadow palette, which is numbered.
   *
   * A separate entry point from `setShadowPalette` because the two versions
   * really do take different things. v6 builds one table and is told the
   * channel scales and the colour range. v7 keeps several tables and is told
   * which one first, so the same five numbers arrive one position later. The
   * arguments are reordered here, in one place, rather than at the call site of
   * each version.
   *
   * The slot is dropped along with everything else for now, for the reason
   * `setShadowPalette` gives: no table is built, so there is nothing to build
   * several of.
   */
  /**
   * v2-v4's "room colour": a palette remap slot, written as a colour and an
   * index.
   *
   * v5 dropped the instruction, which is why it has no equivalent above. The
   * remap table it writes into is not built here, so the effect is recorded
   * and not applied — but the *operands are still read*, which is the part
   * that matters: this form takes two words where v5's `roomOps` sub-opcode 2
   * takes none, and a reader that skipped them would take the next
   * instruction's bytes as its own.
   */
  setRoomColour(slot: number, colour: number): void {
    this.warnOnce(
      'setRoomColour',
      `A script remapped room colour slot ${slot} to ${colour}. Palette remap ` +
        `tables are not implemented, so the room draws in its own colours.`,
    );
  }

  /** The same, for the shadow palette v2-v4 write one slot at a time. */
  setRoomShadowColour(slot: number, colour: number): void {
    this.warnOnce(
      'setRoomShadowColour',
      `A script wrote shadow palette slot ${slot} as colour ${colour}. Shadow ` +
        `palettes are not implemented, so the room draws unshaded.`,
    );
  }

  setShadowPaletteSlot(
    _slot: number,
    red: number,
    green: number,
    blue: number,
    startColor: number,
    endColor: number,
  ): void {
    this.setShadowPalette(red, green, blue, startColor, endColor);
  }

  setShadowPalette(
    _red: number,
    _green: number,
    _blue: number,
    _start: number,
    _end: number,
    _from = 0,
    _to = 256,
  ): void {
    // Shadow palettes drive translucency effects that are not implemented;
    // ignoring them draws the affected sprites opaque rather than not at all.
    // v6 passes a colour range as well, which is read for the same reason the
    // rest is: so a caller need not know which arguments are acted on.
  }

  palManipulate(_a: number, _b: number, _c: number, _d = 0): void {
    this.palette.markDirty();
  }

  /**
   * Selects one of the room's palettes.
   *
   * A v6 room can carry several. Sam & Max's film noir mode is the clearest
   * case: it is a second palette in the room rather than a filter over the
   * first, so a game that could not switch would play the sequence in colour.
   */
  setCurrentPalette(index: number): void {
    const room = this.currentRoomData;
    const chosen = room?.palettes[index];
    if (!chosen) {
      this.warn(
        `Script asked for palette ${index} of room ${this.currentRoom}, which carries ` +
          `${room?.palettes.length ?? 0}. The palette is left as it was.`,
      );
      return;
    }
    room.palette = chosen;
    this.palette.setFromClut(chosen);
    this.palette.markDirty();
  }

  /** Swaps two palette entries, as Sam & Max does for its flashing effects. */
  swapPaletteColors(a: number, b: number): void {
    const first = this.palette.getColor(a);
    const second = this.palette.getColor(b);
    this.palette.setColor(a, second[0], second[1], second[2]);
    this.palette.setColor(b, first[0], first[1], first[2]);
  }

  copyPaletteColor(from: number, to: number): void {
    const [red, green, blue] = this.palette.getColor(from);
    this.palette.setColor(to, red, green, blue);
  }

  /**
   * Desaturates a range of the palette in place.
   *
   * The weights are the ones the original uses, not perceptual ones: matching
   * it matters more than looking better, because the artwork was drawn against
   * this conversion.
   */
  applyGrayscale(start: number, end: number): void {
    for (let index = start; index <= end; index++) {
      const [red, green, blue] = this.palette.getColor(index);
      const gray = Math.min(255, (red * 77 + green * 151 + blue * 28) >> 8);
      this.palette.setColor(index, gray, gray, gray);
    }
  }

  /** The palette entry closest to a colour, for scripts that remap on the fly. */
  remapPaletteColor(red: number, green: number, blue: number): number {
    // Threshold -1 because the query form of this never steals a palette entry:
    // the script is asking which colour it already has, not asking for one to
    // be made. Only the actor recolour passes a real threshold.
    return this.palette.remapColor(red, green, blue, -1, 1, this.scummVersion === 7);
  }

  /**
   * Whether the room is shaking, from `roomOps`.
   *
   * Recorded rather than rendered: the shake is a vertical jitter of the room
   * image, and a script turns it on and off around events that read correctly
   * without it. Recording it keeps the state visible to a diagnostic and lets
   * the renderer pick it up later without touching the interpreter.
   */
  shaking = false;

  setShake(enabled: boolean): void {
    this.shaking = enabled;
  }

  setCycleSpeed(cycle: number, delay: number): void {
    this.palette.setCycleEnabled(cycle - 1, delay !== 0);
  }

  markScreenDirty(): void {
    this.palette.markDirty();
  }

  saveLoadRoom(_a: number, _b: number): void {
    // v5's form. Save/load in a v5 game is driven from the UI rather than from
    // scripts; v6's is not, and goes through `scriptSaveLoad`.
  }

  /**
   * A script asking to save or load, from a v6 game's own save menu.
   *
   * Handed to the host rather than acted on here: which slots exist and where
   * they are kept is the shell's business, and the engine has no way to ask the
   * player anything. Saying so once beats a menu that silently does nothing.
   */
  scriptSaveLoad(flag: number, slot: number): void {
    if (this.onScriptSaveLoad) {
      this.onScriptSaveLoad(flag, slot);
      return;
    }
    const action = flag === 1 ? 'save to' : flag === 2 ? 'load from' : `act (flag ${flag}) on`;
    this.warn(
      `The game's own menu asked to ${action} its slot ${slot}. Nothing is listening for ` +
        `that, so use the player's own save controls instead.`,
    );
  }

  /**
   * One pixel of the rendered room, as a palette index.
   *
   * Sam & Max's screensavers read the screen back and redraw from it. Out of
   * bounds answers -1, which is what the scripts test for — the original
   * reads whatever was next in memory instead, and the screensavers have
   * hard-coded dimensions that overrun a small room.
   */
  getScreenPixel(x: number, y: number): number {
    const main = this.screen.main;
    if (x < 0 || x >= SCREEN_WIDTH || y < 0 || y >= main.height) return -1;
    return this.screen.getPixel(x, y + main.top);
  }

  /**
   * Blanks the mask that keeps room artwork from painting over text.
   *
   * No such mask exists here: text is composited last, so nothing is being
   * held back and there is nothing to clear. Kept because the opcode is real
   * and a caller should not have to know which of these are no-ops.
   */
  clearCharsetMask(): void {}

  /**
   * Queues an object to be drawn over the room for one frame.
   *
   * "Blast" objects are how Sam & Max draws its verb coin, The Dig its
   * inventory and Full Throttle its action wheel: drawn straight to the screen
   * each frame, outside the room's own object list, and gone the next.
   *
   * A width or height of zero means the object's own, which is what a caller
   * usually passes — the size is there for the callers that crop.
   */
  enqueueBlastObject(
    objectId: number,
    x: number,
    y: number,
    width = 0,
    height = 0,
    scaleX = 255,
    scaleY = 255,
    image = 1,
    mode = 0,
  ): void {
    if (this.blastObjects.length >= BLAST_OBJECT_QUEUE_SIZE) {
      // The original errors here, so a script that overruns a queue this size
      // is doing something the game never did. Said once: a frame that does
      // this is a frame that happens sixty times a second.
      if (!this.reportedBlastObjectOverflow) {
        this.reportedBlastObjectOverflow = true;
        this.warn(
          `More than ${BLAST_OBJECT_QUEUE_SIZE} objects were queued for one frame, so the rest ` +
            `were dropped. The original interpreter's queue is the same size.`,
        );
      }
      return;
    }

    this.blastObjects.push({ objectId, x, y, width, height, scaleX, scaleY, image, mode });
  }

  private reportedBlastObjectOverflow = false;

  /** What is queued for this frame, for tests and diagnostics. */
  currentBlastObjects(): readonly BlastObject[] {
    return this.blastObjects;
  }

  /**
   * Draws this frame's queued objects.
   *
   * Straight to the screen rather than into the room's background, which is
   * the whole difference between this and `drawObject`: nothing here is part of
   * the room, so nothing here has to be painted back out afterwards.
   *
   * The artwork is a `BOMP` — a run-length form that carries its own size, and
   * one an object only ships if a script means to blast it. An object drawn
   * this way that has no `BOMP` is a script error in the original, which errors
   * out; here it is reported once and skipped, because a missing verb coin is
   * something a player can still play around.
   */
  private drawBlastObjects(): void {
    for (const entry of this.blastObjects) {
      const image = this.blastObjectImage(entry);
      if (!image) continue;

      const { pixels, width, height } = image;

      // Scaling drops rows and columns rather than resampling them, and the
      // survivors close up against the object's top-left corner — so a
      // half-scale wheel spoke is half the size at the same position, not a
      // sparse version of the full-size one.
      const fullScale =
        entry.scaleX === BLAST_OBJECT_FULL_SCALE && entry.scaleY === BLAST_OBJECT_FULL_SCALE;
      const columns = fullScale ? null : bompScaleMask(width, entry.scaleX);
      const rows = fullScale ? null : bompScaleMask(height, entry.scaleY);

      // A scaled picture is never shaded: the original throws the mode away
      // when either axis is short of full, because the two effects share one
      // blitter and the scaled path has no shadow step in it.
      if (entry.mode !== 0 && fullScale) this.reportBlastObjectMode(entry.mode);

      // Screen coordinates, not room ones: a blast object is positioned
      // against the window rather than against the room behind it. Anything
      // off the edge is dropped by `putPixel`, which is what the original's
      // clip rectangle amounts to.
      let destRow = 0;
      for (let row = 0; row < height; row++) {
        if (rows && !rows[row]) continue;

        let destColumn = 0;
        for (let column = 0; column < width; column++) {
          if (columns && !columns[column]) continue;

          const color = pixels[row * width + column];
          if (color !== BLAST_OBJECT_TRANSPARENT) {
            this.screen.putPixel(entry.x + destColumn, entry.y + destRow, color);
          }
          destColumn++;
        }
        destRow++;
      }
    }
  }

  /**
   * Says once that a shadow mode was asked for and drawn without.
   *
   * Mode 3 recolours the picture's darkest eight indices through a shadow
   * palette, which nothing here builds yet — `setShadowPalette` records
   * nothing, so there is no table to look the replacement up in. Drawing the
   * artwork plainly is the closer of the two wrong answers: the picture is in
   * the right place at the right size, and only its shading is missing.
   */
  private reportBlastObjectMode(mode: number): void {
    if (this.reportedBlastObjectMode) return;
    this.reportedBlastObjectMode = true;
    this.warn(
      `An object was queued to be drawn over the frame with shadow mode ${mode}, which needs a ` +
        `shadow palette this build does not keep. It was drawn without shading.`,
    );
  }

  private reportedBlastObjectMode = false;

  /**
   * Decodes a queued object's artwork, or reports why it could not be.
   *
   * The image number is one-based and selects between the object's pictures,
   * which is how a queued object becomes a highlighted verb rather than a plain
   * one. An object shipping fewer images than a script asks for falls back to
   * its first, because Sam & Max relies on exactly that.
   */
  private blastObjectImage(
    entry: BlastObject,
  ): { pixels: Uint8Array; width: number; height: number } | null {
    const room = this.currentRoomData;
    const object = room?.findObject(entry.objectId);
    if (!room || !object?.image)
      return this.reportBlastObject(entry.objectId, 'is not in the room');

    const data = this.objectBytes(object, room);
    // Asking for a state the object does not carry is not a mistake here: Sam
    // & Max queues numbers its objects do not have, and the original keeps a
    // fallback to the first image for it. That fallback is `findObjectImage`'s
    // own, shared with the objects painted into a room, so there is nothing to
    // repeat on top of it.
    const imageOffset = findObjectImage(data, object.image.obimOffset, entry.image);
    if (imageOffset === null) return this.reportBlastObject(entry.objectId, 'has no image');

    const wrapper = readChunkHeader(data, imageOffset);
    const bomp = findChunk(data, wrapper.dataOffset, 'BOMP', wrapper.dataOffset + wrapper.dataSize);
    if (!bomp) {
      return this.reportBlastObject(entry.objectId, 'is not a blast object: its image has no BOMP');
    }

    // The BOMP's own header, which the size a script passed does not override:
    // a crop changes where the picture is clipped, not how it is decoded.
    const header = bomp.dataOffset;
    if (header + BOMP_HEADER_SIZE > data.length) {
      return this.reportBlastObject(entry.objectId, 'has a truncated BOMP');
    }
    const width = data[header + 2] | (data[header + 3] << 8);
    const height = data[header + 4] | (data[header + 5] << 8);
    if (width === 0 || height === 0) return null;

    const source = data.subarray(header + BOMP_HEADER_SIZE, bomp.dataOffset + bomp.dataSize);
    // Decoded with zeros written, because 255 is what a blast object treats as
    // transparent — see `BLAST_OBJECT_TRANSPARENT`.
    return { pixels: decodeBomp(source, width, height, true), width, height };
  }

  /** Says once why a queued object could not be drawn, and yields nothing. */
  private reportBlastObject(objectId: number, why: string): null {
    if (!this.reportedBlastObjects.has(objectId)) {
      this.reportedBlastObjects.add(objectId);
      this.warn(`Object ${objectId} was queued to be drawn over the frame, but it ${why}.`);
    }
    return null;
  }

  private readonly reportedBlastObjects = new Set<number>();

  /**
   * Floating objects: objects a script adds to this room from another one.
   *
   * Only the object's entry joins this room's list; its code and image stay in
   * the room that owns them and it carries that buffer along (`source`). The
   * original copies the bytes into a `FLOB` resource because its memory manager
   * addresses everything by resource, but nothing writes to a room buffer here,
   * so a reference costs nothing and cannot drift from the original.
   *
   * They live only as long as the room does: entering another parses a fresh
   * `Room`, and the list goes with the old one, which is what the original does
   * when it frees the room's resources.
   */
  loadFloatingObject(objectId: number, room: number): void {
    const current = this.currentRoomData;
    if (!current) return;

    // Already here — one of the room's own, or from an earlier call. The
    // original checks the same thing, because a script may ask twice.
    if (current.findObject(objectId)) return;

    const source = this.floatingObjectRoom(room);
    const object = source?.findObject(objectId);
    if (!object || !source) {
      if (this.reportedFloatingObjects.has(objectId)) return;
      this.reportedFloatingObjects.add(objectId);
      this.warn(
        `Script asked for floating object ${objectId} from room ${room}, which does not have ` +
          `it. It will not be in this room.`,
      );
      return;
    }

    const floating: RoomObject = {
      ...object,
      // Copied, because the room it came from keeps its own and a shared map
      // would let a verb added here appear there.
      verbs: new Map(object.verbs),
      source: source.data,
      // `parent` is a one-based index into the room's *own* object list, so the
      // number the source room recorded names an unrelated object here, or none
      // at all. A floating object has no parent to stand behind.
      parent: 0,
      parentState: 0,
    };
    current.objects.push(floating);

    // Objects are stamped into the background as the room is built, and this
    // one arrived after that, so it has to stamp itself.
    const state = this.getState(objectId);
    if (state !== 0 && this.isObjectInRoom(objectId)) {
      floating.state = state;
      this.drawObjectImage(floating, state);
    }
  }

  /**
   * Removes floating objects in a number range, and only those.
   *
   * A room's own objects are described by its resource and are not the script's
   * to remove: the original frees only what it allocated for a floating object,
   * and nuking a range that happens to cover scenery would empty the room.
   */
  nukeFloatingObjects(from: number, to: number): void {
    const room = this.currentRoomData;
    if (!room) return;

    const kept = room.objects.filter(
      (object) => object.source === undefined || object.id < from || object.id > to,
    );
    if (kept.length === room.objects.length) return;

    room.objects.length = 0;
    room.objects.push(...kept);
    // Whatever they drew is still in the background, so it has to be rebuilt
    // from the room and the objects that remain.
    this.refreshRoomBackground();
  }

  /**
   * A room parsed only to lend objects out of, kept for the next call.
   *
   * A script loads floating objects one at a time and can come back to the same
   * room repeatedly, so parsing per call would re-read one resource many times.
   * Null is cached too: a room the data file does not have will not appear.
   */
  /**
   * Whether a room's resource carries a picture for an object.
   *
   * Asked by `verbOps`'s image sub-opcode, which names an object and no room.
   * The original copies the object's picture into a resource of the verb's own
   * at that moment, and copies it out of whichever room is current — but only
   * if the object is one of that room's; when it is not, `setVerbObject` finds
   * nothing to copy and simply returns, and the verb keeps the picture it
   * already had. That is not a fallback, it is the whole mechanism: Loom
   * defines its distaff once in room 1 and then re-positions the same verbs
   * from every other room in the game, and the picture survives because the
   * re-definition cannot find the object and leaves the copy alone.
   */
  roomHasObjectImage(room: number, objectId: number): boolean {
    const source = room === this.currentRoom ? this.currentRoomData : this.floatingObjectRoom(room);
    return source?.findObject(objectId)?.image !== undefined;
  }

  private floatingObjectRoom(room: number): Room | null {
    const cached = this.floatingObjectRooms.get(room);
    if (cached !== undefined) return cached;

    const resource = this.resources.getRoom(room);
    const parsed = resource
      ? new Room(room, resource, this.resources.game.version, this.resources.roomSources(room))
      : null;
    this.floatingObjectRooms.set(room, parsed);
    return parsed;
  }

  private readonly floatingObjectRooms = new Map<number, Room | null>();

  private readonly reportedFloatingObjects = new Set<number>();

  /**
   * Whether a key is down, for scripts that poll rather than wait.
   *
   * Answered from the last key press, which is what this engine records: there
   * is no held-key state, so a script polling for a key held across frames sees
   * it only while the press is current. Sam & Max's screensavers poll like
   * this; the games' ordinary input does not.
   */
  getKeyState(key: number): number {
    return this.variables[this.vars.KEYPRESS] === key ? 1 : 0;
  }

  drawBox(x: number, y: number, x2: number, y2: number, color: number): void {
    const left = Math.min(x, x2);
    const top = Math.min(y, y2);
    const width = Math.abs(x2 - x) + 1;
    const height = Math.abs(y2 - y) + 1;
    this.screen.fillRect(left, top + this.screen.main.top, width, height, color);
  }

  // ------------------------------------------------------ boxes and scales --

  setBoxFlags(box: number, value: number): void {
    const boxes = this.currentRoomData?.boxes;
    if (!boxes || !boxes[box]) return;
    boxes[box].flags = value;
    this.rebuildBoxMatrix();
  }

  setBoxScale(box: number, value: number): void {
    const boxes = this.currentRoomData?.boxes;
    if (!boxes || !boxes[box]) return;
    boxes[box].scale = value;
  }

  rebuildBoxMatrix(): void {
    const room = this.currentRoomData;
    if (!room) return;
    this.boxes = new BoxMatrix(room.boxes, room.scaleSlots);
  }

  getBoxFlags(box: number): number {
    return this.currentRoomData?.boxes[box]?.flags ?? 0;
  }

  /** Which box a point falls in, or 0 when it falls in none. */
  getSpecialBox(x: number, y: number): number {
    const box = this.boxes?.findBoxAt(x, y) ?? INVALID_BOX;
    return box === INVALID_BOX ? 0 : box;
  }

  isPointInBox(box: number, x: number, y: number): boolean {
    return Boolean(this.boxes?.contains(box, x, y));
  }

  /**
   * Switches the room to another of its box sets.
   *
   * A v6 room can carry several `BOXD`/`BOXM` pairs and change which one is in
   * force without changing rooms — the way a room opens up once a door is
   * unlocked. Sets are numbered from one in the script and from zero here.
   */
  setBoxSet(set: number): void {
    const room = this.currentRoomData;
    const boxes = room?.boxSets[set];
    if (!room || !boxes) {
      this.warn(
        `Script asked for box set ${set + 1} of room ${this.currentRoom}, which carries ` +
          `${room?.boxSets.length ?? 0}. The walk boxes are left as they were.`,
      );
      return;
    }
    room.boxes = boxes;
    room.boxMatrix = room.boxMatrixSets[set] ?? room.boxMatrix;
    this.rebuildBoxMatrix();
    // Actors standing in a box that has just moved would keep their old walk
    // box for ever, since nothing else recomputes it.
    for (const actor of this.actors) {
      if (actor.isInCurrentRoom(this.currentRoom)) this.putActor(actor.number, actor.x, actor.y);
    }
  }

  setScaleSlot(
    slot: number,
    x1: number,
    y1: number,
    scale1: number,
    x2: number,
    y2: number,
    scale2: number,
  ): void {
    const room = this.currentRoomData;
    if (!room) return;
    const index = slot - 1;
    if (index < 0) return;
    while (room.scaleSlots.length <= index) {
      room.scaleSlots.push({ scale1: 0, y1: 0, scale2: 0, y2: 0, x1: 0, x2: 0 });
    }
    room.scaleSlots[index] = { x1, y1, scale1, x2, y2, scale2 };
    this.rebuildBoxMatrix();
  }

  // ----------------------------------------------------------- positioning --

  getObjectOrActorXY(id: number): { x: number; y: number } | null {
    if (id < this.actors.length) {
      const actor = this.getActor(id);
      if (actor && actor.isInCurrentRoom(this.currentRoom)) {
        return { x: actor.x, y: actor.y };
      }
      if (actor && actor.room !== this.currentRoom) return null;
    }

    const object = this.currentRoomData?.findObject(id);
    if (!object) return null;

    // Objects declare a walk-to point; fall back to the hotspot, then centre.
    if (object.walkX !== 0 || object.walkY !== 0) {
      return { x: object.walkX, y: object.walkY };
    }
    const hotspot = object.image?.hotspots[Math.max(0, this.getState(id) - 1)];
    if (hotspot) return { x: object.x + hotspot.x, y: object.y + hotspot.y };
    return { x: object.x + (object.width >> 1), y: object.y + (object.height >> 1) };
  }

  getObjectOrActorX(id: number): number {
    return this.getObjectOrActorXY(id)?.x ?? 0;
  }

  getObjectOrActorY(id: number): number {
    return this.getObjectOrActorXY(id)?.y ?? 0;
  }

  getObjectOrActorDistance(a: number, b: number): number {
    const pa = this.getObjectOrActorXY(a);
    const pb = this.getObjectOrActorXY(b);
    if (!pa || !pb) return 0xff;
    return this.distanceBetweenPoints(pa.x, pa.y, pb.x, pb.y);
  }

  /**
   * Distance from an object or actor to a point.
   *
   * v6 asks for three combinations — thing to thing, thing to point, point to
   * point — where v5 only ever asked the first. Capping at 0xFE is what makes
   * 0xFF mean "one of them is not here", which is what the scripts test.
   */
  getDistanceToPoint(id: number, x: number, y: number): number {
    const position = this.getObjectOrActorXY(id);
    if (!position) return 0xff;
    return this.distanceBetweenPoints(position.x, position.y, x, y);
  }

  distanceBetweenPoints(x1: number, y1: number, x2: number, y2: number): number {
    const dx = x1 - x2;
    const dy = y1 - y2;
    return Math.min(0xfe, Math.round(Math.sqrt(dx * dx + dy * dy)));
  }

  /** Nearest actor or object to `target`, as `getClosestObjActor` expects. */
  getClosestObjOrActor(target: number): number {
    let best = 0;
    let bestDistance = 0xff;

    for (const actor of this.actors) {
      if (actor.number === 0 || actor.number === target) continue;
      if (!actor.isInCurrentRoom(this.currentRoom)) continue;
      const distance = this.getObjectOrActorDistance(target, actor.number);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = actor.number;
      }
    }

    return best;
  }

  /**
   * Changes room and brings the player with them.
   *
   * The actor is placed at the destination object's position *after* the room
   * loads, because the object only exists once the new room is parsed. An
   * optional walk target then moves them on from there — which is how a script
   * has the player step away from the door they just came through.
   *
   * This is the only safe way for a room or object script to change room: the
   * room change kills those scripts, so anything the script would have done
   * afterwards never runs. Doing the placement inside the opcode avoids that.
   */
  loadRoomWithEgo(objectId: number, room: number, x: number, y: number): void {
    const ego = this.getActor(this.variables[this.vars.EGO]);
    if (!ego) return;

    ego.room = room;
    this.startScene(room, ego, objectId);
    ego.visible = true;

    const position = this.getObjectOrActorXY(objectId);
    if (position) {
      this.putActor(ego.number, position.x, position.y);
      const object = this.currentRoomData?.findObject(objectId);
      if (object) this.setActorDirection(ego, oldDirToNewDir(object.actorDir & 3));
    }
    this.stopActorAndStand(ego);

    // v5 and v6 snap the camera to the actor and make it follow; v7 does not.
    // Under v7 the camera is told who to follow by `actorFollowCamera` and
    // nothing else, so doing it here as well overrides whatever the room's
    // entry script had just set — the room opens looking at the wrong thing,
    // and only until the next script touches the camera, which is the kind of
    // fault that reads as a random glitch.
    if (this.scummVersion < 7) {
      this.camera.current = ego.x;
      this.camera.destination = ego.x;
      this.actorFollowCamera(ego.number);
    }

    if (x !== -1 && y !== -1) this.startWalkActor(ego.number, x, y, -1);
  }

  // -------------------------------------------------------------- cutscene --

  /**
   * Opens a cutscene level.
   *
   * The engine itself neither freezes scripts nor hides the cursor: SCUMM
   * delegates that to the game's own cutscene start script, which is why a
   * cutscene that never ends leaves input suspended with nothing left to
   * restore it.
   */
  beginCutscene(args: number[]): void {
    const stack = this.scriptState.cutSceneStack;
    if (stack.length >= MAX_CUTSCENE_DEPTH) {
      this.log(`Cutscene stack overflow at depth ${stack.length}; ignoring beginCutscene`);
      return;
    }

    const ownerSlot = this.scriptState.currentSlot;
    const slot = this.scriptState.slots[ownerSlot];
    if (slot) slot.cutsceneOverride++;

    stack.push({
      ownerSlot,
      ownerScript: slot ? slot.number : 0,
      data: args[0] ?? 0,
    });

    // The new depth starts with no skip point, the way the original clears the
    // arrays at the index it has just moved to.
    const override = this.scriptState.currentOverride;
    override.slot = -1;
    override.pointer = -1;

    this.variables[this.vars.OVERRIDE] = 0;

    // The start script runs nested, so it becomes the current script while
    // this one waits mid-opcode. Naming the owning slot for the duration is
    // what lets `freezeScripts` leave it running when the start script freezes
    // the world; without it the script that opened the cutscene is frozen by
    // the cutscene it opened, and nothing can ever close it.
    this.scriptState.startingCutsceneSlot = ownerSlot;
    const startScript = this.variables[this.vars.CUTSCENE_START_SCRIPT];
    if (startScript) this.scripts.runScript(startScript, false, false, args);
    this.scriptState.startingCutsceneSlot = -1;
  }

  endCutscene(): void {
    const slot = this.scriptState.slots[this.scriptState.currentSlot];
    if (slot && slot.cutsceneOverride > 0) slot.cutsceneOverride--;

    const override = this.scriptState.currentOverride;
    override.slot = -1;
    override.pointer = -1;

    const level = this.scriptState.cutSceneStack.pop();

    this.variables[this.vars.OVERRIDE] = 0;

    const endScript = this.variables[this.vars.CUTSCENE_END_SCRIPT];
    if (endScript) this.scripts.runScript(endScript, false, false, [level?.data ?? 0]);
  }

  /**
   * Arms the resume point for a cutscene the player skips.
   *
   * The offset is the instruction the script would jump over; skipping resumes
   * there rather than at the end of the script, so state the cutscene set up is
   * still applied.
   */
  beginOverride(slotIndex: number, offset: number): void {
    // Not stored on the open cutscene, because there need not be one: the skip
    // point belongs to the depth the game is at. Day of the Tentacle arms one
    // at depth zero for its whole intro, and hanging this off a cutscene level
    // dropped it — leaving an intro the player could not escape from.
    const override = this.scriptState.currentOverride;
    override.slot = slotIndex;
    override.pointer = offset;
    this.variables[this.vars.OVERRIDE] = 0;
  }

  endOverride(): void {
    const override = this.scriptState.currentOverride;
    override.slot = -1;
    override.pointer = -1;
    this.variables[this.vars.OVERRIDE] = 0;
  }

  /**
   * Skips what is playing, when the game has said where to resume.
   *
   * The script does not stop: it jumps to the point it armed with
   * `beginOverride`, which is past the scene but before whatever the scene was
   * setting up. That is why skipping an intro leaves the game in a playable
   * state rather than one missing everything the intro would have arranged.
   *
   * Nothing happens when no skip point is armed, which is how a game says a
   * scene may not be skipped.
   */
  abortCutscene(): void {
    const override = this.scriptState.currentOverride;
    if (override.pointer < 0) return;

    const slot = this.scriptState.slots[override.slot];
    if (slot) {
      slot.offset = override.pointer;
      slot.status = ScriptStatus.Running;
      slot.freezeCount = 0;
      slot.delay = 0;
      slot.delayed = false;
      if (slot.cutsceneOverride > 0) slot.cutsceneOverride--;
    }

    this.variables[this.vars.OVERRIDE] = 1;
    override.pointer = -1;
    override.slot = -1;
  }

  /**
   * Drops cutscene levels whose owning script no longer exists.
   *
   * Leaving a room kills every room-owned and local script. A cutscene one of
   * them opened can then never be closed — nothing is left to run
   * `endCutscene` — so the depth stays non-zero and input stays suspended for
   * the rest of the session. SCUMM only warns here; unwinding as well is a
   * deliberate divergence, on the grounds that a cutscene nobody can end is
   * never what the game wanted.
   */
  unwindOrphanedCutscenes(): void {
    const stack = this.scriptState.cutSceneStack;
    let unwound = 0;

    while (stack.length > 0) {
      const level = stack[stack.length - 1];
      const slot = this.scriptState.slots[level.ownerSlot];
      const alive = slot && slot.status !== ScriptStatus.Dead && slot.number === level.ownerScript;
      if (alive) break;

      this.log(
        `Cutscene opened by script ${level.ownerScript} was orphaned when its script died; ` +
          'unwinding so input is not suspended forever',
      );
      stack.pop();
      unwound++;
    }

    if (unwound === 0 || stack.length > 0) return;

    // Whatever the start script suspended is not coming back on its own.
    this.setUserPut(true);
    this.setCursorVisible(true);
    this.scripts.thawAllScripts();
  }

  setPseudoRoom(from: number, to: number): void {
    this.pseudoRooms.set(from, to);
  }

  /**
   * The room whose resource a room number names.
   *
   * The same number for anything below 128, and a lookup above it. v7 dropped
   * the mechanism, so its numbers are always themselves.
   */
  private pseudoRoomResource(room: number): number {
    if (room < 0x80 || this.scummVersion >= 7) return room;
    return this.pseudoRooms.get(room & 0x7f) ?? room;
  }

  // ---------------------------------------------------------------- system --

  ensureResource(type: ResourceType, id: number): void {
    // Everything is already resident; this only warms the caches.
    if (type === 'costume') this.costumeProblem(id);
    else if (type === 'charset') this.getCharset(id);
  }

  restart(): void {
    this.resetGameState();
    // Called from a script, mid-frame. A throw here would escape the frame
    // loop and stop the game with a browser error rather than a reason, so the
    // failure is logged and the session left running for the player to see.
    try {
      this.boot(0);
    } catch (error) {
      this.log(error instanceof Error ? error.message : String(error));
    }
  }

  pauseGame(): void {
    this.log('Game paused by script');
  }

  quitGame(): void {
    this.quitRequested = true;
    this.log('Game requested quit');
  }

  get hasQuit(): boolean {
    return this.quitRequested;
  }

  random(max: number): number {
    return Math.floor(this.rng() * (max + 1));
  }

  /**
   * Notes a script that hit the opcode budget without yielding.
   *
   * Reported once per script: a stuck script trips this every frame, and a log
   * line per frame would itself be a problem.
   */
  reportRunawayScript(script: number, offset: number, opcodes: number): void {
    if (this.stuckScripts.has(script)) return;
    this.stuckScripts.add(script);
    this.log(
      `Script ${script} ran ${opcodes} opcodes without yielding (offset ${offset}). ` +
        `Pausing it at the end of each frame so the page stays responsive; ` +
        `it is most likely stuck in a loop.`,
    );
  }

  /**
   * Notes a script that read past the end of its own code.
   *
   * Means the engine misread an operand width somewhere upstream, so the
   * offset is the useful part of the report: it says where to look.
   */
  reportScriptOverrun(script: number, offset: number, trail = '', code = ''): void {
    if (this.overrunScripts.has(script)) return;
    this.overrunScripts.add(script);
    this.stuckScripts.add(script);
    this.log(
      `Script ${script} read past the end of its code at offset ${offset} and was ` +
        `stopped. Its opcodes are being misread — the log above names any ` +
        `unimplemented ones.`,
    );
    // The trail and the bytes are what make this diagnosable: the instruction
    // that consumed the wrong number of operands is in the trail, and the dump
    // is enough to disassemble by hand and see what it should have consumed.
    if (trail) this.log(`  last instructions (offset:opcode): ${trail}`);
    if (code) this.log(`  script ${script} bytes: ${code}`);
  }

  /**
   * Notes a sub-opcode the engine does not implement.
   *
   * Reported once per instruction and sub-opcode pair. Unlike an unimplemented
   * top-level opcode, this one does not stop the script, so it is worth naming
   * even though the game carries on for a while afterwards.
   *
   * What it costs depends on where the instruction reads its arguments, which
   * is why the caller says: an inline operand cannot be skipped past when the
   * sub-opcode that describes it is unknown, but an argument taken off the
   * stack was read before the dispatch and costs nothing. Reporting all three
   * as a corrupted instruction stream sent a reader after a desync that was
   * not there — v7's `kernelSetFunctions` pops its whole argument list up
   * front, so the one thing that report could be sure of was that nothing
   * after it was misread.
   */
  /**
   * Logs a message the first time it applies, keyed by whatever makes it new.
   *
   * A script instruction runs every frame, so a bare log about one that cannot
   * do its job buries the rest of the report under thousands of copies of the
   * same line. The key is the caller's, because what counts as the same
   * complaint differs: one per sound number, not one per instruction.
   */
  warnOnce(key: string, message: string): void {
    if (this.reportedSubOpcodes.has(key)) return;
    this.reportedSubOpcodes.add(key);
    this.log(message);
  }

  reportUnknownSubOpcode(
    instruction: string,
    subOpcode: number,
    script: number,
    offset: number,
    effect: SubOpcodeEffect,
    context = '',
    trail = '',
  ): void {
    const key = `${instruction}:${subOpcode}`;
    if (this.reportedSubOpcodes.has(key)) return;
    this.reportedSubOpcodes.add(key);
    this.log(
      `Unimplemented ${instruction} sub-opcode 0x${subOpcode.toString(16).padStart(2, '0')} ` +
        `in script ${script} at offset ${offset}. ${SUB_OPCODE_COST[effect]}`,
    );
    // The bytes either side say what really went wrong: an unknown sub-opcode
    // is usually not the bug but its first symptom, the instruction before it
    // having consumed the wrong number of operands.
    if (context) this.log(`  bytes: ${context}`);
    if (trail) this.log(`  last instructions (offset:opcode): ${trail}`);
  }

  /** Notes that a whole frame's worth of script time was used up. */
  reportScriptBudgetExhausted(opcodes: number): void {
    if (this.reportedScriptBudget) return;
    this.reportedScriptBudget = true;
    this.log(
      `Scripts used the whole ${opcodes} opcode frame budget; the rest continue ` +
        `next frame. Expected on a heavy room change, repeated every frame means ` +
        `something is stuck.`,
    );
  }

  reportUnknownOpcode(opcode: number, script: number, offset: number, trail = ''): void {
    const name = `0x${opcode.toString(16).padStart(2, '0')}`;

    // Script 1 only: a script the boot script started can die without the boot
    // script itself failing to finish, and the load is about the boot script.
    // Recorded before the once-per-opcode guard, so the same opcode stopping a
    // second boot still fails that boot.
    if (this.booting && script === 1 && !this.bootFailure) {
      this.bootFailure =
        `Unimplemented opcode ${name} at offset ${offset} stopped the boot ` +
        `script, so the game cannot start.`;
    }

    const key = opcode;
    if (this.reportedOpcodes.has(key)) return;
    this.reportedOpcodes.add(key);
    this.unknownOpcodes.set(opcode, script);
    this.log(
      script === 1
        ? `Unimplemented opcode ${name} at offset ${offset} stopped the boot script, ` +
            `so the game cannot start. Either this opcode is missing from the v5 ` +
            `table, or these scripts are not v5 bytecode — a version this engine ` +
            `misread as v5 produces exactly this, so check the version before ` +
            `adding the opcode.`
        : `Unimplemented opcode ${name} in script ${script} at offset ${offset}`,
    );
    // What ran just before is the useful half of the report. An unknown opcode
    // in a stack machine is usually not the bug but its first symptom: an
    // earlier instruction consumed the wrong number of operands, and the
    // program counter has been drifting since.
    if (trail) this.log(`  last instructions (offset:opcode): ${trail}`);
  }

  // ------------------------------------------------------------------ input --

  /**
   * Whether the game's own scripts decide what a click means.
   *
   * They always do, in every version this engine runs, because that is what
   * `checkExecVerbs` does: the interpreter says *where* the click landed — a
   * verb, the scene, a key — and the game's input script says what it means.
   * Sam & Max's verb coin is the case that makes the rule obvious, having no
   * verb panel to hit-test, but v5 needs it just as much and for a less
   * visible reason. Atlantis's opening attic has no verb panel either: it runs
   * with `VAR_VERB_SCRIPT` pointed at a cut-down script that handles scene
   * clicks and keys and nothing else, and the game is played entirely by
   * clicking in the room. Resolving those clicks here instead — pairing
   * whatever verb was last clicked with whatever object is under the cursor —
   * produced a scene in which nothing responded to anything.
   *
   * A game with no input script at all keeps the interpreter's own handling
   * below, which is what a compiled project used before its compiler learned
   * to emit one.
   */
  get scriptsOwnInput(): boolean {
    return this.variables[this.vars.VERB_SCRIPT] !== 0;
  }

  /**
   * Runs the game's input script: what was clicked, and with which button.
   *
   * Everything a player does arrives here in a v6 game — a verb, a click in the
   * room, a key — and the script decides what it means. The three values go in
   * as its first three locals.
   */
  runInputScript(clickArea: ClickArea, value: number, button: number): void {
    const verbScript = this.variables[this.vars.VERB_SCRIPT];
    if (!verbScript) return;
    this.scripts.runScript(verbScript, false, false, [clickArea, value, button]);
  }

  /**
   * Which mouse buttons are held, for the games that read them.
   *
   * v6 added two variables for this, and Sam & Max's verb coin is built on
   * them: the coin opens while the button is down and commits when it comes up.
   * A click reported only as an instant event opens the coin and never closes
   * it.
   *
   * Nothing is written for a v5 game. Those variable numbers hold something
   * else entirely there, and writing to them would corrupt whatever the game
   * keeps in them.
   *
   * v7 numbers them differently again — 24 and 25 against v6's 74 and 75 — so
   * these come from the running version's table rather than from v6's. Written
   * at v6's numbers under v7, they land on two slots v7 assigns nothing to,
   * which a game is free to be using for something of its own.
   */
  setButtonsHeld(left: boolean, right: boolean): void {
    if (this.resources.game.version < 6) return;
    this.variables[this.vars.LEFTBTN_HOLD] = left ? 1 : 0;
    this.variables[this.vars.RIGHTBTN_HOLD] = right ? 1 : 0;
  }

  /**
   * A mouse button going down.
   *
   * Acted on at press rather than at release, because that is when the original
   * acts and because a coin that opened on release would have nothing left to
   * commit. For a v5 game this only records the button; `handleRoomClick` and
   * `handleVerbClick` still do the work, on the click.
   */
  pressButton(button: number, screenX: number, screenY: number): void {
    this.setButtonsHeld(button === MouseButton.Left, button === MouseButton.Right);
    if (!this.userPut) return;

    this.setMousePosition(screenX, screenY);

    if (screenY >= this.screen.verb.top) {
      // A click in the verb strip that missed every verb is neither a verb
      // click nor a scene one: the original reports nothing at all
      // (`checkExecVerbs`). Reporting verb 0 instead hands the input script a
      // verb id it has no case for.
      const verbId = this.verbs.hitTest(screenX, screenY);
      if (verbId !== 0) this.handleVerbClick(verbId, button);
      return;
    }

    if (this.scriptsOwnInput) {
      this.runInputScript(ClickArea.Scene, 0, button);
      return;
    }
    // Right click is the "default verb" shortcut where nothing is listening.
    this.handleRoomClick(screenX, screenY, button === MouseButton.Right ? 0 : this.currentVerb);
  }

  releaseButton(): void {
    this.setButtonsHeld(false, false);
  }

  handleRoomClick(screenX: number, screenY: number, currentVerb: number): void {
    // In a v6 game the press already went to the game's input script; acting
    // again on the release would run the whole sentence twice.
    if (this.scriptsOwnInput) return;
    if (!this.userPut) return;

    const roomX = screenX + this.cameraLeft();
    const roomY = screenY - this.screen.main.top;

    this.variables[this.vars.VIRT_MOUSE_X] = roomX;
    this.variables[this.vars.VIRT_MOUSE_Y] = roomY;

    const objectId = this.findObjectAt(roomX, roomY);
    if (objectId !== 0) {
      this.doSentence(currentVerb, objectId, 0);
      return;
    }

    const actorId = this.actorFromPos(roomX, roomY);
    if (actorId !== 0) {
      this.doSentence(currentVerb, actorId, 0);
      return;
    }

    const ego = this.getActor(this.variables[this.vars.EGO]);
    if (ego) this.startWalkActor(ego.number, roomX, roomY, -1);
  }

  /**
   * The player chose a verb — by clicking it, or by its keyboard shortcut.
   *
   * The chosen verb is recorded whether or not a script is listening, because
   * the interpreter's own sentence line is composed from it for games that
   * have no script to compose one. What happens next is the input script's
   * decision, in the one shape every shipped game expects.
   */
  handleVerbClick(verbId: number, button: number = MouseButton.Left): void {
    if (!this.userPut || verbId === 0) return;
    this.currentVerb = verbId;
    if (this.scriptsOwnInput) {
      this.runInputScript(ClickArea.Verb, verbId, button);
      return;
    }
    const verbScript = this.variables[this.vars.VERB_SCRIPT];
    if (verbScript) this.scripts.runScript(verbScript, false, false, [verbId, 0]);
  }

  /** Told by the script engine that a script has written verb 0's text. */
  claimSentenceLine(): void {
    this.sentenceLineClaimed = true;
  }

  /**
   * Composes the sentence line from the chosen verb and whatever is under the
   * cursor.
   *
   * This is the half of the verb panel that makes it an interface rather than
   * a row of words: without it a player clicks "Open", moves onto a door, and
   * is told nothing about what is about to happen. A published game does this
   * from its own scripts; a compiled project has no such script and nothing
   * ever filled the line in, so it is done here — and abandoned the moment a
   * script shows it wants the line for itself.
   */
  private updateSentenceLine(): void {
    if (this.sentenceLineClaimed) return;
    const line = this.verbs.get(0);
    if (!line || !line.enabled) return;

    const verbText = this.verbs.get(this.currentVerb)?.text ?? '';
    const target = this.nameUnderCursor();
    const text = (target ? `${verbText} ${target}` : verbText).trim();
    if (line.text === text) return;

    line.text = text;
    line.type = 'text';
    this.verbs.markDirty();
  }

  /** What the cursor is over in the room, named, or an empty string. */
  private nameUnderCursor(): string {
    // The verb panel is not the room, and an object happening to sit at the
    // same room coordinates should not be named while the cursor is down there.
    if (this.variables[this.vars.MOUSE_Y] >= this.screen.verb.top) return '';

    const x = this.variables[this.vars.VIRT_MOUSE_X];
    const y = this.variables[this.vars.VIRT_MOUSE_Y];

    const objectId = this.findObjectAt(x, y);
    if (objectId !== 0) return this.getObjectName(objectId);

    const actorId = this.actorFromPos(x, y);
    if (actorId !== 0) return this.getActor(actorId)?.name ?? '';
    return '';
  }

  setMousePosition(screenX: number, screenY: number): void {
    this.variables[this.vars.MOUSE_X] = screenX;
    this.variables[this.vars.MOUSE_Y] = screenY;
    this.variables[this.vars.VIRT_MOUSE_X] = screenX + this.cameraLeft();
    this.variables[this.vars.VIRT_MOUSE_Y] = screenY - this.screen.main.top;
  }

  /**
   * Keys currently held down.
   *
   * `VAR_KEYPRESS` records the last key *pressed*, which is what v5 and v6
   * scripts poll and is enough for them: Sam & Max's screensavers ask "was a
   * key hit", and the games' ordinary input is click-driven.
   *
   * An interactive SMUSH sequence is not that. Full Throttle's bike combat
   * reads a direction the player is *holding* while the video runs, and a
   * last-press variable answers "yes" for one frame and "no" for every frame
   * after — which reads as a control that fires once and then sticks. So held
   * state is tracked alongside, and only the sequences that need it look here.
   */
  private readonly keysHeld = new Set<number>();

  /** Whether a key is being held now, as an interactive sequence asks. */
  isKeyHeld(keyCode: number): boolean {
    return this.keysHeld.has(keyCode);
  }

  pressKey(keyCode: number): void {
    this.variables[this.vars.KEYPRESS] = keyCode;
    this.keysHeld.add(keyCode);

    if (keyCode === this.variables[this.vars.TALKSTOP_KEY] && this.messageTimer > 0) {
      this.stopTalk();
    }

    // Skipping a scene is the engine's job, not a script's: the game only says
    // where to resume, through `beginOverride`. The original acts on the key in
    // `processKeyboard` and does not pass it on.
    if (keyCode !== 0 && keyCode === this.variables[this.vars.CUTSCENEEXIT_KEY]) {
      this.abortCutscene();
      return;
    }

    // The game handles its own keys. A key that matches an enabled verb's
    // shortcut is reported as a click on that verb and anything else as a key,
    // which is the order `checkExecVerbs` tries them in.
    if (!this.userPut) return;
    const verbId = this.verbs.findByKey(keyCode);
    if (verbId !== 0) this.handleVerbClick(verbId);
    else if (this.scriptsOwnInput) this.runInputScript(ClickArea.Key, keyCode, MouseButton.Left);
  }

  /**
   * Releases a key, or every key when none is named.
   *
   * The no-argument form is what the existing callers use and keeps meaning
   * "nothing is pressed now". A sequence reading held state needs the specific
   * form, because releasing one direction while another is still down must not
   * clear both.
   */
  releaseKey(keyCode?: number): void {
    this.variables[this.vars.KEYPRESS] = 0;
    if (keyCode === undefined) this.keysHeld.clear();
    else this.keysHeld.delete(keyCode);
  }

  get frame(): number {
    return this.frameCounter;
  }

  get screenEffectId(): number {
    return this.screenEffect;
  }

  // ----------------------------------------------- the host-facing surface --
  //
  // `AdventureEngine` (ADR 0011) is what a shell needs from a game, whichever
  // Engine family runs it. Everything below either forwards to a method that
  // was already here or narrows one, so nothing about how SCUMM behaves changes
  // — the point of this seam is that a second family can sit under the same
  // shell, and the proof it is right is SCUMM continuing to work.

  /** SCUMM's input object, which owns the verb bar and the hot keys. */
  readonly input = new ScummInput(this);

  readonly saveFormat = SAVE_FORMAT;
  readonly saveNote = SAVE_LOCATION_NOTE;
  /**
   * 320x200, in both coordinate spaces (#213).
   *
   * The degenerate case ADR 0007 asks for: this family does not composite a
   * script space onto a different display space, so it says so once and the
   * shell never asks which family it is.
   */
  readonly resolution = {
    script: { width: SCREEN_WIDTH, height: SCREEN_HEIGHT },
    display: { width: SCREEN_WIDTH, height: SCREEN_HEIGHT },
  };

  get gameId(): string {
    return this.resources.game.id;
  }

  /** The Target this loaded game is, in `CONTEXT.md`'s terms. */
  get target(): Target {
    // `resources.game.version` is the detector's axis and can in principle name
    // a version with no assembler; the Target may only hold one that has one.
    // Clamped here rather than trusted, because detection already refuses an
    // unsupported version before the engine is built.
    const version = this.resources.game.version;
    // Each supported version named rather than clamped with a chain: a chain
    // is how a version with no assembler behind it acquires an earlier one's
    // tag, which is the mis-tag ADR 0012 exists to prevent and which has
    // happened here once already.
    const supported = SCUMM_VERSION_TARGETS.find((candidate) => candidate === version);
    return {
      engine: 'scumm',
      version: supported ?? 5,
      identification: this.resources.game.identification,
    };
  }

  get targetName(): string {
    return describeTarget(this.target);
  }

  /**
   * Blits the framebuffer to a canvas through the current palette.
   *
   * The shell used to reach through to `screen.present(context, palette)`,
   * which meant it knew both that there was a palette and that the screen took
   * one. AGI has sixteen colours where SCUMM has 256 and neither fact is the
   * shell's business.
   */
  present(context: CanvasRenderingContext2D): void {
    this.screen.present(context, this.palette);
  }

  roomName(room: number): string | undefined {
    return this.resources.roomNames.get(room);
  }

  describeStatus(): string | undefined {
    // A stopped script is the difference between "slow game" and "engine bug",
    // so it belongs in the status line rather than only in the log.
    const [opcode, script] = this.unknownOpcodes.entries().next().value ?? [];
    if (opcode !== undefined) {
      return `script ${script} stopped at opcode 0x${opcode.toString(16).padStart(2, '0')}`;
    }
    if (this.stuckScripts.size > 0) return `stuck script ${[...this.stuckScripts].join(', ')}`;
    return undefined;
  }

  describeStall(): string[] {
    return [
      `Scripts: ${this.describeScriptState()}`,
      // Separately, because a stalled game and an empty-looking room are
      // different complaints and a player reporting one usually cannot tell
      // which they have.
      `Actors: ${this.describeActorState()}`,
      // A room drawn with no objects in it looks identical to one whose objects
      // are merely hidden, and only this tells them apart.
      `Objects: ${this.describeObjectState()}`,
      // Whether the player can do anything, which decides whether "nothing
      // responds" is a bug at all.
      `Input: ${this.describeInputState()}`,
    ];
  }

  /**
   * Nothing refuses a SCUMM game for editing.
   *
   * ADR 0013's refusal is about AGI's arity table, which SCUMM does not have:
   * v6's stack discipline makes every instruction boundary measurable, so a
   * SCUMM game is decoded rather than decoded-on-a-guess. Answered here anyway
   * so the shell asks one question of whichever family it loaded.
   */
  describeEditRefusal(): string | null {
    return null;
  }

  /**
   * Decompiles this game into a project the editor can open.
   *
   * Runs here rather than in the editor because this is where the game data
   * already is: the editor would otherwise need its own loader, its own file
   * picker and its own copy of the resource layer. The *storing* of the result
   * stays in the shell, so `src/engine` does not import the editor's storage.
   *
   * The authoring modules are imported dynamically to keep the editor out of
   * the engine's static graph: a player who never clicks Edit should not have
   * downloaded a decompiler.
   */
  async toEditableGame(options: EditableGameOptions): Promise<EditableGame> {
    const [{ importGame }, { importStrings }] = await Promise.all([
      import('../authoring/importGame.js'),
      import('../authoring/languageStrings.js'),
    ]);

    const rooms = this.resources.listRooms();
    const result = importGame(this.resources, { rooms, onProgress: options.onProgress });
    const notes = [...result.notes];

    // A v7 game's words live outside its scripts, so they come into the
    // project as content of their own rather than as instructions (ADR 0009).
    // The Dig only — Full Throttle ships no bundle, and its lines are the
    // fallbacks carried beside each tag, which are edited as instructions.
    if (this.languageBundle) {
      result.project.strings = importStrings(this.languageBundle);
      notes.push(
        `Imported ${result.project.strings.entries.length} lines of text from ` +
          `${this.languageBundle.source}. Editing one changes every script that ` +
          `references it.`,
      );
    }

    // Where the game came from, so an export can refuse the wrong folder by
    // name. Recorded for every import, not only the large ones: it costs a few
    // dozen bytes and it is the only thing that can tell one release of a title
    // from another later (ADR 0010).
    result.project.origin = {
      indexFile: this.resources.game.indexFile,
      dataFile: this.resources.game.dataFiles[0],
      indexBytes: this.resources.index.length,
      dataBytes: this.resources.data.length,
      engineVersion: this.resources.engineVersionString || undefined,
      dataVersion: this.resources.dataVersionString || undefined,
    };

    return {
      project: result.project,
      notes,
      originals: {
        layout: this.resources.game.layout,
        version: this.resources.game.version,
        indexFile: this.resources.game.indexFile,
        index: this.resources.index,
        // Cut back into the files they were read as. The reader concatenates
        // every layout into one buffer because everything above it addresses a
        // resource as a room and an offset; an export is the one caller that
        // needs the seams, because a v4 install is written as an index and its
        // disks and a v3 one as an index and fifty-odd room files.
        dataFiles: this.resources.dataFileRanges.map((range) => ({
          name: range.name,
          data: this.resources.data.subarray(range.start, range.start + range.length),
        })),
        charsetFiles: this.resources.charsetFileData.map((file) => ({
          name: file.name,
          data: file.data,
        })),
        xorKey: this.resources.game.xorKey,
        dataXorKey: this.resources.game.dataXorKey,
      },
    };
  }
}

export { SCREEN_HEIGHT, SCREEN_WIDTH };
