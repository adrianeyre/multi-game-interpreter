/**
 * The AGI Engine: the cycle, the world, and everything a Logic can ask for.
 *
 * The counterpart to `ScummEngine`, and a sibling of it rather than a
 * generalisation: the two share the shell above them (ADR 0011), `Screen`,
 * `Palette`, `DataSource` and `ByteStream`, and nothing else. There is no
 * bytecode in common, no resource layout in common and no renderer in common.
 */

import type {
  AdventureEngine,
  EditableGame,
  EditableGameOptions,
  EngineSound,
  SavedGameEnvelope,
} from '../AdventureEngine.js';
import type { DataSource } from '../resource/DataSource.js';
import { LoadProgressTracker } from '../resource/progress.js';
import { Palette } from '../gfx/Palette.js';
import { SCREEN_HEIGHT, SCREEN_WIDTH, Screen } from '../gfx/Screen.js';
import {
  describeTarget,
  describeUneditableTarget,
  formatInterpreterVersion,
  type Target,
} from '../../authoring/target.js';

import {
  detectAgiGame,
  type DeclaredInterpreter,
  type DetectedAgiGame,
} from './resource/agiDetect.js';
import { AgiResources } from './resource/AgiResources.js';
import { CARRIED_ROOM, readObjectFile, type AgiObjectFile } from './resource/objects.js';
import {
  parseInput,
  readVocabulary,
  unknownWordMessage,
  type AgiVocabulary,
} from './resource/words.js';
import { AgiPicture, type PictureCommand } from './gfx/AgiPicture.js';
import {
  PICTURE_HEIGHT,
  PICTURE_TOP,
  PICTURE_WIDTH,
  applyAgiPalette,
  priorityTable,
} from './gfx/agiPalette.js';
import { drawCel, loopIsMirrored, readView, type AgiViewResource } from './gfx/AgiView.js';
import { GLYPH_HEIGHT, TEXT_COLUMNS, drawText, wrapMessage } from './gfx/AgiFont.js';
import { AgiMenu } from './AgiMenu.js';
import { probeArityTable, type AgiArityProbe } from './resource/arityProbe.js';
import { AgiState, F, V } from './script/AgiState.js';
import { LogicEngine, type LogicHost, type TraceEntry } from './script/LogicEngine.js';
import { opcodeSetFor, type AgiOpcodeSet } from './script/opcodes.js';
import {
  DIRECTION_STEPS,
  EGO,
  drawOrder,
  effectivePriority,
  type ScreenObject,
} from './ScreenObject.js';
import { AgiInput } from './AgiInput.js';
import { AgiSoundPlayer, readSound } from './sound/AgiSound.js';
import {
  AGI_SAVE_FORMAT,
  AGI_SAVE_NOTE,
  captureAgiState,
  restoreAgiState,
  type AgiSavedGame,
} from './save/AgiSaveState.js';

export interface AgiEngineOptions {
  onLog?: (message: string) => void;
  progress?: LoadProgressTracker;
  onActivity?: (activity: string) => void;
  /** Injectable so a test's randomness is not the runner's. */
  random?: () => number;
  /**
   * An interpreter version stated by the person editing, for a dump that ships
   * no interpreter to read one from (ADR 0013).
   */
  declaredInterpreter?: DeclaredInterpreter;
}

/** A text window a `print` put up, which holds the game until dismissed. */
interface TextWindow {
  lines: string[];
  /** Cycles left before it closes itself, or -1 to wait for a keypress. */
  remaining: number;
}

export class AgiEngine implements AdventureEngine, LogicHost {
  readonly screen = new Screen();
  readonly palette = new Palette();
  readonly state = new AgiState();
  readonly opcodes: AgiOpcodeSet;
  readonly input: AgiInput;
  readonly saveFormat = AGI_SAVE_FORMAT;
  readonly saveNote = AGI_SAVE_NOTE;
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

  private readonly resources: AgiResources;
  private readonly game: DetectedAgiGame;
  private readonly logic: LogicEngine;
  private readonly soundPlayer = new AgiSoundPlayer();
  private readonly rng: () => number;
  /** Public because `LogicHost` needs it: an opcode reports through it. */
  readonly log: (message: string) => void;
  private readonly onActivity: (activity: string) => void;

  /** The room picture, and the priority buffer that comes with it. */
  private picture = new AgiPicture();
  private pictureCommands: PictureCommand[] = [];
  private bands = priorityTable();
  private priorityBase = 0;

  /** Views decoded once and kept, keyed by resource number. */
  private readonly views = new Map<number, AgiViewResource>();

  private vocabulary: AgiVocabulary = { words: new Map(), groups: new Map() };
  private objectFile: AgiObjectFile = { items: [], maxAnimatedObjects: 0, encrypted: false };
  /** Where each inventory item is now, which is all of AGI's inventory model. */
  private itemRooms: number[] = [];

  private frameCounter = 0;
  /** Words the player's last line resolved to, until a `said` consumes them. */
  private spokenGroups: number[] = [];
  private textWindow: TextWindow | null = null;
  /** Text `display` put straight on the screen, which survives until cleared. */
  private readonly displayed: Array<{ row: number; column: number; text: string }> = [];
  private textForeground = 15;
  private textBackground = 0;

  /**
   * The menu bar the game builds, and the interpreter draws.
   *
   * Always present rather than created on `submit.menu`, because `set.menu`
   * arrives first and has to have somewhere to go.
   */
  private readonly menu = new AgiMenu();

  /**
   * What the game's own bytecode said about its arity table.
   *
   * Kept because the *narrowing* is useful even when the probe cannot decide:
   * a refusal that names the two possible builds and what they disagree about
   * is one a person can act on, and "could not be identified" is not.
   */
  arityProbe: AgiArityProbe | null = null;

  /** Opcodes reported missing, so each is said once rather than every cycle. */
  private readonly unimplemented = new Map<string, number>();
  /** Ticks left of the delay `V.TIME_DELAY` asks for. */
  private delayCounter = 0;

  private constructor(resources: AgiResources, game: DetectedAgiGame, options: AgiEngineOptions) {
    this.resources = resources;
    this.game = game;
    this.log = options.onLog ?? (() => undefined);
    this.onActivity = options.onActivity ?? (() => undefined);
    this.rng = options.random ?? Math.random;

    if (game.target.engine !== 'agi') {
      throw new Error('An AGI engine was built for a Target that is not AGI.');
    }
    this.opcodes = opcodeSetFor(game.target);
    this.logic = new LogicEngine(this);

    this.input = new AgiInput({
      submitLine: (text) => this.submitLine(text),
      pressKey: (code) => this.pressKey(code),
      setDirection: (direction) => this.setEgoDirection(direction),
      acceptsInput: () => this.state.inputEnabled && this.textWindow === null && !this.menu.open,
    });

    applyAgiPalette(this.palette);
    // AGI's three bands: a status line of one text row, the picture, and up to
    // three text rows at the bottom for the Parser input line and its replies.
    // Expressible through `setLayout` with no family branch, which is what
    // ADR 0007 left behind and ADR 0011 predicted would be enough.
    this.screen.setLayout(PICTURE_TOP, PICTURE_TOP + PICTURE_HEIGHT);
    this.soundPlayer.onLog = this.log;
    this.soundPlayer.setFinishedHandler((flag) => this.state.setFlag(flag, true));
  }

  static async create(source: DataSource, options: AgiEngineOptions = {}): Promise<AgiEngine> {
    const progress = options.progress ?? new LoadProgressTracker();
    const detected = await detectAgiGame(source, options.declaredInterpreter);
    const resources = await AgiResources.load(source, detected, {
      onLog: options.onLog,
      progress,
    });

    // **The probe runs here and not in detection, because it needs the
    // volumes.** The arity table decides how a Logic decodes and nothing
    // else — not how a resource is found, decompressed or indexed — so
    // refining it after the resources are read costs nothing and re-reads
    // nothing. Detection cannot do it: it has file names and no bytes.
    const { game, probe } = refineWithArityProbe(detected, resources, options);

    const engine = new AgiEngine(resources, game, options);
    engine.arityProbe = probe;
    await engine.loadPlainFiles(source);
    return engine;
  }

  /**
   * Reads the two files that are not indexed resources.
   *
   * `WORDS.TOK` and `OBJECT` sit beside the volumes rather than inside them, so
   * they are read by name. A game missing either is playable but crippled — no
   * vocabulary means nothing the player types is understood — so both are
   * reported rather than quietly absent.
   */
  private async loadPlainFiles(source: DataSource): Promise<void> {
    const find = (wanted: string): string | undefined =>
      source.list().find((name) => (name.split(/[\\/]/).pop() ?? name).toLowerCase() === wanted);

    const wordsName = find('words.tok');
    if (wordsName) {
      const bytes = await source.read(wordsName);
      if (bytes) {
        this.vocabulary = readVocabulary(bytes);
        this.log(
          `Read ${this.vocabulary.words.size} words in ${this.vocabulary.groups.size} ` +
            `synonym groups from ${wordsName}`,
        );
      }
    } else {
      this.log('No WORDS.TOK was found, so nothing the player types will be understood.');
    }

    const objectName = find('object');
    if (objectName) {
      const bytes = await source.read(objectName);
      if (bytes) {
        this.objectFile = readObjectFile(bytes);
        this.itemRooms = this.objectFile.items.map((item) => item.startRoom);
        this.log(
          `Read ${this.objectFile.items.length} inventory items from ${objectName}` +
            `${this.objectFile.encrypted ? ' (obfuscated)' : ''}`,
        );
      }
    } else {
      this.log('No OBJECT file was found, so this game has no inventory items.');
    }
  }

  // ------------------------------------------------- the AdventureEngine face

  get gameId(): string {
    return this.state.gameId || this.game.id;
  }

  get target(): Target {
    return this.game.target;
  }

  get targetName(): string {
    return describeTarget(this.game.target);
  }

  get frame(): number {
    return this.frameCounter;
  }

  get currentRoom(): number {
    return this.state.var(V.CURRENT_ROOM);
  }

  get hasQuit(): boolean {
    return this.state.quitRequested;
  }

  get sound(): EngineSound {
    return this.soundPlayer;
  }

  roomName(_room: number): string | undefined {
    // AGI carries no room names anywhere: a room is a Logic number and nothing
    // more. Answering undefined is the truth, and the shell already prints the
    // number beside it.
    return undefined;
  }

  describeStatus(): string | undefined {
    if (this.unimplemented.size > 0) {
      const [name] = this.unimplemented.keys();
      return `${this.unimplemented.size} unimplemented opcode(s), first ${name}`;
    }
    return undefined;
  }

  describeStall(): string[] {
    const objects = this.state.objects
      .filter((object) => object.animated)
      .map(
        (object) =>
          `o${object.number} view ${object.view} at (${object.x},${object.y})` +
          `${object.drawn ? '' : ' hidden'}${object.cycling ? ' cycling' : ''}` +
          `${object.motion === 'none' ? '' : ` ${object.motion}`}`,
      );

    const setFlags = [...this.state.flags.entries()]
      .filter(([, value]) => value !== 0)
      .map(([number]) => number)
      .slice(0, 24);

    return [
      `Room: ${this.currentRoom} (picture ${this.state.currentPicture}), ` +
        `${this.state.playerControl ? 'player' : 'program'} control, ` +
        `input ${this.state.inputEnabled ? 'on' : 'off'}` +
        `${this.textWindow ? ', a text window is open' : ''}` +
        `${this.menu.open ? ', the menu is open' : ''}`,
      `Menu: ${
        this.menu.available
          ? this.menu
              .describe()
              .map((column) => `${column.text.trim()} (${column.items.length})`)
              .join(', ')
          : 'not submitted'
      }`,
      `Objects: ${objects.length > 0 ? objects.join('; ') : 'none animated'}`,
      `Flags set: ${setFlags.length > 0 ? setFlags.join(', ') : 'none'}`,
      // Which Logics are running, which the twelve-instruction tail cannot say.
      // A game stopped at its first screen has two quite different shapes — the
      // room's own Logic running every cycle and getting nowhere, or logic 0
      // never calling it at all — and they need opposite fixes. Twelve
      // instructions of logic 0 look identical either way.
      `Logics run: ${this.describeLogicsRun()}`,
      `Last instructions: ${this.describeTrace()}`,
      this.unimplemented.size > 0
        ? `Unimplemented: ${[...this.unimplemented.keys()].join(', ')}`
        : 'Unimplemented: none',
    ];
  }

  /**
   * Which Logics the trace buffer saw, most-run first.
   *
   * Read from the same ring the instruction trace comes from rather than
   * counted separately, so it cannot disagree with it. The whole ring is
   * summarised where the trace prints a tail: 256 instructions is several
   * cycles of a stalled game, which is the window that shows a room Logic
   * missing from it.
   */
  describeLogicsRun(): string {
    const counts = new Map<number, number>();
    for (const entry of this.logic.recentInstructions()) {
      counts.set(entry.logic, (counts.get(entry.logic) ?? 0) + 1);
    }
    if (counts.size === 0) return 'none yet';

    const room = this.currentRoom;
    const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const summary = ordered
      .map(([number, count]) => `${number}${number === room ? ' (this room)' : ''} x${count}`)
      .join(', ');

    // Said outright rather than left to be inferred from a list of numbers.
    // "logic 45 never ran" is the finding; a reader should not have to notice
    // an absence to reach it.
    return counts.has(room)
      ? summary
      : `${summary} — room ${room}'s own Logic has not run in the last ` +
          `${this.logic.recentInstructions().length} instructions`;
  }

  /** The opcode ring buffer, newest last — Tier 3's "what should it have done". */
  describeTrace(count = 12): string {
    const recent = this.logic.recentInstructions().slice(-count);
    if (recent.length === 0) return 'none yet';
    return recent
      .map((entry) => `${entry.logic}:${entry.offset} ${entry.name}(${entry.operands.join(',')})`)
      .join(' → ');
  }

  /** The whole ring buffer, for a diagnostic dump. */
  recentInstructions(): TraceEntry[] {
    return this.logic.recentInstructions();
  }

  set onInstruction(handler: ((entry: TraceEntry) => void) | null) {
    this.logic.onInstruction = handler;
  }

  present(context: CanvasRenderingContext2D): void {
    this.screen.present(context, this.palette);
  }

  saveState(name: string): AgiSavedGame {
    return captureAgiState(
      {
        state: this.state,
        target: this.game.target,
        gameId: this.gameId,
        itemRooms: this.itemRooms,
        priorityBase: this.priorityBase,
      },
      name,
    );
  }

  loadState(saved: SavedGameEnvelope): void {
    restoreAgiState(
      {
        state: this.state,
        target: this.game.target,
        gameId: this.gameId,
        itemRooms: this.itemRooms,
        setPriorityBase: (base) => this.setPriorityBase(base),
      },
      saved as AgiSavedGame,
    );

    // The picture and the Views are rebuilt from the resources rather than
    // stored, the same rule the SCUMM save follows: storing them would make a
    // save both huge and wrong the moment the game files changed.
    if (this.state.currentPicture >= 0) this.drawPicture(this.state.currentPicture);
    for (const object of this.state.objects) {
      if (object.view > 0) {
        object.loopCount = this.viewLoopCount(object.view);
        object.celCount = this.viewCelCount(object.view, object.loop);
        this.applyCelSize(object);
      }
    }
    this.textWindow = null;
    this.log(`Resumed in room ${this.currentRoom}.`);
  }

  /**
   * Decompiles into an editable project, or refuses and says why.
   *
   * ADR 0013's refusal lives here: a game whose interpreter version fell back
   * to a guess **plays** on that guess and is **refused for editing**, because
   * decoding with the wrong arity table misreads every boundary after the first
   * mismatch and re-emitting with the same wrong table writes that misreading
   * back byte for byte.
   */
  /**
   * ADR 0013's declared-interpreter route, which is AGI's alone.
   *
   * True unconditionally rather than only when a refusal is outstanding: the
   * question is whether the family *has* the route, and the shell only asks it
   * when there is a refusal to lift.
   */
  readonly editRefusalIsDeclarable = true;

  describeEditRefusal(): string | null {
    const refusal = describeUneditableTarget(this.game.target);
    if (!refusal) return null;

    // **The narrowing, appended.** ADR 0013's refusal stands, but a reader
    // being told "could not be identified" and offered six versions has
    // nothing to choose with. The game's own bytecode rules some of them out,
    // and saying which turns the declaration from a guess into a choice
    // between named alternatives.
    const survivors = this.arityProbe?.survivors ?? [];
    if (survivors.length < 2) return refusal;

    const named = survivors
      .map((candidate) => formatInterpreterVersion(candidate.interpreter))
      .join(' and ');
    const differences = this.arityProbe?.notes.filter((note) =>
      note.startsWith('  they differ only here:'),
    );
    return (
      `${refusal}\n\n` +
      `This copy's own bytecode narrows it, though. Decoded under each table AGI could ` +
      `be using, only ${named} read every Logic to the end with no unknown opcode and ` +
      `every jump landing on an instruction — so it is one of those two, and declaring ` +
      `either is a choice between named alternatives rather than a guess at six.` +
      (differences && differences.length > 0
        ? `\n\n${differences.map((note) => note.replace('  they differ only here: ', '')).join('\n')}`
        : '')
    );
  }

  async toEditableGame(options: EditableGameOptions): Promise<EditableGame> {
    const refusal = this.describeEditRefusal();
    if (refusal) throw new Error(refusal);

    const { importAgiGame } = await import('../../authoring/agi/importAgiGame.js');
    return importAgiGame(this.resources, this.game, {
      objectFile: this.objectFile,
      vocabulary: this.vocabulary,
      onProgress: options.onProgress,
      onLog: this.log,
    });
  }

  // ----------------------------------------------------------------- the cycle

  boot(): void {
    this.state.reset();
    this.state.gameId = this.game.id;
    for (const [index, item] of this.objectFile.items.entries()) {
      this.itemRooms[index] = item.startRoom;
    }
    this.setPriorityBase(0);
    this.frameCounter = 0;
    this.onActivity('booting');

    // AGI has no boot script separate from the cycle: logic 0 runs every cycle
    // and is responsible for setting the game up on its first one, which is
    // what `LOGIC_ZERO_FIRST_TIME` tells it. So booting is running one cycle.
    this.step();
    this.log(`Booted into room ${this.currentRoom}.`);
  }

  /**
   * One cycle.
   *
   * **The order is the part that matters most** (#129): a game that renders
   * before it moves looks fine and desynchronises, because a script that reads
   * an object's position after telling it to move gets last cycle's answer.
   *
   * 1. Clear the per-cycle flags and vars, so a `said` from last cycle does not
   *    fire again this one.
   * 2. Take the player's input, and reconcile ego's direction with `V.EGO_DIRECTION`
   *    in whichever direction `player.control` says.
   * 3. **Move** every object, so the world is where it will be drawn before any
   *    script looks at it.
   * 4. Run logic 0, repeatedly while it asks for a new room — a room change
   *    unloads the resource the logic is running out of, so it happens between
   *    logics rather than inside one.
   * 5. **Then** advance animation, because a cel change is a consequence of the
   *    move rather than a cause of it.
   * 6. Render.
   *
   * Steps 3 and 5 are the pair that is easy to collapse into one, and doing so
   * is exactly the desynchronisation #129 warns about: cycling before the logic
   * runs shows the frame the script is about to change.
   */
  /**
   * One tick per sixtieth, which is how AGI's cycle is already paced here.
   *
   * AGI has no equivalent of SCUMM's `VAR_TIMER_NEXT`: its own clock counts
   * this engine's cycles — `V.SECONDS` advances every sixtieth of them — so the
   * rate is fixed and the shell's default is it.
   */
  readonly ticksPerStep = 1;

  step(): void {
    const { state } = this;
    this.frameCounter++;

    // AGI's own pacing: `V.TIME_DELAY` is in twentieths of a second and the
    // shell steps at sixty hertz, so a delay of 2 is a cycle every 6 frames.
    // Without it every game runs three times too fast.
    const delay = state.var(V.TIME_DELAY);
    if (delay > 0) {
      if (this.delayCounter > 0) {
        this.delayCounter--;
        this.soundPlayer.step();
        return;
      }
      this.delayCounter = Math.max(0, delay * 3 - 1);
    }

    this.soundPlayer.step();

    if (state.restartRequested) {
      state.restartRequested = false;
      this.boot();
      return;
    }

    // 1. Per-cycle state.
    state.setVar(V.WORD_NOT_FOUND, 0);
    state.setVar(V.BORDER_OBJECT, 0);
    state.setVar(V.BORDER_CODE, 0);
    state.setVar(V.EGO_BORDER, 0);
    state.setFlag(F.SAID_ACCEPTED, false);
    this.advanceClock();

    // 2. Input. A text window swallows it: the game is waiting to be dismissed.
    if (this.textWindow) {
      if (this.textWindow.remaining > 0) this.textWindow.remaining--;
      if (this.textWindow.remaining === 0) this.textWindow = null;
      this.render();
      return;
    }

    const ego = state.object(EGO);
    if (state.playerControl) ego.direction = state.var(V.EGO_DIRECTION);
    else state.setVar(V.EGO_DIRECTION, ego.direction);

    // 3. Move, before anything reads a position.
    this.moveObjects();

    // 4. The logics.
    this.onActivity(`running logic 0 in room ${this.currentRoom}`);
    state.exitAllLogics = false;
    this.logic.run(0);

    // Cleared here rather than after the room loop below, and the difference is
    // not cosmetic: logic 0's first-time branch is where a game calls
    // `new.room`, so a flag still set on the *next* pass would call it again
    // and the game would bounce between rooms until the guard stopped it.
    state.setFlag(F.LOGIC_ZERO_FIRST_TIME, false);
    // The new-room flag is true for exactly the pass that saw it, which is how
    // every room's Logic knows to draw its picture once rather than every cycle.
    state.setFlag(F.NEW_ROOM, false);
    state.setFlag(F.ENTERED_COMMAND, false);

    let roomChanges = 0;
    while (state.pendingRoom !== null && roomChanges++ < 16) {
      const room = state.pendingRoom;
      state.pendingRoom = null;
      this.enterRoom(room);
      state.exitAllLogics = false;
      // The room's own Logic runs on this pass, through logic 0's `call.v(v0)`,
      // with the new-room flag set — which is the whole of AGI's room entry.
      this.logic.run(0);
      state.setFlag(F.NEW_ROOM, false);
    }
    state.exitAllLogics = false;

    // 5. Animation, after the logics have had their say about it.
    this.cycleObjects();

    // 6. Render.
    this.render();

    // Input is consumed at the *end* of the cycle, not the start.
    //
    // A key arrives between cycles — from a DOM event, or from a host driving
    // the engine — and the logics that test it run in the middle of one.
    // Clearing at the top of `step` therefore throws the keypress away before
    // anything can see it, which reads as a game ignoring its own controls.
    //
    // Enclosure binds F10 to the controller that skips its opening cutscene;
    // with the clear at the top, pressing it did nothing at all.
    state.firedControllers.clear();
    state.setVar(V.KEY, 0);
  }

  /** The clock `V.SECONDS` and friends count, at one second per sixty cycles. */
  private advanceClock(): void {
    const { state } = this;
    if (this.frameCounter % 60 !== 0) return;

    state.setVar(V.SECONDS, state.var(V.SECONDS) + 1);
    if (state.var(V.SECONDS) < 60) return;
    state.setVar(V.SECONDS, 0);
    state.setVar(V.MINUTES, state.var(V.MINUTES) + 1);
    if (state.var(V.MINUTES) < 60) return;
    state.setVar(V.MINUTES, 0);
    state.setVar(V.HOURS, state.var(V.HOURS) + 1);
    if (state.var(V.HOURS) < 24) return;
    state.setVar(V.HOURS, 0);
    state.setVar(V.DAYS, state.var(V.DAYS) + 1);
  }

  /**
   * Enters a room.
   *
   * What AGI resets and what it preserves, and the split is not obvious:
   *
   * **Reset** — every screen object's animation and motion state, the horizon,
   * the block region, the border variables, and player control (back on). A
   * room's own Logic is expected to re-animate and re-place everything it wants,
   * which is why every AGI room script opens the same way.
   *
   * **Preserved** — all 256 variables and flags except the ones named below, the
   * inventory, the score, and ego's View. Ego keeps its View across a room
   * change because the player is still wearing the same clothes, and
   * `V.EGO_VIEW` is where a room's Logic reads it back from.
   */
  private enterRoom(room: number): void {
    const { state } = this;
    this.onActivity(`entering room ${room}`);

    this.soundPlayer.stop();
    this.textWindow = null;
    this.displayed.length = 0;

    const egoView = state.object(EGO).view;

    for (const object of state.objects) {
      object.animated = false;
      object.drawn = false;
      object.updating = true;
      object.cycling = false;
      object.cycleUntilEnd = 'none';
      object.motion = 'none';
      object.moveTo = null;
      object.fixedPriority = false;
      object.fixedLoop = false;
      object.ignoreBlocks = false;
      object.ignoreHorizon = false;
      object.ignoreObjects = false;
      object.restriction = 'none';
      object.stopped = false;
      if (object.number !== EGO) object.view = 0;
    }

    state.setVar(V.PREVIOUS_ROOM, state.var(V.CURRENT_ROOM));
    state.setVar(V.CURRENT_ROOM, room);
    state.setVar(V.EGO_BORDER, 0);
    state.setVar(V.BORDER_OBJECT, 0);
    state.setVar(V.BORDER_CODE, 0);
    state.setVar(V.EGO_VIEW, egoView);

    state.horizon = 36;
    state.playerControl = true;
    state.block = { active: false, x1: 0, y1: 0, x2: 0, y2: 0 };
    state.setFlag(F.NEW_ROOM, true);
  }

  // ----------------------------------------------------------------- movement

  private moveObjects(): void {
    for (const object of this.state.objects) {
      if (!object.animated || !object.updating) continue;
      this.decideDirection(object);
      this.stepObject(object);
    }
  }

  /** Turns a motion mode into a direction for this cycle. */
  private decideDirection(object: ScreenObject): void {
    switch (object.motion) {
      case 'move.obj': {
        const target = object.moveTo;
        if (!target) {
          object.motion = 'none';
          return;
        }

        // Arrival is "within one step", not "exactly there". AGI works out the
        // direction by comparing each axis's remaining distance against the
        // step size, and a direction of zero *is* the arrival test — so an
        // object four pixels from its target with a step of six has arrived.
        //
        // Testing for exact equality instead is a real game hanging on its own
        // title screen: Enclosure's intro does `move.obj(o4, 104, 20, 6, f223)`
        // from x=100, which overshoots to 106, turns round, overshoots back to
        // 100, and never sets the flag its script is polling.
        object.direction = directionTowards(
          object.x,
          object.y,
          target.x,
          target.y,
          object.stepSize,
        );

        if (object.direction === 0) {
          object.motion = 'none';
          object.moveTo = null;
          // The flag is how the script knows it arrived: it polls rather than
          // blocking, which is what makes an AGI "wait" a return.
          this.state.setFlag(target.endFlag, true);
          if (object.number === EGO) this.state.playerControl = true;
        }
        return;
      }
      case 'follow.ego': {
        const ego = this.state.object(EGO);
        object.direction = directionTowards(object.x, object.y, ego.x, ego.y, object.stepSize);
        if (object.direction === 0) {
          object.motion = 'none';
          this.state.setFlag(object.followFlag, true);
        }
        return;
      }
      case 'wander': {
        // A new direction only sometimes, or the object jitters on the spot
        // rather than wandering.
        if (object.direction === 0 || object.stopped || this.rng() < 0.1) {
          object.direction = 1 + Math.floor(this.rng() * 8);
        }
        return;
      }
      default:
        return;
    }
  }

  /**
   * Moves an object one step, if the world lets it.
   *
   * The blocking rules are all AGI has in place of walk boxes, and they come
   * from the Picture rather than from the room's geometry (`CONTEXT.md`):
   *
   * - **priority 0** is a control line that blocks everything not ignoring
   *   blocks — the "wall" a room draws to keep the player out of the scenery
   * - **priority 1** is water, which only an object told `object.on.water` may
   *   enter and which an `object.on.land` object may not
   * - **priority 2** is a signal line, which does not block but sets a flag —
   *   how a room detects the player reaching a doorway
   * - **priority 3** is the "unconditionally passable" line, drawn where
   *   scenery would otherwise block
   */
  private stepObject(object: ScreenObject): void {
    if (object.direction === 0) {
      object.stopped = false;
      return;
    }

    if (++object.stepCounter < object.stepTime) return;
    object.stepCounter = 0;

    const [dx, dy] = DIRECTION_STEPS[object.direction] ?? [0, 0];
    const nextX = object.x + dx * object.stepSize;
    const nextY = object.y + dy * object.stepSize;

    const border = this.borderTouched(object, nextX, nextY);
    if (border !== 0) {
      object.stopped = true;
      if (object.number === EGO) {
        this.state.setVar(V.EGO_BORDER, border);
      } else {
        this.state.setVar(V.BORDER_OBJECT, object.number);
        this.state.setVar(V.BORDER_CODE, border);
      }
      // Stopped at the edge rather than moved out of the room: the room's own
      // Logic reads the border variable and decides where the player goes.
      return;
    }

    if (!this.canStandAt(object, nextX, nextY)) {
      object.stopped = true;
      return;
    }

    object.stopped = false;
    object.x = nextX;
    object.y = nextY;

    if (!object.fixedLoop) this.faceDirection(object);
    if (object.number === EGO) this.updateEgoFlags();
  }

  /** 1 top, 2 right, 3 bottom, 4 left, or 0 for inside the room. */
  private borderTouched(object: ScreenObject, x: number, y: number): number {
    if (y <= (object.ignoreHorizon ? 0 : this.state.horizon)) return 1;
    if (x + object.width > PICTURE_WIDTH) return 2;
    if (y >= PICTURE_HEIGHT) return 3;
    if (x < 0) return 4;
    return 0;
  }

  private canStandAt(object: ScreenObject, x: number, y: number): boolean {
    const { block } = this.state;
    if (block.active && !object.ignoreBlocks) {
      if (x >= block.x1 && x <= block.x2 && y >= block.y1 && y <= block.y2) return false;
    }

    // Every column the object's base covers has to be standable, not just its
    // origin — an object standing half on a wall would otherwise walk into it.
    let onWater = true;
    let onLand = true;
    for (let column = 0; column < Math.max(1, object.width); column++) {
      const control = this.picture.priorityAt(x + column, y);
      if (control === 0 && !object.ignoreBlocks) return false;
      if (control === 1) onLand = false;
      else onWater = false;
      if (control === 2 && object.number === EGO) {
        this.state.setFlag(F.EGO_TOUCHED_SIGNAL, true);
      }
    }

    if (object.restriction === 'water' && !onWater) return false;
    if (object.restriction === 'land' && !onLand) return false;
    return true;
  }

  /**
   * Points the object's loop at the way it is walking.
   *
   * AGI's convention, and it is not the obvious one: **loop 0 is right, loop 1
   * is left, loop 2 is down and loop 3 is up.** A View with fewer than four
   * loops uses what it has, and a two-loop View is left and right only — which
   * is why a character with two loops keeps facing sideways while walking up.
   */
  private faceDirection(object: ScreenObject): void {
    if (object.loopCount < 2) return;

    let loop = object.loop;
    switch (object.direction) {
      case 1: // north
        loop = object.loopCount >= 4 ? 3 : loop;
        break;
      case 2:
      case 3:
      case 4: // north-east, east, south-east
        loop = 0;
        break;
      case 5: // south
        loop = object.loopCount >= 3 ? 2 : loop;
        break;
      case 6:
      case 7:
      case 8: // south-west, west, north-west
        loop = 1;
        break;
      default:
        return;
    }

    if (loop !== object.loop && loop < object.loopCount) {
      object.loop = loop;
      object.celCount = this.viewCelCount(object.view, loop);
      object.cel = Math.min(object.cel, Math.max(0, object.celCount - 1));
      this.applyCelSize(object);
    }
  }

  /** The flags a room's Logic reads about where ego is standing. */
  private updateEgoFlags(): void {
    const ego = this.state.object(EGO);
    const control = this.picture.priorityAt(ego.x, ego.y);
    this.state.setFlag(F.EGO_ON_WATER, control === 1);
    // Hidden when the scenery in front of ego has a higher band than ego does.
    this.state.setFlag(
      F.EGO_HIDDEN,
      effectivePriority(ego, this.bands) < this.picture.priorityAt(ego.x, ego.y - 1),
    );
  }

  // ---------------------------------------------------------------- animation

  private cycleObjects(): void {
    for (const object of this.state.objects) {
      if (!object.animated || !object.updating || !object.cycling) continue;
      if (object.celCount <= 1) continue;

      if (++object.cycleCounter < object.cycleTime) continue;
      object.cycleCounter = 0;

      const next = object.cel + object.cycleDirection;

      if (object.cycleUntilEnd !== 'none') {
        const done = object.cycleUntilEnd === 'forward' ? next >= object.celCount : next < 0;
        if (done) {
          object.cycling = false;
          object.cycleUntilEnd = 'none';
          // The flag the script is waiting on. Set when the animation has
          // actually finished, because a script polls it every cycle and an
          // early set cuts the animation short on screen.
          this.state.setFlag(object.cycleEndFlag, true);
          continue;
        }
        object.cel = next;
        continue;
      }

      // A plain cycle wraps rather than stopping.
      object.cel = ((next % object.celCount) + object.celCount) % object.celCount;
    }
  }

  // ---------------------------------------------------------------- rendering

  render(): void {
    const { pixels } = this.screen;
    pixels.fill(0);

    // The picture, doubled from 160 to 320 as it was always meant to be.
    const frame = new Uint8Array(PICTURE_WIDTH * PICTURE_HEIGHT);
    frame.set(this.picture.visual);

    if (this.state.pictureShown && !this.state.textMode) {
      for (const object of drawOrderFor(this.state.objects, this.bands)) {
        this.drawObject(object, frame);
      }

      for (let y = 0; y < PICTURE_HEIGHT; y++) {
        const rowAt = (PICTURE_TOP + y) * SCREEN_WIDTH;
        for (let x = 0; x < PICTURE_WIDTH; x++) {
          const colour = frame[y * PICTURE_WIDTH + x];
          pixels[rowAt + x * 2] = colour;
          pixels[rowAt + x * 2 + 1] = colour;
        }
      }
    }

    this.drawStatusLine();
    this.drawTextOverlays();
    this.drawInputLine();
    this.drawTextWindow();
    // Last, and over the status line: while the menu is up it *is* the status
    // line, which is where AGI puts it.
    this.menu.draw(this.screen.pixels, SCREEN_WIDTH, SCREEN_HEIGHT, (controller) =>
      this.state.disabledControllers.has(controller),
    );
  }

  private drawObject(object: ScreenObject, frame: Uint8Array): void {
    const view = this.views.get(object.view);
    const loop = view?.loops[object.loop];
    const cel = loop?.cels[object.cel];
    if (!cel) return;

    drawCel(cel, object.x, object.y, {
      target: frame,
      width: PICTURE_WIDTH,
      height: PICTURE_HEIGHT,
      priority: this.picture.priority,
      objectPriority: effectivePriority(object, this.bands),
      mirrored: loopIsMirrored(cel, object.loop),
    });
  }

  private drawStatusLine(): void {
    if (!this.state.statusLineVisible) return;
    const score = this.state.var(V.SCORE);
    const max = this.state.var(V.MAX_SCORE);
    const sound = this.state.flag(F.SOUND_ON) ? 'on' : 'off';
    const text = ` Score:${score} of ${max}`.padEnd(TEXT_COLUMNS - 12) + `Sound:${sound} `;
    drawText(
      this.screen.pixels,
      SCREEN_WIDTH,
      SCREEN_HEIGHT,
      0,
      0,
      text.slice(0, TEXT_COLUMNS),
      0,
      15,
    );
  }

  private drawTextOverlays(): void {
    for (const entry of this.displayed) {
      drawText(
        this.screen.pixels,
        SCREEN_WIDTH,
        SCREEN_HEIGHT,
        entry.column * 8,
        entry.row * GLYPH_HEIGHT,
        entry.text,
        this.textForeground,
        this.textBackground,
      );
    }
  }

  /**
   * Draws the Parser input line from the hidden field's value.
   *
   * The field is the only place the text lives, so the drawn line and the value
   * cannot fall out of step — which is the property #130 asks for and the
   * reason for the arrangement.
   */
  private drawInputLine(): void {
    if (!this.state.inputEnabled || this.textWindow) return;

    const row = PICTURE_TOP + PICTURE_HEIGHT;
    const typed = this.input.text.slice(0, TEXT_COLUMNS - 2);
    drawText(this.screen.pixels, SCREEN_WIDTH, SCREEN_HEIGHT, 0, row, `>${typed}`, 15, 0);

    // The cursor sits where the field's caret is, so the two agree even after a
    // paste or an arrow-key move inside the field.
    const caret = Math.min(this.input.caret, typed.length);
    drawText(this.screen.pixels, SCREEN_WIDTH, SCREEN_HEIGHT, (caret + 1) * 8, row, '_', 15, 0);
  }

  private drawTextWindow(): void {
    const window = this.textWindow;
    if (!window) return;

    const width = Math.min(
      TEXT_COLUMNS - 4,
      Math.max(...window.lines.map((line) => line.length), 1),
    );
    const height = window.lines.length;
    const left = Math.max(0, Math.floor((TEXT_COLUMNS - width - 2) / 2)) * 8;
    const top = Math.max(0, Math.floor((SCREEN_HEIGHT - (height + 2) * GLYPH_HEIGHT) / 2));

    // A bordered box, which is what AGI's own window looks like: white ground,
    // black text, a red frame.
    for (let y = 0; y < (height + 2) * GLYPH_HEIGHT; y++) {
      const rowAt = (top + y) * SCREEN_WIDTH;
      if (top + y >= SCREEN_HEIGHT) break;
      this.screen.pixels.fill(15, rowAt + left, rowAt + left + (width + 2) * 8);
    }

    for (const [index, line] of window.lines.entries()) {
      drawText(
        this.screen.pixels,
        SCREEN_WIDTH,
        SCREEN_HEIGHT,
        left + 8,
        top + (index + 1) * GLYPH_HEIGHT,
        line.slice(0, width),
        0,
        15,
      );
    }
  }

  // ------------------------------------------------------------------- input

  /**
   * A line the player typed, parsed against the vocabulary.
   *
   * Public because `AgiInput` is not the only host there is. It translates DOM
   * events, and a DOM is exactly what a headless host — `npm run diagnose`, or
   * a test — has not got. Leaving these private meant the input path could only
   * be exercised in a browser, which is the half of the engine hardest to get
   * at and the half a stuck game most often turns out to be waiting on.
   */
  submitLine(text: string): void {
    const { state } = this;
    if (!state.inputEnabled) return;

    const parsed = parseInput(this.vocabulary, text);
    this.spokenGroups = parsed.groups;

    if (parsed.unknownWord !== null) {
      state.setVar(V.WORD_NOT_FOUND, parsed.unknownIndex);
      // AGI's own response, so it reads as the game rather than as us.
      this.print(unknownWordMessage(parsed.unknownWord));
      this.spokenGroups = [];
      return;
    }

    state.setFlag(F.ENTERED_COMMAND, parsed.groups.length > 0);
    state.setFlag(F.SAID_ACCEPTED, false);
  }

  /**
   * A key the player pressed.
   *
   * Dismisses a text window that is waiting for one, sets `V.KEY` for
   * `have.key`, and fires any controller a script bound to it with `set.key`.
   */
  pressKey(code: number): void {
    // **The menu takes the keyboard while it is up.** Not a special case bolted
    // on: a menu is modal in Sierra's interpreter too, and a key that reached
    // `set.key` underneath it would fire a controller the player was not
    // choosing — Escape, which closes the menu, is bound to something in a good
    // many games.
    if (this.menu.open) {
      const chosen = this.menu.key(code, (controller) =>
        this.state.disabledControllers.has(controller),
      );
      if (typeof chosen === 'number') this.state.firedControllers.add(chosen);
      return;
    }

    this.state.setVar(V.KEY, code & 0xff);

    // A key dismisses a text window that is waiting for one.
    if (this.textWindow && this.textWindow.remaining < 0) this.textWindow = null;

    // **Escape opens the menu**, which is how a player reaches it. The game
    // calls `menu.input` too, and a release that does so gets there either
    // way; King's Quest III does not, and without this its File menu — the
    // only route to Save, Restore, Restart and Quit — could not be opened at
    // all. Gated on the same flag `menu.input` is, so a cutscene that has
    // taken control keeps it.
    if ((code & 0xff) === 0x1b && this.menu.available && this.state.flag(F.MENU_ALLOWED)) {
      this.menu.show();
      return;
    }

    // A binding is an ASCII code in the low byte and a scan code in the high
    // one, and a game uses whichever half suits the key: `set.key(9, 0, c10)`
    // binds Tab by ASCII, `set.key(0, 68, c40)` binds F10 by scan code.
    //
    // Each half is matched only when the binding actually uses it. Comparing
    // low bytes unconditionally means every scan-code binding has an ASCII part
    // of zero, so pressing *any* function key — whose ASCII part is also zero —
    // fires all of them at once. Enclosure binds five controllers that way,
    // including the one that skips its intro.
    const ascii = code & 0xff;
    const scan = (code >> 8) & 0xff;

    for (const [controller, bound] of this.state.keyBindings) {
      if (this.state.disabledControllers.has(controller)) continue;
      const boundAscii = bound & 0xff;
      const boundScan = (bound >> 8) & 0xff;

      const matched =
        (boundAscii !== 0 && boundAscii === ascii) || (boundScan !== 0 && boundScan === scan);
      if (matched) this.state.firedControllers.add(controller);
    }
  }

  /** The direction the player is holding, 0 to 8. */
  setEgoDirection(direction: number): void {
    if (!this.state.playerControl) return;
    const ego = this.state.object(EGO);
    // Pressing the direction you are already walking stops you, which is how
    // AGI's keyboard control works and is not obvious.
    const next = ego.direction === direction ? 0 : direction;
    ego.direction = next;
    this.state.setVar(V.EGO_DIRECTION, next);
  }

  // -------------------------------------------------------------- LogicHost

  logicBytes(number: number): Uint8Array | null {
    return this.resources.has('logic', number) ? this.resources.read('logic', number) : null;
  }

  logicMessagesEncrypted(number: number): boolean {
    return !this.resources.wasCompressed('logic', number);
  }

  loadPicture(number: number): void {
    if (!this.resources.has('picture', number)) {
      this.log(`load.pic ${number}: this game has no such picture.`);
    }
  }

  drawPicture(number: number): void {
    if (!this.resources.has('picture', number)) {
      this.log(`draw.pic ${number}: this game has no such picture.`);
      return;
    }
    this.picture = new AgiPicture();
    const result = this.picture.execute(this.resources.read('picture', number));
    this.pictureCommands = result.commands;
    for (const note of result.notes) this.log(`picture ${number}: ${note.message}`);
    this.state.currentPicture = number;
    this.state.pictureShown = false;
  }

  overlayPicture(number: number): void {
    if (!this.resources.has('picture', number)) return;
    // Additive: an overlay draws on top of what is already there rather than
    // clearing first, which is how a room adds a door to a shared background.
    this.picture.execute(this.resources.read('picture', number), { additive: true });
  }

  discardPicture(): void {
    // Nothing to unload: the volumes are in memory whole (ADR 0010's reasoning
    // applied to a much smaller game), so discarding is bookkeeping AGI did for
    // its own 640K and this does not need.
  }

  showPicture(): void {
    this.state.pictureShown = true;
    this.state.textMode = false;
  }

  showPriorityScreen(): void {
    // A debugging view Sierra's own interpreter had. Swapping the buffers here
    // would show it; leaving it is honest, and the editor's overlay (#135) is
    // where an author actually wants it.
    this.log('show.pri.screen: the priority buffer is shown in the editor rather than in play.');
  }

  addToPicture(
    view: number,
    loop: number,
    cel: number,
    x: number,
    y: number,
    priority: number,
    margin: number,
  ): void {
    const resource = this.loadedView(view);
    const source = resource?.loops[loop]?.cels[cel];
    if (!source) {
      this.log(`add.to.pic: view ${view} loop ${loop} cel ${cel} is not there.`);
      return;
    }

    // Stamped into the picture permanently, both buffers — which is what makes
    // it scenery rather than an object: nothing animates it and it blocks
    // walking from now on.
    drawCel(source, x, y, {
      target: this.picture.visual,
      width: PICTURE_WIDTH,
      height: PICTURE_HEIGHT,
    });

    const band = priority === 0 ? this.bands[Math.min(this.bands.length - 1, y)] : priority;
    for (let row = 0; row < source.height; row++) {
      const screenY = y - source.height + 1 + row;
      if (screenY < 0 || screenY >= PICTURE_HEIGHT) continue;
      for (let column = 0; column < source.width; column++) {
        const screenX = x + column;
        if (screenX < 0 || screenX >= PICTURE_WIDTH) continue;
        if (source.pixels[row * source.width + column] === source.transparent) continue;
        this.picture.priority[screenY * PICTURE_WIDTH + screenX] = band;
      }
    }

    // The margin is a control line drawn under the object's base, so the player
    // walks round it rather than through it. Zero means no margin at all.
    if (margin > 0 && margin < 4) {
      const baseRow = Math.min(PICTURE_HEIGHT - 1, y);
      for (let column = 0; column < source.width; column++) {
        const screenX = x + column;
        if (screenX < 0 || screenX >= PICTURE_WIDTH) continue;
        this.picture.priority[baseRow * PICTURE_WIDTH + screenX] = margin;
      }
    }
  }

  loadView(number: number): void {
    this.loadedView(number);
  }

  private loadedView(number: number): AgiViewResource | null {
    const cached = this.views.get(number);
    if (cached) return cached;
    if (!this.resources.has('view', number)) {
      this.log(`view ${number}: this game has no such view.`);
      return null;
    }
    try {
      const view = readView(this.resources.read('view', number));
      this.views.set(number, view);
      return view;
    } catch (error) {
      this.log(`view ${number} could not be read: ${String(error)}`);
      return null;
    }
  }

  discardView(number: number): void {
    this.views.delete(number);
  }

  viewLoopCount(number: number): number {
    return this.loadedView(number)?.loops.length ?? 0;
  }

  viewCelCount(number: number, loop: number): number {
    return this.loadedView(number)?.loops[loop]?.cels.length ?? 0;
  }

  applyCelSize(object: ScreenObject): void {
    const cel = this.loadedView(object.view)?.loops[object.loop]?.cels[object.cel];
    object.width = cel?.width ?? 0;
    object.height = cel?.height ?? 0;
  }

  loadSound(number: number): void {
    if (!this.resources.has('sound', number)) {
      this.log(`load.sound ${number}: this game has no such sound.`);
    }
  }

  playSound(number: number, endFlag: number): void {
    if (!this.resources.has('sound', number)) {
      // The flag still has to be set, or a game waiting on a missing sound
      // waits for ever.
      this.state.setFlag(endFlag, true);
      return;
    }
    try {
      this.soundPlayer.play(readSound(this.resources.read('sound', number)), endFlag);
    } catch (error) {
      this.log(`sound ${number} could not be read: ${String(error)}`);
      this.state.setFlag(endFlag, true);
    }
  }

  stopSound(): void {
    this.soundPlayer.stop();
  }

  discardSound(): void {
    // As with pictures: nothing to unload.
  }

  loadLogic(number: number): void {
    if (!this.resources.has('logic', number)) {
      this.log(`load.logics ${number}: this game has no such logic.`);
    }
  }

  discardLogic(): void {
    // As above.
  }

  print(text: string): void {
    const lines = wrapMessage(text, TEXT_COLUMNS - 6);
    // A window waits for a key unless the game asked for a timed one, which is
    // what `V.WINDOW_CLOSE_TIME` is for — and games do rely on the difference.
    const seconds = this.state.var(V.WINDOW_CLOSE_TIME);
    this.textWindow = { lines, remaining: seconds > 0 ? seconds * 20 : -1 };
    this.log(`print: ${text}`);
  }

  display(row: number, column: number, text: string): void {
    this.displayed.push({ row, column, text });
  }

  clearLines(from: number, to: number, colour: number): void {
    for (let index = this.displayed.length - 1; index >= 0; index--) {
      const entry = this.displayed[index];
      if (entry.row >= from && entry.row <= to) this.displayed.splice(index, 1);
    }
    for (let row = from; row <= to; row++) {
      const y = row * GLYPH_HEIGHT;
      for (let line = 0; line < GLYPH_HEIGHT && y + line < SCREEN_HEIGHT; line++) {
        const at = (y + line) * SCREEN_WIDTH;
        this.screen.pixels.fill(colour, at, at + SCREEN_WIDTH);
      }
    }
  }

  clearTextRect(row1: number, column1: number, row2: number, column2: number): void {
    for (let index = this.displayed.length - 1; index >= 0; index--) {
      const entry = this.displayed[index];
      if (
        entry.row >= row1 &&
        entry.row <= row2 &&
        entry.column >= column1 &&
        entry.column <= column2
      ) {
        this.displayed.splice(index, 1);
      }
    }
  }

  /**
   * Sets the colours `display` draws with.
   *
   * **In graphics mode, any non-zero background means "inverted" — black on
   * white — whatever colours were actually asked for.** That is not an
   * approximation, it is what Sierra's interpreter does, and a game relies on
   * it: Enclosure's logo screen asks for `set.text.attribute(0, 1)`, black on
   * *blue*, and every screenshot of it shows black on white.
   *
   * A zero background means transparent, so text drawn over a picture lets it
   * through rather than sitting in a black box.
   *
   * Found by comparing a render against the reference screenshot that ships
   * with the game — the check #127 asks for, doing exactly what it is for.
   */
  setTextAttribute(foreground: number, background: number): void {
    if (this.state.textMode) {
      this.textForeground = foreground & 0x0f;
      this.textBackground = background & 0x0f;
      return;
    }

    if ((background & 0x0f) !== 0) {
      this.textForeground = 0;
      this.textBackground = 15;
      return;
    }

    this.textForeground = foreground & 0x0f;
    // Transparent: the picture behind shows through.
    this.textBackground = -1;
  }

  setCursorCharacter(): void {
    // The drawn cursor follows the hidden field's caret rather than a
    // character the game picked, because the field is the source of truth for
    // where the caret is (#130).
  }

  configureScreen(): void {
    // AGI's own screen configuration moved the three bands about. The layout
    // here is already data-driven through `Screen.setLayout`, and no game in
    // scope changes it from the default.
  }

  statusLine(visible: boolean): void {
    this.state.statusLineVisible = visible;
  }

  textScreen(): void {
    this.state.textMode = true;
  }

  graphicsScreen(): void {
    this.state.textMode = false;
  }

  shakeScreen(count: number): void {
    this.log(`shake.screen ${count}`);
  }

  closeWindow(): void {
    this.textWindow = null;
  }

  getNumber(prompt: string, into: number): void {
    // Asked through the same hidden field the parser uses, so it is accessible
    // for the same reasons. Until the player answers, the variable keeps its
    // value — which is what AGI does while its own prompt is up.
    this.print(prompt);
    this.state.setVar(into, this.state.var(into));
  }

  getString(slot: number, prompt: string): void {
    this.print(prompt);
    this.state.strings[slot] = this.state.strings[slot] ?? '';
  }

  parseString(slot: number): void {
    const parsed = parseInput(this.vocabulary, this.state.strings[slot] ?? '');
    this.spokenGroups = parsed.groups;
    this.state.setFlag(F.ENTERED_COMMAND, parsed.groups.length > 0);
    this.state.setFlag(F.SAID_ACCEPTED, false);
  }

  saidWords(): readonly number[] {
    return this.spokenGroups;
  }

  acceptSaid(): void {
    this.state.setFlag(F.SAID_ACCEPTED, true);
  }

  wordToString(slot: number, wordIndex: number): void {
    this.state.strings[slot] = this.spokenWord(wordIndex);
  }

  /**
   * A word of the player's last line, for `%w` in a message.
   *
   * The canonical spelling of the group rather than what was typed, which is
   * the same answer `word.to.string` gives — the parser keeps groups, not
   * keystrokes, so a synonym comes back as the word the game's vocabulary
   * files it under.
   */
  spokenWord(index: number): string {
    const group = this.spokenGroups[index];
    const words = group === undefined ? [] : (this.vocabulary.groups.get(group) ?? []);
    return words[0] ?? '';
  }

  /** An inventory item's name, for `%0` in a message. */
  itemName(item: number): string {
    return this.objectFile.items[item]?.name ?? '';
  }

  itemRoom(item: number): number {
    return this.itemRooms[item] ?? 0;
  }

  setItemRoom(item: number, room: number): void {
    if (item < this.itemRooms.length) this.itemRooms[item] = room;
  }

  readonly carriedRoom = CARRIED_ROOM;

  showInventoryItem(item: number): void {
    const name = this.objectFile.items[item]?.name ?? `item ${item}`;
    this.print(name);
  }

  showInventoryScreen(): void {
    const carried = this.objectFile.items
      .map((item, index) => ({ item, index }))
      .filter(({ index }) => this.itemRooms[index] === CARRIED_ROOM)
      .map(({ item }) => item.name);

    this.print(
      carried.length > 0 ? `You are carrying:\n${carried.join('\n')}` : 'You are empty handed.',
    );
  }

  saveGame(): void {
    // The script asked; the shell owns where a save goes, so this is a request
    // rather than an action. Mirrors how `ScummEngine` hands a script-driven
    // save back to its host.
    this.onSaveRequested?.();
  }

  restoreGame(): void {
    this.onRestoreRequested?.();
  }

  /** Set by the shell so a script's `save.game` reaches the save store. */
  onSaveRequested: (() => void) | null = null;
  onRestoreRequested: (() => void) | null = null;

  restartGame(): void {
    this.state.restartRequested = true;
    this.state.exitAllLogics = true;
  }

  showMemory(): void {
    this.print(`Free memory: ${this.state.var(V.FREE_PAGES)} pages`);
  }

  pauseGame(): void {
    this.print('Game paused. Press Enter to continue.');
  }

  showVersion(): void {
    this.print(this.targetName);
  }

  setMenu(text: string): void {
    this.menu.addColumn(text);
  }

  setMenuItem(text: string, controller: number): void {
    this.menu.addItem(text, controller);
  }

  submitMenu(): void {
    this.menu.submit();
    const columns = this.menu.describe();
    this.log(
      `submit.menu: ${columns.length} menus — ` +
        columns.map((column) => `${column.text.trim()} (${column.items.length})`).join(', '),
    );
  }

  /**
   * `menu.input` — the game asking for the menu to be opened now.
   *
   * Gated on flag 14, which is the flag a script clears while a cutscene is
   * running: opening the menu there would offer Save in the middle of a scene
   * the game has taken control of.
   */
  menuInput(): void {
    if (!this.state.flag(F.MENU_ALLOWED)) return;
    this.menu.show();
  }

  random(low: number, high: number): number {
    const span = Math.max(0, high - low);
    return low + Math.floor(this.rng() * (span + 1));
  }

  reportUnimplemented(name: string, opcode: number): void {
    if (this.unimplemented.has(name)) return;
    this.unimplemented.set(name, opcode);
    // Once by name, never silently. #129 is explicit that sound opcodes may
    // no-op but must be logged, and the same rule is applied to every other
    // command with nothing to do here.
    this.log(
      `${name} (opcode 0x${opcode.toString(16).padStart(2, '0')}) is not implemented ` +
        `and has been skipped. If this game misbehaves, this is the first place to look.`,
    );
  }

  /**
   * Whether a text window is up, waiting to be dismissed.
   *
   * A host needs this to know that a key is what the game wants: a window holds
   * the cycle, so a game "stuck" with one open is not stuck at all.
   */
  get isWaitingForKey(): boolean {
    return this.textWindow !== null;
  }

  /** Opcodes this game asked for that are not implemented, for the log. */
  get unimplementedOpcodes(): ReadonlyMap<string, number> {
    return this.unimplemented;
  }

  private setPriorityBase(base: number): void {
    this.priorityBase = base;
    this.bands = priorityTable(base);
  }

  /** The picture's decoded commands, for the editor (#135). */
  get currentPictureCommands(): readonly PictureCommand[] {
    return this.pictureCommands;
  }
}

/** Draw order, with each object's priority resolved from its row first. */
function drawOrderFor(objects: readonly ScreenObject[], bands: Uint8Array): ScreenObject[] {
  for (const object of objects) {
    if (!object.fixedPriority) object.priority = effectivePriority(object, bands);
  }
  return drawOrder(objects);
}

/**
 * Which way to walk to get from one point to another, or 0 for "already there".
 *
 * Transcribed from ScummVM's `getDirection`, and the shape of it is the point:
 * each axis is reduced to one of three states by comparing its remaining
 * distance against the **step size**, and the two states index a nine-entry
 * table. A remaining distance smaller than one step counts as *aligned* — so an
 * object cannot overshoot its target and oscillate around it, and "direction is
 * zero" doubles as the arrival test.
 *
 * The table is laid out as a three-by-three grid of (x state, y state), which
 * is why the middle entry is 0: neither axis has anywhere left to go.
 */
const DIRECTION_TABLE = [8, 1, 2, 7, 0, 3, 6, 5, 4] as const;

/** -1, 0 or +1 for "step back", "close enough" and "step forward". */
function axisState(delta: number, stepSize: number): number {
  if (-stepSize >= delta) return 0;
  return stepSize <= delta ? 2 : 1;
}

function directionTowards(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  stepSize = 1,
): number {
  const step = Math.max(1, stepSize);
  return DIRECTION_TABLE[axisState(toX - fromX, step) + 3 * axisState(toY - fromY, step)];
}

/**
 * Narrows the interpreter version against the game's own bytecode.
 *
 * Only ever *upgrades* the identification. A version read from `AGIDATA.OVL` or
 * from the shipped interpreter is a fact and the probe has no standing against
 * it; a version the author declared is their assertion and the probe has no
 * standing against that either. What the probe replaces is the `fallback` —
 * the assumed 2.917 — and only when exactly one candidate table decodes the
 * game without the game contradicting itself (ADR 0013, and ADR 0020's
 * reasoning about probes).
 *
 * A probe that leaves two candidates still logs everything it measured. That is
 * the useful half even when it cannot decide: it tells a person choosing a
 * version in the editor which ones are possible and what they disagree about,
 * instead of offering all six with nothing to go on.
 */
function refineWithArityProbe(
  detected: DetectedAgiGame,
  resources: AgiResources,
  options: AgiEngineOptions,
): { game: DetectedAgiGame; probe: AgiArityProbe | null } {
  const log = options.onLog ?? ((): void => undefined);
  if (detected.target.engine !== 'agi') return { game: detected, probe: null };

  const probe = probeArityTable({
    major: detected.layout.major,
    platform: detected.target.platform,
    gameId: detected.id,
    logics: resources.list('logic'),
    read: (logic) => resources.read('logic', logic),
    // The message table is obfuscated unless the resource arrived compressed,
    // which is the resource layer's fact rather than a guess (#127).
    encrypted: (logic) => !resources.wasCompressed('logic', logic),
  });
  for (const note of probe.notes) log(note);

  const settled =
    detected.target.identification !== 'fallback' &&
    detected.target.identification !== 'bytecode-probe';
  if (settled) {
    log(
      `The probe above is a measurement rather than a decision: this game's version came ` +
        `from ${detected.target.identification}, which outranks it.`,
    );
    return { game: detected, probe };
  }

  if (probe.survivors.length !== 1) return { game: detected, probe };

  const interpreter = probe.survivors[0].interpreter;
  return {
    game: {
      ...detected,
      // **The fallback's note is replaced, not appended to.** It ends "cannot
      // be edited (ADR 0013)", which was true of the assumption and is not
      // true of the probe — carrying it through left a note that identified the
      // version and then denied it in the same sentence.
      interpreterNote:
        `The game's own bytecode names its arity table: only ` +
        `${formatInterpreterVersion(interpreter)}'s decodes every Logic without the game ` +
        `contradicting itself, so the interpreter is identified by probe rather than assumed. ` +
        `(Before the probe: ${detected.interpreterNote})`,
      target: { ...detected.target, interpreter, identification: 'bytecode-probe' },
    },
    probe,
  };
}
