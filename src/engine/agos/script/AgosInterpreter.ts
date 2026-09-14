/**
 * Running AGOS bytecode.
 *
 * ## The execution model, which is not the one the other families have
 *
 * A Subroutine is a list of **lines**, and a line is a list of instructions.
 * Instructions run in order, and each one leaves a **condition** behind. The
 * line stops as soon as an instruction's condition comes out false — so a
 * line is a conjunction, and AGOS's `if` is the shape of the line rather than a
 * construct inside it. Opcode 0 (203 in Elvira 1) inverts the sense for the
 * instruction that follows, which is how `unless` is written.
 *
 * That is why `../../authoring/agos/disassemble.ts` reconstructs no control
 * flow: there is none in the instructions to reconstruct. It is also why an
 * interpreter for AGOS is smaller than its siblings' and an *editor* for it is
 * not — the structure a person edits is the line, and the line is data.
 *
 * ## Dispatch is by name, not by number
 *
 * Seven Versions number their opcodes differently and share most of their
 * behaviour: `o_carried` is opcode 5 in one table and elsewhere in another.
 * Dispatching on the name from the generated table (`opcodeNames.ts`) means one
 * implementation serves every Version, and a Version that renumbers costs
 * nothing. It also makes the gap measurable: an opcode whose name has no
 * implementation is **reported**, with its name, rather than skipped.
 *
 * Reporting rather than skipping is the whole discipline here. A no-op for an
 * unimplemented opcode produces a game that runs and is wrong, which is the
 * failure mode this project spends most of its documentation trying to avoid.
 */

import { opcodeTableFor, type AgosTarget } from '../agosVersion.js';
import { opcodeName } from './opcodeNames.js';
import {
  isGuardWildcard,
  type AgosInstruction,
  type AgosOperand,
  type AgosSubroutine,
  type AgosSubroutineBlock,
} from './subroutines.js';
import { itemIdOf, linkTo, type AgosItem } from '../world/itemTree.js';
import { HitAreaTable } from '../world/hitAreas.js';
import { ROUTE_VARIABLE } from '../world/pathfinder.js';
import { ITEM_CHILD_TYPES } from '../world/itemTree.js';

/** How many variables a game has. Every Version this project reads has at least this many. */
const VARIABLE_COUNT = 256;

/**
 * The id at which a string stops being one of `GAMEPC`'s and starts being local.
 *
 * The same number as `resource/tableSource.ts`'s `LOCAL_STRING_BASE`, and
 * deliberately not imported from it: this layer decides which pool an id names,
 * and the resource layer decides which file a local id is in. One import would
 * make the script engine depend on packaging to answer a question about ids.
 */
const LOCAL_STRING_ID_BASE = 0x8000;

/**
 * The sync id that means "wait for the line of speech to finish".
 *
 * Not an id the drawing bytecode ever raises: the reference singles it out
 * inside `o_waitSync` and answers it from the sound system instead.
 */
const SPEECH_SYNC = 200;

/**
 * The bit flag a game sets to say the sequence now playing may be skipped.
 *
 * Bit 9, and the reference tests it before honouring an Escape — so skipping
 * is the *game's* permission rather than the interpreter's policy, and a
 * sequence that carries information a player must see stays unskippable. Six of
 * Simon 1's Subroutines set it and the opening is not one of them, which is why
 * skipping the opening goes through {@link SPEECH_SKIP_DONE_BIT} instead.
 */
export const CUTSCENE_SKIPPABLE_BIT = 9;

/**
 * The bit flag that says the end-of-speech animation has already been run.
 *
 * Bit 14. `skipSpeech` sets it so that cutting a second line short does not
 * play the mouth-closing animation twice, and the reference tests it before
 * honouring the right button for the same reason.
 */
const SPEECH_SKIP_DONE_BIT = 14;

/**
 * The Subroutine a skipped sequence hands control to.
 *
 * 170, and it is the game's own tidy-up: whatever the sequence was going to
 * leave behind — a room entered, an item placed, a variable set — this puts the
 * world into the state the sequence would have reached. Skipping without it
 * would drop the player into a half-built scene.
 */
const CUTSCENE_END_SUBROUTINE = 170;

/** The variable a script leaves the next Subroutine's number in (`_variableArray[254]`). */
const NEXT_SUBROUTINE_VARIABLE = 254;

/**
 * The variable Simon 2's horizontal scroll lives in (`_variableArray[251]`).
 *
 * The reference mirrors `_scrollX` here every time it moves, in eight-pixel
 * columns, so a script — and `os1_getPathPosn` — can read the scroll back.
 */
const SCROLL_X_VARIABLE = 251;

/**
 * Simon 2's *second* queued-Subroutine channel (`_variableArray[249]`).
 *
 * `hitarea_stuff_helper_2` drains this one before 254, and Simon 2's walk uses
 * it to run a junction crossing when the actor arrives — see
 * `pollsSecondSubroutineChannel`. Only the families that poll it treat it as a
 * channel; to the rest it is an ordinary variable, so the Engine reads it only
 * for those Versions.
 */
export const WALK_SUBROUTINE_VARIABLE = 249;

/**
 * The verb `oww_addTextBox` gives the boxes it defines.
 *
 * 208 in the reference, passed to `defineBox` as a literal. Named because
 * nothing else here would explain it.
 */
const TEXT_BOX_VERB = 208;

/**
 * How long `o_waitSync` waits before giving up, in drawing-machine ticks.
 *
 * The reference's own numbers, and it warns when the wait fires. Kept because a
 * wait that cannot time out turns one unraised sync into a hung game — but the
 * number is not one number. `waitForSync` is
 * `maxCount = (getGameType() == GType_SIMON1) ? 1000 : 2500` (`script.cpp:1076`):
 * **Simon 1 alone waits 1000; Simon 2 and everything else wait 2500.**
 *
 * This mattered, not as a warning-tuning nicety. Simon 2's intro is a chain of
 * `o_waitSync`s each answered by a VGA sprite raising the sync when its
 * animation reaches the beat — and those animations reach it *later than tick
 * 1000*. Measured: the wait for sync 6801 is set at tick 66 and the sprite
 * raises 6801 at tick 1794. At a 1000-tick cap every beat timed out before its
 * sprite got there, so the whole intro played by timeout rather than by sync —
 * one dead 1000-tick pause per beat. At 2500 the sync arrives first and the
 * intro plays at the pace the animation sets, which is the reference's.
 */
const SYNC_TIMEOUT_SIMON1 = 1000;
const SYNC_TIMEOUT_OTHERS = 2500;

/** How long a screen copy takes, in drawing-machine ticks (`_copyScnFlag`). */
const SCREEN_COPY_TICKS = 2;

/** How deep a Subroutine calling a Subroutine may go, as the reference allows. */
const MAX_CALL_DEPTH = 40;

/**
 * How many instructions {@link AgosInterpreter.run} will execute before giving up.
 *
 * A budget rather than "until it finishes", because that path satisfies waits
 * as they arrive and a script that loops on one would spin here for ever. A
 * caller with no clock cannot tell that apart from a slow script, so the budget
 * is what makes the difference reportable.
 */
const MAX_DRAINED_STEPS = 200_000;

/**
 * What the interpreter asks the Engine to do that it cannot do itself.
 *
 * Graphics are the whole of it, and the shape says why AGOS is two languages: a
 * game Subroutine's entire contribution to the screen is `loadZone` and
 * `animate` — load a zone's scripts and pixels, then start one of its scripts
 * running. Everything a player sees is placed by that second language, not by
 * the one these opcodes are written in (ADR 0027's amendment).
 *
 * Optional, because reading and disassembling a game needs no screen, and a
 * test of the arithmetic should not have to supply one.
 */
export interface AgosGraphicsHooks {
  loadZone(zone: number): boolean;
  /**
   * Puts a picture up: a room's backdrop, the verb panel, a close-up.
   *
   * The **image** table's side of the split `animate` is the animation table's.
   * `o_picture` used to be wired to `loadZone`, which is a different operation
   * on a different number — the operand is a sprite id like 6400 and a zone is
   * its hundreds column, so every backdrop request asked for zone 6400, was
   * told there is no such zone, and drew nothing. The room was black because
   * nothing had been asked to paint it.
   */
  setWindowImage?(window: number, image: number): boolean;
  /**
   * The nearest authored route point to a place the player clicked.
   *
   * `os1_getPathPosn`'s whole content, and the reason a floor click can become
   * a walk. Answered by the pathfinder, which holds the routes the drawing
   * bytecode handed out.
   */
  nearestRoutePoint?(
    x: number,
    y: number,
    previous: number,
  ): { route: number; point: number } | null;
  animate(zone: number, image: number, x: number, y: number, palette: number): boolean;
  /**
   * Stops one sprite, the counterpart of {@link animate}.
   *
   * `os2_stopAnimate` names a (zone, sprite) pair and Elvira's
   * `oe1_stopAnimate` a sprite whose zone is its id's hundreds column. Both
   * were wired to `unloadZone` — a no-op in this engine — so a sprite a script
   * asked to stop went on animating.
   */
  stopAnimate?(zone: number, spriteId: number): void;
  /**
   * Throws every sprite away, in every zone.
   *
   * `o_killAnimate` is not a flag and not a pause: the reference sends it
   * straight to `vc27_resetSprite`, which empties the whole sprite table and
   * the wait tables with it. So it is the same operation the drawing
   * bytecode's own `RESET` performs, reached from the other language — a
   * script ending a scene and a sprite ending one mean the same thing by it.
   */
  resetSprites?(): void;
  /**
   * Wakes every sprite waiting on a sync id.
   *
   * The two bytecodes both raise syncs and both wait on them, and this is the
   * direction that was missing: a *game* script's `o_sync` reached a set the
   * interpreter keeps for its own waits and stopped there, so a drawing script
   * parked on `WAIT_SYNC` for that id waited for ever. The reference has no
   * such split — `o_sync` calls `sendSync`, which is `vc15_sync` with the id
   * already in hand, the same routine the drawing bytecode's own `SYNC` runs.
   *
   * It is what leaves a pose on the screen: Simon's walk hands each of its
   * cels a sync to wait on, and a cel that is never woken never reaches the
   * halt at the end of its script — so it is never reaped, and he stands in
   * the room he walked out of.
   */
  raiseSync?(id: number): void;
  /** Starts a music track. Optional, because reading a game needs no speakers. */
  playMusic?(track: number): boolean;
  /**
   * Plays a recorded line, answering how long it lasts in seconds.
   *
   * The duration matters as much as the sound: `CONTEXT.md`'s **Speech wait**
   * is a script pausing until a line finishes, and its timing comes from the
   * recording. An interpreter that plays speech and does not know its length
   * gets the pacing wrong in exactly the releases that have speech.
   */
  playSpeech?(id: number): number | null;
  /**
   * Cuts the line that is playing short, for a player who has heard enough.
   *
   * Separate from `playSpeech` returning a length because the two disagree
   * about when the line ends, and the disagreement is the point: the wait is
   * measured against the recording, and this is what makes it end early.
   */
  stopSpeech?(): void;
  /**
   * Whether a recorded line is actually sounding right now.
   *
   * The speech wait (sync 200) is measured against this rather than against a
   * duration: a Talkie's MP3 is decoded by the browser, so `playSpeech` cannot
   * return a length and the mouth sprite instead loops on `IF_SPEECH` until the
   * voice stops and then raises the sync. This is that same question, asked
   * where the wait falls back to the clock — the fallback stands only when no
   * voice is sounding, which is a release with no speech at all. See {@link
   * AgosInterpreter.waitArrived}.
   */
  speechActive?(): boolean;
  /** Plays a sound effect by number. */
  playEffect?(number: number): boolean;
  /**
   * Names the video a later `playVideo` will play.
   *
   * Two opcodes rather than one because that is what the games do: a script
   * names a file some way before it asks for it, and collapsing the pair into a
   * single call would change when the file is fetched relative to everything
   * else the script does in between.
   */
  loadVideo?(name: string): void;
  /** Plays the named video, stopping the world until it ends. */
  playVideo?(): void;
  /** Saves the game, which a script asks for and the shell owns. */
  saveGame?(): void;
  /** Loads a saved game. */
  loadGame?(): void;
}

/**
 * The Subroutines and strings that are not in `GAMEPC`.
 *
 * `CONTEXT.md` says a game's Subroutines are split across `GAMEPC` and its
 * table resources; this is the second half arriving as a lookup rather than as
 * a second list to search. Two calls rather than a resource type, so the script
 * layer stays ignorant of packaging: it asks for number 101 and does not learn
 * that the answer came out of `TABLES01` inside an offset table.
 *
 * Optional for the reason the graphics hooks are: reading and disassembling a
 * game needs neither, and a test of the arithmetic should not have to supply a
 * game folder.
 */
export interface AgosScriptLibrary {
  /** A Subroutine held outside `GAMEPC`, by number. */
  subroutine(id: number): AgosSubroutine | undefined;
  /**
   * A jump has landed on a Subroutine held outside `GAMEPC`.
   *
   * The reference reloads a non-resident subroutine's whole table on **every**
   * jump to it (`getSubroutineByID` → `loadTablesIntoMem`), and it is that load
   * — not the lookup — that swaps Simon 2's sound-effects bank. `subroutine`
   * above is cached after its first hit, so a side effect hung there fires once
   * and never again; the effects bank would then freeze on whichever table was
   * warmed up last and `PLAY_EFFECT` would read the wrong one. This fires on
   * every jump, cache hit or miss, so the bank tracks the running table.
   */
  enterSubroutine?(id: number): void;
  /**
   * A **local** string — one whose id is at or above `0x8000`.
   *
   * The ids below that belong to `GAMEPC`'s own pool and never reach here.
   * Simon 1's talkie keeps most of its dialogue in local strings, so an
   * interpreter with no answer for this reads the world correctly and says
   * nothing.
   */
  string(id: number): string | undefined;
}

/**
 * What a suspended script is waiting for.
 *
 * Three kinds, and they are the three the reference actually blocks on. Each
 * carries a deadline in drawing-machine ticks, because every one of them can
 * fail to arrive — the reference's `waitForSync` gives up after a thousand
 * ticks and warns, and a wait with no deadline is a hung game rather than a
 * faithful one.
 */
export type AgosWait =
  /** `o_waitSync`: until the drawing bytecode raises this id. */
  | { readonly kind: 'sync'; readonly id: number; readonly until: number }
  /** `o_picture`: until the screen it asked for has actually been copied. */
  | { readonly kind: 'screen'; readonly until: number }
  /** `os2_waitMark`: until the drawing bytecode sets this mark bit. */
  | { readonly kind: 'mark'; readonly bit: number; readonly until: number }
  /** A line of speech, whose length comes from the recording. */
  | { readonly kind: 'speech'; readonly until: number };

/** One Subroutine part-way through, and where in it. */
interface AgosFrame {
  readonly subroutine: AgosSubroutine;
  /** Which line, and which instruction within it. */
  line: number;
  instruction: number;
  /** Whether the inversion marker has been seen for the next instruction. */
  inverted: boolean;
}

/**
 * A Subroutine running across frames rather than inside one.
 *
 * **This is the difference between an AGOS interpreter that finishes a game's
 * scripts and one that plays a game.** An AGOS script blocks: `o_waitSync`
 * stops until the drawing bytecode raises an id, and `o_picture` stops until
 * the screen has been copied. The reference expresses that by calling `delay`
 * from inside the script engine, which runs the drawing machine and comes back.
 *
 * Running a Subroutine to completion inside one host frame — which is what this
 * did — is not a slightly-too-fast version of that. It is a different program.
 * Simon 1's intro is eleven pictures and a dozen synchronised animations, and
 * with no way to suspend it ran the whole sequence between two frames of the
 * renderer: every wait fell through, every picture but the last was overwritten
 * before it was drawn, and what a player saw was the last frame of an intro that
 * had already finished.
 *
 * A task holds a **stack** of frames rather than one, because `o_process` is a
 * nested call — a Subroutine calling a Subroutine that then blocks has to
 * suspend the pair of them.
 */
export class AgosTask {
  /** Innermost frame last. */
  readonly frames: AgosFrame[] = [];
  /** What this task is waiting for, or null when it is runnable. */
  wait: AgosWait | null = null;
  /** Why the task exists, for a stall report to name. */
  constructor(readonly reason: string) {}

  get done(): boolean {
    return this.frames.length === 0;
  }
}

export interface AgosRunReport {
  /** Opcodes reached that have no implementation here, by name. */
  readonly unimplemented: readonly string[];
  /** Instructions executed. */
  readonly executed: number;
  /** Lines whose condition failed, which is how an AGOS `if` declines. */
  readonly linesStopped: number;
}

/**
 * The mutable half of a running game.
 *
 * Items are mutable because AGOS moves them: `o_place` re-parents an item and
 * that is how the world changes. The tree read out of `GAMEPC` is the starting
 * state, and a save is this (ADR 0002's rule, applied to a graph rather than to
 * a set of scalars).
 */
export class AgosState {
  readonly variables = new Int16Array(VARIABLE_COUNT);
  /** Items by number, with the two predefined slots left empty. */
  readonly items: (AgosItem | undefined)[];
  /** The item the player is, and the item the player is in. */
  me = 1;
  item1 = 1;
  /**
   * The two items a script is currently talking about.
   *
   * AGOS has no expressions: a script walks the tree by *setting* one of these
   * two registers — `o_getParent`, `o_getNext`, `o_getChildren` — and then acts
   * on whichever it set. The byte operand chooses which, and 1 means the
   * subject. Nothing else in the family is register-shaped, which is why these
   * two live here rather than being threaded through the opcodes.
   */
  subjectItem = 0;
  objectItem = 0;
  /** True once a script has asked the game to end. */
  quit = false;
  /**
   * Where a click means something, as the game's own scripts define it.
   *
   * State rather than configuration: the interface is rebuilt by script as the
   * game moves between rooms, so it belongs beside the variables and the item
   * tree rather than beside the renderer.
   */
  readonly hitAreas = new HitAreaTable();
  /**
   * Subroutines waiting for a time to arrive.
   *
   * AGOS's whole notion of "later": a script says *run subroutine 160 in three
   * seconds* and stops caring. The game's opening move is one of these — boot
   * queues subroutine 1 rather than calling it — so a game with no clock does
   * not merely lose its timers, it never starts.
   */
  readonly timeEvents: { due: number; subroutine: number }[] = [];
  /** Seconds since the game booted, advanced by the Engine. */
  clock = 0;
  /**
   * When the line currently being spoken finishes.
   *
   * `CONTEXT.md`'s **Speech wait**: a script pauses until speech ends, and the
   * timing comes from the recording. Kept even when nothing is audible, because
   * an interpreter that skips the pause runs a talkie at a speed the game was
   * never written for.
   */
  speechUntil = 0;
  /**
   * Lines the game has asked to show, in order.
   *
   * Collected rather than drawn. A font renderer is a separate piece of work,
   * and a game's words are worth having before it exists — they are the fastest
   * check that an interpreter is following the same path the game does, and
   * they are what a person reading a stall report actually needs.
   */
  readonly messages: string[] = [];
  /**
   * The lines currently on screen, which is not the same list.
   *
   * {@link messages} is a **transcript**: everything the game has asked to
   * show, kept because it is the fastest evidence that the interpreter is
   * following the same path the game does, and read by the stall report.
   * Drawing it was a category error — by the end of Simon 1's intro the screen
   * held four scenes' dialogue at once, stacked over each other.
   *
   * This is what is on screen now: replaced when a script shows a new line and
   * emptied by `o_cls`. Still a simplification of the reference, which renders
   * each line into a sprite the animation system removes on its own schedule —
   * so a line here stays until something replaces it rather than fading on its
   * own.
   */
  readonly onScreen: string[] = [];
  /** Class flags a script has set on items, which is how AGOS groups them. */
  readonly classFlags = new Map<number, number>();
  /** Bits, which Elvira 2 onwards uses where Simon uses variables. */
  readonly bits = new Set<number>();
  /** Elvira 2's second bank, a separate set rather than a higher range. */
  readonly bits2 = new Set<number>();
  /** Zones a script has unloaded, and whether it has frozen them all. */
  readonly unloadedZones = new Set<number>();
  zonesFrozen = false;
  /** Whether the pointer is showing; a script hides it while it draws. */
  pointerVisible = true;
  /** The inventory list a script last asked for: a container, and a class filter. */
  icons: { container: number; window: number; classMask: number } | null = null;
  /** Text boxes a script has placed, and the colour it asked for. */
  readonly textBoxes: { x: number; y: number; width: number }[] = [];
  /**
   * The names and descriptions of the room's clickable things, by slot.
   *
   * Simon 1 and Waxworks describe a room's objects with three opcodes rather
   * than with items: `oww_setShortText` gives slot *n* a name,
   * `oww_setLongText` gives it a description and a speech id, and
   * `oww_addTextBox` puts a **hit area** on screen carrying that slot number.
   * So a room's scenery is not in the item tree at all — the tree holds the
   * room, and this holds what is in it.
   */
  readonly shortText = new Map<number, number>();
  readonly longText = new Map<number, { string: number; speech: number }>();
  textColour = 0;
  paused = false;
  fading = false;
  /** Whether a script asked to start its Subroutine again. */
  rescanRequested = false;
  /** Whether Simon is wearing the beard, which is a graphics swap. */
  beardLoaded = false;
  /** Which speech and effects files the game is reading from. */
  soundFileId = 0;
  /** When a script last marked the clock, for Elvira's timed tests. */
  timeMark = 0;
  /** The word search a script is stepping through, for `oe1_nextMaster`. */
  masterSearch: { adjective: number; noun: number; from: number } | null = null;
  /**
   * The animation marks, a sixteen-bit set one bytecode raises and the other
   * waits on.
   *
   * A bitmask rather than a set of ids because that is what it is: the VGA
   * script's `SET_MARK`/`CLEAR_MARK` turn a numbered bit on and off, and the
   * game script's `os2_waitMark` blocks until a bit is on — the reference's
   * `_marks` word exactly. Simon 2 paces its cutscenes with it, one script
   * marking a moment its animation has reached and another waiting for that
   * moment, so a mark that is only recorded and never waited on collapses the
   * pacing: every wait falls straight through and the scene runs at once.
   */
  private markBits = 0;
  /** Turns a mark on, which is `SET_MARK` in the drawing bytecode. */
  setMark(bit: number): void {
    this.markBits |= 1 << (bit & 15);
  }
  /** Turns a mark off, which is `CLEAR_MARK`. */
  clearMark(bit: number): void {
    this.markBits &= ~(1 << (bit & 15));
  }
  /** Turns every mark off, which `os2_clearMarks` does between scenes. */
  clearMarks(): void {
    this.markBits = 0;
  }
  /** Whether a mark is on, which is what `os2_waitMark` blocks until. */
  hasMark(bit: number): boolean {
    return (this.markBits & (1 << (bit & 15))) !== 0;
  }
  /** Elvira 2's super room, a grid of cells rather than a tree of items. */
  superRoom = 0;
  /** Feeble's third bank of bits. */
  readonly bits3 = new Set<number>();
  /** Interface odds and ends a script sets and something later will read. */
  musicPlaying = 0;
  inputEnabled = false;
  menuOpen = false;
  hyperLink = 0;
  /** The adjective and noun pairs a script sets for the verb table to match. */
  adjective1 = 0;
  noun1 = 0;
  adjective2 = 0;
  noun2 = 0;
  /** Item slots, which Elvira 2 uses where Simon uses the two registers. */
  readonly itemSlots = new Map<number, number>();
  /** Whether a script has asked animation to stop. */
  animationHalted = false;
  /** The last sync a script sent or waited for. */
  lastSync = 0;
  /**
   * Drawing-machine ticks since boot, advanced by the Engine.
   *
   * A second clock beside {@link clock}, and the two measure different things:
   * `clock` is seconds and is what time events are due against, while this
   * counts frames of the drawing machine and is what a **wait** is measured in.
   * The reference's `waitForSync` gives up after a thousand of these, which is
   * a number of frames rather than a number of seconds.
   */
  vgaTicks = 0;
  /**
   * Sync ids the drawing bytecode has raised and nothing has consumed yet.
   *
   * `o_waitSync` blocks until its id turns up here. A set rather than a single
   * value because several scripts raise syncs in one frame and a game script
   * may be waiting for any of them.
   */
  readonly syncsRaised = new Set<number>();
  /**
   * The tick at which the screen has finished being copied.
   *
   * `_copyScnFlag` in the reference, which `setWindowImage` sets to two and
   * every drawn frame decrements — so a script that puts a picture up waits two
   * frames before it may put up another. That wait is the whole reason an
   * AGOS intro is a sequence of pictures rather than one picture: without it a
   * script runs through eleven of them inside a single frame and only the last
   * is ever seen.
   */
  screenBusyUntil = 0;
  /**
   * Whether the player has asked to leave the sequence that is playing.
   *
   * `_exitCutscene` in the reference, set by the Escape key and consulted from
   * inside a sync wait — not acted on where it is set, because the thing it
   * interrupts is a script that is blocked rather than a screen that is being
   * shown. Cleared every time a fresh wait begins, so an Escape pressed during
   * one sequence does not skip the next one.
   *
   * A request rather than a command: it only skips where the game has said the
   * sequence is skippable, which it says by setting bit flag 9.
   */
  exitCutscene = false;
  /**
   * Whether the right button is down, which is how a line of speech is cut short.
   *
   * `_rightButtonDown`, and it is a latch rather than a live reading: the
   * reference clears it when a wait begins and tests it on every pass of that
   * wait, so a click that lands between two passes is not lost. Only a wait on
   * {@link SPEECH_SYNC} reads it.
   */
  rightButtonDown = false;
  /**
   * Text windows the game has defined, by number.
   *
   * `flags` and `fillColour` are `o_defWindow`'s last two operands — the
   * background colour a window paints itself before anything goes in it. They
   * were read and dropped while nothing filled a window; the icon bar needs
   * them, because Simon 2's inventory is icons on a coloured panel and drawing
   * only the icons leaves them floating on black. See `AgosWindow`.
   */
  readonly windows = new Map<
    number,
    { x: number; y: number; width: number; height: number; flags: number; fillColour: number }
  >();
  currentWindow = 0;

  constructor(items: readonly AgosItem[]) {
    this.items = [];
    this.items.length = 2;
    this.items.push(...items.map((item) => ({ ...item })));

    // Item 1 is the player, and the game's file does not contain it — which is
    // the whole reason the file's numbering starts at 2. The reference builds
    // it at load (`createPlayer`), and without it every opcode that moves the
    // player silently does nothing: `o_goto` finds no item 1 and returns, and
    // a game that cannot move its player looks like a game whose scripts are
    // not running.
    this.items[1] = {
      // **The reference's own two values**, and they are not zero:
      // `createPlayer` sets the adjective to −1 and the noun to 10000. Both are
      // matched against by the verb table — a guard naming the player names
      // 10000 — so a player built with zeroes is a player no line can be
      // written about.
      adjective: -1,
      noun: 10_000,
      state: 0,
      next: { raw: 0xffffffff },
      child: { raw: 0xffffffff },
      parent: { raw: 0xffffffff },
      trailing: [0],
      classFlags: 0,
      childrenLead: 0,
      children: [],
    };
  }

  /**
   * A variable's value, **unsigned**, as the game bytecode sees it.
   *
   * The reference stores variables in an `int16` array and reads them back
   * through `getNextVarContents`, which casts to `uint16` — so a variable
   * holding −1 reads as **65535** to every comparison opcode. Reading it signed,
   * which is what an `Int16Array` gives you, breaks the commonest test in the
   * game: `o_let 60, 65535` followed by `o_eq 60, 65535` came out false.
   *
   * That is not an obscure pair. Simon 1's verb dispatch turns on it. Its walk
   * handler asks `o_eq 60, 65535` to mean *no object is selected*, and with the
   * test failing the line below it — `o_notEq 60, 65535` — ran instead, so a
   * click on the floor was handled as a click on a thing: the room's verb
   * handler overwrote the click position with the spot for an object nobody had
   * pointed at, and Simon walked to the same place whatever the player did.
   *
   * The **drawing** bytecode reads the same array signed (`vcReadVar` casts to
   * `int16`), which is why `VgaMachine` keeps its own accessor rather than
   * calling this one. Two readings of one array, and the reference has both.
   */
  read(index: number): number {
    return (this.variables[index & (VARIABLE_COUNT - 1)] ?? 0) & 0xffff;
  }

  write(index: number, value: number): void {
    this.variables[index & (VARIABLE_COUNT - 1)] = value;
  }

  parentOf(id: number): number {
    const item = this.items[id];
    return item ? itemIdOf(item.parent) : 0;
  }

  /** Moves an item to a new parent, which is how the world changes at all. */
  place(id: number, parent: number): void {
    const item = this.items[id];
    if (!item) return;
    this.items[id] = { ...item, parent: linkTo(parent) };
  }

  /** Sets an item's state, the other thing a game rewrites about one. */
  setState(id: number, state: number): void {
    const item = this.items[id];
    if (!item) return;
    this.items[id] = { ...item, state };
  }

  /** An item's object sub-structure, where one exists. */
  private objectChild(id: number): { mask: number; values: readonly number[] } | undefined {
    const item = this.items[id];
    const child = item?.children.find((each) => each.type === ITEM_CHILD_TYPES.object);
    if (!child) return undefined;
    return { mask: child.header?.[0] ?? 0, values: child.values };
  }

  /**
   * Reads an object flag.
   *
   * The mask doubles as the flags: its low sixteen bits say which values the
   * record holds, and its high bits are ordinary flags a script sets. That is
   * why only bits 16 and up may be written — writing a low one would change how
   * many values the record has without moving any of them.
   */
  objectFlag(id: number, bit: number): boolean {
    const object = this.objectChild(id);
    return object ? (object.mask & (1 << bit)) !== 0 : false;
  }

  setObjectFlag(id: number, bit: number, on: boolean): void {
    if (bit < 16) return;
    const item = this.items[id];
    if (!item) return;
    const index = item.children.findIndex((each) => each.type === ITEM_CHILD_TYPES.object);
    if (index < 0) return;

    const child = item.children[index]!;
    const mask = child.header?.[0] ?? 0;
    const header = [...(child.header ?? [])];
    header[0] = on ? mask | (1 << bit) : mask & ~(1 << bit);
    const children = [...item.children];
    children[index] = { ...child, header };
    this.items[id] = { ...item, children };
  }

  /**
   * One of an object's numbered values.
   *
   * The values are the ones the mask sized, in order, so "value 3" means the
   * third bit set in the mask rather than the third bit of it — which is why
   * this counts bits rather than indexing directly.
   */
  objectValue(id: number, which: number): number {
    const object = this.objectChild(id);
    if (!object) return 0;
    let index = 0;
    for (let bit = 0; bit < 16; bit += 1) {
      if ((object.mask & (1 << bit)) === 0) continue;
      if (bit === which) return object.values[index] ?? 0;
      index += 1;
    }
    return 0;
  }

  setObjectValue(id: number, which: number, value: number): void {
    const item = this.items[id];
    if (!item) return;
    const childIndex = item.children.findIndex((each) => each.type === ITEM_CHILD_TYPES.object);
    if (childIndex < 0) return;

    const child = item.children[childIndex]!;
    const mask = child.header?.[0] ?? 0;
    let index = 0;
    for (let bit = 0; bit < 16; bit += 1) {
      if ((mask & (1 << bit)) === 0) continue;
      if (bit === which) {
        const values = [...child.values];
        values[index] = value;
        const children = [...item.children];
        children[childIndex] = { ...child, values };
        this.items[id] = { ...item, children };
        return;
      }
      index += 1;
    }
  }

  /** The string id an object is named by, which is what `o_isCalled` compares. */
  objectName(id: number): number | undefined {
    const object = this.objectChild(id);
    return object ? object.values[object.values.length - 1] : undefined;
  }

  /** Whether one item is inside another, at any depth. */
  contains(container: number, id: number): boolean {
    let walker = this.parentOf(id);
    // A depth cap rather than a visited set: an item tree with a cycle in it is
    // a corrupt game, and looping for ever while looking for one helps nobody.
    for (let steps = 0; walker !== 0 && steps < 64; steps += 1) {
      if (walker === container) return true;
      walker = this.parentOf(walker);
    }
    return false;
  }

  /**
   * What an item weighs, itself and everything in it.
   *
   * An object's weight is one of its numbered values; a container weighs what
   * it holds. Both games use this for the same thing — whether the player can
   * pick something else up.
   */
  weigh(id: number): number {
    let total = this.objectValue(id, 2);
    for (let child = 0; child < this.items.length; child += 1) {
      if (this.parentOf(child) === id) total += this.weigh(child);
    }
    return total;
  }

  /** Whether an item would fit in a container, by weight against its volume. */
  wouldFit(id: number, container: number): boolean {
    const volume = this.objectValue(container, 1);
    if (volume === 0) return true;
    return this.weigh(id) <= volume;
  }

  /** One of the eight numbers a game keeps on an item. */
  userFlag(id: number, which: number): number {
    const item = this.items[id];
    const child = item?.children.find((each) => each.type === ITEM_CHILD_TYPES.userFlag);
    return child?.values[which] ?? 0;
  }

  setUserFlag(id: number, which: number, value: number): void {
    const item = this.items[id];
    if (!item) return;
    const index = item.children.findIndex((each) => each.type === ITEM_CHILD_TYPES.userFlag);
    if (index < 0) return;
    const child = item.children[index]!;
    const values = [...child.values];
    values[which] = value;
    const children = [...item.children];
    children[index] = { ...child, values };
    this.items[id] = { ...item, children };
  }

  /**
   * A room's exit states, two bits each, in the mask that sized its exit list.
   *
   * The same word does both jobs: which exits a room has, and what state each
   * one is in. That is why a door cannot be added by a script — the mask would
   * have to grow and the record with it.
   */
  doorState(room: number, direction: number): number {
    const item = this.items[room];
    const child = item?.children.find((each) => each.type === ITEM_CHILD_TYPES.room);
    const states = child?.header?.[1] ?? 0;
    return (states >> (direction * 2)) & 3;
  }

  setDoorState(room: number, direction: number, state: number): void {
    const item = this.items[room];
    if (!item) return;
    const index = item.children.findIndex((each) => each.type === ITEM_CHILD_TYPES.room);
    if (index < 0) return;

    const child = item.children[index]!;
    const header = [...(child.header ?? [])];
    const states = header[1] ?? 0;
    header[1] = (states & ~(3 << (direction * 2))) | ((state & 3) << (direction * 2));
    const children = [...item.children];
    children[index] = { ...child, header };
    this.items[room] = { ...item, children };
  }

  /**
   * Where an exit leads.
   *
   * The destinations are the values the mask sized, in order, so the third exit
   * a room *has* is the third value — not the third direction. Counting rather
   * than indexing is the whole reason the mask is kept beside the values.
   */
  exitOf(room: number, direction: number): number {
    const item = this.items[room];
    const child = item?.children.find((each) => each.type === ITEM_CHILD_TYPES.room);
    if (!child) return 0;
    const states = child.header?.[1] ?? 0;

    let index = 0;
    for (let each = 0; each < 6; each += 1) {
      if (((states >> (each * 2)) & 3) === 0) continue;
      if (each === direction) {
        const raw = child.values[index];
        return raw === undefined ? 0 : itemIdOf({ raw });
      }
      index += 1;
    }
    return 0;
  }

  /**
   * The item a pair of clicked words names, or 0.
   *
   * `from` is how "the red key" reaches the second red key: a script asks for
   * the next match rather than re-asking for the first and getting it again.
   */
  findByWords(adjective: number, noun: number, from = 0): number {
    for (let id = from; id < this.items.length; id += 1) {
      const item = this.items[id];
      if (!item) continue;
      if (item.noun === noun && (adjective === 0 || item.adjective === adjective)) return id;
    }
    return 0;
  }

  /** 1 chooses the subject register, anything else the object. */
  setRegister(which: number, id: number): void {
    if (which === 1) this.subjectItem = id;
    else this.objectItem = id;
  }
}

/** The id an operand carries, whichever kind of id it is. */
/**
 * Reads an operand as whichever of an item or a string id it carries.
 *
 * **A string id is sixteen bits**, and the four bytes on disk are not all of
 * it: the reference reads a long and truncates — `val = (uint16)readUint32BE()`
 * — so the high word is padding. Keeping all thirty-two turned a local string
 * id of `0x8C55` into `0xFFFF8C55`, which is not in any pool, and the game's
 * dialogue came out as `string(4294934933)` rather than as words.
 */
function itemOrStringId(operand: AgosOperand | undefined): number {
  if (!operand) return 0;
  if (operand.kind === 'string') return (operand.id ?? operand.lead) & 0xffff;
  if (operand.kind === 'item') return operand.id ?? operand.lead;
  if (operand.kind === 'word' || operand.kind === 'byte') return operand.value;
  return 0;
}

/** Whether an item carries a sub-structure of a kind, which is what says what it is. */
function hasChildOfType(state: AgosState, id: number, type: number): boolean {
  const item = state.items[id];
  return item ? item.children.some((child) => child.type === type) : false;
}

/**
 * Where a word operand stops being a value and becomes a variable.
 *
 * `getVarOrWord` in the reference: a word from **30000 to 30511** is not the
 * number 30000-odd, it is *variable n* where n is the word minus 30000. Simon's
 * variables number 0 to 255 and the range is twice that, so a word inside it
 * cannot be a literal a game meant.
 *
 * This rule was missing entirely, and it is the rule that makes a click reach
 * the floor. Simon 1's walk handler is
 * `os1_getPathPosn 30001, 30002, 6, 7` — *take the x and y the player clicked
 * out of variables 1 and 2* — and reading those two words as literals asked for
 * the nearest route point to (30001, 30002), which is off the screen by two
 * orders of magnitude. Every opcode that takes a computed number was affected;
 * this is only where it was noticed.
 */
const VARIABLE_WORD_BASE = 30_000;
const VARIABLE_WORD_LIMIT = 30_512;

/** Reads an operand as a plain value, resolving a variable reference. */
function valueOf(state: AgosState, operand: AgosOperand | undefined): number {
  if (!operand) return 0;
  switch (operand.kind) {
    case 'byte':
      return operand.variable === undefined ? operand.value : state.read(operand.variable);
    case 'word':
      // See `VARIABLE_WORD_BASE`. Not applied to `raw`, which is the condition
      // marker's own word and never goes through `getVarOrWord`.
      if (operand.value >= VARIABLE_WORD_BASE && operand.value < VARIABLE_WORD_LIMIT) {
        return state.read(operand.value - VARIABLE_WORD_BASE);
      }
      return operand.value;
    case 'raw':
      return operand.value;
    case 'item':
      return operand.id ?? operand.lead;
    case 'string':
      return (operand.id ?? operand.lead) & 0xffff;
  }
}

/** Reads an operand as the *index* of a variable rather than as a value. */
function variableIndex(operand: AgosOperand | undefined): number {
  if (!operand) return 0;
  if (operand.kind === 'byte') return operand.variable ?? operand.value;
  if (operand.kind === 'word') return operand.value;
  return 0;
}

/**
 * Reads an operand as an item number.
 *
 * **The five special leads are registers, not item numbers**, and this used to
 * return them as numbers. A `I` operand whose word is 1, 3, 5, 7 or 9 does not
 * name items 1, 3, 5, 7 and 9: it names the subject register, the object
 * register, the player, the actor and the player's container. The reference
 * spells the same five as −1, −3, −5, −7 and −9, which is what they become once
 * the special word is widened to sixteen bits — so the coincidence that made
 * this look plausible is that the *shortest* encoding of "the subject" reads as
 * a small item number.
 *
 * What it cost: every condition that asks about the subject or the object —
 * which is most of what a verb handler does — asked about an unrelated item
 * instead, and got a confident false. Nothing crashed, and Simon looked at the
 * wrong things.
 *
 * The two remaining leads are answered the way the reference answers them: the
 * actor is 0, because AGOS never had one (`AGOSEngine::actor` is an error stub),
 * and lead 9 is the player's parent, which is the room.
 */
function itemOf(state: AgosState, operand: AgosOperand | undefined): number {
  if (!operand || operand.kind !== 'item') return 0;
  if (operand.id === undefined) {
    switch (operand.lead) {
      case 1:
        return state.subjectItem;
      case 3:
        return state.objectItem;
      case 5:
        return state.me;
      case 7:
        return 0;
      case 9:
        return state.parentOf(state.me);
      default:
        return operand.lead;
    }
  }
  // `fileReadItemID`: all-ones is "no item", and every other id is stored two
  // below the number it means because the first two slots are predefined.
  return operand.id === 0xffffffff ? 0 : (operand.id + 2) & 0xffff;
}

/**
 * Runs Subroutines.
 *
 * Deliberately partial, and it says which part. The opcodes implemented here
 * are the ones whose behaviour is the same across every Version — comparisons,
 * arithmetic, variables and moving items around the tree. Everything that draws,
 * speaks, waits or animates is not here yet, and reaching one is recorded in
 * the report rather than passed over.
 */
export class AgosInterpreter {
  private readonly unimplemented = new Set<string>();
  private executed = 0;
  private linesStopped = 0;
  /**
   * What the instruction just executed asked the stepper to do next.
   *
   * Three separate requests rather than a return value, because `execute` is a
   * three-hundred-case switch whose every arm returns the instruction's
   * *condition* — and the condition is a different question from "and then
   * suspend". Set by an opcode, consumed by {@link advance}, and never both at
   * once except deliberately: `o_picture` sets a wait, `o_process` sets a call,
   * `o_done` sets a return.
   */
  private pendingWait: AgosWait | null = null;
  private pendingCall: number | null = null;
  private pendingReturn = false;

  constructor(
    private readonly block: AgosSubroutineBlock,
    private readonly state: AgosState,
    private readonly target: AgosTarget,
    private readonly graphics?: AgosGraphicsHooks,
    /** The game's pooled strings, so a printed line can be a line. */
    private readonly strings: readonly string[] = [],
    /** Where randomness comes from, so a test can pin it. */
    private readonly random: () => number = Math.random,
    /** The Subroutines and strings that live outside `GAMEPC`. */
    private readonly library?: AgosScriptLibrary,
  ) {}

  /**
   * Subroutines found through the library, kept so a lookup happens once.
   *
   * A Subroutine called every tick would otherwise search thirty table files'
   * worth of blocks on every frame. Keyed by number including the misses, which
   * is why the value is nullable rather than the key being absent: "there is no
   * Subroutine 66" is worth remembering too.
   */
  private readonly found = new Map<number, AgosSubroutine | undefined>();

  /**
   * A Subroutine by number, wherever it lives.
   *
   * `GAMEPC` first, because that is where the verb table and the game's own
   * common code are, and a table file may not shadow them.
   */
  private subroutineById(id: number): AgosSubroutine | undefined {
    const own = this.block.subroutines.find((each) => each.id === id);
    if (own) return own;
    if (!this.library) return undefined;
    // The jump lands on a non-resident subroutine whether or not its bytes are
    // already cached, and the reference reloads its table — and swaps the
    // effects bank — on every such jump. So this fires each time, before the
    // cache is consulted, rather than only on the miss below.
    this.library.enterSubroutine?.(id);
    if (this.found.has(id)) return this.found.get(id);
    const external = this.library.subroutine(id);
    this.found.set(id, external);
    return external;
  }

  /**
   * A string by id, from whichever pool the id names.
   *
   * The top bit is the whole of the decision: `CONTEXT.md`'s pooled strings sit
   * below `0x8000` and the local ones at or above it. Returns undefined rather
   * than a placeholder so a caller can tell "the game says nothing here" from
   * "this project could not find what the game says".
   */
  stringAt(id: number): string | undefined {
    if (id < LOCAL_STRING_ID_BASE) return this.strings[id];
    return this.library?.string(id);
  }

  get report(): AgosRunReport {
    return {
      unimplemented: [...this.unimplemented].sort(),
      executed: this.executed,
      linesStopped: this.linesStopped,
    };
  }

  /**
   * The `o_waitSync`/`os2_waitMark` timeout for this release, in drawing ticks.
   *
   * Simon 1 alone caps at 1000; every other Version, Simon 2 included, at 2500
   * (`waitForSync`, `script.cpp:1076`).
   */
  private get syncTimeoutTicks(): number {
    return this.target.version === 'Simon1' ? SYNC_TIMEOUT_SIMON1 : SYNC_TIMEOUT_OTHERS;
  }

  /**
   * Runs whatever the clock has made due, oldest first.
   *
   * Due events are taken off the queue **before** they run, because a
   * Subroutine that queues another one is normal and a queue mutated mid-walk
   * would either run the new one immediately or lose it.
   */
  runDueEvents(now: number): number {
    let ran = 0;
    for (;;) {
      const id = this.takeDueEvent(now);
      if (id === null) return ran;
      this.run(id);
      ran += 1;
    }
  }

  /**
   * Takes the oldest due time event off the queue, or answers null.
   *
   * The half of `runDueEvents` a running game wants, because the other half —
   * *and then run it to completion* — is the thing that must not happen. A time
   * event's Subroutine blocks like any other, and Simon 1's queue fires the
   * Subroutine that puts up the intro's eleven pictures. Running that inside
   * `runDueEvents` drained every wait it set, so the pacing this class gained
   * elsewhere never reached the one script that needed it most.
   *
   * One at a time, so the caller can run it as a task and come back.
   */
  takeDueEvent(now: number): number | null {
    this.state.clock = now;
    // A script waiting on speech is waiting, and time events wait with it.
    if (now < this.state.speechUntil) return null;

    let oldest = -1;
    for (const [index, event] of this.state.timeEvents.entries()) {
      if (event.due > now) continue;
      if (oldest < 0 || event.due < this.state.timeEvents[oldest]!.due) oldest = index;
    }
    if (oldest < 0) return null;
    const [event] = this.state.timeEvents.splice(oldest, 1);
    return event?.subroutine ?? null;
  }

  /**
   * Runs one Subroutine by number, to completion, in one go.
   *
   * **Waits are satisfied as they arrive here**, which is the honest way to say
   * that this path has no clock: a caller with no frames to spend cannot wait
   * for the drawing bytecode to raise a sync. It is the right behaviour for the
   * sweep, for a test of one opcode's arithmetic, and for a time event whose
   * Subroutine does not block; it is the *wrong* behaviour for a game's intro,
   * which is what {@link begin} and {@link advance} exist for.
   *
   * Returns false when there is no such Subroutine, which is a normal answer.
   */
  run(id: number): boolean {
    const task = this.begin(id, `subroutine ${id}`);
    if (!task) return false;
    // A budget rather than `while (!task.done)`: a Subroutine whose wait never
    // arrives would spin here for ever, and a caller with no clock cannot tell
    // the difference between that and a slow one.
    for (let steps = 0; steps < MAX_DRAINED_STEPS && !task.done; steps += 1) {
      task.wait = null;
      this.advance(task);
    }
    return true;
  }

  /**
   * Starts a Subroutine as a task that can be suspended and resumed.
   *
   * The entry point for a running game, where `run` is the entry point for
   * everything that has no frames to spend. Nothing is executed here: the task
   * comes back at the first instruction of the first line, and {@link advance}
   * runs it.
   */
  begin(id: number, reason = `subroutine ${id}`): AgosTask | null {
    const subroutine = this.subroutineById(id);
    if (!subroutine) return null;
    const task = new AgosTask(reason);
    task.frames.push({ subroutine, line: 0, instruction: 0, inverted: false });
    return task;
  }

  /**
   * Runs a task until it suspends or finishes.
   *
   * The reference's `startSubroutine` and `runScript` in one loop, because in a
   * resumable form they are one loop: a line ends on a failed condition and the
   * next line runs, and an opcode that returns non-zero ends the whole
   * Subroutine. Both of those decisions are per instruction, so neither can
   * live in a function that owns a `for` over lines.
   *
   * A task whose wait has not arrived returns immediately and unchanged, which
   * is what makes calling this once a frame the whole of the scheduling.
   */
  advance(task: AgosTask): void {
    if (task.wait) {
      // The player's two interruptions are tested here rather than inside
      // {@link waitArrived}, because neither of them is the wait arriving:
      // cutting a sequence short abandons the script that is waiting, and
      // {@link waitArrived} answers a question about the world instead.
      if (this.interrupt(task, task.wait)) return;
      if (!this.waitArrived(task.wait)) return;
    }
    task.wait = null;

    while (!task.done && task.wait === null) {
      const frame = task.frames[task.frames.length - 1]!;
      const line = frame.subroutine.lines[frame.line];
      if (!line) {
        // Past the last line: this Subroutine is finished, and an outer one may
        // be waiting behind it.
        task.frames.pop();
        continue;
      }

      const instruction = line.instructions[frame.instruction];
      if (!instruction) {
        this.nextLine(frame);
        continue;
      }
      frame.instruction += 1;

      if (this.isInversion(instruction.opcode)) {
        frame.inverted = true;
        continue;
      }

      const name = opcodeName(this.nameTable, instruction.opcode);
      const condition = this.execute(name, instruction);
      this.executed += 1;

      // **An opcode may end the whole Subroutine**, which is what `o_done`
      // does, and this used to have nowhere to put that. Checked before the
      // condition, because the reference's loop tests its return value first
      // and because `o_done` leaves the condition true.
      if (this.pendingReturn) {
        this.pendingReturn = false;
        task.frames.pop();
        continue;
      }

      if (condition === frame.inverted) {
        this.linesStopped += 1;
        this.nextLine(frame);
        continue;
      }
      frame.inverted = false;

      // A nested call, which is `o_process`. Pushed after the instruction has
      // been accounted for, so a Subroutine that blocks inside the call
      // suspends the pair of them rather than restarting the caller.
      if (this.pendingCall !== null) {
        const id = this.pendingCall;
        this.pendingCall = null;
        if (task.frames.length >= MAX_CALL_DEPTH) {
          this.unimplemented.add(`recursion past ${MAX_CALL_DEPTH} subroutines`);
        } else {
          const called = this.subroutineById(id);
          if (called) {
            task.frames.push({ subroutine: called, line: 0, instruction: 0, inverted: false });
          }
        }
      }

      if (this.pendingWait !== null) {
        task.wait = this.pendingWait;
        this.pendingWait = null;
      }
    }
  }

  /** Moves a frame to the start of its next line. */
  private nextLine(frame: AgosFrame): void {
    frame.line += 1;
    frame.instruction = 0;
    frame.inverted = false;
  }

  /**
   * Whether what a task is waiting for has happened.
   *
   * Every kind has a deadline as well as a condition, because every one of them
   * can fail to arrive: the reference gives up on a sync after a thousand
   * drawing-machine ticks and warns. A wait with no deadline is a hung game
   * rather than a faithful one.
   */
  private waitArrived(wait: AgosWait): boolean {
    switch (wait.kind) {
      case 'sync':
        // A raised sync ends the wait, sync 200 included. This used to
        // special-case 200 and satisfy it from the clock alone, and that is the
        // reported "random audio": a Talkie's speech is MP3 decoded by the
        // browser, so `playSpeech` returns a length of zero, `clock >=
        // speechUntil` is true on the frame the wait is set, and four lines
        // start inside four frames on top of each other. The reference never
        // times a line — the mouth sprite loops on `IF_SPEECH` while the voice
        // sounds and raises `SYNC 200` (`vc15`) when it stops, and `sendSync`
        // clears the wait (`vga.cpp:1005`, `script_s2.cpp`). So 200 is a sync
        // like any other here now.
        if (this.state.syncsRaised.delete(wait.id)) return true;
        // The clock is kept only as the fallback for a release with no voice at
        // all: when nothing is sounding and the recorded length (zero for MP3)
        // has passed, there is no sprite that will ever raise the sync. While a
        // voice *is* active the fallback stands down, which is what stops the
        // lines overlapping in a browser.
        if (
          wait.id === SPEECH_SYNC &&
          !(this.graphics?.speechActive?.() ?? false) &&
          this.state.clock >= this.state.speechUntil
        ) {
          return true;
        }
        return this.state.vgaTicks >= wait.until;
      case 'screen':
        return this.state.vgaTicks >= wait.until;
      case 'mark':
        // Unlike a sync, a mark is not consumed: it stays set until the drawing
        // bytecode clears it, so a second script waiting on the same bit sees
        // it too. The deadline is the same guard against a mark that never
        // arrives.
        return this.state.hasMark(wait.bit) || this.state.vgaTicks >= wait.until;
      case 'speech':
        return this.state.clock >= this.state.speechUntil || this.state.vgaTicks >= wait.until;
    }
  }

  /**
   * Acts on the player's two ways of cutting a blocked script short.
   *
   * Neither is a wait arriving, which is why they are not in {@link
   * waitArrived}: one ends the line of speech the wait is measured against, and
   * the other abandons the waiting script outright. Returns true when the task
   * should be left alone this frame — either because it has just been abandoned
   * or because nothing happened and the wait still stands.
   *
   * **Both are refused unless the game has allowed them.** The reference gates
   * each on a bit flag the game's own scripts set, and that is not caution
   * about our own correctness: a sequence that states something the player has
   * to know is written to be unskippable, and honouring Escape there would lose
   * the information rather than save time.
   */
  private interrupt(task: AgosTask, wait: AgosWait): boolean {
    const state = this.state;

    // A line of speech, cut short. The bit says the mouth-closing animation has
    // already run, so a second right button on the same line does nothing
    // rather than playing it twice.
    if (
      state.rightButtonDown &&
      wait.kind === 'sync' &&
      wait.id === SPEECH_SYNC &&
      !state.bits.has(SPEECH_SKIP_DONE_BIT)
    ) {
      state.rightButtonDown = false;
      this.graphics?.stopSpeech?.();
      state.bits.add(SPEECH_SKIP_DONE_BIT);
      // The wait is measured against the recording, so ending the recording is
      // what ends the wait — bringing the clock forward rather than clearing
      // the wait, so anything else measured against the same line agrees.
      state.speechUntil = state.clock;
      return false;
    }

    if (!state.exitCutscene) return false;
    state.exitCutscene = false;

    // The game has said this sequence may be abandoned, so abandon it — the
    // reference's own route, and the fast one, because Subroutine 170 puts the
    // world straight where the sequence would have.
    if (state.bits.has(CUTSCENE_SKIPPABLE_BIT)) {
      this.endCutscene(task);
      return true;
    }

    /**
     * **Otherwise the wait is cut short rather than the script**, and this is a
     * deliberate divergence.
     *
     * The reference has two ways out of a sequence and neither reaches Simon
     * 1's opening: bit 9 is set by six of its Subroutines and the opening is
     * not one of them, and the right button's route is refused because bit 14
     * — "nobody is talking" — is set by the boot Subroutine and never cleared
     * by anything in the game or in the reference. Both checked against the
     * game's own bytecode. So a player watching the opening has no way out, and
     * fifty-five seconds of it is what this engine's first report from a player
     * was about.
     *
     * What this does instead cannot desynchronise anything, which is the whole
     * reason it is allowed: **every instruction still runs, in order** — only
     * the waiting between them is shortened. Skipping in the abandoning sense
     * needs the game's permission because it leaves instructions unexecuted;
     * declining to wait needs none. A player holding Escape runs the opening
     * through at the speed the pictures can be drawn.
     */
    state.speechUntil = state.clock;
    this.graphics?.stopSpeech?.();
    if (wait.kind === 'sync') state.syncsRaised.add(wait.id);
    return false;
  }

  /**
   * Abandons the sequence that is playing and lets the game tidy up after it.
   *
   * `endCutscene` in the reference, and the order matters: the game's own
   * Subroutine 170 runs *first*, putting the world where the sequence would
   * have left it, and only then is the waiting script thrown away. Doing it the
   * other way round would drop the player into a scene the sequence never
   * finished building.
   *
   * The task is emptied rather than resumed, which is what the reference's
   * `_runScriptReturn1` amounts to: it makes every frame of the call stack
   * return at its next instruction, so a Subroutine that had called another is
   * abandoned along with it.
   */
  endCutscene(task: AgosTask): void {
    this.graphics?.stopSpeech?.();
    this.state.speechUntil = this.state.clock;
    if (this.subroutineById(CUTSCENE_END_SUBROUTINE)) this.run(CUTSCENE_END_SUBROUTINE);
    task.frames.length = 0;
    task.wait = null;
  }

  /**
   * Takes the Subroutine a script has left in variable 254, if there is one.
   *
   * The reference reads it on every idle pass of `hitarea_stuff_helper` and
   * clears it, which makes the variable a **channel** rather than a value: a
   * script that cannot call another directly — because it is about to end, or
   * because the call would nest — leaves its number here for the Engine to pick
   * up once nothing is running.
   *
   * Returns null when the channel is empty, which is the normal state.
   *
   * The variable is a parameter because Simon 2 has two such channels — 254 and
   * the walk's 249 ({@link WALK_SUBROUTINE_VARIABLE}) — read by the same rule.
   */
  takeQueuedSubroutine(variable: number = NEXT_SUBROUTINE_VARIABLE): number | null {
    const id = this.state.read(variable);
    if (!id) return null;
    this.state.write(variable, 0);
    return this.subroutineById(id) ? id : null;
  }

  /**
   * Runs the lines of the verb table whose guard matches.
   *
   * This is how a click reaches code: the guard carries a verb and two nouns,
   * and a wildcard in a noun means "anything". Everything a player does in an
   * AGOS game arrives here.
   *
   * **The wildcard is `0xFFFF` as stored, and this used to compare against
   * `-1`.** They are the same bits read with different signedness, and the
   * guards are read unsigned — so the test saw 65535, took it for a real noun,
   * found it did not equal what the player clicked, and skipped the line. In
   * Simon 1's DOS floppy demo every noun slot in the table is that value, and
   * none is `-1`, so on real data almost nothing a player did could match.
   * `isGuardWildcard` is now the one place that decision is made.
   */
  runVerb(verb: number, noun1 = -1, noun2 = -1): boolean {
    const task = this.beginVerb(verb, noun1, noun2);
    if (!task) return false;
    for (let steps = 0; steps < MAX_DRAINED_STEPS && !task.done; steps += 1) {
      task.wait = null;
      this.advance(task);
    }
    return true;
  }

  /**
   * The verb table as a task, so a command that blocks can block.
   *
   * The guard's own semantics are the reference's `checkIfToRunSubroutineLine`:
   * a verb and two nouns, with a wildcard in a noun meaning "anything". What
   * differs from {@link begin} is that the *lines* are filtered rather than the
   * Subroutine chosen, so the frame carries the matching lines as a Subroutine
   * of its own — which is also why a matched command runs its lines in the
   * table's order rather than in the order they were found.
   *
   * **The wildcard is `0xFFFF` as stored, and this used to compare against
   * `-1`.** They are the same bits read with different signedness, and the
   * guards are read unsigned — so the test saw 65535, took it for a real noun,
   * found it did not equal what the player clicked, and skipped the line. In
   * Simon 1's DOS floppy demo every noun slot in the verb table is that value
   * and none is `-1`, so on real data almost nothing a player did could match.
   * `isGuardWildcard` is now the one place that decision is made.
   */
  beginVerb(verb: number, noun1 = -1, noun2 = -1): AgosTask | null {
    const table = this.block.subroutines.find((each) => each.id === 0);
    if (!table) return null;
    const lines = table.lines.filter((line) => {
      const guard = line.guard;
      if (!guard || guard.verb !== verb) return false;
      if (!isGuardWildcard(guard.noun1) && !isGuardWildcard(noun1) && guard.noun1 !== noun1) {
        return false;
      }
      if (!isGuardWildcard(guard.noun2) && !isGuardWildcard(noun2) && guard.noun2 !== noun2) {
        return false;
      }
      return true;
    });
    if (lines.length === 0) return null;

    const task = new AgosTask(`verb ${verb} on ${noun1}/${noun2}`);
    task.frames.push({
      // The matched lines, as a Subroutine the stepper can walk. `endMarker` is
      // never written back from here, so its value is not a decision.
      subroutine: { id: 0, lines, endMarker: table.endMarker },
      line: 0,
      instruction: 0,
      inverted: false,
    });
    return task;
  }

  private get nameTable(): string {
    return opcodeTableFor(this.target).replace(/talkie|dos$/, '');
  }

  private isInversion(opcode: number): boolean {
    return this.target.version === 'Elvira1' ? opcode === 203 : opcode === 0;
  }

  /**
   * One instruction. Returns the condition it leaves behind.
   *
   * An unimplemented opcode returns true — the line carries on — and is
   * recorded. Returning false would silently prune the rest of every line that
   * touches anything unimplemented, which would look like the game working.
   */
  private execute(name: string, instruction: AgosInstruction): boolean {
    const state = this.state;
    const operands = instruction.operands;
    const value = (index: number): number => valueOf(state, operands[index]);
    const item = (index: number): number => itemOf(state, operands[index]);
    const variable = (index: number): number => variableIndex(operands[index]);

    switch (name) {
      case 'o_at':
        return state.parentOf(state.me) === item(0);
      case 'o_notAt':
        return state.parentOf(state.me) !== item(0);
      case 'o_carried':
        return state.parentOf(item(0)) === state.item1;
      case 'o_notCarried':
        return state.parentOf(item(0)) !== state.item1;
      case 'o_isAt':
        return state.parentOf(item(0)) === item(1);
      case 'o_zero':
        return state.read(variable(0)) === 0;
      case 'o_notZero':
        return state.read(variable(0)) !== 0;
      case 'o_eq':
        return state.read(variable(0)) === value(1);
      case 'o_notEq':
        return state.read(variable(0)) !== value(1);
      case 'o_gt':
        return state.read(variable(0)) > value(1);
      case 'o_lt':
        return state.read(variable(0)) < value(1);
      case 'o_eqf':
        return state.read(variable(0)) === state.read(variable(1));
      case 'o_notEqf':
        return state.read(variable(0)) !== state.read(variable(1));
      case 'o_gtf':
        return state.read(variable(0)) > state.read(variable(1));
      case 'o_ltf':
        return state.read(variable(0)) < state.read(variable(1));
      case 'o_state':
        return (state.items[item(0)]?.state ?? -1) === value(1);

      case 'o_let':
        state.write(variable(0), value(1));
        return true;
      case 'o_add':
        state.write(variable(0), state.read(variable(0)) + value(1));
        return true;
      case 'o_sub':
        state.write(variable(0), state.read(variable(0)) - value(1));
        return true;
      case 'o_addf':
        state.write(variable(0), state.read(variable(0)) + state.read(variable(1)));
        return true;
      case 'o_subf':
        state.write(variable(0), state.read(variable(0)) - state.read(variable(1)));
        return true;
      case 'o_mul':
        state.write(variable(0), state.read(variable(0)) * value(1));
        return true;
      case 'o_div': {
        const divisor = value(1);
        // The reference calls this an error and stops. Stopping is right: a
        // division by zero here means the state is already wrong, and carrying
        // on would bury the evidence.
        if (divisor === 0) throw new Error('o_div: division by zero');
        state.write(variable(0), Math.trunc(state.read(variable(0)) / divisor));
        return true;
      }
      case 'o_mod': {
        const divisor = value(1);
        if (divisor === 0) throw new Error('o_mod: division by zero');
        state.write(variable(0), state.read(variable(0)) % divisor);
        return true;
      }
      case 'o_copyff':
        state.write(variable(1), state.read(variable(0)));
        return true;
      case 'o_clear':
        state.write(variable(0), 0);
        return true;

      // Graphics. Handled here rather than reported as unimplemented, because
      // they are the only two opcodes that reach the screen at all — a game
      // whose loadZone is a no-op looks exactly like a game whose renderer is
      // broken, and the two are worth telling apart.
      case 'o_loadZone':
        if (!this.graphics) {
          this.unimplemented.add('o_loadZone (no screen attached)');
          return true;
        }
        this.graphics.loadZone(value(0));
        return true;
      case 'os1_animate':
      case 'o_animate': {
        if (!this.graphics) {
          this.unimplemented.add(`${name} (no screen attached)`);
          return true;
        }
        const spriteId = value(0);
        // The zone is the sprite id's hundreds digit — arithmetic rather than a
        // field, which is the kind of thing that reads as a bug until you have
        // seen the reference.
        this.graphics.animate(
          Math.floor(spriteId / 100),
          spriteId,
          value(2),
          value(3),
          value(4) & 15,
        );
        return true;
      }

      // The interface, which is data. These build Simon's verb list and
      // inventory as surely as they build a clickable door.
      case 'off_addBox':
      case 'oe1_addBox':
      case 'o_addBox':
        state.hitAreas.add(value(0), value(1), value(2), value(3), value(4), item(5), value(6));
        return true;
      case 'o_delBox':
        state.hitAreas.remove(value(0));
        return true;
      case 'o_enableBox':
        state.hitAreas.setEnabled(value(0), true);
        return true;
      case 'o_disableBox':
        state.hitAreas.setEnabled(value(0), false);
        return true;
      case 'o_moveBox':
        state.hitAreas.move(value(0), value(1), value(2));
        return true;
      case 'o_isBox':
        return state.hitAreas.has(value(0));

      case 'oe2_playEffect':
      case 'os1_playEffect':
        if (!this.graphics?.playEffect) {
          this.unimplemented.add('os1_playEffect (no sound attached)');
          return true;
        }
        this.graphics.playEffect(value(0));
        return true;

      case 'oe1_playTune':
      case 'os2_playTune':
      case 'opp_playTune':
      case 'o_playTune':
        if (!this.graphics?.playMusic) {
          this.unimplemented.add('o_playTune (no sound attached)');
          return true;
        }
        this.graphics.playMusic(value(0));
        return true;

      // Timers. `o_when` is how a script asks for anything to happen later,
      // including the game's own first move.
      case 'o_when':
        state.timeEvents.push({ due: state.clock + value(0), subroutine: value(1) });
        return true;
      case 'o_clearTimers':
        state.timeEvents.length = 0;
        return true;

      // Words. Collected rather than drawn (see `messages`).
      /**
       * The opcodes that make a game *say* something.
       *
       * `oww_setShortText` and `oww_setLongText` used to be in this group and
       * do not belong: they record a name and a description for a slot the
       * room's hit areas refer to, rather than showing anything. Displaying
       * them put a room's scenery descriptions on screen as if a character had
       * spoken them, which is why the wizard's study opened with "It's my
       * little dog - Chippy." on its status line and kept it there.
       */
      case 'o_msg':
      case 'oww_boxMessage':
      case 'oww_boxMsg':
      case 'oww_boxLongText':
      case 'opp_message':
      case 'opp_setShortText':
      case 'os1_screenTextMsg': {
        const operand = operands.find((each) => each.kind === 'string');
        // Sixteen bits, for `itemOrStringId`'s reason.
        const id =
          operand && operand.kind === 'string' && operand.id !== undefined
            ? operand.id & 0xffff
            : undefined;
        if (id !== undefined) {
          const line = this.stringAt(id) ?? `string(${id})`;
          state.messages.push(line);
          // Replaces what is on screen rather than adding to it: a game shows
          // one line at a time. See `AgosState.onScreen`.
          state.onScreen.splice(0, state.onScreen.length, line);
        }

        // The talkie's extra operand *is* the speech id — the one ADR 0027's
        // tripwire fired on. A floppy release has no such operand, so nothing
        // here has to ask which release it is: if the operand is present, the
        // line was recorded.
        const stringAt = operands.findIndex((each) => each.kind === 'string');
        const speech = stringAt >= 0 ? operands[stringAt + 1] : undefined;
        if (speech?.kind === 'word' && this.graphics?.playSpeech) {
          const seconds = this.graphics.playSpeech(speech.value);
          // Where the line was played, the script's pacing is owed the same
          // pause whether or not anybody is listening.
          if (seconds !== null) state.speechUntil = state.clock + seconds;
        }
        return true;
      }
      /**
       * Simon 2's "show string from array" (opcode 70), which is where a room
       * object's description reaches the screen.
       *
       * The far end of the same chain as {@link os1_scnTxtLongText}: a slot
       * number, put on a hit area by `oww_addTextBox` and filled in by
       * `oww_setLongText`, is read back here and its string shown. The reference
       * (`script_s2.cpp:290`) also writes variable 51 with the height the text
       * needs — `strlen / 53 * 8 + 8`, 53 characters to a line and eight pixels
       * to a line — so the game can size the window it prints into.
       */
      case 'os2_printLongText': {
        const held = state.longText.get(value(0));
        if (!held) return true;
        const line = this.stringAt(held.string);
        if (line !== undefined && line !== '') {
          state.messages.push(line);
          state.onScreen.splice(0, state.onScreen.length, line);
          state.write(51, Math.floor(line.length / 53) * 8 + 8);
        }
        if (held.speech !== 0 && this.graphics?.playSpeech) {
          const seconds = this.graphics.playSpeech(held.speech);
          if (seconds !== null) state.speechUntil = state.clock + seconds;
        }
        return true;
      }
      case 'o_print':
      case 'off_printLongText':
      case 'oww_printBox':
      case 'oww_printLongText':
        // These print a string the game has already selected, which this
        // interpreter does not track yet — recorded as a gap rather than
        // pushing an empty line that would read as the game saying nothing.
        this.unimplemented.add(name);
        return true;

      // Item classes: AGOS's way of grouping items without a second structure.
      case 'o_isClass':
        return ((state.classFlags.get(item(0)) ?? 0) & (1 << value(1))) !== 0;
      case 'o_setClass':
        state.classFlags.set(item(0), (state.classFlags.get(item(0)) ?? 0) | (1 << value(1)));
        return true;
      case 'o_unsetClass':
        state.classFlags.set(item(0), (state.classFlags.get(item(0)) ?? 0) & ~(1 << value(1)));
        return true;

      // What an item *is* comes from the sub-structures hanging off it rather
      // than from where it sits in the tree.
      case 'o_isRoom':
        return hasChildOfType(state, item(0), ITEM_CHILD_TYPES.room);
      case 'o_isObject':
        return hasChildOfType(state, item(0), ITEM_CHILD_TYPES.object);

      case 'o_random':
        // Deterministic by default so a test can assert on it; the Engine
        // supplies a real source when one is wanted.
        state.write(variable(0), Math.floor(this.random() * Math.max(1, value(1))));
        return true;
      case 'off_chance':
      case 'o_chance': {
        const chance = value(0);
        if (chance <= 0) return false;
        if (chance >= 100) return true;
        return this.random() * 100 < chance;
      }

      case 'o_place':
        state.place(item(0), item(1));
        return true;
      case 'o_destroy':
        state.place(item(0), 0);
        return true;

      // Walking the tree. A script sets one of two registers and then acts on
      // it; the byte operand picks which, and 1 means the subject.
      case 'o_getParent':
        state.setRegister(value(1), state.parentOf(item(0)));
        return true;
      case 'o_getNext':
        state.setRegister(value(1), itemIdOf(state.items[item(0)]?.next ?? { raw: 0xffffffff }));
        return true;
      case 'o_getChildren':
        state.setRegister(value(1), itemIdOf(state.items[item(0)]?.child ?? { raw: 0xffffffff }));
        return true;

      // The player moving, which is what a game does most.
      case 'oww_goto':
      case 'o_goto':
        state.place(state.me, item(0));
        return true;
      case 'o_putBy':
        state.place(item(0), state.parentOf(item(1)));
        return true;
      case 'o_here':
        return state.parentOf(state.me) === state.parentOf(item(0));
      case 'o_is':
        return item(0) === item(1);

      // An item's state, clamped the way the reference clamps it: a state
      // outside the range is pinned rather than wrapped, and wrapping would
      // turn a counter that overran into one that looks reset.
      case 'o_setState':
        state.setState(item(0), Math.min(30_000, Math.max(0, value(1))));
        return true;
      case 'o_inc': {
        const current = state.items[item(0)]?.state ?? 0;
        if (current <= 30_000) state.setState(item(0), current + 1);
        return true;
      }
      case 'o_dec': {
        const current = state.items[item(0)]?.state ?? 0;
        if (current >= 0) state.setState(item(0), current - 1);
        return true;
      }

      // Calling another Subroutine. Depth is capped for the reason the
      // reference caps it: a game with a script that calls itself should say so
      // rather than exhaust the stack.
      /**
       * Calls another Subroutine, and the call has to be able to block.
       *
       * Asked for rather than performed, so {@link advance} pushes a frame
       * instead of this recursing into `run`. The difference matters exactly
       * when the called Subroutine waits: a recursive call would satisfy that
       * wait immediately and return, where a pushed frame suspends the caller
       * with it. Simon 1's intro is a chain of these.
       *
       * The depth limit moved to the stepper with the stack it now guards.
       */
      case 'o_process':
        this.pendingCall = value(0);
        return true;

      /**
       * Runs an **item's own** Subroutine, which is not its item number.
       *
       * `oe2_doTable` takes an item and calls the Subroutine named inside that
       * item's *room* sub-structure — `SubRoom::subroutine_id` in the
       * reference, the first word of the record. Sharing `o_process`'s
       * implementation called subroutine 91 for item 91, which is a different
       * Subroutine or none.
       *
       * That is how a room's behaviour is reached at all. Simon 1's walk
       * handler ends `oe2_doTable item:special(9)` — *run the script of the
       * room the player is in* — and with the wrong number called, a click
       * computed its destination correctly and then asked nothing to move
       * anybody there.
       *
       * An item with no room record is not an error: most items are not rooms,
       * and the reference returns without calling anything.
       */
      case 'oe2_doTable': {
        const room = state.items[item(0)]?.children.find(
          (child) => child.type === ITEM_CHILD_TYPES.room,
        );
        const id = room?.header?.[0];
        if (id === undefined) return true;
        this.pendingCall = id;
        return true;
      }

      case 'o_end':
        state.quit = true;
        return true;
      /**
       * Ends the Subroutine, and used to do nothing at all.
       *
       * The reference's `o_done` sets a non-zero script return, which
       * `startSubroutine` treats as "stop walking this Subroutine's lines". A
       * no-op here meant every line after it ran anyway — and the shape it
       * appears in is *exactly* the shape that makes that fatal:
       *
       * ```
       * line 0:  oe2_bNotZero 71 ; o_when 3, 160 ; o_done
       * line 1:  o_sub 116, 1
       * ```
       *
       * Line 0 is "if that bit is set, come back in three seconds and stop
       * here". Running on into line 1 decremented the countdown line 0 had just
       * decided to leave alone, so Simon 1's idle timer ran on every tick of
       * the intro instead of only when the intro was over.
       */
      case 'o_done':
        this.pendingReturn = true;
        return true;

      // An object's flags, which live on the item's object sub-structure rather
      // than beside its class flags. Only bits 16 and up are settable: the low
      // sixteen are the mask that sized the record, and writing one would
      // change how many values the record holds without moving any of them.
      case 'o_oset':
        state.setObjectFlag(item(0), value(1), true);
        return true;
      case 'o_oclear':
        state.setObjectFlag(item(0), value(1), false);
        return true;
      case 'o_oflag':
        return state.objectFlag(item(0), value(1));

      case 'o_isCalled': {
        const named = operands.find((each) => each.kind === 'string');
        const wanted = named && named.kind === 'string' ? named.id : undefined;
        return wanted !== undefined && state.objectName(item(0)) === wanted;
      }

      // The two registers again, this time written directly.
      case 'o_setDollar':
        state.setRegister(value(0), item(1));
        return true;
      case 'o_if1':
        return state.subjectItem !== 0;
      case 'o_if2':
        return state.objectItem !== 0;
      case 'o_copysf':
        state.write(variable(1), state.items[item(0)]?.state ?? 0);
        return true;

      // Windows are where text goes. The game defines them and then selects
      // one; nothing here draws, so they are recorded rather than acted on —
      // and recorded rather than ignored, because a script that opens a window
      // and gets no error is telling the truth about what it asked for.
      case 'o_defWindow':
        // `BNNNNNN`: num, x, y, w, h, flags, colour. For Simon 2 the seventh
        // operand is the fill colour outright (the Elvira/Waxworks split of
        // `colour % 100` / `colour / 100` into fill and text does not apply);
        // `script.cpp:614`. flags and fill were decoded and discarded until the
        // icon panel needed a background — see `AgosState.windows`.
        state.windows.set(value(0) & 7, {
          x: value(1),
          y: value(2),
          width: value(3),
          height: value(4),
          flags: value(5),
          fillColour: value(6),
        });
        return true;
      case 'o_window':
        state.currentWindow = value(0) & 7;
        return true;
      case 'o_closeWindow':
        state.windows.delete(value(0) & 7);
        return true;
      /**
       * Clears the screen's text.
       *
       * The **transcript** is kept, which is the whole distinction between
       * `messages` and `onScreen`: `o_cls` is a game clearing its display, not
       * a game unsaying what it said, and a stall report wants the latter.
       */
      case 'o_cls':
        state.onScreen.length = 0;
        return true;

      // The words a click was made of. A verb-table line is guarded by a verb
      // and two nouns, and these are how a script *sets* the nouns it will be
      // matched against — which is how one click leads to another.
      case 'o_setAdjNoun':
        if (value(0) === 1) {
          state.adjective1 = value(1);
          state.noun1 = value(2);
        } else {
          state.adjective2 = value(1);
          state.noun2 = value(2);
        }
        return true;

      // Item slots, which Elvira 2 uses where Simon uses the two registers.
      case 'o_defObj':
        state.itemSlots.set(value(0), item(1));
        return true;
      case 'oe2_storeItem':
        state.itemSlots.set(value(0), item(1));
        return true;
      case 'oe2_getItem':
        state.setRegister(value(1), state.itemSlots.get(value(0)) ?? 0);
        return true;

      // An object's numbered values, beside its flags on the same record.
      case 'oe2_getOValue':
        state.write(variable(2), state.objectValue(item(0), value(1)));
        return true;
      case 'oe2_setOValue':
        state.setObjectValue(item(0), value(1), value(2));
        return true;

      // Things that exist to be read by a person rather than run.
      case 'o_message':
        state.messages.push(this.stringAt(itemOrStringId(operands[0])) ?? '');
        return true;
      case 'o_comment':
      case 'o_debug':
        // Deliberately nothing: the reference consumes the operand and drops
        // it, and a comment that reached the screen would be a change in what
        // the game says rather than a fix.
        return true;

      // Animation, which is the graphics machine's business. Recorded so a
      // stalled game can say the scripts asked for it.
      case 'o_haltAnimation':
        state.animationHalted = true;
        return true;
      case 'o_restartAnimation':
        state.animationHalted = false;
        return true;
      /**
       * Raises a sync id, which is how a script tells another it has arrived.
       */
      case 'o_sync': {
        const id = value(0);
        state.lastSync = id;
        state.syncsRaised.add(id);
        // And the drawing machines, which is the half `sendSync` exists for.
        this.graphics?.raiseSync?.(id);
        return true;
      }

      /**
       * **Waits** for a sync, which is not the same opcode and was treated as
       * one.
       *
       * This is the instruction Simon 1's intro is built out of: start an
       * animation, then stop until it says it has finished. Recording the id
       * and carrying on ran the intro's eleven pictures and its dozen
       * animations between two frames of the renderer — so every wait fell
       * through, every picture but the last was overwritten before it was
       * drawn, and a player saw the final frame of a sequence that had already
       * happened.
       *
       * A sync already raised satisfies it at once, which is the reference's
       * `_lastVgaWaitFor` short-circuit: a script that waits for what has just
       * happened does not wait.
       */
      case 'o_waitSync': {
        const id = value(0);
        state.lastSync = id;
        // A sync already raised satisfies the wait at once, sync 200 included:
        // the reference's `_lastVgaWaitFor` short-circuit does not exempt it,
        // and now that 200 is raised by the mouth sprite rather than read off
        // the clock, exempting it would leave a stale raise to skip the next
        // line. See {@link waitArrived}.
        if (state.syncsRaised.delete(id)) return true;
        // **Both interruptions are cleared as the wait begins**, which is the
        // reference's first two lines of `waitForSync` and not an accident of
        // ordering: a wait tests them on every pass, so a stale latch from an
        // earlier sequence would skip this one before the player had asked.
        state.exitCutscene = false;
        state.rightButtonDown = false;
        this.pendingWait = {
          kind: 'sync',
          id,
          until: state.vgaTicks + this.syncTimeoutTicks,
        };
        return true;
      }

      // The three arithmetic opcodes whose second operand is a variable rather
      // than a value. Missing them made a game divide by the *index* of a
      // divisor instead of by the divisor.
      case 'o_mulf':
        state.write(variable(0), state.read(variable(0)) * state.read(variable(1)));
        return true;
      case 'o_divf': {
        const divisor = state.read(variable(1));
        if (divisor === 0) throw new Error('o_divf: division by zero');
        state.write(variable(0), Math.trunc(state.read(variable(0)) / divisor));
        return true;
      }
      case 'o_modf': {
        const divisor = state.read(variable(1));
        if (divisor === 0) throw new Error('o_modf: division by zero');
        state.write(variable(0), state.read(variable(0)) % divisor);
        return true;
      }

      // Elvira 2's second bank of bits, which is a separate set rather than a
      // higher range of the first — a game using both would collide otherwise.
      case 'off_b2Set':
      case 'oe2_b2Set':
        state.bits2.add(value(0));
        return true;
      case 'oe2_b2Clear':
        state.bits2.delete(value(0));
        return true;
      case 'oe2_b2Zero':
        return !state.bits2.has(value(0));
      case 'oe2_b2NotZero':
        return state.bits2.has(value(0));

      case 'off_isAdjNoun':
      case 'oe2_isAdjNoun': {
        // Compares an item's own adjective and noun against the pair a click
        // was made of, which is how a game asks "is this the thing I clicked".
        const target = state.items[item(0)];
        return target !== undefined && target.adjective === value(1) && target.noun === value(2);
      }

      case 'oe2_getDollar2':
        state.subjectItem = state.objectItem;
        return true;

      // Zones, which a script loads and unloads around a room change.
      case 'os1_unloadZone':
        state.unloadedZones.add(value(0));
        return true;
      // Elvira 1 / Waxworks stop a single sprite, addressed by an id alone
      // whose zone is its hundreds column, as their `animate` is. Sharing
      // `unloadZone`'s body made it a no-op — a zone nobody unloads — so a
      // sprite the script asked to stop kept animating. See Fault 4.
      case 'oe1_stopAnimate':
        if (this.graphics) this.graphics.stopAnimate?.(Math.floor(value(0) / 100), value(0));
        return true;
      case 'o_freezeZones':
      case 'oww_lockZones':
        state.zonesFrozen = true;
        return true;
      case 'os1_unfreezeZones':
      case 'oww_unlockZones':
        state.zonesFrozen = false;
        return true;
      /**
       * **Not a halt: a clearing out.** This used to set the same flag
       * `o_haltAnimation` sets, which is a different opcode with a different
       * job — and nothing reads that flag, so the effect was none at all.
       *
       * The reference's `o_killAnimate` is one line, `vc27_resetSprite()`, and
       * the sprite table it empties is the game's rather than one zone's.
       * Simon 1's opening runs it twice: once as the intro hands over and once
       * as the study is set up, and each time it is meant to take the last
       * scene's actors off the screen. Without it Simon's desk pose stayed
       * drawn where the intro had left it, so the first floor click walked him
       * to where it landed and left a second Simon standing at the desk for
       * the rest of the game.
       */
      case 'o_killAnimate':
        this.graphics?.resetSprites?.();
        return true;

      // The pointer, which a script hides while it draws.
      case 'os2_mouseOn':
      case 'off_mouseOn':
      case 'os1_mouseOn':
        state.pointerVisible = true;
        return true;
      case 'off_mouseOff':
      case 'os2_mouseOff':
      case 'os1_mouseOff':
        state.pointerVisible = false;
        return true;

      case 'o_picture': {
        if (!this.graphics) {
          this.unimplemented.add('o_picture (no screen attached)');
          return true;
        }
        // The operands are the reference's: a sprite id, then which window to
        // put it in. The zone is the id's hundreds column, as everywhere else.
        const image = value(0);
        if (!this.graphics.setWindowImage) {
          this.unimplemented.add('o_picture (no window to put a picture in)');
          return true;
        }
        this.graphics.setWindowImage(value(1), image);
        // **And then wait for it**, which is the reference's
        // `while (_copyScnFlag) delay(1)` inside `setWindowImageEx`. Without it
        // a script that puts up a sequence of pictures puts them all up inside
        // one frame and only the last is ever drawn — which is what Simon 1's
        // intro looked like: eleven palette loads and one visible screen.
        this.pendingWait = {
          kind: 'screen',
          until: state.vgaTicks + SCREEN_COPY_TICKS,
        };
        return true;
      }

      case 'o_placeNoIcons':
        // The same move as `o_place`; the difference is only whether the
        // interface redraws, which nothing here does yet.
        state.place(item(0), item(1));
        return true;

      // The inventory display, which is a *list* rather than a drawing: the
      // items in a container, optionally filtered by class. Building the list
      // is data work and belongs here; drawing it is the renderer's, and the
      // list is what the renderer will need either way.
      case 'o_doIcons':
        state.icons = { container: item(0), window: value(1), classMask: 0 };
        return true;
      case 'o_doClassIcons':
        state.icons = {
          container: item(0),
          window: value(1),
          // Elvira 1 passes the mask; everything later passes the bit number.
          classMask: this.target.version === 'Elvira1' ? value(2) : 1 << value(2),
        };
        return true;
      case 'o_restoreIcons':
        // Redraws whatever the window already had, so the list is unchanged.
        return true;

      case 'off_setColor':
      case 'oe2_ink':
        state.textColour = value(0);
        return true;

      // Text boxes: where a line of dialogue goes. Recorded rather than drawn,
      // like the windows, so a stalled game can say what it asked for.
      case 'os1_screenTextBox':
      case 'os2_screenTextPObj':
      case 'oww_boxPObj':
      case 'off_screenTextBox':
      case 'off_screenTextPObj':
      case 'os1_screenTextPObj':
        state.textBoxes.push({ x: value(1), y: value(2), width: value(3) });
        return true;

      /**
       * Says a room object's description, which is what "Look at" comes to.
       *
       * Its third operand is a **slot**, not a string id: the description was
       * put there by `oww_setLongText` when the room was set up, along with its
       * recorded line. So this is the far end of the chain that starts with
       * `oww_addTextBox` — a box on screen, a slot number on the box, and the
       * words here.
       *
       * Filed with the text-box recorders before, so looking at anything in a
       * room noted a rectangle and said nothing.
       */
      case 'os1_scnTxtLongText': {
        const held = state.longText.get(value(2));
        if (!held) return true;
        const line = this.stringAt(held.string);
        if (line !== undefined && line !== '') {
          state.messages.push(line);
          state.onScreen.splice(0, state.onScreen.length, line);
        }
        if (held.speech !== 0 && this.graphics?.playSpeech) {
          const seconds = this.graphics.playSpeech(held.speech);
          if (seconds !== null) state.speechUntil = state.clock + seconds;
        }
        return true;
      }

      /**
       * **`oww_addTextBox` adds a hit area**, and its name says otherwise.
       *
       * The reference's own comment on it is `// 65: add hit area`, and it calls
       * `defineBox` — so this is how a room's *scenery* becomes clickable. It
       * was filed with the text-box recorders on the strength of its name, so
       * every room's objects went into a list nothing read: the wizard's study
       * has six of them and not one could be pointed at.
       *
       * The slot number is folded into the flags in the reference
       * (`(number << 8) + 129`) and kept as the box's item here, because that is
       * what a click needs to find the description
       * {@link AgosState.longText} holds. Its verb is 208, which is the
       * reference's constant.
       */
      case 'oww_addTextBox':
      case 'off_addTextBox': {
        const slot = value(5);
        state.hitAreas.add(
          value(0),
          value(1),
          value(2),
          value(3),
          value(4),
          // Negative, so it cannot be confused with an item number: a text-box
          // box refers to a slot in the room's own descriptions rather than to
          // anything in the item tree.
          -1 - slot,
          TEXT_BOX_VERB,
        );
        return true;
      }

      /** Slot *n*'s name, which is what the status line shows on hover. */
      case 'oww_setShortText':
        state.shortText.set(value(0), itemOrStringId(operands[1]));
        return true;

      /**
       * Slot *n*'s description, and its recorded line where the release has one.
       *
       * The talkie carries a third operand that the floppy does not — the same
       * split ADR 0027's tripwire fired on — so the speech id is read from the
       * operand where there is one rather than from the release kind.
       */
      case 'oww_setLongText': {
        const speech = operands[2];
        state.longText.set(value(0), {
          string: itemOrStringId(operands[1]),
          speech: speech?.kind === 'word' ? speech.value : 0,
        });
        return true;
      }

      case 'oe1_pauseGame':
      case 'oe2_pauseGame':
      case 'oww_pauseGame':
      case 'opp_pauseClock':
      case 'off_stopClock':
      case 'os1_pauseGame':
        state.paused = true;
        return true;
      case 'os1_specialFade':
        state.fading = true;
        return true;

      // Saving, which a game asks for and the shell owns.
      case 'off_saveUserGame':
      case 'opp_saveUserGame':
      case 'o_saveUserGame':
        if (!this.graphics?.saveGame) {
          this.unimplemented.add('o_saveUserGame (no save store attached)');
          return true;
        }
        this.graphics.saveGame();
        return true;
      case 'oe1_loadGame':
      case 'off_loadUserGame':
      case 'opp_loadUserGame':
      case 'o_loadUserGame':
        if (!this.graphics?.loadGame) {
          this.unimplemented.add('o_loadUserGame (no save store attached)');
          return true;
        }
        this.graphics.loadGame();
        return true;

      case 'oe1_rescan':
        // Asks the interpreter to start the current Subroutine again. Recorded
        // rather than looped, because a rescan implemented as recursion is an
        // infinite loop in every game that uses it as a `continue`.
        state.rescanRequested = true;
        return true;

      // Simon's beard, which is a whole opcode pair because the game swaps one
      // graphics resource for another to put it on his face. A flag here and a
      // zone swap in the renderer: the interpreter's half is knowing which.
      case 'os1_loadBeard':
        state.beardLoaded = true;
        return true;
      case 'os1_unloadBeard':
        state.beardLoaded = false;
        return true;

      case 'os1_loadStrings':
        // Selects which speech and effects files the game reads from, which is
        // how a talkie changes voice sets between parts of the game.
        state.soundFileId = value(0);
        return true;

      /**
       * Where on the room's walk paths a click lands.
       *
       * Not a search: the routes are **authored**, handed out by the drawing
       * bytecode as `SET_PATHFIND_ITEM`'s list of points, and this asks which
       * of them is nearest. The script writes the answer into two variables and
       * does its own walking from there — which is why one lookup is the whole
       * of the opcode.
       *
       * This used to answer "where you asked" and name itself as unimplemented.
       * That was honest and it was also unusable: the script takes the two
       * numbers as a *route* and an *index into it*, so being handed a pair of
       * screen coordinates sent Simon to point 200 of route 160.
       *
       * The routes are still the drawing bytecode's, so a room whose scripts
       * have not run yet has none, and this says so by name rather than
       * inventing a route.
       */
      case 'os1_getPathPosn': {
        // A click's x is where it landed on the *screen*; a route point is in
        // the *room*. In a scrolling room the two differ by the scroll, so the
        // reference adds it back before matching — `x += _scrollX * 8` for
        // Simon 2 (`_scrollX` is variable 251, in eight-pixel columns). Without
        // it a click on the far side of a scrolled street routed to the point
        // under the same screen x on the near side.
        const scrollX = this.target.version === 'Simon2' ? state.read(SCROLL_X_VARIABLE) * 8 : 0;
        const nearest = this.graphics?.nearestRoutePoint?.(
          value(0) + scrollX,
          value(1),
          state.read(ROUTE_VARIABLE),
        );
        if (!nearest) {
          this.unimplemented.add('os1_getPathPosn (no routes have been drawn yet)');
          return true;
        }
        state.write(variable(2), nearest.route);
        state.write(variable(3), nearest.point);
        return true;
      }

      // Elvira 1's tests, which are the same questions Simon asks in fewer
      // words. Sharing the implementations rather than the numbers is the whole
      // point of dispatching by name.
      case 'oe1_isNotAt':
        return state.parentOf(item(0)) !== item(1);
      case 'oe1_sibling':
        return state.parentOf(item(0)) === state.parentOf(item(1));
      case 'oe1_notSibling':
        return state.parentOf(item(0)) !== state.parentOf(item(1));
      case 'oe1_isIn':
        return state.contains(item(1), item(0));
      case 'oe1_isNotIn':
        return !state.contains(item(1), item(0));
      case 'oe1_isPlayer':
        return item(0) === state.me;

      // A container's capacity. `canPut` asks whether an item would fit, which
      // needs both weights — the item's own and everything already inside.
      case 'oe1_canPut':
        return state.wouldFit(item(0), item(1));
      case 'oe1_weigh':
        state.write(variable(1), state.weigh(item(0)));
        return true;

      // User flags: eight numbers a game keeps on an item, which is Elvira's
      // equivalent of Simon's object values.
      case 'oe1_copyof':
        state.write(variable(2), state.userFlag(item(0), value(1)));
        return true;
      case 'oe1_copyfo':
        state.setUserFlag(item(1), value(2), state.read(variable(0)));
        return true;

      case 'oe1_whatO':
        // Finds the item the last click named, which is what turns two words
        // into a thing the rest of the script can act on.
        state.setRegister(
          value(0),
          value(0) === 1
            ? state.findByWords(state.adjective1, state.noun1)
            : state.findByWords(state.adjective2, state.noun2),
        );
        return true;

      // Simon 2 spells three opcodes differently and means the same things.
      case 'os2_rescan':
        state.rescanRequested = true;
        return true;
      // Simon 2 hands `animate` its zone as an explicit operand rather than the
      // hundreds column of a sprite id. `NNBNNN` is zone, sprite, a byte this
      // engine does not use, x, y, palette — and reading only `value(0)` as
      // Simon 1 does took the zone number for a sprite id and started every
      // sprite in zone 0 or thereabouts, so nothing the game animated appeared.
      case 'os2_animate':
        if (this.graphics)
          this.graphics.animate(value(0), value(1), value(3), value(4), value(5) & 15);
        return true;
      // Elvira 1 and Waxworks keep the Simon 1 rule — the zone is the sprite
      // id's hundreds column — and their own operand shapes (NNNNN, NBNNN) are
      // out of scope, so this preserves what they did before `os2_animate` was
      // split out from under them.
      case 'oe1_animate':
        if (this.graphics) this.graphics.animate(Math.floor(value(0) / 100), value(0), 0, 0, 0);
        return true;
      // `NN` is (zone, sprite): stop that sprite in that zone. Wiring it to
      // `unloadedZones` — which this engine never reads — left the sprite
      // running. See Fault 4.
      case 'os2_stopAnimate':
        if (this.graphics) this.graphics.stopAnimate?.(value(0), value(1));
        return true;

      // Doors, which Elvira 2 and Waxworks keep as two bits per exit inside a
      // room's own record — the same mask that sized the exit list. Three
      // states: open, closed, locked.
      case 'oe2_setExitOpen':
      case 'oe2_setDoorOpen':
        state.setDoorState(item(0), value(1), 1);
        return true;
      case 'oe2_setExitClosed':
      case 'oe2_setDoorClosed':
        state.setDoorState(item(0), value(1), 2);
        return true;
      case 'oe2_setExitLocked':
      case 'oe2_setDoorLocked':
        state.setDoorState(item(0), value(1), 3);
        return true;
      case 'oe2_ifExitOpen':
      case 'oe2_ifDoorOpen':
        return state.doorState(item(0), value(1)) === 1;
      case 'oe2_ifExitClosed':
      case 'oe2_ifDoorClosed':
        return state.doorState(item(0), value(1)) === 2;
      case 'oe2_ifExitLocked':
      case 'oe2_ifDoorLocked':
        return state.doorState(item(0), value(1)) === 3;

      case 'oe2_moveDirn': {
        // Walking through an exit: the destination is the room's exit list,
        // indexed by direction. A closed door is not a destination.
        const room = state.parentOf(state.me);
        const destination = state.exitOf(room, value(0));
        if (destination !== 0 && state.doorState(room, value(0)) === 1) {
          state.place(state.me, destination);
        }
        return true;
      }

      // Elvira's clock, which measures against a mark a script sets.
      case 'off_setTime':
      case 'off_restartClock':
      case 'opp_resetGameTime':
      case 'oe1_setTime':
        state.timeMark = state.clock;
        return true;
      case 'off_ifTime':
      case 'oe1_ifTime':
        return state.clock - value(0) >= state.timeMark;

      // Elvira 1's remaining tests and small actions.
      case 'oe1_present':
        return (
          state.parentOf(item(0)) === state.item1 ||
          state.parentOf(item(0)) === state.parentOf(state.me)
        );
      case 'oe1_notPresent':
        return !(
          state.parentOf(item(0)) === state.item1 ||
          state.parentOf(item(0)) === state.parentOf(state.me)
        );
      case 'oe1_worn':
        // Worn means carried *and* flagged worn: an item on the floor with the
        // flag still set is not being worn by anybody.
        return state.parentOf(item(0)) === state.item1 && state.objectFlag(item(0), 8);
      case 'oe1_notWorn':
        return !(state.parentOf(item(0)) === state.item1 && state.objectFlag(item(0), 8));
      case 'oe1_create':
        state.place(item(0), state.parentOf(state.me));
        return true;
      case 'oe1_setFF':
        state.write(variable(0), 255);
        return true;
      case 'oe1_moveDirn': {
        const room = state.parentOf(state.me);
        const direction = state.read(variable(0));
        const destination = state.exitOf(room, direction);
        if (destination !== 0 && state.doorState(room, direction) === 1) {
          state.place(state.me, destination);
        }
        return true;
      }
      case 'oww_whereTo':
      case 'oe1_whereTo':
        state.setRegister(value(2), state.exitOf(item(0), value(1)));
        return true;
      case 'oe1_doorExit':
        state.write(variable(2), state.doorState(item(0), value(1)));
        return true;
      case 'oe1_cFlag': {
        const container = state.items[item(0)]?.children.find(
          (each) => each.type === ITEM_CHILD_TYPES.container,
        );
        return container !== undefined && ((container.values[1] ?? 0) & (1 << value(1))) !== 0;
      }
      case 'oe2_isCalled':
      case 'oe1_isCalled':
        return (state.items[item(0)]?.itemName ?? -1) === itemOrStringId(operands[1]);
      case 'oe1_bitSet':
        state.bits.add(value(0));
        return true;
      case 'oe1_bitClear':
        state.bits.delete(value(0));
        return true;
      case 'oe1_bitTest':
        return state.bits.has(value(0));
      case 'oe1_setUserItem':
        state.setUserFlag(item(0), value(1), value(2));
        return true;
      case 'oe1_getUserItem':
        state.write(variable(2), state.userFlag(item(0), value(1)));
        return true;
      case 'oe1_clearUserItem':
        state.setUserFlag(item(0), value(1), 0);
        return true;

      // Finding the next item matching the words a click was made of, which is
      // how "the red key" picks the second red key when the first is wrong.
      case 'oe1_findMaster':
        state.masterSearch = { adjective: value(1), noun: value(2), from: 0 };
        state.setRegister(value(0), state.findByWords(value(1), value(2)));
        return true;
      case 'oe1_nextMaster': {
        const search = state.masterSearch;
        if (!search) return true;
        const next = state.findByWords(search.adjective, search.noun, item(1) + 1);
        state.masterSearch = { ...search, from: next };
        state.setRegister(value(0), next);
        return true;
      }

      // Simon 2's marks, which are how one script waits for another's
      // animation to reach a point.
      case 'opp_sync':
      case 'os2_clearMarks':
        state.clearMarks();
        return true;
      // **A wait, not a record.** This used to *set* the mark it was named
      // with and carry on, which is backwards: `os2_waitMark` blocks until the
      // drawing bytecode sets the bit. Recording it instead let every wait fall
      // through at once — 106 instructions ran where the scene needed thousands
      // — so a cutscene played its whole length in a single frame. A bit
      // already set satisfies it without suspending, the reference's own
      // short-circuit.
      case 'os2_waitMark':
        if (state.hasMark(value(0))) return true;
        this.pendingWait = {
          kind: 'mark',
          bit: value(0),
          until: state.vgaTicks + this.syncTimeoutTicks,
        };
        return true;
      case 'os2_isShortText':
        return this.stringAt(value(0)) !== undefined;

      // The last of Elvira's, and Feeble's interface odds and ends. Each is a
      // flag or a line of text rather than behaviour, and each is recorded so
      // a stalled game can say the scripts asked for it.
      case 'oe1_stopTune':
        state.musicPlaying = 0;
        return true;
      case 'oe1_enableInput':
        state.inputEnabled = true;
        return true;
      case 'oe1_menu':
      case 'oww_textMenu':
      case 'oe2_menu':
        state.menuOpen = true;
        return true;
      case 'oe1_zoneDisk':
        // Which disk a zone is on, which mattered to a floppy release and does
        // not to a reader that already has every file.
        return true;
      case 'off_hyperLinkOn':
        state.hyperLink = value(0);
        return true;
      case 'off_hyperLinkOff':
        state.hyperLink = 0;
        return true;
      case 'off_oracleTextUp':
      case 'off_oracleTextDown':
      case 'off_listSaveGames':
        // Scrolling a list that nothing draws. Recorded rather than reported,
        // because the script is not asking for behaviour this engine lacks —
        // it is asking to move a view that does not exist yet.
        return true;

      // Elvira's fight and status lines, which are text a person reads. The
      // numbers behind them are the player's own sub-structure, which this
      // engine does not model yet, so they are named gaps rather than lines
      // invented to fill the screen.
      case 'oe1_score':
      case 'oe2_printStats':
      case 'oe2_printPlayerDamage':
      case 'oe2_printMonsterDamage':
      case 'oe2_pObj':
      case 'oe1_printStats':
      case 'oe1_printPlayerDamage':
      case 'oe1_printMonsterDamage':
      case 'oe1_printPlayerHit':
      case 'oe1_printMonsterHit':
      case 'oe1_pName':
      case 'oe1_pcName':
      case 'oe1_pObj':
      case 'oe1_look':
        this.unimplemented.add(`${name} (needs the player's own sub-structure)`);
        return true;

      case 'oe2_doClass':
      case 'oe1_doClass':
        // Runs the rest of the line once per item of a class. Recorded rather
        // than run: doing it wrong would run a line the wrong number of times,
        // which is worse than not running it.
        this.unimplemented.add('oe1_doClass (iteration over a class)');
        return true;

      // Elvira 2's super rooms: a room made of a grid of cells, which is how
      // its mazes are built. The cell a player is in is a coordinate rather
      // than an item, so it is state rather than tree.
      case 'oe2_setSuperRoom':
        state.superRoom = value(0);
        return true;
      case 'oe2_getSuperRoom':
        state.write(variable(0), state.superRoom);
        return true;
      case 'oe2_setSRExit':
        state.setDoorState(item(0), value(1), value(2));
        return true;
      case 'oe2_drawItem':
        if (this.graphics) this.graphics.animate(0, item(0), value(2), value(3), 0);
        return true;

      // Feeble's third bank of bits, and its video and path opcodes.
      case 'off_b3Set':
        state.bits3.add(value(0));
        return true;
      case 'off_b3Clear':
        state.bits3.delete(value(0));
        return true;
      case 'off_b3Zero':
        return !state.bits3.has(value(0));
      case 'off_b3NotZero':
        return state.bits3.has(value(0));
      case 'off_checkCD':
        // Which disc is in the drive, which a reader that already has every
        // file can answer with "the right one" rather than pretending to look.
        return true;
      case 'off_jumpOut':
      case 'off_centerScroll':
      case 'off_resetPVCount':
      case 'off_setPathValues':
      case 'off_checkPaths':
      case 'opp_resetPVCount':
      case 'opp_setPathValues':
      case 'opp_iconifyWindow':
      case 'opp_restoreOopsPosition':
      case 'opp_saveOopsPosition':
      case 'opp_loadMouseImage':
      case 'opp_loadHiScores':
      case 'opp_checkHiScores':
        // AGOS 2's window and path bookkeeping, which needs the parts of the
        // engine it is bookkeeping *for*. Named rather than pretended.
        this.unimplemented.add(`${name} (AGOS 2 window and path handling)`);
        return true;
      // Video, which is played *at* the screen by the Engine rather than
      // composited by the VGA script machine — the distinction `CONTEXT.md`
      // draws for SMUSH against SCI's Robot, arriving in a third family.
      case 'off_loadVideo': {
        const id = itemOrStringId(operands[0]);
        const file = this.stringAt(id);
        if (file === undefined) {
          // A name the string pool does not have is a gap in the reading of the
          // game rather than a missing file, and the two want different fixes.
          this.unimplemented.add(`${name} (no string ${id} to name a video)`);
          return true;
        }
        this.graphics?.loadVideo?.(file);
        return true;
      }
      case 'off_playVideo':
        if (!this.graphics?.playVideo) {
          this.unimplemented.add(`${name} (no screen to play a video at)`);
          return true;
        }
        this.graphics.playVideo();
        return true;

      // Bits, which Elvira 2 onwards uses where Simon uses variables.
      case 'oe2_bSet':
        state.bits.add(value(0));
        return true;
      case 'oe2_bClear':
        state.bits.delete(value(0));
        return true;
      case 'oe2_bZero':
        return !state.bits.has(value(0));
      case 'oe2_bNotZero':
        return state.bits.has(value(0));

      default:
        this.unimplemented.add(name);
        return true;
    }
  }
}
