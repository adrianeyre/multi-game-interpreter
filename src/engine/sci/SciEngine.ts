/**
 * The SCI family's Engine: Sierra's Creative Interpreter, SCI0 to SCI3.
 *
 * The third Engine family in this project (ADR 0015), and one family rather
 * than two despite the SCI32 break — the claim rests on shared bytecode and a
 * resource layout that drifts rather than breaks, not on the renderer.
 *
 * What is different about SCI, in one paragraph each:
 *
 * **The tables ship inside the game.** A script names Selectors and classes by
 * index into `vocab.997` and `vocab.996`, so there is no external arity table,
 * no per-build drift and no per-title correction list — nothing that would make
 * this family grow AGI's `gameId?` field. The one exception is the Kernel
 * table, which lives in Sierra's interpreter, and that is the whole reason a
 * SCI Target has to name a Version (ADR 0016).
 *
 * **The Version is probed, never stamped.** SCI writes its version nowhere.
 * The map's structure gives a bucket and ADR 0020's probes narrow it; where
 * they cannot, ADR 0013's rule fires and the game plays but is refused for
 * editing, with the reason on screen.
 *
 * **Resources are read by offset.** Phantasmagoria is seven discs, so nothing
 * here holds a Volume (ADR 0021). A caller that needs bytes synchronously asks
 * in advance.
 */

import type {
  AdventureEngine,
  EditableGame,
  EditableGameOptions,
  SavedGameEnvelope,
} from '../AdventureEngine.js';
import type { DataSource } from '../resource/DataSource.js';
import { LoadProgressTracker } from '../resource/progress.js';
import { Palette } from '../gfx/Palette.js';
import { SCREEN_HEIGHT, SCREEN_WIDTH, Screen } from '../gfx/Screen.js';
import { describeUneditableTarget, type Target } from '../../authoring/target.js';
import { createProject } from '../../authoring/project.js';
import { importSciGame } from '../../authoring/sci/importSciGame.js';
import { describeTextSurface } from '../../authoring/sci/sciSource.js';
import {
  describeSciVersion,
  selectorIdCarriesReadWriteBit,
  type SciVersion,
} from './sciVersion.js';
import { SciInput } from './SciInput.js';
import { SciSound } from './sound/SciSound.js';
import { detectSciGame } from './resource/detectSciGame.js';
import { PMachine, reg, type Reg } from './script/PMachine.js';
import { SciScripts } from './script/SciScripts.js';
import { readKernelVocab } from './script/kernel.js';
import { readClassTable, selectorTableFor, type SciSelectorTable } from './script/selectors.js';
import { SCI_KERNEL, type SciFileSurface, type SciKernelWorld } from './script/SciKernel.js';
import { createSciFileSurface } from './script/sciFiles.js';
import {
  drawSciPicture,
  sci16PictureTop,
  SCI_PICTURE_HEIGHT,
  SCI_PICTURE_WIDTH,
} from './gfx/SciPicture.js';
import { readSciCelPicture } from './gfx/SciCelPicture.js';
import {
  messageKey,
  readSciMessages,
  readSciSync,
  type SciMessageKey,
  type SciMessageResource,
  type SciSyncStep,
} from './resource/sciMessage.js';
import { readSciFont, type SciFontResource } from './gfx/SciFont.js';
import {
  parseSciLine,
  readSciVocabulary,
  vocabularyIndex,
  type SciWord,
} from './resource/sciVocabulary.js';
import { drawSciText, measureSciText } from './gfx/SciText.js';
import { sciPictureKind } from './gfx/pictureKind.js';
import { readSciView, type SciViewResource } from './gfx/SciView.js';
import {
  celOrigin,
  NO_VIEW,
  Plane,
  SciCompositor,
  sci32NowSeenRect,
  screenItemSize,
  type ScreenItem,
} from './gfx/Plane.js';
import { SciMoviePlayer } from './video/SciMoviePlayer.js';
import { frameScreenItems, openSciRobot, type SciRobotStream } from './video/SciRobot.js';
import { applyEgaPalette, applySciPalette, readSciPalette } from './gfx/sciPalette.js';
import {
  cursorToDataUri,
  readSciCursor,
  readSciViewCursor,
  type SciCursor,
} from './gfx/SciCursor.js';
import { SciHeap } from './script/segments.js';
import {
  captureSciState,
  restoreSciState,
  SCI_SAVE_NOTE as SCI_SAVE_NOTE_TEXT,
  type SciSavedGame,
} from './save/SciSaveState.js';
import { kernelNamesFor } from './script/kernel.js';
import type { SciResources } from './resource/SciResources.js';
import { SCI_RESOURCE_TYPES, type SciResourceType } from './resource/sciResourceTypes.js';
import { SciPalVary, type SciPalVaryColour } from './gfx/sciPalVary.js';
import { SciBitmaps } from './gfx/SciBitmap.js';
import type { DetectedSciGame } from './resource/sciDetect.js';
import type { ProjectAudio } from '../../authoring/audio.js';
import {
  describeSciAudio36,
  listSciAudio,
  readSciAudioEntries,
} from '../../authoring/sci/audioList.js';

/**
/**
 * The `vocab` resource holding a parser-driven game's words.
 *
 * Zero, and only zero. ScummVM picks `vocab.000` when it exists and `vocab.900`
 * otherwise (`Vocabulary::Vocabulary`, `engines/sci/parser/vocabulary.cpp`,
 * fetched 2026-09-12) — but the two are *different formats*, and this project's
 * reader is the SCI0 one it is named for. Reading a SCI1 `vocab.900` with it
 * would produce a vocabulary of plausible-looking nonsense rather than failing,
 * which is the characteristic SCI fault `CONTEXT.md` names. So the SCI1 form is
 * absent rather than misread, and Quest for Glory II — the one SCI1 that still
 * has a parser — is left without one.
 */
const SCI0_MAIN_VOCABULARY = 0;

/**
 * The Kernel calls that are really a dozen calls behind one number.
 *
 * Each dispatches on its first argument, so a count against the bare name says
 * a game did *something* with saves or lists and not which. The diagnostic
 * splits these and leaves every other call alone, because a sub-function
 * number on a call that has none is noise.
 */
const MULTIPLEXED_KERNELS = new Set([
  'Save',
  'DoSound',
  'List',
  'String',
  'Array',
  'Bitmap',
  'PalCycle',
  'RemapColors',
  'PalVary',
  'CreateTextBitmap',
]);

export interface SciEngineOptions {
  onLog?: (message: string) => void;
  progress?: LoadProgressTracker;
  onActivity?: (activity: string) => void;
  /**
   * A Version stated by a person, rather than one the probes arrived at.
   *
   * ADR 0020 defines `declared` as one of the ways a SCI Version can be
   * established and `describeUneditableTarget` tells an author to use it — and
   * until this option existed **nothing in the codebase produced that value**.
   * The identification was reachable in the type and by no code path, so the
   * refusal named a remedy a person could not take.
   *
   * It is set before `loadTables()`, which is the only place it could go: the
   * Kernel table, the Selector numbering and the Script layout are all read
   * there, so a Version substituted afterwards would describe tables that had
   * already been built from another one.
   *
   * ADR 0013's warning is unchanged and is the reason this is an option rather
   * than a default. A declaration is not a probe: naming the wrong Version
   * gives a game that runs and does the wrong things, and re-emits its own
   * misreading byte for byte. What makes it legitimate is that a person chose
   * it deliberately, against a warning, and the Target records that they did.
   */
  declaredVersion?: SciVersion;
}

/**
 * The save format this family writes.
 *
 * Versioned independently of SCUMM's and AGI's, which is why the shell is told
 * the number rather than importing one: a SCI format 1 is not comparable with a
 * SCUMM format 4 (ADR 0011).
 */
export const SCI_SAVE_FORMAT = 1;

export const SCI_SAVE_NOTE = SCI_SAVE_NOTE_TEXT;

export class SciEngine implements AdventureEngine {
  readonly screen: Screen;
  readonly palette = new Palette();
  readonly input = new SciInput();
  readonly sound = new SciSound();

  /**
   * The files a SCI0 game opens by name (`createSciFileSurface`).
   *
   * In memory and for this session only — there is no disc in a browser tab —
   * and the module says what that costs. The interpreter owns one because
   * `FOpen` has to answer something; a host with somewhere durable to put bytes
   * supplies its own implementation of `SciFileSurface` instead.
   */
  private readonly files: SciFileSurface = createSciFileSurface({
    log: (message) => this.log(message),
  });
  readonly saveFormat = SCI_SAVE_FORMAT;
  readonly saveNote = SCI_SAVE_NOTE;
  readonly resolution: {
    script: { width: number; height: number };
    display: { width: number; height: number };
  };

  readonly resources: SciResources;
  readonly game: DetectedSciGame;
  readonly log: (message: string) => void;
  /** One Script engine for the family (ADR 0017). */
  readonly machine: PMachine;
  readonly scripts: SciScripts;
  /** The Selector names this game ships, or Sierra's own where it ships none. */
  selectors: SciSelectorTable = { names: [], numbers: new Map() };
  /** Whether `selectors` came from the game or from the fallback table. */
  selectorsFromGame = false;
  /** The Kernel names this game ships, where it does — SCI0 and SCI01 do. */
  kernelNames: string[] = [];
  /** Kernel numbers a script asked for that are not implemented yet. */
  readonly unimplementedKernels = new Set<number>();
  /** The object the boot sent `play` to, which `Parse` reports a failure to. */
  private gameObjectRef: Reg | null = null;
  /**
   * The parser's vocabulary, indexed once.
   *
   * `undefined` means not looked for yet and `null` means looked for and not
   * there, which are different facts: the second is how a SCI1 game says it has
   * no parser, and re-reading a resource that is absent once a cycle for the
   * length of a game is the cost of conflating them.
   */
  private parserWords: Map<string, SciWord> | null | undefined;
  /** The interpreter's own heap: lists, nodes and blocks (ADR 0019). */
  readonly heap = new SciHeap();
  /** Kernel calls made, by name, for the diagnostic. */
  readonly kernelCalls = new Map<string, number>();

  /**
   * The room, as a Plane carrying its Picture's priority buffer (ADR 0015).
   *
   * One Plane rather than a framebuffer with a mask beside it, because that is
   * the decision: SCI32's compositor is this one with Planes that carry no
   * mask, and building it the other way round is what #225 exists to avoid.
   */
  readonly compositor = new SciCompositor();
  private roomPlane: Plane | null = null;
  /**
   * How many of the room Plane's items belong to the Picture rather than the cast.
   *
   * Zero for a vector Picture, whose whole contribution is the background and
   * the mask, and non-zero for a cel Picture, which *is* screen items. The cast
   * is redrawn every frame and the Picture is not, so the boundary has to be
   * somewhere; a count is the cheapest place that does not put a "this one is
   * scenery" flag on every actor.
   */
  private pictureItemCount = 0;
  /** Views decoded once and kept, keyed by resource number. */
  private readonly views = new Map<number, SciViewResource>();
  /**
   * The palette entries text is drawn in, as `TextColors` set them.
   *
   * Held rather than applied, because nothing draws text yet — but a game sets
   * these once at startup and assumes them afterwards, so forgetting them is
   * how text later comes out in whatever colour the last window left behind.
   */
  private textColours: number[] = [];

  /** The fonts `TextFonts` set, which a `|f1|` code inside a string selects. */
  private textFonts: number[] = [];

  /** Palette bands `PalCycle` set rotating, by their first entry. */
  private readonly palCycles = new Map<
    number,
    { to: number; direction: number; at: number; on: boolean }
  >();

  /** What `RemapColors` was asked for, kept because it cannot yet be rendered. */
  private readonly remaps: Array<{ sub: number; values: number[] }> = [];

  /** Saves the game itself asked for, by slot, for this session. */
  private readonly gameSaves = new Map<number, SavedGameEnvelope>();

  /** A restore the game asked for, applied between cycles rather than mid-send. */
  private pendingRestore: SavedGameEnvelope | null = null;

  /** SCI32's off-screen surfaces, which is how a SCI32 game draws text. */
  private readonly bitmaps = new SciBitmaps();

  /** The `PalVary` fade, which the cycle advances and the palette receives. */
  private readonly palVary = new SciPalVary();
  /** `MESSAGE` resources already read, decoded once and kept. */
  private readonly messages = new Map<number, ReturnType<typeof readSciMessages>>();
  /**
   * Modules a `Message` call wanted and the reader did not have in hand.
   *
   * Same shape as `pendingScripts` and for the same reason: `kMessage` happens
   * in the middle of a send and reading a SCI32 Volume is asynchronous, so the
   * only synchronous answer is what is already cached. Collected here and read
   * between cycles, after which the game's next ask finds it.
   *
   * Modules the game asks for and the release has not got are remembered too,
   * so a script that asks every cycle re-reads the map every cycle instead of
   * the Volume.
   */
  private readonly pendingMessages = new Set<number>();
  private readonly missingMessages = new Set<number>();
  /** `font` resources already read, decoded once and kept. */
  private readonly fonts = new Map<number, SciFontResource | null>();
  /** `sync36` timings already read, keyed by the number a Message's tuple gives. */
  private readonly syncs = new Map<number, SciSyncStep[]>();
  /**
   * SCI32's display list: the game's own Planes, by the reference it named them.
   *
   * Held apart from `roomPlane` because they are two ways of describing a
   * screen and not two names for one. SCI16 draws a Picture and animates a
   * cast over it; SCI32 hands over a list of Planes and asks for a frame. ADR
   * 0015's claim is that **one compositor serves both**, and this is where that
   * is put to the test — these Planes go into the same `SciCompositor`, with no
   * mask, and occlude by ordering alone.
   */
  private readonly gamePlanes = new Map<string, Plane>();
  /**
   * The Plane each screen item is on **and the item itself**.
   *
   * Holding only the Plane's name was the whole of why a SCI32 game drew
   * nothing it could keep: `UpdateScreenItem` deleted by name, the delete found
   * no item to take off the Plane, and the update added a second one. King's
   * Quest VII's boot makes 45,000 of those calls against twenty items, so the
   * Plane it was framing out held tens of thousands of stale cels in insertion
   * order with the live ones buried underneath.
   */
  private readonly screenItems = new Map<string, { plane: string; item: ScreenItem }>();
  /**
   * Planes whose Picture has been asked for and not yet read.
   *
   * `AddPlane` is a Kernel call and cannot await, and a SCI32 Volume is not in
   * memory (ADR 0021) — so a Plane's background is requested here and attached
   * between cycles by `loadPending`, the same arrangement `pendingScripts`
   * already uses. Reading it with `peek` instead, as this did, asks for a
   * resource that has never been read and is answered null every time: every
   * SCI32 room was a Plane with no background.
   */
  private readonly pendingPlanePictures: Array<{
    id: string;
    picture: number;
    /** Where the Picture's own cel positions are measured from, in script space. */
    at: { x: number; y: number };
    /** True for the Plane's own `picture`, which a later change may cancel. */
    own: boolean;
  }> = [];
  /** Set by `FrameOut`, so a SCI32 game's own render drives the screen. */
  private framedOut = false;
  /** Whether the Picture on screen is still the one the scripts drew. */
  private picValid = false;
  /** The Picture number last drawn, for the diagnostic and for `shot`. */
  lastPicture: number | null = null;
  /**
   * The pointer the game asked for, as CSS.
   *
   * CSS rather than pixels in the framebuffer, because a cursor drawn into the
   * framebuffer moves at the *game's* frame rate rather than the pointer's —
   * and on a game running at ten cycles a second that is a pointer visibly
   * lagging the mouse. The shell reads this and sets it on the canvas.
   */
  cursorStyle: string | null = null;
  private cursorVisible = true;

  /**
   * The video on screen, when there is one (#226).
   *
   * A video is *played at the screen* rather than composited, so it is here
   * rather than on a Plane — and the PMachine stops while one is on, because
   * Sierra's `kShowMovie` and `kPlayVMD` do not return until the video ends.
   */
  private movies!: SciMoviePlayer;
  /**
   * The Robot on screen, which is the other case entirely.
   *
   * A Robot is a **screen-item kind**: its cels go onto a Plane and are sorted
   * and occluded like a View cel's. That it lives here as a stream of frames
   * and not as a second drawing path is ADR 0015's claim holding.
   */
  private robot: {
    stream: SciRobotStream;
    plane: string;
    priority: number;
    x: number;
    y: number;
    frame: number;
    items: ScreenItem[];
    finished: boolean;
  } | null = null;
  /** A Robot a Kernel call asked for, opened between cycles like a script. */
  private pendingRobot: {
    robot: number;
    plane: string;
    priority: number;
    x: number;
    y: number;
  } | null = null;

  /**
   * Cycles since boot, which is also the engine's clock — see `ticks`.
   *
   * Sierra's interpreter drove its animation at sixty ticks a second and the
   * scripts do their own timing arithmetic in those units, so one cycle is one
   * tick and the counter is both.
   */
  private frameCounter = 0;
  private room = 0;
  private quit = false;

  private constructor(
    game: DetectedSciGame,
    resources: SciResources,
    log: (message: string) => void,
  ) {
    this.game = game;
    this.resources = resources;
    this.log = log;

    // Both spaces from the Version (#213). Every SCI16 Version runs and draws
    // at 320x200; SCI32 runs its scripts there and composites to 640x480, and
    // #225 is where a Plane may say otherwise for itself.
    const display = resources.isSci32
      ? { width: 640, height: 480 }
      : { width: SCREEN_WIDTH, height: SCREEN_HEIGHT };
    this.resolution = { script: { width: SCREEN_WIDTH, height: SCREEN_HEIGHT }, display };
    this.screen = new Screen(display.width, display.height);
    // The pointer is reported to scripts in the space they think in, which is
    // not the framebuffer's from SCI2 on.
    this.input.displaySize = display;
    this.input.scriptSize = this.resolution.script;

    this.machine = new PMachine(game.version, {
      scriptCode: (number) => this.scripts.code(number),
      exportOffset: (script, index) => this.scripts.get(script)?.exports[index] ?? null,
      heapStart: (script) => this.scripts.get(script)?.heapAt ?? 0,
      log: (message) => this.log(message),
      // Resolved by *name*, through the Version's own table (#217), and then
      // implemented by name in `SCI_KERNEL`. A file of numbered handlers is
      // precisely how a Kernel table ends up off by one entry, which is the
      // failure nothing on screen shows.
      callKernel: (number, args) => {
        const name = this.kernelNameFor(number);
        const handler = name ? SCI_KERNEL[name] : undefined;
        if (!handler) {
          this.unimplementedKernels.add(number);
          return null;
        }
        // **Counted by sub-function where there is one.** `Save`, `List`,
        // `String`, `Bitmap`, `PalCycle` and `RemapColors` are each a dozen
        // calls behind one number, and "Save×341" says a game is doing
        // something with saves 341 times a session without saying which of the
        // nine things it is. Which one it is is the whole question when a game
        // polls one every cycle and never gets past it.
        const counted = MULTIPLEXED_KERNELS.has(name!) ? `${name}(${args[0]?.offset ?? 0})` : name!;
        this.kernelCalls.set(counted, (this.kernelCalls.get(counted) ?? 0) + 1);
        return handler(this.world(), args);
      },
    });
    this.scripts = new SciScripts(this.resources, this.machine, game.version, this.log);
    this.movies = new SciMoviePlayer(this.resources.files, this.input, this.log);
  }

  static async create(source: DataSource, options: SciEngineOptions = {}): Promise<SciEngine> {
    const log = options.onLog ?? ((): void => undefined);
    const { game: detected, resources } = await detectSciGame(source, {
      onLog: log,
      progress: options.progress,
    });

    // A declared Version replaces the detected one before any table is built,
    // and the log says both — a declaration that contradicts what the probes
    // found is worth seeing rather than silently winning.
    const game =
      options.declaredVersion && options.declaredVersion !== detected.version
        ? { ...detected, version: options.declaredVersion, identification: 'declared' as const }
        : detected;

    const engine = new SciEngine(game, resources, log);
    await engine.loadTables();
    log(
      `Detected a ${describeSciVersion(detected.version)} game "${game.id}" ` +
        `(${resources.describeContents()})`,
    );
    if (game.version !== detected.version) {
      log(
        `Running as ${describeSciVersion(game.version)}, declared rather than probed — ` +
          `ADR 0013: a Version arrived at this way plays and is refused for editing ` +
          `unless the person who declared it accepts that.`,
      );
    }
    if (resources.unreadable.length > 0) {
      log(
        `${resources.unreadable.length} resources could not be read: ` +
          resources.unreadable
            .slice(0, 3)
            .map((r) => `${r.type} ${r.number} (${r.reason})`)
            .join('; '),
      );
    }
    return engine;
  }

  /**
   * Draws a Picture into the room Plane.
   *
   * Synchronous, because it is reached from a Kernel call. The resource has to
   * be in hand already, which is what the preload at `start` is for — and a
   * Picture that is not says so rather than leaving the room blank without
   * explanation.
   */
  private drawPicture(number: number): void {
    const bytes = this.resources.peek('pic', number);
    if (!bytes) {
      this.log(`Picture ${number} was not preloaded, so the room cannot be drawn.`);
      return;
    }

    // Which kind, asked of the resource and not of the Version (ADR 0018). A
    // SCI1.1 game ships both, so a Version answer would get half of them wrong.
    if (sciPictureKind(bytes) === 'cel') {
      this.drawCelPicture(number, bytes);
      return;
    }

    // The colour depth is a property of the artwork, not of the Version: a game
    // with palette resources draws in 256 colours whatever bucket it landed in.
    const vga = this.resources.count('palette') > 0;
    const picture = drawSciPicture(bytes, {
      vga,
      width: SCI_PICTURE_WIDTH,
      height: SCI_PICTURE_HEIGHT,
    });

    if (picture.unknown) {
      this.log(
        `Picture ${number} stopped at byte ${picture.unknown.at} on operation ` +
          `0x${picture.unknown.op.toString(16)}. What is on screen is what was reached, not the ` +
          `whole picture.`,
      );
    }

    if (!vga) applyEgaPalette(this.palette);
    if (picture.palette.length > 0) applySciPalette(this.palette, picture.palette);

    // A new Plane rather than a reused one: a room change replaces the Picture
    // *and* its priority buffer, and keeping the old Plane would leave the last
    // room's occlusion mask under the new room's art.
    const plane = new Plane(
      {
        x: 0,
        y: sci16PictureTop(picture.height, this.screen.height),
        width: picture.width,
        height: picture.height,
      },
      0,
      picture.priority,
    );
    plane.background = picture.visual;

    if (this.roomPlane) this.compositor.remove(this.roomPlane);
    this.roomPlane = this.compositor.add(plane);
    this.pictureItemCount = 0;
    this.lastPicture = number;
    this.picValid = true;
    this.log(`Drew Picture ${number} (${picture.commands.length} operations)`);
  }

  /**
   * Draws a cel Picture: a composition rather than a list of operations.
   *
   * The same room Plane and the same compositor. What differs is entirely data
   * on the Plane — a SCI1.1 cel Picture still carries vector operations that
   * paint the mask, and a SCI32 one carries **none**, so its Plane gets `null`
   * and occludes by ordering alone. That is ADR 0015's claim standing up in the
   * one place it would fall over if it were wrong (#225), and it is why there
   * is no second renderer here to keep in step with this one.
   */
  private drawCelPicture(number: number, bytes: Uint8Array): void {
    const composition = readSciCelPicture(bytes);
    if (composition.unknown) {
      this.log(
        `Picture ${number} stopped at byte ${composition.unknown.at}: ` +
          `${composition.unknown.why}. What is on screen is what was reached.`,
      );
    }

    const entries = readSciPalette(bytes, composition.paletteOffset);
    if (entries.length > 0) applySciPalette(this.palette, entries);

    // The vector half, where there is one. SCI1.1's Pictures keep it after the
    // bitmap and it is what still paints the priority buffer this room's actors
    // are tested against; a SCI32 Picture has none, and that Plane's mask stays
    // null rather than being faked from the artwork.
    const vectors = composition.vectorData?.length
      ? drawSciPicture(composition.vectorData, {
          vga: true,
          width: SCI_PICTURE_WIDTH,
          height: SCI_PICTURE_HEIGHT,
        })
      : null;

    const width = composition.resolution?.width ?? SCI_PICTURE_WIDTH;
    const height = composition.resolution?.height ?? SCI_PICTURE_HEIGHT;
    const plane = new Plane(
      { x: 0, y: sci16PictureTop(height, this.screen.height), width, height },
      0,
      vectors?.priority ?? null,
    );

    // The first cel is the background where it covers the Plane; the rest are
    // authored screen items at the priorities the Picture gave them. Both go
    // through `add`, so the compositor sorts them against the cast by the same
    // three keys rather than the background being a special case underneath.
    for (const placed of composition.cels) {
      plane.add({
        cel: placed.cel,
        x: placed.x,
        y: placed.y,
        priority: placed.priority,
        visible: true,
      });
    }

    if (this.roomPlane) this.compositor.remove(this.roomPlane);
    this.roomPlane = this.compositor.add(plane);
    this.pictureItemCount = plane.items.length;
    this.lastPicture = number;
    this.picValid = true;
    this.log(
      `Drew Picture ${number} as a composition: ${composition.cels.length} screen items, ` +
        `${vectors?.commands.length ?? 0} drawing operations, ` +
        `${plane.mask ? 'a priority buffer' : 'no priority buffer — ordering alone'}`,
    );
  }

  /** Puts the cast on the room Plane, each cel tested against its mask. */
  private drawCast(
    cast: ReadonlyArray<{
      view: number;
      loop: number;
      cel: number;
      x: number;
      y: number;
      priority: number;
    }>,
  ): void {
    const plane = this.roomPlane;
    if (!plane) return;
    // A cel Picture's own items are part of the Picture, not part of the cast,
    // and clearing the whole list would erase the room every frame. Kept by
    // count rather than by a flag on the item: the Picture put the first N
    // there and the cast owns everything after.
    plane.items.length = this.pictureItemCount;

    for (const actor of cast) {
      const cel = this.cel(actor.view, actor.loop, actor.cel);
      if (!cel) continue;
      plane.add({
        cel,
        // A cel's own displacement is where its origin sits relative to the
        // actor's position, and an actor's position is its *feet*. Ignoring it
        // stands every actor half a cel down and to one side of where the game
        // thinks it is, which reads as art that does not line up rather than as
        // a fault.
        x: actor.x - cel.displaceX - (cel.width >> 1),
        y: actor.y - cel.displaceY - cel.height,
        priority: actor.priority,
        visible: true,
      });
    }
  }

  /** A cursor by resource number: SCI0's and SCI1's form. */
  private setCursor(number: number, visible: boolean): void {
    this.cursorVisible = visible;
    if (!visible) {
      this.cursorStyle = 'none';
      return;
    }
    const bytes = this.resources.peek('cursor', number);
    const cursor = bytes ? readSciCursor(bytes) : null;
    this.applyCursor(cursor);
  }

  /** A cursor as a View cel: SCI1.1's form. */
  private setViewCursor(view: number, loop: number, cel: number, x: number, y: number): void {
    const bytes = this.resources.peek('view', view);
    this.applyCursor(bytes ? readSciViewCursor(bytes, loop, cel, x, y) : null);
  }

  private applyCursor(cursor: SciCursor | null): void {
    if (!cursor) return;
    this.cursorStyle = cursorToDataUri(cursor, (index) => {
      // A SCI0 cursor's two colours are black and white; a View cursor's are
      // palette indices. One lookup covers both because black and white are
      // where they are in every palette this family uses.
      if (index === 0) return [0, 0, 0];
      if (index === 1) return [255, 255, 255];
      const rgba = this.palette.rgba;
      const at = index << 2;
      return [rgba[at], rgba[at + 1], rgba[at + 2]];
    });
  }

  /**
   * Reads a View from the Volume and decodes it, for the between-cycle loader.
   *
   * The synchronous `view` below can only answer for a View already read, which
   * is the whole of what ADR 0021's streaming costs the render path.
   */
  private async loadView(number: number): Promise<void> {
    if (this.views.has(number)) return;
    const bytes = await this.resources.read('view', number);
    if (!bytes) {
      this.log(`A screen item asked for View ${number}, which this game does not have.`);
      return;
    }
    try {
      const decoded = readSciView(bytes);
      this.views.set(number, decoded);
      this.applyViewPalette(number, bytes, decoded);
    } catch (error) {
      this.log(`View ${number} could not be decoded: ${String(error)}`);
    }
  }

  /**
   * A View's own palette, which is where its colours are.
   *
   * **A SCI View carries the colours it was drawn in, and until this was done
   * every SCI32 View drew in whatever the last Picture happened to leave in the
   * palette.** King's Quest VII's title is the clean demonstration: its three
   * cels are painted in indices 200 to 250, its cloud backdrop defines none of
   * them, and the title drew as three solid black rectangles over the sky.
   *
   * Merged rather than replacing, which is Sierra's own arrangement — a
   * palette resource names a start index and a count and writes only those, so
   * a View's colours land beside the room's instead of on top of them.
   *
   * Views already loaded keep their colours: this runs once per View, at
   * decode, and not on every screen item that names it.
   */
  private applyViewPalette(number: number, bytes: Uint8Array, decoded: SciViewResource): void {
    const at = decoded.paletteOffset;
    if (!at || at <= 0 || at >= bytes.length) return;
    const entries = readSciPalette(bytes, at);
    if (entries.length === 0) return;
    applySciPalette(this.palette, entries);
    this.viewPalettes.add(number);
  }

  /** Views whose palette has been merged, for the diagnostic to count. */
  private readonly viewPalettes = new Set<number>();

  /** A View, decoded once and kept. */
  private view(number: number): SciViewResource | null {
    const cached = this.views.get(number);
    if (cached) return cached;
    const bytes = this.resources.peek('view', number);
    if (!bytes) return null;
    const decoded = readSciView(bytes);
    this.views.set(number, decoded);
    this.applyViewPalette(number, bytes, decoded);
    return decoded;
  }

  private cel(
    view: number,
    loop: number,
    cel: number,
  ): ReturnType<typeof readSciView>['loops'][number]['cels'][number] | null {
    const decoded = this.view(view);
    if (!decoded) return null;
    return decoded.loops[loop]?.cels[cel] ?? null;
  }

  /**
   * A palette resource as 256 entries, indexed by colour number.
   *
   * `PalVary` blends entry against entry, so a sparse resource has to become a
   * dense array first — a palette that names only the colours it changes would
   * otherwise fade the wrong ones.
   */
  private paletteEntriesOf(resource: number): SciPalVaryColour[] | null {
    const bytes = this.resources.peek('palette', resource);
    if (!bytes) return null;
    const entries = readSciPalette(bytes, 0);
    if (entries.length === 0) return null;

    const dense = this.currentPaletteColours();
    for (const entry of entries) {
      if (entry.index >= 0 && entry.index < dense.length) {
        dense[entry.index] = { r: entry.r, g: entry.g, b: entry.b };
      }
    }
    return dense;
  }

  /** The palette as it stands, which a fade starts from. */
  private currentPaletteColours(): SciPalVaryColour[] {
    return Array.from({ length: 256 }, (_unused, index) => {
      const [r, g, b] = this.palette.getColor(index);
      return { r, g, b };
    });
  }

  /**
   * Rotates one palette band by a step, which is all `PalCycle` ever does.
   *
   * Sierra's cycling is a palette write and nothing else — the framebuffer is
   * untouched and the colours under it change — so this is the whole effect
   * rather than an approximation of it. What is missing is the clock: a game
   * that sets a cycle and expects it to run on its own gets a still one.
   */
  private stepPalCycle(from: number, by: number): void {
    const cycle = this.palCycles.get(from);
    if (!cycle || !cycle.on) return;
    const span = cycle.to - from + 1;
    if (span <= 1) return;

    cycle.at = (((cycle.at + (by || cycle.direction || 1)) % span) + span) % span;
    const colours = Array.from({ length: span }, (_unused, index) =>
      this.palette.getColor(from + index),
    );
    for (let index = 0; index < span; index++) {
      const source = colours[(index + cycle.at) % span]!;
      this.palette.setColor(from + index, source[0], source[1], source[2]);
    }
  }

  /**
   * Steps a running `PalVary` and puts the blend on the palette.
   *
   * Once a cycle, because that is the clock this engine has: Sierra drove it
   * from a timer, and the tick count a script gives is in sixtieths, so a fade
   * here lasts as many cycles as it would have ticks.
   */
  private advancePalVary(): void {
    if (!this.palVary.advance()) return;
    for (let index = 0; index < this.palVary.length; index++) {
      const colour = this.palVary.colourAt(index);
      if (colour) this.palette.setColor(index, colour.r, colour.g, colour.b);
    }
  }

  /** The Kernel's view of the engine, built per call so nothing goes stale. */
  /**
   * The Kernel's view of the engine, built once.
   *
   * Once rather than per call for two reasons: a Kernel call happens inside a
   * send and allocating an object there is a cost on the hottest path in the
   * interpreter, and a handler that needs to remember something between calls —
   * `PlayVMD` opens a file in one sub-function and plays it in another — needs
   * the world it is handed to be the same world next time.
   */
  private cachedWorld: SciKernelWorld | null = null;

  private world(): SciKernelWorld {
    if (this.cachedWorld) return this.cachedWorld;
    this.cachedWorld = {
      machine: this.machine,
      heap: this.heap,
      input: this.input,
      sound: this.sound,
      scriptExport: (script, index) => {
        const loaded = this.scripts.get(script);
        if (!loaded) {
          // Loading is async and a Kernel call is not, so a script the game
          // has not reached yet cannot be fetched here. Reported rather than
          // answered with null: "the game asked for a script that is not
          // loaded" is actionable, and a null reference is a halt several
          // sends later with nothing pointing back to here.
          this.pendingScripts.add(script);
          return null;
        }
        const offset = loaded.exports[index];
        return offset === undefined ? null : reg(script, offset);
      },
      // **A free-running clock, not the frame counter.** `kGetTime` returns
      // the system tick count at 60 a second, and a SCI script may busy-wait on
      // it: "read the time, compare, read again". The frame counter cannot
      // change *inside* a cycle, so such a loop never ends — Mixed Up Fairy
      // Tales called `GetTime` 98,817 times in thirty cycles, burning its whole
      // instruction budget every one of them and never advancing.
      //
      // Sierra's interpreter read a clock that moved while the script looked at
      // it, and this does the same. It makes the engine's timing wall-clock
      // rather than frame-locked, which is what the games were written against.
      ticks: () => this.ticks(),
      drawPicture: (number) => this.drawPicture(number),
      farText: (resource, index) => this.farText(resource, index),
      openWindow: (rect, title, style, colours) => this.openWindow(rect, title, style, colours),
      closeWindow: (id) => this.closeWindow(id),
      setPort: (id) => {
        this.currentPort = id;
      },
      getPort: () => this.currentPort,
      setCursor: (number, visible) => this.setCursor(number, visible),
      setViewCursor: (view, loop, cel, x, y) => this.setViewCursor(view, loop, cel, x, y),
      message: (module, key) => this.message(module, key),
      messageRecord: (module, key) => this.messageRecord(module, key),
      // `back` of -1: a Plane showing a Picture states no fill colour, and the
      // one place a colour matters here is recorded rather than painted.
      setPlanePicture: (id, picture) => this.changePlanePicture(id, picture, -1),
      files: this.files,
      messageModules: () => this.resources.list('message'),
      highestPlanePriority: () =>
        [...this.gamePlanes.values()].reduce((top, plane) => Math.max(top, plane.priority), 0),
      highestItemPriority: (planeName) => {
        const plane = this.gamePlanes.get(planeName);
        // Read off the items rather than kept as a field: a Plane's top
        // priority is whatever is on it now, and a remembered one goes stale
        // the moment an item is removed.
        return plane ? plane.items.reduce((top, item) => Math.max(top, item.priority), 0) : 0;
      },
      bitmapCreate: (width, height, skip, back) => this.bitmaps.create(width, height, skip, back),
      bitmapDestroy: (handle) => this.bitmaps.destroy(handle),
      bitmapFill: (handle, left, top, right, bottom, colour) =>
        this.bitmaps.fill(handle, left, top, right, bottom, colour),
      bitmapSetOrigin: (handle, x, y) => this.bitmaps.setOrigin(handle, x, y),
      bitmapSize: (handle) => {
        const bitmap = this.bitmaps.get(handle);
        return bitmap ? { width: bitmap.width, height: bitmap.height } : null;
      },
      bitmapDrawText: (handle, text, options) => {
        const font = this.font(options.font);
        if (!font) return;
        this.bitmaps.drawText(handle, font, text, {
          x: options.x,
          y: options.y,
          colour: options.colour,
          background: options.background,
          maxWidth: options.maxWidth,
        });
      },
      textBitmap: (request) => {
        const font = this.font(request.font);
        if (!font) {
          // Said rather than silently answering nought: a text bitmap with no
          // font is a menu with no words, and the reason is worth knowing.
          this.log(
            `A text bitmap wanted font ${request.font}, which this game's resources do not ` +
              `hold — so the words "${request.text.slice(0, 40)}" cannot be drawn.`,
          );
          return 0;
        }
        // Sized from the text where the script did not say, which is what a
        // script asking for sub 1 expects.
        const measured = measureSciText(font, request.text, request.width);
        const width = request.width || measured.width;
        const height = request.height || measured.height;

        const handle = this.bitmaps.create(width, height, request.skip, request.back);
        this.bitmaps.drawText(handle, font, request.text, {
          x: 0,
          y: 0,
          colour: request.fore,
          background: request.back === request.skip ? null : request.back,
          maxWidth: width,
        });
        return handle;
      },
      saveGame: (slot, description) => {
        // The game's own menu, through the same capture the editor's overlay
        // uses. Kept in memory beside the session rather than written anywhere:
        // the host owns where a save lives, and a game that saves and restores
        // within a session is what the scripts actually exercise.
        try {
          this.gameSaves.set(slot, this.saveState(description || `slot ${slot}`));
          return true;
        } catch (error) {
          this.log(
            `The game asked to save into slot ${slot} and it could not be captured: ${String(error)}`,
          );
          return false;
        }
      },
      restoreGame: (slot) => {
        const saved = this.gameSaves.get(slot);
        if (!saved) {
          this.log(`The game asked to restore slot ${slot}, which holds nothing this session.`);
          return false;
        }
        // **Between cycles, not here.** This call is inside a send, and the
        // frames above it belong to a state that is about to stop existing —
        // restoring underneath them returns into a method of an object the
        // restore has replaced.
        this.pendingRestore = saved;
        return true;
      },
      palCycle: (what, from, to, extra) => {
        if (what === 'set') this.palCycles.set(from, { to, direction: extra, at: 0, on: true });
        else if (what === 'step') this.stepPalCycle(from, extra);
        else {
          const cycle = this.palCycles.get(from);
          if (cycle) cycle.on = what === 'on';
        }
      },
      remapColors: (sub, values) => {
        this.remaps.push({ sub, values: [...values] });
      },
      parseInput: (line) => this.parseInput(line),
      gameObject: () => this.gameObjectRef,
      syncSteps: (number) => this.syncSteps(number),
      measureText: (text, font, maxWidth) => {
        const loaded = this.font(font);
        return loaded ? measureSciText(loaded, text, maxWidth) : null;
      },
      showText: (text, options) => this.showText(text, options),
      showControl: (control) => this.showControl(control),
      screenItemHit: (id, x, y, checkPixel) => this.screenItemHit(id, x, y, checkPixel),
      deferNowSeen: (object, view) => {
        if (view > 0 && !this.views.has(view)) this.pendingViews.add(view);
        this.pendingNowSeen.set(`${object.segment}:${object.offset}`, object);
      },
      addPlane: (id, rect, priority, picture, back) =>
        this.addPlane(id, rect, priority, picture, back),
      deletePlane: (id) => this.deletePlane(id),
      planeOrigin: (id) => this.planeScriptRects.get(id) ?? null,
      addPicAt: (id, picture, x, y, _mirrorX, deleteDuplicate) =>
        this.addPicAt(id, picture, x, y, deleteDuplicate),
      addScreenItem: (id, plane, item) => this.addScreenItem(id, plane, item),
      deleteScreenItem: (id) => this.deleteScreenItem(id),
      frameOut: () => {
        this.framedOut = true;
      },
      setTextColours: (colours) => {
        this.textColours = [...colours];
      },
      setTextFonts: (fonts) => {
        this.textFonts = [...fonts];
      },
      celRect: (view, loop, cel, x, y, z) => {
        const found = this.cel(view, loop, cel);
        if (!found) return null;

        // **SCI32 measures a `nsRect` differently, and `z` is not in it.**
        //
        // `ScreenItem::getNowSeenRect` (`screen_item32.cpp`) takes the cel's
        // own rectangle, scales it out of the cel's resolution and into the
        // script's, and translates it by the position less the origin. There is
        // no baseline and no elevation: SCI32 uses `z` for priority, so
        // subtracting it — which is right for SCI16, where `z` is a height
        // above the floor — puts the rectangle wherever the priority happens to
        // be.
        //
        // King's Quest VII's chapter-select digits are what that cost. Each
        // sets `z` to 1000 to order itself, so its `nsRect` came out at
        // y −929 to −893 while the digit was drawn at y 81. Their own `onMe` is
        // a bounding-box test against those four words — not the Kernel call —
        // so all six answered "not on me" to every click, sixty thousand polls
        // a second, and the panel could be read and never used.
        if (this.resources.isSci32) {
          return sci32NowSeenRect(found, this.celResolution(view), this.resolution.script, x, y);
        }

        // `GfxView::getCelRect` (`view.cpp`). The `+ 1` and the halved width
        // are Sierra's: an actor's position is the middle of its feet, not the
        // corner of its box.
        const left = x + found.displaceX - (found.width >> 1);
        // SCI0 early puts the baseline one pixel higher than every later
        // Version does (`_adjustForSci0Early`), and a cel rectangle off by one
        // is a click that misses along one edge.
        const bottom = y + found.displaceY - z + 1 + (this.game.version === 'sci0-early' ? -1 : 0);
        return { left, top: bottom - found.height, right: left + found.width, bottom };
      },
      celSkipAt: (view, loop, cel, x, y) => {
        const found = this.cel(view, loop, cel);
        if (!found) return null;
        // Clamped into the cel rather than refused, which is Sierra's
        // (`compare.cpp:197`).
        const atX = Math.min(Math.max(x, 0), found.width - 1);
        const atY = Math.min(Math.max(y, 0), found.height - 1);
        return found.pixels[atY * found.width + atX] === found.clearKey;
      },
      moveCursor: (x, y) => {
        this.input.mouseX = x;
        this.input.mouseY = y;
      },
      palVary: {
        init: (resource, ticks, stepStop, direction) => {
          const target = this.paletteEntriesOf(resource);
          if (!target) return false;
          return this.palVary.init(
            resource,
            this.currentPaletteColours(),
            target,
            ticks,
            stepStop,
            direction,
          );
        },
        reverse: (ticks, stepStop, direction) => this.palVary.reverse(ticks, stepStop, direction),
        currentStep: () => this.palVary.currentStep,
        deinit: () => this.palVary.deinit(),
        changeTarget: (resource) => {
          const target = this.paletteEntriesOf(resource);
          return target ? this.palVary.changeTarget(resource, target) : this.palVary.currentStep;
        },
        changeTicks: (ticks) => this.palVary.changeTicks(ticks),
        pause: (paused) => this.palVary.pause(paused),
      },
      assertPalette: (number) => {
        const bytes = this.resources.peek('palette', number);
        if (!bytes) return;
        const entries = readSciPalette(bytes, 0);
        if (entries.length > 0) applySciPalette(this.palette, entries);
      },
      resourcePresent: (type, number) => {
        const name = SCI_RESOURCE_TYPES[type];
        return name !== undefined && this.resources.has(name, number);
      },
      drawCast: (cast) => this.drawCast(cast),
      pictureValid: () => this.picValid,
      setPictureValid: (valid) => {
        this.picValid = valid;
      },
      // **The argument is the object, not a View number.** `kNumLoops` and
      // `kNumCels` read the `view` selector off the object they are handed —
      // and `kNumCels` reads `loop` as well, because a View's loops do not all
      // hold the same number of cels. Both of those were missing here: the
      // object's own heap offset was being used as a View number, so no View
      // was ever found and both answered their fallback of one.
      //
      // One is not a harmless fallback. `Cycle::init` sets `lastCel` from this,
      // and `CT::init` clamps the cel it was asked to stop at down to `lastCel`
      // — so a script asking to cycle to cel 11 was given a target of nought,
      // the cel counted upwards past it forever, and the `cue` at the end of
      // the cycle never came. In King's Quest VII that hangs `deathByGila` at
      // its first state, which holds the room's script, which stops the room
      // answering anything at all.
      viewLoopCount: (object) => this.viewOf(object)?.loops.length ?? 1,
      viewCelCount: (object) => {
        const view = this.viewOf(object);
        if (!view) return 1;
        const loop = this.selectorValue(object, 'loop') ?? 0;
        return view.loops[loop]?.cels.length ?? view.loops[0]?.cels.length ?? 1;
      },
      celOrigin: (view, loop, cel) => {
        const one = this.cel(view, loop, cel);
        return one ? { x: one.displaceX, y: one.displaceY } : null;
      },
      celPixel: (view, loop, cel, x, y) => {
        const one = this.cel(view, loop, cel);
        if (!one || x < 0 || y < 0 || x >= one.width || y >= one.height) return null;
        return one.pixels[y * one.width + x] ?? one.clearKey;
      },
      celSize: (args) => {
        const cel = this.cel(args[0]?.offset ?? 0, args[1]?.offset ?? 0, args[2]?.offset ?? 0);
        return cel ? { width: cel.width, height: cel.height } : null;
      },
      random: () => Math.random(),
      log: (message) => this.log(message),
      playMovie: (request) => {
        this.movies.play(request);
      },
      closeMovie: () => this.movies.close(),
      movieStatus: () => ({ playing: this.movies.busy, frame: this.movies.frameNumber }),
      openRobot: (robot, plane, priority, x, y) => this.openRobot(robot, plane, priority, x, y),
      robotStatus: () => this.robotStatus(),
      closeRobot: () => this.closeRobot(),
    };
    return this.cachedWorld;
  }

  /**
   * Scripts a Kernel call asked for that were not loaded.
   *
   * SCI loads lazily and a Kernel call cannot await, so the engine loads these
   * between cycles — which is the arrangement ADR 0021's streaming forces on
   * this family, and it is why `step` is not simply `machine.run`.
   */
  private readonly pendingScripts = new Set<number>();

  /**
   * What a Kernel number means, preferring the table the *game* ships.
   *
   * **The game's own `vocab.999` wins, and this had it the other way round.**
   * `CONTEXT.md` says the Kernel table "lives in Sierra's interpreter rather
   * than in the game from SCI1 on" — which is exactly the point: below SCI1 the
   * game carries it, and where a game carries a fact about itself this project
   * believes the game (ADR 0020's rule, one layer down).
   *
   * It was not a tie-break nobody would notice. Checked against the demos that
   * ship a `vocab.999`, this project's SCI16 table diverges from King's Quest
   * IV's and the Christmas Card 1988's **from index 41 onward** — 72 of 113
   * entries differ. The games say 41 is `FOpen`, 42 `FPuts`, 43 `FGets`, 44
   * `FClose`; this table says `SaveGame`, `RestoreGame`, `RestartGame`,
   * `GameIsRestarting`. Four file-handling entries are missing from ours and
   * everything after them is shifted by four.
   *
   * That is SCI's characteristic failure exactly as `CONTEXT.md` describes it —
   * "a table off by one entry produces a game that runs and does the wrong
   * things" — and it was off by four for every SCI0 and SCI01 game.
   *
   * Island of Dr. Brain, at SCI1.1, matches on 123 of 128, differing only where
   * its own table says `Dummy`. So this changes SCI16's dispatch and leaves the
   * later Versions where they were.
   */
  private kernelNameFor(number: number): string | undefined {
    const shipped = this.kernelNames[number];
    // A game's own table may name a slot `Dummy`, which is the game saying the
    // slot is unused rather than naming a call — fall through to ours there.
    if (shipped && shipped !== 'Dummy') return shipped;
    return kernelNamesFor(this.game.version)[number];
  }

  /**
   * Reads the tables a SCI game ships inside itself.
   *
   * `vocab.997` names the Selectors and `vocab.996` lists the classes, and both
   * being in the game is the whole reason a SCI Target is smaller than an AGI
   * one (ADR 0016). `vocab.999` names the Kernel calls where a game carries it,
   * which is what lets an unimplemented one be reported by name.
   *
   * A game shipping none of them is not an error — several demos ship no
   * `vocab.997` at all — but it is worth saying, because it means every report
   * about a Selector afterwards is a number rather than a name.
   */
  private async loadTables(): Promise<void> {
    const selectors = await this.resources.read('vocab', 997);
    // A game shipping heap resources numbers its Selectors SCI1.1's way, three
    // lower than SCI16's. Only used when the game ships no table of its own.
    const chosen = selectorTableFor(selectors ?? null, {
      heapSplit: this.resources.count('heap') > 0,
      sci32: this.resources.isSci32,
      // SCI0 early spends the low bit of a Selector ID on a read/write flag,
      // so its numbering is doubled and a 255-entry table answers to 510
      // numbers. Without this King's Quest IV's game object answers no `play`.
      lsbToggle: selectorIdCarriesReadWriteBit(this.game.version),
    });
    this.selectors = chosen.table;
    this.selectorsFromGame = chosen.fromGame;
    if (!chosen.fromGame) {
      this.log(
        `This game ships no vocab.997, so Sierra's own SCI16 numbering is being used. Every ` +
          `Selector name in a report about this game comes from that table rather than from the ` +
          `game itself — which is a guess in the same sense ADR 0013 means, and is why this ` +
          `line exists.`,
      );
    }

    const kernel = await this.resources.read('vocab', 999);
    if (kernel) this.kernelNames = readKernelVocab(kernel);

    const classes = await this.resources.read('vocab', 996);
    if (classes) this.classTable = readClassTable(classes);

    this.machine.selectorNumbers = this.selectors.numbers;
    this.machine.classScripts = new Map(
      this.classTable.map((entry, number) => [number, entry.script]),
    );
  }

  /** Class number to the Script resource that defines it. */
  classTable: ReturnType<typeof readClassTable> = [];

  /**
   * Starts the game, which SCI does in two steps and not one.
   *
   * **Export 0 of script 0 is the game object, not code.** Sierra's own
   * interpreter resolves it with `ScriptID(0, 0)` and then *sends* `play` to
   * whatever comes back; there is no engine-side main loop that decides what
   * happens, because a SCI game's own scripts are the main loop.
   *
   * Entering export 0 as though it were a method is what this did first, and
   * the trace said so immediately: King's Quest IV decoded `ldi 13312` followed
   * by three `bnot` in a row, which is an object's property table read as
   * instructions. A decoder that produces plausible-looking instructions from
   * data is the reason ADR 0017 insists boundaries are derived rather than
   * guessed, and it is why the trace hook exists before there is anything to
   * compare it against.
   */
  async start(script = 0): Promise<void> {
    const loaded = await this.scripts.load(script);
    if (!loaded) {
      this.log(`Script ${script} is not in this game, so there is nothing to start.`);
      return;
    }

    // **Every script, up front, for a SCI16 game.**
    //
    // Not laziness avoided for its own sake: `ScriptID` is a Kernel call and a
    // Kernel call cannot await, so a script the game asks for mid-send either
    // is already loaded or is not there. SCI's own interpreter loaded
    // synchronously from a file it had open; this cannot, so it loads
    // everything before the first send instead — and every "send to 0:0"
    // this engine produced was a `ScriptID` for a script that was one cycle
    // away from arriving.
    //
    // It is affordable exactly where it is needed, and **"only the classes" was
    // too few**. A SCI32 game's scripts were preloaded from the class table on
    // the ground that ADR 0021's whole point is that a seven-disc game is not
    // held — but a class table names the scripts that *define classes*, not the
    // scripts a game asks for. King's Quest VII loaded 98 of its 218 that way
    // and halted on its first send: `Game::play` asked `ScriptID` for one of the
    // other 120, was handed nought because the Kernel cannot await, and sent
    // `doit` to it.
    //
    // **Scripts are not what ADR 0021 is about.** King's Quest VII is 3,112
    // resources, of which 1,527 are Views and 890 are sounds — those are the
    // megabytes, and they still stream. Its 218 scripts are a few kilobytes
    // each. So every script is read up front at every Version now, and the cost
    // is reported rather than assumed: the log says how many and how large, so
    // the next game to be pointed at this says whether the trade still holds.
    const all = this.resources.list('script');
    let scriptBytes = 0;
    for (const number of all) {
      if (number === script) continue;
      await this.scripts.load(number);
      // Measured from the loaded script rather than from the resource cache:
      // `SciScripts` keeps what it decoded and the cache is free to drop the
      // bytes behind it, which is why this reported 0KB on a game that had just
      // read 218 of them.
      scriptBytes += this.scripts.get(number)?.code.length ?? 0;
    }
    this.log(
      `Read all ${all.length} scripts up front (${Math.round(scriptBytes / 1024)}KB), because ` +
        `ScriptID is a Kernel call and cannot await one that is still arriving.`,
    );

    // Now that every class is in, turn each object's `-super-` from the class
    // number the file holds into the class it names. A script that walks a
    // class chain sends to that property, and an integer there is a send to an
    // integer several layers later (`resolveSuperClasses`).
    const resolved = this.machine.resolveSuperClasses();
    if (resolved > 0) {
      this.log(`Resolved ${resolved} superclass properties from class numbers to classes.`);
    }
    // Pictures and Views as well, for the same reason and with the same
    // limit: `DrawPic` is a Kernel call and cannot await either. A SCI16
    // game's artwork is a megabyte or two; a SCI32 game's is not, and it is
    // left to stream.
    const artwork: Array<[SciResourceType, number]> = [];
    if (!this.resources.isSci32) {
      for (const number of this.resources.list('pic')) artwork.push(['pic', number]);
      for (const number of this.resources.list('view')) artwork.push(['view', number]);
      for (const number of this.resources.list('cursor')) artwork.push(['cursor', number]);
      // And the `MESSAGE` resources, for the same reason a third time:
      // `kMessage` happens in the middle of a send and cannot await either. A
      // SCI1.1 game's text is tens of kilobytes, and a game whose Message
      // reports itself rather than answering never closes the window it opened
      // and so never advances.
      for (const number of this.resources.list('message')) artwork.push(['message', number]);
    }

    // **The small resources are read up front whatever the Version is**, and
    // the line above used to enclose these too. Streaming is right for artwork
    // — a SCI32 game's Pictures and Views are hundreds of megabytes and the
    // whole of ADR 0021 — and wrong for everything a Kernel call needs *while
    // it is running*, because a Kernel call cannot await whatever the Version.
    //
    // King's Quest VII is where that showed. It ships ten fonts including 999,
    // and every text bitmap it tried to build was told "font 999 is not in this
    // game, so font 0 is being used instead" — a message that was wrong twice
    // over: the game has font 999, and font 0 had not been read either. Worse,
    // the substitute was **cached**, so the font never recovered once it did
    // arrive. Ten fonts is a few kilobytes; the reason to stream them was never
    // size.
    {
      // And `text`, which is where a SCI0 game keeps its dialogue: `Display`
      // and `GetFarText` are handed a resource number in the middle of a send
      // and cannot await either.
      for (const number of this.resources.list('text')) artwork.push(['text', number]);
      // **And the fonts.** `TextSize` measures with one in the middle of a
      // send, and a font that is not already read makes it answer nothing —
      // which does not make text invisible, it makes every window nought by
      // nought. King's Quest IV asks for fonts 1 and 4, has both, and got
      // neither: `peek` found nothing because nothing had loaded them, the
      // fallback to font 0 found nothing for the same reason, and the size the
      // script sized its dialog from was null.
      for (const number of this.resources.list('font')) artwork.push(['font', number]);
      // A SCI32 game's Messages are small too and `kMessage` cannot await
      // either — King's Quest VII's 76 modules are 200KB between them.
      if (this.resources.isSci32) {
        for (const number of this.resources.list('message')) artwork.push(['message', number]);
      }
      // **And `vocab.000`, which is the parser's whole dictionary.** `Parse` is
      // a Kernel call in the middle of a send and cannot await either, and a
      // SCI0 game whose vocabulary is one cycle away answers "I don't know that
      // word" to every word in it.
      if (this.resources.list('vocab').includes(SCI0_MAIN_VOCABULARY)) {
        artwork.push(['vocab', SCI0_MAIN_VOCABULARY]);
      }
      await this.resources.preload(artwork);
    }

    this.log(
      `Loaded ${this.scripts.loadedScripts().length} of ${all.length} scripts before the first ` +
        `send, because ScriptID is a Kernel call and cannot await.`,
    );

    const entry = loaded.exports[0];
    if (entry === undefined) {
      this.log(`Script ${script} exports nothing, so there is no entry point.`);
      return;
    }

    const gameObject = this.machine.object(reg(script, entry));
    if (!gameObject) {
      this.log(
        `Export 0 of script ${script} points at ${entry}, where this engine found no object. ` +
          `SCI's own boot resolves that export to the game object and sends "play" to it, so ` +
          `without an object there is nothing to send to.`,
      );
      return;
    }

    const play = this.selectors.numbers.get('play');
    if (play === undefined) {
      this.log(
        `This game's Selector table has no "play", so the game object cannot be started. ` +
          `Every SCI game's boot is a send of that Selector.`,
      );
      return;
    }

    const method = this.machine.resolveMethod(gameObject, play);
    if (!method) {
      this.log(`The game object answers no "play" method, on itself or on any of its classes.`);
      return;
    }
    this.log(
      `Starting: sending "play" to the game object at ${script}:${entry}, whose method is in ` +
        `script ${method.object.script} at ${method.offset}.`,
    );
    // Kept because `Parse` reports a word it did not know *to the game* rather
    // than printing one itself, and the send it makes is to this object.
    this.gameObjectRef = gameObject.id;
    this.machine.enter(method.object.script, method.offset, gameObject.id);
  }

  /** The Target, which is what selects an Engine, an encoding and an assembler. */
  get target(): Target {
    return {
      engine: 'sci',
      version: this.game.version,
      platform: this.game.platform,
      identification: this.game.identification,
    };
  }

  get gameId(): string {
    return this.game.id;
  }

  get targetName(): string {
    return describeSciVersion(this.game.version);
  }

  get frame(): number {
    return this.frameCounter;
  }

  get currentRoom(): number {
    return this.room;
  }

  get hasQuit(): boolean {
    return this.quit;
  }

  /**
   * SCI's own cadence.
   *
   * Sierra's interpreter ran its animation cycle at sixty ticks a second and
   * the scripts set their own delays inside that, unlike SCUMM where a variable
   * asks the interpreter to slow down. So this is one and stays one.
   */
  readonly ticksPerStep = 1;

  boot(): void {
    this.log(`Booting ${describeSciVersion(this.game.version)} "${this.game.id}"`);
    void this.start();
  }

  /**
   * One animation cycle.
   *
   * The budget is what stops a script that never returns from freezing the tab
   * — SCI has no `breakHere`, so a runaway loop is indistinguishable from a
   * long computation until the frame is late.
   */
  step(): void {
    this.frameCounter++;
    // **A video blocks the interpreter, because Sierra's did.** `kShowMovie`
    // and `kPlayVMD`'s play sub-function do not return until the video is over
    // or skipped, so a script assumes the world is exactly as it left it.
    // Running cycles underneath would advance actors, timers and rooms behind
    // a full-screen picture.
    if (this.movies.busy) {
      void this.pumpVideo();
      return;
    }
    // The restore the game asked for last cycle, before anything else runs:
    // every frame from the old state is gone by the time this returns.
    if (this.pendingRestore) {
      const saved = this.pendingRestore;
      this.pendingRestore = null;
      try {
        this.loadState(saved);
        this.log(`Restored the save the game asked for, between cycles.`);
      } catch (error) {
        this.log(`The restore the game asked for could not be applied: ${String(error)}`);
      }
    }

    // **One cycle ends at the game's own frame, not at the budget.** SCI's main
    // loop never returns, so a fixed instruction budget runs however many of
    // the game's frames happen to fit inside it — 206 of them for King's Quest
    // VII, which is why one animation cycle took a tenth of a second and the
    // first room was reported as lagging. `kFrameOut` is where Sierra's own
    // frame ends, and it is where this one ends now. The budget stays, as the
    // runaway guard it always was.
    this.framedOut = false;
    this.machine.run(20000, () => this.framedOut);
    // After the scripts have run rather than before: a cycle that starts a fade
    // should show its first step on the frame the script asked for it, not the
    // one after.
    this.advancePalVary();
    void this.loadPending();
  }

  /**
   * Advances the video or the Robot, between cycles.
   *
   * Between rather than during, for `loadPending`'s reason: reading the next
   * frame of a VMD is a Volume read and a Kernel call is not asynchronous.
   */
  private async pumpVideo(): Promise<void> {
    await this.movies.pump(this.ticks());
    if (this.movies.frameNumber === 0) this.movies.applyOpeningPalette(this.palette);
  }

  /**
   * The engine's clock in ticks, which is **this engine's own cycle count**.
   *
   * SCI's tick is a sixtieth of a second and `ticksPerStep` is one, so a cycle
   * *is* a tick — Sierra's interpreter counted them in its own loop and so does
   * this one. Reading the wall clock instead is right only while something
   * paces the loop to real time, and in the browser something does.
   *
   * **Headless, nothing does, and the two run at completely different rates.**
   * A `vite-node` driver steps as fast as the CPU allows: the same 480 cycles
   * spanned about thirty seconds of game time on a loaded machine and about
   * three on an idle one, so a game that waits two seconds for its room to
   * settle had settled in one run and had not in the other. That is not a
   * flaky probe, it is a clock that measures the machine rather than the game
   * — and it made every headless reading unreproducible, this branch's own
   * walk probe included, which walked until the machine got quieter and then
   * stopped.
   *
   * Counting cycles makes a headless run **deterministic**: the same script
   * reaches the same game time on any machine, which is what every command in
   * `docs/processes/verifying-version-support.md` needs to mean anything. The
   * browser is unaffected, because there a cycle already takes a sixtieth of a
   * second.
   */
  private ticks(): number {
    return this.frameCounter;
  }

  /**
   * Opens a Robot and puts its frames on a Plane.
   *
   * Queued rather than opened, like a script and like a video, because opening
   * reads a Volume. The Robot's own file naming is Sierra's: the number the
   * script passed, and `.rbt`.
   */
  private openRobot(robot: number, plane: string, priority: number, x: number, y: number): void {
    this.pendingRobot = { robot, plane, priority, x, y };
  }

  private robotStatus(): { open: boolean; finished: boolean; frame: number } {
    return {
      open: this.robot !== null || this.pendingRobot !== null,
      finished: this.robot?.finished ?? false,
      frame: this.robot?.frame ?? 0,
    };
  }

  private closeRobot(): void {
    this.clearRobotItems();
    this.robot = null;
    this.pendingRobot = null;
  }

  /** Takes last frame's cels off the Plane, so a Robot does not smear. */
  private clearRobotItems(): void {
    const robot = this.robot;
    if (!robot) return;
    const plane = this.gamePlanes.get(robot.plane) ?? [...this.gamePlanes.values()][0];
    for (const item of robot.items) plane?.remove(item);
    robot.items = [];
  }

  /**
   * One Robot frame onto its Plane, as screen items.
   *
   * **This is the whole of #226's architectural test.** The items handed to
   * `plane.add` are the identical shape `drawCast` builds for an actor, and
   * nothing in `Plane` or `SciCompositor` was touched to make a Robot work. One
   * compositor, as ADR 0015 claims.
   */
  private async advanceRobot(): Promise<void> {
    if (this.pendingRobot) {
      const wanted = this.pendingRobot;
      this.pendingRobot = null;
      const stream = await openSciRobot(this.resources.files, `${wanted.robot}.rbt`);
      if (!stream) {
        this.log(`Robot ${wanted.robot} could not be opened, so nothing is composited for it.`);
        return;
      }
      this.robot = { stream, ...wanted, frame: -1, items: [], finished: false };
    }

    const robot = this.robot;
    if (!robot || robot.finished) return;

    const next = robot.frame + 1;
    if (next >= robot.stream.info.frameCount) {
      robot.finished = true;
      return;
    }
    const frame = await robot.stream.frame(next);
    if (!frame) {
      robot.finished = true;
      return;
    }

    this.clearRobotItems();
    const plane = this.gamePlanes.get(robot.plane) ?? [...this.gamePlanes.values()][0];
    if (plane) {
      for (const item of frameScreenItems(frame, robot.priority, { x: robot.x, y: robot.y })) {
        robot.items.push(plane.add(item));
      }
    }
    robot.frame = next;
  }

  /**
   * Loads the scripts a Kernel call asked for and could not have.
   *
   * Between cycles rather than during one, because reading a SCI32 Volume is
   * asynchronous and a `ScriptID` in the middle of a send is not. A game
   * therefore reaches a script one cycle after asking for it, which is what
   * streaming costs and is invisible at sixty cycles a second.
   */
  private async loadPending(): Promise<void> {
    // A Robot advances every cycle, because it is part of the scene rather
    // than something the scripts wait for.
    if (this.robot || this.pendingRobot) await this.advanceRobot();
    // A Plane's Picture and a screen item's View are both Volume reads a Kernel
    // call could not make, so they are collected during the cycle and done here.
    if (this.pendingPlanePictures.length > 0) {
      const wantedPictures = this.pendingPlanePictures.splice(0);
      for (const { id, picture, at, own } of wantedPictures) {
        const bytes = await this.resources.read('pic', picture);
        if (!bytes) {
          this.log(`Plane ${id} asked for Picture ${picture}, which this game does not have.`);
          continue;
        }
        // Only if the Plane still wants this Picture: a room change between the
        // request and the read would otherwise paint the room the game left.
        // A Picture that `AddPicAt` layered on is not the Plane's own, so it is
        // checked against the Plane still existing and nothing more.
        const plane = this.gamePlanes.get(id);
        if (!plane) continue;
        if (own && plane.pictureId !== picture) continue;
        this.attachPlanePicture(id, picture, bytes, at);
      }
    }

    if (this.pendingViews.size > 0) {
      const wantedViews = [...this.pendingViews];
      this.pendingViews.clear();
      for (const number of wantedViews) await this.loadView(number);

      // Replayed in the order the game asked for them, which is the order they
      // stack on the Plane.
      const deferred = [...this.deferredScreenItems];
      this.deferredScreenItems.clear();
      for (const [id, held] of deferred) this.addScreenItem(id, held.plane, held.item);

      // And the `nsRect`s that could not be measured, asked again now the View
      // they measure is here. Through the Kernel handler rather than a second
      // copy of its arithmetic, so the two cannot disagree about what a cel's
      // rectangle is.
      const nowSeen = [...this.pendingNowSeen.values()];
      this.pendingNowSeen.clear();
      for (const object of nowSeen) SCI_KERNEL.SetNowSeen(this.world(), [object]);
    }

    if (this.pendingMessages.size > 0) {
      const wantedMessages = [...this.pendingMessages];
      this.pendingMessages.clear();
      for (const module of wantedMessages) {
        const bytes = await this.resources.read('message', module);
        if (!bytes) this.missingMessages.add(module);
      }
    }

    if (this.pendingScripts.size === 0) return;
    const wanted = [...this.pendingScripts];
    this.pendingScripts.clear();
    for (const number of wanted) await this.scripts.load(number);
  }

  /**
   * Composites the Planes into the framebuffer, repairing what changed (#225).
   *
   * **Nothing clears the screen here, and that is the point.** A dirty-rect
   * redraw repairs the union of what this frame touches and what the last one
   * did, and leaves every other pixel alone — so clearing first throws away
   * exactly the pixels the redraw is relying on being there and leaves a black
   * screen with only the moving parts on it.
   *
   * That is what a `screen.clear(0)` left here did: Conquests of the Longbow
   * drew its Picture, the first frame repaired the room's bounds onto a cleared
   * screen, and every frame after cleared it again and repaired nothing,
   * because nothing had moved. The compositor clears the regions it is about to
   * repaint, which is the only clearing a dirty redraw may do.
   */
  render(): void {
    this.compositor.compositeDirty(this.screen.pixels, this.screen.width, this.screen.height);
    // Over the top, and only while one is playing: a video is played *at* the
    // screen and has no priority, so it is not a screen item and the
    // compositor has no opinion about it. A Robot is the other case and has
    // already been composited above, as a screen item like any other.
    this.movies.paint(this.screen.pixels, this.screen.width, this.screen.height, this.palette);
  }

  present(context: CanvasRenderingContext2D): void {
    this.screen.present(context, this.palette);
  }

  /**
   * Captures the object graph, which is the game state (ADR 0019).
   *
   * Static objects by their changes and Clones whole, because a Clone has
   * nothing to reload from.
   */
  saveState(name: string): SavedGameEnvelope {
    const state = captureSciState(this.machine, this.heap, (object) =>
      this.originalVariables(object),
    );
    const saved: SciSavedGame = {
      format: SCI_SAVE_FORMAT,
      gameId: this.game.id,
      savedAt: Date.now(),
      name,
      room: this.room,
      ...state,
    };
    return saved;
  }

  /**
   * Refuses rather than half-applying, and refuses on the Target as well as on
   * the game.
   *
   * A SCI save is the game's own object graph. Applying one graph to a
   * different game's objects — or to the same game read at a different Version,
   * whose object *layout* differs — loads a world that looks right and is not
   * the one the scripts hold pointers to.
   */
  loadState(saved: SavedGameEnvelope): void {
    if (saved.gameId !== this.game.id) {
      throw new Error(
        `That save is from "${saved.gameId}" and this is "${this.game.id}". ` +
          `Loading it would restore one game's object graph into another's.`,
      );
    }
    if (saved.format > SCI_SAVE_FORMAT) {
      throw new Error(
        `That save is format ${saved.format} and this engine writes ${SCI_SAVE_FORMAT}. ` +
          `It was written by a newer build than this one.`,
      );
    }

    const state = saved as SciSavedGame;
    if (!Array.isArray(state.clones) || !Array.isArray(state.statics)) {
      throw new Error(
        'That save has no object graph in it, so it is not a SCI save. It is being refused ' +
          'rather than half-applied.',
      );
    }

    restoreSciState(this.machine, this.heap, state);
    this.room = saved.room;
  }

  /**
   * What a static object's script says its properties are.
   *
   * So a save writes only what changed. Read from the loaded script rather than
   * remembered at load, because the Project may have been edited since — and
   * re-applying changes over a *new* layout is what makes a save survive an
   * edit at all.
   */
  private originalVariables(object: {
    script: number;
    id: { offset: number };
  }): readonly Reg[] | null {
    const loaded = this.scripts.get(object.script);
    if (!loaded) return null;
    const found = loaded.objects.find((candidate) => candidate.id.offset === object.id.offset);
    return found ? found.variables : null;
  }

  /**
   * One Message, by module and tuple, for `kMessage`.
   *
   * Synchronous by necessity: a Kernel call happens in the middle of a send and
   * a Volume read does not. So this answers from what has already been read and
   * returns null otherwise, which the handler reports by number rather than
   * turning into an empty line of dialogue.
   *
   * A Message may defer to another by tuple — Sierra's own way of saying "the
   * same thing he said last time" — so a reference is followed once. Once
   * rather than to a fixed point, because a cycle in a shipped game would
   * otherwise be an infinite loop inside a Kernel call.
   */
  /**
   * A module's decoded Messages, loading it once and asking for it if absent.
   *
   * The ask matters: King's Quest VII's menu wants module 0 on its way into a
   * new game and takes silence for an answer, so a null that does not queue the
   * load is a game that never says anything with the module one cycle away.
   */
  private decodedMessages(module: number): SciMessageResource | null {
    const held = this.messages.get(module);
    if (held) return held;
    const bytes = this.resources.peek('message', module);
    if (!bytes) {
      if (!this.missingMessages.has(module)) this.pendingMessages.add(module);
      return null;
    }
    const decoded = readSciMessages(bytes);
    this.messages.set(module, decoded);
    return decoded;
  }

  /**
   * One Message record with its reference intact, for `Message`'s cursor stack.
   *
   * `message` below follows a reference and returns what it points at, which
   * `GetMessage` wants and `Message` must not have: there a reference is a
   * **continuation** the caller walks with repeated `next` calls, so collapsing
   * it here would turn a conversation into its last line.
   */
  private messageRecord(
    module: number,
    key: SciMessageKey,
  ): { text: string; talker: number; reference?: SciMessageKey } | null {
    const decoded = this.decodedMessages(module);
    if (!decoded) return null;
    const found = decoded.messages.find(
      (one) =>
        one.noun === key.noun &&
        one.verb === key.verb &&
        one.cond === key.cond &&
        one.seq === key.seq,
    );
    if (!found) return null;
    return found.reference
      ? { text: found.text, talker: found.talker, reference: found.reference }
      : { text: found.text, talker: found.talker };
  }

  /** A property of an object by Selector name, where both exist. */
  private selectorValue(object: Reg, name: string): number | undefined {
    const held = this.machine.object(object);
    const selector = this.machine.selectorNumbers?.get(name);
    if (!held || selector === undefined) return undefined;
    const index = this.machine.resolveProperty(held, selector);
    return index >= 0 ? held.variables[index]?.offset : undefined;
  }

  /** The View an object says it is showing, by its own `view` Selector. */
  private viewOf(object: Reg) {
    const number = this.selectorValue(object, 'view');
    return number === undefined ? null : this.view(number);
  }

  private message(module: number, key: SciMessageKey): { text: string; talker: number } | null {
    const decoded = this.decodedMessages(module);
    if (!decoded) return null;

    const byKey = new Map(decoded.messages.map((one) => [messageKey(one), one]));
    const found = byKey.get(messageKey(key));
    if (!found) return null;
    if (found.reference) {
      const referred = byKey.get(messageKey(found.reference));
      if (referred) return { text: referred.text, talker: referred.talker };
    }
    return { text: found.text, talker: found.talker };
  }

  /**
   * A `sync36` resource's mouth timing, by the number its Message's tuple gives.
   *
   * The third face of a line of dialogue, found by the *same key* as the text
   * and the recording rather than through a table joining them — which is
   * #221's own phrasing of the criterion and the reason `audio36Number` exists.
   *
   * `peek` rather than `read`, for `message`'s reason: a Kernel call happens in
   * the middle of a send and a Volume read is asynchronous. A resource that is
   * not in hand yet answers null, and `DoSync` then stops the sync rather than
   * driving a mouth from invented timings.
   */
  private syncSteps(number: number): SciSyncStep[] | null {
    const held = this.syncs.get(number);
    if (held !== undefined) return held;
    const bytes = this.resources.peek('sync36', number);
    if (!bytes) return null;
    const steps = readSciSync(bytes);
    this.syncs.set(number, steps);
    return steps;
  }

  /**
   * A font by number, decoded once.
   *
   * Falls back to the lowest-numbered font the game ships when the one asked
   * for is missing, because a game that cannot find its font should draw its
   * text in the wrong face rather than not at all — an interface nobody can
   * read is worse than one that looks wrong, and the log says which happened.
   */
  private font(number: number): SciFontResource | null {
    const cached = this.fonts.get(number);
    if (cached !== undefined) return cached;

    const bytes = this.resources.peek('font', number);
    let decoded = bytes ? readSciFont(bytes) : null;
    if (decoded?.unrecovered) {
      this.log(`Font ${number} could not be read whole: ${decoded.unrecovered}`);
      decoded = null;
    }
    if (!decoded) {
      const fallback = this.resources.list('font')[0];
      if (fallback !== undefined && fallback !== number) {
        // **"Not in this game" and "not read yet" are different facts**, and
        // saying the first when the second is true sent a reader looking for a
        // missing resource that is present. A substitute for a font the game
        // *has* is also not cached: caching it made the substitution permanent,
        // so a font that arrived a cycle later was never used.
        const shipped = this.resources.has('font', number);
        this.log(
          shipped
            ? `Font ${number} is in this game and has not been read yet, so font ${fallback} is ` +
                `standing in for it until it arrives.`
            : `Font ${number} is not in this game, so font ${fallback} is being used instead.`,
        );
        const substitute = this.font(fallback);
        if (!shipped) this.fonts.set(number, substitute);
        return substitute;
      }
    }
    this.fonts.set(number, decoded);
    return decoded;
  }

  /**
   * Draws a string onto the room Plane's background.
   *
   * Onto the background rather than as a screen item, because `Display` is
   * SCI's *immediate* text: it stamps pixels where a script says and the script
   * is responsible for putting them back. A screen item would be repaired away
   * by the next dirty redraw, which is the opposite of what the call means.
   */
  private showText(
    text: string,
    options: { x: number; y: number; font: number; colour: number; width: number },
  ): boolean {
    const plane = this.roomPlane;
    const loaded = this.font(options.font);
    if (!plane?.background || !loaded) return false;

    // Port-relative, for the same reason a control is: `Display` inside a
    // window is measured from the window.
    const origin = this.portOrigin();
    drawSciText(plane.background, plane.bounds.width, plane.bounds.height, loaded, text, {
      x: options.x + origin.x,
      y: options.y + origin.y,
      colour: options.colour,
      // `Display`'s own width attribute, which is what makes a long line wrap
      // inside the box the game drew for it rather than running off the screen.
      ...(options.width > 0 ? { maxWidth: options.width } : {}),
    });
    // No dirty marking is needed: a Plane with a background contributes its
    // whole bounds to the dirty set every frame, so text stamped into it is
    // repainted with the room it was drawn on.
    return true;
  }

  /**
   * The windows a game has open, and which one drawing is measured against.
   *
   * **A SCI16 game's interface is a window and a port, and this had neither.**
   * `kNewWindow` was a two-byte heap block and `GetPort`/`SetPort` were
   * constants, so a window was never painted and every control's rectangle was
   * taken as screen coordinates — which they are not. A control's `nsLeft` and
   * `nsTop` are *port*-relative, and the port is the inside of the window the
   * script just opened, so a dialog's buttons landed in the top-left corner of
   * the room instead of inside a frame that was not there.
   *
   * That is the whole of what stopped King's Quest IV being playable rather
   * than merely running: the game opens a modal at its first screen, runs its
   * dialog loop correctly, and a player saw nothing to answer.
   */
  private readonly windows = new Map<number, SciWindow>();
  private nextWindowId = 1;
  /** The port drawing is measured against; window 0 is the whole screen. */
  private currentPort = 0;

  /** Where the current port's origin sits on screen. */
  private portOrigin(): { x: number; y: number } {
    const window = this.windows.get(this.currentPort);
    return window ? { x: window.contentLeft, y: window.contentTop } : { x: 0, y: 0 };
  }

  /**
   * `kNewWindow` — a frame, a title bar, and a port to draw inside.
   *
   * The rect Sierra passes is the window's *outer* bounds in screen
   * coordinates, and the port is what is left after the frame and the title
   * bar: one pixel of border, and ten rows of title where the style asks for
   * one. Everything the script draws afterwards is measured from there.
   *
   * Drawn as a screen item for the reason a control is — a SCI1.1 room's Plane
   * carries no background buffer at all, so a window painted into the
   * background would be painted into nothing for exactly the Versions whose
   * interface this exists to show.
   */
  private openWindow(
    rect: { top: number; left: number; bottom: number; right: number },
    title: string,
    style: number,
    colours: { pen: number; back: number },
  ): number {
    const plane = this.roomPlane;
    const id = this.nextWindowId++;
    const width = Math.max(1, Math.min(SCI_PICTURE_WIDTH, rect.right - rect.left));
    const height = Math.max(1, Math.min(this.screen.height, rect.bottom - rect.top));
    const titled = (style & WINDOW_STYLE_TITLE) !== 0 && title !== '';
    const framed = (style & WINDOW_STYLE_NOFRAME) === 0;
    const titleHeight = titled ? WINDOW_TITLE_HEIGHT : 0;
    const border = framed ? 1 : 0;

    const window: SciWindow = {
      id,
      left: rect.left,
      top: rect.top,
      contentLeft: rect.left + border,
      contentTop: rect.top + border + titleHeight,
      item: null,
    };
    this.windows.set(id, window);
    this.currentPort = id;

    // A transparent window paints nothing and is only a port, which is what
    // the style bit means and is how a game draws over the room without a box.
    if (plane && (style & WINDOW_STYLE_TRANSPARENT) === 0) {
      const pixels = new Uint8Array(width * height).fill(colours.back);
      const put = (x: number, y: number, colour: number): void => {
        if (x < 0 || y < 0 || x >= width || y >= height) return;
        pixels[y * width + x] = colour;
      };
      if (framed) {
        for (let x = 0; x < width; x++) {
          put(x, 0, colours.pen);
          put(x, height - 1, colours.pen);
        }
        for (let y = 0; y < height; y++) {
          put(0, y, colours.pen);
          put(width - 1, y, colours.pen);
        }
      }
      if (titled) {
        for (let y = border; y < border + titleHeight && y < height; y++) {
          for (let x = border; x < width - border; x++) put(x, y, colours.pen);
        }
        const font = this.font(0);
        if (font) {
          drawSciText(pixels, width, height, font, title, {
            x: border + 2,
            y: border,
            colour: colours.back,
            maxWidth: width - border * 2 - 4,
          });
        }
      }

      window.item = plane.add({
        cel: {
          width,
          height,
          displaceX: 0,
          displaceY: 0,
          clearKey: CONTROL_CLEAR,
          pixels,
        },
        x: rect.left,
        y: rect.top,
        priority: WINDOW_PRIORITY,
        visible: true,
      });
      this.pictureItemCount = plane.items.length;
    }

    return id;
  }

  /**
   * `kDisposeWindow` — the window goes and the port goes back.
   *
   * The controls drawn inside it go too: SCI draws a dialog's contents into
   * the window and a game that closes one expects the room back, so leaving
   * them behind would leave a dialog's buttons floating over the next scene.
   * They are the items added after the window's own, which is what makes the
   * item list's order load-bearing here and why the count is recomputed rather
   * than decremented.
   */
  private closeWindow(id: number): void {
    const plane = this.roomPlane;
    const window = this.windows.get(id);
    if (!window) return;

    if (plane && window.item) {
      const at = plane.items.indexOf(window.item);
      if (at >= 0) plane.items.splice(at);
      this.pictureItemCount = plane.items.length;
    }
    this.windows.delete(id);
    if (this.currentPort === id) {
      // Back to the most recent window still open, or to the screen.
      const remaining = [...this.windows.keys()];
      this.currentPort = remaining.length > 0 ? remaining[remaining.length - 1] : 0;
    }
  }

  /**
   * Draws one of the game's own controls into the room.
   *
   * SCI put the interface in the scripts (ADR 0011), so this is not a widget
   * set — it is a box and a string, positioned where the game's own object
   * says. A button gets a frame and a label does not, which is the only
   * distinction that changes what a person sees; a type this does not know is
   * drawn as a label rather than not at all, because a label in the wrong box
   * is legible and an empty box is not.
   *
   * **As a screen item, not into the background.** A SCI1.1 or SCI2 room is a
   * cel Picture, whose Plane carries items and *no* background buffer at all —
   * so anything drawn into the background would be drawn into nothing for
   * exactly the Versions whose interface this exists to show. A screen item
   * composites through the same sort as everything else and works for both
   * kinds of Picture.
   *
   * It counts as part of the Picture rather than as cast, because `drawCast`
   * truncates the item list to the Picture's own count every frame and a
   * control has to outlive that: SCI controls persist until the game redraws
   * or disposes them.
   */
  /**
   * One line out of a `text` resource, by resource number and index.
   *
   * **A SCI0 game's dialogue is in `text` resources and is addressed as a
   * pair.** The resource is a run of NUL-terminated strings and a line is the
   * `index`th of them, which is why `Display` and `GetFarText` take two
   * integers where a later game would pass a reference.
   *
   * Synchronous, because both callers happen in the middle of a send and a
   * Volume read does not — so `text` is preloaded with the artwork for the
   * same reason `message` is.
   */
  private farText(resource: number, index: number): string | null {
    const bytes = this.resources.peek('text', resource);
    if (!bytes) return null;
    let at = 0;
    for (let line = 0; line < index; line++) {
      while (at < bytes.length && bytes[at] !== 0) at++;
      if (at >= bytes.length) return null;
      at++;
    }
    let text = '';
    for (; at < bytes.length && bytes[at] !== 0; at++) text += String.fromCharCode(bytes[at]);
    return text;
  }

  /**
   * A typed line, reduced to the word groups a `Said` matches, for `Parse`.
   *
   * The reader is `resource/sciVocabulary.ts` and this is the only thing
   * between it and the machine — the same shape as `message` and `farText`, and
   * for the same reason: a Kernel call happens in the middle of a send and a
   * Volume read does not, so `vocab.000` is preloaded at `start` and read from
   * `peek` here.
   *
   * Null when the game ships no `vocab.000`, which is the ordinary case from
   * SCI1 on and is not an error.
   */
  private parseInput(line: string): { groups: number[]; unknown: string[] } | null {
    if (this.parserWords === undefined) {
      const bytes = this.resources.peek('vocab', SCI0_MAIN_VOCABULARY);
      const words = bytes ? readSciVocabulary(bytes) : [];
      this.parserWords = words.length > 0 ? vocabularyIndex(words) : null;
      if (this.parserWords) {
        this.log(`This game's parser knows ${words.length} words, from vocab.000.`);
      }
    }
    return this.parserWords ? parseSciLine(line, this.parserWords) : null;
  }

  private showControl(control: {
    x: number;
    y: number;
    width: number;
    height: number;
    text: string;
    font: number;
    type: number;
    state: number;
  }): void {
    const plane = this.roomPlane;
    if (!plane || control.width <= 0 || control.height <= 0) return;
    // **A control's rectangle is measured from the port, not from the screen.**
    // The port is the inside of the window the script opened, so without this
    // every dialog's buttons land in the corner of the room.
    const origin = this.portOrigin();
    if (control.width > SCI_PICTURE_WIDTH || control.height > this.screen.height) return;

    const pixels = new Uint8Array(control.width * control.height).fill(CONTROL_BACKGROUND);
    const put = (x: number, y: number, colour: number): void => {
      if (x < 0 || y < 0 || x >= control.width || y >= control.height) return;
      pixels[y * control.width + x] = colour;
    };

    // A frame around the things a player is meant to aim at: a button, an edit
    // field and a list. A label has none, because Sierra's does not and a box
    // round every line of dialogue is a different interface.
    const framed =
      control.type === CONTROL_BUTTON ||
      control.type === CONTROL_TEXTEDIT ||
      control.type === CONTROL_LIST;
    if (framed) {
      for (let x = 0; x < control.width; x++) {
        put(x, 0, CONTROL_FRAME);
        put(x, control.height - 1, CONTROL_FRAME);
      }
      for (let y = 0; y < control.height; y++) {
        put(0, y, CONTROL_FRAME);
        put(control.width - 1, y, CONTROL_FRAME);
      }
    }

    const font = this.font(control.font);
    if (font && control.text !== '') {
      const inset = framed ? 2 : 0;
      drawSciText(pixels, control.width, control.height, font, control.text, {
        x: inset,
        y: inset,
        colour: CONTROL_TEXT,
        maxWidth: control.width - inset * 2,
      });
    }

    plane.add({
      cel: {
        width: control.width,
        height: control.height,
        displaceX: 0,
        displaceY: 0,
        // Nothing in the box is transparent: a control covers what is under it,
        // which is what makes a window readable over a room.
        clearKey: CONTROL_CLEAR,
        pixels,
      },
      x: control.x + origin.x,
      y: control.y + origin.y,
      priority: CONTROL_PRIORITY,
      visible: true,
    });
    this.pictureItemCount = plane.items.length;
  }

  // ------------------------------------------------- the SCI32 display list --

  /**
   * How a coordinate in one resolution lands on this screen.
   *
   * **SCI32's one genuinely new idea about drawing.** A cel declares what
   * resolution it was drawn for, and everything about it — where it sits and
   * how big it is — is mapped from that resolution onto the display. A view
   * with no declared resolution was drawn for the script's own space, which is
   * 320x200 for every SCI game ever shipped.
   *
   * So King's Quest VII's cast, drawn at 320x200, is doubled onto a 640x480
   * screen, and its interface, drawn at 640x480, is placed pixel for pixel —
   * on the same Plane, in the same frame, through this one rule.
   * `ScreenItem::calcRects` (`screen_item32.cpp`) is where Sierra's is.
   */
  private toScreen(value: number, from: number, to: number): number {
    return from === to ? value : Math.round((value * to) / from);
  }

  /** The resolution a View was drawn for, which is the script's when it says nothing. */
  private celResolution(view: number): { width: number; height: number } {
    return this.view(view)?.resolution ?? this.resolution.script;
  }

  /**
   * `AddPlane` and `UpdatePlane`, which are the same call and not the same act.
   *
   * **A Plane that already exists is updated rather than replaced.** SCI32's
   * `UpdatePlane` carries the same object and means "these fields changed";
   * rebuilding the Plane throws away every screen item the game has added to it
   * since, and those items are the scene. King's Quest VII updates its main
   * Plane on the cycle after it fills it.
   *
   * The Picture is only re-read when the number changes, so an update that
   * moves a Plane does not re-fetch a 200KB background.
   */
  private addPlane(
    id: string,
    rect: { x: number; y: number; width: number; height: number },
    priority: number,
    picture: number,
    back = -1,
  ): void {
    // A Plane's rectangle is in script coordinates and the framebuffer is not,
    // so it is mapped here once rather than at every blit.
    const bounds = this.planeToScreen(rect);

    const existing = this.gamePlanes.get(id);
    if (existing) {
      existing.bounds.x = bounds.x;
      existing.bounds.y = bounds.y;
      existing.bounds.width = bounds.width;
      existing.bounds.height = bounds.height;
      existing.priority = priority;
      // **Updated with the bounds, not left at what the Plane was created
      // with.** `UpdatePlane` is how a SCI32 game moves and resizes a Plane,
      // and a stale script rectangle here places every screen item added
      // afterwards against an origin the Plane has not had for some time.
      this.planeScriptRects.set(id, { ...rect });
      this.changePlanePicture(id, picture, back);
      return;
    }

    // **No mask, ever.** A SCI32 Plane occludes by ordering alone — that is
    // ADR 0015's optional-data claim from the other side, and the same
    // compositor call renders it.
    const plane = new Plane(bounds, priority, null);
    this.gamePlanes.set(id, this.compositor.add(plane));
    this.planeScriptRects.set(id, { ...rect });
    this.changePlanePicture(id, picture, back);
  }

  /**
   * What a Plane shows under its items, when the script has just said.
   *
   * Sierra's `Plane::sync` is three statements and this is the same three:
   * when the picture number differs from the one the Plane is holding,
   * `deleteAllPics` takes every Picture item off it, `setType` re-reads what
   * kind of Plane the new number makes it, and `changePic` puts the new
   * Picture's cels on — which does nothing when the new number is not a
   * Picture at all.
   *
   * **The middle one is what was missing, and a number going the other way is
   * the case that showed it.** A Plane moving from one Picture to another was
   * handled; a Plane moving from a Picture to `kPlanePicColored` was not, so
   * its old Picture stayed on it for the rest of the game. King's Quest VII
   * reuses one Plane for its title screen and for every chapter screen after
   * it: the chapter screen sets `picture` to 65535, meaning "paint me in my
   * own `back`", and what showed instead was the title art it had finished
   * with, in the chapter's palette.
   */
  private changePlanePicture(id: string, picture: number, back: number): void {
    const plane = this.gamePlanes.get(id);
    if (!plane) return;
    const held = plane.pictureId;

    // The Plane keeps its own number and does its own deleting, which is where
    // Sierra keeps both. What is left here is the asynchronous half: a Picture
    // this engine may not have read yet.
    const wanted = plane.setPicture(picture, back);
    // A Plane that has just been emptied has no Picture arriving for it either,
    // its own or any `AddPicAt` laid on the screen it has left.
    if (picture !== held) this.dropPendingPlanePictures(id);
    if (wanted) this.requestPlanePicture(id, picture);
  }

  /** A Plane's script rectangle in framebuffer pixels. */
  private planeToScreen(rect: { x: number; y: number; width: number; height: number }): {
    x: number;
    y: number;
    width: number;
    height: number;
  } {
    const { script, display } = this.resolution;
    return {
      x: this.toScreen(rect.x, script.width, display.width),
      y: this.toScreen(rect.y, script.height, display.height),
      width: this.toScreen(rect.width, script.width, display.width),
      height: this.toScreen(rect.height, script.height, display.height),
    };
  }

  /** Each Plane's rectangle as the scripts gave it, which items are placed against. */
  private readonly planeScriptRects = new Map<
    string,
    { x: number; y: number; width: number; height: number }
  >();

  /**
   * Asks for a Plane's Picture, to be attached between cycles.
   *
   * Attached rather than drawn: a SCI32 Picture is a composition of cels with
   * their own positions and priorities, so it becomes the Plane's *lowest*
   * screen items and is occluded by whatever the game adds above it.
   */
  private requestPlanePicture(
    id: string,
    picture: number,
    at: { x: number; y: number } = { x: 0, y: 0 },
    own = true,
  ): void {
    const bytes = this.resources.peek('pic', picture);
    if (bytes) {
      this.attachPlanePicture(id, picture, bytes, at);
      return;
    }
    this.pendingPlanePictures.push({ id, picture, at, own });
  }

  /**
   * `AddPicAt` — a second Picture onto a Plane, displaced by `(x, y)`.
   *
   * `Plane::addPic` keeps the Plane's own `picture` number unchanged: what it
   * adds is a set of cels with a `_pictureId` of their own, which is what lets
   * `deletePic` take exactly one of them off again.
   */
  private addPicAt(
    id: string,
    picture: number,
    x: number,
    y: number,
    deleteDuplicate: boolean,
  ): void {
    const plane = this.gamePlanes.get(id);
    if (!plane) return;
    if (deleteDuplicate) {
      plane.deletePic(picture);
      const already = this.pendingPlanePictures.findIndex(
        (pending) => pending.id === id && pending.picture === picture && !pending.own,
      );
      if (already >= 0) this.pendingPlanePictures.splice(already, 1);
    }
    this.requestPlanePicture(id, picture, { x, y }, false);
  }

  /** Forgets every Picture still on its way to this Plane. */
  private dropPendingPlanePictures(id: string): void {
    for (let index = this.pendingPlanePictures.length - 1; index >= 0; index--) {
      if (this.pendingPlanePictures[index].id === id) this.pendingPlanePictures.splice(index, 1);
    }
  }

  /** Puts a read Picture onto its Plane, under everything already there. */
  private attachPlanePicture(
    id: string,
    picture: number,
    bytes: Uint8Array,
    at: { x: number; y: number } = { x: 0, y: 0 },
  ): void {
    const plane = this.gamePlanes.get(id);
    if (!plane) return;

    // The kind is asked of the resource and not of the Version (ADR 0018).
    if (sciPictureKind(bytes) !== 'cel') {
      const vga = this.resources.count('palette') > 0;
      const drawn = drawSciPicture(bytes, {
        vga,
        width: plane.bounds.width || SCI_PICTURE_WIDTH,
        height: plane.bounds.height || SCI_PICTURE_HEIGHT,
      });
      if (drawn.palette.length > 0) applySciPalette(this.palette, drawn.palette);
      plane.background = drawn.visual;
      this.lastPicture = picture;
      this.picValid = true;
      return;
    }

    const composition = readSciCelPicture(bytes);
    const entries = readSciPalette(bytes, composition.paletteOffset);
    if (entries.length > 0) applySciPalette(this.palette, entries);

    // `Plane.setPicture` has already taken the old Picture off, so this only
    // has to add.
    // A cel Picture declares the resolution it was composed for, and its cels
    // are placed in that space — the same rule a screen item follows.
    const celRes = composition.resolution ?? this.resolution.script;
    const { display, script: scriptRes } = this.resolution;
    const rect = this.planeScriptRects.get(id) ?? { x: 0, y: 0 };
    const script = { x: rect.x + at.x, y: rect.y + at.y };
    for (const placed of composition.cels) {
      plane.add({
        cel: placed.cel,
        x: this.toScreen(script.x + placed.x, scriptRes.width, display.width) - plane.bounds.x,
        y: this.toScreen(script.y + placed.y, scriptRes.height, display.height) - plane.bounds.y,
        size: {
          width: Math.max(1, this.toScreen(placed.cel.width, celRes.width, display.width)),
          height: Math.max(1, this.toScreen(placed.cel.height, celRes.height, display.height)),
        },
        // A background cel sits below every item the game adds, and SCI32
        // Picture priorities are small positive numbers that would otherwise
        // sort *above* an actor at priority 0.
        priority: placed.priority ?? 0,
        visible: true,
        pictureId: picture,
      });
    }
    this.lastPicture = picture;
    this.picValid = true;
  }

  private deletePlane(id: string): void {
    const plane = this.gamePlanes.get(id);
    if (!plane) return;
    this.compositor.remove(plane);
    this.gamePlanes.delete(id);
    this.planeScriptRects.delete(id);
    this.dropPendingPlanePictures(id);
    // The items on a deleted Plane are gone with it, and leaving them in the
    // index makes every later update look them up and find a Plane that is not
    // composited any more.
    for (const [itemId, held] of [...this.screenItems]) {
      if (held.plane === id) this.screenItems.delete(itemId);
    }
    for (const [itemId, held] of [...this.deferredScreenItems]) {
      if (held.plane === id) this.deferredScreenItems.delete(itemId);
    }
  }

  private addScreenItem(
    id: string,
    planeId: string,
    item: {
      view: number;
      loop: number;
      cel: number;
      x: number;
      y: number;
      priority: number;
      bitmap?: number;
    },
  ): void {
    const plane = this.gamePlanes.get(planeId) ?? [...this.gamePlanes.values()][0];
    if (!plane) return;

    // A bitmap-backed item ignores the View entirely, which is SCI32's own rule
    // (`screen_item32.cpp`): the `bitmap` Selector wins when it is set. This is
    // how every menu and every line of text in a SCI32 game reaches the screen.
    const cel = item.bitmap
      ? this.celFromBitmap(item.bitmap)
      : this.cel(item.view, item.loop, item.cel);

    const held = this.screenItems.get(id);

    // **An item whose View has not been read yet is kept, not dropped.**
    //
    // A SCI32 Volume is not in memory (ADR 0021) and a Kernel call cannot
    // await, so the first `AddScreenItem` of a room routinely arrives before
    // its View does. Returning there loses the item for good, because a SCI32
    // game only calls `AddScreenItem` *once* for anything that does not move —
    // King's Quest VII's menu builds fourteen buttons in one cycle and never
    // mentions them again. Four thousand `UpdateScreenItem` calls a second for
    // the things that *do* move hid it: the moving item recovered on its next
    // update and the menu never did.
    //
    // So the request is held and replayed when the View lands, which is the
    // same shape `pendingScripts` and a Plane's Picture already use.
    if (!cel) {
      // **65535 is SCI32's "no View", not resource 65535.** A screen item that
      // is drawn from a bitmap carries it, and asking the resource layer for it
      // is the same mistake a Plane's picture code was: the answer is truthfully
      // "this game has not got one" and it is not a question worth asking.
      if (item.view > 0 && item.view < NO_VIEW && !this.views.has(item.view)) {
        this.pendingViews.add(item.view);
        this.deferredScreenItems.set(id, { plane: planeId, item: { ...item } });
      }
      return;
    }
    this.deferredScreenItems.delete(id);

    // A screen item's position is its own, not its feet: SCI32 places by the
    // cel's origin and the displacement is already in the cel.
    //
    // Then mapped out of the cel's own resolution and onto the screen, which is
    // what puts a 320x200 actor and a 640x480 button on one Plane. A bitmap is
    // already in screen pixels — SCI32 builds them at display resolution — so
    // it maps one to one.
    const celRes = item.bitmap ? this.resolution.display : this.celResolution(item.view);
    const { display } = this.resolution;
    // The Plane's own rectangle, in the coordinates the scripts placed it with.
    // `UpdatePlane` keeps this in step, so it is the Plane's origin now rather
    // than the one it was created with.
    const script = this.planeScriptRects.get(planeId) ?? { x: 0, y: 0 };

    // **Position scales from the script's space; everything the cel owns scales
    // from the cel's.**
    //
    // Two questions, and reading them as one is what stacked King's Quest VII's
    // menu on top of itself. Its buttons are 640x480 artwork placed at script
    // coordinates thirty apart; scaled as the artwork is — not at all — they sat
    // thirty pixels apart with sixty-five-pixel cels and overlapped two deep.
    // Scaled as coordinates, they are seventy-two apart and the menu reads.
    //
    // **The cel's origin offset is one of the cel's own quantities, not one of
    // the script's**, and reading it as the script's was the half of that rule
    // this engine had wrong. `displaceX` and `displaceY` are measured in the
    // pixels of the artwork they belong to, exactly as `width` and `height`
    // are, so they scale by the cel's ratio and not by the script's. Subtracted
    // before the scaling, a 640x480 cel's offset was applied twice: King's
    // Quest VII's three menu buttons landed at screen tops 31, 103 and 163 with
    // heights 63, 62 and 65 — a six-pixel gap, then a two-pixel overlap — and
    // "Start New Game" began at x −16, sixteen pixels off the left edge of its
    // own screen. Scaled as the cel's, the same three land at 94, 163 and 226,
    // stacked flush the way a menu is, and all three are on the screen.
    //
    // What it cost was not only the picture. `IsOnMe` hit-tests against this
    // same rectangle, so every button answered for a region the player could
    // not see and the menu could be read and never used.
    //
    // **A View's origin is not the number in its cel header**, and reading it as
    // one put three quarters of King's Quest VII's name-entry panel off the top
    // left corner of the screen. `celOrigin` holds the rule and the reasoning;
    // what matters here is that the answer is in the cel's own pixels, so it
    // scales by the cel's ratio below and not by the script's.
    const origin = celOrigin(cel, item.bitmap !== undefined && item.bitmap !== 0);

    // Absolute first, then made relative to the Plane's screen origin, because
    // that is what the blitter adds back.
    const { script: scriptRes } = this.resolution;
    const absoluteX =
      this.toScreen(script.x + item.x, scriptRes.width, display.width) -
      this.toScreen(origin.x, celRes.width, display.width);
    const absoluteY =
      this.toScreen(script.y + item.y, scriptRes.height, display.height) -
      this.toScreen(origin.y, celRes.height, display.height);
    const x = absoluteX - plane.bounds.x;
    const y = absoluteY - plane.bounds.y;
    const size = {
      width: Math.max(1, this.toScreen(cel.width, celRes.width, display.width)),
      height: Math.max(1, this.toScreen(cel.height, celRes.height, display.height)),
    };

    // **Updated in place.** `UpdateScreenItem` is the same Kernel handler as
    // `AddScreenItem` and the game calls it every cycle for every actor; an
    // update that removes and re-adds moves the item to the end of the Plane's
    // insertion order, so a cast that should keep its drawing order restacks
    // itself on every frame.
    if (held && held.plane === planeId) {
      held.item.cel = cel;
      held.item.x = x;
      held.item.y = y;
      held.item.size = size;
      held.item.priority = item.priority;
      held.item.visible = true;
      return;
    }

    if (held) this.deleteScreenItem(id);
    const added = plane.add({ cel, x, y, size, priority: item.priority, visible: true });
    this.screenItems.set(id, { plane: planeId, item: added });
  }

  /**
   * Whether a point lands on a screen item, in the space the scripts use.
   *
   * `GfxFrameout::kernelIsOnMe`: the point arrives in script coordinates, is
   * scaled onto the screen, offset by the Plane's own origin, and compared
   * against the item's screen rectangle. With `checkPixel` it then asks the cel
   * whether that pixel is inked, which is what makes an irregular shape
   * clickable only where it is drawn.
   */
  private screenItemHit(id: string, x: number, y: number, checkPixel: boolean): boolean | null {
    const held = this.screenItems.get(id);
    if (!held) return null;
    const plane = this.gamePlanes.get(held.plane);
    if (!plane) return null;

    // The point is in the same space a screen item's position is given in — the
    // script's, absolute — so it scales onto the framebuffer and nothing else.
    // Adding the Plane's origin on top of that (`kernelIsOnMe` reads as though
    // it does) puts the point a Plane's height too low: King's Quest VII's menu
    // Plane starts ten script rows down, and a click on the middle of a button
    // was tested twenty-four pixels below where it landed.
    const { script, display } = this.resolution;
    const pointX = this.toScreen(x, script.width, display.width);
    const pointY = this.toScreen(y, script.height, display.height);

    const left = plane.bounds.x + held.item.x;
    const top = plane.bounds.y + held.item.y;
    const size = screenItemSize(held.item);
    if (pointX < left || pointX >= left + size.width) return false;
    if (pointY < top || pointY >= top + size.height) return false;
    if (!checkPixel) return true;

    const { cel } = held.item;
    const celX = Math.min(cel.width - 1, Math.floor(((pointX - left) * cel.width) / size.width));
    const celY = Math.min(cel.height - 1, Math.floor(((pointY - top) * cel.height) / size.height));
    return cel.pixels[celY * cel.width + celX] !== cel.clearKey;
  }

  /** Views a screen item asked for that were not read, loaded between cycles. */
  private readonly pendingViews = new Set<number>();

  /**
   * Objects whose `nsRect` could not be measured because their View was not in.
   *
   * `nsRect` is what a script's own `onMe` tests, and a game sets it once — so
   * a miss here is permanent rather than retried on the next frame, and the
   * thing it describes becomes unclickable for the life of the screen.
   */
  private readonly pendingNowSeen = new Map<string, Reg>();

  /**
   * Screen items whose View had not arrived, replayed once it has.
   *
   * Keyed by the item's own register, so a game that updates the item before
   * the View lands replaces the request rather than queueing a second one.
   */
  private readonly deferredScreenItems = new Map<
    string,
    { plane: string; item: Parameters<SciEngine['addScreenItem']>[2] }
  >();

  /**
   * A bitmap as the compositor's kind of cel.
   *
   * The shapes already agree — width, height, a byte a pixel and an index that
   * means "leave what is underneath" — so this is a rename rather than a
   * conversion. The origin a script set with `BitmapSetOrigin` becomes the
   * displacement, which is the same thing under the other family's name.
   */
  private celFromBitmap(handle: number): {
    width: number;
    height: number;
    displaceX: number;
    displaceY: number;
    clearKey: number;
    pixels: Uint8Array;
  } | null {
    const bitmap = this.bitmaps.get(handle);
    if (!bitmap) return null;
    return {
      width: bitmap.width,
      height: bitmap.height,
      displaceX: bitmap.originX,
      displaceY: bitmap.originY,
      clearKey: bitmap.skip,
      pixels: bitmap.pixels,
    };
  }

  /**
   * Takes a screen item off its Plane, which is what `DeleteScreenItem` means.
   *
   * This forgot the item and left the cel on the Plane, so nothing a SCI32 game
   * ever removed actually left the screen.
   */
  private deleteScreenItem(id: string): void {
    this.deferredScreenItems.delete(id);
    const held = this.screenItems.get(id);
    if (!held) return;
    this.screenItems.delete(id);
    this.gamePlanes.get(held.plane)?.remove(held.item);
  }

  roomName(): string | undefined {
    return undefined;
  }

  describeStatus(): string | undefined {
    if (this.resources.unreadable.length > 0) {
      return `${this.resources.unreadable.length} resources unreadable`;
    }
    return undefined;
  }

  describeStall(): string[] {
    return [
      `${describeSciVersion(this.game.version)} "${this.game.id}", identified by ` +
        `${this.game.identification}`,
      this.gamePlanes.size === 0
        ? 'no SCI32 Planes — the scripts have not reached an AddPlane'
        : `${this.gamePlanes.size} SCI32 Planes, ${this.framedOut ? 'framed out' : 'never framed out'}`,
      `resources: ${this.resources.describeContents()}`,
      // What a video cost, which is #226's memory question answered from a
      // real run rather than from a claim in a PR.
      this.movies.describe() ??
        (this.movies.busy ? 'a video is playing' : 'no video has played this session'),
      `input: ${this.input.describe()}`,
      ...this.machine.describe(),
      `heap: ${this.heap.describe()}`,
      this.textColours.length === 0
        ? 'no text colours set — the scripts have not reached a TextColors'
        : `text colours: ${this.textColours.join(', ')}`,
      this.textFonts.length === 0
        ? 'no text fonts set'
        : `text fonts: ${this.textFonts.join(', ')}`,
      // What was asked for and could not be drawn, so a still screen says why.
      this.palCycles.size === 0
        ? 'no palette cycles set'
        : `${this.palCycles.size} palette cycles set, stepped only when the game steps them`,
      `bitmaps: ${this.bitmaps.describe()}`,
      this.remaps.length === 0
        ? 'no colour remaps asked for'
        : `${this.remaps.length} colour remaps asked for and not rendered — the remap tables ` +
          `belong to the SCI32 compositor, which this engine does not have`,
      this.cursorStyle === null
        ? 'no cursor set — the scripts have not reached a SetCursor'
        : this.cursorVisible
          ? 'a cursor is set'
          : 'the game has hidden the cursor',
      this.lastPicture === null
        ? 'no Picture has been drawn — the scripts have not reached a DrawPic'
        : `Picture ${this.lastPicture} is on screen, ` +
          `${this.roomPlane?.items.length ?? 0} cast members on it`,
      `Kernel calls made: ${[...this.kernelCalls]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([name, count]) => `${name}×${count}`)
        .join(', ')}`,
      this.unimplementedKernels.size > 0
        ? `Kernel calls not implemented: ${[...this.unimplementedKernels]
            .map((number) => `0x${number.toString(16)}`)
            .join(', ')}`
        : 'every Kernel call a script made is implemented',
      ...this.game.notes,
    ];
  }

  describeEditRefusal(): string | null {
    return describeUneditableTarget(this.target);
  }

  /**
   * Decompiles into a Project holding the class graph (ADR 0018).
   *
   * The refusal is asked first and is the same string `describeEditRefusal`
   * returns, so the two cannot drift — and it is asked *before* the work, which
   * is what stops a refusal reading as a button that does nothing.
   */
  async toEditableGame(options: EditableGameOptions): Promise<EditableGame | null> {
    const refusal = this.describeEditRefusal();
    if (refusal) throw new Error(refusal);

    const sci = await importSciGame(this.game, this.resources, {
      onProgress: options.onProgress,
    });

    const audio = await this.listAudio();

    const notes = [
      `Imported ${sci.scripts.length} Script resources as a class graph: ` +
        `${sci.scripts.reduce((count, script) => count + script.objects.length, 0)} objects, ` +
        `${sci.selectors.length} Selectors, ${sci.classes.length} classes.`,
      describeTextSurface(this.resources.count('message') > 0),
      sci.unrecoveredCount === 0
        ? 'Unrecovered: 0 — every resource came back as it arrived.'
        : `Unrecovered: ${sci.unrecoveredCount}. Those resources are held as their original ` +
          `bytes and shown read-only.`,
    ];

    if (audio.tracks.length > 0) {
      notes.push(
        `${audio.tracks.length} digital recordings listed by the numbers this release's own maps ` +
          `say; their bytes stay in the game folder (ADR 0034).`,
      );
    }
    const audio36 = describeSciAudio36(audio.audio36Maps);
    if (audio36) notes.push(audio36);

    return {
      project: {
        ...createProject(this.game.id),
        target: this.target,
        audio: audio.tracks,
        sci,
      },
      notes,
    };
  }

  /**
   * The recordings this release has, as rows with no bytes in them, and how
   * much speech those rows do not reach.
   *
   * The reading is in `authoring/sci/audioList.ts` rather than here, because
   * what it needs is two index reads and nothing an Engine holds — and putting
   * it there is what lets it be checked against a fixture without standing an
   * interpreter up first.
   */
  private async listAudio(): Promise<{ tracks: ProjectAudio[]; audio36Maps: number }> {
    const { entries, audio36Maps } = await readSciAudioEntries(this.resources);
    return { tracks: listSciAudio({ entries }), audio36Maps };
  }
}

/**
 * Sierra's own control types, which are **one-based**.
 *
 * Transcribed from ScummVM's `graphics/controls16.h`: button 1, text 2,
 * text-edit 3, icon 4, list 6, list-alias 7, dummy 10. This file had them
 * zero-based — button 0, label 1, edit 2 — which is off by one all the way
 * along, and off by one in the way that does not fail: King's Quest IV's
 * `DText` clone reports type 2 and would have been drawn with a button's
 * frame, and its `DEdit` reports 3 and would have been drawn as an edit field
 * only by accident of the two adjacent mistakes cancelling.
 *
 * Only the three that get a frame are named: text and icon are drawn without
 * one, so nothing here has to ask which they are.
 */
/** One open window, and where the port inside it starts. */
interface SciWindow {
  id: number;
  left: number;
  top: number;
  /** Where drawing inside this window is measured from. */
  contentLeft: number;
  contentTop: number;
  item: ScreenItem | null;
}

/** Sierra's window style bits, from ScummVM's `GfxPorts`. */
const WINDOW_STYLE_TRANSPARENT = 1 << 0;
const WINDOW_STYLE_NOFRAME = 1 << 1;
const WINDOW_STYLE_TITLE = 1 << 2;
/** How tall a title bar is, which is one line of Sierra's own small font. */
const WINDOW_TITLE_HEIGHT = 10;
/** Under the controls it holds and over the room it covers. */
const WINDOW_PRIORITY = 14;

const CONTROL_BUTTON = 1;
const CONTROL_TEXTEDIT = 3;
const CONTROL_LIST = 6;
/** The colours a control is drawn in until a game says otherwise. */
const CONTROL_BACKGROUND = 15;
const CONTROL_FRAME = 0;
const CONTROL_TEXT = 0;
/**
 * A palette index no control pixel uses, so every pixel of the box is drawn.
 *
 * A control that let the room show through would be unreadable over artwork,
 * which is the opposite of what a window is for.
 */
const CONTROL_CLEAR = 0xff;
/** Above the cast, because an interface is drawn over the room and not into it. */
const CONTROL_PRIORITY = 15;
