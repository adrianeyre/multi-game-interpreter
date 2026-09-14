/**
 * `SwordEngine` — Broken Sword: The Shadow of the Templars as an
 * `AdventureEngine`.
 *
 * ## The seam, tested a seventh time
 *
 * ADR 0011 set a ceiling on `AdventureEngine`: "if it grows past roughly thirty
 * the seam is in the wrong place". Six families have added no member. This one
 * is the first whose display is **not 320x200** — it is 640x480 with the game
 * area inset by forty pixels top and bottom — and it still adds none, because
 * ADR 0015 already widened `resolution` into a script/display pair for SCI32.
 * So the answer here is `script: 640x400, display: 640x480`, and the shell
 * scales a canvas and maps a click with no branch. Seventeen members, a
 * seventh time, and the one thing that would have broken had been widened two
 * families earlier for a different reason.
 *
 * ## Where the awaiting happens, once more
 *
 * `SwordResources`'s header explains the split: the logic path only touches
 * clusters that are pinned resident, and a screen change is the one point at
 * which a region cluster has to arrive. This engine implements that split as a
 * **loading state**: `step()` returns without running a cycle while a load is
 * outstanding, and the shell's loop keeps calling it. That is faithful to the
 * original, which stopped for a CD seek at exactly the same point.
 *
 * ## What this engine does, and where it stops
 *
 * It reads the cluster index, opens the objects, runs the logic engine and the
 * bytecode, routes walks, animates, draws backgrounds, masks, parallax and
 * sprites, renders subtitles from the game's own font, plays effects, music and
 * recorded speech, handles the pointer and both menu bars, and saves.
 *
 It plays its cutscenes: `fnPlaySequence` names a Smacker under `smackshi/` or
 * `video/`, and the reader AGOS already had reads them (`SwordSequences`). The
 * film takes the screen, the logic stops while it runs, Escape skips it, and
 * the room's palette is restored afterwards. A sequence this install does not
 * ship is counted by name and the scripts carry on.
 *
 * Both of Revolution's walk animators are implemented — see `SwordRouter`.
 *
 * Everything a script can call is implemented or counted by name, and
 * `describeStall` prints the counts rather than leaving a player to guess.
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
import { importSword1Project, describeSword1Project } from '../../authoring/sword1/import.js';
import {
  readSword1Executable,
  sword1ExecutableFilesIn,
  type Sword1Executable,
} from '../../authoring/sword1/executable.js';
import type { ProjectAudio } from '../../authoring/audio.js';
import { listSword1Audio } from '../../authoring/sword1/audioList.js';
import { sword1SpeechFileIn } from './sound/musicFiles.js';
import { readSword1SpeechIndex } from './sound/speechIndex.js';
import { SwordInput } from './SwordInput.js';
import { SwordSound } from './sound/SwordSound.js';
import { SwordUi } from './SwordUi.js';
import { SwordScreen, type SwordMouseTarget } from './gfx/SwordScreen.js';
import { SwordText } from './gfx/SwordText.js';
import { SwordLogic, type SwordLogicHost } from './script/SwordLogic.js';
import { SwordObjects } from './resource/SwordObjects.js';
import {
  SwordResources,
  SwordResourceError,
  SWORD1_RESIDENT_CLUSTERS,
} from './resource/SwordResources.js';
import {
  identifySword1,
  SWORD1_PLATFORM_NAMES,
  type Sword1Detection,
} from './resource/swordDetect.js';
import {
  SWORD1_CZECH_GAME_FONT,
  SWORD1_GAME_FONT,
  SWORD1_ITM_PER_SEC,
  SWORD1_MENU_BAR_HEIGHT,
  SWORD1_PLAYER,
  SWORD1_SCREEN_FULL_DEPTH,
  SWORD1_SCREEN_LEFT_EDGE,
  SWORD1_SCREEN_TOP_EDGE,
  SWORD1_SCREEN_WIDTH,
  SWORD1_STAND,
  SWORD1_TEXT_SECT,
  SwordStatus,
} from './resource/swordDefs.js';
import { SwordTexts } from './resource/swordTextResources.js';
import { SV } from './script/swordVarIndex.js';
import { DEMO_OVERLAP, OVERLAP } from './gfx/SwordText.js';
import { CPT, type SwordCompact } from './resource/swordCompact.js';
import { interpretSword1Script } from './script/SwordInterpreter.js';
import { parseSword1ScriptModule } from './script/swordTokens.js';
import { SWORD1_SECTION_SCRIPTS } from './resource/swordSections.js';
import {
  advanceSequence,
  findSequenceFiles,
  openFirstSequence,
  type SwordSequence,
} from './video/SwordSequences.js';
import { sword1SequenceName } from './video/sequenceNames.js';
import { SWORD1_TOTAL_POCKETS } from './resource/swordMenuTables.js';

/** This family's save payload version. Independent of every other family's. */
export const SWORD1_SAVE_FORMAT = 1;

/**
 * The one screen the original refuses to open its control panel on.
 *
 * "Disable the save screen on the phone envelope room!" (`sword1.cpp:268`).
 */
const SWORD1_NO_PANEL_SCREEN = 91;

/**
 * Twelve cycles a second — `DEFAULT_FRAME_TIME` is 80ms, so 12.5Hz.
 *
 * Exported because it is also the rate an animation plays at: the anim driver
 * advances `o_anim_pc` by exactly one a cycle, so this number is the whole of
 * Broken Sword's animation timing and the editor's preview reads it from here
 * rather than choosing one (`docs/editor-parity.md` §18).
 */
export const SWORD1_TICKS_PER_STEP = 5;

export interface SwordEngineOptions {
  onLog?: (message: string) => void;
  onActivity?: (activity: string) => void;
  /**
   * Which start position to open on — the original's `boot_param`.
   *
   * 0 is a new game and is the default. 1..80 open at a section directly, the
   * way Revolution's own debug parameter did, and 956..962 are Spain revisited.
   * Carried as an option rather than as a constant because the editor's "play
   * from here" needs it: playing a screen means starting the game in it.
   */
  startPosition?: number;
}

/** A Broken Sword save: the shared envelope, plus this family's world. */
interface SwordSavedGame extends SavedGameEnvelope {
  /** The globals, all 1,179 of them. */
  readonly scriptVars: number[];
  /** Section number -> that section's compact words. */
  readonly sections: Array<{ section: number; words: number[] }>;
  readonly liveList: number[];
  readonly events: number[];
  readonly ui: { pointer: number; luggage: number; subjects: number[] };
}

export class SwordEngine implements AdventureEngine {
  readonly saveFormat = SWORD1_SAVE_FORMAT;
  readonly saveNote =
    'Broken Sword saves are this interpreter’s own format and are not readable by ScummVM, or ' +
    'by this project’s SCUMM, AGI, SCI, AGOS, Sky or Lure saves.';

  /**
   * 640x480 for both halves, because this family's pointer is in display
   * pixels and `resolution.script` is what a click is scaled through.
   *
   * This used to say 640x400 — the room's height — on the reasoning that "the
   * game's menus live in the forty-pixel bars the scripts never address". The
   * observation is right and the conclusion was wrong, because the two halves
   * of `resolution` mean a *scale* and not an *inset*. `src/main.ts` maps a
   * click as `(clientY / rect.height) * script.height` and `PlayOverlay` does
   * the same, so a 400 here divides every pointer Y by 480 and multiplies it
   * by 400. SCI32, which the pair was widened for (ADR 0015), is a true scale:
   * 320x200 of script covering all of a 640x480 display. Broken Sword's 400 is
   * a strip *inside* its display, and a linear map through it is not a
   * conversion of anything.
   *
   * What the shipped bug looked like: every click landed high, by more the
   * further down the screen it was, and the bottom bar — display y 440 and
   * below — could not be reached at all, because 400 was the largest Y the
   * shell could produce. That bar is the conversation chooser, so a topic
   * could not be picked with a mouse.
   *
   * The forty-pixel bars are still real and still not the scripts' space.
   * `SwordUi.engine` is where that is handled, and it is handled in display
   * pixels: it tests `pointerY < 40` for the top menu and sets
   * `MOUSE_Y = SCROLL_OFFSET_Y + pointerY + 128 - 40`, subtracting the bar
   * itself. Feeding it a Y that had already been scaled by 400/480 made that
   * subtraction the second of two corrections where one was wanted.
   *
   * `SWORD1_SCREEN_DEPTH` is unchanged and still names the room's height,
   * which is what the renderer and the room table mean by it.
   */
  readonly resolution = {
    script: { width: SWORD1_SCREEN_WIDTH, height: SWORD1_SCREEN_FULL_DEPTH },
    display: { width: SWORD1_SCREEN_WIDTH, height: SWORD1_SCREEN_FULL_DEPTH },
  };

  /** The display framebuffer the shell presents. */
  readonly screen = new Screen(SWORD1_SCREEN_WIDTH, SWORD1_SCREEN_FULL_DEPTH);

  readonly input = new SwordInput();
  readonly sound: SwordSound;

  frame = 0;
  hasQuit = false;

  /**
   * What the control panel asks the shell for, when a player presses F5 or F7.
   *
   * `Control::getPlayerOptions` is a whole screen of the original's own — its
   * own panel graphics, its own eight slots, its own scroll bar. The slots a
   * player's saves actually live in here are the shell's ten (ADR 0012), so
   * the key is a *request* rather than a panel: the same seam Broken Sword
   * II's system menu uses and the same one `AgiEngine` has had all along.
   * Null means no shell is listening, and the keys do nothing rather than
   * appearing to.
   */
  onSaveRequested: (() => void) | null = null;
  onRestoreRequested: (() => void) | null = null;

  private readonly objects: SwordObjects;
  private readonly renderer: SwordScreen;
  private readonly texts: SwordTexts;
  private readonly font: SwordText;
  private readonly ui: SwordUi;
  private readonly logic: SwordLogic;

  private booted = false;
  /**
   * `SwordEngine::_systemVars.justRestoredGame`.
   *
   * A restore re-enters the saved screen so its clusters, layers and palette
   * are loaded — and screen entry is also how a *doorway* works, which places
   * George at the `CHANGE_*` globals the room he left wrote. Those globals hold
   * the last doorway, not the save, so entering the screen without this flag
   * walks a restored George back to where he came into the room: the probe
   * measured a save taken at 371,413 restoring to 481,413, the screen's own
   * entry point. Revolution's answer is this flag and `Logic::newScreen`'s
   * first branch (`logic.cpp:127-135`), and this is that flag.
   */
  private justRestored = false;
  /** True while a cluster load is outstanding; `step` runs no cycle then. */
  private loading = true;
  private loadError: string | null = null;
  /** Sequences `fnPlaySequence` asked for and this project could not play. */
  private readonly skippedSequences = new Set<number>();
  /** The cutscene on screen, or null. While one runs, no logic cycle does. */
  private sequence: SwordSequence | null = null;
  /** The room's colours, kept while a cutscene owns the palette. */
  private paletteBeforeSequence: Uint8Array | null = null;
  /** The folder's file names, for finding a sequence's Smacker. */
  private videoNames: readonly string[] = [];

  /**
   * The folder this install was opened from, kept for the files outside the RIF.
   *
   * Music and speech are both files rather than resources, and the speech
   * container is read by range rather than whole, so a reader function is not
   * enough — `listAudio` and `SwordSound` both want the source itself.
   */
  private source: DataSource | null = null;
  /** Reads a file, for the sequence loader. Set at create. */
  private readFile: ((name: string) => Promise<Uint8Array | null>) | null = null;
  private quitReason: 'quit' | 'restart' | 'death' | 'the-end' | null = null;
  /** Text compacts in use, so `lowTextManager`'s slot search has state. */
  private textSlots = 0;
  /** The original's `boot_param`: which start position `boot` opens on. */
  private startPosition = 0;

  /** The hit list the pointer was tested against last cycle. See `step`. */
  private lastTargets: readonly SwordMouseTarget[] = [];

  private constructor(
    private readonly resources: SwordResources,
    private readonly detection: Sword1Detection,
    private readonly log?: (message: string) => void,
  ) {
    this.objects = new SwordObjects(resources);
    this.renderer = new SwordScreen(resources, this.objects);
    this.texts = new SwordTexts(resources);
    // The Czech release ships its own font, HIF-compressed where the others are
    // not. Chosen by *presence* rather than by a language flag, because a
    // release's language is not established until its text is read — and asked
    // lazily, because this constructor runs before `loadResident` and at this
    // moment neither font is fetchable. Probing here answered "no font" for
    // every install, Czech or not.
    this.font = new SwordText(
      resources,
      [SWORD1_CZECH_GAME_FONT, SWORD1_GAME_FONT],
      detection.release === 'demo' ? DEMO_OVERLAP : OVERLAP,
    );
    this.sound = new SwordSound(resources, [], undefined, detection.release === 'demo');
    this.ui = new SwordUi({
      runMouseScript: (compact, script) => this.runMouseScript(compact, script),
      presetScript: (targetId, script) => this.presetScript(targetId, script),
      fetch: (id) => this.objects.fetch(id),
      getVar: (number) => this.logic.getVar(number),
      setVar: (number, value) => this.logic.setVar(number, value),
    });
    this.logic = new SwordLogic(this.objects, resources, this.logicHost());
  }

  /**
   * Opens a folder, or refuses with something a person can act on.
   *
   * `SwordResources.create` does the refusing, by cluster name — an install
   * without `COMPACTS`, `GENERAL` or `SCRIPTS` cannot start, and saying which
   * is the difference between a fixable problem and a black screen.
   */
  static async create(source: DataSource, options: SwordEngineOptions = {}): Promise<SwordEngine> {
    const detection = identifySword1(source.list());
    const resources = await SwordResources.create(source, { onLog: options.onLog });
    const engine = new SwordEngine(resources, detection, options.onLog);
    engine.startPosition = options.startPosition ?? 0;

    options.onActivity?.('Loading Broken Sword clusters');
    await resources.loadResident();
    // Music and speech are both read from files rather than from clusters, so
    // the engine hands the sound object the names and the source itself rather
    // than a cluster label.
    engine.attachFiles(source);
    engine.loading = false;

    options.onLog?.(
      `Broken Sword (${detection.release} release) — ${detection.evidence}; ` +
        resources.describe(),
    );
    return engine;
  }

  /**
   * Points the sound object at the install's files.
   *
   * The whole list, not a filtered one: a tune is `MUSIC/1M10.WAV` but the
   * speech container is `SPEECH/COWS.MAD` or `SPEECH1.CLU`, and a filter built
   * from audio extensions hid the second from the code that looks for it.
   */
  private attachFiles(source: DataSource): void {
    this.source = source;
    this.videoNames = source.list();
    this.readFile = (name) => source.read(name);
    // Rebuilt rather than mutated, because `SwordSound`'s file list is readonly
    // by design: the set of files cannot change while a game runs.
    (this.sound as unknown as { musicNames: readonly string[] }).musicNames = source.list();
    (
      this.sound as unknown as { readFile?: (name: string) => Promise<Uint8Array | null> }
    ).readFile = (name) => source.read(name);
    // A speech container is tens of megabytes and every line is a range inside
    // it, so the sound object gets the source to read ranges from rather than a
    // reader that would hand it the whole file per line.
    this.sound.attachSpeech(source);
  }

  get gameId(): string {
    return `sword1-${this.detection.release}`;
  }

  /**
   * The Target, with the platform its files state rather than an assumed one.
   *
   * This read `Sword1 (${release} release, DOS)`, and the word DOS was a
   * constant. Measured against the five Broken Sword demos on
   * `scummvm.org/demos`, that made the Macintosh demo announce itself as DOS
   * and the PlayStation one as "psx release, DOS", which contradicts itself in
   * four words. A platform is evidence now (`identifySword1Platform`), and a
   * folder whose files do not say is not called anything.
   */
  get targetName(): string {
    const platform = SWORD1_PLATFORM_NAMES[this.detection.platform];
    return `Sword1 (${this.detection.release} release${platform ? `, ${platform}` : ''})`;
  }

  get currentRoom(): number {
    return this.logic.getVar(SV.SCREEN);
  }

  get ticksPerStep(): number {
    return SWORD1_TICKS_PER_STEP;
  }

  /** Runs the opening: the world's starting globals, then the first screen. */
  boot(): void {
    if (this.booted) return;
    this.booted = true;
    this.logic.initialise(this.detection.release === 'demo');
    this.objects.initialise();

    /*
     * **And then the start position**, which is what turns a loaded world into
     * a started game.
     *
     * `initialise` sets the 95 non-zero globals and stops there, and `SCREEN`
     * is not one of them: it and `NEW_SCREEN` are both still zero, which is the
     * uninitialised value rather than a screen number. Without this call the
     * first cycle entered nothing, no region cluster was ever asked for, and
     * the framebuffer stayed the colour it was cleared to — measured at 0
     * non-black pixels of 307,200.
     *
     * `startPosition` is the original's `boot_param`: 0 for a new game, which
     * runs the opening and puts the player into section 1.
     */
    const refused = this.logic.startPositions(this.startPosition);
    if (refused) this.log?.(refused);

    if (this.font.fontMissing) {
      this.log?.(`no game font, so no subtitles: ${this.font.fontMissing}`);
    }
    for (const warning of this.objects.warnings) this.log?.(warning);

    // `NEW_SCREEN` is set by the start position, and the first cycle's job is
    // to notice that it differs from `SCREEN` and enter it.
    this.log?.(
      `Broken Sword booted: opening on screen ${this.logic.getVar(SV.NEW_SCREEN)}, ` +
        `${this.objects.liveSections().length} sections alive`,
    );
  }

  /**
   * One tick: enter a new screen if asked, then one logic cycle, then draw.
   *
   * The screen-change branch comes first because that is where the original's
   * outer loop is, and it is the only point at which this engine awaits.
   */
  step(): void {
    if (!this.booted) this.boot();
    if (this.hasQuit) return;
    // A cutscene owns the screen: no logic cycle runs while it does, which is
    // what the original's blocking `fnPlaySequence` amounts to.
    if (this.sequence) {
      if (this.input.drainSkip() || !this.drawSequenceFrame()) this.endSequence();
      this.frame++;
      return;
    }
    // A load is outstanding: no cycle runs, so no script sees a resource that
    // is about to arrive as absent.
    if (this.loading) return;

    const newScreen = this.logic.getVar(SV.NEW_SCREEN);
    if (newScreen !== this.renderer.screen) {
      this.enterScreen(newScreen);
      return;
    }

    this.ui.setInput(this.input.x, this.input.y, this.input.drainButtons());
    this.checkPanelKeys();
    if (this.input.drainSkip()) {
      // Escape with no film running — one would have been caught above. The
      // original's key also cuts the current line of speech short, which is
      // the visible effect a player expects from it between cutscenes.
      this.logic.speech.finished = true;
    }

    this.logic.engine();
    this.updateScroll();
    this.renderer.draw();
    // Kept rather than read twice: the renderer's list is emptied on the next
    // line, so this is the only moment the cycle's hit list exists. `ui.engine`
    // gets exactly what `pointerTargets` will report, which is what makes the
    // harness's idea of "what is clickable" the engine's own.
    this.lastTargets = this.renderer.hitTargets();
    this.ui.engine(this.lastTargets);
    this.renderer.clearMouseList();
    this.frame++;

    // The asynchronous half of a cycle: samples to decode, clusters a
    // `fnPreload` asked for. Never awaited here — the promise drains before the
    // next tick, and a sample that is late is simply not heard.
    void this.sound.pump();
    void this.drainWantedResources();
  }

  /**
   * `SwordEngine::checkKeys`' first case: the control panel, and when it opens.
   *
   * All three of the original's guards, because each of them is a moment the
   * panel would otherwise cover something the player cannot get back to: no
   * panel without a human (`MOUSE_STATUS & 1`), none while George is holding a
   * piece of the puzzle he is assembling (`GEORGE_HOLDING_PIECE`), and none on
   * screen 91 — "Disable the save screen on the phone envelope room!"
   * (`sword1.cpp:266-271`), which is a room whose state a save cannot hold.
   */
  private checkPanelKeys(): void {
    const wanted = this.input.drainPanel();
    if (!wanted) return;
    if (!(this.logic.getVar(SV.MOUSE_STATUS) & 1)) {
      this.log?.('the control panel is not available while the human is switched off');
      return;
    }
    if (this.logic.getVar(SV.GEORGE_HOLDING_PIECE) !== 0) {
      this.log?.('the control panel is not available while George is holding a piece');
      return;
    }
    if (this.logic.getVar(SV.SCREEN) === SWORD1_NO_PANEL_SCREEN) {
      this.log?.(
        'the control panel is disabled in the phone envelope room, as it is in the original',
      );
      return;
    }
    if (wanted === 'save') this.onSaveRequested?.();
    else this.onRestoreRequested?.();
  }

  /** Loads a screen's clusters, then enters it. */
  private enterScreen(screen: number): void {
    this.loading = true;
    void (async (): Promise<void> => {
      try {
        for (const id of SwordScreen.resourcesFor(screen)) {
          await this.resources.load(id);
        }
        this.renderer.newScreen(screen);
        const limits = this.renderer.scrollLimits();
        this.logic.setVar(SV.SCROLL_FLAG, limits.flag);
        this.logic.setVar(SV.MAX_SCROLL_OFFSET_X, limits.maxX);
        this.logic.setVar(SV.MAX_SCROLL_OFFSET_Y, limits.maxY);
        this.logic.setVar(SV.SCROLL_OFFSET_X, 0);
        this.logic.setVar(SV.SCROLL_OFFSET_Y, 0);
        this.newScreenLogic(screen);
        this.logic.setVar(SV.SCREEN, screen);
        for (const warning of this.renderer.warnings) this.log?.(warning);
      } catch (error) {
        this.loadError = error instanceof Error ? error.message : String(error);
        this.log?.(`entering screen ${screen} failed: ${this.loadError}`);
      } finally {
        this.loading = false;
      }
    })();
  }

  /**
   * `Logic::newScreen`: move the player and stand them where the script said.
   *
   * The four `CHANGE_*` globals are how a room transition passes the player's
   * new position between screens, and they are written by the *exit* script of
   * the room being left — so reading them here rather than in the script is
   * what makes an exit work.
   */
  private newScreenLogic(screen: number): void {
    const player = this.objects.fetch(SWORD1_PLAYER);
    if (!player) return;
    /*
     * A restore is the other branch, and it is the opposite instruction: leave
     * George exactly where the save put him. `o_screen` is already the saved
     * one, so it is not written either — writing `screen` over it would be the
     * same arithmetic with the same answer only while the two agree.
     *
     * `fnAddHuman` gives the pointer back, because a save may have been taken
     * from the panel while the scripts had taken it away. And a save taken
     * *mid-walk* is the one case George is moved: the walk's own animation
     * state would resume against a route that is no longer being followed, so
     * the original stands him at the position the restore just published and
     * idles him (`logic.cpp:129-133`).
     */
    if (this.justRestored) {
      this.justRestored = false;
      this.logic.callMcode(49, [], player, SWORD1_PLAYER); // fnAddHuman
      if (this.logic.getVar(SV.GEORGE_WALKING) !== 0) {
        this.logic.callMcode(
          72, // fnStandAt
          [
            this.logic.getVar(SV.CHANGE_X),
            this.logic.getVar(SV.CHANGE_Y),
            this.logic.getVar(SV.CHANGE_DIR),
            this.logic.getVar(SV.CHANGE_STANCE),
          ],
          player,
          SWORD1_PLAYER,
        );
        this.logic.callMcode(18, [], player, SWORD1_PLAYER); // fnIdle
        this.logic.setVar(SV.GEORGE_WALKING, 0);
      }
      return;
    }
    player.screen = screen;
    this.logic.callMcode(
      72, // fnStandAt
      [
        this.logic.getVar(SV.CHANGE_X),
        this.logic.getVar(SV.CHANGE_Y),
        this.logic.getVar(SV.CHANGE_DIR),
        this.logic.getVar(SV.CHANGE_STANCE),
      ],
      player,
      SWORD1_PLAYER,
    );
    this.logic.callMcode(68, [this.logic.getVar(SV.CHANGE_PLACE)], player, SWORD1_PLAYER);
  }

  /** `Logic::updateScreenParams`: scroll to keep the player near their anchor. */
  private updateScroll(): void {
    const player = this.objects.fetch(SWORD1_PLAYER);
    if (!player) return;
    this.renderer.setScrolling(
      player.x - this.logic.getVar(SV.FEET_X),
      player.y - this.logic.getVar(SV.FEET_Y),
    );
    this.logic.setVar(SV.SCROLL_OFFSET_X, this.renderer.scrollX);
    this.logic.setVar(SV.SCROLL_OFFSET_Y, this.renderer.scrollY);
  }

  /** Loads whatever a synchronous fetch could not answer this cycle. */
  private async drainWantedResources(): Promise<void> {
    if (this.resources.wanted.length === 0) return;
    await this.resources.satisfyWanted();
  }

  render(): void {
    // A cutscene has already drawn straight into the framebuffer, and the room
    // behind it must not be composited over the film.
    if (this.sequence) return;
    this.renderer.present(this.screen.pixels);
  }

  present(context: CanvasRenderingContext2D): void {
    this.screen.present(context, this.renderer.palette);
  }

  /**
   * Starts a cutscene, or says it could not.
   *
   * Returns true when the film is now running — the logic then stops for as
   * long as it takes. The load is asynchronous and the sequence begins on the
   * tick after, which is why this answers true before a frame exists: the
   * alternative is a cycle running underneath a film about to appear.
   */
  private beginSequence(sequenceId: number): boolean {
    const name = sword1SequenceName(sequenceId);
    if (!name || !this.readFile) {
      this.skippedSequences.add(sequenceId);
      return false;
    }
    const candidates = findSequenceFiles(this.videoNames, name);
    if (candidates.length === 0) {
      this.skippedSequences.add(sequenceId);
      this.log?.(`sequence ${sequenceId} ("${name}") is not in this folder, so it is skipped`);
      return false;
    }

    this.loading = true;
    const read = this.readFile;
    void (async (): Promise<void> => {
      try {
        const opened = await openFirstSequence(this.videoNames, name, (file) => read(file));
        if (!opened) {
          this.skippedSequences.add(sequenceId);
          this.log?.(
            `sequence ${sequenceId} ("${name}"): ${candidates.join(', ')} ` +
              `${candidates.length === 1 ? 'is' : 'are'} not a Smacker this project reads`,
          );
          return;
        }
        this.paletteBeforeSequence = this.renderer.palette.snapshot();
        this.sequence = opened.sequence;
        this.log?.(
          `playing sequence ${sequenceId} ("${name}") from ${opened.file}: ` +
            `${opened.sequence.smacker.info.frameCount} frames at ` +
            `${opened.sequence.smacker.info.width}x${opened.sequence.smacker.info.displayHeight}`,
        );
      } finally {
        this.loading = false;
      }
    })();
    return true;
  }

  /** Draws one frame of the running cutscene. False when it has ended. */
  private drawSequenceFrame(): boolean {
    if (!this.sequence) return false;
    const frame = advanceSequence(
      this.sequence,
      this.screen.pixels,
      SWORD1_SCREEN_WIDTH,
      SWORD1_SCREEN_FULL_DEPTH,
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

  /** Ends the cutscene and gives the room its colours back. */
  private endSequence(): void {
    this.sequence = null;
    if (this.paletteBeforeSequence) {
      this.renderer.palette.setFromClut(this.paletteBeforeSequence);
      this.paletteBeforeSequence = null;
    }
  }

  /** What the logic engine is given: everything outside the script machine. */
  private logicHost(): SwordLogicHost {
    return {
      addToGraphicList: (list, id) => this.renderer.addToGraphicList(list, id),
      addToMouseList: (id, compact) => this.renderer.addToMouseList(id, compact),
      fadePalette: () => {
        // A fade is a palette ramp over frames. The palette is set directly
        // here, so a fade reads as a cut — visible, harmless, and named on the
        // status line rather than left to look like a bug.
      },
      stillFading: () => 0,
      setPalette: (start, length, resourceId) =>
        this.renderer.setPalette(start, length, resourceId),
      setFadeTargetPalette: (start, length, resourceId) =>
        this.renderer.setPalette(start, length, resourceId),
      flash: (colour) => this.renderer.flash(colour),
      setParallax: () => {
        // `fnSetParallax` replaces a screen's parallax mid-room. Re-entering the
        // screen is how this engine picks it up, so the call is a no-op rather
        // than wrong: the layer the room table names is already drawn.
      },
      playFx: (fxNo) => this.sound.playFx(fxNo),
      stopFx: (fxNo) => this.sound.stopFx(fxNo),
      playMusic: (tuneId, looped) => this.sound.playMusic(tuneId, looped),
      stopMusic: () => this.sound.stopMusic(),
      startSpeech: (section, line) => this.sound.startSpeech(section, line),
      speechFinished: () => this.sound.speechFinished(),
      stopSpeech: () => this.sound.stopSpeech(),
      makeTextSprite: (textId, width, pen) => this.makeTextSprite(textId, width, pen),
      releaseText: (textCompactId) => {
        this.renderer.setTextSprite(textCompactId, null);
        if (this.textSlots > 0) this.textSlots--;
      },
      textSpriteSize: (textCompactId) => this.renderer.textSpriteSize(textCompactId),
      textDuration: (textId) => {
        const line = this.texts.line(textId);
        // `strlen(text) + 5` in the original: the subtitle stays up for as many
        // cycles as it has characters, plus a beat.
        return line ? line.length + 5 : 0;
      },
      mouse: {
        noHuman: () => this.ui.noHuman(),
        addHuman: () => this.ui.addHuman(),
        blank: () => this.ui.blank(),
        normal: () => this.ui.normal(),
        lock: () => this.ui.lock(),
        unlock: () => this.ui.unlock(),
        setPointer: (tag, rate) => this.ui.setPointer(tag, rate),
        setLuggage: (tag, rate) => this.ui.setLuggage(tag, rate),
        testEvent: () => this.ui.testEvent(),
      },
      menu: {
        startMenu: () => this.ui.startMenu(),
        endMenu: () => this.ui.endMenu(),
        releaseMenu: () => this.ui.releaseMenu(),
        addSubject: (subject) => this.ui.addSubject(subject),
        startChooser: (compact) => this.ui.startChooser(compact),
        endChooser: () => this.ui.endChooser(),
        logicChooser: (compact) => this.ui.logicChooser(compact),
        refreshTop: () => this.ui.refreshTop(),
      },
      playSequence: (sequenceId) => this.beginSequence(sequenceId),
      requestQuit: (reason) => {
        this.quitReason = reason;
        this.hasQuit = true;
      },
      random: (min, max) => min + Math.floor(Math.random() * (max - min + 1)),
      preload: (resourceId) => {
        // A preload is exactly a want: the engine's own drain loads it, which is
        // what `fnPreload` is for.
        void this.resources.load(resourceId);
      },
      log: (message) => this.log?.(message),
    };
  }

  /**
   * `Text::lowTextManager`: finds a free text compact and renders into it.
   *
   * There are two text compacts (section 149), which is Revolution's cap. A
   * third line of simultaneous speech is refused rather than overwriting one,
   * because overwriting is what makes a subtitle vanish mid-sentence.
   */
  private makeTextSprite(textId: number, width: number, pen: number): number {
    const line = this.texts.line(textId);
    if (!line) return 0;
    const sprite = this.font.makeTextSprite(line, width, pen);
    if (!sprite) return 0;

    for (let slot = 0; slot < 2; slot++) {
      const id = SWORD1_TEXT_SECT * SWORD1_ITM_PER_SEC + slot;
      const compact = this.objects.fetch(id);
      if (!compact || compact.status !== 0) continue;
      compact.status = SwordStatus.FORE;
      this.renderer.setTextSprite(id, sprite);
      this.textSlots++;
      return id;
    }
    this.log?.(
      `both text compacts are in use, so the subtitle for text ${textId} was dropped rather ` +
        `than overwriting a line still on screen`,
    );
    return 0;
  }

  /** `Logic::runMouseScript`: run a script now, outside the object's tree. */
  private runMouseScript(compact: SwordCompact | null, script: number): void {
    if (!script) return;
    const target = compact ?? this.objects.fetch(this.logic.getVar(SV.SPECIAL_ITEM));
    if (!target) return;
    const section = Math.floor(script / SWORD1_ITM_PER_SEC);
    const resourceId = SWORD1_SECTION_SCRIPTS[section] ?? 0;
    if (!resourceId) return;
    const resource = this.resources.fetch(resourceId);
    if (!resource) return;
    try {
      const module = parseSword1ScriptModule(resource.payload, this.resources.bigEndian);
      interpretSword1Script(
        module,
        this.logic,
        target,
        this.logic.getVar(SV.SPECIAL_ITEM),
        script,
        script & 0xffff,
      );
    } catch (error) {
      this.log?.(
        `a mouse script (${script}) would not run: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  /** `cfnPresetScript` reached from the UI rather than from a script. */
  private presetScript(targetId: number, script: number): void {
    const target = this.objects.fetch(targetId);
    if (!target) return;
    this.logic.callMcode(33, [targetId, script], target, targetId);
  }

  saveState(name: string): SavedGameEnvelope {
    const sections = [...this.objects.snapshot()].map(([section, words]) => ({
      section,
      words: Array.from(words),
    }));
    const saved: SwordSavedGame = {
      format: SWORD1_SAVE_FORMAT,
      gameId: this.gameId,
      savedAt: Date.now(),
      name,
      room: this.currentRoom,
      scriptVars: Array.from(this.logic.scriptVars),
      sections,
      liveList: this.objects.liveListSnapshot(),
      events: this.logic.events.snapshot(),
      ui: this.ui.snapshot(),
    };
    return saved;
  }

  /**
   * Restores a save, or refuses without touching anything.
   *
   * Every check runs before a word is applied, which is `AdventureEngine`'s
   * rule and matters here for the reason it matters in Sky and Lure: the
   * compacts *are* the world, so a half-applied restore is two games' objects
   * at once.
   */
  loadState(saved: SavedGameEnvelope): void {
    const candidate = saved as SwordSavedGame;
    if (candidate.format !== SWORD1_SAVE_FORMAT) {
      throw new Error(
        `This save is format ${candidate.format} and this engine writes ${SWORD1_SAVE_FORMAT}.`,
      );
    }
    if (candidate.gameId !== this.gameId) {
      throw new Error(
        `This save is for "${candidate.gameId}" and this game is "${this.gameId}". A save is ` +
          `tagged with the Target that wrote it (ADR 0012), so it is refused rather than ` +
          `half-applied.`,
      );
    }
    if (!Array.isArray(candidate.scriptVars) || !Array.isArray(candidate.sections)) {
      throw new Error('This save carries no Broken Sword world, so there is nothing to restore.');
    }
    if (candidate.scriptVars.length !== this.logic.scriptVars.length) {
      throw new Error(
        `This save holds ${candidate.scriptVars.length} script variables and Broken Sword has ` +
          `${this.logic.scriptVars.length}. It is refused rather than half-applied.`,
      );
    }

    const sections = new Map<number, Int32Array>();
    for (const entry of candidate.sections)
      sections.set(entry.section, Int32Array.from(entry.words));
    // `SwordObjects.restore` does its own checks before writing, so a save whose
    // section lengths disagree with this install throws here rather than half
    // way through.
    this.objects.restore(sections, candidate.liveList ?? []);
    this.logic.scriptVars.set(candidate.scriptVars);
    if (Array.isArray(candidate.events)) this.logic.events.restore(candidate.events);
    if (candidate.ui) this.ui.restore(candidate.ui);

    this.booted = true;
    /*
     * Publish George's own position through the globals the screen entry reads,
     * and say that this entry is a restore — `Control::doRestore`'s last five
     * lines (`control.cpp:3084-3090`), in the same order and for the same
     * reason. Without them the entry below walks him to the doorway the room
     * was last come in by.
     */
    const player = this.objects.fetch(SWORD1_PLAYER);
    if (player) {
      this.logic.setVar(SV.CHANGE_DIR, player.dir);
      this.logic.setVar(SV.CHANGE_X, player.x);
      this.logic.setVar(SV.CHANGE_Y, player.y);
      this.logic.setVar(SV.CHANGE_STANCE, SWORD1_STAND);
      this.logic.setVar(SV.CHANGE_PLACE, player.get(CPT.PLACE));
    }
    this.justRestored = true;
    // Force the screen to be re-entered, so its clusters, layers and palettes
    // are loaded for wherever the save was made.
    this.logic.setVar(SV.NEW_SCREEN, candidate.room);
    this.renderer.newScreen(-1);
    const music = this.logic.getVar(SV.CURRENT_MUSIC);
    if (music) this.sound.playMusic(music, true);
  }

  roomName(room: number): string | undefined {
    // Broken Sword does not name its screens in its data — the room table is
    // numbers — so this is undefined rather than an invented name.
    void room;
    return undefined;
  }

  describeStatus(): string | undefined {
    if (this.hasQuit) {
      const reasons: Record<string, string> = {
        quit: 'The game asked to quit.',
        restart: 'The game asked to restart.',
        death: 'George died. The original would offer its death screen here.',
        'the-end': 'The game is over — this is the ending.',
      };
      return reasons[this.quitReason ?? 'quit'];
    }
    if (this.loadError) return `Loading a screen failed: ${this.loadError}`;
    if (this.loading) return 'Loading a cluster for the next screen.';
    if (!this.booted) return undefined;

    const notes: string[] = [];
    if (this.font.fontMissing) notes.push('no font, so no subtitles');
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
    return notes.length > 0 ? notes.join('; ') : undefined;
  }

  describeStall(): string[] {
    const lines = [
      `Broken Sword (${this.detection.release} release) — ${this.detection.evidence}`,
      this.resources.describe(),
      `screen ${this.currentRoom} (${this.renderer.size.width}x${this.renderer.size.height}), ` +
        `scroll ${this.renderer.scrollX},${this.renderer.scrollY}`,
      `${this.logic.cycles} logic cycles, ${this.frame} frames drawn`,
      `sections alive: ${this.objects.liveSections().join(', ') || 'none'}`,
      this.ui.describe(),
      this.sound.describe(),
      this.logic.router.describe(),
    ];
    const events = this.logic.events.describe();
    if (events) lines.push(events);
    const unimplemented = this.logic.describeUnimplemented();
    if (unimplemented) lines.push(unimplemented);
    if (this.skippedSequences.size > 0) {
      lines.push(
        `cutscenes the scripts asked for and this project could not play: ` +
          `${[...this.skippedSequences]
            .map((id) => `${id} ("${sword1SequenceName(id) ?? '?'}")`)
            .join(', ')}`,
      );
    }
    for (const fault of this.logic.faults.slice(0, 10)) lines.push(`fault: ${fault}`);
    for (const warning of this.renderer.warnings.slice(0, 10)) lines.push(`graphics: ${warning}`);
    for (const note of this.sound.notes.slice(0, 10)) lines.push(`sound: ${note}`);
    return lines;
  }

  // -- what a harness may ask, which is not what the shell asks ---------------
  //
  // ADR 0011 caps `AdventureEngine` and eight families have left it alone, so
  // none of the four below is on it. They are here for the same reason
  // `SkyEngine` carries `playerAt`/`hotspots`/`describeRoom`: `bin/play-probe.ts`
  // has to ask a family-shaped question — where is George, what can be clicked,
  // is anyone in control — and the alternative is a harness that recomputes the
  // engine's own arithmetic and then measures its own version of the screen.

  /**
   * The palette the framebuffer is read through.
   *
   * The renderer owns it because a screen change loads it, and `present` hands
   * the two to the canvas together. Exposed so a harness reading `screen.pixels`
   * can turn indices into colours the same way the canvas does; the other four
   * families keep a `palette` field on the engine and this is that, forwarded.
   */
  get palette(): Palette {
    return this.renderer.palette;
  }

  /**
   * Where George is standing, in the game's own coordinates, or null when his
   * compact is not open — which is every frame before the start position runs.
   */
  playerAt(): { x: number; y: number } | null {
    const george = this.objects.fetch(SWORD1_PLAYER);
    return george ? { x: george.x, y: george.y } : null;
  }

  /**
   * What the player is carrying: the menu-object numbers, in pocket order.
   *
   * Read from the 52 `POCKET_n` globals rather than from the bar, and that is
   * the point — the bar is built from them when it opens (`SwordUi.buildMenu`),
   * so this answers the same question whether or not the bar is up, and after a
   * restore it answers out of the restored globals rather than out of what was
   * on screen before. `Sword2Engine.inventoryIcons` is the same question asked
   * of the other family, which keeps its inventory somewhere else entirely
   * (ADR 0036).
   */
  get inventoryIcons(): readonly number[] {
    const carried: number[] = [];
    for (let pocket = 0; pocket < SWORD1_TOTAL_POCKETS; pocket++) {
      if (this.logic.getVar(SV.POCKET_1 + pocket)) carried.push(pocket + 1);
    }
    return carried;
  }

  /**
   * The menu object the pointer is carrying, or 0 when it carries nothing.
   *
   * `OBJECT_HELD` is the whole of this family's "use X on Y": an icon taken
   * from the bar stays on the pointer, and the next click on a thing runs that
   * thing's script with the icon's number still in the global. A driver has to
   * be able to see it — `bin/sword-playthrough.ts` checks that a take worked
   * before it clicks the thing it is for, because a click with an empty pointer
   * looks at the scenery instead and the run would then fail two steps later
   * with nothing to say about why. `Sword2Engine.draggedIcon` is the same
   * question asked of the other family.
   */
  get heldIcon(): number {
    return this.logic.getVar(SV.OBJECT_HELD);
  }

  /**
   * Where George is standing in **display** pixels, or null when his compact is
   * not open.
   *
   * The same three subtractions {@link pointerTargets} makes, and it is here so
   * that there is one copy of them rather than one per caller. The scroll is
   * the term a caller forgets: it is 33 pixels on the demo's first screen and
   * 0 on the next, so a conversion that takes off only the 128 origin and the
   * 40-pixel bar is right exactly until the room is wider than the display.
   * `bin/play-probe.ts` did precisely that, clicked a third of a screen from
   * where it meant to, and reported the walk that did not happen as an engine
   * defect — so the arithmetic lives here now and the probe asks.
   */
  playerOnScreen(): { x: number; y: number } | null {
    const george = this.playerAt();
    return george ? this.toDisplay(george.x, george.y) : null;
  }

  /**
   * Room coordinates to display pixels: `SwordUi.engine`'s sum, read backwards.
   */
  private toDisplay(x: number, y: number): { x: number; y: number } {
    return {
      x: x - SWORD1_SCREEN_LEFT_EDGE - this.logic.getVar(SV.SCROLL_OFFSET_X),
      y:
        y - SWORD1_SCREEN_TOP_EDGE - this.logic.getVar(SV.SCROLL_OFFSET_Y) + SWORD1_MENU_BAR_HEIGHT,
    };
  }

  /**
   * What the pointer can touch this cycle, in **display** pixels.
   *
   * Display and not room coordinates, because a caller's job is to put a
   * pointer somewhere and the pointer lives in the display. The conversion is
   * `SwordUi.engine`'s, read backwards: it adds the scroll offset, the 128
   * origin and the 40-pixel menu bar the display has and the room does not, so
   * this subtracts exactly those three. A caller that converted for itself
   * would be the second copy of the arithmetic ADR 0011 exists to prevent.
   *
   * The list is rebuilt every cycle by the compacts that asked for the mouse,
   * so it is empty whenever nothing on screen is clickable — including while a
   * cutscene runs, which is a true answer and not a missing one.
   */
  pointerTargets(): Array<{
    id: number;
    x: number;
    y: number;
    /**
     * The whole rectangle, display pixels, because the midpoint is not enough
     * to aim with: a floor compact spans the walkable area and its middle is
     * as likely to be under George as anywhere, while a *non*-floor rectangle
     * is the thing a caller aiming at the floor has to stay out of.
     */
    left: number;
    top: number;
    right: number;
    bottom: number;
    /** `SwordType`: `FLOOR` is what a walk is clicked on, the rest are things. */
    type: number;
    clickScript: number;
  }> {
    return this.lastTargets.map((target) => {
      const topLeft = this.toDisplay(target.x1, target.y1);
      const bottomRight = this.toDisplay(target.x2, target.y2);
      return {
        id: target.id,
        x: (topLeft.x + bottomRight.x) >> 1,
        y: (topLeft.y + bottomRight.y) >> 1,
        left: topLeft.x,
        top: topLeft.y,
        right: bottomRight.x,
        bottom: bottomRight.y,
        type: this.objects.fetch(target.id)?.type ?? 0,
        clickScript: target.mouseClick,
      };
    });
  }

  /**
   * Whether a cutscene is running that a player may press Escape out of.
   *
   * Every one of them, in this family: Revolution's own player checks for
   * Escape on each frame of every film and stops there (`animation.cpp`,
   * `MoviePlayer::play`), so there is no scene the game means a player to sit
   * through. `step` honours it through `SwordInput.drainSkip`; this is the same
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
   * Four things have to be true at once and each is asked of the authority that
   * owns it. `MOUSE_STATUS` bit 0 is the game's own "there is a human" flag —
   * `fnNoHuman` clears it for every cutscene, conversation and scripted walk —
   * and it is the one that matters, because the other three can all be true
   * during a sequence the player is only watching.
   */
  /**
   * The conversation topics on offer, with the point that picks each one.
   *
   * Empty when the bar is closed. A topic is chosen by clicking its point, the
   * same as any other click, so a driver needs nothing else from the menu.
   */
  pointerSubjects(): Array<{ slot: number; value: number; x: number; y: number }> {
    if (!this.ui.isOpen('bottom')) return [];
    return this.ui.iconPoints('bottom');
  }

  /** The inventory icons on the top bar, with the point that picks each one. */
  pointerInventory(): Array<{ slot: number; value: number; x: number; y: number }> {
    if (!this.ui.isOpen('top')) return [];
    return this.ui.iconPoints('top');
  }

  describeNotInteractive(): string | null {
    if (this.hasQuit) return 'the game has ended';
    if (this.loadError) return `a screen failed to load: ${this.loadError}`;
    if (this.loading) return 'a cluster is still loading';
    if (this.sequence) return `the cutscene "${this.sequence.name}" is playing`;
    // The conversation bar is the exception to `MOUSE_STATUS`: `fnChooser`
    // parks the speaker in `LOGIC_choose` and the topics are picked with the
    // mouse while the game's own "there is a human" flag is clear. A player
    // looking at a row of subjects is in control, so saying otherwise here
    // would have a driver wait for something that is waiting for it.
    if (this.ui.isOpen('bottom')) return null;
    if (!(this.logic.getVar(SV.MOUSE_STATUS) & 1)) {
      return 'the scripts have taken the pointer away (MOUSE_STATUS has no human bit)';
    }
    if (this.lastTargets.length === 0) {
      return `nothing on screen ${this.currentRoom} is asking for the mouse`;
    }
    return null;
  }

  /**
   * Why this game may not be edited, or null when it may.
   *
   * Asked before the work, from the same import `toEditableGame` uses, so the
   * two cannot drift (ADR 0011's rule). Broken Sword refuses only when nothing
   * could be read at all — an install with its three immediate clusters always
   * has scripts, compacts and text.
   */
  describeEditRefusal(): string | null {
    const project = importSword1Project(this.resources, this.detection);
    if (project.editable.editable) return null;
    return `Editing Broken Sword is refused: ${project.editable.reasons.join('; ')}.`;
  }

  /**
   * Every recording this install holds, as an index rather than as bytes.
   *
   * Three kinds addressed three different ways, which is why this cannot be
   * one loop: a tune is a *file* named from the tune table, an effect is a
   * *resource id* built from the fx table and the release, and a line of
   * speech is an *offset inside a container* the RIF does not list at all.
   *
   * Nothing here keeps any bytes. What comes back is a list of addresses, and
   * `readTrackBytes` reads one out of the folder when a row is played or saved
   * — ADR 0030 and ADR 0034, and the demo's speech container alone is 43.9 MB.
   */
  private async listAudio(): Promise<ProjectAudio[]> {
    const source = this.source;
    const names = source?.list() ?? [];

    // Present rather than resident, and neither is "in the index": a retail
    // install's second disc is declared by `swordres.rif` and absent from the
    // folder, so listing its effects would be rows that can never play.
    const ids = new Set(this.resources.allIds());
    const present = new Set(this.resources.availableClusters.map((label) => label.toUpperCase()));

    const speechFile = sword1SpeechFileIn(names);
    const index = source && speechFile ? await readSword1SpeechIndex(source, speechFile) : null;

    return listSword1Audio({
      names,
      windowsDemo: this.detection.release === 'demo',
      hasSample: (id) => ids.has(id) && present.has(this.resources.clusterLabelFor(id) ?? ''),
      ...(index ? { speech: { file: index.file, entries: index.entries() } } : {}),
    });
  }

  async toEditableGame(options: EditableGameOptions): Promise<EditableGame | null> {
    options.onProgress?.(0, 4, 'Broken Sword: reading clusters');
    // Every resident cluster is already in hand; the region clusters are not,
    // and the editable surfaces want them. Loading them here rather than
    // lazily is the right trade for an editor: it is a one-off cost at open,
    // where a lazy load would be a stall per section a person clicks.
    for (const label of this.resources.availableClusters) {
      if ((SWORD1_RESIDENT_CLUSTERS as readonly string[]).includes(label)) continue;
      if (SwordResources.isStreamed(label)) continue;
      await this.resources.loadCluster(label, true);
    }

    options.onProgress?.(1, 4, 'Broken Sword: decompiling scripts');
    /*
     * The interpreter, which is where two of the editable surfaces live.
     *
     * `SWORD.EXE` sits beside the clusters in every install, and it carries the
     * room table and the start positions in its own bytes — they are in no
     * cluster and in no index. Read here rather than in the import so that the
     * import stays a function of what it is handed, and read at open rather
     * than lazily for the reason the region clusters are: 3.4 MB once beats a
     * stall on the panel that wants them.
     */
    const executables: Sword1Executable[] = [];
    for (const name of sword1ExecutableFilesIn(this.source?.list() ?? [])) {
      const bytes = await this.source?.read(name);
      if (bytes) executables.push(readSword1Executable(name, bytes));
    }
    const project = importSword1Project(this.resources, this.detection, executables);
    const audio = await this.listAudio();
    options.onProgress?.(4, 4, 'Broken Sword project');

    return {
      project: {
        version: 6,
        target: this.target,
        name: this.gameId,
        start: { room: this.currentRoom, x: 0, y: 0 },
        defaultResponse: '',
        screen: { textHeight: SWORD1_MENU_BAR_HEIGHT, verbTop: 0 },
        verbs: [],
        actors: [],
        rooms: [],
        scripts: [],
        audio,
        sword1: project,
      },
      notes: [
        ...describeSword1Project(project),
        `${audio.length} recordings listed by number; their bytes stay in the game folder ` +
          `(ADR 0034)`,
      ],
    };
  }

  private get target(): Target {
    return {
      engine: 'sword1',
      release: this.detection.release,
      platform: 'dos',
      identification: this.detection.identification,
    };
  }
}

export { SwordResourceError };
