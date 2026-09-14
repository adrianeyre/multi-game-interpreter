/**
 * `Sword2Engine` — Broken Sword II: The Smoking Mirror as an `AdventureEngine`.
 *
 * ## The seam, tested an eighth time
 *
 * Seventeen members again. 640x480 for both halves of `resolution`, unlike
 * Sword1: this game draws its menus over the picture rather than in bars
 * beside it, so there is no inset and the two halves agree.
 *
 * ## How a room change works here, and why it is simpler than Sword1's
 *
 * There is no room table and no screen number. A session is a **run list** — a
 * resource holding the ids of the objects that are alive — and `fnSetSession`
 * replaces it. The screen's background, its masks, its palette and its four
 * parallax layers all come out of **one** resource that `fnInitBackground`
 * names. So entering a room is: a script sets the session, the cycle stops, the
 * new session's first object's script calls `fnInitBackground`, and the screen
 * is read.
 *
 * That means this engine's loading state is driven by the *run list* rather
 * than by a screen number, and the await point is the same one: between
 * sessions, never inside a cycle.
 *
 * ## What this engine does, and where it stops
 *
 * It reads the three index files and the clusters, reads the globals out of the
 * game's own resource, walks the run list, runs the bytecode, animates, draws
 * backgrounds, masks, parallax and scaled sprites, plays effects and speech,
 * handles the pointer, and saves.
 *
 It walks, too. `Sword2Router` is this family's own pathfinder over its own
 * walk-grid format — a *list* of grids scripts add and remove, and a frame
 * layout derived from the mega's own walk data rather than hardcoded — and both
 * its animators are implemented, so `fnWalk`, `fnTurn`, `fnFaceMega` and the
 * rest do what they say.
 *
 * It plays its cutscenes through the same Smacker reader AGOS uses. A sequence
 * this folder does not ship is counted by name and the scripts carry on, which
 * is on the status line rather than behind a black screen.
 */

import {
  type AdventureEngine,
  type EditableGame,
  type EditableGameOptions,
  type SavedGameEnvelope,
} from '../AdventureEngine.js';
import type { DataSource } from '../resource/DataSource.js';
import { Screen } from '../gfx/Screen.js';
import type { Palette } from '../gfx/Palette.js';
import type { Target } from '../../authoring/target.js';
import { describeSword2Project, importSword2Project } from '../../authoring/sword2/import.js';
import type { ProjectAudio } from '../../authoring/audio.js';
import { listSword2Audio, type Sword2AudioEntry } from '../../authoring/sword2/audioList.js';
import { Sword2Input } from './Sword2Input.js';
import { Sword2Pointer, SWORD2_MOUSE_MODE } from './Sword2Pointer.js';
import {
  SWORD2_BOTTOM_MENU_TOP,
  SWORD2_ICON_DEPTH,
  SWORD2_ICON_SPACING,
  SWORD2_ICON_START,
  SWORD2_ICON_WIDTH,
  SWORD2_MENU,
  SWORD2_SYSTEM_ICONS,
  SWORD2_SYSTEM_MENU,
} from './Sword2Menu.js';
import { Sword2Sound } from './sound/Sword2Sound.js';
import { Sword2Screen, SWORD2_SCREEN_HEIGHT, SWORD2_SCREEN_WIDTH } from './gfx/Sword2Screen.js';
import {
  decodeSword2MouseFrame,
  parseSword2MouseAnim,
  type Sword2MouseFrame,
} from './gfx/sword2Mouse.js';
import {
  placeTextBloc,
  Sword2Text,
  Sword2TextJustification,
  sword2SpeechFontIds,
  SWORD2_SAVE_LINE_NO,
  SWORD2_TEXT_RES,
} from './gfx/Sword2Text.js';
import { MEGA, Sword2Logic, type Sword2LogicHost } from './script/Sword2Logic.js';
import {
  Sword2Resources,
  Sword2ResourceError,
  SWORD2_STREAMED,
} from './resource/Sword2Resources.js';
import {
  identifySword2,
  refineSword2Release,
  type Sword2Detection,
  type Sword2Release,
} from './resource/sword2Detect.js';
import {
  RES_HEADER_SIZE,
  sword2Animation,
  type Sword2Animation,
  Sword2FileType,
  Sword2FrameType,
  Sword2SpriteType,
} from './resource/sword2Headers.js';
import {
  SV2,
  SWORD2_CROSHAIR_POINTER,
  SWORD2_CUR_PLAYER_ID,
  SWORD2_USE_POINTER,
} from './script/sword2Vars.js';
import { readSword2TextEntries } from '../../authoring/sword2/import.js';
import { sword2OpcodeName } from './script/opcodeNames.js';
import {
  advanceSequence,
  findSequenceFiles,
  openFirstSequence,
  type SwordSequence,
} from '../sword1/video/SwordSequences.js';

/**
 * This family's save payload version. Independent of every other family's.
 *
 * Two, because format 1 wrote a field it never read. It carried every object
 * the session had loaded — sixty-odd kilobytes of them — and `loadState` put
 * back the globals and nothing else, so a restored game came back in the right
 * room with the player wherever the live world had left them. Format 2 carries
 * the globals and the player object, which is what the original saves, and
 * restores both.
 */
export const SWORD2_SAVE_FORMAT = 2;

/**
 * Twelve cycles a second, as the original's timer runs.
 *
 * Exported for the reason Sword 1's is: `doAnimate` steps `GRAPHIC.ANIM_PC` by
 * one a cycle, so this is Broken Sword II's animation rate and the editor's
 * preview takes it from here.
 */
export const SWORD2_TICKS_PER_STEP = 5;

/**
 * The screen manager whose script 1 opens the game, per Release.
 *
 * This used to be answered by scanning the index for the **first `RUN_LIST`
 * resource** and starting there, on the stated ground that a hardcoded number
 * could not be verified. Measured, that was wrong twice over: the first run
 * list in the demo's table is resource 2, `Run list for 111`, which is a
 * players-cluster list and not a section; and a run list is not what starts
 * this game at all.
 *
 * `Sword2Engine::startGame` (`sword2.cpp:523`) boots "straight into a start
 * script … always George's script #1, but with different ScreenManager objects
 * depending on if it's the demo or the full game". So the number is
 * interpreter knowledge of exactly the kind ADR 0029 keeps here, it is *per
 * Release*, and the start script is what calls `fnSetSession` — meaning the
 * opening run list is read out of the game rather than guessed at.
 *
 * Both ids are checked against the resource's own file type before use, so a
 * folder that disagrees says so rather than running a screen at random.
 */
export const SWORD2_START_SCREEN_MANAGER = {
  /** `19` — "DOCKS SECTION START", which is the section the demo ships. */
  demo: 19,
  /** `949` — "INTRO & PARIS START". */
  cd: 949,
  /** The conversion is the full game, so it opens where the full game does. */
  psx: 949,
} as const satisfies Record<Sword2Release, number>;

/** George's script that a screen manager's start entry point is. */
const SWORD2_START_SCRIPT = 1;

export interface Sword2EngineOptions {
  onLog?: (message: string) => void;
  onActivity?: (activity: string) => void;
}

/**
 * A Broken Sword II save: the shared envelope, plus this family's world.
 *
 * The same five things `Sword2Engine::saveGame` writes (`saveload.cpp:60-96`),
 * in the same spirit: the globals are the game's state, the player object is
 * the one compact that does not rebuild itself, the run list is the room, the
 * background is what is drawn behind it, and the looping music is what is
 * playing. Everything else restarts from the resources, which is what happens
 * when you walk into a room.
 */
interface Sword2SavedGame extends SavedGameEnvelope {
  /** The globals, as the game's own variable block. */
  readonly globals: number[];
  /**
   * The player object's whole byte block — hub, structures and tables.
   *
   * Wider than ScummVM's four structures and narrower than format 1's every
   * object. See `Sword2Logic.playerBytes` for why a browser can afford the
   * first and why the second was never a world in the first place.
   */
  readonly player: number[];
  readonly session: number;
  readonly background: number;
  /** The looping music, which the original keeps a safe copy of for this. */
  readonly music: number;
}

export class Sword2Engine implements AdventureEngine {
  readonly saveFormat = SWORD2_SAVE_FORMAT;
  readonly saveNote =
    'Broken Sword II saves are this interpreter’s own format and are not readable by ScummVM, ' +
    'or by this project’s other families’ saves.';

  readonly resolution = {
    script: { width: SWORD2_SCREEN_WIDTH, height: SWORD2_SCREEN_HEIGHT },
    display: { width: SWORD2_SCREEN_WIDTH, height: SWORD2_SCREEN_HEIGHT },
  };

  readonly screen = new Screen(SWORD2_SCREEN_WIDTH, SWORD2_SCREEN_HEIGHT);
  readonly input = new Sword2Input();
  readonly sound: Sword2Sound;

  frame = 0;
  hasQuit = false;

  /**
   * What the game's own system menu asks the shell for.
   *
   * The panel at the top of the screen is the game's; the ten slots and the
   * dialog over them are the shell's, and have been since long before this
   * family existed. So a click on SAVE is a *request* rather than an action —
   * the same arrangement `AgiEngine.saveGame` already used for a script-driven
   * save, now named in `AdventureEngine` so a shell can wire it without
   * knowing which family it has. Null means nobody is listening, and the two
   * icons are greyed rather than drawn live.
   */
  onSaveRequested: (() => void) | null = null;
  onRestoreRequested: (() => void) | null = null;

  private readonly renderer: Sword2Screen;
  private readonly logic: Sword2Logic;
  /**
   * The mouse engine: which of `Mouse::mouseEngine`'s modes the pointer is in.
   *
   * Separate from {@link input}, which only collects what the browser reports.
   * This is the part that decides what a position *means* — and in particular
   * that a pointer at the bottom of the screen is a request for the inventory.
   */
  private readonly pointer: Sword2Pointer;
  /** The subtitle renderer. Its font resolves lazily; see `Sword2Text`. */
  private readonly text: Sword2Text;
  /**
   * Whether subtitles are wanted. `Sword2Engine::getSubtitles`.
   *
   * On by default, and on for a reason beyond taste: this project plays no
   * speech until the page has had a gesture, and every line of the demo would
   * otherwise pass in silence with nothing on screen.
   */
  subtitlesEnabled = true;
  /** Whether "there is no font" has already been said this dry spell. */
  private saidFontMissing = false;
  /** How many subtitles have been built this session, for the status line. */
  private linesShown = 0;

  /** The dragged object's decoded sprite, and which resource it came from. */
  private luggage: Sword2MouseFrame | null = null;
  private luggageResource = 0;
  /** The last resource a load was asked for, so it is asked for once. */
  private luggageAsked = 0;

  private booted = false;
  private loading = false;

  /**
   * `_mouseEvent`: the one press waiting to be read (`sword2.cpp:104`).
   *
   * Held rather than drained per cycle because the mouse engine's arms read a
   * click only after their own early returns, and a cycle spent opening the
   * inventory reads nothing. See `Sword2Pointer.tookEvent`.
   */
  private pendingClick = { left: false, right: false };
  private loadError: string | null = null;
  private background = 0;
  /**
   * The pointer text named by the last `fnRegisterPointerText`, if any.
   *
   * The call comes *before* the registration it decorates and names no target,
   * so it is held here until the same object registers one — which is exactly
   * what the original does by writing into the slot it is about to fill.
   */
  private pendingPointerText: { objectId: number; textId: number } | null = null;
  private readonly skippedSequences = new Set<string>();
  /** The cutscene on screen, or null. While one runs, no session cycle does. */
  private sequence: SwordSequence | null = null;
  private paletteBeforeSequence: Uint8Array | null = null;
  private videoNames: readonly string[] = [];
  private readFile: ((name: string) => Promise<Uint8Array | null>) | null = null;
  private quitReason: 'restart' | 'death' | 'credits' | null = null;
  private startRunList = 0;
  private startScreenManager = 0;

  private constructor(
    private readonly resources: Sword2Resources,
    private detection: Sword2Detection,
    private readonly log?: (message: string) => void,
  ) {
    this.renderer = new Sword2Screen(resources);
    this.sound = new Sword2Sound(resources);
    // Asked lazily, not now: which speech font a release wants is decided by
    // reading a line of *text*, and TEXT.CLU is not resident yet here.
    this.text = new Sword2Text(resources, () =>
      sword2SpeechFontIds(this.textLine(SWORD2_TEXT_RES * 0x10000 + SWORD2_SAVE_LINE_NO)),
    );
    this.logic = new Sword2Logic(resources, this.logicHost());
    this.pointer = new Sword2Pointer(
      {
        getVar: (number) => this.logic.getVar(number),
        setVar: (number, value) => this.logic.setVar(number, value),
        inventory: () => this.logic.menu.inventory,
        buildMenu: () => this.logic.menu.buildMenu(),
        hideMenu: (menu) => this.logic.menu.hideMenu(menu),
        setExamining: (examining) => this.logic.menu.setExamining(examining),
        setPlayerActionEvent: (interactId) =>
          this.logic.setPlayerActionEvent(SWORD2_CUR_PLAYER_ID, interactId),
        objectUnder: (roomX, roomY) => this.objectUnder(roomX, roomY),
        buildSystemMenu: (available) => {
          // The five icons are ordinary resources and the demo ships all of
          // them, but they are not resident: asked for here so that the first
          // frame the panel is up is a frame with icons on it.
          for (const icon of SWORD2_SYSTEM_ICONS) void this.resources.load(icon);
          this.logic.menu.buildSystemMenu(available);
        },
        systemMenuAvailable: () => this.systemMenuAvailable(),
        systemMenuPick: (choice) => this.systemMenuPick(choice),
        log: this.log,
      },
      SV2,
    );
  }

  /** The five in words, for the line the log prints when one is greyed. */
  private static readonly systemMenuNames = [
    'options',
    'quit',
    'save',
    'restore',
    'restart',
  ] as const;

  /**
   * Which of the panel's five icons are live, in `SWORD2_SYSTEM_ICONS` order.
   *
   * Save and restore, when a shell has wired them; and not save while the
   * player is dead, which is the original's own rule ("The only case when an
   * icon is grayed is when the player is dead. Then SAVE is not available",
   * `icons.cpp:221-222`).
   *
   * Options, quit and restart are never live, and that is a statement about
   * this shell rather than about the game: the volume and the subtitles are
   * the page's controls, closing the tab is its quit, and opening the game
   * again is its restart. Wiring the icons to those would give the player two
   * ways to do each with different words for the same thing; greying them says
   * where they went.
   */
  private systemMenuAvailable(): readonly boolean[] {
    const dead = this.logic.getVar(SV2.DEAD) !== 0;
    const live: boolean[] = [false, false, false, false, false];
    live[SWORD2_SYSTEM_MENU.SAVE] = this.onSaveRequested !== null && !dead;
    live[SWORD2_SYSTEM_MENU.RESTORE] = this.onRestoreRequested !== null;
    return live;
  }

  /** A click on one of the five. False means it was greyed and nothing ran. */
  private systemMenuPick(choice: number): boolean {
    if (!this.systemMenuAvailable()[choice]) {
      this.log?.(
        `the system menu's ${Sword2Engine.systemMenuNames[choice] ?? `icon ${choice}`} is greyed ` +
          `here — saving and restoring are the two this panel services, and the page's own ` +
          `controls are the other three`,
      );
      return false;
    }
    if (choice === SWORD2_SYSTEM_MENU.SAVE) this.onSaveRequested?.();
    else if (choice === SWORD2_SYSTEM_MENU.RESTORE) this.onRestoreRequested?.();
    return true;
  }

  /** Which registered mouse rectangle a room position falls in, or 0. */
  private objectUnder(roomX: number, roomY: number): number {
    const hit = this.renderer
      .hitTargets()
      .find(
        (target) =>
          roomX >= target.x1 && roomX <= target.x2 && roomY >= target.y1 && roomY <= target.y2,
      );
    return hit?.objectId ?? 0;
  }

  static async create(
    source: DataSource,
    options: Sword2EngineOptions = {},
  ): Promise<Sword2Engine> {
    const resources = await Sword2Resources.create(source, { onLog: options.onLog });
    const detection = refineSword2Release(identifySword2(source.list()), resources.clusterNames);
    const engine = new Sword2Engine(resources, detection, options.onLog);

    options.onActivity?.('Loading Broken Sword II clusters');
    await resources.loadResident();
    engine.videoNames = source.list();
    engine.readFile = (name) => source.read(name);

    options.onLog?.(
      `Broken Sword II (${detection.release} release) — ${detection.evidence}; ` +
        resources.describe(),
    );
    return engine;
  }

  get gameId(): string {
    return `sword2-${this.detection.release}`;
  }

  get targetName(): string {
    return `Sword2 (${this.detection.release} release, DOS)`;
  }

  /**
   * The room, which this game keeps as a global rather than as a screen number.
   *
   * `LOCATION` is what the debug overlay in the original prints, so it is the
   * closest thing to a room number this family has — and unlike Sword1's
   * screen, it comes out of the game's own globals.
   */
  get currentRoom(): number {
    return this.logic.getVar(SV2.LOCATION);
  }

  get ticksPerStep(): number {
    return SWORD2_TICKS_PER_STEP;
  }

  /** Reads the globals, then runs the Release's own start script. */
  boot(): void {
    if (this.booted) return;
    this.booted = true;
    this.logic.initialise();

    // `DEMO` is a global the scripts branch on, and the engine is what sets it.
    this.logic.setVar(SV2.DEMO, this.detection.release === 'demo' ? 1 : 0);

    const wanted = SWORD2_START_SCREEN_MANAGER[this.detection.release];
    const manager = this.resources.fetch(wanted);
    if (!manager) {
      this.log?.(
        `Broken Sword II starts from screen manager ${wanted} and ` +
          `${this.resources.describeMissingResource(wanted)} No session can start.`,
      );
      return;
    }
    if (manager.header.fileType !== Sword2FileType.SCREEN_MANAGER) {
      this.log?.(
        `Broken Sword II starts from screen manager ${wanted}, and resource ${wanted} in this ` +
          `folder is file type ${manager.header.fileType} rather than a screen manager. The ` +
          `Release was read as "${this.detection.release}" and may be wrong.`,
      );
      return;
    }

    // George's script 1, out of the screen manager's resource. The script sets
    // the session itself, which is why nothing here has to name a run list.
    this.startScreenManager = wanted;
    if (!this.logic.runObjectScript(wanted, SWORD2_CUR_PLAYER_ID, SWORD2_START_SCRIPT)) {
      this.log?.(`Broken Sword II could not run the start script of ${manager.header.name}.`);
      return;
    }
    this.startRunList = this.logic.session;
    // `startGame` ends here (`startup.cpp:174`): "make sure there's a mouse, in
    // case restarting while mouse not available". Without it a game whose start
    // script took the pointer away — or one that never gave it — begins with no
    // way to play, which is what the probe measured on the mounted demo.
    this.logic.addHuman();
    if (this.startRunList) {
      this.log?.(
        `Broken Sword II booted through ${manager.header.name} (${wanted}) ` +
          `onto run list ${this.startRunList}`,
      );
    } else {
      this.log?.(
        `${manager.header.name} (${wanted}) ran and set no session, so no objects are alive.`,
      );
    }
  }

  step(): void {
    if (!this.booted) this.boot();
    // A cutscene owns the screen; no session cycle runs while one does.
    if (this.sequence) {
      if (this.input.drainSkip() || !this.drawSequenceFrame()) this.endSequence();
      this.frame++;
      return;
    }
    if (this.hasQuit || this.loading) return;

    // A press joins the one-slot event queue and stays there until an arm of
    // the mouse engine reads it (`Sword2Engine::mouseEvent`, `sword2.cpp:403`).
    // Draining it into a per-cycle flag instead threw away every press that
    // landed on a cycle the pointer spent changing mode — see
    // `Sword2Pointer.tookEvent`.
    const pressed = this.input.drainButtons();
    if (pressed.left) this.pendingClick.left = true;
    if (pressed.right) this.pendingClick.right = true;
    const buttons = this.pendingClick;
    this.logic.setVar(SV2.MOUSE_X, this.input.x + this.renderer.scrollX);
    this.logic.setVar(SV2.MOUSE_Y, this.input.y + this.renderer.scrollY);
    this.logic.setVar(SV2.LEFT_BUTTON, buttons.left ? 1 : 0);
    this.logic.setVar(SV2.RIGHT_BUTTON, buttons.right ? 1 : 0);
    if (this.input.drainSkip()) this.sound.stopSpeech();

    // Reset the hit list *before* the session and test the pointer against it
    // *after*, which is the order `gameCycle` uses (`sword2.cpp:491-521`): the
    // service scripts fill the list through `fnRegisterMouse` while the session
    // runs, and `mouseEngine()` runs on what they left. Clearing afterwards
    // instead tests every click against an empty list, so `CLICKED_ID` stays 0
    // for the whole game and nothing can be clicked — with no symptom other
    // than a pointer that never touches anything.
    this.renderer.clearMouseList();
    const cutShort = this.logic.processSession();

    // "If this screen is wide, recompute the scroll offsets every cycle"
    // (`sword2.cpp:513-517`) — after the session, because the session is what
    // tells the camera where the player is, and before the hit test, because
    // the pointer is tested in room coordinates.
    this.renderer.updateScroll(this.logic.getVar(SV2.SCROLL_X), this.logic.getVar(SV2.SCROLL_Y));

    // A click sets `CLICKED_ID`, which is what the scripts branch on: this game
    // does its own hit-testing in script, and the engine's job is only to say
    // what is under the pointer.
    // "If the mouse is not visible, do nothing" (`mouse.cpp:240-243`): a cycle
    // with the human switched off runs no mouse engine at all, so no click
    // reaches a room target. That guard is what keeps a conversation honest —
    // fnChoose's own comment says "the human is switched off so there will be
    // no normal mouse engine" (`function.cpp:178-186`) — and without it a click
    // on the chooser bar is *also* a click on whatever floor is behind it.
    // `Mouse::mouseEngine` runs every cycle the human is available — not only
    // on a cycle with a click — because two of its three modes are entered by
    // the pointer *moving*: the inventory opens by being reached at the bottom
    // of the screen, and closes by leaving it. Running it only on a click is
    // what used to leave the bar with no way to open it.
    //
    // A chooser is the one exception. `fnChoose` switches the human off while
    // it waits, and its own comment says why — "the human is switched off so
    // there will be no normal mouse engine" (`function.cpp:178-186`) — so the
    // `MOUSE_AVAILABLE` guard already covers it; the explicit test is here so
    // that a conversation bar cannot be mistaken for an inventory bar if a
    // script ever leaves the human on.
    if (this.logic.getVar(SV2.MOUSE_AVAILABLE) !== 0 && !this.logic.menu.isChoosing) {
      const taken = this.pointer.run({
        displayX: this.input.x,
        displayY: this.input.y,
        roomX: this.input.x + this.renderer.scrollX,
        roomY: this.input.y + this.renderer.scrollY,
        left: buttons.left,
        right: buttons.right,
      });
      if (taken) this.pendingClick = { left: false, right: false };
    }

    this.renderer.draw();
    this.frame++;

    void this.sound.pump();
    void this.drainWantedResources();

    if (cutShort) {
      // A session change: the next cycle runs the new run list, and whatever
      // clusters it needs are loaded first.
      this.loading = true;
      void (async (): Promise<void> => {
        try {
          await this.resources.satisfyWanted();
        } catch (error) {
          this.loadError = error instanceof Error ? error.message : String(error);
        } finally {
          this.loading = false;
        }
      })();
    }
  }

  private async drainWantedResources(): Promise<void> {
    if (this.resources.wanted.length === 0) return;
    await this.resources.satisfyWanted();
  }

  render(): void {
    // A cutscene has already drawn into the framebuffer; compositing the room
    // over it would draw the game on top of the film.
    if (this.sequence) return;
    // The menu bars are the logic's state, not the renderer's: the scripts put
    // icons in them and take them away, and the renderer only stamps whatever
    // they hold this frame.
    this.renderer.setMenu(this.logic.menu.bars);
    this.renderer.setLuggage(this.luggageFrame(), this.input.x, this.input.y);
    this.renderer.present(this.screen.pixels);
  }

  /**
   * The dragged object's sprite, decoded once and kept until it changes.
   *
   * Read off the pointer rather than pushed in from it: `_currentLuggageResource`
   * is already published there and a second copy of the same number is a second
   * thing to keep in step. `Mouse::setLuggage` opens the resource the moment
   * the object is picked up (`mouse.cpp:1114-1125`); here the pick-up cycle
   * asks for the load and the frame after it draws, because a resource arrives
   * asynchronously in this project and a cycle cannot wait for one.
   */
  private luggageFrame(): Sword2MouseFrame | null {
    const wanted = this.pointer.luggage;
    if (!wanted) {
      this.luggage = null;
      this.luggageResource = 0;
      return null;
    }
    if (wanted === this.luggageResource) return this.luggage;
    const resource = this.resources.fetch(wanted);
    if (!resource) {
      // Not here yet (or not here at all): ask for it, and say so once.
      if (wanted !== this.luggageAsked) {
        this.luggageAsked = wanted;
        void this.resources.load(wanted);
      }
      return null;
    }
    this.luggageResource = wanted;
    const anim = parseSword2MouseAnim(resource.bytes);
    const frame = anim ? decodeSword2MouseFrame(anim, 0) : null;
    if (!frame) {
      this.log?.(
        `the luggage for the object being dragged (resource ${wanted}) is not a mouse ` +
          `animation, so the pointer carries nothing`,
      );
      this.luggage = null;
      return null;
    }
    if (!frame.ok) {
      this.log?.(
        `the luggage for the object being dragged (resource ${wanted}) ran out part way ` +
          `through its ${frame.width}x${frame.height} frame`,
      );
    }
    this.luggage = frame;
    return frame;
  }

  /**
   * Starts a cutscene by name, or says it could not.
   *
   * The name comes from the script as a pushed string — Sword2 carries its own
   * filenames — so unlike Sword1 there is no table to look one up in.
   */
  private beginSequence(name: string): boolean {
    if (!name || !this.readFile) return false;
    const candidates = findSequenceFiles(this.videoNames, name);
    if (candidates.length === 0) {
      this.skippedSequences.add(name);
      this.log?.(`sequence "${name}" is not in this folder, so it is skipped`);
      return false;
    }
    this.loading = true;
    const read = this.readFile;
    void (async (): Promise<void> => {
      try {
        const opened = await openFirstSequence(this.videoNames, name, (file) => read(file));
        if (!opened) {
          this.skippedSequences.add(name);
          this.log?.(
            `sequence "${name}": ${candidates.join(', ')} ` +
              `${candidates.length === 1 ? 'is' : 'are'} not a Smacker this project reads`,
          );
          return;
        }
        this.paletteBeforeSequence = this.renderer.palette.snapshot();
        this.sequence = opened.sequence;
        this.log?.(
          `playing sequence "${name}" from ${opened.file}: ` +
            `${opened.sequence.smacker.info.frameCount} frames at ` +
            `${opened.sequence.smacker.info.width}x${opened.sequence.smacker.info.displayHeight}`,
        );
      } finally {
        this.loading = false;
      }
    })();
    return true;
  }

  private drawSequenceFrame(): boolean {
    if (!this.sequence) return false;
    const frame = advanceSequence(
      this.sequence,
      this.screen.pixels,
      SWORD2_SCREEN_WIDTH,
      SWORD2_SCREEN_HEIGHT,
    );
    if (!frame) return false;
    if (frame.paletteChanged || this.sequence.frame === 1) {
      for (let index = 0; index < 256; index++) {
        this.renderer.palette.setColor(
          index,
          frame.palette[index * 3],
          frame.palette[index * 3 + 1],
          frame.palette[index * 3 + 2],
        );
      }
    }
    return true;
  }

  private endSequence(): void {
    this.sequence = null;
    if (this.paletteBeforeSequence) {
      this.renderer.palette.setFromClut(this.paletteBeforeSequence);
      this.paletteBeforeSequence = null;
    }
  }

  present(context: CanvasRenderingContext2D): void {
    this.screen.present(context, this.renderer.palette);
  }

  private logicHost(): Sword2LogicHost {
    return {
      registerFrame: (objectId, mouseOffset, graphicOffset, megaOffset) => {
        // The graphic structure's three words are type, anim resource and anim
        // pc. The logic hands over a token; the engine reads through it.
        const graphic = this.readPointer(graphicOffset, 3);
        const type = graphic[0];
        if ((type & 0xffff) === Sword2SpriteType.NO_SPRITE) return;

        // A mega scales with how far down the room its feet are:
        // `(A * feetY + B) / 256`, `ObjectMega::calcScale` (`object.h:245`).
        // Without the mega there are no feet and no scale, and the frame's own
        // coordinates are where it goes — which is what a scenery animation is.
        const feetX = megaOffset === null ? 0 : this.logic.peek(megaOffset, MEGA.FEET_X);
        const feetY = megaOffset === null ? 0 : this.logic.peek(megaOffset, MEGA.FEET_Y);
        const scale =
          megaOffset === null
            ? 0
            : Math.trunc(
                (this.logic.peek(megaOffset, MEGA.SCALE_A) * feetY +
                  this.logic.peek(megaOffset, MEGA.SCALE_B)) /
                  256,
              );

        const sprite = {
          objectId,
          type,
          animResource: graphic[1],
          animPc: graphic[2],
          feetX,
          feetY,
          scale,
          shaded: (type & Sword2SpriteType.SHADED_SPRITE) !== 0,
        };
        this.renderer.addSprite(sprite);

        // A mega's hit area is the shape it was just drawn at rather than the
        // rectangle in its structure, which for a walking character is the only
        // way the area follows it around the room.
        if (mouseOffset !== null) {
          this.addMouseTarget(objectId, mouseOffset, this.renderer.spriteBounds(sprite));
        }
      },
      registerMouse: (objectId, mouseOffset) => {
        if (mouseOffset === null) return;
        this.addMouseTarget(objectId, mouseOffset, null);
      },
      registerPointerText: (objectId, textId) => {
        this.pendingPointerText = { objectId, textId };
      },
      roomSize: () => this.renderer.size,
      initBackground: (resourceId, newPalette) => {
        this.background = resourceId;
        this.renderer.initBackground(resourceId, newPalette);
        for (const warning of this.renderer.warnings) this.log?.(warning);
      },
      registerParallax: () => {
        // The four parallax layers come out of the screen resource itself, so a
        // separate registration is a no-op rather than wrong.
      },
      registerWalkGrid: () => {
        // The router keeps the list itself, because it is the only thing that
        // reads it — the logic hands the resource id straight there.
      },
      setPalette: (resourceId) => this.renderer.setPalette(resourceId),
      fadeUp: () => {
        // A fade is a palette ramp over frames; the palette is set directly, so
        // a fade reads as a cut. Named on the status line rather than hidden.
      },
      fadeDown: () => {},
      playFx: (resourceId, volume, pan, type) => this.sound.playFx(resourceId, volume, pan, type),
      stopFx: (slot) => this.sound.stopFx(slot),
      playMusic: (resourceId, looped) => this.sound.playMusic(resourceId, looped),
      stopMusic: () => this.sound.stopMusic(),
      requestSpeech: (textId) => this.sound.requestSpeech(textId),
      speechFinished: () => this.sound.speechFinished(),
      stopSpeech: () => this.sound.stopSpeech(),
      subtitles: () => this.subtitlesEnabled,
      speechLine: (textId) => this.speechLine(textId),
      displayText: (textId, x, y, width, pen) => this.displayText(textId, x, y, width, pen),
      removeText: (block) => this.renderer.killTextBloc(block),
      firstFrame: (animResource) => this.firstFrame(animResource),
      animFrameCount: (animResource) => this.animation(animResource)?.frames.length ?? 0,
      scrollOffset: () => ({ x: this.renderer.scrollX, y: this.renderer.scrollY }),
      setScrollTarget: (x, y) => this.renderer.setScrollTarget(x, y),
      setPlayerFeet: (x, y) => this.renderer.setPlayerFeet(x, y),
      setScrollFraction: (fraction) => this.renderer.setScrollFraction(fraction),
      maxScroll: () => ({ x: this.renderer.maxScrollX, y: this.renderer.maxScrollY }),
      playSequence: (name) => this.beginSequence(name),
      requestQuit: (reason) => {
        this.quitReason = reason;
        this.hasQuit = true;
      },
      random: (min, max) => min + Math.floor(Math.random() * (max - min + 1)),
      preload: (resourceId) => {
        void this.resources.load(resourceId);
      },
      setObjectHeld: (resource) => this.pointer.setObjectHeld(resource),
      humanAdded: () => this.pointer.addHuman(),
      log: (message) => this.log?.(message),
    };
  }

  /**
   * Puts one `ObjectMouse` in this cycle's hit list. `Mouse::registerMouse`.
   *
   * `bounds` is the frame the object was drawn at, for a target registered
   * through `fnRegisterFrame`, and null for one registered through
   * `fnRegisterMouse` — a floor or a hand-placed area, which carries its own
   * rectangle. ScummVM stores an exclusive right and bottom (`1 + x2`) and
   * tests with `Rect::contains`; these are stored inclusive and tested with
   * `<=`, which is the same rectangle written the other way round.
   */
  private addMouseTarget(
    objectId: number,
    mouseOffset: number,
    bounds: { x: number; y: number; width: number; height: number } | null,
  ): void {
    const mouse = this.readPointer(mouseOffset, 6);
    // A structure with no pointer graphic is not a target at all: the scripts
    // switch an area off by zeroing this field, and `Mouse::registerMouse`
    // returns before it writes a slot (`mouse.cpp:163`).
    if (mouse[5] === 0) return;
    this.renderer.addMouseTarget({
      objectId,
      x1: bounds ? bounds.x : mouse[0],
      y1: bounds ? bounds.y : mouse[1],
      x2: bounds ? bounds.x + bounds.width : mouse[2],
      y2: bounds ? bounds.y + bounds.height : mouse[3],
      priority: mouse[4],
      pointerText:
        this.pendingPointerText?.objectId === objectId ? this.pendingPointerText.textId : 0,
      // "Change all COGS pointers to CROSHAIR" (`mouse.cpp:181-186`) — a
      // mid-development decision the resource files were never regenerated for.
      pointer: mouse[5] === SWORD2_USE_POINTER ? SWORD2_CROSHAIR_POINTER : mouse[5],
    });
    this.pendingPointerText = null;
  }

  /**
   * Reads `count` words through a logic pointer token.
   *
   * The logic owns the pointer table — it is the one that hands the tokens out
   * — so the engine asks it rather than keeping a second table, which is the
   * thing that would drift.
   */
  private readPointer(token: number, count: number): number[] {
    const out: number[] = [];
    for (let word = 0; word < count; word++) out.push(this.logic.peek(token, word * 4));
    return out;
  }

  /** A text line, for a subtitle or a log. */
  private textLine(textId: number): string | null {
    return this.speechLine(textId)?.text ?? null;
  }

  /**
   * A line of speech: its words, and the wav id written in front of them.
   *
   * A text id is `module * 0x10000 + line`, the same shape as a script id, and
   * the first two bytes of every line are the wav id rather than text
   * (`speech.cpp:186`).
   */
  private speechLine(textId: number): { wavId: number; text: string } | null {
    const module = Math.floor(textId / 0x10000);
    const line = textId & 0xffff;
    const resource = this.resources.fetch(module);
    if (!resource || resource.header.fileType !== Sword2FileType.TEXT_FILE) {
      void this.resources.load(module);
      return null;
    }
    return readSword2TextEntries(resource.bytes)[line] ?? null;
  }

  /**
   * Builds a subtitle and puts it on the display. `Screen::buildNewBloc`.
   *
   * Returns a bloc handle for the script to kill later, or 0 — and 0 is a
   * *reported* failure rather than a silent one, because a game with no text on
   * screen is a game that cannot be followed. The font not being resident yet
   * is the one case that is not worth a line every cycle: clusters arrive a few
   * frames after they are asked for, so the message is said once.
   */
  private displayText(textId: number, x: number, y: number, width: number, pen: number): number {
    const line = this.textLine(textId);
    if (line === null) {
      this.log?.(`text ${textId} is not in a resident text resource, so no subtitle was shown`);
      return 0;
    }

    const missing = this.text.fontMissing;
    if (missing) {
      if (!this.saidFontMissing) {
        this.saidFontMissing = true;
        this.log?.(`subtitles: ${missing}`);
      }
      return 0;
    }
    // Said once, and only until the font turns up — so that a font that never
    // arrives is reported again if the game asks again later in the session.
    this.saidFontMissing = false;

    const sprite = this.text.makeTextSprite(line, width, pen);
    if (!sprite) {
      this.log?.(`text ${textId} ("${line}") produced no sprite`);
      return 0;
    }

    const placed = placeTextBloc(
      x,
      y,
      sprite.width,
      sprite.height,
      Sword2TextJustification.CENTER_OF_BASE,
      { width: SWORD2_SCREEN_WIDTH, height: SWORD2_SCREEN_HEIGHT },
    );
    this.linesShown++;
    return this.renderer.addTextBloc(sprite, placed.x, placed.y);
  }

  /** An animation resource, walked, or null when it is not resident. */
  private animation(animResource: number): Sword2Animation | null {
    if (!animResource) return null;
    const resource = this.resources.fetch(animResource);
    if (!resource) return null;
    return sword2Animation(resource.bytes);
  }

  /**
   * Frame 0's placement, for putting a line of speech above a head.
   *
   * `offset` is `FRAME_OFFSET` off the CDT entry: set, the x and y are relative
   * to the speaker's feet and are scaled, and `locateTalker` places from the
   * mega instead. Clear, the frame's own coordinates are where it is.
   */
  private firstFrame(
    animResource: number,
  ): { x: number; y: number; width: number; offset: boolean } | null {
    const frame = this.animation(animResource)?.frames[0];
    if (!frame) return null;
    return {
      x: frame.cdt.x,
      y: frame.cdt.y,
      width: frame.header.width,
      offset: (frame.cdt.frameType & Sword2FrameType.OFFSET) !== 0,
    };
  }

  saveState(name: string): SavedGameEnvelope {
    const player = this.logic.playerBytes();
    if (!player) {
      throw new Error(
        'This game has no player object loaded yet, so there is no world to save. Saving is ' +
          'refused rather than written as an empty one.',
      );
    }
    const saved: Sword2SavedGame = {
      format: SWORD2_SAVE_FORMAT,
      gameId: this.gameId,
      savedAt: Date.now(),
      name,
      room: this.currentRoom,
      globals: Array.from(this.logic.snapshotGlobals()),
      player: Array.from(player),
      session: this.logic.session,
      background: this.background,
      music: this.sound.loopingMusic,
    };
    return saved;
  }

  /**
   * Restores a save, or refuses without touching anything.
   *
   * The order is `restoreFromBuffer`'s (`saveload.cpp:229-345`) and each step
   * is load-bearing: the world is dropped and the globals and the player go
   * back before the session is started, because the first cycle of the new
   * session reads both.
   */
  loadState(saved: SavedGameEnvelope): void {
    const candidate = saved as Sword2SavedGame;
    if (candidate.format !== SWORD2_SAVE_FORMAT) {
      throw new Error(
        `This save is format ${candidate.format} and this engine writes ${SWORD2_SAVE_FORMAT}.`,
      );
    }
    if (candidate.gameId !== this.gameId) {
      throw new Error(
        `This save is for "${candidate.gameId}" and this game is "${this.gameId}". A save is ` +
          `tagged with the Target that wrote it (ADR 0012), so it is refused rather than ` +
          `half-applied.`,
      );
    }
    if (!Array.isArray(candidate.globals) || !Array.isArray(candidate.player)) {
      throw new Error(
        'This save carries no Broken Sword II world, so there is nothing to restore.',
      );
    }
    // `restoreWorld` checks every length before writing a byte, so a save from
    // a different install throws here rather than half way through.
    this.logic.restoreWorld(Uint8Array.from(candidate.globals), Uint8Array.from(candidate.player));
    this.booted = true;
    this.pointer.reset();
    this.logic.setSession(candidate.session);
    this.background = candidate.background;
    if (candidate.background) this.renderer.initBackground(candidate.background, true);
    // After the background, because `initBackground` is what sets a screen's
    // own defaults and the save's numbers are the ones that have to win.
    if (candidate.music) this.sound.playMusic(candidate.music, true);
    else this.sound.stopMusic();
  }

  // -- what a harness may ask, which is not what the shell asks ---------------
  //
  // The same four `SwordEngine` carries and for the same reason: ADR 0011 caps
  // `AdventureEngine`, so `bin/play-probe.ts` gets a family-shaped answer from
  // the family rather than recomputing the engine's own arithmetic. Separate
  // implementations, because ADR 0036 is right that these two share nothing —
  // Sword2's pointer is in room coordinates plus a scroll and has no menu bar
  // to subtract, and its hit test is the engine's own rather than the UI's.

  /**
   * The palette the framebuffer is read through. The renderer owns it, because
   * the background resource carries it and a session change replaces both.
   */
  get palette(): Palette {
    return this.renderer.palette;
  }

  /**
   * Where the player character is standing, or null when nothing has said.
   *
   * `PLAYER_FEET_X`/`PLAYER_FEET_Y` and not the mega structure directly: the
   * scripts hand the engine the player's feet through `fnUpdatePlayerStats`
   * once a cycle, and those two globals are where the game itself looks. A
   * harness reading the mega would be reading a structure whose position in the
   * object's variable block is the *object's* to decide.
   */
  playerAt(): { x: number; y: number } | null {
    if (!this.booted) return null;
    return {
      x: this.logic.getVar(SV2.PLAYER_FEET_X),
      y: this.logic.getVar(SV2.PLAYER_FEET_Y),
    };
  }

  /**
   * Where the player is on the **display**, which is not where they are.
   *
   * The same subtraction {@link pointerTargets} makes, kept here so there is
   * one copy of it. The scroll is the term a caller forgets, and it is no
   * longer always zero now that the camera follows anyone: on the demo's first
   * room it settles at 159.
   */
  playerOnScreen(): { x: number; y: number } | null {
    const player = this.playerAt();
    if (!player) return null;
    return { x: player.x - this.renderer.scrollX, y: player.y - this.renderer.scrollY };
  }

  /**
   * What the pointer can touch this cycle, in **display** pixels.
   *
   * `step` hit-tests `input.x + scrollX` against the target rectangle, so the
   * conversion back is the scroll offset and nothing else — there is no 128
   * origin here and no menu bar, which is the whole of the difference from
   * Sword1 and the reason this is a second method rather than a shared one.
   */
  pointerTargets(): Array<{
    id: number;
    x: number;
    y: number;
    /**
     * The whole rectangle, display pixels, for the same reason Sword1 reports
     * one: a midpoint is not enough to aim with. The floor's midpoint is the
     * middle of the room, which is as likely to be under the player or off the
     * walk grid as anywhere, and a caller aiming at the floor needs to know
     * where everything it must *not* hit is.
     */
    left: number;
    top: number;
    right: number;
    bottom: number;
    /**
     * 0 is the highest and 9 the lowest, and 9 is the floor.
     *
     * Reported because it is how this game decides what a click reaches —
     * `checkMouseList` scans priority 0 upwards (`mouse.cpp:1146`) — so a
     * caller looking for the floor can ask for the floor rather than guess
     * from an area or a list position.
     */
    priority: number;
    pointer: number;
    pointerText: number;
  }> {
    return this.renderer.hitTargets().map((target) => ({
      id: target.objectId,
      x: ((target.x1 + target.x2) >> 1) - this.renderer.scrollX,
      y: ((target.y1 + target.y2) >> 1) - this.renderer.scrollY,
      left: target.x1 - this.renderer.scrollX,
      top: target.y1 - this.renderer.scrollY,
      right: target.x2 - this.renderer.scrollX,
      bottom: target.y2 - this.renderer.scrollY,
      priority: target.priority,
      pointer: target.pointer,
      // The line the game would show under the pointer. Reported rather than
      // resolved, because a harness that wants the words can ask for them and
      // one that only wants to know a target is named does not have to.
      pointerText: target.pointerText,
    }));
  }

  /**
   * The game's own "there is a human" flag, `MOUSE_AVAILABLE`.
   *
   * Reported separately from {@link describeNotInteractive} so a harness can
   * print it beside the other reasons rather than having to parse a sentence.
   */
  get mouseAvailable(): boolean {
    return this.logic.getVar(SV2.MOUSE_AVAILABLE) !== 0;
  }

  /**
   * Whether the inventory bar is up because the pointer opened it.
   *
   * The bar's own `shown` flag is not the same question: the conversation
   * chooser raises it too, and a harness asking "can the player open their
   * inventory" would read a chooser as a yes.
   */
  get inventoryOpen(): boolean {
    return this.pointer.menuOpen;
  }

  /**
   * The icon the pointer is dragging, or 0.
   *
   * `OBJECT_HELD` and the luggage are two halves of one state and a harness
   * that reads only the first cannot tell "picked up" from "picked up and
   * drawn". This answers the second: it is non-zero only while there is a
   * luggage frame on the display.
   */
  get draggedIcon(): number {
    return this.luggageFrame() === null ? 0 : this.logic.getVar(SV2.OBJECT_HELD);
  }

  /** The icon resource of each thing the player is carrying, in bar order. */
  get inventoryIcons(): readonly number[] {
    return this.logic.menu.inventory.map((object) => object.icon);
  }

  /**
   * One of the game's own script globals, by number.
   *
   * The scripts keep every fact about the world here — what is held, what was
   * clicked, which puzzle has been done — and a harness driving the game needs
   * to read the same numbers the scripts branch on rather than infer them from
   * pixels. Read-only on purpose: writing one would be changing the world from
   * outside the scripts, which is what a save file is for.
   *
   * `sword2Vars.ts` names the ones this project relies on.
   */
  scriptVariable(id: number): number {
    return this.logic.getVar(id);
  }

  /**
   * The conversation topics on offer, with the point that picks each one.
   *
   * Empty unless a chooser is up: the bottom bar is the inventory the rest of
   * the time and clicking it then picks an object up, which is not what a
   * caller asking for topics means. `SwordEngine.pointerSubjects` is the same
   * question asked of the other family, and answers it in the same shape, so a
   * driver that can hold a conversation in one can hold one in the other.
   *
   * The point is the pocket's own centre, from the geometry `Sword2Screen`
   * draws the bar with, because a topic is chosen by clicking it and by
   * nothing else.
   */
  pointerSubjects(): Array<{ slot: number; value: number; x: number; y: number }> {
    if (!this.logic.menu.isChoosing) return [];
    const pitch = SWORD2_ICON_WIDTH + SWORD2_ICON_SPACING;
    const out: Array<{ slot: number; value: number; x: number; y: number }> = [];
    this.logic.menu.bars[SWORD2_MENU.BOTTOM].pockets.forEach((pocket, slot) => {
      if (!pocket) return;
      out.push({
        slot,
        value: pocket.icon,
        x: SWORD2_ICON_START + slot * pitch + (SWORD2_ICON_WIDTH >> 1),
        y: SWORD2_BOTTOM_MENU_TOP + (SWORD2_ICON_DEPTH >> 1),
      });
    });
    return out;
  }

  /**
   * Whether a cutscene is running that a player may press Escape out of.
   *
   * Every one of them, in this family: Revolution's own player checks for
   * Escape on each frame of every film and stops there (`animation.cpp`,
   * `MoviePlayer::play`), so there is no scene the game means a player to sit
   * through. `step` honours it through `Sword2Input.drainSkip`; this is the same
   * fact asked of the engine, so a headless driver presses where a player would
   * and nowhere else.
   *
   * **Deliberately not a member of `AdventureEngine`**: `AgosEngine` carries
   * the same accessor for the same reason and the two answer it from wholly
   * different evidence — a script bit there, a film here.
   */
  get cutsceneSkippable(): boolean {
    return this.sequence !== null;
  }

  /**
   * Why the player is not in control, or null when they are.
   *
   * `MOUSE_AVAILABLE` is the game's own flag — `fnAddHuman` sets it and
   * `fnNoHuman` clears it — and it is reported here even though this project
   * does not yet implement those two opcodes, because a probe that quietly
   * substituted a different test would report control the game has not given.
   */
  describeNotInteractive(): string | null {
    if (this.hasQuit) return 'the game has ended';
    if (this.loadError) return `a cluster failed to load: ${this.loadError}`;
    if (this.loading) return 'a cluster is still loading';
    if (this.sequence) return `the cutscene "${this.sequence.name}" is playing`;
    if (!this.mouseAvailable) {
      return 'the scripts have not made the mouse available (MOUSE_AVAILABLE is 0)';
    }
    if (this.renderer.hitTargets().length === 0) {
      return `nothing in session ${this.logic.session} is asking for the mouse`;
    }
    return null;
  }

  roomName(): string | undefined {
    // Sword2 names its objects and not its rooms, so this is undefined rather
    // than an invented name.
    return undefined;
  }

  describeStatus(): string | undefined {
    if (this.hasQuit) {
      if (this.quitReason === 'restart') return 'The game asked to restart.';
      if (this.quitReason === 'credits') {
        return (
          'The game is over: the closing sequence played and the scripts called ' +
          'fnPlayCredits, which ends the demo.'
        );
      }
      return 'George died. The original would offer its death screen here.';
    }
    if (this.loadError) return `Loading a cluster failed: ${this.loadError}`;
    if (this.loading) return 'Loading a cluster for the next session.';
    if (!this.booted) return undefined;

    const notes: string[] = [];
    if (this.sequence) {
      notes.push(
        `playing the cutscene "${this.sequence.name}", frame ${this.sequence.frame} of ` +
          `${this.sequence.smacker.info.frameCount} — press Escape to skip it`,
      );
    }
    if (this.skippedSequences.size > 0) {
      notes.push(
        `${this.skippedSequences.size} cutscene${this.skippedSequences.size === 1 ? '' : 's'} ` +
          `could not be played — this folder does not ship them, or they are not Smacker`,
      );
    }
    const unimplemented = this.logic.describeUnimplemented();
    if (unimplemented) notes.push(unimplemented);
    if (this.logic.faults.length > 0) notes.push(`${this.logic.faults.length} script faults`);
    return notes.join('; ');
  }

  describeStall(): string[] {
    const lines = [
      `Broken Sword II (${this.detection.release} release) — ${this.detection.evidence}`,
      this.resources.describe(),
      `started through screen manager ${this.startScreenManager} onto run list ` +
        `${this.startRunList}`,
      `session (run list) ${this.logic.session}, background ${this.background}, ` +
        `${this.renderer.size.width}x${this.renderer.size.height}, ` +
        `scroll ${this.renderer.scrollX},${this.renderer.scrollY}`,
      `${this.logic.cycles} logic cycles, ${this.frame} frames drawn`,
      `${this.logic.variableCount} script variables, from the game's own global variable file`,
      `${this.logic.loadedObjects().length} objects loaded this session`,
      this.sound.describe(),
      this.logic.router.describe(),
      this.describeText(),
      this.describePointer(),
    ];
    const unimplemented = this.logic.describeUnimplemented();
    if (unimplemented) lines.push(unimplemented);
    if (this.skippedSequences.size > 0) {
      lines.push(
        `cutscenes the scripts asked for and this project could not play: ` +
          `${[...this.skippedSequences].join(', ')}`,
      );
    }
    for (const fault of this.logic.faults.slice(0, 10)) lines.push(`fault: ${fault}`);
    for (const warning of this.renderer.warnings.slice(0, 10)) lines.push(`graphics: ${warning}`);
    for (const note of this.sound.notes.slice(0, 10)) lines.push(`sound: ${note}`);
    return lines;
  }

  /**
   * What the subtitles have done, which the probe had no way to see.
   *
   * "No text on screen" and "text on screen that this report cannot mention"
   * looked identical from the outside: the report named clusters, cycles and
   * opcodes and said nothing about the one thing a player reads. It says the
   * font it found, how many lines it has built, and how many are up now.
   */
  private describeText(): string {
    const font = this.text.resolvedFontId;
    const where =
      font === null ? `no font yet (${this.text.fontMissing ?? 'resolving'})` : `font ${font}`;
    const queued = this.logic.sequenceTextCount;
    return (
      `text: ${where}, ${this.linesShown} line${this.linesShown === 1 ? '' : 's'} built, ` +
      `${this.renderer.textBlocCount} on screen` +
      // Always zero on the demo, which sets `DEMO` and so queues none.
      (queued > 0 ? `, ${queued} queued for a cutscene that nothing draws yet` : '')
    );
  }

  /**
   * Which mouse mode the pointer is in, and what is on the inventory bar.
   *
   * On the status line for the reason the subtitle line is: "the inventory did
   * not open" and "the inventory opened and is empty" are different answers,
   * and until this was reported they looked the same from outside.
   */
  private describePointer(): string {
    const mode =
      this.pointer.mode === SWORD2_MOUSE_MODE.MENU
        ? 'menu'
        : this.pointer.mode === SWORD2_MOUSE_MODE.DRAG
          ? 'drag'
          : this.pointer.mode === SWORD2_MOUSE_MODE.SYSTEM_MENU
            ? 'system menu'
            : 'normal';
    const carried = this.logic.menu.inventory.length;
    const held = this.logic.getVar(SV2.OBJECT_HELD);
    return (
      `mouse: ${mode} mode, ${carried} object${carried === 1 ? '' : 's'} in the inventory` +
      (held ? `, holding icon ${held}` : '') +
      // Whether the luggage is on screen, not merely which one it is: it is
      // drawn from the frame *after* the pick-up, because the resource is
      // fetched asynchronously, and a status line that said "drawn" on the
      // cycle it is still being loaded would be a frame ahead of the picture.
      (this.pointer.luggage
        ? ` (luggage ${this.pointer.luggage}, ` +
          (this.luggage && this.luggageResource === this.pointer.luggage
            ? `drawn ${this.luggage.width}x${this.luggage.height} at the pointer)`
            : 'still loading)')
        : '')
    );
  }

  describeEditRefusal(): string | null {
    const project = importSword2Project(this.resources, this.detection);
    if (project.editable.editable) return null;
    return `Editing Broken Sword II is refused: ${project.editable.reasons.join('; ')}.`;
  }

  /**
   * Every recording this install holds, as an index rather than as bytes.
   *
   * Two listings rather than one, because this family keeps its recordings in
   * two places. **Effects are resources**: one id space, no fx table and no
   * tune table, and the `WAV_FILE` header that says nothing about which of the
   * three kinds it is — so the kind comes from the cluster it lives in, the
   * same rule `Sword2Sound` plays them by. **Speech and music are not.** A
   * retail disc keeps them in containers with an index of their own that
   * `resource.inf` never names, so they are listed from that index instead.
   *
   * A streamed cluster is never resident, so its resources are taken from the
   * offset table alone: `locate` answers without the bytes.
   */
  private async listAudio(): Promise<ProjectAudio[]> {
    const entries: Sword2AudioEntry[] = [];
    // The streamed containers first, because they are the ones this family
    // keeps outside its index: a retail disc's `SPEECH1.CLU` and `MUSIC1.CLU`
    // are files `resource.inf` never names, and their own table is the only
    // thing that says what is in them. Both demos ship neither, so on the data
    // reachable here this loop lists nothing — which is exactly why
    // `docs/editor-parity.md` §27a calls the write path written and unverified.
    for (const container of this.resources.soundFiles) {
      const index = await this.resources.readSoundIndex(container.file);
      if (!index) continue;
      for (const entry of index.entries()) {
        // One byte per sample after a two-byte first sample, so what an author
        // would save is a sample shorter than the payload.
        entries.push({
          id: entry.index,
          name: '',
          bytes: Math.max(0, entry.length - 1),
          cluster: container.name,
          file: container.file,
        });
      }
    }
    for (const id of this.resources.allIds()) {
      const located = this.resources.locate(id);
      if (!located) continue;
      const cluster = located.cluster.name;
      // The length in the table includes the resource header; what an author
      // would save is the recording, which is what follows it.
      const bytes = Math.max(0, located.length - RES_HEADER_SIZE);
      if (SWORD2_STREAMED.test(cluster)) {
        entries.push({ id, name: '', bytes, cluster });
        continue;
      }
      const resource = this.resources.fetch(id);
      if (!resource || resource.header.fileType !== Sword2FileType.WAV_FILE) continue;
      entries.push({ id, name: resource.header.name, bytes, cluster });
    }
    return listSword2Audio({ entries });
  }

  async toEditableGame(options: EditableGameOptions): Promise<EditableGame | null> {
    options.onProgress?.(0, 3, 'Broken Sword II: reading clusters');
    // The import walks every id and reads each resource's own type byte, so
    // every cluster has to be resident. A one-off cost at open, which is the
    // right trade for an editor (a lazy load would stall per click).
    for (const name of this.resources.presentClusters) {
      await this.resources.loadCluster(name, true);
    }

    options.onProgress?.(1, 3, 'Broken Sword II: decompiling objects');
    const project = importSword2Project(this.resources, this.detection);
    const audio = await this.listAudio();
    options.onProgress?.(3, 3, 'Broken Sword II project');

    return {
      project: {
        version: 6,
        target: this.target,
        name: this.gameId,
        start: { room: this.currentRoom, x: 0, y: 0 },
        defaultResponse: '',
        screen: { textHeight: 0, verbTop: 0 },
        verbs: [],
        actors: [],
        rooms: [],
        scripts: [],
        audio,
        sword2: project,
      },
      notes: [
        ...describeSword2Project(project),
        `${audio.length} recordings listed by number; their bytes stay in the game folder ` +
          `(ADR 0034)`,
      ],
    };
  }

  private get target(): Target {
    return {
      engine: 'sword2',
      release: this.detection.release,
      platform: 'dos',
      identification: this.detection.identification,
    };
  }

  /** Exported so a test can name the header size it expects. */
  static get resourceHeaderSize(): number {
    return RES_HEADER_SIZE;
  }

  /** Exported for the stall report's opcode naming. */
  static opcodeName(number: number): string {
    return sword2OpcodeName(number);
  }
}

export { Sword2ResourceError };
