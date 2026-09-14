/**
 * The AGOS Engine.
 *
 * A sixth Engine family under the same app shell (ADR 0027), reaching it
 * through the same twenty-member seam ADR 0011 drew and adding nothing to it.
 *
 * ## What this can do, stated plainly
 *
 * It loads a game, identifies its Target from the game's own bytes, reads the
 * item tree, the pooled strings and every Subroutine, and runs the ones whose
 * opcodes are implemented. It saves and restores. It hands the game to the
 * editor as a Project.
 *
 * It runs the VGA script machine that places a game's sprites, draws the words
 * a game says when a font can be found, and plays The Feeble Files' and the
 * Puzzle Pack's video.
 *
 * **Two of those have conditions worth stating rather than discovering.** The
 * font is not in the game: AGOS keeps it in the interpreter executable, so a
 * folder of game data alone draws no text at all, and `describeStatus` says so
 * rather than drawing boxes (ADR 0032). Video is Smacker, which is what the
 * discs carry; a folder of ScummVM's DXA re-encodes is recognised and named
 * rather than played (ADR 0024). `CONTEXT.md`'s Completable is not claimed for
 * any AGOS title, and this comment is the honest version of that, kept next to
 * the code rather than only in a document.
 *
 * The reason it is here in that state is the sequencing this family was planned
 * with: the reader and the whole-game disassembly sweep first, because they
 * falsify the opcode table before any behaviour depends on it; then the world
 * and the interpreter; then the screen. Each phase's evidence exists before the
 * next one leans on it.
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
import { Screen } from '../gfx/Screen.js';
import { describeTarget, type Target } from '../../authoring/target.js';
import { importAgosProject } from '../../authoring/agos/project.js';
import { unnamedOpcodes } from '../../authoring/agos/disassemble.js';
import { toBase64 } from '../../authoring/base64.js';
import { fingerprintOf } from '../../authoring/agos/fingerprint.js';
import { detectAgosGame, type AgosDetection } from './resource/agosDetect.js';
import { readZoneSource, type ZoneSource } from './resource/zoneSource.js';
import { readTableSource, type TableSource } from './resource/tableSource.js';
import { readVgaFile, vgaLayoutFor, type VgaFile } from './gfx/vgaFile.js';
import { EngineVgaHost } from './world/engineVgaHost.js';
import { Pathfinder } from './world/pathfinder.js';
import type { HitArea } from './world/hitAreas.js';
import { VerbBar, dispatchableVerbsFrom, reachableVerbs } from './world/verbBar.js';
import {
  VgaMachine,
  blitWideBackdrop,
  paintZoneSprites,
  type WideBackdrop,
} from './gfx/VgaMachine.js';
import { readGamePc, type AgosGamePc } from './resource/gamePc.js';
import {
  AgosInterpreter,
  AgosState,
  CUTSCENE_SKIPPABLE_BIT,
  WALK_SUBROUTINE_VARIABLE,
  type AgosTask,
} from './script/AgosInterpreter.js';
import { AGOS_SAVE_FORMAT, loadAgosState, saveAgosState } from './save/AgosSaveState.js';
import type { AgosSavedGame } from './save/AgosSaveState.js';
import { AgosInput } from './AgosInput.js';
import { AgosSound } from './sound/AgosSound.js';
import { readSpeechIndex, type SpeechIndex } from './sound/speech.js';
import { readEffectsIndex, type EffectsIndex } from './sound/effects.js';
import { effectsBankFileIn, effectsFileIn, speechFileIn } from './sound/audioFiles.js';
import { listAgosAudio, type AgosEffectBank } from '../../authoring/agos/audioList.js';
import type { ProjectAudio } from '../../authoring/audio.js';
import {
  archiveBasesFor,
  isAgos2,
  pollsSecondSubroutineChannel,
  type AgosTarget,
} from './agosVersion.js';
import {
  findAgosFont,
  glyphsOf,
  interpreterCandidates,
  isKnownInterpreterName,
  type AgosFont,
} from './gfx/agosFont.js';
import { drawTextWindow, type AgosWindow } from './gfx/drawWindow.js';
import { drawSimon2Icon, SIMON2_ICON_WIDTH } from './gfx/icons.js';
import { describeTextDirection, readTextDirection } from './gfx/textDirection.js';
import type { TextDirectionEvidence } from './gfx/textDirection.js';
import { AgosVideoPlayback } from './video/AgosVideoPlayback.js';
import { videoFileCandidates } from './video/agosVideo.js';

/**
 * The hit-area numbers Simon 1 and Simon 2 give their verb strip.
 *
 * The reference tests `ha->id >= 101 && ha->id < 113` and so does this. It
 * looks like a magic number and is not one: the strip is built by the game's
 * own Subroutines, which number its boxes, so this range identifies the strip
 * in the data rather than describing where it is drawn.
 */
const VERB_STRIP_FIRST_BOX = 101;
const VERB_STRIP_LAST_BOX = 112;

/**
 * The two strip boxes whose verbs stand in when the player has chosen none.
 *
 * **This is the whole reason a click used to do nothing.** Simon 1 and 2 always
 * have a verb live: `resetVerbs` takes box 101's verb when the pointer is over
 * the room and box 102's when it is over the panel, and
 * `AGOSEngine_Simon1::handleMouseMoved` swaps between the two as the pointer
 * crosses the boundary. Box 101 carries "walk to", which is why clicking the
 * floor of a room walks there without the player choosing anything first.
 *
 * Without it the bar started empty, every click on the floor or on a thing
 * returned `idle`, and the game looked like one whose scripts were not running
 * — with no verb chosen there was no command to issue and nothing said so.
 *
 * Which verb each box carries is the game's own business: these are box
 * numbers, and the verbs come out of the boxes the game's Subroutines defined.
 */
const DEFAULT_VERB_BOX_ROOM = 101;
const DEFAULT_VERB_BOX_PANEL = 102;

/**
 * Where the panel starts, for choosing between those two boxes.
 *
 * The reference's own `_mouse.y >= 136`. One more than the top of the band box
 * 1 covers, and the reference's number is kept rather than derived from the box
 * so that the two cannot drift apart.
 */
const PANEL_TOP = 136;

/**
 * The bit in a box's verb that says the box is a whole command on its own.
 *
 * `ha->verb & 0x4000` in the reference: the low bits are the verb and this one
 * says "issue it against my item now" rather than "select me". The verb itself
 * is the remaining bits, which is what `& 0xBFFF` masks out — a box like that
 * read whole gives a verb number no guard could ever match.
 */
const VERB_IMMEDIATE_FLAG = 0x4000;
const VERB_NUMBER_MASK = 0xbfff;

/** The key that asks to leave the sequence that is playing (`kActionExitCutscene`). */
const EXIT_CUTSCENE_KEY = 'Escape';

/**
 * Where a click's position is left for the game's scripts to read.
 *
 * The reference's `boxController` writes `_variableArray[1]` and `[2]` for
 * Simon 1, Simon 2 and The Feeble Files. Named rather than inlined because
 * nothing else in this engine would explain two bare numbers.
 */
const CLICK_X_VARIABLE = 1;
const CLICK_Y_VARIABLE = 2;

/**
 * The variable that says which **text box** the player clicked, or that they
 * clicked none.
 *
 * `setVerbText` in the reference (`input.cpp:34`): the id starts at **0xFFFF**
 * and only a hit area carrying the text-box flag replaces it with that box's
 * slot. Then `_variableArray[60] = id`.
 *
 * Nothing here wrote it, so it stayed at its initial zero — and zero is not
 * "nothing", it is slot zero. Simon 2's street reads it two removes down from a
 * floor click: subroutine 21 copies variable 60 into 84 and runs the room's
 * table, and the room's walk handler opens
 *
 * ```
 * subroutine 5315, line 0:
 *   o_eq 84, 0 ; o_let 1, 156 ; o_let 2, 112
 * ```
 *
 * — *if the player clicked scenery, walk to where you stand to look at it*. So
 * every floor click was read as a click on a piece of scenery, the pointer
 * position the click had just written into variables 1 and 2 was replaced by
 * that scenery's standing spot, and Simon walked to the same place however far
 * away the player clicked.
 */
const VERB_TEXT_VARIABLE = 60;

/** What {@link VERB_TEXT_VARIABLE} holds when the box clicked is not a text box. */
const NO_TEXT_BOX = 0xffff;

/**
 * The Subroutine Simon 1 and 2 re-enter the current room through after a load,
 * and the bit that tells it a load is why. Set together, read together:
 * subroutine 100 fires its restore branch on {@link RESTORE_REDRAW_BIT} and
 * `o_process`es the room's own re-entry Subroutine, which rebuilds the scene's
 * hit areas. Both are the reference's (`saveload.cpp`, `getSubroutineByID(100)`).
 */
const ROOM_REENTRY_SUBROUTINE = 100;
const RESTORE_REDRAW_BIT = 97;

export interface AgosEngineOptions {
  onLog?: (message: string) => void;
  progress?: LoadProgressTracker;
}

export class AgosEngine implements AdventureEngine {
  /**
   * The framebuffer, at this Version's own size.
   *
   * AGOS 1 is 320x200 like its siblings; AGOS 2 is 640x480, which is the one
   * place in this engine where a Version changes something the shell can see.
   * `Screen` took its dimensions as constructor arguments for SCI's sake and
   * they serve here unchanged (ADR 0011's "widen the data" a further time).
   */
  readonly screen: Screen;
  readonly palette = new Palette();
  readonly saveFormat = AGOS_SAVE_FORMAT;
  readonly saveNote =
    'AGOS saves are this interpreter’s own format and are not interchangeable with ' +
    'ScummVM’s, or with this project’s SCUMM, AGI and SCI saves.';
  readonly resolution = {
    script: { width: 320, height: 200 },
    display: { width: 320, height: 200 },
  };

  frame = 0;
  hasQuit = false;

  readonly sound = new AgosSound();

  readonly input: AgosInput;

  private readonly interpreter: AgosInterpreter;
  private readonly state: AgosState;
  private booted = false;
  /**
   * The game script running now, across frames rather than inside one.
   *
   * At most one, which is the reference's shape: `AGOSEngine::go` runs one
   * Subroutine at a time and takes no input while it does. A second command
   * arriving mid-script is dropped rather than interleaved — see {@link
   * runCommand} — because two AGOS scripts sharing the two item registers and
   * the sync set would each see the other's world.
   */
  private task: AgosTask | null = null;
  private cursorIndex = 0;
  /**
   * Whether the verb now in the bar is the player's choice rather than the default.
   *
   * The reference's `_defaultVerb` read as a flag: it sets it to zero when a
   * player clicks the strip, and `handleMouseMoved` only reinstalls the default
   * while it is non-zero. So this is what stops "walk to" from quietly
   * replacing the "give" a player picked while they move the pointer towards
   * what they meant to give.
   */
  private verbChosenByPlayer = false;
  /**
   * The graphics machines currently running, by zone.
   *
   * One per zone rather than one per game, because a zone is the unit a game
   * loads and unloads: its scripts and its pixels arrive and leave together
   * (`loadZone`), and a sprite's script offset means nothing outside the zone
   * it came from.
   */
  private readonly zones = new Map<number, VgaMachine>();
  /**
   * A zone's decoded image and animation tables, keyed by the resource itself.
   *
   * Keyed by the `Uint8Array` rather than by the zone number because the
   * resource is what the tables describe: two zones cannot share one and a
   * reloaded zone hands back the same subarray, so identity is the right key
   * and there is nothing to invalidate.
   */
  private readonly vgaFiles = new Map<Uint8Array, VgaFile>();
  /**
   * The scene the sprites are drawn over, kept between frames.
   *
   * See {@link setWindowImage}. Sized in the constructor, because AGOS 2 draws
   * at 640x480 and everything before it at 320x200.
   */
  private background: Uint8Array = new Uint8Array(0);
  /**
   * The decoded backdrop of a room wider than the screen, or null.
   *
   * A scrolling room is decoded once and kept here so {@link render} can re-cut
   * the visible window every frame at the current scroll, without re-running
   * the picture script (which would re-issue the room's sprites and sounds).
   * Null in a room that fits the screen — see {@link setWindowImage}.
   */
  private wideBackdrop: WideBackdrop | null = null;
  /** How far the current room can scroll, in eight-pixel columns; zero if it does not. */
  private scrollXMax = 0;
  /**
   * The window table, shared by every zone's drawing machine.
   *
   * Global in the reference — one `_videoWindows` for the whole game — so a
   * zone that draws into a window another zone's script defined clips against
   * the same rectangle rather than against the whole screen.
   */
  private readonly windows = new Map<number, [number, number, number, number]>();
  /**
   * The effects bank belonging to the part of the game now running.
   *
   * Simon 1's Windows release ships one per `TABLES` file (see
   * `TableSource.effectsFor`), so this is state rather than a load-time read.
   * The table number is kept beside the index to recognise a bank that has not
   * changed, so a Subroutine jumped to every tick does not re-read its table.
   * It is the *number* rather than the bytes because `effectsFor`/`sound` may
   * hand back a fresh view each call, and an identity test on that would reload
   * — and re-log — on every jump.
   */
  private tableEffects: EffectsIndex | undefined;
  private tableEffectsNumber: number | undefined;
  /**
   * VGA opcodes that reached the host and had nothing behind them, by name.
   *
   * Sound effects and the pathfinder. Kept on the Engine rather than per zone,
   * because the gap is the Engine's rather than a zone's — and reported, on
   * this project's standing rule that a silent no-op is worse than a named
   * gap.
   */
  readonly vgaUnsupported = new Set<string>();
  /**
   * The routes scripts hand out, shared by every zone.
   *
   * On the Engine rather than per zone because a route belongs to an item and
   * an item outlives a zone: a script that draws a route in one zone and
   * selects it in another would find an empty set if each zone kept its own.
   */
  readonly pathfinder = new Pathfinder();
  /**
   * The chosen verb and the nouns being collected for it.
   *
   * The last of AGOS's three interfaces to exist at all, and the reason a
   * complete opcode table still left Simon 1 unplayable: with no way to choose
   * a verb there was no way to issue a command. Holds no strings and draws
   * nothing — a verb's label is a string in the game's own pool and its
   * position is a hit area the scripts define, so both belong to the surface.
   */
  readonly verbBar: VerbBar;

  /**
   * The video currently playing, which stops the world while it does.
   *
   * A field on the Engine rather than something the VGA script machine owns,
   * because a video is played *at* the screen rather than composited into it —
   * the distinction `CONTEXT.md` draws for SMUSH against SCI's Robot, met here
   * for the third time (#288).
   */
  private readonly video = new AgosVideoPlayback();

  /** The file `off_loadVideo` named, waiting for `off_playVideo` to ask for it. */
  private pendingVideo: string | null = null;

  /** Reported once each, so a folder of DXA re-encodes says so once and not per frame. */
  private readonly reportedVideos = new Set<string>();

  /** Where this Engine's own lines go. */
  readonly log: (message: string) => void;

  private constructor(
    private readonly game: AgosGamePc,
    private readonly detection: AgosDetection,
    private readonly agosTarget: AgosTarget,
    private readonly baseFileBytes: Uint8Array,
    private readonly zoneSource: ZoneSource,
    /** The Subroutines and local strings that are not in `GAMEPC`. */
    private readonly tableSource: TableSource,
    /** The talkie's recorded lines, indexed; absent for a floppy release. */
    private readonly speech: SpeechIndex | undefined,
    /**
     * The numbered sound effects, indexed; absent where the release ships none.
     *
     * A separate resource from the speech and in the same container format,
     * which is exactly why they had to be told apart by name — see the note at
     * the load site.
     */
    private readonly effects: EffectsIndex | undefined,
    /** The game's files, kept open for what is addressed by name after load. */
    private readonly source: DataSource,
    /**
     * The font read out of an interpreter executable, where one was there.
     *
     * Undefined is the normal state for a folder holding only game data, and it
     * is why `describeStatus` says so rather than the renderer drawing boxes
     * (ADR 0032).
     */
    private readonly font: AgosFont | undefined,
    /** Which way this release lays its text out, read from its own words (ADR 0028). */
    private readonly textDirection: TextDirectionEvidence,
    /**
     * Simon 2's `ICON.DAT`, read whole; null where the folder ships none.
     *
     * Only the Simon 2 draw path reads it. The bytes open with a table of two
     * little-endian 16-bit stream offsets per icon — see `gfx/icons.ts`.
     */
    private readonly iconFile: Uint8Array | null,
    onLog: ((message: string) => void) | undefined,
    /** What was loaded, so an export can refuse the wrong folder by name. */
    private readonly origin: {
      baseFile: string;
      baseBytes: number;
      archiveFile: string;
      archiveBytes: number;
    },
  ) {
    // AGOS 2 draws at 640x480; everything before it at 320x200. Scripts and
    // display agree in both, so this family is SCUMM's and AGI's degenerate
    // case rather than SCI32's split.
    this.log = onLog ?? ((): void => undefined);
    const wide = isAgos2(agosTarget.version);
    const size = wide ? { width: 640, height: 480 } : { width: 320, height: 200 };
    this.screen = new Screen(size.width, size.height);
    this.background = new Uint8Array(size.width * size.height);
    this.resolution = { script: size, display: size };

    this.state = new AgosState(game.items);
    this.interpreter = new AgosInterpreter(
      game.subroutines,
      this.state,
      agosTarget,
      {
        loadZone: (zone) => this.loadZone(zone),
        setWindowImage: (window, image) => this.setWindowImage(window, image),
        nearestRoutePoint: (x, y, previous) => this.pathfinder.nearest(x, y, previous),
        animate: (zone, image, x, y, palette) => this.animate(zone, image, x, y, palette),
        // The two ways a *game* script takes something off the screen, and
        // neither was connected: the hooks are optional, so both opcodes
        // called nothing and reported nothing. `stopAnimate` names one sprite
        // in one zone; `o_killAnimate` clears the lot, which is the same reset
        // the drawing bytecode's `RESET` performs.
        stopAnimate: (zone, spriteId) => {
          this.zones.get(zone)?.stopSprite(spriteId);
        },
        resetSprites: () => {
          for (const machine of this.zones.values()) machine.clearSprites();
        },
        // A sync is global — the reference keeps one wait table for the whole
        // game — so a sync a game script raises wakes sprites in every loaded
        // zone, exactly as one raised by a drawing script does.
        raiseSync: (id) => {
          for (const machine of this.zones.values()) machine.wakeSync(id);
        },
        playMusic: (track) => this.playMusic(track),
        playSpeech: (id) => this.playSpeech(id),
        stopSpeech: () => this.sound.stopSpeech(),
        speechActive: () => this.sound.speechActive,
        playEffect: (number) => this.playEffect(number),
        loadVideo: (name) => {
          this.pendingVideo = name;
        },
        playVideo: () => this.playPendingVideo(),
      },
      game.strings,
      Math.random,
      {
        subroutine: (id) =>
          this.tableSource.subroutinesFor(id)?.subroutines.find((each) => each.id === id),
        enterSubroutine: (id) => {
          // The effects bank travels with the code, on this release: a jump to a
          // non-resident Subroutine is what says which part of the game is now
          // running, and the reference reloads that part's table — and swaps its
          // sounds — on **every** such jump (`subroutine.cpp:378`), not only the
          // first. So this follows the jump, not the one-time lookup above; a
          // swap hung on the cached lookup froze the bank on whichever table was
          // warmed up last, which is why Simon 2's opening asked for sixteen
          // effects by number and every one answered "no effect N in the
          // resource" while five banks of two hundred sat unread.
          //
          // **Two routes to the same bank, because AGOS has two packagings.**
          // Simon 1's Windows release ships `SFXXXX02`…`SFXXXX29` beside the
          // game, one per `TABLES` file, and `effectsFor` hands the bytes over.
          // Simon 2 keeps its banks *in the archive* and the reference indexes
          // them by the table file's own number —
          // `_gameOffsetsPtr[atoi(filename + 6) - 1 + _soundIndexBase]`
          // (`subroutine.cpp:379`) — so `ZoneSource.sound` is asked instead.
          const number = this.tableSource.tableNumberFor(id);
          if (number === undefined || number === this.tableEffectsNumber) return;
          const bank = this.tableSource.effectsFor(id) ?? this.zoneSource.sound?.(number - 1);
          if (!bank) return;
          this.tableEffectsNumber = number;
          this.tableEffects = readEffectsIndex(bank);
          this.log(`AGOS effects: ${this.tableEffects.entries.length} sounds for this table`);
        },
        string: (id) => {
          const held = this.tableSource.stringsFor(id);
          return held ? held.lines[id - held.min] : undefined;
        },
      },
    );
    // The verbs this game's table dispatches on, read out of the table rather
    // than written down — a hard-coded list would be English, would be Simon
    // 1's, and would be a second copy of what the data states.
    //
    // **This is a superset of the player's bar, deliberately.** Simon 1's demo
    // yields 33 verbs where the on-screen bar has about nine; the bar uses the
    // set only to refuse a verb no guard could match, and a superset refuses
    // nothing legitimate. Which nine are player-facing, and where they sit, is
    // not established — see `world/verbBar.ts`.
    this.verbBar = new VerbBar(dispatchableVerbsFrom(game.subroutines));
    this.input = new AgosInput({
      verb: (verb, noun1, noun2) => {
        // A box that names its own verb is a complete command already, and
        // goes straight through: this is the inventory and the room's own
        // clickable things, which the game's scripts defined with the verb
        // baked in. The bar is for the other half — a player choosing a verb
        // and then choosing what to point it at.
        this.runCommand(verb, noun1, noun2);
      },
      click: (x, y) => this.click(x, y),
      key: (key) => this.handleKey(key),
      rightClick: () => this.rightClick(),
    });
    // The video's three connections to the rest of the Engine, made once at
    // construction rather than per video, so a sequence that fails to open
    // reports through the same channel as one that plays.
    this.video.onPalette = (rgb) => this.palette.setFromClut(rgb);
    this.video.onPaletteRestored = (rgb) => this.palette.setFromClut(rgb);
    this.video.onAudio = (audio) => {
      this.sound.playVideoAudio(audio.samples, audio.sampleRate);
    };
    this.video.onLog = (message) => this.log(message);

    // Simon's layout: a room band with the verb list and inventory below it.
    // ADR 0007's data-driven layout covers it without a family branch. AGOS 2
    // draws its interface into the scene instead, so its room band is the whole
    // screen — the same call, a different number.
    this.screen.setLayout(0, wide ? size.height : 134);

    // **The drawing windows Simon starts with**, hardcoded in the reference as
    // `initialVideoWindows_Simon` and not defined by any script — so a map that
    // waited for a script to fill it left window 4, the play area, undefined,
    // and a room drawn into it clipped against the whole screen and painted over
    // the interface band. Window 4 is 134 rows tall: the interface below it
    // survives a room change because the room is cut to those rows. Widths and
    // x are in sixteens of a pixel, the units this machine's clip already reads.
    if (agosTarget.version === 'Simon1' || agosTarget.version === 'Simon2') {
      this.windows.set(0, [0, 0, 20, 200]);
      this.windows.set(1, [0, 0, 3, 136]);
      this.windows.set(2, [17, 0, 3, 136]);
      this.windows.set(3, [0, 0, 20, 200]);
      this.windows.set(4, [0, 0, 20, 134]);
    }
  }

  static async create(source: DataSource, options: AgosEngineOptions = {}): Promise<AgosEngine> {
    const detection = await detectAgosGame(source);
    const bytes = await source.read(detection.baseFile);
    if (!bytes) throw new Error(`AGOS base file ${detection.baseFile} could not be read.`);

    const game = readGamePc(bytes, detection.target);

    // Whichever layout this Version keeps its graphics in — an archive for the
    // Simons, loose numbered files for Elvira and Waxworks (ADR 0030). A game
    // with neither draws nothing, which is normal for a bare GAMEPC dump.
    const zoneSource = await readZoneSource(source, detection.target.version);
    // The other half of the game's code, and the half its first line is in.
    // Read after the zones because the archive it addresses through is the
    // zones' archive: one file open, one offset table, five kinds of resource.
    const tableSource = await readTableSource(source, detection.target, zoneSource.archive);
    if (tableSource.tables.length > 0 || tableSource.texts.length > 0) {
      options.onLog?.(
        `AGOS tables: ${tableSource.tables.length} subroutine file(s), ` +
          `${tableSource.texts.length} local-string file(s)`,
      );
    }
    options.onLog?.(
      `AGOS ${detection.target.version} (${detection.target.releaseKind}), ` +
        `${game.items.length} items, ${game.subroutines.subroutines.length} subroutines, ` +
        `identified by ${detection.identification}`,
    );
    const archiveName =
      source.list().find((name) => /\.gme$/i.test(name.split(/[\\/]/).pop() ?? name)) ?? '';
    const archiveBytes = archiveName ? ((await source.read(archiveName))?.length ?? 0) : 0;

    /**
     * A talkie's speech file, where there is one. Its index is *not* the
     * archive's: the size is in the second word rather than the first, and
     * reading it the archive's way puts every offset almost right.
     *
     * Which file it is comes from `audioFiles.ts`, which the importer and the
     * editor's folder reader ask as well — see there for why the effects
     * resource has to be excluded by name and why the re-encoded formats
     * count.
     */
    const speechName = speechFileIn(source.list());
    const speechBytes = speechName ? await source.read(speechName) : null;
    const speech = speechBytes && speechBytes.length > 8 ? readSpeechIndex(speechBytes) : undefined;

    // The numbered sound effects, which are a separate resource with the same
    // container. Absent on every floppy release, which is the normal case
    // rather than an error — the two effect opcodes then name themselves
    // through the host seam instead of doing nothing.
    const effectsName = effectsFileIn(source.list());
    const effectsBytes = effectsName ? await source.read(effectsName) : null;
    const effects =
      effectsBytes && effectsBytes.length > 8 ? readEffectsIndex(effectsBytes) : undefined;
    if (effects) options.onLog?.(`AGOS effects: ${effects.entries.length} sounds`);

    // The font, out of an interpreter executable if the folder has one. AGOS
    // keeps its font in the interpreter rather than in the data a player owns,
    // so this is the only place it can come from (ADR 0032) — and a folder with
    // no executable is the normal case rather than an error.
    const font = await findFontBeside(source, options.onLog);

    // Simon 2's inventory icons live in a loose `ICON.DAT` beside the game,
    // read whole with no header (`loadIconFile`, `icons.cpp:44`). Loaded here
    // for any game that ships one; only Simon 2's draw path (`drawIcons`) reads
    // it, because the file's layout — two LE16 stream offsets per icon, 20-wide
    // cells — is that Version's. A folder without one is normal, not an error.
    const iconName = source
      .list()
      .find((name) => /^icon\.dat$/i.test(name.split(/[\\/]/).pop() ?? name));
    const iconFile = iconName ? ((await source.read(iconName)) ?? null) : null;
    if (iconFile) options.onLog?.(`AGOS icons: ${iconName} (${iconFile.length} bytes)`);

    // Which way this release lays its text out, read from the release's own
    // words. On the release rather than in the Target, which is ADR 0028's
    // whole point: nothing above here has to know that Hebrew Simon exists.
    const direction = readTextDirection(game.textBytes);
    options.onLog?.(`AGOS ${describeTextDirection(direction)}`);

    return new AgosEngine(
      game,
      detection,
      detection.target,
      bytes,
      zoneSource,
      tableSource,
      speech,
      effects,
      source,
      font,
      direction,
      iconFile,
      options.onLog,
      {
        baseFile: detection.baseFile,
        baseBytes: bytes.length,
        archiveFile: archiveName,
        archiveBytes,
      },
    );
  }

  get gameId(): string {
    return `agos-${this.detection.target.version.toLowerCase()}`;
  }

  get targetName(): string {
    return describeTarget(this.target);
  }

  get target(): Target {
    return {
      engine: 'agos',
      version: this.agosTarget.version,
      releaseKind: this.agosTarget.releaseKind,
      platform: this.agosTarget.platform,
      identification: this.detection.identification,
    };
  }

  /** AGOS has no room number: where the player is *is* an item. */
  get currentRoom(): number {
    return this.state.parentOf(this.state.me);
  }

  get ticksPerStep(): number {
    return 1;
  }

  /**
   * Starts the game, in the order the reference starts it.
   *
   * Two moves rather than one, and the pair is the whole of an AGOS boot:
   *
   * - **Subroutine 1 is queued, not called.** It is the game's own heartbeat,
   *   and it re-queues itself; calling it here would run one tick's worth of
   *   the world before anything had been drawn and then never run it again.
   * - **Subroutine 101 is called.** That is the game's opening — it loads the
   *   first zone, starts the music and puts Simon in the woods.
   *
   * Neither is in `GAMEPC`. Both are in `TABLES01`, reached through
   * `resource/tableSource.ts`, and this used to call `run(1)` and stop: the
   * number was right, the file it lives in was not being read, and the engine
   * correctly reported that it had executed nothing.
   */
  boot(): void {
    this.state.timeEvents.push({ due: 0, subroutine: 1 });
    // **Started rather than run**, which is the whole of the difference between
    // an intro that plays and one that has already finished. Subroutine 101
    // blocks — on a screen copy, then on a sync, then on the next picture — and
    // `step` is what lets it.
    this.task = this.interpreter.begin(101, 'the opening');
    this.booted = true;
  }

  step(): void {
    this.frame += 1;
    // A video stops the world. In the original a script asks for one and does
    // not continue until it ends, because playback runs its own loop; here the
    // host drives one loop, so "the script blocks" is "the Engine steps the
    // video instead of the world" — including while the file is still being
    // fetched, which the original never had to think about.
    if (this.video.active) return;

    // Both clocks, advanced before the scripts run so a wait set this frame is
    // not satisfied by the same frame that set it.
    //
    // **The seconds clock has to move even while a script is suspended**, and
    // used to move only when a time event was taken. A script waiting on speech
    // waits against this clock, so freezing it while a script waited meant the
    // wait could never end: the game stopped mid-sentence at one second past
    // boot and stayed there.
    //
    // AGOS counts in seconds, the shell in ticks. Sixty of one to the other,
    // which is an assumption rather than a reading — no game data has been
    // checked against it, and a game whose timers feel wrong should suspect
    // this line first.
    this.state.vgaTicks = this.frame;
    this.state.clock = this.frame / 60;

    // The script that is already running gets the frame first. It may finish,
    // suspend again, or do nothing at all because what it is waiting for has
    // not arrived — and doing nothing is the common case and the point.
    if (this.task) {
      this.interpreter.advance(this.task);
      if (this.task.done) this.task = null;
    }

    // Time events are held back while a script is running, which is the
    // reference's own behaviour: `invokeTimeEvent` returns without doing
    // anything while a script is mid-flight, because a timer that fired into a
    // running script would share its item registers.
    //
    // **Taken one at a time and run as a task**, not run to completion here.
    // Simon 1's queue fires the Subroutine that puts up the intro's eleven
    // pictures, so running a due event inside `runDueEvents` drained every wait
    // it set — and the pacing was there and unreachable by the one script that
    // needed it.
    if (this.task) return;

    // Simon 2's walk channel, variable 249, drained *before* 254 — the order of
    // `hitarea_stuff_helper_2`. This is the whole of how a click leaves a room:
    // the walk sets 249 to its junction-crossing Subroutine when the actor
    // arrives, and an idle pass that only ever read 254 left Simon standing on
    // the boundary with the crossing queued and nothing to run it. Gated to the
    // families that treat 249 as a channel; to the rest it is a plain variable.
    if (pollsSecondSubroutineChannel(this.agosTarget.version)) {
      const walk = this.interpreter.takeQueuedSubroutine(WALK_SUBROUTINE_VARIABLE);
      if (walk !== null) {
        this.task = this.interpreter.begin(walk, `walk queue: subroutine ${walk}`);
        if (this.task) {
          this.interpreter.advance(this.task);
          if (this.task.done) this.task = null;
        }
        return;
      }
    }

    // The Subroutine a script asked for by leaving its number in variable 254.
    // Taken before the timers, which is the reference's order in
    // `hitarea_stuff_helper`: a script that has just queued a scene means it to
    // run next, not after whatever the clock happens to make due first.
    const queued = this.interpreter.takeQueuedSubroutine();
    if (queued !== null) {
      this.task = this.interpreter.begin(queued, `queued: subroutine ${queued}`);
      if (this.task) {
        this.interpreter.advance(this.task);
        if (this.task.done) this.task = null;
      }
      return;
    }

    const due = this.interpreter.takeDueEvent(this.frame / 60);
    if (due === null) return;
    this.task = this.interpreter.begin(due, `time event: subroutine ${due}`);
    if (this.task) {
      this.interpreter.advance(this.task);
      if (this.task.done) this.task = null;
    }
  }

  render(): void {
    if (this.video.active) {
      this.screen.pixels.fill(0);
      this.video.advance(this.screen);
      return;
    }
    // The scene back, then the sprites over it. Not a clear: see
    // {@link setWindowImage} for why a cleared framebuffer loses the room.
    this.screen.pixels.set(this.background);
    // A scrolling room's backdrop is re-cut to the current scroll here, over
    // the copy just laid down, so a change in variable 251 moves the room the
    // next frame — the sprites below are drawn shifted by the same offset.
    if (this.wideBackdrop) {
      // Clamp the scroll to what the room can show before cutting the window,
      // and write it back so a later reader sees the same bounded value the
      // reference keeps in _scrollX.
      const scrollX = Math.max(0, Math.min(this.scrollXMax, this.state.read(251)));
      this.state.write(251, scrollX);
      blitWideBackdrop(
        this.screen.pixels,
        this.screen.width,
        this.screen.height,
        this.wideBackdrop,
        scrollX,
      );
    }
    // `tick` rather than `step`, which is the difference between a scheduler
    // with a clock and one without. `step` runs every sprite that is not
    // asleep and never advances the clock — so the first `DELAY` any sprite
    // reached put it to sleep until a tick that never came, and a game whose
    // every animation starts with a delay froze on its first frame.
    // **Run every zone, then draw them all together.** A zone is where a
    // sprite's pixels live and not where it stands in the z-order: the
    // reference keeps one sprite array for the whole game and draws it in
    // priority order, so running and drawing are two passes here rather than
    // one per zone. See {@link paintZoneSprites}.
    for (const machine of this.zones.values()) machine.runFrame();
    paintZoneSprites(this.zones.values());
    this.drawIcons();
    this.drawText();
  }

  /**
   * Draws the words the game has asked to show.
   *
   * Nothing is drawn without a font, and that is the honest outcome rather than
   * a degraded one: AGOS keeps its font in the interpreter executable, a folder
   * of game data alone has none, and a row of boxes would turn that fact into
   * something that looks like a rendering fault (ADR 0032). `describeStatus`
   * carries the sentence a player needs instead.
   */
  /**
   * Points the chosen verb at a thing, and runs the command when it is whole.
   *
   * Returns what happened rather than a boolean, because "the verb needs a
   * second thing" is a real outcome a surface has to show — a player who has
   * chosen "Give" and clicked a coin needs to see that the coin is held and
   * something else is wanted, and a bare false would look like a click that
   * did nothing.
   */
  pointVerb(noun: number): ReturnType<VerbBar['point']> {
    const action = this.verbBar.point(noun);
    if (action.kind === 'run') {
      this.runCommand(action.verb, action.noun1, action.noun2);
    }
    return action;
  }

  /**
   * Which verbs a player can issue right now.
   *
   * The question the static read could not answer: `dispatchableVerbsFrom`
   * gives the verbs the table dispatches on, and the player-facing subset is
   * decided at run time by the boxes a game's Subroutines create. A snapshot,
   * because it changes as scripts enable and disable them.
   */
  /**
   * Issues a command, as a script that may block.
   *
   * **Refused while another script is running**, which is the reference's
   * `permitInput`/`_inCallBack` pair rather than a limitation invented here: a
   * game takes no input while a Subroutine is mid-flight, because the two would
   * share the item registers and the sync set. A player clicking during a
   * cutscene is not a rare case — it is how a player skips one — so the answer
   * is a plain false rather than a queue that would run the command a second
   * later against a world that had moved.
   */
  private runCommand(verb: number, item1: number, item2: number): boolean {
    if (this.task) return false;

    /**
     * **The verb table matches on an item's *noun*, not its number**, and this
     * used to pass the number.
     *
     * `checkIfToRunSubroutineLine` compares a guard's two nouns against
     * `_scriptNoun1` and `_scriptNoun2`, which `handleVerbClicked` takes from
     * `_subjectItem->noun` and `_objectItem->noun` — an index into the game's
     * own string pool, not an item id. So every guard that named a *particular*
     * thing compared an item number with a noun index and declined, and only
     * the wildcard lines ever ran.
     *
     * Setting the two registers is the other half of the same function, and it
     * was missing entirely: a script asking about the subject saw whatever the
     * last one had left there. Simon 1's walk handler asks
     * `o_isObject item:special(1)` before it does anything, so a stale subject
     * sent a floor click down the branch for looking at a thing.
     */
    this.state.subjectItem = this.dereference(item1);
    this.state.objectItem = this.dereference(item2);
    const task = this.interpreter.beginVerb(
      verb,
      this.nounOf(this.state.subjectItem),
      this.nounOf(this.state.objectItem),
    );
    if (!task) return false;
    this.task = task;
    // Advanced once here so a command that does not block has happened by the
    // time the click returns, which is what a surface reporting the outcome
    // needs.
    this.interpreter.advance(task);
    if (task.done) this.task = null;
    return true;
  }

  /**
   * The item a box refers to, resolving the ones that stand for something.
   *
   * A text-box hit area refers to a *slot* in the room's own descriptions
   * rather than to anything in the item tree, which this engine spells as a
   * negative item. The reference gives those boxes `_dummyItem2` and
   * `handleVerbClicked` maps it to the player — so a click on the scenery is a
   * command about the player, and the words come from the slot.
   */
  private dereference(item: number): number {
    if (item < 0) return this.state.me;
    return item;
  }

  /** An item's noun, which is what a verb-table guard is written against. */
  private nounOf(item: number): number {
    if (item <= 0) return -1;
    return this.state.items[item]?.noun ?? -1;
  }

  playerVerbs(): ReturnType<typeof reachableVerbs> {
    return reachableVerbs(this.state.hitAreas.all(), dispatchableVerbsFrom(this.game.subroutines));
  }

  /**
   * Draws Simon 2's inventory icons — the last AGOS interface to paint anything.
   *
   * Simon 1 lays its verb strip out as text through the font; Simon 2 makes its
   * bar a grid of *icon buttons* blitted from `ICON.DAT`, and until this drew
   * them the bottom band (rows 135-199) was black — a player had to know where
   * the invisible boxes were.
   *
   * Rebuilt every frame like {@link drawText}, because {@link render} rebuilds
   * the whole screen from the background and the zones each tick; an icon drawn
   * once would be painted over on the next frame.
   *
   * Transcribed from `AGOSEngine::drawIconArray` (`icons.cpp:491`): Simon 2's
   * cell is 100x40 at an icon size of 20, so five icons across and two rows
   * down. The container's children are walked by {@link iconContainerChildren},
   * and one is an icon when its **object** sub-structure has the `kOFIcon` flag
   * (bit 4, `0x10`) set; the icon number is that object's value for the same bit.
   *
   * **The icon comes from the object flags, not from user flag 7.** Simon 2
   * inherits `AGOSEngine_Elvira2::hasIcon`/`itemGetIconNumber` — Waxworks,
   * Simon 1 and Simon 2 do not override them (`agos.h`), so the base
   * `getUserFlag(item, 7)` reading is only reached by games that never draw an
   * icon. The Elvira 2 version reads the object child: `hasIcon` is
   * `objectFlags & kOFIcon`, and the number is `objectFlagValue[offs]` where
   * `offs` counts the set flag bits below `kOFIcon` (`items.cpp:49-67`). Those
   * are exactly {@link AgosState.objectFlag}`(id, 4)` and
   * {@link AgosState.objectValue}`(id, 4)`, which count bits the same way.
   *
   * Gated to Simon 2 by Version: the margins (a fixed 110), the 20-wide cell and
   * the two-LE16-offsets-per-icon table are that Version's, and Simon 1's icon
   * path is a different geometry this must not disturb.
   */
  private drawIcons(): void {
    if (this.agosTarget.version !== 'Simon2') return;
    const request = this.state.icons;
    if (!request || !this.iconFile) return;

    const window = this.state.windows.get(request.window & 7);
    if (!window) return;

    const pitch = this.screen.width;
    const pixels = this.screen.pixels;

    // The panel behind the icons: the window's own fill colour, recovered from
    // `o_defWindow`'s last operand. Without it the icons float on black. The
    // rectangle is the window's, whose x/width/height are in 8-pixel cells and
    // whose y is already in pixels (see `AgosWindow`).
    if (window.fillColour !== 0) {
      const left = window.x * 8;
      const top = window.y;
      const right = Math.min(this.screen.width, left + window.width * 8);
      const bottom = Math.min(this.screen.height, top + window.height * 8);
      for (let py = Math.max(0, top); py < bottom; py += 1) {
        pixels.fill(window.fillColour, py * pitch + Math.max(0, left), py * pitch + right);
      }
    }

    // Simon 2's grid: 100 wide by 40 tall in steps of 20 — five across, two down.
    const cellWidth = 100;
    const cellHeight = 40;
    const iconSize = SIMON2_ICON_WIDTH;

    let xPos = 0;
    let yPos = 0;
    for (const itemId of this.iconContainerChildren(request.container)) {
      const item = this.state.items[itemId];
      if (!item) continue;
      // The class filter `o_doClassIcons` set, and the icon flag. A mask of 0
      // means "no filter", matching every item. `kOFIcon` is bit 4 (0x10).
      if (request.classMask !== 0 && (item.classFlags & request.classMask) === 0) continue;
      if (!this.state.objectFlag(itemId, 4)) continue;
      const icon = this.state.objectValue(itemId, 4);

      drawSimon2Icon(pixels, this.iconFile, icon, xPos, yPos, window.y, pitch);

      xPos += iconSize;
      if (xPos >= cellWidth) {
        xPos = 0;
        yPos += iconSize;
        // Two rows fill the cell; the rest would need the scroll arrows, which
        // are the standing gap (see the run report) and not drawn here.
        if (yPos >= cellHeight) break;
      }
    }
  }

  /**
   * The items a container directly holds, by the **parent pointer** rather than
   * the on-disk `child`/`next` chain.
   *
   * The reference walks `itemRef->child` then `->next`, but this model does not
   * maintain that chain as items move: `AgosState.place` sets an item's parent
   * and leaves the links alone, because they are the frozen on-disk structure
   * kept for writeback (ADR 0030). So containment *now* is what the parent
   * pointers say — the same source `weigh` and `childrenOf` read — and walking
   * the stale chain would draw the authored inventory, not the current one.
   *
   * The order is item-number order rather than the sibling order the chain
   * would give. That decides which cell an icon lands in and is the one place
   * this diverges from the reference; it is deterministic and the model has no
   * live sibling order to offer instead.
   */
  private *iconContainerChildren(container: number): Iterable<number> {
    for (let id = 0; id < this.state.items.length; id += 1) {
      if (this.state.items[id] && this.state.parentOf(id) === container) yield id;
    }
  }

  private drawText(): void {
    if (!this.font || this.state.onScreen.length === 0) return;

    const window = this.state.windows.get(this.state.currentWindow) ?? this.defaultWindow();
    drawTextWindow(this.screen, this.state.onScreen, glyphsOf(this.font), {
      window,
      colour: this.state.textColour || 15,
      direction: this.textDirection.direction,
      glyphWidth: this.font.width,
      lineHeight: this.font.height,
    });
  }

  /**
   * Where text goes before a script has defined a window.
   *
   * A fallback said out loud rather than a layout: the games define their own
   * windows and this is only reached before the first `o_defWindow`, which in
   * practice is the opening moments of a game and a stall report.
   */
  private defaultWindow(): AgosWindow {
    const columns = Math.floor(this.screen.width / (this.font?.width ?? 8));
    const lineHeight = this.font?.height ?? 8;
    const rows = isAgos2(this.agosTarget.version) ? 4 : 8;
    return {
      x: 0,
      y: Math.max(0, this.screen.height - rows * lineHeight),
      width: columns,
      // Rows, not pixels: see `AgosWindow.height`.
      height: rows,
    };
  }

  /**
   * Plays the video `off_loadVideo` named, if there is one and it can be found.
   *
   * The world is stopped from the moment the file is asked for, which is what
   * makes this look synchronous to the script that asked: it ran an instruction
   * and the next thing it sees is the frame after the cutscene.
   */
  private playPendingVideo(): boolean {
    const name = this.pendingVideo;
    if (name === null) {
      this.log('A script asked to play a video without naming one first');
      return false;
    }
    if (this.video.active) {
      this.log(`A script asked to play ${name} while ${this.video.playing} is playing; ignored`);
      return false;
    }
    this.pendingVideo = null;
    this.video.beginLoad(name, this.palette.snapshot());
    void this.openVideo(name);
    return true;
  }

  /**
   * Finds and opens a video file, or gives up on it by name.
   *
   * The candidates are tried in order because the games name a video with and
   * without its extension in different places, and a name that is absent costs
   * one lookup.
   */
  private async openVideo(name: string): Promise<void> {
    for (const candidate of videoFileCandidates(name)) {
      let bytes: Uint8Array | null;
      try {
        bytes = await this.source.read(candidate);
      } catch {
        // A source that throws on a name it does not have is the same situation
        // as one that answers null, and a cutscene is not worth a crash.
        bytes = null;
      }
      if (!bytes) continue;
      if (!this.video.open(bytes)) this.reportedVideos.add(candidate);
      return;
    }
    this.video.fail(`${name} is not beside the game, so the sequence is skipped`);
  }

  /**
   * Loads a graphics zone: its scripts and its pixels.
   *
   * The two are separate resources in the archive, and their numbering is
   * arithmetic rather than a lookup — entry `zone * 2` holds the scripts and
   * `zone * 2 + 1` holds the pixels. Returns false when the zone is not there,
   * which a game with no archive always is.
   */
  loadZone(zone: number): boolean {
    if (this.zones.has(zone)) return true;

    const resources = this.zoneSource.zone(zone);
    if (!resources) return false;

    const machine = new VgaMachine(
      resources.scripts,
      resources.pixels,
      this.vgaTable,
      {
        width: this.screen.width,
        height: this.screen.height,
        pixels: this.screen.pixels,
        // What a masked draw reveals. The room, as `setWindowImage` left it.
        background: this.background,
        windows: this.windows,
        setPalette: (base, rgb) => {
          for (let index = 0; index < rgb.length / 3; index += 1) {
            this.palette.setColor(
              base + index,
              rgb[index * 3] ?? 0,
              rgb[index * 3 + 1] ?? 0,
              rgb[index * 3 + 2] ?? 0,
            );
          }
        },
      },
      // The world behind the drawing bytecode, rather than the recorder the
      // machine defaults to. A third of a Version's VGA opcodes ask about
      // items, hit areas, speech and the animation table, and with a recorder
      // under them every one of those questions is answered "no" — a script
      // asking whether the lantern is in this room takes the same branch for
      // ever. `world/engineVgaHost.ts` says which six of the ten are real and
      // why the other four are named instead.
      new EngineVgaHost({
        world: this.state,
        hitAreas: this.state.hitAreas,
        pathfinder: this.pathfinder,
        animations: this.vgaFileOf(resources.scripts).animations,
        sound: this.sound,
        playEffect: (effect) => this.playEffect(effect),
        loadImage: (id) => {
          // A zone number is an image number's own hundreds column, which is
          // the arithmetic `drawImage` already relies on.
          this.drawImage(Math.floor(id / 100), id);
        },
        // A window's backdrop is an *image*, so this is the image table's
        // side of the split `animate` explains. The window number is not
        // used yet: this engine draws one band and a second window would
        // need a clip rectangle the machine does not carry.
        setWindowImage: (window, image) => {
          this.setWindowImage(window, image);
        },
        // A script in one zone routinely starts a sprite in another. The zone
        // is the machine's, decided from the opcode's shape — an operand in
        // Simon 2, the id's hundreds column in Simon 1 — so it arrives here
        // rather than being re-derived. See `gfx/vgaHost.ts`'s
        // `startSpriteInZone`.
        startSprite: (zone, spriteId, x, y, palette) => this.animate(zone, spriteId, x, y, palette),
        // `STOP_ANIMATE`. Simon 2 names the zone (its ids are zone-local);
        // Simon 1 gives an id alone and means every zone, because its sprite
        // ids are global. The machine that ran the opcode has already halted
        // its own copy in the second case.
        stopSprite: (spriteId, zone) => {
          if (zone === undefined) {
            for (const other of this.zones.values()) other.stopSprite(spriteId);
          } else {
            this.zones.get(zone)?.stopSprite(spriteId);
          }
        },
        // A sync is global: it wakes sprites in every loaded zone, not only
        // in the one that raised it.
        syncRaised: (id) => {
          for (const other of this.zones.values()) other.wakeSync(id);
        },
        // `RESET` ends a scene, and a scene's sprites are spread across
        // every zone it used.
        resetSprites: () => {
          for (const other of this.zones.values()) other.clearSprites();
        },
        unsupported: this.vgaUnsupported,
      }),
      vgaLayoutFor(this.agosTarget.version),
    );
    // **The variables are the game's, not the machine's own.** One array in
    // the reference, and the two bytecodes talk through it: Simon's sprite
    // reads its position out of variables 15 and 16, and the game script is
    // what puts it there. See `VgaMachine.variables`.
    machine.variables = this.state.variables;
    // The bits are the game's too, and for the same reason: `setBitFlag` is one
    // bank the whole engine shares, so a bit raised by a sprite in one zone is
    // the bit a sprite in another zone lowers. See `VgaMachine.bits`.
    machine.bits = this.state.bits;
    this.zones.set(zone, machine);
    return true;
  }

  /**
   * Runs the script an image entry names, which is how anything is drawn.
   *
   * A graphics resource is a table of entries pointing at scripts rather than a
   * bitmap (ADR 0027's amendment), so "draw image 12" is "run the script entry
   * 12 names" and the pixels are whatever that script places.
   */
  drawImage(zone: number, image: number): boolean {
    if (!this.loadZone(zone)) return false;
    const machine = this.zones.get(zone);
    const resources = this.zoneSource.zone(zone);
    if (!machine || !resources) return false;

    const entry = this.vgaFileOf(resources.scripts).images.find((each) => each.id === image);
    if (!entry) return false;
    machine.run(entry.scriptOffset);
    return true;
  }

  /**
   * Puts a picture up, and remembers it as the scene behind the sprites.
   *
   * Two things rather than one, and the second is what makes the first last.
   * The screen is **persistent** in AGOS: a backdrop is painted once when a
   * room is entered and the sprites are re-drawn over it every frame. A
   * renderer that cleared the framebuffer each frame — which this one did —
   * threw the room away one frame after it arrived, so the only thing ever
   * visible was whatever a sprite had drawn in the last sixteen milliseconds.
   *
   * So the backdrop is kept in {@link background}, and `render` restores it
   * before the sprites go down. That is `restoreBackGround` in the reference,
   * and it is also what gives a **masked** draw something real to reveal.
   */
  setWindowImage(window: number, image: number): boolean {
    const zone = Math.floor(image / 100);
    const machine = this.loadZone(zone) ? this.zones.get(zone) : undefined;
    const resources = this.zoneSource.zone(zone);
    if (!machine || !resources) return false;

    // **The window is cleared to the colour the image entry carries**, before
    // the picture's script runs. `VgaEntry.colour` has been read all along and
    // never used, so every scene drew over whatever the last one left — and by
    // the fourth screen of Simon 1's intro the display held four of them.
    // **The scene as it was, without last frame's words on it.** `render` draws
    // text into the framebuffer after restoring the scene, so the framebuffer
    // still holds it when a script puts up the next picture — and the snapshot
    // below would bake it in. By the middle of Simon 1's intro four sentences
    // were painted permanently over the credits.
    this.screen.pixels.set(this.background);

    const entry = this.vgaFileOf(resources.scripts).images.find((each) => each.id === image);
    if (entry) machine.clearWindow(window, entry.colour ?? 0);

    // **Entering a room resets the scroll**, which is `setImage`'s tail in the
    // reference: `_scrollX = 0` and, unless variable 34 asks to keep it, the
    // mirror in variable 251 too. Without this a non-scrolling room entered
    // after a scrolling one kept the old offset and drew its sprites shifted.
    // A wide backdrop below re-seeds both; a room that fits the screen leaves
    // them zero. The machine's own record is cleared first so this room's
    // wide backdrop, if it has one, is the one the Engine re-blits — not the
    // last room's.
    if (this.state.read(34) >= 0) this.state.write(251, 0);
    machine.wideBackdrop = null;
    machine.scrollXMax = 0;
    this.wideBackdrop = null;
    this.scrollXMax = 0;

    // The mode the thirty-two colour decode is chosen by, held only for the
    // length of this one script — a sprite drawn later in the same zone is
    // still a sprite.
    machine.windowImageMode = true;
    // **Draw into the window the picture is put into**, `_windowNum = mode` in
    // the reference's `setWindowImage`. Window 4 cuts a room to the play area so
    // it does not paint over the interface; window 0 is the whole screen, which
    // is where the interface panel itself goes. Restored afterwards so the
    // room's sprites, windowed by their own scripts, keep theirs.
    const priorWindow = machine.drawWindow;
    machine.drawWindow = window;
    try {
      const drawn = this.drawImage(zone, image);
      if (drawn) {
        this.background.set(this.screen.pixels);
        // A room wider than the screen keeps its decoded backdrop for `render`
        // to re-cut as the scroll moves, rather than re-running this script.
        this.wideBackdrop = machine.wideBackdrop;
        this.scrollXMax = machine.scrollXMax;
      }
      return drawn;
    } finally {
      machine.windowImageMode = false;
      machine.drawWindow = priorWindow;
    }
  }

  /**
   * Starts an animation: a sprite with a script of its own.
   *
   * **The other of a graphics resource's two tables**, and the reason this is
   * not `drawImage`. A resource holds an *image* table and an *animation*
   * table, keyed by the same kind of number and holding different scripts, and
   * the two opcodes that reach the screen want one each: `o_setImage` puts a
   * backdrop up out of the image table, and `o_animate` starts a sprite out of
   * the animation table.
   *
   * Routing both through the image table is what left Simon 1 black. The
   * scripts were running and asking for animations 130, 1174, 6411 and 6414;
   * zone 1's image table holds one entry, 100, so every request answered false
   * and the animations those numbers name were never looked at.
   */
  animate(zone: number, spriteId: number, x: number, y: number, palette: number): boolean {
    if (!this.loadZone(zone)) return false;
    const machine = this.zones.get(zone);
    if (!machine) return false;
    return machine.startSprite(spriteId, x, y, palette) !== undefined;
  }

  /**
   * Stops one sprite in one zone, the counterpart of {@link animate}.
   *
   * `os2_stopAnimate` and Elvira's `oe1_stopAnimate` were wired to
   * `unloadZone`, which this engine does not act on — so a sprite a script
   * asked to stop kept animating. Simon 2 names the zone the sprite lives in
   * (its ids are zone-local, so the same id runs in many zones and stopping it
   * everywhere would halt the wrong actor); Elvira's ids carry their zone in
   * the hundreds column, which the interpreter passes here the same way.
   */
  stopAnimate(zone: number, spriteId: number): void {
    this.zones.get(zone)?.stopSprite(spriteId);
  }

  /**
   * The graphics resource's tables, decoded once per zone rather than per call.
   *
   * `drawImage` and `animate` both want them and both used to re-read the
   * resource's header on every call — which is a decode of two tables inside a
   * frame, several times a frame.
   */
  private vgaFileOf(scripts: Uint8Array): VgaFile {
    const held = this.vgaFiles.get(scripts);
    if (held) return held;
    const file = readVgaFile(scripts, { layout: vgaLayoutFor(this.agosTarget.version) });
    this.vgaFiles.set(scripts, file);
    return file;
  }

  /**
   * The keyboard cursor over the game's boxes.
   *
   * Rebuilt from the box table on every read rather than kept in step with it,
   * because the game redefines its interface as it moves between rooms and a
   * cached focus order would point at boxes that no longer exist.
   */
  get cursor(): { targets: { id: number; verb: number; item: number }[]; index: number } {
    const targets = this.state.hitAreas
      .all()
      .filter((area) => area.enabled)
      .map((area) => ({ id: area.id, verb: area.verb, item: area.item }));
    if (this.cursorIndex >= targets.length) this.cursorIndex = 0;
    // Read and written through arrow functions, which close over `this`
    // directly — the index has to stay live against the engine, and an aliased
    // local was a second name for the same thing.
    const read = (): number => this.cursorIndex;
    const write = (value: number): void => {
      this.cursorIndex = value;
    };
    return {
      targets,
      get index() {
        return read();
      },
      set index(value: number) {
        write(value);
      },
    };
  }

  /**
   * Every hit area the game's scripts have defined, as the box table holds them.
   *
   * The interface an AGOS game presents is not laid out by this engine — the
   * game's own scripts define the boxes, and a box carries the verb it means
   * and the item it refers to. So a harness asking "is there anything to click
   * yet, and where" has to ask the box table, the same way {@link click} does.
   *
   * Read-only, and the table is asked afresh each call rather than cached, for
   * the reason {@link cursor} gives: a game redefines its interface as it moves
   * between rooms.
   *
   * **Deliberately not a member of `AdventureEngine`.** ADR 0011 caps that
   * seam and six families have left it alone; `SkyEngine.hotspots` answers the
   * same question for Sky and stays off it too.
   */
  boxes(): readonly HitArea[] {
    return this.state.hitAreas.all();
  }

  /**
   * Where every sprite the loaded zones are drawing currently is.
   *
   * AGOS has no "player position" the engine holds: the player is a sprite the
   * drawing bytecode places, and the only honest answer to "did the player
   * move" is "these sprites moved and these did not". Keyed by zone as well as
   * by sprite id because a sprite id means nothing outside the zone it came
   * from — the same reason {@link zones} is a map rather than one machine.
   */
  sprites(): { zone: number; id: number; x: number; y: number }[] {
    const found: { zone: number; id: number; x: number; y: number }[] = [];
    for (const [zone, machine] of this.zones) {
      for (const sprite of machine.sprites) {
        found.push({ zone, id: sprite.id, x: sprite.x, y: sprite.y });
      }
    }
    return found;
  }

  /**
   * Whether a game Subroutine is mid-flight, and so whether input is refused.
   *
   * The same fact {@link runCommand} turns away on, offered read-only: AGOS
   * takes no input while a script is running (`permitInput`/`_inCallBack`), so
   * this is the engine's own answer to "is the player in control".
   *
   * `bin/play-probe.ts` needs it to tell an opening from a game. Simon 1 has
   * its verb strip and a full-screen hit area up within one frame of booting
   * and then spends fourteen thousand frames on the dream sequence — so boxes
   * alone say "interactive" through the whole intro, and the probe measured a
   * cutscene and reported it as the game. A script running is the half of the
   * answer the boxes cannot give.
   *
   * **Deliberately not a member of `AdventureEngine`**, for {@link boxes}'s
   * reason.
   */
  get scriptRunning(): boolean {
    return this.task !== null;
  }

  /**
   * Whether the sequence now playing is one **the game itself** has said may be
   * abandoned.
   *
   * Bit 9, which the reference tests before honouring an Escape. So this is not
   * a policy of this engine's: a sequence carrying something the player has to
   * know is written without the bit, and {@link key} correctly declines to cut
   * it short. Six of Simon 1's Subroutines set it and its opening is not one of
   * them — Simon 2's opening is, which is why one game's intro ends at frame 64
   * under Escape and the other's runs its full fourteen thousand frames.
   *
   * Exists so a headless driver can press Escape exactly where a player who has
   * seen the opening would, and nowhere else. `bin/play-probe.ts` already does
   * this for SCUMM off `scriptState.currentOverride`; this is the same gate for
   * this family, asked of the game rather than assumed.
   *
   * **Deliberately not a member of `AdventureEngine`**, for {@link boxes}'s
   * reason.
   */
  get cutsceneSkippable(): boolean {
    return this.task !== null && this.state.bits.has(CUTSCENE_SKIPPABLE_BIT);
  }

  /**
   * Where the walking character stands, in Simon's two games.
   *
   * **Variables 15 and 16**, and that is not a guess about a pair of slots: the
   * walk sprites read their position straight out of them —
   *
   * ```
   * SET_SPRITE_X var15
   * SET_SPRITE_Y var16
   * ```
   *
   * — and the reference ties the same two to the character rather than to a
   * sprite, keying Simon 2's horizontal scroll on writes to variable 15
   * (`vc40_scrollRight`, `vc41_scrollLeft`). So it is the one place in this
   * family where "where is the player" has an answer the engine holds, which is
   * what `bin/play-probe.ts` needs to say whether a click moved anybody.
   *
   * **In screen pixels, which is not the unit variable 15 holds it in.** A
   * sprite's x is in *eighths* of a pixel-column — `VgaMachine.paint` lands it
   * at `(x - scrollX) * 8`, which is the reference's `(vlut[0] * 2 +
   * state->x) * 8` — while y is in pixels and so is a click. Handing the raw
   * pair back made every answer mixed-unit: a walk the length of Simon 1's
   * first room came out as "the player went 17,61 to 7,69 (13px)", which reads
   * as a walk that barely happened and was eighty pixels across the floor.
   *
   * Null for every other Version, because nothing establishes the pair there
   * and a number this tool cannot vouch for is worse than no number.
   *
   * **Deliberately not a member of `AdventureEngine`**, for {@link boxes}'s
   * reason.
   */
  walkerAt(): { x: number; y: number } | null {
    const version = this.agosTarget.version;
    if (version !== 'Simon1' && version !== 'Simon2') return null;
    return { x: (this.state.variables[15] ?? 0) * 8, y: this.state.variables[16] ?? 0 };
  }

  /**
   * Resolves a click against the boxes the game's own scripts defined.
   *
   * Nothing here knows where the verb list is drawn, and nothing needs to: a
   * box carries the verb it means and the item it refers to, so the interface
   * is whatever the loaded game says it is. Returns false when the click landed
   * on nothing, which is most of the screen most of the time.
   */
  click(x: number, y: number): boolean {
    // The default verb is settled before the click is resolved, which is the
    // reference's order — `resetVerbs` runs at the top of `waitForInput` and
    // the box dispatch below it, so a click on the strip overrides the default
    // it just installed rather than racing with it.
    this.applyDefaultVerb(y);

    const area = this.state.hitAreas.at(x, y);
    if (!area) return false;

    /**
     * **Where the click landed goes into variables 1 and 2**, which is how a
     * floor click becomes a walk.
     *
     * `boxController` writes them in the reference, and Simon 1's walk handler
     * reads them straight back: `os1_getPathPosn 30001, 30002, 6, 7` is *take
     * the x and y out of variables 1 and 2 and give me the nearest route point*.
     * Without this the two variables held whatever the last script had left,
     * so a click anywhere on the floor walked to the same place — or to no
     * place at all.
     */
    this.state.write(CLICK_X_VARIABLE, x);
    this.state.write(CLICK_Y_VARIABLE, y);

    // Which text box was clicked, or that none was. See {@link
    // VERB_TEXT_VARIABLE} for what leaving this unwritten cost. A text-box hit
    // area carries its slot as a negative item (`oww_addTextBox`), which is
    // this engine's spelling of the reference's text-box flag.
    this.state.write(VERB_TEXT_VARIABLE, area.item < 0 ? -1 - area.item : NO_TEXT_BOX);

    /**
     * **Simon's verb strip chooses a verb; it does not issue one.**
     *
     * Boxes 101 to 112 are the strip, and the reference recognises them by
     * exactly that number range — the game's own scripts define them, so the
     * range is a fact about the data rather than a layout this engine imposes.
     * They carry an item (156, the strip itself) alongside their verb, and this
     * used to run the verb *against that item*: clicking "Look at" looked at
     * the verb strip, over and over, and there was no way to point a verb at
     * anything.
     */
    if (area.id >= VERB_STRIP_FIRST_BOX && area.id <= VERB_STRIP_LAST_BOX) {
      this.verbBar.choose(area.verb);
      // `_defaultVerb = 0` in the reference: a verb the player picked is not to
      // be replaced by the default as the pointer moves back over the room, so
      // the default stands down until the command they are building has run.
      this.verbChosenByPlayer = true;
      return true;
    }

    // The verb without the flag bit, because a box carrying the flag would
    // otherwise present a verb number no guard matches.
    const verb = area.verb & VERB_NUMBER_MASK;

    // A box carrying a thing is a noun. With a verb chosen the command is
    // complete and runs; without one the thing is remembered and the surface
    // can say so — which is `pointVerb`'s `idle`, not a failure.
    if (area.item) {
      // A box whose verb carries the flag is a command already made: the verb
      // and the thing it acts on both come from the box, so it runs without
      // consulting the bar at all. This is how the inventory's own items and
      // the exits of a room work.
      if (area.verb & VERB_IMMEDIATE_FLAG) {
        this.runCommand(verb, area.item, -1);
        this.verbChosenByPlayer = false;
        return true;
      }
      const action = this.pointVerb(area.item);
      // A completed command hands the default verb back, which is the reset at
      // the top of the reference's next `waitForInput`. A command still
      // collecting its second thing does not.
      if (action.kind === 'run') this.verbChosenByPlayer = false;
      return true;
    }

    // A box with a verb and nothing to point it at chooses the verb, which is
    // how the inventory arrows and the map screens work — unless a thing is
    // already being held for a verb, in which case the box completes that
    // command instead. The reference's `if (_hitAreaSubjectItem != nullptr)
    // break;`, and without it a two-noun command could never be finished
    // against a box that names only a verb.
    if (verb) {
      const pending = this.verbBar.pending;
      if (pending !== null) {
        this.runCommand(verb, pending, -1);
        this.verbBar.clear();
        this.verbChosenByPlayer = false;
        return true;
      }
      this.verbBar.choose(verb);
      this.verbChosenByPlayer = true;
      return true;
    }
    return false;
  }

  /**
   * Installs the verb the game offers by default, where the player has not chosen.
   *
   * `resetVerbs` and the half of `AGOSEngine_Simon1::handleMouseMoved` that
   * calls it: the default is box 101's verb over the room and box 102's over
   * the panel, and it follows the pointer between the two. See {@link
   * DEFAULT_VERB_BOX_ROOM} for why its absence made every click inert.
   *
   * The reference re-reads the boxes as the pointer moves and this reads them
   * when a click arrives, which is the same answer for a player who moves to
   * the thing before clicking it — and it is the only pointer position this
   * Engine is told about, since the shell reports clicks rather than movement.
   *
   * A disabled box means the game has taken the default away — a screen with no
   * verb bar, a close-up, a menu — so the bar is cleared rather than left
   * holding a verb from the room the player has left.
   */
  private applyDefaultVerb(pointerY: number): void {
    if (this.verbChosenByPlayer) return;
    const id = pointerY >= PANEL_TOP ? DEFAULT_VERB_BOX_PANEL : DEFAULT_VERB_BOX_ROOM;
    const box = this.state.hitAreas.find(id);
    if (!box) return;
    if (!box.enabled) {
      this.verbBar.clear();
      return;
    }
    this.verbBar.choose(box.verb & VERB_NUMBER_MASK);
  }

  /**
   * The right button, whose one job in this family is to cut speech short.
   *
   * A latch on the state rather than an action here, because what it interrupts
   * is a script blocked inside a wait — see `AgosInterpreter.interrupt`.
   */
  rightClick(): void {
    this.state.rightButtonDown = true;
  }

  /**
   * A key, which is either the interface's or the sequence-skipping one.
   *
   * Escape is handled here rather than passed to the keyboard cursor because it
   * is not navigation: it asks the *running script* to stop, and the script
   * reads the request from the state on its next frame.
   */
  private handleKey(key: string): void {
    if (key === EXIT_CUTSCENE_KEY) {
      this.state.exitCutscene = true;
      return;
    }
    this.input.handleKey(key, this.cursor);
  }

  /**
   * A key from outside, the counterpart of {@link click}.
   *
   * The public way to press Escape — how a player skips Simon 2's opening — so
   * a headless driver can reach the room a player acts in rather than only the
   * cutscene that precedes it. Routes to the same {@link handleKey} a live
   * keyboard reaches.
   */
  key(key: string): void {
    this.handleKey(key);
  }

  /**
   * Plays a music track out of the game's own archive.
   *
   * Music sits in the archive like everything else, and which entry a track
   * number means is arithmetic the same way a zone's is. Returns false when the
   * game ships no such track, which is a normal answer.
   */
  playMusic(track: number): boolean {
    const resource = this.zoneSource.music?.(track);
    if (!resource) return false;
    return this.sound.playMusic(resource);
  }

  /**
   * Plays a recorded line.
   *
   * The id comes from the operand a talkie release carries and a floppy one
   * does not — the difference ADR 0027's tripwire fired on, arriving here as
   * the thing it was for. Returns false when the release ships no speech,
   * which is the normal answer for a floppy game.
   */
  playSpeech(id: number): number | null {
    if (!this.speech) return null;
    const recording = this.speech.read(id);
    if (!recording) return null;

    // The length is answered even when nothing is audible, because a script
    // waiting on speech waits the same either way and a talkie played without
    // the pauses runs at a speed it was never written for.
    const decoded = this.sound.decodeSpeech(recording);
    void this.sound.playSpeech(recording);
    return decoded ? decoded.samples.length / decoded.sampleRate : 0;
  }

  /**
   * Plays a numbered sound effect.
   *
   * Two places to look, in the order the releases put them. The per-table bank
   * comes first because it is the *current* one — a release that ships
   * `SFXXXX07` beside its `TABLES07` means the effects of that scene — and the
   * single whole-game resource is the fallback for a release with one.
   *
   * This used to read the graphics archive at the effect number, which is a
   * zone's pixels: it played a picture as audio, or more often played nothing
   * and said nothing.
   */
  playEffect(number: number): boolean {
    const bank = this.tableEffects ?? this.effects;
    const bytes = bank?.read(number);
    // The answer is whether the effect is *in the resource*, not whether an
    // audio device accepted it. `AgosSound.play` returns false with no
    // `AudioContext` — which is every headless run — so returning its result
    // made a caller's "no effect N in the resource" fire for every effect the
    // bank held perfectly well. A found effect is a hit; playing it is
    // best-effort and silent where there is no sink.
    if (!bytes) return false;
    this.sound.playEffect(bytes);
    return true;
  }

  /** The VGA opcode table this Target's graphics scripts decode with. */
  private get vgaTable(): string {
    switch (this.agosTarget.version) {
      case 'Elvira1':
        return 'elvira1';
      case 'Elvira2':
        return 'elvira2';
      case 'Waxworks':
        return 'waxworks';
      case 'Simon1':
        return 'simon1';
      case 'Simon2':
        return 'simon2';
      case 'Feeble':
        return 'feeblefiles';
      case 'PuzzlePack':
        return 'puzzlepack';
    }
  }

  present(context: CanvasRenderingContext2D): void {
    this.screen.present(context, this.palette);
  }

  saveState(name: string): SavedGameEnvelope {
    return saveAgosState(this.state, this.target, this.gameId, name);
  }

  loadState(saved: SavedGameEnvelope): void {
    loadAgosState(this.state, saved as AgosSavedGame, this.target);

    // **Re-enter the room the save was taken in**, which is the load path's
    // second half in the reference (`saveload.cpp:161-165` for Simon 1 and 2):
    // restore the world, then set bit 97 and run subroutine 100. Subroutine 100
    // reads that bit, keeps the scroll (`o_let 34, -1`) and `o_process`es the
    // room's re-entry Subroutine, which is what rebuilds the hit areas and
    // redraws the scene. Without it the script that was mid-flight when the load
    // happened — at boot, the opening — keeps running and walks the player out
    // of the restored room: a save in room 53 ran on to room 171.
    //
    // The running task is dropped first for the same reason the reference is not
    // reached mid-script: a load replaces the world, so whatever was drawing the
    // old one has nothing left to draw.
    this.task = null;
    if (this.agosTarget.version === 'Simon1' || this.agosTarget.version === 'Simon2') {
      this.state.bits.add(RESTORE_REDRAW_BIT);
      this.task = this.interpreter.begin(
        ROOM_REENTRY_SUBROUTINE,
        'restore: re-enter the room via subroutine 100',
      );
    }
  }

  /**
   * An item's name, which is what AGOS has instead of a room name.
   *
   * Derived from the strings the item's own fields index rather than stored,
   * for the reason the Project gives: a stored name would be a second source of
   * truth that export would have to reconcile.
   */
  roomName(room: number): string | undefined {
    const item = this.state.items[room];
    if (!item) return undefined;
    const noun = this.game.strings[item.noun];
    return noun ?? undefined;
  }

  /**
   * What a player should know, which right now is a great deal.
   *
   * The status line exists so a stopped script is distinguishable from a slow
   * one. Here it carries something blunter: the reason the screen is empty is
   * that nothing has been written to draw it, and a player deserves that
   * sentence rather than a black rectangle.
   */
  describeStatus(): string | undefined {
    const unimplemented = this.interpreter.report.unimplemented.length;
    const graphics = [...this.zones.values()].reduce(
      (total, machine) => total + machine.report.unimplemented.length,
      0,
    );
    const parts = [
      this.zones.size === 0
        ? `AGOS graphics are not running: no zone loaded yet (packaging: ${this.zoneSource.layout})`
        : `AGOS graphics: ${this.zones.size} zone(s) running, ${graphics} unimplemented VGA opcode(s)`,
      'AGOS sound is not implemented yet',
      // The font is the one thing a player cannot fix by loading a different
      // folder of game data, so it says what would fix it (ADR 0032).
      this.font
        ? `text drawn from a font found in an interpreter executable, ${describeTextDirection(this.textDirection)}`
        : 'text is collected but not drawn: AGOS keeps its font in the interpreter ' +
          'executable, and none was found beside this game',
    ];
    if (this.video.active) parts.push(`playing ${this.video.playing}`);
    if (this.reportedVideos.size > 0) {
      parts.push(`${this.reportedVideos.size} video(s) in a format this project does not decode`);
    }
    if (unimplemented > 0) parts.push(`${unimplemented} opcode(s) reached with no implementation`);
    if (this.detection.identification === 'narrowed') {
      parts.push(`Version narrowed to ${this.detection.candidates.join(' or ')}`);
    }
    if (this.detection.identification === 'partial') {
      // The Elvira 1 and Waxworks demos, which carry a development build's
      // opcode-name table after the runtime database (#291). It plays; ADR 0030
      // refuses to edit it, because a region this file's model cannot produce
      // makes the whole game uneditable.
      parts.push(
        `${this.detection.baseFile} holds more than the runtime database, so this game ` +
          'plays and is refused for editing',
      );
    }
    return parts.join('; ');
  }

  describeStall(): string[] {
    const report = this.interpreter.report;
    // The last few lines the game asked to show. Nothing draws them yet, and
    // they are the fastest evidence that the interpreter is following the same
    // path the game does — so they belong in a stall report rather than waiting
    // for a font.
    const said = this.state.messages.slice(-3);
    return [
      `AGOS ${this.agosTarget.version}, ${this.agosTarget.releaseKind}`,
      `booted: ${this.booted}`,
      `instructions executed: ${report.executed}, lines stopped on a condition: ${report.linesStopped}`,
      report.unimplemented.length === 0
        ? 'every opcode reached so far is implemented'
        : `unimplemented opcodes reached: ${report.unimplemented.join(', ')}`,
      said.length === 0
        ? 'the game has not asked to show any text yet'
        : `last text the game asked to show: ${said.map((line) => JSON.stringify(line)).join(', ')}`,
      this.font
        ? `font: ${this.font.count} glyphs read from an interpreter executable at offset ` +
          `${this.font.at}, ${describeTextDirection(this.textDirection)}`
        : 'font: none — AGOS keeps its font in the interpreter executable and no ' +
          'executable was found beside this game, so text is collected rather than drawn',
      this.video.active
        ? `video: ${this.video.playing} is playing, and the world is stopped until it ends`
        : 'video: none playing',
    ];
  }

  /**
   * Every recording this game has, listed by number rather than copied.
   *
   * The three kinds arrive by three different routes, because AGOS keeps them
   * in three different places, and all three routes are the ones the running
   * Engine already uses rather than second readings of the same files:
   *
   * - **Speech** is one large file beside the game with an offset table at the
   *   front, already open as {@link speech}.
   * - **Music** sits at a base of its own inside the resource archive. How
   *   many tracks there are is not written down anywhere, so it is the
   *   distance from the music base to whichever base comes next — the same
   *   arithmetic `highestGraphicsZone` does at the other end of the table.
   * - **Effects** come in banks, one per `TABLES` file, by whichever of AGOS's
   *   two packagings this release uses: loose `SFXXXX02` … `SFXXXX29` files
   *   beside Simon 1, archive entries at the sound base for Simon 2.
   *
   * Nothing here keeps any of those bytes. What comes back is an index, and
   * `readTrackBytes` reads a recording out of the folder when one is played or
   * saved — see `authoring/agos/audioList.ts` for why that is the only shape
   * ADR 0010 and ADR 0030 leave open.
   */
  private async listAudio(): Promise<ProjectAudio[]> {
    const names = this.source.list();
    const speechFile = speechFileIn(names);

    const bases = archiveBasesFor(this.agosTarget.version);
    const music: { number: number; bytes: Uint8Array }[] = [];
    if (bases && bases.music > 0) {
      const next = Math.min(
        ...[bases.tables, bases.text, bases.sound].filter((base) => base > bases.music),
      );
      // A Version whose music base is the last one in the table says nothing
      // about where its music stops, and walking to the end of the archive
      // would list its graphics as tracks. Nothing is a better answer.
      if (Number.isFinite(next)) {
        for (let track = 0; track < next - bases.music; track += 1) {
          const bytes = this.zoneSource.music?.(track);
          if (bytes && bytes.length > 0) music.push({ number: track, bytes });
        }
      }
    }

    const effects: AgosEffectBank[] = [];
    for (const entry of this.tableSource.tables) {
      const number = Number(entry.file.trim().replace(/[^0-9]/g, ''));
      if (!Number.isFinite(number) || number <= 0) continue;
      const file = effectsBankFileIn(names, number);
      const bytes = file ? await this.source.read(file) : this.zoneSource.sound?.(number - 1);
      // Eight bytes is two offsets: below that there is no table to read, which
      // is what a table file with no bank of its own looks like. Simon 1's
      // `TABLES01` and `TABLES30` are both that, and neither is a fault.
      if (!bytes || bytes.length <= 8) continue;
      effects.push({ number, ...(file ? { file } : {}), bytes });
    }

    return listAgosAudio({
      speech: this.speech && speechFile ? { index: this.speech, file: speechFile } : undefined,
      effects,
      music,
      archiveFile: this.origin.archiveFile,
    });
  }

  /**
   * Why this game may not be edited, or null when it may.
   *
   * ADR 0029's three conditions, asked before the work rather than discovered
   * by attempting it — and deliberately the same string `toEditableGame`
   * throws, so the two cannot drift.
   */
  describeEditRefusal(): string | null {
    const project = importAgosProject(this.baseFileBytes, this.detection, this.agosTarget);
    if (project.editable.editable) return null;
    return `This AGOS game cannot be edited: ${project.editable.reasons.join('; ')}.`;
  }

  async toEditableGame(options: EditableGameOptions): Promise<EditableGame | null> {
    const refusal = this.describeEditRefusal();
    if (refusal) throw new Error(refusal);

    // The zones come in here and not in `describeEditRefusal`, which only asks
    // whether editing is allowed: probing every zone to answer that would read
    // a game's whole art to decide a boolean.
    const project = importAgosProject(this.baseFileBytes, this.detection, this.agosTarget, {
      zones: this.zoneSource,
      agos2: this.zoneSource.layout === 'agos2',
      // The room list needs each room's own Subroutine, and a room's Subroutine
      // is almost never in `GAMEPC`: Simon 1 keeps all ninety-two in `TABLES01`
      // and up. This is the only place both halves are open at once, which is
      // why the lookup is handed down rather than the reader being reached for
      // inside the importer.
      subroutineFor: (id) =>
        this.tableSource.subroutinesFor(id)?.subroutines.find((each) => each.id === id),
    });
    options.onProgress?.(1, 1, 'AGOS project');

    const audio = await this.listAudio();

    const unnamed = unnamedOpcodes(project.game.subroutines, this.agosTarget);
    const notes = [
      `AGOS ${this.agosTarget.version} (${this.agosTarget.releaseKind}), identified by ${this.detection.identification}`,
      `${project.items.length} items, ${project.strings.length} strings, ${project.game.subroutines.subroutines.length} subroutines`,
      `Unrecovered: ${project.editable.unrecovered} (GAMEPC has no index, so the count is per game — ADR 0030)`,
      `${audio.length} recordings listed by number; their bytes stay in the game folder (ADR 0034)`,
    ];
    if (unnamed.length > 0) {
      notes.push(
        `opcodes this project cannot name: ${unnamed.join(', ')} — a wrong Target or a gap`,
      );
    }

    return {
      project: {
        version: 6,
        target: this.target,
        // ADR 0010: above the size threshold the originals are not kept, and
        // export asks for the folder again. A talkie is comfortably above it,
        // so this is the normal path for AGOS rather than the exception — and
        // it is what lets a mismatched folder be refused by name rather than
        // written into.
        origin: {
          indexFile: this.origin.baseFile,
          dataFile: this.origin.archiveFile,
          indexBytes: this.origin.baseBytes,
          dataBytes: this.origin.archiveBytes,
        },
        name: this.gameId,
        start: { room: this.currentRoom, x: 0, y: 0 },
        defaultResponse: '',
        screen: { textHeight: 0, verbTop: 134 },
        verbs: [],
        actors: [],
        rooms: [],
        scripts: [],
        // Listed rather than imported: the numbers are the project's, the bytes
        // stay in the folder. See `authoring/agos/audioList.ts`.
        audio,
        agos: {
          identification: this.detection.identification,
          editable: {
            editable: project.editable.editable,
            unrecovered: project.editable.unrecovered,
            reasons: [...project.editable.reasons],
          },
          header: { ...project.game.header },
          textBase64: toBase64(project.game.textBytes),
          // ADR 0035's Preserved bytes, carried onto the Project rather than
          // left in the engine: an export is built from the Project, so a
          // release whose trailing region stayed here could only ever re-emit
          // byte for byte in the session that imported it.
          trailingBase64: toBase64(project.game.trailing),
          // ADR 0034's teeth. Computed once, here, over the bytes this project
          // was actually built from — a fingerprint taken later, from anything
          // the editor reconstructs, would be a fingerprint of the edit.
          baseFingerprint: fingerprintOf(this.baseFileBytes),
          items: [...project.game.items],
          subroutines: project.game.subroutines,
          // Carried through rather than re-read. The zones were already probed
          // to build the project, and probing them twice would read a game's
          // whole art again to produce the same list.
          art: project.art,
          // The rooms, on the same terms. They cost a walk of the item tree and
          // a read of ninety-odd Subroutines out of the table files, all of
          // which happened above.
          rooms: project.rooms,
        },
      },
      notes,
    };
  }
}

/**
 * Reads a font out of an interpreter executable beside the game, if one is there.
 *
 * A folder holds more than the interpreter — a DOS extender, an installer, a
 * splash-screen stub — and some of those carry byte runs that score as a font.
 * A plain first-match, or a plain best-score, draws a game's text out of the
 * wrong executable. So which one to believe is settled by two facts in turn:
 *
 * - **A known interpreter name is taken on sight.** A file called `SIMON.EXE`
 *   is the interpreter; scoring a setup program after it would spend seconds to
 *   change nothing. First-named, first-served.
 * - **When nothing is named, the best-scoring survivor wins.** Simon 1 ships
 *   four executables and none is `simon.exe` — `SimSplsh.exe` is the splash and
 *   `Simon1.exe` is the game — so a name cannot choose and shape must: the
 *   game's font scores near 0.83 and the splash's near 0.72, and a first-match
 *   would take whichever the folder happened to list first. Simon 2 ships
 *   `DOS4GW.EXE` and `INSTALL.EXE` beside its interpreter, and those score as
 *   fonts too; they are struck from the list by name (`NOT_INTERPRETERS`)
 *   before shape is consulted, because a best-score alone would pick the
 *   extender. Best-score is a judgement the scan cannot make on its own, which
 *   is why it lives here.
 *
 * Every outcome is reported, including the ordinary one. A player whose game
 * shows no text needs to know whether the font was not found or not looked for.
 */
async function findFontBeside(
  source: DataSource,
  onLog: ((message: string) => void) | undefined,
): Promise<AgosFont | undefined> {
  const candidates = interpreterCandidates(source.list());
  if (candidates.length === 0) {
    onLog?.(
      'No interpreter executable is beside this game, and AGOS keeps its font in the ' +
        'interpreter rather than in the data — so the game will run without drawing its ' +
        'words (ADR 0032).',
    );
    return undefined;
  }

  const report = (name: string, font: AgosFont): void =>
    onLog?.(
      `Font read from ${name} at offset ${font.at}, ${font.count} glyphs of ` +
        `${font.width}x${font.height} (shape score ${font.score.toFixed(2)})`,
    );

  // A definitively named interpreter is believed on its name: first that yields
  // a font wins, and the others are not even scanned.
  for (const name of candidates.filter(isKnownInterpreterName)) {
    const bytes = await source.read(name);
    if (!bytes) continue;
    const font = findAgosFont(bytes);
    if (!font) continue;
    report(name, font);
    return font;
  }

  // Nothing was named, so shape decides. The best-scoring executable wins —
  // the splash and the stub lose to the real interpreter on score, and the
  // provable non-interpreters were dropped from the candidates already.
  let best: { name: string; font: AgosFont } | undefined;
  for (const name of candidates.filter((name) => !isKnownInterpreterName(name))) {
    const bytes = await source.read(name);
    if (!bytes) continue;
    const font = findAgosFont(bytes);
    if (!font) continue;
    if (!best || font.score > best.font.score) best = { name, font };
  }
  if (best) {
    report(best.name, best.font);
    return best.font;
  }

  onLog?.(
    `No font was found in ${candidates.join(', ')}. The game will run without drawing ` +
      'its words rather than drawing boxes where they would go.',
  );
  return undefined;
}
