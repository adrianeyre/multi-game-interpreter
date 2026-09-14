/**
 * Broken Sword II's logic engine: the run list, the levels, and the opcodes.
 *
 * ## The cycle is a run list, not a section walk
 *
 * Sword1 walks all 150 sections every cycle and skips the dead ones. Sword2
 * does something quite different and much simpler: there is a **run list**, a
 * `RUN_LIST` resource holding the ids of the objects that are alive right now,
 * NUL-terminated. A cycle walks it in order and runs each object's logic until
 * that object's script says to stop. Changing room is changing the run list.
 *
 * That is the second structural difference between the families (after the
 * bytecode) and it is why `fnSetSession` exists at all: a room transition in
 * this game is one opcode replacing one resource id.
 *
 * ## Levels and return codes
 *
 * An object has three script levels. A script that ends drops a level; a
 * `fnGosub` pushes one; `IR_TERMINATE` returns without moving the pc, so a new
 * script "kicks in and runs" on the next pass of the inner loop. Level 0
 * terminating is *normal and frequent* — ScummVM says "don't make it a
 * warning" — and resets the pc so the script reruns next cycle.
 *
 * ## What is implemented and what is named
 *
 * All 118 opcodes are present and named. The ones that drive the world —
 * sessions, run lists, sprites, animation, walking, pausing, syncs, variables,
 * speech text, menus, sound, palettes — are implemented. The rest are counted
 * by name and return `IR_CONT`, which is AGOS's precedent and the same
 * arrangement `SwordLogic` uses: a named, counted, continued opcode leaves a
 * game playable with something missing, where an unknown one leaves it stopped.
 */

import {
  OBJECT_GRAPHIC_SIZE,
  OBJECT_LOGIC_SIZE,
  OBJECT_MEGA_SIZE,
  OBJECT_MOUSE_SIZE,
  OBJECT_SPEECH_SIZE,
  RES_HEADER_SIZE,
  Sword2FileType,
  Sword2SpriteType,
  readSword2AnimHeader,
  OBJECT_HUB_SIZE,
  Sword2ObjectHub,
} from '../resource/sword2Headers.js';
import type { Sword2Resources } from '../resource/Sword2Resources.js';
import { IR, type Sword2ScriptError as Sword2ScriptErrorType } from './sword2Tokens.js';
import {
  parseSword2Object,
  runSword2Script,
  type Sword2ObjectLayout,
  type Sword2ScriptHost,
} from './Sword2Interpreter.js';
import { sword2OpcodeName, SWORD2_OPCODE_COUNT } from './opcodeNames.js';
import {
  readSword2WalkData,
  Sword2RouteResult,
  Sword2Router,
  type Sword2WalkData,
} from './Sword2Router.js';
import { Sword2Menu, SWORD2_MENU, SWORD2_NO_CHOICE } from '../Sword2Menu.js';
import {
  SV2,
  SWORD2_CUR_PLAYER_ID,
  SWORD2_PLAYER_SAVE_DATA,
  SWORD2_PLAYER_SAVE_RETURN,
  SWORD2_GLOBAL_VAR_RESOURCE,
  SWORD2_NORMAL_MOUSE_ID,
  SWORD2_SCROLL_LEFT_MOUSE_ID,
  SWORD2_SCROLL_RIGHT_MOUSE_ID,
  sword2ObjectOf,
  sword2ScriptOf,
} from './sword2Vars.js';

void (0 as unknown as Sword2ScriptErrorType);

/** How many sync slots the original carries. */
export const SWORD2_MAX_SYNCS = 10;

/** How many event slots the original carries. `MAX_events`, `logic.h:35`. */
export const SWORD2_MAX_EVENTS = 10;

/**
 * `ObjectMega`'s fields, as byte offsets into the structure.
 *
 * Named here because the *engine* reads them through a script's pointer token,
 * and a bare `peek(token, 32)` in the middle of a walk opcode is unreadable.
 * They are the format: the structure was declared to the game's compiler as
 * well as to its interpreter.
 */
export const MEGA = {
  IS_WALKING: 16,
  WALK_PC: 20,
  SCALE_A: 24,
  SCALE_B: 28,
  FEET_X: 32,
  FEET_Y: 36,
  CUR_DIR: 40,
  MEGASET_RES: 48,
} as const;

/** `ObjectGraphic`'s three fields. */
export const GRAPHIC = { TYPE: 0, ANIM_RESOURCE: 4, ANIM_PC: 8 } as const;

/** `ObjectLogic`'s two. */
export const LOGIC = { LOOPING: 0, PAUSE: 4 } as const;

/**
 * `ObjectSpeech`, all nine fields (`object.h:137-184`).
 *
 * `pen` and `width` are what a line looks like. The other seven are a mailbox:
 * a conversation opcode posts a command through the *globals*, and
 * `fnSpeechProcess` copies it from there into the addressee's own structure, so
 * that the command survives the cycle in which it was sent. `wait_state` is the
 * answer a "get speech state" script reads back — which is why leaving it
 * unwritten deadlocks every `fnTheyDoWeWait` in the game.
 */
export const SPEECH = {
  PEN: 0,
  WIDTH: 4,
  COMMAND: 8,
  INS1: 12,
  INS2: 16,
  INS3: 20,
  INS4: 24,
  INS5: 28,
  WAIT_STATE: 32,
} as const;

/**
 * The commands a speech script can be sent. `function.cpp:1155-1173`.
 *
 * Revolution's own enum, and interpreter knowledge rather than data: nothing in
 * any cluster names these, the scripts just push the numbers. A generator has
 * nothing to read, so ADR 0029 does not reach them.
 */
export const SWORD2_INS = {
  TALK: 1,
  ANIM: 2,
  REVERSE_ANIM: 3,
  WALK: 4,
  TURN: 5,
  FACE: 6,
  TRACE: 7,
  NO_SPRITE: 8,
  SORT: 9,
  FOREGROUND: 10,
  BACKGROUND: 11,
  TABLE_ANIM: 12,
  REVERSE_TABLE_ANIM: 13,
  WALK_TO_ANIM: 14,
  SET_FRAME: 15,
  STAND_AFTER_ANIM: 16,
  QUIT: 42,
} as const;

/** The short name inside this file. */
const INS = SWORD2_INS;

/** How far above a talking sprite its line is kept. `speech.cpp:44`. */
const GAP_ABOVE_HEAD = 20;

/** `MAX_SEQUENCE_TEXT_LINES` (`logic.h`): how many lines a cutscene may carry. */
const MAX_SEQUENCE_TEXT_LINES = 15;

/**
 * Lines that are a sound effect written as speech, and get no sample.
 *
 * "There are some hard-coded cases where speech is used to illustrate a sound
 * effect. In this case there is no sound associated with the speech itself"
 * (`speech.cpp:190`). A ringing telephone, a cat, a slamming trapdoor. Asking
 * the sound driver for a sample that was never recorded makes the line wait for
 * a sample that will not arrive; these count down on the text clock instead.
 *
 * Transcribed rather than generated because it is nine numbers in a `switch`
 * with no table to read — ADR 0029 is about tables a generator can extract, and
 * this is a list of cases with their subtitles as the comments.
 */
const SWORD2_SFX_SPEECH_LINES = new Set([
  528, 920, 923, 926, 1328, 2059, 4082, 4214, 4568, 4913, 5120,
]);

/** Whether a line should try to play a sample at all. `wantSpeechForLine`. */
function wantSpeechForLine(wavId: number): boolean {
  return !SWORD2_SFX_SPEECH_LINES.has(wavId);
}

/** `ObjectMouse`'s six, in the order `ObjectMouse::write` puts them. */
export const MOUSE = {
  X1: 0,
  Y1: 4,
  X2: 8,
  Y2: 12,
  PRIORITY: 16,
  POINTER: 20,
} as const;

/**
 * The floor's priority, which is the lowest the family has.
 *
 * 0 is the highest and 9 the lowest (`mouse.cpp:1146`), and the floor is
 * always 9 so that every object in the room is asked before it
 * (`function.cpp:511`).
 */
const SWORD2_FLOOR_MOUSE_PRIORITY = 9;

/** How wide the scroll-me strips down the edges of the display are. */
const SCROLL_MOUSE_WIDTH = 20;

/** The display, which is not the room. `Screen::getScreenWide`. */
const SWORD2_DISPLAY_WIDTH = 640;

/** What the logic engine needs from the rest of the engine. */
export interface Sword2LogicHost {
  /**
   * Puts this cycle's frame in the draw list, and its shape in the mouse list.
   *
   * `fnRegisterFrame`, which every object's service script calls every cycle —
   * 34,600 times in three thousand frames of the demo. The sprite *type* calls
   * (`fnBackSprite` and its six siblings) do not draw anything: they write a
   * field in the object's own graphic structure, and this is what reads it.
   */
  registerFrame(
    objectId: number,
    mouseOffset: number | null,
    graphicOffset: number,
    megaOffset: number | null,
  ): void;
  /** Registers a mouse-hittable area from an `ObjectMouse` structure. */
  registerMouse(objectId: number, mouseOffset: number | null): void;
  /** Names the line of text shown while the pointer is over the next target. */
  registerPointerText(objectId: number, textId: number): void;
  /** The room's size, which is the background's and not the display's. */
  roomSize(): { width: number; height: number };
  /** Sets the background for a session. `fnInitBackground`. */
  initBackground(resourceId: number, newPalette: boolean): void;
  /** Registers a parallax layer at one of the four depths. */
  registerParallax(resourceId: number, depth: number): void;
  /** Registers a walk grid so the router can use it. */
  registerWalkGrid(resourceId: number, add: boolean): void;
  setPalette(resourceId: number): void;
  fadeUp(rate: number): void;
  fadeDown(rate: number): void;
  /** Plays a sound effect; returns the value the script should see. */
  playFx(resourceId: number, volume: number, pan: number, type: number): number;
  stopFx(slot: number): void;
  playMusic(resourceId: number, looped: boolean): void;
  stopMusic(): void;
  /** Requests a line of speech; true when a sample is actually playing. */
  requestSpeech(textId: number): boolean;
  speechFinished(): boolean;
  /** Cuts the current line short, which is what a click past a subtitle does. */
  stopSpeech(): void;
  /** Whether subtitles are wanted. `Sword2Engine::getSubtitles`. */
  subtitles(): boolean;
  /** Builds a text sprite for a line and returns its block number, or 0. */
  displayText(textId: number, x: number, y: number, width: number, pen: number): number;
  removeText(block: number): void;
  /**
   * A line of speech: the wav id in front of it, and the words.
   *
   * The first two bytes of every text line are a wav id rather than text
   * (`speech.cpp:186`). `fnISpeak` needs both before it has anything else —
   * the id is what the sample is played by when the script did not compile one
   * in, and the length of the words is how long the line stays up when there is
   * no sample at all.
   */
  speechLine(textId: number): { wavId: number; text: string } | null;
  /**
   * Where the first frame of an animation sits, for placing a line above a head.
   *
   * `locateTalker` reads one CDT entry and one frame header to decide whether a
   * talking sprite is a scaled mega (place from its feet) or a fixed anim
   * (place from the frame). Returned through the host because it is a resource
   * read and the logic does not own resources.
   */
  firstFrame(animResource: number): { x: number; y: number; width: number; offset: boolean } | null;
  /** How many frames an animation has, so a talking loop knows where it ends. */
  animFrameCount(animResource: number): number;
  /**
   * Where on the display the camera tries to keep the player's feet.
   *
   * `fnSetScrollCoordinate`. Not the scroll offset: the camera derives that
   * each cycle from this and from where the player actually is.
   */
  setScrollTarget(x: number, y: number): void;
  /** Where the player actually is, in room pixels. `fnUpdatePlayerStats`. */
  setPlayerFeet(x: number, y: number): void;
  /** 16 normal, 32 slow. Larger is slower: it is a divisor. */
  setScrollFraction(fraction: number): void;
  /** How far the view may still scroll, so a scroll mouse area can be sized. */
  maxScroll(): { x: number; y: number };
  /**
   * The scroll the engine is drawing at.
   *
   * Read as well as written because `fnUpdatePlayerStats` is the one opcode
   * that carries a field the other way: three of its four globals go script to
   * engine, and `SCROLL_OFFSET_X` comes back out of the engine so the scripts
   * can place things relative to what is on screen.
   */
  scrollOffset(): { x: number; y: number };
  /**
   * Plays a cutscene. False when this project cannot.
   *
   * A *name*, not a number: Sword2's `fnPlaySequence` takes a pushed string, so
   * the game carries its own filename and this family needs no sequence table.
   */
  playSequence(name: string): boolean;
  /** The game asked to restart, to show its death screen, or that it is over. */
  requestQuit(reason: 'restart' | 'death' | 'credits'): void;
  random(min: number, max: number): number;
  preload(resourceId: number): void;
  /**
   * `fnSetObjectHeld`: a script puts something in the player's hand.
   *
   * Goes out to the host because the part that matters is the *mouse mode*
   * lock — `Mouse::setObjectHeld` sets `_mouseModeLocked` so the inventory
   * cannot be opened while a puzzle holds something for the player
   * (`mouse.cpp:1126-1135`) — and the mode lives in the engine's mouse engine,
   * not here. Optional, so a host with no pointer still runs the opcode.
   */
  setObjectHeld?(resource: number): void;
  /**
   * `fnAddHuman`: the pointer is handed back, so anything dragged is dropped.
   *
   * The same split. `Mouse::addHuman` clears the mode lock and the luggage
   * alongside the globals, and only the host knows about either.
   */
  humanAdded?(): void;
  log?(message: string): void;
}

/** One pending sync: who it is for, and what it says. */
interface Sync {
  id: number;
  sync: number;
}

/**
 * One pending event: an object, and the script it should run when it notices.
 *
 * `EventUnit` (`logic.h`). This is how a click becomes an action in Revolution's
 * engine: the mouse writes `CLICKED_ID` and then *sends the player an event*
 * naming the clicked object's script 2, and the player's own logic — which is
 * looping in `fnPauseForEvent` or `fnCheckForEvent` — picks it up and replaces
 * itself with that script. Without the list the click is recorded and nothing
 * ever reads it, which is exactly what this engine did: the probe could click
 * the floor and George would not move.
 */
interface Sword2Event {
  id: number;
  interactId: number;
}

export class Sword2Logic implements Sword2ScriptHost {
  /** The run list currently being walked. A `RUN_LIST` resource id. */
  private currentRunList = 0;
  /** Where in the run list the cycle is. 0xffffffff ends the session. */
  private pc = 0;
  /** Objects loaded this session, by id, so an offset can be decoded. */
  private readonly objects = new Map<number, Sword2ObjectLayout>();
  /**
   * Each loaded object's bytes as the compiler left them, for a reboot.
   *
   * Taken the first time an object is touched, when its block still holds
   * exactly what the cluster holds — see {@link object} for what a kill does
   * with it.
   */
  private readonly asCompiled = new Map<number, Uint8Array>();
  /** Encoded offsets handed to opcodes, so a pointer survives the stack. */
  private readonly pointers: Array<{ object: Sword2ObjectLayout; at: number }> = [];
  private readonly syncs: Sync[] = [];
  private readonly events: Sword2Event[] = [];
  private readonly kills: number[] = [];

  /** The globals' resource, whose variable block *is* the globals. */
  private globals: Uint8Array | null = null;
  private globalsAt = 0;
  private globalCount = 0;

  /**
   * `_saveLogic`, `_saveGraphic`, `_saveMega` — the player's three structures,
   * copied out by the player's own script rather than read by the engine.
   *
   * Revolution's comment on `fnPassPlayerSaveData` says why the engine cannot
   * simply go and get them: "we cannot simply read a compact any longer but
   * instead must request it from the object itself" (`function.cpp:1997`). An
   * object's variable block is laid out by the *script* that compiled it, so
   * where `ObjectMega` sits inside George is George's business; script 7
   * (`george_savedata_request`) hands the engine three pointers to it, and
   * script 8 (`george_savedata_return`) takes them back.
   *
   * Null until script 7 has run. A copy, not a view: the whole point is that
   * they outlive the object they came from.
   */
  private savedPlayerLogic: Uint8Array | null = null;
  private savedPlayerGraphic: Uint8Array | null = null;
  private savedPlayerMega: Uint8Array | null = null;

  /** Opcode number -> how many times a script called one this project skips. */
  readonly unimplemented = new Map<number, number>();
  readonly faults: string[] = [];
  cycles = 0;

  /** The object whose logic is running, for a fault message. */
  private currentObject = 0;

  /** The walk router. Its own, sharing no code with Sword1's. */
  readonly router: Sword2Router;

  /**
   * The two menu bars: the conversation chooser and the inventory.
   *
   * Owned here rather than by the engine because every one of its entry points
   * is an opcode, and read by the engine because the bars are drawn. See
   * {@link Sword2Menu} for why it is one module and not two.
   */
  readonly menu: Sword2Menu;

  /**
   * The pointer `fnInitFloorMouse` last wrote through, or null before it runs.
   *
   * Kept so the rectangle can be rewritten when the room changes size. See
   * {@link writeFloorMouse} for why that is not the same as writing it once.
   */
  private floorMouse: number | null = null;
  /** The room size the floor's rectangle currently describes. */
  private floorMouseRoom = '';

  /**
   * `fnISpeak`'s state, which lives across cycles because the opcode does.
   *
   * A speech opcode is a loop: it returns `IR_REPEAT` and is re-entered every
   * cycle until the sample ends, the countdown runs out or the player clicks
   * past it. ScummVM keeps all of this on `Logic` (`logic.h:228-247`) for the
   * same reason — the object's own `ob_logic.looping` says *that* it is in a
   * loop, and nothing in the object says which line or how far in.
   */
  private speechAnimId = 0;
  private speechTextBloc = 0;
  private speechTime = 0;
  private speechRunning = false;
  private speechAnimType = 0;
  private officialTextNumber = 0;
  /**
   * "Drop out for 1st cycle to allow walks/anims to end and display last frame
   * before system locks while speech loaded" — `function.cpp:803-808`. Without
   * it a character freezes mid-stride the instant a line starts.
   */
  private speechCycleSkip = false;
  /** Lines queued for the next cutscene. `_sequenceTextList`. */
  private readonly sequenceText: Array<{
    textNumber: number;
    startFrame: number;
    endFrame: number;
  }> = [];
  /**
   * Frames before a click may cut the line short: "left-click past the text
   * after half a second, right-click past it after a quarter"
   * (`function.cpp:876-879`). Two delays, because they are two gestures.
   */
  private leftClickDelay = 0;
  private rightClickDelay = 0;
  /** Where the line is placed, and what its pan is derived from. `locateTalker`. */
  private textX = 0;
  private textY = 0;
  /** The buttons as they were last cycle, so a press is an edge and not a level. */
  private previousButtons = { left: 0, right: 0 };

  constructor(
    private readonly resources: Sword2Resources,
    private readonly host: Sword2LogicHost,
  ) {
    this.router = new Sword2Router(resources);
    this.menu = new Sword2Menu(
      {
        getVar: (number) => this.getVar(number),
        setVar: (number, value) => this.setVar(number, value),
        runResScript: (object, script) => this.runResScript(object, script),
        pointer: () => this.pointerOnDisplay(),
        log: (message) => this.host.log?.(message),
      },
      SV2,
    );
  }

  /**
   * Where the pointer is on the display, and whether it was clicked.
   *
   * `MOUSE_X` and `MOUSE_Y` are room coordinates — the engine writes them with
   * the scroll already added, because that is what every script that hit-tests
   * against an object's rectangle needs. A menu bar is drawn on the display
   * and does not scroll, so the scroll comes back off again here. `LEFT_BUTTON`
   * is already an event: the engine writes it from one cycle's worth of
   * drained button presses, so it is 1 only on the cycle of the click.
   */
  private pointerOnDisplay(): { x: number; y: number; clicked: boolean } {
    const scroll = this.host.scrollOffset();
    return {
      x: this.getVar(SV2.MOUSE_X) - scroll.x,
      y: this.getVar(SV2.MOUSE_Y) - scroll.y,
      clicked: this.getVar(SV2.LEFT_BUTTON) !== 0,
    };
  }

  /**
   * Reads the globals out of resource 1.
   *
   * Refuses by name: without the global variable file there are no globals, and
   * a game running with an all-zero global block would take every wrong branch.
   */
  initialise(): void {
    const resource = this.resources.fetch(SWORD2_GLOBAL_VAR_RESOURCE);
    if (!resource) {
      throw new Error(
        `Broken Sword II keeps its script variables in resource ` +
          `${SWORD2_GLOBAL_VAR_RESOURCE}, and ` +
          `${this.resources.describeMissingResource(SWORD2_GLOBAL_VAR_RESOURCE)} The game ` +
          `cannot start without them.`,
      );
    }
    if (resource.header.fileType !== Sword2FileType.GLOBAL_VAR_FILE) {
      throw new Error(
        `Resource ${SWORD2_GLOBAL_VAR_RESOURCE} is file type ${resource.header.fileType} and ` +
          `should be ${Sword2FileType.GLOBAL_VAR_FILE} (the global variable file). This is not ` +
          `a Broken Sword II install, or its resource.tab does not match its clusters.`,
      );
    }
    // The variable block is the payload, and its length is the count.
    this.globals = resource.bytes;
    this.globalsAt = RES_HEADER_SIZE;
    this.globalCount = Math.floor((resource.bytes.length - RES_HEADER_SIZE) / 4);
    this.host.log?.(
      `${this.globalCount} script variables from resource ${SWORD2_GLOBAL_VAR_RESOURCE}`,
    );
  }

  get variableCount(): number {
    return this.globalCount;
  }

  /** How many lines `fnAddSequenceText` has queued for the next cutscene. */
  get sequenceTextCount(): number {
    return this.sequenceText.length;
  }

  getVar(number: number): number {
    if (!this.globals || number < 0 || number >= this.globalCount) return 0;
    return new DataView(
      this.globals.buffer,
      this.globals.byteOffset,
      this.globals.byteLength,
    ).getInt32(this.globalsAt + number * 4, true);
  }

  setVar(number: number, value: number): void {
    if (!this.globals || number < 0 || number >= this.globalCount) return;
    new DataView(this.globals.buffer, this.globals.byteOffset, this.globals.byteLength).setInt32(
      this.globalsAt + number * 4,
      value | 0,
      true,
    );
  }

  /** The globals as bytes, for a save. */
  snapshotGlobals(): Uint8Array {
    return this.globals ? this.globals.slice(this.globalsAt) : new Uint8Array(0);
  }

  restoreGlobals(bytes: Uint8Array): void {
    if (!this.globals) return;
    if (bytes.length !== this.globalCount * 4) {
      throw new Error(
        `This save holds ${bytes.length} bytes of script variables and this install has ` +
          `${this.globalCount * 4}. It is refused rather than half-applied.`,
      );
    }
    this.globals.set(bytes, this.globalsAt);
  }

  onFault(message: string): void {
    if (this.faults.length < 50 && !this.faults.includes(message)) this.faults.push(message);
  }

  /**
   * Encodes a byte offset inside an object as a number a script can hold.
   *
   * ScummVM's `encodePtr` does the same thing for the same reason: a pointer
   * cannot go on a stack of `int32` and survive a save, so it is a token into a
   * table. The table is per-session and is cleared with the session.
   */
  encodeOffset(object: Sword2ObjectLayout, at: number): number {
    // Tokens start at 1 so that 0 stays "no pointer", which several opcodes
    // test for (`fnRegisterMouse` takes "0 for no write to mouse list").
    this.pointers.push({ object, at });
    return this.pointers.length;
  }

  /** The object and offset a token names, or null. */
  private decode(token: number): { object: Sword2ObjectLayout; at: number } | null {
    if (token <= 0 || token > this.pointers.length) return null;
    return this.pointers[token - 1];
  }

  /**
   * `fnAddHuman`: hands the pointer back to the player.
   *
   * `Mouse::addHuman` (`mouse.cpp:1369`). `MOUSE_AVAILABLE` is the flag the
   * scripts branch on, and `CLICKED_ID` is cleared with it — the original's
   * comment is "clear this to reset no-second-click system", which is what
   * stops a click made while the pointer was away from being acted on the
   * instant it comes back. Whatever the player was dragging is dropped for the
   * same reason — by the host, which owns the mouse mode and the luggage. The
   * cursor work the original does here is not mirrored: this family's pointer
   * is the browser's own cursor and this project renders no sprite for it.
   *
   * Public because the *boot* calls it as well as the opcode: `startGame`
   * ends with `fnAddHuman(nullptr)` (`startup.cpp:174`), so a new game always
   * begins with a mouse even if the last thing the start script did was take
   * it away.
   */
  addHuman(): void {
    this.setVar(SV2.MOUSE_AVAILABLE, 1);
    this.setVar(SV2.CLICKED_ID, 0);
    // The mouse engine, where there is one, owns the rest: it drops the
    // luggage and clears the mode lock in the same breath as `OBJECT_HELD`,
    // and doing it here first would leave it nothing to notice. The fallback
    // is what this did before there was a mouse engine to tell.
    if (this.host.humanAdded) this.host.humanAdded();
    else if (this.getVar(SV2.OBJECT_HELD)) this.setVar(SV2.OBJECT_HELD, 0);
  }

  /**
   * `fnNoHuman`: takes the pointer away.
   *
   * `Mouse::noHuman` calls `hideMouse`, whose one script-visible effect is
   * `MOUSE_AVAILABLE = 0` (`mouse.cpp:1336-1352`). Every cutscene and every
   * conversation in the game starts here.
   */
  noHuman(): void {
    this.setVar(SV2.MOUSE_AVAILABLE, 0);
  }

  /**
   * Reads an `int32` through an encoded pointer.
   *
   * Public because the *engine* needs it too: an opcode hands the logic a
   * token for a graphic or a mouse structure, and the renderer reads the words
   * behind it. Keeping the table in one place and exposing the read is better
   * than a second table in the engine, which is the thing that would drift.
   */
  peek(token: number, field = 0): number {
    const target = this.decode(token);
    if (!target) return 0;
    const bytes = target.object.bytes;
    const at = target.at + field;
    if (at + 4 > bytes.length) return 0;
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(at, true);
  }

  /**
   * Sets a sprite's list, keeping the shading bit that lives above it.
   *
   * `Router::setSpriteStatus`: `type = (type & 0xffff0000) | wanted`. The mask
   * is the point — the low word says which of the seven draw lists the frame
   * goes in and the high word says whether the shading mask applies, and a
   * write that took the whole word would unshade every sprite that moved
   * between lists.
   */
  private setSpriteType(graphicToken: number, type: number): void {
    const was = this.peek(graphicToken, GRAPHIC.TYPE);
    this.poke(graphicToken, GRAPHIC.TYPE, (was & 0xffff0000) | type);
  }

  /** The same write, other half: `Router::setSpriteShading`. */
  private setSpriteShading(graphicToken: number, shaded: boolean): void {
    const was = this.peek(graphicToken, GRAPHIC.TYPE);
    const bit = shaded ? Sword2SpriteType.SHADED_SPRITE : 0;
    this.poke(graphicToken, GRAPHIC.TYPE, (was & 0x0000ffff) | bit);
  }

  /** Writes an `int32` through an encoded pointer. */
  poke(token: number, field: number, value: number): void {
    const target = this.decode(token);
    if (!target) return;
    const bytes = target.object.bytes;
    const at = target.at + field;
    if (at + 4 > bytes.length) return;
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setInt32(at, value | 0, true);
  }

  /** Reads a NUL-terminated string through an encoded pointer. */
  private peekString(token: number): string {
    const target = this.decode(token);
    if (!target) return '';
    const bytes = target.object.bytes;
    let end = target.at;
    while (end < bytes.length && bytes[end] !== 0) end++;
    return new TextDecoder('latin1').decode(bytes.subarray(target.at, end));
  }

  /**
   * Loads an object's layout, and remembers how the compiler left it.
   *
   * The snapshot is what makes a kill mean anything. Scripts write their state
   * — script levels, program counters, local variables — into the object's own
   * block, which is a view onto the resident cluster and is shared by everyone
   * who reads that object, exactly as `_vm->_resman->openResource` hands the
   * same block to every caller. `fnAddToKillList` then exists so an object can
   * ask to be **rebooted** when the session ends: ScummVM's `remove()` frees
   * the block (`logic.cpp:198-199`) and the next `openResource` re-reads it
   * from the CLU, so the object comes back in the state the compiler left it
   * in.
   *
   * There is no re-read here — the cluster was mutated in place, which is what
   * makes the block shared in the first place — so the compiled bytes are kept
   * aside on first use and copied back over the block when the kill runs. A
   * hundred-odd bytes an object is what it costs, and without it Broken Sword
   * II's demo cannot be finished: the dog in screen 12 resumes a loop it should
   * have restarted, holds global 156 at 1, and the fence never opens.
   */
  private object(id: number): Sword2ObjectLayout | null {
    const cached = this.objects.get(id);
    if (cached) return cached;
    const resource = this.resources.fetch(id);
    if (!resource) {
      this.onFault(`object ${id}: ${this.resources.describeMissingResource(id)}`);
      return null;
    }
    try {
      if (!this.asCompiled.has(id)) this.asCompiled.set(id, resource.bytes.slice());
      const layout = parseSword2Object(resource.bytes);
      if (!layout.checksumOk) {
        this.host.log?.(
          `object "${layout.name}" (${id}) has a checksum mismatch, which some releases ship; ` +
            `it is run anyway, as ScummVM runs it`,
        );
      }
      this.objects.set(id, layout);
      return layout;
    } catch (error) {
      this.onFault(
        `object ${id} would not parse: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /** The hub of an object, which holds its script levels. */
  private hub(layout: Sword2ObjectLayout): Sword2ObjectHub {
    return new Sword2ObjectHub(layout.bytes, RES_HEADER_SIZE);
  }

  /**
   * Runs one object's script with another object's structures. `startGame`.
   *
   * ScummVM's `runResObjScript(scriptRes, objRes, offset)`, and the start-up
   * sequence's whole mechanism: `Sword2Engine::startGame` calls it with a
   * **screen manager** for the code and **George** for the data, so the script
   * that opens a section reads and writes the player's own structures while
   * running out of a resource the run list never mentions.
   *
   * Kept here rather than on the engine because both halves have to come out of
   * this object cache: the structures written by the start script are the ones
   * the first session's cycle then reads.
   */
  runObjectScript(scriptResource: number, dataObject: number, script: number): boolean {
    const code = this.object(scriptResource);
    const data = this.object(dataObject);
    if (!code || !data) return false;
    this.currentObject = dataObject;
    this.setVar(SV2.ID, dataObject);
    runSword2Script(code, this, script, data);
    return true;
  }

  /** Sets the run list, which is how this game changes room. */
  setSession(runList: number): void {
    this.currentRunList = runList;
    this.pc = 0;
    // Pointers are per-session: an offset into an object the new session does
    // not load would otherwise stay valid and read the wrong bytes.
    this.pointers.length = 0;
  }

  get session(): number {
    return this.currentRunList;
  }

  /**
   * One session's worth of logic: walk the run list, run each object.
   *
   * Returns false when the session ended naturally (the list ran out) and true
   * when it was cut short — which is what `fnEndSession` and a room change do.
   */
  /**
   * Writes the floor's rectangle, and rewrites it whenever the room resizes.
   *
   * `fnInitFloorMouse` fills the structure with `0, 0, screen_wide - 1,
   * screen_deep - 1` (`function.cpp:508-511`), and `screen_wide` is the
   * *background layer's* width — "Size of background layer", `screen.h:142` —
   * not the display's. ScummVM reads resources synchronously, so by the time
   * any floor script runs the background has been read and that size is the
   * room's.
   *
   * Here clusters arrive asynchronously. The demo's screen manager asks for
   * screen 22, which is in the 20 MB `Docks.clu`, and the floor's script runs
   * while that load is still in flight — so the room is still the fallback
   * 640x480 and the floor is written 639 by 479. The floor's script then parks
   * in `fnPauseForEvent` and `fnInitFloorMouse` is never reached again: one
   * call in 3000 frames. The room becomes 960x597 a cycle later and the floor
   * does not follow.
   *
   * What that costs is the whole right and bottom of every room. George starts
   * at 750,500 — outside his own floor — so a click near him reached no
   * target at all and the walk it should have asked for was never attempted.
   * There was no error anywhere: clicks simply did nothing.
   *
   * So the rectangle is re-derived each cycle from the room rather than
   * captured once from whatever the room happened to be. Guarded on the size
   * actually changing, because this runs every cycle and the common case is
   * that nothing has moved.
   */
  /**
   * `fnSetScrollLeftMouse` / `fnSetScrollRightMouse`: the edge strips.
   *
   * A band 20 pixels wide down the left or right of the *display*, at priority
   * 0 — the highest there is, so it beats anything under it
   * (`function.cpp:1805-1859`). The pointer is zeroed when the view cannot
   * scroll that way any further, and a mouse structure with no pointer is not
   * registered at all (`mouse.cpp:163`), so the arrow disappears at the end of
   * the room without the script having to ask.
   *
   * The rectangle is in *room* coordinates, which is why it is written from
   * the scroll offset: the band stays under the same part of the display as
   * the room moves beneath it.
   */
  private scrollMouse(token: number, right: boolean): void {
    const room = this.host.roomSize();
    const scroll = this.host.scrollOffset();
    const max = this.host.maxScroll();
    this.poke(token, MOUSE.X1, right ? scroll.x + SWORD2_DISPLAY_WIDTH - SCROLL_MOUSE_WIDTH : 0);
    this.poke(token, MOUSE.Y1, 0);
    this.poke(token, MOUSE.X2, right ? room.width - 1 : scroll.x + SCROLL_MOUSE_WIDTH);
    this.poke(token, MOUSE.Y2, room.height - 1);
    this.poke(token, MOUSE.PRIORITY, 0);
    const canScroll = right ? scroll.x < max.x : scroll.x > 0;
    this.poke(
      token,
      MOUSE.POINTER,
      canScroll ? (right ? SWORD2_SCROLL_RIGHT_MOUSE_ID : SWORD2_SCROLL_LEFT_MOUSE_ID) : 0,
    );
  }

  private writeFloorMouse(): void {
    if (this.floorMouse === null) return;
    const room = this.host.roomSize();
    const key = `${room.width}x${room.height}`;
    if (key === this.floorMouseRoom) return;
    this.floorMouseRoom = key;
    this.poke(this.floorMouse, MOUSE.X1, 0);
    this.poke(this.floorMouse, MOUSE.Y1, 0);
    this.poke(this.floorMouse, MOUSE.X2, room.width - 1);
    this.poke(this.floorMouse, MOUSE.Y2, room.height - 1);
    // The floor is always the lowest priority there is.
    this.poke(this.floorMouse, MOUSE.PRIORITY, SWORD2_FLOOR_MOUSE_PRIORITY);
    this.poke(this.floorMouse, MOUSE.POINTER, SWORD2_NORMAL_MOUSE_ID);
  }

  processSession(): boolean {
    this.cycles++;
    this.writeFloorMouse();
    const runList = this.currentRunList;
    if (!runList) return false;
    this.pc = 0;

    for (;;) {
      if (this.pc === 0xffffffff) break;
      const list = this.resources.fetch(runList);
      if (!list) {
        // Not resident *yet* is not a fault. `fetch` has already put the id on
        // the wanted list and the engine drains that every step, so the next
        // cycle finds it — which is what the boot cycle of the mounted demo
        // does, and it filed "run list 20 is in Docks.clu, which is not
        // resident yet" against a game that then ran for the rest of the
        // session. `faults` is a list nothing clears, so one early frame left a
        // permanent entry on the status line describing nothing.
        if (!this.resources.willBecomeResident(runList)) {
          this.onFault(`run list ${runList}: ${this.resources.describeMissingResource(runList)}`);
        }
        return false;
      }
      const view = new DataView(list.bytes.buffer, list.bytes.byteOffset, list.bytes.byteLength);
      const at = RES_HEADER_SIZE + 4 * this.pc;
      if (at + 4 > list.bytes.length) break;
      const id = view.getUint32(at, true);
      this.pc++;
      this.setVar(SV2.ID, id);
      // A zero ends the list, which is how a session finishes naturally.
      if (!id) break;

      const layout = this.object(id);
      if (!layout) continue;
      this.currentObject = id;
      this.runObject(id, layout);

      // Syncs are consumed by the object they were sent to: it has used them or
      // now loses them. Clearing here rather than where they are read is what
      // makes `fnSendSync` fire-and-forget.
      this.clearSyncs(id);

      if (this.pc !== 0xffffffff) {
        // The graphics/mouse service script, script 0, runs every cycle for
        // every object — it is what re-registers a sprite and a mouse area, so
        // the draw lists are rebuilt from scratch each cycle.
        runSword2Script(layout, this, 0);
      }
    }

    /*
     * The reboot: the block goes back to what the compiler wrote, so the object
     * starts its scripts from the top the next time the session reaches it.
     *
     * Only when the room is being left, which is what `this.pc` says. ScummVM
     * puts this loop after its `while (_pc != 0xffffffff)` under the comment
     * "Leaving a room so remove all ids that must reboot correctly"
     * (`logic.cpp:195-201`); a run list that ends *naturally* — the zero that
     * terminates it — takes the `return 0` above it and never reaches the
     * loop, so the kill list is carried across cycles and spent on the way
     * out. Draining it every cycle instead reboots objects in the room a
     * player is standing in: the window George shouts up at in Broken Sword
     * II's demo went back to its compiled script between the click and the
     * chooser, and the conversation offered nothing.
     */
    if (this.pc === 0xffffffff) {
      for (const id of this.kills) {
        const layout = this.objects.get(id);
        const compiled = this.asCompiled.get(id);
        if (layout && compiled && layout.bytes.length === compiled.length) {
          layout.bytes.set(compiled);
        }
        this.objects.delete(id);
      }
      this.kills.length = 0;
    }
    return this.pc === 0xffffffff;
  }

  /** Runs one object's levels until a script says to stop. */
  private runObject(id: number, layout: Sword2ObjectLayout): void {
    const hub = this.hub(layout);
    for (let guard = 0; guard < 64; guard++) {
      const level = hub.logicLevel;
      const scriptId = hub.scriptId(level);
      const owner = sword2ObjectOf(scriptId);

      let result: number;
      if (owner === id) {
        const run = runSword2Script(layout, this, hub.scriptPc(level));
        if (!run.holdOffset) hub.setScriptPc(level, run.offset);
        result = run.result;
      } else {
        // Another object's script, with our own structures. Both halves are
        // needed and they come from different resources (see the interpreter).
        const scriptLayout = this.object(owner);
        if (!scriptLayout) return;
        const run = runSword2Script(scriptLayout, this, hub.scriptPc(level), layout);
        if (!run.holdOffset) hub.setScriptPc(level, run.offset);
        result = run.result;
      }

      if (result === IR.CONT) {
        const current = hub.logicLevel;
        if (current) {
          hub.logicLevel = current - 1;
        } else {
          // Level 0 terminating happens a lot and is not a warning: the script
          // is reset to rerun and the object drops out for a cycle.
          hub.setScriptPc(current, hub.scriptId(current) & 0xffff);
          return;
        }
        continue;
      }
      if (result === IR.STOP) return;
      // IR_TERMINATE: go round again, so a new script or subroutine runs.
      if (result === IR.TERMINATE) continue;
      return;
    }
    this.onFault(`object ${id} ran 64 script levels in one cycle without settling`);
  }

  /** `logicUp` — push a level and start a script there. `fnGosub`. */
  private logicUp(scriptId: number): void {
    const layout = this.objects.get(this.getVar(SV2.ID));
    if (!layout) return;
    const hub = this.hub(layout);
    const level = hub.logicLevel + 1;
    if (level >= 3) {
      this.onFault(`object ${this.getVar(SV2.ID)} exceeded its three script levels in fnGosub`);
      return;
    }
    hub.logicLevel = level;
    hub.setScriptId(level, scriptId);
    hub.setScriptPc(level, sword2ScriptOf(scriptId));
  }

  /** `logicReplace` — replace this level's script. `fnNewScript`. */
  private logicReplace(scriptId: number): void {
    const layout = this.objects.get(this.getVar(SV2.ID));
    if (!layout) return;
    const hub = this.hub(layout);
    const level = hub.logicLevel;
    hub.setScriptId(level, scriptId);
    hub.setScriptPc(level, sword2ScriptOf(scriptId));
  }

  /**
   * `logicOne` — force this object to level 1 and run `scriptId` there.
   *
   * What an event does when it is taken: the object abandons whatever it was
   * looping on and becomes the interaction. `logicUp` would stack a return
   * address the interaction never uses.
   */
  private logicOne(scriptId: number): void {
    const layout = this.objects.get(this.getVar(SV2.ID));
    if (!layout) return;
    const hub = this.hub(layout);
    hub.logicLevel = 1;
    hub.setScriptId(1, scriptId);
    hub.setScriptPc(1, sword2ScriptOf(scriptId));
  }

  /**
   * Queues an interaction for an object. `Logic::sendEvent`.
   *
   * One slot per object: a second event for an id that already has one
   * *replaces* it, which is the original's `if (id == _eventList[i].id || !_eventList[i].id)`
   * and is what stops a held-down button from filling the list.
   */
  sendEvent(id: number, interactId: number): void {
    const existing = this.events.find((candidate) => candidate.id === id);
    if (existing) {
      existing.interactId = interactId;
      return;
    }
    if (this.events.length >= SWORD2_MAX_EVENTS) {
      // ScummVM calls `error()` here and stops the game. A fault says the same
      // thing without taking the session down, which is what every other
      // overflow in this engine does.
      this.onFault(
        `the ${SWORD2_MAX_EVENTS} event slots are full, so an event to ${id} was dropped`,
      );
      return;
    }
    this.events.push({ id, interactId });
  }

  /**
   * `setPlayerActionEvent` — the click, as the mouse engine sends it.
   *
   * `sendEvent(id, (interact_id << 16) | 2)` (`events.cpp:46-49`): script 2 of
   * the thing clicked, run by the player. Every interaction in the game is this
   * one line.
   */
  setPlayerActionEvent(id: number, interactId: number): void {
    this.sendEvent(id, ((interactId << 16) | 2) >>> 0);
  }

  /** Whether an event is waiting for the object whose logic is running. */
  private checkEventWaiting(): boolean {
    return this.events.some((candidate) => candidate.id === this.getVar(SV2.ID));
  }

  /** Takes the waiting event and becomes it. Must be followed by TERMINATE. */
  private startEvent(): void {
    const id = this.getVar(SV2.ID);
    const at = this.events.findIndex((candidate) => candidate.id === id);
    if (at < 0) {
      this.onFault(`object ${id} started an event that was not waiting for it`);
      return;
    }
    const [event] = this.events.splice(at, 1);
    this.logicOne(event.interactId);
  }

  private clearEvent(id: number): void {
    const at = this.events.findIndex((candidate) => candidate.id === id);
    if (at >= 0) this.events.splice(at, 1);
  }

  private sendSync(id: number, sync: number): void {
    const existing = this.syncs.find((candidate) => candidate.id === id);
    if (existing) {
      existing.sync = sync;
      return;
    }
    if (this.syncs.length >= SWORD2_MAX_SYNCS) {
      this.onFault(`the ${SWORD2_MAX_SYNCS} sync slots are full, so a sync to ${id} was dropped`);
      return;
    }
    this.syncs.push({ id, sync });
  }

  private getSync(): Sync | null {
    const id = this.getVar(SV2.ID);
    return this.syncs.find((candidate) => candidate.id === id) ?? null;
  }

  private clearSyncs(id: number): void {
    for (let at = this.syncs.length - 1; at >= 0; at--) {
      if (this.syncs[at].id === id) this.syncs.splice(at, 1);
    }
  }

  /**
   * `fnISpeak`: says a line — the subtitle, the sample and the talking head.
   *
   * The biggest single opcode in the family and the one whose absence was most
   * visible: recorded speech played and **no line ever appeared on screen**,
   * because nothing here built a text sprite. It is a loop, re-entered every
   * cycle until the line ends, and it is `ob_logic.looping` that says which
   * half of it to run.
   *
   * ## The nine parameters
   *
   * `0` ob_graphic, `1` ob_speech, `2` ob_logic, `3` ob_mega, `4` the encoded
   * text number, `5` the wav id, `6` an anim resource, `7` a direction table,
   * `8` the animation mode. Six and seven are alternatives: a straight anim, or
   * a table the mega's current direction indexes for one.
   *
   * ## Why the first cycle does nothing
   *
   * The `speechCycleSkip` dance is Revolution's, and it is not a workaround for
   * slow loading here: it is what lets the walk or animation that was running
   * when the line started put its last frame on screen. Removing it freezes a
   * character mid-stride.
   *
   * ## What this does not do
   *
   * `SYSTEM_TESTING_TEXT`'s branch — the text-and-speech test harness in
   * George's own scripts — is not implemented, and neither is the focus
   * rectangle, which is an accessibility hint to the backend rather than
   * anything the game draws.
   */
  private iSpeak(params: Int32Array): number {
    const graphicToken = params[0];
    const speechToken = params[1];
    const logicToken = params[2];
    const megaToken = params[3];
    const textId = params[4];

    if (this.peek(logicToken, LOGIC.LOOPING) === 0) {
      // "New fudge to wait for smacker samples to finish since they can
      // over-run into the game."
      //
      // `&& this.speechRunning` is this project's and not ScummVM's. Speech
      // here is fetched asynchronously, so `requestSpeech` answers "not
      // playing" and the sample arrives some cycles later; without the second
      // half of the test the *next* line would wait on a sample this loop
      // never claimed, and the conversation would stop at its second line.
      if (!this.host.speechFinished() && this.speechRunning) return IR.REPEAT;

      // "New fudge for 'fx' subtitles: If subtitles switched off, and we don't
      // want to use a wav for this line either, then just quit back to script
      // right now!" — an fx line with no subtitles is silence and no sprite, so
      // there is nothing for the loop to wait for.
      if (!this.host.subtitles() && !wantSpeechForLine(params[5])) return IR.CONT;

      if (!this.speechCycleSkip) {
        this.speechCycleSkip = true;
        return IR.REPEAT;
      }
      this.speechCycleSkip = false;

      // The first two bytes of a text line are a wav id. It is the number the
      // sample is played by when the script did not compile one in.
      const line = this.host.speechLine(textId);
      this.officialTextNumber = line?.wavId ?? 0;

      this.poke(logicToken, LOGIC.LOOPING, 1);
      this.leftClickDelay = 6;
      this.rightClickDelay = 3;

      // Which animation the talker plays, if any. Six wins over seven.
      if (params[6]) {
        this.speechAnimId = params[6];
      } else if (params[7]) {
        // A direction table: four bytes per direction, indexed by the mega's.
        // "NB. ASSUMES WE HAVE A MEGA OBJECT!!"
        const direction = megaToken ? this.peek(megaToken, MEGA.CUR_DIR) : 0;
        this.speechAnimId = this.peek(params[7], direction * 4);
      } else {
        this.speechAnimId = 0;
      }

      if (this.speechAnimId) {
        this.speechAnimType = this.getVar(SV2.SPEECHANIMFLAG);
        this.poke(graphicToken, GRAPHIC.ANIM_RESOURCE, this.speechAnimId);
        this.poke(graphicToken, GRAPHIC.ANIM_PC, 0);
      }
      // Default back to looped lip-synced anims.
      this.setVar(SV2.SPEECHANIMFLAG, 0);

      this.locateTalker(megaToken);

      this.speechRunning = false;
      const wavId = params[5] || this.officialTextNumber;
      if (wantSpeechForLine(this.officialTextNumber)) {
        this.speechRunning = this.host.requestSpeech(wavId);
      }

      if (this.host.subtitles() || !this.speechRunning) {
        this.formText(textId, speechToken, line?.text.length ?? 0);
      }
    }

    // EVERY CYCLE: one frame of the talking animation.
    if (this.speechAnimId) {
      const pc = this.peek(graphicToken, GRAPHIC.ANIM_PC) + 1;
      this.poke(graphicToken, GRAPHIC.ANIM_PC, pc);
      const frames = this.host.animFrameCount(this.peek(graphicToken, GRAPHIC.ANIM_RESOURCE));
      if (!this.speechAnimType) {
        // Lip-synced and repeating: back to frame 0 at the end. ScummVM also
        // returns to 0 during a quiet passage of the sample, which needs the
        // mixer to report amplitude; this project does not ask for that, so a
        // mouth that should rest stays in the cycle instead of closing.
        if (frames > 0 && pc >= frames) this.poke(graphicToken, GRAPHIC.ANIM_PC, 0);
      } else if (frames > 0 && pc >= frames - 1) {
        // Play once, then hold the last frame.
        this.speechAnimId = 0;
      }
    } else if (this.speechAnimType) {
      // Placed here so the last frame of a play-once anim is actually shown.
      this.speechAnimType = 0;
    }

    // EVERY CYCLE: has the line ended?
    let finished = false;
    if (this.speechRunning) {
      if (this.host.speechFinished()) finished = true;
    } else if (this.speechTime > 0) {
      // No sample, so the length of the line is the clock.
      this.speechTime--;
      if (this.speechTime === 0) finished = true;
    }

    if (this.leftClickDelay > 0) this.leftClickDelay--;
    if (this.rightClickDelay > 0) this.rightClickDelay--;

    // A click past the text, once its delay has expired. Edge-triggered: the
    // globals carry the button's *level*, so without remembering last cycle a
    // held button would end every line in the conversation at once.
    const left = this.getVar(SV2.LEFT_BUTTON);
    const right = this.getVar(SV2.RIGHT_BUTTON);
    const leftPressed = left !== 0 && this.previousButtons.left === 0;
    const rightPressed = right !== 0 && this.previousButtons.right === 0;
    this.previousButtons = { left, right };
    if (
      (this.leftClickDelay === 0 && leftPressed) ||
      (this.rightClickDelay === 0 && rightPressed)
    ) {
      finished = true;
      if (this.speechRunning) this.host.stopSpeech();
    }

    // `!speechAnimType`, so a play-once anim is allowed to finish first.
    if (finished && !this.speechAnimType) {
      if (this.speechTextBloc) {
        this.host.removeText(this.speechTextBloc);
        this.speechTextBloc = 0;
      }
      if (this.speechAnimId) {
        this.speechAnimId = 0;
        this.poke(graphicToken, GRAPHIC.ANIM_PC, 0);
      }
      this.speechRunning = false;
      this.poke(logicToken, LOGIC.LOOPING, 0);
      this.officialTextNumber = 0;
      return IR.CONT;
    }

    return IR.REPEAT;
  }

  /**
   * Sets `textX`/`textY` for the line. `locateTalker` (`speech.cpp:63`).
   *
   * Three cases. No animation means voice-over, which goes at the bottom
   * centre. A scalable mega frame is placed from the *feet* plus the frame's
   * scaled y-offset, because the sprite's own coordinates mean nothing once it
   * is scaled. Anything else is placed from the frame itself.
   *
   * The subtraction of the scroll offset at the end is what makes the result a
   * display coordinate, which is what a text bloc needs.
   */
  private locateTalker(megaToken: number): void {
    if (!this.speechAnimId) {
      this.textX = 320;
      this.textY = 400;
      return;
    }

    const frame = this.host.firstFrame(this.speechAnimId);
    if (!frame) {
      // The animation is on a disc this install does not ship. Voice-over
      // placement rather than 0,0, which would put the line in the corner.
      this.textX = 320;
      this.textY = 400;
      return;
    }

    if (frame.offset && megaToken) {
      const feetY = this.peek(megaToken, MEGA.FEET_Y);
      const scale = Math.trunc(
        (this.peek(megaToken, MEGA.SCALE_A) * feetY + this.peek(megaToken, MEGA.SCALE_B)) / 256,
      );
      this.textX = this.peek(megaToken, MEGA.FEET_X);
      this.textY = feetY + Math.trunc((frame.y * scale) / 256);
    } else {
      this.textX = frame.x + Math.trunc(frame.width / 2);
      this.textY = frame.y;
    }

    this.textY -= GAP_ABOVE_HEAD;

    const scroll = this.host.scrollOffset();
    this.textX -= scroll.x;
    this.textY -= scroll.y;
  }

  /**
   * Builds the line's sprite and sets how long it stays up. `formText`.
   *
   * The duration is `strlen(text) + 30` cycles and only matters when no sample
   * is playing — with one, the sample's end is what ends the line.
   */
  private formText(textId: number, speechToken: number, length: number): void {
    if (!textId) {
      // "There should always be a text line, as all text is derived from it.
      // If there is none, that's bad..."
      this.host.log?.('a speech command carried no text line, so nothing was shown');
      return;
    }
    const pen = speechToken ? this.peek(speechToken, SPEECH.PEN) : 0;
    const width = speechToken ? this.peek(speechToken, SPEECH.WIDTH) : 0;
    this.speechTextBloc = this.host.displayText(textId, this.textX, this.textY, width, pen);
    this.speechTime = length + 30;
  }

  /**
   * Runs another object's script with that object's own structures.
   *
   * `runResScript` (`interpreter.cpp:205`). The conversation opcodes all begin
   * by running the *target's* script 5 — its "get speech state" — which writes
   * `RESULT`: 1 for waiting, 0 for busy. Note that this is the plain form and
   * not `runResObjScript`: both halves come from the target, because the
   * question being asked is about the target and not about the asker.
   */
  private runResScript(target: number, script: number): void {
    const layout = this.object(target);
    if (!layout) return;
    runSword2Script(layout, this, script);
  }

  /**
   * `fnWeWait`: hold until the target is not busy.
   *
   * The simplest of the three, and the one that shows the shape: ask, and
   * repeat the same opcode next cycle until the answer changes. A script
   * blocked here is not stalled — it is a conversation waiting its turn.
   */
  private weWait(target: number): number {
    this.runResScript(target, 5);
    return this.getVar(SV2.RESULT) === 0 ? IR.REPEAT : IR.CONT;
  }

  /**
   * `fnTheyDoWeWait`: send the target a command and wait for it to finish.
   *
   * Three states in one opcode, distinguished by `ob_logic.looping` on the
   * *caller* — which is how it remembers, between cycles, whether it has sent
   * the command yet:
   *
   * - not looping, target waiting, no command queued: send it, start looping;
   * - not looping: the target was busy, so keep asking;
   * - looping and the target waiting again: it has finished. Stop.
   *
   * The instruction slots are seven script variables rather than a message
   * queue. That is the whole conversation mechanism in this family: one object
   * writes `SPEECH_ID` and `INS_COMMAND`, and the other's speech script — which
   * is looping in its own `fnAnimate`-shaped wait — picks them up.
   */
  private theyDoWeWait(params: Int32Array): number {
    const logicToken = params[0];
    const target = params[1];
    this.runResScript(target, 5);

    const looping = this.peek(logicToken, LOGIC.LOOPING);
    if (this.getVar(SV2.RESULT) === 1 && this.getVar(SV2.INS_COMMAND) === 0 && looping === 0) {
      this.poke(logicToken, LOGIC.LOOPING, 1);
      this.sendInstruction(target, params, 2);
      return IR.REPEAT;
    }
    if (looping === 0) return IR.REPEAT;
    if (this.getVar(SV2.RESULT) === 0) return IR.REPEAT;

    this.poke(logicToken, LOGIC.LOOPING, 0);
    return IR.CONT;
  }

  /** `fnTheyDo`: send the command and carry on without waiting. */
  private theyDo(params: Int32Array): number {
    const target = params[0];
    this.runResScript(target, 5);
    if (this.getVar(SV2.RESULT) === 1 && this.getVar(SV2.INS_COMMAND) === 0) {
      this.sendInstruction(target, params, 1);
      return IR.CONT;
    }
    return IR.REPEAT;
  }

  /** The seven variables a command is posted through. */
  private sendInstruction(target: number, params: Int32Array, at: number): void {
    this.setVar(SV2.SPEECH_ID, target);
    this.setVar(SV2.INS_COMMAND, params[at] ?? 0);
    this.setVar(SV2.INS1, params[at + 1] ?? 0);
    this.setVar(SV2.INS2, params[at + 2] ?? 0);
    this.setVar(SV2.INS3, params[at + 3] ?? 0);
    this.setVar(SV2.INS4, params[at + 4] ?? 0);
    this.setVar(SV2.INS5, params[at + 5] ?? 0);
  }

  /**
   * `fnAddSequenceText`: a subtitle to show over frames of a cutscene.
   *
   * Guarded on `DEMO` in the game's own code, and that guard is the whole
   * story on this install: the demo sets the variable, so all eight calls the
   * scripts reach are a *legitimate* no-op rather than something missing. They
   * were being counted as unimplemented, which said the demo was short of
   * something it is not.
   *
   * Off the demo the line is recorded. Nothing draws it yet — the sequence
   * player here cannot play the films this folder does not ship — so the list
   * is kept and reported rather than pretended about.
   */
  private addSequenceText(params: Int32Array): number {
    if (this.getVar(SV2.DEMO)) return IR.CONT;
    if (this.sequenceText.length < MAX_SEQUENCE_TEXT_LINES) {
      this.sequenceText.push({
        textNumber: params[0],
        startFrame: params[1],
        endFrame: params[2],
      });
    }
    return IR.CONT;
  }

  /**
   * `fnSpeechProcess`: the receiving half of a conversation.
   *
   * `fnTheyDo` and `fnTheyDoWeWait` post a command through seven globals and
   * then ask, over and over, whether the addressee is free yet. *This* is what
   * answers. A character who is in a conversation runs this opcode forever —
   * sacco's script 1 is literally `fnSpeechProcess` followed by an unconditional
   * jump back to a `CP_QUIT` — and each cycle it either carries on with the
   * command it has or takes delivery of a new one.
   *
   * Two things about it are easy to get wrong and both are fatal:
   *
   * - it writes `ob_speech.wait_state`, and *that* is what the target's "get
   *   speech state" script (script 5) copies into `RESULT`. Without the write
   *   the target is permanently busy, so `fnTheyDoWeWait` never returns and the
   *   conversation stops on its first line. This project had `fnSpeechProcess`
   *   stubbed as "repeat until the sample ends", which answered a different
   *   question and left the mailbox empty;
   * - the command is *copied out of the globals into the structure*
   *   (`function.cpp:1376-1391`), because the sender only holds `SPEECH_ID` for
   *   the one cycle in which it matches this object's `ID`.
   *
   * ScummVM's `while (1)` runs at most twice — once to take delivery, once to
   * start the command — which is what the two passes below are.
   */
  private speechProcess(params: Int32Array, object: Sword2ObjectLayout): number {
    const speechToken = params[1];
    for (let pass = 0; pass < 2; pass++) {
      const command = this.peek(speechToken, SPEECH.COMMAND);
      if (command === INS.QUIT) {
        // "That's it - we're finished with this." `wait_state` is deliberately
        // left alone here; ScummVM's write of it is commented out.
        this.poke(speechToken, SPEECH.COMMAND, 0);
        return IR.CONT;
      }
      if (command !== 0) {
        if (this.runInstruction(command, params, speechToken, object)) {
          this.poke(speechToken, SPEECH.COMMAND, 0);
          this.poke(speechToken, SPEECH.WAIT_STATE, 1);
        }
        return IR.REPEAT;
      }
      if (this.getVar(SV2.SPEECH_ID) !== this.getVar(SV2.ID)) {
        // "No new command. We could run a blink anim (or something) here."
        this.poke(speechToken, SPEECH.WAIT_STATE, 1);
        return IR.REPEAT;
      }

      this.setVar(SV2.SPEECH_ID, 0);
      this.poke(speechToken, SPEECH.COMMAND, this.getVar(SV2.INS_COMMAND));
      this.poke(speechToken, SPEECH.INS1, this.getVar(SV2.INS1));
      this.poke(speechToken, SPEECH.INS2, this.getVar(SV2.INS2));
      this.poke(speechToken, SPEECH.INS3, this.getVar(SV2.INS3));
      this.poke(speechToken, SPEECH.INS4, this.getVar(SV2.INS4));
      this.poke(speechToken, SPEECH.INS5, this.getVar(SV2.INS5));
      this.poke(speechToken, SPEECH.WAIT_STATE, 0);
      this.setVar(SV2.INS_COMMAND, 0);
    }
    return IR.REPEAT;
  }

  /**
   * Runs one speech command, and answers whether it finished this cycle.
   *
   * Every arm is a re-ordering of the same four structure pointers into the
   * argument list some other opcode already wants, so the commands go back
   * through `callMcode` rather than into private methods: a command this
   * project has not implemented then lands in the unimplemented report by the
   * ordinary route, named, instead of failing silently inside the conversation.
   *
   * The six that ignore their opcode's answer — the sprite-order four,
   * `set_frame` and `stand_after_anim` — ignore it in ScummVM too
   * (`function.cpp:1300-1358`); they are single-cycle by construction.
   */
  private runInstruction(
    command: number,
    params: Int32Array,
    speech: number,
    object: Sword2ObjectLayout,
  ): boolean {
    const graphic = params[0];
    const logic = params[2];
    const mega = params[3] ?? 0;
    // sacco_12 calls `fnSpeechProcess` with four arguments and not five: a
    // character who never walks has no walkdata to pass.
    const walkdata = params[4] ?? 0;
    const ins = (slot: number): number => this.peek(speech, slot);
    const run = (number: number, args: readonly number[]): boolean =>
      this.callMcode(number, Int32Array.from(args), object) !== IR.REPEAT;
    const always = (number: number, args: readonly number[]): boolean => {
      run(number, args);
      return true;
    };

    switch (command) {
      case INS.TALK:
        return run(44, [
          graphic,
          speech,
          logic,
          mega,
          ins(SPEECH.INS1), // encoded text number
          ins(SPEECH.INS2), // wav resource
          ins(SPEECH.INS3), // anim resource
          ins(SPEECH.INS4), // anim table resource
          ins(SPEECH.INS5), // 0 lip-synced, 1 straight
        ]);
      case INS.ANIM:
        return run(9, [logic, graphic, ins(SPEECH.INS1)]); // fnAnim
      case INS.REVERSE_ANIM:
        return run(64, [logic, graphic, ins(SPEECH.INS1)]); // fnReverseAnim
      case INS.WALK:
        return run(15, [
          logic,
          graphic,
          mega,
          walkdata,
          ins(SPEECH.INS1),
          ins(SPEECH.INS2),
          ins(SPEECH.INS3),
        ]); // fnWalk
      case INS.TURN:
        return run(17, [logic, graphic, mega, walkdata, ins(SPEECH.INS1)]); // fnTurn
      case INS.FACE:
        return run(87, [logic, graphic, mega, walkdata, ins(SPEECH.INS1)]); // fnFaceMega
      case INS.NO_SPRITE:
        return always(29, [graphic]); // fnNoSprite
      case INS.SORT:
        return always(6, [graphic]); // fnSortSprite
      case INS.FOREGROUND:
        return always(7, [graphic]); // fnForeSprite
      case INS.BACKGROUND:
        return always(5, [graphic]); // fnBackSprite
      case INS.TABLE_ANIM:
        return run(22, [logic, graphic, mega, ins(SPEECH.INS1)]); // fnMegaTableAnim
      case INS.REVERSE_TABLE_ANIM:
        return run(63, [logic, graphic, mega, ins(SPEECH.INS1)]); // fnReverseMegaTableAnim
      case INS.WALK_TO_ANIM:
        return run(16, [logic, graphic, mega, walkdata, ins(SPEECH.INS1)]); // fnWalkToAnim
      case INS.SET_FRAME:
        return always(26, [graphic, ins(SPEECH.INS1), ins(SPEECH.INS2)]); // fnSetFrame
      case INS.STAND_AFTER_ANIM:
        return always(20, [graphic, mega, ins(SPEECH.INS1)]); // fnStandAfterAnim
      default:
        // `INS_trace` and anything else: "unimplemented command - just cancel".
        // Revolution's own fall-through, not this project giving up.
        this.host.log?.(`speech command ${command} is cancelled, as ScummVM cancels it`);
        return true;
    }
  }

  /** Records that a script reached an opcode this project does not implement. */
  private note(number: number): void {
    this.unimplemented.set(number, (this.unimplemented.get(number) ?? 0) + 1);
  }

  /**
   * Dispatches one opcode call.
   *
   * The return is Revolution's packed pair: the low three bits are an `IR_*`
   * code, the rest is a value the next `CP_JUMP_ON_RETURNED` indexes by.
   */
  callMcode(number: number, params: Int32Array, object: Sword2ObjectLayout): number {
    if (number < 0 || number >= SWORD2_OPCODE_COUNT) {
      this.onFault(
        `object ${this.currentObject} called opcode ${number} and Broken Sword II has ` +
          `${SWORD2_OPCODE_COUNT}. The script offset is not on an instruction boundary`,
      );
      return IR.TERMINATE;
    }

    switch (number) {
      case 0: // fnTestFunction
      case 1: // fnTestFlags
        // Revolution's own debug hooks. They do nothing in a shipped game.
        return IR.CONT;

      case 2: // fnRegisterStartPoint — a named entry point for the debugger
        this.host.log?.(`start point ${params[0]}: ${this.peekString(params[1])}`);
        return IR.CONT;

      case 3: // fnInitBackground
        this.host.initBackground(params[0], params[1] === 1);
        return IR.CONT;

      case 4: // fnSetSession
        this.setSession(params[0]);
        // The session changed, so this cycle's walk must stop.
        this.pc = 0xffffffff;
        return IR.CONT;

      // The eight sprite calls set a *field*, they do not draw. `Router::
      // setSpriteStatus` writes the low word of the object's own graphic
      // structure and returns; the drawing happens in `fnRegisterFrame`, which
      // the same service script calls a few instructions later and reads the
      // field back. Treating these as "draw now" — which this did — put every
      // sprite in the list one call too early, with the player's feet standing
      // in for every mega's, and then `fnRegisterFrame` did nothing at all.
      case 5: // fnBackSprite
        this.setSpriteType(params[0], Sword2SpriteType.BACK_SPRITE);
        return IR.CONT;
      case 6: // fnSortSprite
        this.setSpriteType(params[0], Sword2SpriteType.SORT_SPRITE);
        return IR.CONT;
      case 7: // fnForeSprite
        this.setSpriteType(params[0], Sword2SpriteType.FORE_SPRITE);
        return IR.CONT;
      case 29: // fnNoSprite
        this.setSpriteType(params[0], Sword2SpriteType.NO_SPRITE);
        return IR.CONT;
      case 67: // fnBackPar0Sprite
        this.setSpriteType(params[0], Sword2SpriteType.BGP0_SPRITE);
        return IR.CONT;
      case 68: // fnBackPar1Sprite
        this.setSpriteType(params[0], Sword2SpriteType.BGP1_SPRITE);
        return IR.CONT;
      case 69: // fnForePar0Sprite
        this.setSpriteType(params[0], Sword2SpriteType.FGP0_SPRITE);
        return IR.CONT;
      case 70: // fnForePar1Sprite
        this.setSpriteType(params[0], Sword2SpriteType.FGP1_SPRITE);
        return IR.CONT;

      // The shading bit lives in the *high* word of the same field, so these
      // two are the same write with the halves swapped (`router.cpp`'s
      // `setSpriteShading`).
      case 89: // fnShadedSprite
        this.setSpriteShading(params[0], true);
        return IR.CONT;
      case 90: // fnUnshadedSprite
        this.setSpriteShading(params[0], false);
        return IR.CONT;

      case 28: // fnRegisterFrame
        this.host.registerFrame(
          this.currentObject,
          params[0] === 0 ? null : params[0],
          params[1],
          params[2] === 0 ? null : params[2],
        );
        return IR.CONT;

      case 97: // fnRegisterPointerText
        this.host.registerPointerText(this.currentObject, params[0]);
        return IR.CONT;

      case 31: {
        // fnUpdatePlayerStats: the engine is told where the player is.
        // `function.cpp:461-483`. Three fields out of the object's own
        // `ObjectMega`, and the scroll back the other way.
        const mega = params[0];
        this.setVar(SV2.PLAYER_FEET_X, this.peek(mega, MEGA.FEET_X));
        this.setVar(SV2.PLAYER_FEET_Y, this.peek(mega, MEGA.FEET_Y));
        // The engine's copy as well as the script's: the camera chases these
        // and reads them from the engine, not from the variable block
        // (`function.cpp:470-471`).
        this.host.setPlayerFeet(this.peek(mega, MEGA.FEET_X), this.peek(mega, MEGA.FEET_Y));
        this.setVar(SV2.PLAYER_CUR_DIR, this.peek(mega, MEGA.CUR_DIR));
        this.setVar(SV2.SCROLL_OFFSET_X, this.host.scrollOffset().x);
        return IR.CONT;
      }

      case 37: // fnNoHuman
        this.noHuman();
        return IR.CONT;
      case 38: // fnAddHuman
        this.addHuman();
        return IR.CONT;

      case 8: // fnRegisterMouse
        this.host.registerMouse(this.currentObject, params[0] === 0 ? null : params[0]);
        return IR.CONT;

      case 33: {
        // fnInitFloorMouse *writes* the floor's mouse structure and registers
        // nothing (`function.cpp:498-517`); the floor object's own
        // `fnRegisterMouse` a few instructions later is what puts it in the
        // list. Registering here instead handed the list the structure as the
        // script left it — all zeroes — which is why the probe reported a floor
        // target at 0,0 with no area to click.
        this.floorMouse = params[0];
        // A fresh structure: force the write rather than let the size guard
        // skip it, because this may be a different object's structure at the
        // same room size and it is all zeroes until written.
        this.floorMouseRoom = '';
        this.writeFloorMouse();
        return IR.CONT;
      }

      /*
       * The four animation calls, and the two that were one.
       *
       * `fnReverseAnim` is opcode **64**, not 63. 63 is
       * `fnReverseMegaTableAnim` — the two sit next to each other in
       * `interpreter.cpp`'s table (entries 63 and 64) and this dispatched 63
       * to the wrong one of them. So every `fnReverseMegaTableAnim` ran as a
       * plain reverse anim, reading the mega pointer in `params[2]` as though
       * it were a resource id, and every real `fnReverseAnim` fell through to
       * "an opcode this project does not implement" — 88,235 times in 3,536
       * cycles on the demo, because the script that reaches it loops until the
       * animation it is waiting for ends, and nothing was ever going to end
       * it.
       *
       * The table pair differs from the plain pair only in where the resource
       * comes from: `megaTableAnimate` reads `animTable[4 * curDir]` on the
       * first frame and then defers to the same `doAnimate` (`anims.cpp:142`).
       */
      case 9: // fnAnim
        return this.doAnimate(params[0], params[1], params[2], false);
      case 22: // fnMegaTableAnim
        return this.megaTableAnimate(params[0], params[1], params[2], params[3], false);
      case 63: // fnReverseMegaTableAnim
        return this.megaTableAnimate(params[0], params[1], params[2], params[3], true);
      case 64: // fnReverseAnim
        return this.doAnimate(params[0], params[1], params[2], true);

      case 10: // fnRandom
        this.setVar(SV2.RESULT, this.host.random(params[0], params[1]));
        return IR.CONT;

      case 11: // fnPreLoad
      case 78: // fnPreFetch
      case 101: // fnSoundFetch
        this.host.preload(params[0]);
        return IR.CONT;

      case 21: // fnPause
        return this.doPause(params[0], params[1]);
      case 27: // fnRandomPause
        return this.doPause(params[0], this.host.random(params[1], params[2]));

      case 26: // fnSetFrame
        return this.setFrame(params[0], params[1], params[2] !== 0);

      case 30: // fnSendSync
        this.sendSync(params[0], params[1]);
        return IR.CONT;
      case 60: {
        // fnGetSync
        const sync = this.getSync();
        this.setVar(SV2.RESULT, sync ? sync.sync : 0);
        return IR.CONT;
      }
      case 61: {
        // fnWaitSync — repeats the whole mcode call until a sync arrives
        const sync = this.getSync();
        if (!sync) return IR.REPEAT;
        this.setVar(SV2.RESULT, sync.sync);
        return IR.CONT;
      }

      // The event system: six opcodes over one ten-slot list, and the whole
      // reason a click turns into anything. Nothing here was implemented, so
      // `fnCheckEventWaiting` answered "no" 5,172 times in three thousand
      // frames of the demo and the player never picked up a single click.
      case 49: // fnStartEvent
        this.startEvent();
        return IR.TERMINATE;
      case 50: // fnCheckEventWaiting
        this.setVar(SV2.RESULT, this.checkEventWaiting() ? 1 : 0);
        return IR.CONT;
      case 71: // fnSetPlayerActionEvent
        this.setPlayerActionEvent(SWORD2_CUR_PLAYER_ID, params[0]);
        return IR.CONT;
      case 81: // fnSendEvent
        this.sendEvent(params[0], params[1]);
        return IR.CONT;
      case 84: // fnCheckForEvent
        if (!this.checkEventWaiting()) return IR.CONT;
        this.startEvent();
        return IR.TERMINATE;
      case 85: // fnPauseForEvent
        // "combination of fnPause and fnCheckForEvent" — the pause is dropped
        // the moment an event arrives, which is why a character standing idle
        // answers a click on the next cycle rather than when its pause runs out.
        if (this.checkEventWaiting()) {
          this.poke(params[0], LOGIC.LOOPING, 0);
          this.startEvent();
          return IR.TERMINATE;
        }
        return this.doPause(params[0], params[1]);
      case 86: // fnClearEvent
        this.clearEvent(this.getVar(SV2.ID));
        return IR.CONT;

      case 98: // fnFetchWait
        // A no-op in ScummVM too (`function.cpp:2303-2311`): resources are
        // fetched in the background and the wait is the original's, not ours.
        return IR.CONT;

      case 59: // fnNewScript
        this.setVar(SV2.PLAYER_ACTION, 0);
        this.logicReplace(params[0]);
        return IR.TERMINATE;

      case 52: // fnGosub
        this.logicUp(params[0]);
        return IR.GOSUB;

      case 58: // fnSetValue — sets a mega's far-referenced megaset resource
        this.poke(params[0], MEGA.MEGASET_RES, params[1]);
        return IR.CONT;

      case 65: // fnAddToKillList
        if (
          this.currentObject !== SWORD2_CUR_PLAYER_ID &&
          !this.kills.includes(this.currentObject)
        ) {
          this.kills.push(this.currentObject);
        }
        return IR.CONT;

      case 36: // fnEndSession
        this.setSession(params[0]);
        this.pc = 0xffffffff;
        return IR.CONT;

      case 62: // fnRegisterWalkGrid
      case 82: // fnAddWalkGrid
      case 46: // fnSetWalkGrid
        this.router.addWalkGrid(params[0]);
        this.host.registerWalkGrid(params[0], true);
        return IR.CONT;
      case 83: // fnRemoveWalkGrid
        this.router.removeWalkGrid(params[0]);
        this.host.registerWalkGrid(params[0], false);
        return IR.CONT;

      // --- walking ----------------------------------------------------------
      case 15: // fnWalk
        return this.doWalk(
          params[0],
          params[1],
          params[2],
          params[3],
          params[4],
          params[5],
          params[6],
        );
      case 16: // fnWalkToAnim — the anim's own start coords are the target
        return this.walkToAnim(params[0], params[1], params[2], params[3], params[4]);
      case 42: // fnWalkToTalkToMega — ends facing whatever it ends facing
        return this.doWalk(params[0], params[1], params[2], params[3], params[4], params[5], 8);
      case 17: // fnTurn
        return this.doFace(params[0], params[1], params[2], params[3], params[4]);
      case 35: // fnFaceXY
        return this.doFace(
          params[0],
          params[1],
          params[2],
          params[3],
          this.whatTarget(
            this.peek(params[2], MEGA.FEET_X),
            this.peek(params[2], MEGA.FEET_Y),
            params[4],
            params[5],
          ),
        );
      case 87: // fnFaceMega
        return this.doFace(
          params[0],
          params[1],
          params[2],
          params[3],
          this.whatTarget(
            this.peek(params[2], MEGA.FEET_X),
            this.peek(params[2], MEGA.FEET_Y),
            this.peek(params[4], MEGA.FEET_X),
            this.peek(params[4], MEGA.FEET_Y),
          ),
        );
      case 18: // fnStandAt
        this.standAt(params[0], params[1], params[2], params[3], params[4]);
        return IR.CONT;
      case 19: // fnStand — at the feet the mega already has
        this.standAt(
          params[0],
          params[1],
          this.peek(params[1], MEGA.FEET_X),
          this.peek(params[1], MEGA.FEET_Y),
          params[2],
        );
        return IR.CONT;
      case 20: // fnStandAfterAnim
      case 73: // fnStandAtAnim
        return this.standAtAnim(params[0], params[1], params[2], number === 20);
      case 48: // fnSetScaling — the floor's ramp, which sizes every step
        this.poke(params[0], MEGA.SCALE_A, params[1]);
        this.poke(params[0], MEGA.SCALE_B, params[2]);
        return IR.CONT;

      case 43: // fnFadeDown
        this.host.fadeDown(params[0]);
        return IR.CONT;
      case 91: // fnFadeUp
        this.host.fadeUp(params[0]);
        return IR.CONT;
      case 96: // fnSetPalette
        this.host.setPalette(params[0]);
        return IR.CONT;

      case 54: // fnPlayFx
        this.setVar(SV2.RESULT, this.host.playFx(params[0], params[2], params[3], params[1]));
        return IR.CONT;
      case 55: // fnStopFx
        this.host.stopFx(params[0]);
        return IR.CONT;
      case 105: // fnStopAllFx
        for (let slot = 0; slot < 16; slot++) this.host.stopFx(slot);
        return IR.CONT;
      case 56: // fnPlayMusic
        this.host.playMusic(params[0], params[1] === 1);
        return IR.CONT;
      case 57: // fnStopMusic
        this.host.stopMusic();
        return IR.CONT;
      case 108: // fnCheckMusicPlaying
        this.setVar(SV2.RESULT, 0);
        return IR.CONT;

      case 51: // fnRequestSpeech
        this.setVar(SV2.RESULT, this.host.requestSpeech(params[0]) ? 1 : 0);
        return IR.CONT;
      case 47: // fnSpeechProcess
        return this.speechProcess(params, object);

      case 44: // fnISpeak
        return this.iSpeak(params);

      case 92: // fnDisplayMsg
        // `Screen::displayMsg` centres the line horizontally and sits it on the
        // bottom of the game area, in pen 187, across the full width
        // (`screen.cpp:373-385`) — the same centre-of-base placement a subtitle
        // gets, which is why it goes through the same call.
        this.host.displayText(params[0], 320, 400, 640, 187);
        return IR.CONT;

      case 72:
        // fnSetScrollCoordinate: "feet_x & feet_y refer to the physical screen
        // coords where the system will try to maintain George's feet"
        // (`function.cpp:1772-1783`). This used to set the scroll offset
        // itself, which pinned the view wherever the script last asked and
        // stopped the camera following anyone.
        this.host.setScrollTarget(params[0], params[1]);
        return IR.CONT;

      case 74: // fnSetScrollLeftMouse
      case 75: // fnSetScrollRightMouse
        this.scrollMouse(params[0], number === 75);
        return IR.CONT;

      case 110: // fnSetScrollSpeedNormal
        this.host.setScrollFraction(16);
        return IR.CONT;
      case 111: // fnSetScrollSpeedSlow
        this.host.setScrollFraction(32);
        return IR.CONT;

      case 100: // fnPrepareMusic
      case 102:
        // "params: 1 id of music to prepare [guess]" — ScummVM's own comment,
        // above a body that is `return IR_CONT` (`function.cpp:2323-2326`).
        // Revolution's table lists the name at 100 and again at 102, and
        // neither is `fnStopMusic`: preparing music is not stopping it, which
        // is what this project did with 100.
        return IR.CONT;

      case 88:
        // fnPlaySequence — the filename is a pushed string. Implemented, so it
        // is not noted: a film the folder does not hold is the *host's* answer,
        // and the host already records it by name for the stall report. Noting
        // it here as well put an opcode that ran under "opcodes this project
        // does not implement", and reported one absence twice.
        //
        // `IR_STOP` where ScummVM returns `IR_CONT`, and the two mean the same
        // thing for different reasons: ScummVM's `fnPlaySequence` *blocks* —
        // `_moviePlayer->play(...)` runs the whole film before the opcode
        // returns (`function.cpp`) — while a film here is loaded and drawn
        // across frames by the host. Stopping for the cycle is what makes the
        // rest of the script wait for the film in the same way, and it is the
        // difference between Broken Sword II's demo ending on its closing film
        // and ending on the line *after* it: `ScreenManager21` script 3 plays
        // `enddemo` and then calls `fnPlayCredits`, which quits.
        return this.host.playSequence(this.peekString(params[0])) ? IR.STOP : IR.CONT;

      case 12: // fnAddSubject
        this.menu.addSubject(params[0], params[1]);
        return IR.CONT;

      case 14: {
        // fnChoose. The one opcode in the game whose answer is *packed* into
        // its return value: `IR_CONT | (response << 3)`, unpacked by
        // `CP_JUMP_ON_RETURNED` (`function.cpp:178-196`). While the player has
        // not picked anything the opcode repeats, which re-enters it next
        // cycle with the bar still up.
        const response = this.menu.choose();
        if (response === SWORD2_NO_CHOICE) return IR.REPEAT;
        return IR.CONT | (response << 3);
      }

      case 23: {
        // fnAddMenuObject: a `MenuObject` — two int32s, the icon and the
        // luggage — read through the pointer `menu_master`'s script pushed.
        const icon = this.peek(params[0], 0);
        const luggage = this.peek(params[0], 4);
        this.menu.addMenuObject(icon, luggage);
        return IR.CONT;
      }

      case 112: // fnRemoveChooser
        // "Called from speech scripts to remove the chooser bar when it's not
        // appropriate to keep it displayed" — `function.cpp:2423-2431`.
        this.menu.hideMenu(SWORD2_MENU.BOTTOM);
        return IR.CONT;

      case 116: // fnRefreshInventory
        this.menu.refreshInventory();
        return IR.CONT;

      case 93: // fnSetObjectHeld
        // `Mouse::setObjectHeld` (`mouse.cpp:1126`): the script decides what the
        // player is carrying, and locks the mouse mode so opening the inventory
        // cannot take it back out of their hand.
        this.setVar(SV2.OBJECT_HELD, params[0]);
        this.host.setObjectHeld?.(params[0]);
        return IR.CONT;

      case 24: // fnStartConversation
        // `Mouse::startConversation` (`mouse.cpp:1443-1450`). The chooser's
        // count is reset only when this is the *start* of a conversation
        // rather than a return to its menu, which is what `TALK_FLAG` says.
        if (this.getVar(SV2.TALK_FLAG) === 0) this.setVar(SV2.CHOOSER_COUNT_FLAG, 0);
        this.noHuman();
        return IR.CONT;

      case 25: // fnEndConversation
        // `Mouse::endConversation` (`mouse.cpp:1457`) hides the bottom bar and,
        // if the pointer is still over where it was, holds the mouse until it
        // moves off. The bar and the variable are the two halves the scripts
        // can see; the hold is a cursor effect, and this family's cursor is the
        // browser's.
        this.menu.hideMenu(SWORD2_MENU.BOTTOM);
        this.setVar(SV2.TALK_FLAG, 0);
        return IR.CONT;

      case 39: // fnWeWait
        return this.weWait(params[0]);
      case 40: // fnTheyDoWeWait
        return this.theyDoWeWait(params);
      case 41: // fnTheyDo
        return this.theyDo(params);

      case 94: // fnAddSequenceText
        return this.addSequenceText(params);

      case 45: // fnTotalRestart
        this.host.requestQuit('restart');
        return IR.TERMINATE;

      case 109: // fnPlayCredits
        // "This function just quits the game if this is the playable demo, ie.
        // credits are NOT played in the demo any more!" — `fnPlayCredits`
        // (`function.cpp:2394-2406`) reads `DEMO` and calls `quitGame()`.
        //
        // This is how Broken Sword II's demo *ends*, and it is the whole of the
        // opcode for the only Release this project can run: the screen manager
        // for the warehouse exterior plays `enddemo.smk` and then calls this,
        // and the original stops. The retail branch — `rollCredits()`, the
        // scrolling credit list over its own music — is not implemented, so a
        // retail install would fall through to the note below and carry on.
        if (this.getVar(SV2.DEMO) !== 0) {
          this.host.requestQuit('credits');
          return IR.STOP;
        }
        this.note(number);
        return IR.CONT;
      case 95: // fnResetGlobals
        this.host.log?.('fnResetGlobals: the game asked for a fresh set of globals');
        return IR.CONT;
      case 115: // fnRestoreGame
        this.note(number);
        return IR.CONT;

      case 80: // fnPassPlayerSaveData — the player hands its structures out
        this.savedPlayerLogic = this.copyStructure(params[0], OBJECT_LOGIC_SIZE);
        this.savedPlayerGraphic = this.copyStructure(params[1], OBJECT_GRAPHIC_SIZE);
        this.savedPlayerMega = this.copyStructure(params[2], OBJECT_MEGA_SIZE);
        return IR.CONT;

      case 79: // fnGetPlayerSaveData — and takes them back
        this.pasteStructure(params[0], this.savedPlayerLogic);
        this.pasteStructure(params[1], this.savedPlayerGraphic);
        this.pasteStructure(params[2], this.savedPlayerMega);
        // "Any walk-data must be cleared - the player will be set to stand if
        // he was walking when saved." The route the walk was following lived in
        // the router and the router is empty after a restore, so a mega left
        // mid-walk would step through nodes that are not there.
        if (this.peek(params[2], MEGA.IS_WALKING)) {
          this.poke(params[2], MEGA.IS_WALKING, 0);
          this.standAt(
            params[1],
            params[2],
            this.peek(params[2], MEGA.FEET_X),
            this.peek(params[2], MEGA.FEET_Y),
            this.peek(params[2], MEGA.CUR_DIR),
          );
          // "Reset looping flag (which would have been 1 during fnWalk)."
          this.poke(params[0], LOGIC.LOOPING, 0);
        }
        return IR.CONT;

      case 32: // fnPassGraph
      case 34: // fnPassMega
        // Copy-outs the scripts use to hand a structure to the engine. Nothing
        // here needs the copy, because the engine reads the structures in
        // place. `fnUpdatePlayerStats` used to be in this group and is not a
        // copy-out at all — see case 31 above.
        return IR.CONT;

      default:
        this.note(number);
        void object;
        return IR.CONT;
    }
  }

  /**
   * The direction to face to get from one point to another.
   *
   * Three bands — flat, diagonal, vertical — with the diagonal band narrower
   * than an even split would make it, which is what makes a mega prefer walking
   * straight. The same shape Sword1 uses, against this family's own steps.
   */
  private whatTarget(startX: number, startY: number, destX: number, destY: number): number {
    const deltaX = destX - startX;
    const deltaY = destY - startY;
    const right = deltaX > 0;
    const down = deltaY > 0;
    const DIAGONALX = 36;
    const DIAGONALY = 8;
    let slope: 0 | 1 | 2;
    if (Math.abs(deltaY) * DIAGONALX < Math.trunc((Math.abs(deltaX) * DIAGONALY) / 2)) slope = 0;
    else if (Math.trunc((Math.abs(deltaY) * DIAGONALX) / 2) > Math.abs(deltaX) * DIAGONALY)
      slope = 2;
    else slope = 1;
    if (slope === 0) return right ? 2 : 6;
    if (slope === 2) return down ? 4 : 0;
    if (right) return down ? 3 : 1;
    return down ? 5 : 7;
  }

  /** Reads an `ObjectWalkdata` through a script's pointer token. */
  private walkDataOf(token: number): Sword2WalkData | null {
    const target = this.decode(token);
    if (!target) return null;
    return readSword2WalkData(target.object.bytes, target.at);
  }

  /**
   * `fnWalk`: route once, then step the walk one node a cycle.
   *
   * A looping opcode, like `fnPause`: `looping` in the logic structure marks the
   * walk as running, `walk_pc` in the mega structure is the node, and
   * `IR_REPEAT` is what makes one opcode last as long as the walk does. That is
   * why the router runs once per walk rather than once per cycle.
   */
  private doWalk(
    logicToken: number,
    graphicToken: number,
    megaToken: number,
    walkToken: number,
    targetX: number,
    targetY: number,
    targetDir: number,
  ): number {
    const looping = this.peek(logicToken, LOGIC.LOOPING);

    if (looping === 0) {
      // Already there: quit back to the script without a stand frame, which is
      // what stops a mega flickering when a script re-runs an animation.
      if (
        this.peek(megaToken, MEGA.FEET_X) === targetX &&
        this.peek(megaToken, MEGA.FEET_Y) === targetY &&
        this.peek(megaToken, MEGA.CUR_DIR) === targetDir
      ) {
        this.setVar(SV2.RESULT, 0);
        return IR.CONT;
      }

      const walk = this.walkDataOf(walkToken);
      if (!walk) {
        this.onFault(
          `object ${this.currentObject} asked to walk with a walkdata structure this project ` +
            `could not read, so the walk is refused rather than run against zeroes`,
        );
        this.setVar(SV2.RESULT, 1);
        return IR.CONT;
      }

      this.poke(megaToken, MEGA.WALK_PC, 0);
      const route = this.router.routeFinder(
        {
          feetX: this.peek(megaToken, MEGA.FEET_X),
          feetY: this.peek(megaToken, MEGA.FEET_Y),
          dir: this.peek(megaToken, MEGA.CUR_DIR),
          scaleA: this.peek(megaToken, MEGA.SCALE_A),
          scaleB: this.peek(megaToken, MEGA.SCALE_B),
        },
        walk,
        targetX,
        targetY,
        targetDir,
      );

      if (route !== Sword2RouteResult.FOUND && route !== Sword2RouteResult.ALREADY_THERE) {
        this.setVar(SV2.RESULT, 1);
        return IR.CONT;
      }

      this.poke(megaToken, MEGA.IS_WALKING, 1);
      this.poke(logicToken, LOGIC.LOOPING, 1);
      this.poke(graphicToken, GRAPHIC.ANIM_RESOURCE, this.peek(megaToken, MEGA.MEGASET_RES));
    }

    // One node a cycle.
    const walkPc = this.peek(megaToken, MEGA.WALK_PC);
    const node = this.router.walkAnim[walkPc];
    if (!node || node.frame === 512) {
      this.poke(logicToken, LOGIC.LOOPING, 0);
      this.poke(megaToken, MEGA.IS_WALKING, 0);
      this.setVar(SV2.RESULT, 0);
      return IR.CONT;
    }

    this.poke(graphicToken, GRAPHIC.ANIM_PC, node.frame);
    this.poke(megaToken, MEGA.FEET_X, node.x);
    this.poke(megaToken, MEGA.FEET_Y, node.y);
    this.poke(megaToken, MEGA.CUR_DIR, node.dir);
    this.poke(megaToken, MEGA.WALK_PC, walkPc + 1);
    return IR.REPEAT;
  }

  /** `fnWalkToAnim`: the target is the animation's own start coordinates. */
  private walkToAnim(
    logicToken: number,
    graphicToken: number,
    megaToken: number,
    walkToken: number,
    animResource: number,
  ): number {
    let targetX = this.peek(megaToken, MEGA.FEET_X);
    let targetY = this.peek(megaToken, MEGA.FEET_Y);
    let targetDir = this.peek(megaToken, MEGA.CUR_DIR);

    const resource = this.resources.fetch(animResource);
    if (resource) {
      const header = readSword2AnimHeader(resource.bytes, RES_HEADER_SIZE);
      targetX = header.feetStartX;
      targetY = header.feetStartY;
      targetDir = header.feetStartDir;
    } else {
      this.onFault(
        `animation ${animResource}: ${this.resources.describeMissingResource(animResource)}`,
      );
    }
    return this.doWalk(logicToken, graphicToken, megaToken, walkToken, targetX, targetY, targetDir);
  }

  /**
   * `fnTurn`: a walk of zero length, which is how this engine turns on the spot.
   *
   * Routing with the mega's own coordinates as the target is not a trick — it is
   * what `getRoute` answers 2 for, and the animator then produces the turn
   * frames and nothing else.
   */
  private doFace(
    logicToken: number,
    graphicToken: number,
    megaToken: number,
    walkToken: number,
    targetDir: number,
  ): number {
    return this.doWalk(
      logicToken,
      graphicToken,
      megaToken,
      walkToken,
      this.peek(megaToken, MEGA.FEET_X),
      this.peek(megaToken, MEGA.FEET_Y),
      targetDir,
    );
  }

  /** `fnStandAt`: place a mega and face it, with no walk at all. */
  private standAt(
    graphicToken: number,
    megaToken: number,
    x: number,
    y: number,
    dir: number,
  ): void {
    if (dir < 0 || dir > 7) {
      this.onFault(`a stand was asked for direction ${dir}, which is not one of the eight`);
      return;
    }
    this.poke(megaToken, MEGA.FEET_X, x);
    this.poke(megaToken, MEGA.FEET_Y, y);
    this.poke(megaToken, MEGA.CUR_DIR, dir);
    const megaset = this.peek(megaToken, MEGA.MEGASET_RES);
    this.poke(graphicToken, GRAPHIC.ANIM_RESOURCE, megaset);

    const resource = megaset ? this.resources.fetch(megaset) : null;
    if (resource) {
      const header = readSword2AnimHeader(resource.bytes, RES_HEADER_SIZE);
      // The stand frames follow the walk frames, one per direction — the layout
      // `Sword2Router.loadWalkData` derives, at the one place outside it that
      // needs a frame number.
      const framesPerChar = Math.max(0, header.noAnimFrames - 8 - 8);
      this.poke(graphicToken, GRAPHIC.ANIM_PC, framesPerChar + dir);
    }
  }

  /** `fnStandAfterAnim` / `fnStandAtAnim`: stand where an animation leaves you. */
  private standAtAnim(
    graphicToken: number,
    megaToken: number,
    animResource: number,
    afterwards: boolean,
  ): number {
    const resource = this.resources.fetch(animResource);
    if (!resource) {
      this.onFault(
        `animation ${animResource}: ${this.resources.describeMissingResource(animResource)}`,
      );
      return IR.CONT;
    }
    const header = readSword2AnimHeader(resource.bytes, RES_HEADER_SIZE);
    const x = afterwards ? header.feetEndX : header.feetStartX;
    const y = afterwards ? header.feetEndY : header.feetStartY;
    const dir = afterwards ? header.feetEndDir : header.feetStartDir;
    this.standAt(graphicToken, megaToken, x, y, dir);
    return IR.CONT;
  }

  /**
   * `fnPause`: a looping mcode, which is the pattern worth understanding.
   *
   * The `looping` field in the object's logic structure is how a *single*
   * opcode occupies several cycles: the first call sets it and the pause count,
   * every call after decrements and returns `IR_REPEAT` — which makes the
   * interpreter return with the offset pointing at this instruction's own
   * start, so the same opcode runs again next cycle. That is the whole of
   * Sword2's "waiting", and a dozen opcodes use it.
   *
   * A pause of 0 continues immediately, 1 gives a one-cycle quit, and so on.
   */
  private doPause(logicToken: number, cycles: number): number {
    const looping = this.peek(logicToken, 0);
    if (looping === 0) {
      this.poke(logicToken, 0, 1);
      this.poke(logicToken, 4, cycles);
    }
    const pause = this.peek(logicToken, 4);
    if (pause) {
      this.poke(logicToken, 4, pause - 1);
      return IR.REPEAT;
    }
    this.poke(logicToken, 0, 0);
    return IR.CONT;
  }

  /**
   * `fnAnim`: step an animation, one frame a cycle, until it runs out.
   *
   * The same looping mechanism as `fnPause`: `looping` in the logic structure
   * marks the animation as running, `anim_pc` in the graphic structure is the
   * frame, and `IR_REPEAT` is what makes one opcode last as long as the
   * animation does.
   */
  /**
   * `fnMegaTableAnim` / `fnReverseMegaTableAnim`: the anim comes from a table.
   *
   * "Appropriate anim resource is in `table[direction]`" (`anims.cpp:153`).
   * The lookup happens only on the first frame — once the animation is looping
   * the resource is already in the graphic structure, and `megaTableAnimate`
   * passes 0 down rather than reading the table again.
   */
  private megaTableAnimate(
    logicToken: number,
    graphicToken: number,
    megaToken: number,
    tableToken: number,
    reverse: boolean,
  ): number {
    const starting = this.peek(logicToken, LOGIC.LOOPING) === 0;
    const animResource = starting
      ? this.peek(tableToken, 4 * this.peek(megaToken, MEGA.CUR_DIR))
      : 0;
    return this.doAnimate(logicToken, graphicToken, animResource, reverse);
  }

  private doAnimate(
    logicToken: number,
    graphicToken: number,
    animResource: number,
    reverse: boolean,
  ): number {
    const looping = this.peek(logicToken, LOGIC.LOOPING);
    // Mid-animation the id is the one already in the graphic structure, which
    // is where `doAnimate` reads it from too (`anims.cpp:115`). The table form
    // relies on this: it hands 0 down once the animation is running rather
    // than looking the direction up a second time.
    const wanted = looping === 0 ? animResource : this.peek(graphicToken, GRAPHIC.ANIM_RESOURCE);
    const resource = this.resources.fetch(wanted);
    if (!resource) {
      this.onFault(`animation ${wanted}: ${this.resources.describeMissingResource(wanted)}`);
      return IR.CONT;
    }
    const header = readSword2AnimHeader(resource.bytes, RES_HEADER_SIZE);
    const frames = header.noAnimFrames;
    if (frames === 0) return IR.CONT;

    if (looping === 0) {
      this.poke(logicToken, LOGIC.LOOPING, 1);
      this.poke(graphicToken, GRAPHIC.ANIM_RESOURCE, wanted);
      this.poke(graphicToken, GRAPHIC.ANIM_PC, reverse ? frames - 1 : 0);
      return IR.REPEAT;
    }

    const pc = this.peek(graphicToken, GRAPHIC.ANIM_PC);
    const next = reverse ? pc - 1 : pc + 1;
    if (reverse ? next < 0 : next >= frames) {
      this.poke(logicToken, LOGIC.LOOPING, 0);
      return IR.CONT;
    }
    this.poke(graphicToken, GRAPHIC.ANIM_PC, next);
    return IR.REPEAT;
  }

  /** `fnSetFrame`: park an animation on its first or last frame. */
  private setFrame(graphicToken: number, animResource: number, last: boolean): number {
    const resource = this.resources.fetch(animResource);
    if (!resource) {
      this.onFault(
        `animation ${animResource}: ${this.resources.describeMissingResource(animResource)}`,
      );
      return IR.CONT;
    }
    const header = readSword2AnimHeader(resource.bytes, RES_HEADER_SIZE);
    this.poke(graphicToken, 4, animResource);
    this.poke(graphicToken, 8, last ? Math.max(0, header.noAnimFrames - 1) : 0);
    return IR.CONT;
  }

  /** The objects this session has loaded, for a save and for the stall report. */
  loadedObjects(): number[] {
    return [...this.objects.keys()].sort((a, b) => a - b);
  }

  /** The object layouts, for a save: their bytes are the world. */
  objectBytes(): Array<{ id: number; bytes: Uint8Array }> {
    return [...this.objects].map(([id, layout]) => ({ id, bytes: layout.bytes.slice() }));
  }

  /** Reads a structure out through a pointer token, or null when it is not one. */
  private copyStructure(token: number, size: number): Uint8Array | null {
    const target = this.decode(token);
    if (!target) return null;
    const bytes = target.object.bytes;
    if (target.at + size > bytes.length) return null;
    return bytes.slice(target.at, target.at + size);
  }

  /** Writes one back, ignoring a token that names nothing and a missing copy. */
  private pasteStructure(token: number, saved: Uint8Array | null): void {
    if (!saved) return;
    const target = this.decode(token);
    if (!target) return;
    if (target.at + saved.length > target.object.bytes.length) return;
    target.object.bytes.set(saved, target.at);
  }

  /**
   * The player object's whole byte block, for a save.
   *
   * ScummVM saves the player's hub and its three structures and then runs three
   * more scripts — 14, and one of 9 to 13 chosen by megaset — to rebuild the
   * animation tables it did **not** save (`saveload.cpp:266-307`). It has to:
   * its save is a fixed-size buffer and those tables are kilobytes.
   *
   * There is no such limit here, so this takes the block whole. The hub and all
   * three structures are inside it, and so are the tables — which is why this
   * project needs no megaset-to-script table to restore a game, and why the
   * player comes back as whoever they were rather than as whoever a table said.
   */
  playerBytes(): Uint8Array | null {
    const player = this.object(SWORD2_CUR_PLAYER_ID);
    return player ? player.bytes.slice() : null;
  }

  /**
   * Puts a saved world back: the globals, the player, and a fresh everything.
   *
   * `killAll(false)` is ScummVM's phrase for the middle step — "trash all
   * resources from memory except player object & global vars" — and it is not
   * housekeeping. An object's script pc lives in its own bytes, so an object
   * left in the cache would resume a script from the middle of a scene that is
   * no longer happening; the walk grids it registered on the way in would never
   * be registered again, because the line that registers them is behind the pc.
   * Dropping every object makes each one restart from the top of its logic on
   * the next cycle, which is exactly what walking into a room does.
   *
   * The player is the exception, and is the only one: its bytes are the save.
   *
   * Refuses before it writes anything. A half-applied restore in this family is
   * two games' objects at once, which is worse than a refused load.
   */
  restoreWorld(globals: Uint8Array, player: Uint8Array): void {
    if (this.globals && globals.length !== this.globalCount * 4) {
      throw new Error(
        `This save holds ${globals.length} bytes of script variables and this install has ` +
          `${this.globalCount * 4}. It is refused rather than half-applied.`,
      );
    }
    const current = this.object(SWORD2_CUR_PLAYER_ID);
    if (!current) {
      throw new Error(
        `This install has no player object (resource ${SWORD2_CUR_PLAYER_ID}), so a saved ` +
          `player cannot be put back into it.`,
      );
    }
    if (current.bytes.length !== player.length) {
      throw new Error(
        `This save holds a ${player.length}-byte player object and this install's is ` +
          `${current.bytes.length}. It is refused rather than half-applied.`,
      );
    }

    this.objects.clear();
    this.pointers.length = 0;
    this.syncs.length = 0;
    this.events.length = 0;
    this.kills.length = 0;
    this.router.clearWalkGrids();
    this.floorMouse = null;
    this.floorMouseRoom = '';
    this.speechRunning = false;
    this.speechTextBloc = 0;
    this.speechTime = 0;
    this.sequenceText.length = 0;
    this.menu.closeImmediately();

    this.restoreGlobals(globals);

    const fresh = this.object(SWORD2_CUR_PLAYER_ID);
    if (!fresh) {
      throw new Error(
        `The player object (resource ${SWORD2_CUR_PLAYER_ID}) would not reload, so the save ` +
          `could not be put back.`,
      );
    }
    fresh.bytes.set(player);

    // Scripts 7 then 8, which is the game's own way in and out of its four
    // structures. Seven is a copy-out and a no-op against bytes that are
    // already the saved ones; what it buys is the three pointers, which is the
    // only way the engine learns where inside George his mega structure sits.
    // Eight copies them straight back and, if he was mid-stride when the save
    // was taken, stands him where he stood.
    //
    // Guarded on the count because a script number past the end is read as a
    // raw code offset by the interpreter, which would run the player's bytes
    // from the middle of an instruction. George has fifteen; a cut-down object
    // that has not got them keeps its restored bytes and says so.
    if (fresh.scriptCount > SWORD2_PLAYER_SAVE_RETURN) {
      this.runObjectScript(SWORD2_CUR_PLAYER_ID, SWORD2_CUR_PLAYER_ID, SWORD2_PLAYER_SAVE_DATA);
      this.runObjectScript(SWORD2_CUR_PLAYER_ID, SWORD2_CUR_PLAYER_ID, SWORD2_PLAYER_SAVE_RETURN);
    } else {
      this.host.log?.(
        `the player object has ${fresh.scriptCount} scripts, so the pair that hand its ` +
          `structures back (7 and 8) were not run — the saved bytes are in place and the ` +
          `engine's pointers into them are not`,
      );
    }
  }

  /** A line for the stall report: which opcodes a playthrough skipped. */
  describeUnimplemented(): string | undefined {
    if (this.unimplemented.size === 0) return undefined;
    const named = [...this.unimplemented.entries()]
      .sort((left, right) => right[1] - left[1])
      .map(([number, count]) => `${sword2OpcodeName(number)} (${count}x)`);
    return `opcodes this project does not implement that the scripts reached: ${named.join(', ')}`;
  }

  /** The structure sizes, exported so the editor can lay an object out. */
  static get structureSizes(): Readonly<Record<string, number>> {
    return {
      resHeader: RES_HEADER_SIZE,
      objectHub: OBJECT_HUB_SIZE,
      objectMouse: OBJECT_MOUSE_SIZE,
      objectLogic: OBJECT_LOGIC_SIZE,
      objectGraphic: OBJECT_GRAPHIC_SIZE,
      objectSpeech: OBJECT_SPEECH_SIZE,
      objectMega: OBJECT_MEGA_SIZE,
    };
  }
}
