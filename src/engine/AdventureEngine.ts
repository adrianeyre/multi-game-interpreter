/**
 * What an app shell needs from a game, whichever Engine family runs it.
 *
 * `src/main.ts` does two jobs: it is the shell — file loading, the `games/`
 * folder, progress, consent, pause, fps, stall detection, saving, the editor
 * handoff — and it used to be hardwired to `ScummEngine`. This interface is the
 * seam between those two jobs, so a second Engine family (`CONTEXT.md`) can sit
 * under the same shell rather than beside a second copy of it.
 *
 * It is deliberately small. Of `ScummEngine`'s ~110 methods all but about
 * twenty exist for `ScriptEngine` to call, and those stay exactly where they
 * are; what both families face is the shell. Seventeen members is a description
 * of what a shell needs from a game, not a framework — and per ADR 0011, if it
 * grows past roughly thirty the seam is in the wrong place and the ADR should be
 * revisited rather than the interface widened.
 *
 * **Input is not in it.** Three of the members the shell used to touch were
 * SCUMM-shaped and all three were input: the verb-bar hit test and
 * `VAR.CUTSCENEEXIT_KEY`. SCUMM builds a sentence from clicks; AGI matches a
 * line the player types against a fixed vocabulary. ADR 0007's test for
 * generalise-versus-separate is whether the two "differ by degree in a way one
 * model can hold" — a verb bar and a typed parser do not, so each Engine brings
 * its own input object and the shell only tells it where the screen is.
 *
 * **Screen geometry is not in it either**, because it turns out not to differ.
 * AGI displays 320x200 in sixteen colours, so `Screen` is reusable unchanged
 * and its `setLayout` already expresses AGI's bands (ADR 0011).
 */

import type { EditableSource } from '../authoring/exportEdits.js';
import type { Project } from '../authoring/project.js';
import type { LoadProgressTracker } from './resource/progress.js';

/** A width and a height in pixels. */
export interface Size {
  width: number;
  height: number;
}

/**
 * The two coordinate spaces a game runs in, which are not always the same one.
 *
 * SCUMM and AGI are the degenerate case where they are: 320x200 scripts drawn
 * to a 320x200 picture. SCI32 is not — a game runs its **scripts** in one space
 * and **displays** in another, commonly 320x200 composited to 640x480, and it
 * varies by game and by Plane. ScummVM carries `_scriptWidth`/`_scriptHeight`
 * separately from `_screenWidth`/`_screenHeight` for exactly this.
 *
 * A single resolution number cannot express it, and picking one silently
 * misplaces every click and every actor — which is the worst shape of bug this
 * project has, because nothing errors. So the shell is told both and uses each
 * for what it is for: `display` sizes the canvas, `script` maps the pointer.
 */
export interface EngineResolution {
  readonly script: Size;
  readonly display: Size;
}

/** The sound surface the shell drives: a toggle and the resume-on-gesture dance. */
export interface EngineSound {
  setEnabled(enabled: boolean): void;
  /**
   * Starts the audio context, which browsers only allow from a user gesture.
   *
   * Called from the shell's own pointer and key handlers rather than from the
   * engine's, so it happens once per family instead of once per input path.
   */
  resume(): Promise<void>;
}

/**
 * Where an Engine's input object finds the screen and the events.
 *
 * The shell owns the canvas and knows how it is scaled; the engine owns what a
 * click or a keystroke *means*. This is the whole of what crosses between them.
 */
export interface InputSurface {
  /** The element pointer events arrive on. */
  readonly canvas: HTMLElement;
  /**
   * Where key listeners go.
   *
   * The window in the app, so a keystroke reaches the game without the canvas
   * having to hold focus — and separable in a test, which has no window.
   */
  readonly keys: EventTarget;
  /**
   * An element an Engine may mount its own DOM inside.
   *
   * AGI needs it: a visually hidden `<input>` owns the Parser input line's text
   * so screen readers, IME and the mobile keyboard all work, while the engine
   * draws the authentic line into the framebuffer from that value. SCUMM mounts
   * nothing.
   */
  readonly overlay: HTMLElement;
  /** Maps client coordinates to framebuffer pixels, honouring the CSS scale. */
  toScreen(client: { clientX: number; clientY: number }): { x: number; y: number };
  /** Starts the audio context; browsers require a gesture and this is one. */
  resumeSound(): void;
}

/**
 * One Engine family's input, which the shell attaches and never interprets.
 *
 * A unified `handlePointer`/`handleKey` pair was rejected on ADR 0007's own
 * grounds read the other way: there is no model that holds both a verb bar and a
 * typed parser without becoming a bag of flags.
 */
export interface EngineInput {
  attach(surface: InputSurface): void;
  detach(): void;
}

/**
 * The envelope every save carries, whichever family wrote it.
 *
 * `SaveStore` lists and reads saves without knowing what is inside one, so it
 * needs exactly these fields; everything else in a save is its family's
 * business. Per ADR 0012 a save is Target-tagged rather than version-tagged,
 * which is what lets an AGI save and a SCUMM save be refused for each other
 * rather than half-applied.
 */
export interface SavedGameEnvelope {
  format: number;
  gameId: string;
  savedAt: number;
  name: string;
  room: number;
}

/** What the shell hands the engine so it can report while it decompiles. */
export interface EditableGameOptions {
  progress: LoadProgressTracker;
  onProgress?: (done: number, total: number, what: string) => void;
}

/**
 * A loaded game turned into something the editor can open.
 *
 * The engine knows how to decompile its own resources; the shell knows where a
 * handoff is kept. Splitting it here keeps `src/engine` from importing the
 * editor's storage, which would be the coupling the wrong way round.
 */
export interface EditableGame {
  project: Project;
  /**
   * The bytes an export rewrites, when they are small enough to keep.
   *
   * Absent above the threshold in `shouldStoreOriginals`: an edited Full
   * Throttle would want roughly two copies of a CD in IndexedDB, so export asks
   * for the folder again instead (ADR 0010).
   *
   * A *set* of files rather than an index and a data file, for the reason
   * detection carries one (#194): only one of the three Resource layouts has
   * exactly one data file, and a v3 install has fifty-odd.
   */
  originals?: EditableSource;
  /** Lines worth putting in the log — what was imported, and what was not. */
  notes: string[];
}

/**
 * A game the shell can load, run, draw, save and hand to the editor.
 *
 * Implemented by `ScummEngine` for the SCUMM family and by `AgiEngine` for AGI.
 * Nothing here names a type from either.
 */
export interface AdventureEngine {
  /** Short id the save store and the status line use, e.g. `monkey2`. */
  readonly gameId: string;
  /**
   * The Target in words, for the status line: "SCUMM v6", "AGI v2 (2.917)".
   *
   * `CONTEXT.md` is firm that a bare version names two unrelated engines, so
   * this always carries the family with it.
   */
  readonly targetName: string;
  readonly frame: number;
  readonly currentRoom: number;
  readonly hasQuit: boolean;
  readonly sound: EngineSound;
  readonly input: EngineInput;
  /**
   * The newest save format this family's payload uses.
   *
   * The shell needs it to build a `SaveStore`, which refuses a save from the
   * future. Injected rather than imported by the store, because the two
   * families version their payloads independently and a SCUMM format 4 is not
   * comparable with an AGI format 1.
   */
  readonly saveFormat: number;
  /**
   * What to tell the player about where their saves live and what they are for.
   *
   * A member rather than a constant the shell imports, because the two families
   * have different things to say: a SCUMM save is not readable by ScummVM, and
   * an AGI save is additionally not interchangeable with a SCUMM one. The shell
   * shows whichever the loaded game supplies, which is how it says the right
   * thing without asking which family it is (ADR 0011).
   */
  readonly saveNote: string;
  /**
   * The script and display coordinate spaces this game runs in (ADR 0015).
   *
   * ADR 0007's move: widen the data so nothing has to ask which family it is.
   * SCUMM and AGI report 320x200 for both halves and never think about it
   * again; SCI2 reports the pair that actually differ, and the shell that
   * scales a canvas and maps a click needs no branch either way.
   */
  readonly resolution: EngineResolution;

  /** Runs whatever the game does before its first frame. */
  boot(): void;
  /** Advances one tick. The shell drives a fixed step and this is one of them. */
  step(): void;
  /**
   * Sixtieths of a second the game wants between ticks.
   *
   * The shell owns the clock but not the cadence: how fast a game's world
   * should run is the game's own business, and a SCUMM game says so in a
   * variable it writes itself — Day of the Tentacle asks for six, which is ten
   * ticks a second, not sixty. A shell that assumes one tick per sixtieth runs
   * such a game six times too fast, which is not a subtle fault: the walking
   * is a sprint, the cutscenes are over before they read, and an animation
   * whose next cel is due in two ticks gets six frames drawn from the one it
   * has.
   *
   * Read every tick rather than once, because a game changes it — a cutscene
   * runs at a different rate from the room it interrupts.
   */
  readonly ticksPerStep: number;
  /** Draws the world into the framebuffer. */
  render(): void;
  /** Blits the framebuffer to a canvas, through whatever palette applies. */
  present(context: CanvasRenderingContext2D): void;

  saveState(name: string): SavedGameEnvelope;
  /** Refuses rather than half-applying, so a bad save leaves the game playable. */
  loadState(saved: SavedGameEnvelope): void;

  /**
   * The game's own menu asking the shell for the save dialog, or the load one.
   *
   * Several families have a gesture for this of their own and none of them can
   * act on it: Broken Sword II's system menu is the panel that opens when the
   * pointer reaches the top of the screen, Broken Sword's is F5's
   * `Control::getPlayerOptions`, AGI's is the `save.game` command, and SCUMM's
   * is a script that hands the request back to its host. What they ask *for*
   * is the same thing in all four — the ten slots, the dialog over them, and
   * where those live is the shell's business and has been since ADR 0012. So
   * the seam is here rather than four times in four engines.
   *
   * Optional because most of this interface's implementors have no such
   * gesture, and null-by-default because an engine has to be able to tell:
   * Broken Sword II greys its save and restore icons when nothing is
   * listening, rather than drawing a panel whose buttons do nothing.
   */
  onSaveRequested?: (() => void) | null;
  onRestoreRequested?: (() => void) | null;

  /** The room's authored name, when the game carries one. */
  roomName(room: number): string | undefined;
  /**
   * A short note for the status line, or undefined when nothing is wrong.
   *
   * A stopped script is the difference between "slow game" and "engine bug", so
   * it belongs where a player will see it rather than only in the log.
   */
  describeStatus(): string | undefined;
  /**
   * What the game is waiting on, for the log, when it stops getting anywhere.
   *
   * Several lines rather than one: a stalled game and an empty-looking room are
   * different complaints and a player reporting one usually cannot tell which
   * they have.
   */
  describeStall(): string[];

  /**
   * Why this game may not be edited, or null when it may.
   *
   * Asked *before* the work rather than discovered by attempting it, because
   * ADR 0013's refusal is a property of the Target and is therefore knowable
   * the moment the game loads. A shell that only finds out by calling
   * `toEditableGame` can only report the refusal after a spinner has been up
   * and taken down again, which is indistinguishable from a button that does
   * nothing — and that is exactly how it read.
   *
   * The same string `toEditableGame` throws, so the two cannot drift.
   */
  describeEditRefusal(): string | null;

  /**
   * Whether stating the game's Target by hand could lift that refusal.
   *
   * A capability rather than a family, which is ADR 0011's own distinction —
   * the shell asks "can this be answered by the person?" instead of "is this
   * AGI?". Only AGI answers true: ADR 0013 has a declared-interpreter route
   * because an AGI dump can be missing the evidence entirely, and ADR 0029
   * records that AGOS deliberately has none, "because an AGOS game's bytes say
   * which game they are, so a declaration would only let someone assert past a
   * check that can actually be run".
   *
   * Absent means false, so a family with no such route says nothing. It exists
   * because the shell offered the route to everybody: an AGOS owner whose game
   * was refused was shown a list of Sierra interpreter builds, and no entry on
   * it could have helped.
   */
  readonly editRefusalIsDeclarable?: boolean;

  /**
   * Decompiles into an editable project, or null when this family cannot.
   *
   * Throws with something a person can act on when it can and did not — a
   * Target whose interpreter version could not be positively identified is
   * refused for editing and says so (ADR 0013).
   */
  toEditableGame(options: EditableGameOptions): Promise<EditableGame | null>;
}

/**
 * The loaded game, reachable from the console as `window.scumm`.
 *
 * Diagnosing a stall means asking the world what it is waiting for, and every
 * such question asked through a log line costs a code change, a deploy and a
 * reload. The standalone player exposes it behind `?trace=1`; the editor's Play
 * overlay always does, because pressing Play *is* the debugging affordance.
 *
 * Declared here rather than in each host, because two hosts declaring the same
 * global with different types is an error — and it was one the moment the
 * player widened to `AdventureEngine` and the overlay still said `ScummEngine`.
 * The name is historical, like the package's (ADR 0011).
 *
 * A debugging affordance, not an API anything should depend on.
 */
declare global {
  interface Window {
    scumm?: AdventureEngine;
  }
}
