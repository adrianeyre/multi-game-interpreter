/**
 * The Kernel calls themselves: what a SCI script asks the interpreter to do.
 *
 * #217 dispatches; this implements. Split that way because the dispatch is one
 * table per Version and the implementations are one per *call*, and a call that
 * means the same thing at every Version — `StrLen`, `NewList`, `Random` — should
 * be written once rather than thirteen times.
 *
 * **Everything here is by name, never by number.** The number is the Version's
 * business and it is #217's table that resolves it. A file of numbered handlers
 * is precisely how a Kernel table ends up off by one entry, which is the
 * failure `verifying-version-support.md` says nothing on screen will show.
 *
 * **A call that is not here reports itself.** It does not return zero and it
 * does not guess. A game that halts naming a Kernel call is a game somebody can
 * fix; a game that runs and does the wrong things is not.
 */

import type { SciInput } from '../SciInput.js';
import { SCI_EVENT } from '../SciInput.js';
import {
  isNull,
  NULL_REG,
  reg,
  type PMachine,
  type Reg,
  type SciByteView,
  type SciObject,
} from './PMachine.js';
import { SciHeap } from './segments.js';
import { audio36Number } from '../resource/sciMessage.js';
import { SCI_PAL_VARY } from '../gfx/sciPalVary.js';
import {
  SCI_SOUND_MASTER_VOLUME_MAX,
  SCI_SOUND_SIGNAL_FINISHED,
  SCI_SOUND_STATE,
  SCI_SOUND_VOLUME_MAX,
  SciSoundSlots,
  soundOpFor,
  soundOpsFor,
  soundVersionFor,
  type SciSoundOp,
} from '../sound/sciDoSound.js';
import { describeSciVersion } from '../sciVersion.js';

/** What a Kernel call can reach. */
/**
 * How Sierra's three file modes are numbered.
 *
 * `engines/sci/engine/file.h:31`, `kFileOpenMode`. Nought and two both create;
 * only one refuses a file that is not there, and a game uses that to ask
 * whether it has been here before — Quest for Glory looks for a character it
 * exported, and the answer "no" is a mode-1 open returning nought.
 */
export const SCI_FILE_MODE = {
  openOrCreate: 0,
  openOrFail: 1,
  create: 2,
} as const;

/**
 * `FileIO`'s twenty sub-functions, by the number the first argument carries.
 *
 * `kFileIO_subops` in `engines/sci/engine/kernel_tables.h` (fetched
 * 2026-09-13). Eleven are everywhere from SCI1, `rename` and `copy` arrive at
 * SCI1.1, and the last seven at SCI2.1 middle — which is why King's Quest VII
 * is the first release read here that reaches past `exists`.
 */
export const SCI_FILE_IO = {
  open: 0,
  close: 1,
  readRaw: 2,
  writeRaw: 3,
  unlink: 4,
  readString: 5,
  writeString: 6,
  seek: 7,
  findFirst: 8,
  findNext: 9,
  exists: 10,
  rename: 11,
  copy: 12,
  readByte: 13,
  writeByte: 14,
  readWord: 15,
  writeWord: 16,
  checkFreeSpace: 17,
  getCwd: 18,
  isValidDirectory: 19,
} as const;

/**
 * What `CheckFreeSpace` is asking about, which is three different questions.
 *
 * `kfile.cpp:157`. The call is one name over three unrelated answers — a size
 * in bytes, a free space in kibibytes, and a yes or no — so a handler that
 * answered one constant was right for at most one of them.
 */
export const SCI_FREE_SPACE = {
  saveGameSize: 0,
  freeDiskSpace: 1,
  enoughToSave: 2,
} as const;

/**
 * The files a SCI0 game reads and writes by name.
 *
 * SCI0 has four file calls and SCI1 folded them into `FileIO`; these four are
 * the older shape. What a game does with them is narrow and worth knowing,
 * because it says what an implementation has to get right: Quest for Glory
 * exports a character and imports it into the sequel, Codename ICEMAN prints a
 * transcript, and several games keep their own list of saved games in one.
 *
 * A handle is a positive integer and **nought means failure** — that is the
 * whole error channel, and Sierra's scripts test it, so a surface that throws
 * where the original returned nought turns a message into a crash.
 */
export interface SciFileSurface {
  /** Opens by name in one of `SCI_FILE_MODE`'s three; nought when it could not. */
  open(name: string, mode: number): number;
  /** The next line with no trailing newline, or null at the end of the file. */
  readLine(handle: number): string | null;
  /** Writes exactly what it is handed at the cursor: the newline is the game's. */
  write(handle: number, text: string): void;
  close(handle: number): void;

  /*
   * The rest is `FileIO`'s, and it is bytes rather than lines.
   *
   * SCI1 folded SCI0's four calls into one with twenty sub-functions, and seven
   * of those are byte-addressed — a raw read and write, a seek, a byte and a
   * word each way. A surface that only knows lines cannot answer them, so the
   * cursor is a byte offset and `readLine` is written over it.
   */
  /** Up to `count` bytes from the cursor, which it advances. Short at the end. */
  read(handle: number, count: number): Uint8Array;
  /** Writes at the cursor, which it advances, growing the file if it must. */
  writeBytes(handle: number, bytes: Uint8Array): void;
  /** `whence` is 0 from the start, 1 from here, 2 from the end. The new cursor, or -1. */
  seek(handle: number, offset: number, whence: number): number;
  /** Whether a name could be opened, without opening it. */
  exists(name: string): boolean;
  /** Deletes by name; false when there was nothing of that name. */
  remove(name: string): boolean;
  rename(from: string, to: string): boolean;
  copy(from: string, to: string): boolean;
  /** Every name a DOS wildcard matches, sorted, for `FindFirst` and `FindNext`. */
  names(mask: string): string[];
}

export interface SciKernelWorld {
  machine: PMachine;
  heap: SciHeap;
  input: SciInput;
  /** Loads a script and returns its export, for `ScriptID`. */
  scriptExport(script: number, index: number): Reg | null;
  /** Ticks since the game started, in sixtieths. */
  ticks(): number;
  random(): number;
  /**
   * Whether anything would be heard, for `DoSound`'s `Mute`.
   *
   * Optional and narrow on purpose: a Kernel handler should not reach the
   * shell's `AudioContext`, and `Mute` is the one sub-function whose answer a
   * script keeps — it reads the state back, stores it, and puts it back after
   * a dialog. Tracking that inside the Kernel would give the game a mute that
   * agreed with itself and with nothing else.
   */
  sound?: { readonly isEnabled: boolean; setEnabled(enabled: boolean): void };
  log(message: string): void;
  /**
   * View geometry, where the engine can answer it.
   *
   * Optional because a Kernel handler should not need the renderer to exist,
   * and present because these three answers change what a game *believes*
   * rather than only what it draws: an actor whose cel is nought by nought is
   * at a point, and every collision and every bounding box above it is wrong.
   */
  viewLoopCount?(view: Reg): number;
  /**
   * Where a cel's own origin sits, which `CelInfo` asks for by number.
   *
   * The origin **is** the displacement — the offset from the actor's position
   * to the cel's top left — and it is asked for by View, loop and cel rather
   * than by object, because a script asking this is measuring a cel it has not
   * put on screen yet.
   */
  celOrigin?(view: number, loop: number, cel: number): { x: number; y: number } | null;
  /** One pixel of a cel, by its own index, for `CelInfo`'s fifth sub-function. */
  celPixel?(view: number, loop: number, cel: number, x: number, y: number): number | null;
  viewCelCount?(view: Reg): number;
  celSize?(args: Reg[]): { width: number; height: number } | null;
  /** Draws a Picture into the room Plane, which is what puts a room on screen. */
  drawPicture?(number: number): void;
  /** Puts the cast on the room Plane as screen items. */
  drawCast?(
    cast: ReadonlyArray<{
      view: number;
      loop: number;
      cel: number;
      x: number;
      y: number;
      priority: number;
    }>,
  ): void;
  pictureValid?(): boolean;
  setPictureValid?(valid: boolean): void;
  /**
   * One string out of a `text` resource, by resource number and index.
   *
   * SCI0 keeps a room's dialogue in `text` resources and addresses a line as a
   * pair, so `Display` and `GetFarText` are handed two integers rather than a
   * reference. Answered here rather than through the heap because there is
   * nothing on the heap to answer with.
   */
  farText?(resource: number, index: number): string | null;

  /**
   * A window, and the port inside it that drawing is measured against.
   *
   * SCI16 puts a game's whole interface in windows its own scripts open, so
   * these are not decoration: a control's rectangle is *port*-relative, and
   * without a port every dialog's contents land in the corner of the room.
   */
  openWindow?(
    rect: { top: number; left: number; bottom: number; right: number },
    title: string,
    style: number,
    colours: { pen: number; back: number },
  ): number;
  closeWindow?(id: number): void;
  setPort?(id: number): void;
  getPort?(): number;

  /** A cursor by resource number, which is SCI0's and SCI1's form. */
  setCursor?(number: number, visible: boolean): void;
  /** A cursor as a View cel, which is SCI1.1's. */
  setViewCursor?(view: number, loop: number, cel: number, x: number, y: number): void;
  /**
   * One Message from a `MESSAGE` resource, by module and tuple.
   *
   * Synchronous, and therefore only answerable for a resource already read —
   * `kMessage` happens in the middle of a send and a Volume read does not. The
   * engine preloads what it can and this returns null for the rest, which the
   * handler reports rather than answering with an empty string.
   */
  message?(
    module: number,
    key: { noun: number; verb: number; cond: number; seq: number },
  ): { text: string; talker: number } | null;
  /**
   * One Message **record**, with its reference left alone.
   *
   * Separate from `message` above, which follows a reference and hands back
   * the line it points at. That collapse is right for `GetMessage`, SCI1's
   * one-shot spelling, and wrong for SCI1.1's `Message`: there a reference is
   * not a redirection but a **continuation**, and the caller walks it with
   * repeated `next` calls. Sierra's own reader pushes the reference onto a
   * cursor stack and pops back to the referring sequence when the referenced
   * one runs out, so a conversation that branches into another and returns is
   * two pops and not two lookups.
   *
   * Kept as a second hook rather than a widened first one so that the collapse
   * `GetMessage` depends on is not disturbed by the machinery above it.
   */
  messageRecord?(
    module: number,
    key: { noun: number; verb: number; cond: number; seq: number },
  ): {
    text: string;
    talker: number;
    reference?: { noun: number; verb: number; cond: number; seq: number };
  } | null;
  /**
   * The files a SCI0 game opens by name, where the host offers any.
   *
   * Optional for the reason every surface here is: a Kernel handler must not
   * need one to exist. Absent, `FOpen` answers nought, which is exactly what
   * Sierra's own interpreter answers on a disc it cannot write — so a game
   * meets a failure it already has code for rather than a call that is not
   * there.
   */
  files?: SciFileSurface;
  /** The colours text is drawn in, which `TextColors` sets. */
  setTextColours?(colours: readonly number[]): void;
  /** The fonts `|f0|` and its siblings select, which `TextFonts` sets. */
  setTextFonts?(fonts: readonly number[]): void;
  /**
   * The resolution text is laid out in, which `Font(SetFontRes)` sets.
   *
   * Optional, and nothing in this engine reads it back yet — text is measured
   * in the script's own coordinates throughout. It is here so the number a game
   * states is kept rather than dropped on the floor, and so that the day
   * something does measure in display pixels there is one place it comes from.
   */
  setTextResolution?(width: number, height: number): void;
  /**
   * Whether a cel's pixel is its clear key — the index meaning "draw nothing".
   *
   * `IsItSkip`'s whole question, and it is about what a game *believes* rather
   * than about drawing: scripts use it to decide whether a point is on a
   * character or on the background behind one.
   */
  celSkipAt?(view: number, loop: number, cel: number, x: number, y: number): boolean | null;
  /**
   * Where a cel lands on screen for an actor at (x, y, z).
   *
   * `SetNowSeen` and `BaseSetter` both need it and neither can work it out: the
   * rectangle depends on the cel's own width, height and displacement, which
   * live in the View resource.
   */
  celRect?(
    view: number,
    loop: number,
    cel: number,
    x: number,
    y: number,
    z: number,
  ): { left: number; top: number; right: number; bottom: number } | null;
  /** Puts the pointer where the game wants it, which `MoveCursor` asks for. */
  moveCursor?(x: number, y: number): void;
  /**
   * The palette fade `PalVary` drives, where the engine offers one.
   *
   * The sub-functions rather than the state: the Kernel dispatches on the first
   * argument and the engine owns the palette the fade is applied to.
   */
  palVary?: {
    init(resource: number, ticks: number, stepStop: number, direction: number): boolean;
    reverse(ticks: number, stepStop: number, direction: number): number;
    currentStep(): number;
    deinit(): void;
    changeTarget(resource: number): number;
    changeTicks(ticks: number): void;
    pause(paused: boolean): void;
  };
  /** Starts — and immediately finishes — a screen transition on a Plane. */
  showStyle?(type: number, plane: Reg, seconds: number): void;
  /** Records which palette entries a transition was told to touch. */
  setPalStyleRange?(from: number, to: number): void;
  /** A palette band rotating in place, which `PalCycle` drives. */
  palCycle?(
    what: 'set' | 'step' | 'pause' | 'on' | 'off',
    from: number,
    to: number,
    extra: number,
  ): void;
  /** SCI2.1's colour remapping, recorded where it cannot yet be rendered. */
  remapColors?(sub: number, args: readonly number[]): void;
  /** Writes the game's own save into a slot, answering whether it went. */
  saveGame?(slot: number, description: string): boolean;
  /** Asks for a restore, which the host does between cycles rather than here. */
  restoreGame?(slot: number): boolean;
  /** SCI32's off-screen surfaces, which is how a SCI32 game draws text. */
  bitmapCreate?(width: number, height: number, skip: number, back: number): number;
  bitmapDestroy?(handle: number): void;
  bitmapFill?(
    handle: number,
    left: number,
    top: number,
    right: number,
    bottom: number,
    colour: number,
  ): void;
  bitmapSetOrigin?(handle: number, x: number, y: number): void;
  bitmapSize?(handle: number): { width: number; height: number } | null;
  bitmapDrawText?(
    handle: number,
    text: string,
    options: {
      x: number;
      y: number;
      maxWidth: number;
      colour: number;
      background: number;
      font: number;
    },
  ): void;
  /** A bitmap of a string, built from the object a script hands over. */
  textBitmap?(request: {
    text: string;
    width: number;
    height: number;
    font: number;
    fore: number;
    back: number;
    skip: number;
  }): number;
  /** The highest priority any Plane holds, which a script adds one to. */
  highestPlanePriority?(): number;
  /** The same for the items on one Plane. */
  highestItemPriority?(plane: string): number;
  /** Which MESSAGE modules this game ships, so a miss can say which kind it is. */
  messageModules?(): number[];
  /** How big the screen is, which `IsHiRes` asks about. */
  screenSize?(): { width: number; height: number } | null;
  /** Makes sure a palette resource is loaded, which `AssertPalette` asks for. */
  assertPalette?(number: number): void;
  /** Whether a resource is there, by type number and resource number. */
  resourcePresent?(type: number, number: number): boolean;
  /** How wide and tall a string is in a font, which scripts do arithmetic with. */
  measureText?(
    text: string,
    font: number,
    maxWidth: number,
  ): { width: number; height: number } | null;
  /** Draws a string into the room, which is what puts a game's interface on screen. */
  showText?(
    text: string,
    options: { x: number; y: number; font: number; colour: number; width: number },
  ): boolean;
  /**
   * Whether a script-space point lands on a live screen item, or null.
   *
   * Null when the object has no screen item, which is what tells `IsOnMe` to
   * fall back to the `nsRect` a SCI16 game keeps.
   */
  screenItemHit?(id: string, x: number, y: number, checkPixel: boolean): boolean | null;
  /**
   * Asks for a View a `SetNowSeen` needed and could not have, and to be asked
   * again once it has arrived.
   */
  deferNowSeen?(object: Reg, view: number): void;
  /** SCI32's compositor: a Plane the game's own object describes. */
  addPlane?(
    id: string,
    rect: { x: number; y: number; width: number; height: number },
    priority: number,
    /**
     * A Picture resource number, **or one of SCI32's four codes**.
     *
     * At or below 65531 it is a resource; above it, it says what kind of Plane
     * this is rather than what is on it (`PlanePictureCodes`, `plane32.h`).
     * Read as a number, King's Quest VII asked this project for "Picture 65535"
     * on every Plane it made and was told, correctly and uselessly, that the
     * game does not have one.
     */
    picture: number,
    /** The Plane's fill colour, which is what a coloured Plane is made of. */
    back: number,
  ): void;
  deletePlane?(id: string): void;
  /**
   * Where a Plane's rectangle sits, in the script's own space.
   *
   * `GlobalToLocal` and `LocalToGlobal` are the only callers, and what they
   * need is the **game** rectangle rather than the framebuffer one: a script
   * asks and answers in 320x200 whatever the game composites at.
   */
  planeOrigin?(id: string): { x: number; y: number } | null;
  /**
   * `AddPicAt` — another Picture onto a Plane, at an offset of its own.
   *
   * A SCI32 room's background is not always one Picture. `Plane::addPic`
   * appends a second Picture's cels to a Plane that already has one, displaced
   * by `(x, y)`, which is how a room composes scenery out of parts and how it
   * changes one part without redrawing the rest.
   *
   * King's Quest VII's first gameplay room is the plainest possible case and
   * it was a black screen: room 1250 draws nothing through the `picture`
   * property at all, and calls this once. Unimplemented, the Kernel call
   * answered nought and the room ran perfectly with no scenery in it.
   */
  addPicAt?(
    id: string,
    picture: number,
    x: number,
    y: number,
    mirrorX: boolean,
    deleteDuplicate: boolean,
  ): void;
  /**
   * Replace what a Plane is showing with one Picture, dropping what it had.
   *
   * `AddPicAt` above **adds** — a panoramic room is three Pictures side by side
   * on one Plane, and adding is how they get there. `SetScroll` is the other
   * shape: one Picture leaves and one arrives, and the Plane ends up carrying
   * only the new one. Separate hooks because "add" and "replace" differ by what
   * happens to what was already there, which is the whole of what the caller
   * is asking about.
   */
  setPlanePicture?(id: string, picture: number, mirrorX: boolean): void;
  /** One screen item on a Plane, which is a View cel at a position. */
  addScreenItem?(
    id: string,
    plane: string,
    item: {
      view: number;
      loop: number;
      cel: number;
      x: number;
      y: number;
      priority: number;
      /** A bitmap handle, which replaces the View when it is not nought. */
      bitmap?: number;
    },
  ): void;
  deleteScreenItem?(id: string): void;
  /** Composites what the Planes now hold, which is what `FrameOut` means. */
  frameOut?(): void;
  /**
   * Plays a video at the screen, which blocks until it ends or is skipped.
   *
   * Asked for here and opened between cycles, because opening reads a Volume
   * and a Kernel call happens in the middle of a send — the same arrangement
   * `scriptExport` uses for a script that is not loaded, and for the same
   * reason.
   */
  playMovie?(request: { file: string; x?: number; y?: number; ticksPerFrame?: number }): void;
  /** Ends the video on screen, which is what a `Close` sub-function means. */
  closeMovie?(): void;
  /**
   * A `sync36` resource's mouth timing, by the number its Message's tuple gives.
   *
   * Synchronous and therefore only answerable for a resource already read, the
   * same bargain `message` strikes and for the same reason. Null means "not
   * loaded yet", and the handler stops the sync rather than inventing timings —
   * a talker whose mouth is driven by made-up numbers is worse than one whose
   * mouth does not move.
   */
  syncSteps?(number: number): Array<{ time: number; cue: number }> | null;
  /** Where a video got to, for the scripts that ask between play calls. */
  movieStatus?(): { playing: boolean; frame: number };
  /**
   * Opens a Robot, which is **not** a video (#226).
   *
   * Separate from `playMovie` deliberately: a Robot is composited into a Plane
   * as a screen item, sorted and occluded like a View cel, and routing it
   * through "play this at the screen" is the second drawing path ADR 0015's
   * tripwire is about.
   */
  openRobot?(robot: number, plane: string, priority: number, x: number, y: number): void;
  robotStatus?(): { open: boolean; finished: boolean; frame: number };
  closeRobot?(): void;
  /**
   * A typed line, reduced to the word groups a `Said` matches.
   *
   * **SCI0 and SCI01 are parser-driven**, and `Parse` is the whole of how a
   * typed command reaches the game: the icon bar and the input window are
   * classes the game's own scripts build, and the only thing the interpreter
   * owes them is this reduction (`CONTEXT.md`, *Parser input*). The reader is
   * `resource/sciVocabulary.ts`, reached the way `message` reaches
   * `sciMessage.ts` — one reader, wired outside this file.
   *
   * Synchronous, and so answerable only for a `vocab.000` already read; null
   * means the game ships no main vocabulary, which is not an error — SCI1 and
   * later replaced the parser with an icon bar and ship none.
   */
  parseInput?(line: string): { groups: number[]; unknown: string[] } | null;
  /**
   * The game object, which is what `Parse` reports a failure *to*.
   *
   * Sierra's interpreter does not print "I don't know the word" itself: it
   * sends `wordFail` to the game object and the game's own script prints it
   * (`kParse`, `engines/sci/engine/kparse.cpp`). So the message is the game's
   * and reaching it needs the object the boot sent `play` to.
   */
  gameObject?(): Reg | null;
  /** Draws one of the game's own controls: a button, a label, an edit field. */
  showControl?(control: {
    x: number;
    y: number;
    width: number;
    height: number;
    text: string;
    font: number;
    type: number;
    state: number;
  }): void;
}

type Handler = (world: SciKernelWorld, args: Reg[]) => Reg;

/**
 * What `PlayVMD`'s open and init sub-functions said, until its play arrives.
 *
 * Held beside the world rather than inside it because it is not state the
 * engine has any use for: a file name that has been opened and not yet played
 * is `PlayVMD`'s own bookkeeping, and putting it on `SciKernelWorld` would make
 * every other Engine surface carry a field for one Kernel call's habits.
 */
const pendingVmd = new WeakMap<SciKernelWorld, string>();
const pendingVmdAt = new WeakMap<SciKernelWorld, { x: number; y: number }>();

/**
 * The block `Parse` writes a word it did not know into.
 *
 * Sierra's segment manager keeps exactly one of these per game and hands it to
 * `wordFail` as an argument, so the game's own script can print the word back
 * (`SegManager::getParserPtr`). One per world here for the same reason: a block
 * allocated per failed parse would leak one per typed command, and a player who
 * mistypes is the common case rather than the rare one.
 */
const parserBlock = new WeakMap<SciKernelWorld, Reg>();

/** Worlds that have already been told this game ships no `vocab.000`. */
const reportedNoVocabulary = new WeakSet<SciKernelWorld>();

/** Where a `DoSync` has got to in its resource, between `Next` calls. */
const syncCursor = new WeakMap<
  SciKernelWorld,
  { steps: Array<{ time: number; cue: number }>; at: number }
>();

const int = (value: number): Reg => reg(0, value & 0xffff);

/**
 * Sierra's "yes, and there is nothing to hand back" answer.
 *
 * `SIGNAL_OFFSET` is 0xffff in ScummVM (`vm_types.h`), and `SIGNAL_REG` is a
 * register holding it in segment nought. Distinct from nought, which several
 * calls use for "no", and distinct from a real number, which a script would go
 * on to use — `PalVary`'s `Init` is the case here.
 */
const SIGNAL_REG: Reg = reg(0, 0xffff);

/** Sierra's own `Display` attribute codes, from `sci.sh`. */
/** Sierra's control types, one-based, from ScummVM's `graphics/controls16.h`. */
const CONTROL_TEXTEDIT = 3;

/** The keys a text field acts on, as `GetEvent` reports them. */
const KEY_BACKSPACE = 8;
const KEY_ENTER = 13;
const KEY_HOME = 0x4700;
const KEY_END = 0x4f00;
const KEY_LEFT = 0x4b00;
const KEY_RIGHT = 0x4d00;

/**
 * `Display`'s attribute codes, transcribed from ScummVM's `paint16.cpp`.
 *
 * This file had three of them and two were wrong: font was recorded as 102,
 * which is the *pen colour*, and the foreground as 103, which is the
 * *background*. So a game asking for a font got a colour, a game asking for a
 * colour got a background it does not use, and the walk stopped at the first
 * code it did not know — which for King's Quest IV was the very first one.
 */
/** SCI16's screen, which `TextSize` wraps against when a game asks for nought. */
const SCI_SCREEN_WIDTH = 320;

const DS_MOVEPEN = 100;
const DS_ALIGNMENT = 101;
const DS_PEN_COLOUR = 102;
const DS_BACKGROUND = 103;
const DS_GREY = 104;
const DS_FONT = 105;
const DS_WIDTH = 106;
const DS_SAVE_UNDER = 107;
const DS_RESTORE_UNDER = 108;
const DS_DONT_SHOW = 121;
const DS_STROKE = 122;
const signed = (value: Reg): number =>
  value.offset > 0x7fff ? value.offset - 0x10000 : value.offset;

/**
 * `factor * sin(angle)`, truncated the way a C cast truncates.
 *
 * One place rather than four, because `SinMult`/`CosMult` and `TimesSin`/
 * `TimesCos` are the same two slots under the names two different Kernel
 * tables give them.
 */
function timesTrig(ratio: (radians: number) => number, args: Reg[]): Reg {
  const angle = signed(args[0] ?? NULL_REG);
  const factor = args.length > 1 ? signed(args[1]) : 1;
  return int(Math.trunc(ratio((angle * Math.PI) / 180) * factor));
}

/** The optional scale `TimesTan` and `TimesCot` take, which defaults to one. */
function trigScale(args: Reg[]): number {
  return args.length > 1 ? signed(args[1]) : 1;
}

/**
 * What to answer where the ratio has no reciprocal.
 *
 * Reported by name and angle, because a script reaching one is either doing
 * arithmetic this engine has misread or asking for something Sierra's own
 * interpreter could not answer either — and both are worth a line.
 */
function trigUndefined(world: SciKernelWorld, call: string, angle: number): Reg {
  world.log(
    `${call}(${angle}) is undefined — the tangent runs away at a quarter turn, and Sierra's ` +
      `own interpreter has no answer there either. Answering -1 rather than raising, so the ` +
      `trace survives.`,
  );
  return int(-1);
}

/** `value / sin(angle)` and `value / cos(angle)`, guarded at the pole. */
function trigDiv(
  world: SciKernelWorld,
  ratio: (radians: number) => number,
  args: Reg[],
  call: string,
): Reg {
  const angle = signed(args[0] ?? NULL_REG);
  const value = signed(args[1] ?? NULL_REG);
  const divisor = ratio((angle * Math.PI) / 180);
  // ScummVM's own window, not an epsilon chosen here: it treats anything
  // inside a ten-thousandth of nought as a division by zero.
  if (divisor < 0.0001 && divisor > -0.0001) return trigUndefined(world, call, angle);
  return int(Math.trunc(value / divisor));
}

/**
 * How tall SCI16's play area is, below the status bar and above the icon bar.
 *
 * 190 rather than 200, and it is Sierra's own number rather than a rounding:
 * `Intersections` clamps a backtracked line to `189` when extending it off the
 * screen, which is the last row a polygon can occupy.
 */
const SCI_PLAY_HEIGHT = 190;

/**
 * The slope Sierra uses for a vertical line, which is a sentinel and not a
 * number: `0x7fffffff` stands in for the division it cannot do.
 */
const VERTICAL = 0x7fffffff;

/**
 * A line's slope in centipixels, rounded the way Sierra rounds it.
 *
 * Thousandths, nudged half a hundredth away from zero, then divided down to
 * hundredths — which is round-half-away-from-zero at the scale the rest of
 * `Intersections` works in. Written out rather than done in floating point
 * because the two disagree in the last pixel, and the last pixel decides
 * whether a crossing lands on a segment or just past its end.
 */
function roundedSlope(rise: number, run: number): number {
  const thousandths = Math.trunc((1000 * rise) / run);
  return Math.trunc((thousandths >= 0 ? thousandths + 5 : thousandths - 5) / 10);
}

/**
 * Is a point inside the box two endpoints describe, give or take a pixel?
 *
 * The margin is Sierra's and is what makes the test usable: a crossing is
 * computed in centipixels and rounded back, so the point that lies exactly on
 * a segment's end can round a pixel past it. ScummVM's `PointInRect` grows the
 * rectangle by one for the same reason.
 */
function inRect(x: number, y: number, x1: number, y1: number, x2: number, y2: number): boolean {
  return (
    x >= Math.min(x1, x2) - 1 &&
    x <= Math.max(x1, x2) + 1 &&
    y >= Math.min(y1, y2) - 1 &&
    y <= Math.max(y1, y2) + 1
  );
}

/**
 * The two buffers `Intersections` reads points from and writes crossings into,
 * as word accessors.
 *
 * Words rather than bytes because a SCI buffer is an array of registers and
 * every index in the call is a *word* index — reading it as bytes would halve
 * every point's address. Null when either reference names nothing, which the
 * caller reports rather than answering a count it did not compute.
 */
function intersectionBuffers(
  world: SciKernelWorld,
  args: Reg[],
): { input: (index: number) => number; output: (index: number, value: number) => void } | null {
  const inputBytes = bytesAt(world, args[4] ?? NULL_REG);
  const outputBytes = bytesAt(world, args[8] ?? NULL_REG);
  if (!inputBytes || !outputBytes) {
    world.log(
      'Intersections was handed a buffer that names nothing, so no crossings were computed.',
    );
    return null;
  }
  return {
    input: (index) => {
      const at = index * 2;
      if (at + 1 >= inputBytes.length) return 0;
      const word = inputBytes.get(at) | (inputBytes.get(at + 1) << 8);
      return word > 0x7fff ? word - 0x10000 : word;
    },
    output: (index, value) => {
      const at = index * 2;
      if (at + 1 >= outputBytes.length) return;
      outputBytes.set(at, value & 0xff);
      outputBytes.set(at + 1, (value >> 8) & 0xff);
    },
  };
}

/**
 * Sierra's end marker in a polygon point buffer.
 *
 * A polygon's points are not counted in the buffer: the walk reads pairs until
 * it meets this x, which is why a buffer with no terminator has to be stopped
 * by its own length rather than by its contents.
 */
const POLY_LAST_POINT = 0x7777;

/** How wide one point is in a polygon buffer: two 16-bit words. */
const POLY_POINT_SIZE = 4;

/**
 * The one polygon type whose vertices run the other way.
 *
 * Sierra orders a *contained access* polygon — the one an actor may only walk
 * inside — clockwise, and every other type anti-clockwise. `fixVertexOrder`
 * exists for exactly this, and getting it wrong reverses which side of each
 * edge counts as inside.
 */
const POLY_CONTAINED_ACCESS = 3;

/** A whole-pixel point, which is what a polygon buffer holds. */
interface PolyPoint {
  x: number;
  y: number;
}

/**
 * One arithmetic step at C's `float` width rather than JavaScript's double.
 *
 * **Not decoration.** ScummVM does `kMergePoly`'s geometry in `float`, and
 * every input to it is a small integer that a `float` holds exactly — so the
 * only place the two widths can disagree is the rounding of a division, and
 * the quotient is then multiplied out and rounded to a whole pixel. A double
 * that lands a half-ulp the other side of `.5` moves a vertex by a pixel, and a
 * polygon's vertex moving by a pixel is the difference between an edge that
 * intersects the next one and an edge that does not. Applied per operation,
 * because `fround` of a whole expression is not the same as `float` arithmetic
 * through it.
 */
const f32 = Math.fround;

/** Twice the signed area of a triangle, which is Sierra's `area`. */
function triangleArea(a: PolyPoint, b: PolyPoint, c: PolyPoint): number {
  return (b.x - a.x) * (a.y - c.y) - (c.x - a.x) * (a.y - b.y);
}

const collinear = (a: PolyPoint, b: PolyPoint, c: PolyPoint): boolean =>
  triangleArea(a, b, c) === 0;

const samePoint = (a: PolyPoint, b: PolyPoint): boolean => a.x === b.x && a.y === b.y;

/**
 * The squared distance between two points, with ScummVM's own overflow guard.
 *
 * The guard cannot fire on a 320-by-190 play field and is carried anyway,
 * because `liesBefore` subtracts two of these and a reader comparing this
 * against `Common::Point::sqrDist` should find the same function rather than a
 * tidied one.
 */
function sqrDist(a: PolyPoint, b: PolyPoint): number {
  const dx = Math.abs(b.x - a.x);
  if (dx >= 0x1000) return 0xffffff;
  const dy = Math.abs(b.y - a.y);
  if (dy >= 0x1000) return 0xffffff;
  return dx * dx + dy * dy;
}

/**
 * The squared distance from a point to a segment — squared, despite Sierra's
 * own name for it saying otherwise.
 *
 * Two cases, and the branch is the projection test: where the foot of the
 * perpendicular lies between the endpoints the answer is the distance to the
 * line, and where it does not the answer is the distance to the nearer end.
 *
 * A zero-length segment divides by zero here and answers `NaN`, which every
 * comparison against it is false for — the same thing C does with the same
 * inputs, and the reason the caller's own zero-length check is the guard rather
 * than this.
 */
function pointSegSqrDistance(a: PolyPoint, b: PolyPoint, p: PolyPoint): number {
  const bax = b.x - a.x;
  const bay = b.y - a.y;
  const pax = p.x - a.x;
  const pay = p.y - a.y;
  const baDotPa = bax * pax + bay * pay;
  const baDotBp = bax * (b.x - p.x) + bay * (b.y - p.y);

  if (baDotPa >= 0 && baDotBp >= 0) {
    const scale = f32(baDotPa / (bax * bax + bay * bay));
    const dx = f32(f32(bax * scale) - pax);
    const dy = f32(f32(bay * scale) - pay);
    return f32(f32(dx * dx) + f32(dy * dy));
  }
  return Math.min(pax * pax + pay * pay, (p.x - b.x) ** 2 + (p.y - b.y) ** 2);
}

/**
 * Where two segments cross, as a fraction of each, or null where they do not.
 *
 * Sierra's own asymmetry is kept: the first segment's parameter is accepted at
 * its endpoints (`0 <= s <= 1`) and the second's is not (`0 < t < 1`). So an
 * edge that ends exactly on another edge counts one way round and not the
 * other, which is what makes `segSegIntersect`'s enter and exit tests answer
 * differently for the same pair of edges.
 */
function segmentCrossing(a: PolyPoint, b: PolyPoint, c: PolyPoint, d: PolyPoint): PolyPoint | null {
  const denom = f32(a.x * (d.y - c.y) + b.x * (c.y - d.y) + d.x * (b.y - a.y) + c.x * (a.y - b.y));
  if (denom === 0) return null;

  const s = f32(f32(a.x * (d.y - c.y) + c.x * (a.y - d.y) + d.x * (c.y - a.y)) / denom);
  const t = f32(-f32(a.x * (c.y - b.y) + b.x * (a.y - c.y) + c.x * (b.y - a.y)) / denom);
  if (s < 0 || s > 1 || t <= 0 || t >= 1) return null;

  return { x: f32(a.x + f32(s * (b.x - a.x))), y: f32(a.y + f32(s * (b.y - a.y))) };
}

/**
 * A crossing rounded back to a whole pixel, the way a C cast rounds it.
 *
 * Half is added and the fraction thrown away, which is round-half-up for a
 * positive coordinate and round-half-*down* for a negative one. Truncation
 * rather than `Math.round` because the two disagree at exactly the values a
 * polygon edge lands on most often.
 */
const toWholePixel = (p: PolyPoint): PolyPoint => ({
  x: Math.trunc(p.x + 0.5),
  y: Math.trunc(p.y + 0.5),
});

/** Is `q` between `a` and `b`, measured along whichever axis the segment spans? */
function betweenOnAxis(a: PolyPoint, b: PolyPoint, q: PolyPoint): boolean {
  if (a.x !== b.x) return (a.x <= q.x && q.x <= b.x) || (b.x <= q.x && q.x <= a.x);
  return (a.y <= q.y && q.y <= b.y) || (b.y <= q.y && q.y <= a.y);
}

/**
 * Where the edge `a→b` meets the edge `c→d`, with the endpoint cases decided
 * by hand.
 *
 * **The endpoint cases are the call.** Two polygons that touch at a vertex, or
 * whose edges lie along each other, are the ordinary case when one room's
 * obstacle is extended to cover another — so Sierra answers those before it
 * reaches any general line arithmetic, and answers them asymmetrically: `c`
 * lying on `a→b` is a crossing and `d` lying on it is not. That asymmetry is
 * what stops a shared vertex being counted twice as the walk goes round.
 *
 * Answers the point as well as whether there was one, and the point can come
 * back with no crossing: C passes it by reference and leaves what the failing
 * branch wrote, and the caller genuinely reads that in one path. Null means
 * "unchanged" so the caller can reproduce it rather than approximate it.
 */
function segSegIntersect(
  a: PolyPoint,
  b: PolyPoint,
  c: PolyPoint,
  d: PolyPoint,
  log: (message: string) => void,
): { hit: boolean; point: PolyPoint | null } {
  // Lying entirely along each other is not a crossing: there is no one point to
  // answer with, and the walk that called this will meet the same edges again
  // at their ends.
  if (collinear(a, b, c) && collinear(a, b, d)) return { hit: false, point: null };

  let point: PolyPoint | null = null;
  if (collinear(a, b, c)) {
    point = c;
    if (betweenOnAxis(a, b, c)) return { hit: true, point };
  }
  if (collinear(a, b, d)) {
    point = d;
    if (betweenOnAxis(a, b, d)) return { hit: false, point };
  }

  if (sqrDist(c, d) === 0) {
    // ScummVM stops the interpreter here. This engine reports and declines the
    // pair, for the reason every other guard in this file does: a halt loses
    // every later finding in the same run.
    log('MergePoly met a polygon edge of zero length, so that edge was not intersected.');
    return { hit: false, point };
  }

  // Within a pixel and a half of an end counts as meeting it. Sierra's own
  // slack, and the reason a vertex shared by two polygons is found rather than
  // missed by the rounding either side of it.
  if (pointSegSqrDistance(c, d, a) <= 2) return { hit: true, point: a };
  if (pointSegSqrDistance(c, d, b) <= 2) return { hit: true, point: b };

  const crossing = segmentCrossing(a, b, c, d);
  return crossing ? { hit: true, point: toWholePixel(crossing) } : { hit: false, point };
}

/**
 * Which way the second edge crosses the first: positive entering, negative
 * leaving, zero parallel. The z of the cross product of the two directions.
 */
function intersectDir(
  work: readonly PolyPoint[],
  wi: number,
  poly: readonly PolyPoint[],
  pi: number,
): number {
  const w1 = work[wi] as PolyPoint;
  const w2 = work[(wi + 1) % work.length] as PolyPoint;
  const p1 = poly[pi] as PolyPoint;
  const p2 = poly[(pi + 1) % poly.length] as PolyPoint;
  return (w2.x - w1.x) * (p2.y - p1.y) - (p2.x - p1.x) * (w2.y - w1.y);
}

/**
 * An edge's direction in whole degrees from the x axis, between -180 and 180.
 *
 * Rounded towards zero at `float` width because ScummVM's `rad2deg<float,int>`
 * is a `float` multiply and a C cast, and the sum of these across a run of
 * edges decides whether a patch is kept — so a degree either way is a patch
 * either way.
 */
function edgeDir(from: PolyPoint, to: PolyPoint): number {
  let deg = Math.trunc(f32(f32(Math.atan2(to.y - from.y, to.x - from.x)) * f32(57.2957795130823)));
  if (deg < -180) deg += 360;
  if (deg > 180) deg -= 360;
  return deg;
}

/** Negative when `p1` comes first along the edge leaving `v`, positive after. */
const liesBefore = (v: PolyPoint, p1: PolyPoint, p2: PolyPoint): number =>
  sqrDist(v, p1) - sqrDist(v, p2);

/**
 * One extension of the work polygon that follows the merged polygon instead.
 *
 * It leaves the work polygon at `intersection1`, where work edge `indexw1`
 * meets polygon edge `indexp1`, and rejoins it at `intersection2` on work edge
 * `indexw2` and polygon edge `indexp2`. `disabled` is set when a later patch
 * turns out to cover this one.
 */
interface Patch {
  indexw1: number;
  indexp1: number;
  intersection1: PolyPoint;
  indexw2: number;
  indexp2: number;
  intersection2: PolyPoint;
  disabled: boolean;
}

/** Does this patch bypass work vertex `wi`, so the merged outline omits it? */
function isVertexCovered(work: readonly PolyPoint[], patch: Patch, wi: number): boolean {
  if (wi > patch.indexw1 && wi <= patch.indexw2) return true;
  // The patch wraps past the end of the work polygon's vertex list.
  if (patch.indexw1 > patch.indexw2 && (wi <= patch.indexw2 || wi > patch.indexw1)) return true;
  // Both ends on one edge, leaving after it rejoins: this patch covers *every*
  // vertex of the work polygon.
  if (
    patch.indexw1 === patch.indexw2 &&
    liesBefore(work[patch.indexw1] as PolyPoint, patch.intersection1, patch.intersection2) > 0
  ) {
    return true;
  }
  return false;
}

/**
 * Does patch `p1` make patch `p2` superfluous?
 *
 * Transcribed whole from ScummVM's `isPatchCovered`, including the three
 * comparisons its own comments mark `CHECKME` as possibly meaningless. They are
 * kept because Sierra's scripts were written against whatever this does, and a
 * tidied version of an algorithm ScummVM describes as "a bit error-prone"
 * differs from the games rather than from the bug.
 */
function isPatchCovered(work: readonly PolyPoint[], p1: Patch, p2: Patch): boolean {
  if (
    samePoint(p1.intersection1, p2.intersection1) &&
    samePoint(p1.intersection2, p2.intersection2)
  )
    return true;

  // p2 leaves the work polygon somewhere p1 has already left it.
  if (p1.indexw1 < p2.indexw1 && p2.indexw1 < p1.indexw2) return true;
  if (p1.indexw1 > p1.indexw2 && (p2.indexw1 > p1.indexw1 || p2.indexw1 < p1.indexw2)) return true;

  // p2 rejoins somewhere p1 has already left it.
  if (p1.indexw1 < p2.indexw2 && p2.indexw2 < p1.indexw2) return true;
  if (p1.indexw1 > p1.indexw2 && (p2.indexw2 > p1.indexw1 || p2.indexw2 < p1.indexw2)) return true;

  // The same two tests the other way round: p2 covers p1, so p1 does not cover
  // p2 and the answer is settled without looking at the order along an edge.
  if (p2.indexw1 < p1.indexw1 && p1.indexw1 < p2.indexw2) return false;
  if (p2.indexw1 > p2.indexw2 && (p1.indexw1 > p2.indexw1 || p1.indexw1 < p2.indexw2)) return false;
  if (p2.indexw1 < p1.indexw2 && p1.indexw2 < p2.indexw2) return false;
  if (p2.indexw1 > p2.indexw2 && (p1.indexw2 > p2.indexw1 || p1.indexw2 < p2.indexw2)) return false;

  // Everything above compared whole edges. What is left is two patches whose
  // ends share an edge, and there the order along that edge decides.
  if (p1.indexw1 !== p1.indexw2) {
    if (p1.indexw1 === p2.indexw1) {
      return liesBefore(work[p1.indexw1] as PolyPoint, p1.intersection1, p2.intersection1) < 0;
    }
    if (p1.indexw2 === p2.indexw1) {
      return liesBefore(work[p1.indexw2] as PolyPoint, p1.intersection2, p2.intersection1) > 0;
    }
    // Neither end shared: the stretches the two patches cover are disjoint.
    return false;
  }

  const v1 = work[p1.indexw1] as PolyPoint;
  const v2 = work[p2.indexw1] as PolyPoint;
  if (liesBefore(v1, p1.intersection1, p1.intersection2) > 0) return p1.indexw1 !== p2.indexw1;
  if (liesBefore(v2, p2.intersection1, p2.intersection2) > 0) return false;
  if (liesBefore(v2, p2.intersection1, p1.intersection1) <= 0) return false;
  if (liesBefore(v2, p2.intersection1, p1.intersection2) >= 0) return false;
  return true;
}

/** A circular list reversed in place, which keeps its head and turns the rest. */
const reverseCircular = (vertices: readonly PolyPoint[]): PolyPoint[] => [
  vertices[0] as PolyPoint,
  ...vertices.slice(1).reverse(),
];

/** The same circular list read from its second vertex, which is `_head = _head->_next`. */
const rotateHead = (vertices: readonly PolyPoint[]): PolyPoint[] => [
  ...vertices.slice(1),
  vertices[0] as PolyPoint,
];

/**
 * Twice the polygon's signed area: positive anti-clockwise, negative clockwise.
 *
 * Fanned from the first vertex rather than by the shoelace sum, because that is
 * how Sierra does it and the two differ for a self-intersecting polygon — which
 * is exactly what a half-merged obstacle is.
 */
function polygonArea(vertices: readonly PolyPoint[]): number {
  let total = 0;
  for (let index = 1; index + 1 < vertices.length; index++) {
    total += triangleArea(
      vertices[0] as PolyPoint,
      vertices[index] as PolyPoint,
      vertices[index + 1] as PolyPoint,
    );
  }
  return total;
}

/** Turns a polygon's vertices the way its type says they should run. */
function fixVertexOrder(type: number, vertices: PolyPoint[]): PolyPoint[] {
  const area = polygonArea(vertices);
  const wrongWay =
    (area > 0 && type === POLY_CONTAINED_ACCESS) || (area < 0 && type !== POLY_CONTAINED_ACCESS);
  return wrongWay ? reverseCircular(vertices) : vertices;
}

/** One point out of a polygon buffer, or null past its end. */
function readPolyPoint(bytes: SciByteView, index: number): PolyPoint | null {
  const at = index * POLY_POINT_SIZE;
  if (at + 3 >= bytes.length) return null;
  const word = (offset: number): number => {
    const value = bytes.get(offset) | (bytes.get(offset + 1) << 8);
    return value > 0x7fff ? value - 0x10000 : value;
  };
  return { x: word(at), y: word(at + 2) };
}

function writePolyPoint(bytes: SciByteView, index: number, point: PolyPoint): void {
  const at = index * POLY_POINT_SIZE;
  if (at + 3 >= bytes.length) return;
  bytes.set(at, point.x & 0xff);
  bytes.set(at + 1, (point.x >> 8) & 0xff);
  bytes.set(at + 2, point.y & 0xff);
  bytes.set(at + 3, (point.y >> 8) & 0xff);
}

/**
 * One polygon out of the game's own object, through its own Selector table.
 *
 * By name and never by index, for the reason `setProperty` gives: which
 * property number `points` is differs per game. A polygon whose `size` is nought
 * is skipped rather than read as empty, which is Sierra's own answer and not a
 * guard added here.
 *
 * The vertices arrive *reversed*, because Sierra builds the list by inserting
 * each point at its head. That is not tidied away: `MergePoly` then reverses it
 * again and steps the head on by one, and a list that started the right way
 * round would come out of those two operations rotated by one vertex.
 */
function convertPolygon(
  world: SciKernelWorld,
  object: SciObject,
): { type: number; vertices: PolyPoint[] } | null {
  let points = readPropertyReg(world, object, 'points');
  // SCI2 onwards keeps the points in an array object rather than in a buffer,
  // and reaches them through its `data` property. Followed here so that the one
  // handler is not silently wrong at the Versions whose tables also name this
  // call — it is the same Kernel call at both, and only the indirection moved.
  const holder = world.machine.object(points);
  if (holder) points = readPropertyReg(world, holder, 'data');

  const size = readProperty(world, object, 'size');
  if (size === 0) return null;

  const bytes = bytesAt(world, points);
  if (!bytes) {
    world.log('MergePoly met a polygon whose points name nothing, so it was skipped.');
    return null;
  }
  if (bytes.length < size * POLY_POINT_SIZE) {
    world.log(
      `MergePoly met a polygon claiming ${size} points in a buffer of ${bytes.length} bytes, ` +
        `so it was skipped rather than read past its end.`,
    );
    return null;
  }

  const vertices: PolyPoint[] = [];
  for (let index = 0; index < size; index++) {
    const point = readPolyPoint(bytes, index);
    if (!point) break;
    vertices.unshift(point);
  }
  const type = readProperty(world, object, 'type');
  return { type, vertices: fixVertexOrder(type, vertices) };
}

/** The point a default-constructed `Common::Point` is, which C leaves at nought. */
const POLY_ORIGIN: PolyPoint = { x: 0, y: 0 };

/**
 * Extends `work` to cover `poly`, or answers null when the two do not meet.
 *
 * **Two passes, and the first is the one that does the thinking.** It walks
 * every pair of edges looking for a place where the polygon's edge *leaves* the
 * work outline, then searches forward for where it comes back in, and records
 * the pair as a `Patch`. A patch is kept only if the polygon turns the right
 * way between the two — `angle`, summed from the relative direction of each
 * edge — which is what distinguishes a detour round the outside from one
 * through the inside. The second pass walks the work outline and steps onto the
 * polygon wherever a patch says to.
 *
 * **Transcribed from ScummVM's `mergeSinglePolygon` and kept faithful to the
 * parts it says are wrong.** Its own comment: the strategy "matches qfg1new
 * closely, and is a bit error-prone", the search can skip a re-entry when the
 * right patch would use a single partial edge, and the order patches are
 * applied in is marked `CHECKME`. A corrected version would disagree with the
 * scripts rather than with the bug, and with no SCI game data mounted there is
 * nothing here that could tell a correction from a mistake. So it is copied,
 * and the divergences it does have are these two: a zero-length edge is
 * reported rather than halting the interpreter, and a ninth patch is reported
 * and dropped where ScummVM stops the game.
 */
function mergeSinglePolygon(
  work: readonly PolyPoint[],
  poly: readonly PolyPoint[],
  log: (message: string) => void,
): PolyPoint[] | null {
  const workSize = work.length;
  const polygonSize = poly.length;
  if (workSize === 0 || polygonSize === 0) return null;

  const workEdge = (index: number): [PolyPoint, PolyPoint] => [
    work[index % workSize] as PolyPoint,
    work[(index + 1) % workSize] as PolyPoint,
  ];
  const polyEdge = (index: number): [PolyPoint, PolyPoint] => [
    poly[index % polygonSize] as PolyPoint,
    poly[(index + 1) % polygonSize] as PolyPoint,
  ];

  const patches: Patch[] = [];
  let full = false;

  for (let wi = 0; wi < workSize && !full; wi++) {
    for (let pi = 0; pi < polygonSize && !full; pi++) {
      let intersection1 = POLY_ORIGIN;
      const leaving = segSegIntersect(...workEdge(wi), ...polyEdge(pi), log);
      if (leaving.point) intersection1 = leaving.point;
      if (!leaving.hit) continue;
      // A positive turn is the polygon's edge coming *in*, and the patch being
      // looked for starts where it goes out.
      if (intersectDir(work, wi, poly, pi) >= 0) continue;

      // Now find where it comes back. The search starts at the polygon's next
      // edge, which is Sierra's own choice and the reason a patch using a single
      // partial edge of the polygon is skipped rather than found.
      let angle = 0;
      let baseAngle = edgeDir(...workEdge(wi));
      let intersects = false;
      let intersection2 = POLY_ORIGIN;
      // Both counters are read after the walk, and both are meant to hold the
      // *size* when the walk found nothing — which is what turns the re-entry
      // into the edge the search started on. Written as `while` loops rather
      // than `for` loops so that value survives into the patch below.
      let pi2 = 0;
      let rejoinAtWork = 0;

      while (pi2 < polygonSize) {
        const polyAt = (pi + 1 + pi2) % polygonSize;
        const newAngle = edgeDir(...polyEdge(polyAt));
        let relative = newAngle - baseAngle;
        if (relative > 180) relative -= 360;
        if (relative < -180) relative += 360;
        angle += relative;
        baseAngle = newAngle;

        let wi2 = 0;
        while (wi2 < workSize) {
          const workAt = (wi + wi2) % workSize;
          const rejoining = segSegIntersect(...workEdge(workAt), ...polyEdge(polyAt), log);
          if (rejoining.point) intersection2 = rejoining.point;
          intersects = rejoining.hit;
          if (intersects && intersectDir(work, workAt, poly, polyAt) > 0) break;
          wi2++;
        }
        rejoinAtWork = wi2;
        if (intersects) break;
        pi2++;
      }

      // No way back, or the polygon turned the wrong way getting there: this is
      // a crossing rather than a detour, and there is nothing to patch.
      if (!intersects || angle < 0) continue;

      if (patches.length >= 8) {
        log(
          'MergePoly found more than eight patches on one polygon and kept the first eight. ' +
            'Sierra stops the interpreter here, so the merged outline below is this engine ' +
            'carrying on rather than an answer a game has ever seen.',
        );
        full = true;
        continue;
      }

      const patch: Patch = {
        indexw1: wi,
        indexp1: pi,
        intersection1,
        indexw2: (wi + rejoinAtWork) % workSize,
        indexp2: (pi + 1 + pi2) % polygonSize,
        intersection2,
        disabled: false,
      };

      if (patches.length === 0) {
        patches.push(patch);
        continue;
      }
      if (patches.some((existing) => isPatchCovered(work, existing, patch))) continue;
      patches.push(patch);
      for (let index = 0; index < patches.length - 1; index++) {
        const existing = patches[index] as Patch;
        if (isPatchCovered(work, patch, existing)) existing.disabled = true;
      }
    }
  }

  if (patches.length === 0) return null;

  // The walk: every work vertex a patch does not bypass, and at each patch's
  // start the polygon's own vertices between its two intersections.
  const output: PolyPoint[] = [];
  for (let wi = 0; wi < workSize; wi++) {
    const covered = patches.some((patch) => !patch.disabled && isVertexCovered(work, patch, wi));
    if (!covered) output.push(work[wi] as PolyPoint);

    for (const patch of patches) {
      if (patch.disabled || patch.indexw1 !== wi) continue;
      if (!samePoint(patch.intersection1, work[wi] as PolyPoint)) output.push(patch.intersection1);
      for (
        let index = (patch.indexp1 + 1) % polygonSize;
        index !== patch.indexp2;
        index = (index + 1) % polygonSize
      ) {
        output.push(poly[index] as PolyPoint);
      }
      const rejoin = poly[patch.indexp2] as PolyPoint;
      output.push(rejoin);
      if (!samePoint(patch.intersection2, rejoin)) output.push(patch.intersection2);
    }
  }

  if (
    output.length > 1 &&
    samePoint(output[0] as PolyPoint, output[output.length - 1] as PolyPoint)
  )
    output.pop();
  return output;
}

/**
 * The Kernel calls Sierra shipped that a retail game never makes.
 *
 * **Answered once rather than fourteen times, because they are one decision.**
 * Nine of them are Sierra's own debugger reaching into the interpreter —
 * `ShowSends` prints the send trace, `ShowObjs` and `ShowFree` dump the heap,
 * `InspectObj` opens an object, `Profiler` and `StackUsage` measure, `Record`
 * and `PlayBack` drive Sierra's input recorder. The other two are slots
 * ScummVM's own table annotates "never called?" — `ShiftScreen` and `ListOps`
 * — and `ATan`, which its table maps to a dummy as well.
 *
 * All eleven are `MAP_DUMMY` in ScummVM's `s_kernelMap`
 * (`engines/sci/engine/kernel_tables.h`, fetched 2026-09-12), which is the
 * strongest evidence available without a game: an interpreter that has run
 * every SCI title there is has never needed to implement one.
 *
 * **What a handler here is, and what it is not.** It logs by name and answers
 * zero, so a game that does reach one keeps running instead of halting at the
 * one call whose result nothing reads. It is *not* an implementation, and
 * nothing in this repository may count it as one:
 * `kernelCoverage.ts` reports these in a column of their own and
 * `npm run sweep:sci -- --kernel-coverage` prints that column separately. A
 * report that merged them would be claiming eleven calls this project has
 * written no behaviour for.
 *
 * A game that really does call one is a finding rather than a nuisance, and the
 * log says so: either the Version is wrong — which for SCI is the failure that
 * shows up nowhere else — or this list is.
 */
export const SCI_UNUSED_KERNEL_NAMES: readonly string[] = [
  // SCI32's own, read from `kernel_tables.h`'s `MAP_DUMMY` the same way SCI16's
  // were: names Sierra shipped that no retail game is known to call. They were
  // counted as *absent* before, which made SCI32's published gap larger than the
  // work left in it.
  'AddMagnify',
  'DeleteMagnify',
  'BaseLineSpan',
  'CelRect',
  'DeletePic',
  'GetSierraProfileString',
  'Priority',
  'Table',
  'InspectObject',
  'MonoOut',
  'SetFatalStr',
  'MarkMemory',
  'IntegrityChecking',
  'CheckIntegrity',
  'PreloadResource',
  'FindSelector',
  'FindClass',

  'InspectObj',
  'ShowSends',
  'ShowObjs',
  'ShowFree',
  'StackUsage',
  'Profiler',
  'Record',
  'PlayBack',
  'ATan',
  'ShiftScreen',
  'ListOps',
];

/**
 * The calls that answer the same value whatever a game passes them.
 *
 * **Why this is a column and not a footnote.** The count this file's coverage
 * module publishes used to read "implemented" as *a handler exists under this
 * name*, and a key is not a behaviour. When this column was introduced
 * `DoSound`, `Parse`, `Said`, `SaveGame`, `RestoreGame`, `Graph` and `Palette`
 * were each `() => int(0)`; four of the seven have since gained behaviour and
 * `Said`, `Graph` and `Palette` have not. Every one of them was counted beside
 * `Format` and `DrawPic`, which do the work their
 * names describe, and the effect was a figure that could only ever go up:
 * registering `MergePoly: () => NULL_REG` would have closed the SCI16 gap
 * outright without a line of polygon arithmetic being written. That is the
 * trade the three-column table was built to refuse, applied to the eleven calls
 * nobody makes and not to the fifty-four a game makes constantly.
 *
 * **What the list means, and what it does not.** It means exactly one
 * mechanically checked thing: called with arguments, the handler reads none of
 * them, touches nothing on the world, and returns a constant.
 * `tests/sci-kernel-coverage.test.ts` probes every handler and fails if this
 * list is not precisely the set that behaves that way, so it cannot drift and
 * no judgement enters it.
 *
 * It is **not** a list of defects. Some of these are the finished answer:
 * `SetVideoMode` has a VGA planar mode to leave that no renderer here has,
 * `CanBeHere` and `CantBeHere` answer permissively on purpose because a refusal
 * hangs `findPosn`, `HaveMouse` says there is a mouse, and `UnLoad`, `Lock` and
 * `FlushResources` manage a resource cache this interpreter does not keep. Each
 * of those carries its reasoning where it is written. Others — `Said`,
 * `Graph`, `Palette`, the menu calls — are whole surfaces with
 * nothing behind them yet.
 *
 * Sorting those two apart is a judgement per call, and it is not made here: the
 * column reports the measurement, and a call leaves it by gaining behaviour
 * rather than by being argued about. **`DoSound` and `Parse` have both left it
 * that way**, which is the only way out: `DoSound` because a sound object's
 * `handle` is written by `kDoSoundPlay` and by nothing else, so a constant
 * there is not a silence but a cue the game waits on forever. What the column buys is that a number
 * claiming this engine answers 120 of SCI1's 137 calls can no longer be read as
 * 120 calls that do something.
 */
export const SCI_CONSTANT_KERNEL_NAMES: readonly string[] = [
  // SCI32's `MAP_EMPTY` four and `Purge`. A game calls each and there is
  // nothing for this host to do — a debug hook, a Windows title bar, a
  // force-feedback mouse, a memory tracker, and a resource flush over a
  // cache that is not under memory pressure. Finished answers, declared
  // here so the probe agrees with the list rather than the list with the
  // probe.
  'NewRoom',
  'SetWindowsOption',
  'VibrateMouse',
  'ResourceTrack',
  'Purge',
  // Answers 100 because `SetShowStyle` finishes a transition immediately, so
  // a script polling it is always told the transition is over. ScummVM marks
  // it `MAP_DUMMY`; it is answered here rather than left in the unused group
  // because a script that polls it and is told nought forever is the hang the
  // pair exists to avoid.
  'ShowStylePercent',

  'AddMenu',
  'AddToPic',
  'CanBeHere',
  'CantBeHere',
  'CheckSaveGame',
  'DbugStr',
  'DeviceInfo',
  'DirLoop',
  'DisposeScript',
  'DoAudio',
  'DoAvoider',
  'DrawCel',
  'DrawMenuBar',
  'DrawStatus',
  'Empty',
  'FlushResources',
  'GameIsRestarting',
  'GetMenu',
  'GetSaveFiles',
  'Graph',
  'HaveMouse',
  'HiliteControl',
  'Joystick',
  'Lock',
  'MemoryInfo',
  'MemorySegment',
  'MenuSelect',
  'OnControl',
  'Palette',
  'Platform',
  'RepaintPlane',
  'RestartGame',
  'Said',
  'SetDebug',
  'SetJump',
  'SetMenu',
  'SetQuitStr',
  'SetSynonyms',
  'SetVideoMode',
  'ShakeScreen',
  'Show',
  'UnLoad',
  'ValidPath',
];

/** Which of the unused calls a world has already reported, so a loop reports once. */
const reportedUnused = new WeakMap<SciKernelWorld, Set<string>>();

/** The same, for a finding a running game can produce every cycle. */
const reportedOnce = new WeakMap<SciKernelWorld, Set<string>>();

/** Says something the first time, and nothing the thousand times after it. */
function reportOnce(world: SciKernelWorld, key: string, message: string): void {
  let seen = reportedOnce.get(world);
  if (!seen) {
    seen = new Set();
    reportedOnce.set(world, seen);
  }
  if (seen.has(key)) return;
  seen.add(key);
  world.log(message);
}

const SCI_KERNEL_UNUSED: Readonly<Record<string, Handler>> = Object.fromEntries(
  SCI_UNUSED_KERNEL_NAMES.map((name): [string, Handler] => [
    name,
    (world) => {
      let seen = reportedUnused.get(world);
      if (!seen) {
        seen = new Set();
        reportedUnused.set(world, seen);
      }
      if (!seen.has(name)) {
        seen.add(name);
        world.log(
          `${name} is one of the ${SCI_UNUSED_KERNEL_NAMES.length} Kernel calls Sierra shipped ` +
            `and no retail game is known to make — its own debugger's surface, plus the slots ` +
            `ScummVM's table marks "never called?". It has answered zero, and nothing is ` +
            `implemented behind it. A game genuinely calling this is a finding: either the ` +
            `Version is wrong or that list is.`,
        );
      }
      return NULL_REG;
    },
  ]),
);

/**
 * The calls this engine answers, by the name the Kernel table gives them.
 *
 * Grouped by what they are rather than by number, because the numbers differ
 * per Version and the meanings do not.
 */
/** One entry of a Message cursor: the tuple being walked, with a moving `seq`. */
interface MessageCursor {
  noun: number;
  verb: number;
  cond: number;
  seq: number;
}

/**
 * Where a game is in the words it is saying, which SCI keeps and this did not.
 *
 * Sierra's `MessageState` holds a **stack** of cursors and a stack of those
 * stacks. `get` initialises the cursor and reads; `next` reads where the cursor
 * points and steps `seq` on by one, so a conversation is one `get` and then
 * `next` until it answers nothing. A record that carries a reference pushes
 * that reference on top, so a line that continues into another sequence returns
 * to the first when the second runs out — which is why a stack rather than a
 * single tuple. `push` and `pop` save and restore the whole cursor, for a game
 * that interrupts itself with a second conversation.
 *
 * Held per world, like the other Kernel state in this file.
 */
interface MessageStacks {
  module: number;
  cursor: MessageCursor[];
  saved: Array<{ module: number; cursor: MessageCursor[] }>;
  lastModule: number;
  last: MessageCursor | null;
}

const messageState = new WeakMap<SciKernelWorld, MessageStacks>();

function messageStacks(world: SciKernelWorld): MessageStacks {
  let held = messageState.get(world);
  if (!held) {
    held = { module: 0, cursor: [], saved: [], lastModule: 0, last: null };
    messageState.set(world, held);
  }
  return held;
}

/**
 * The record the cursor points at, following references and popping dead ends.
 *
 * `Sierra's MessageState::getRecord`. Two rules that are easy to get wrong and
 * are both load-bearing:
 *
 * - a tuple that is **not found** pops the stack and retries, but only while
 *   something is under it — that is how a referenced sequence ending returns to
 *   the one that referenced it;
 * - a record **carrying** a reference steps the referring `seq` on first and
 *   then pushes, so the pop lands after the reference rather than on it.
 *
 * `walk` false reads without moving anything, which is what a `next` with no
 * buffer wants: the game is asking who speaks next, not asking for the line.
 */
function messageRecordAt(
  world: SciKernelWorld,
  stacks: MessageStacks,
  walk: boolean,
): { text: string; talker: number; tuple: MessageCursor } | null {
  const cursor = walk ? stacks.cursor : stacks.cursor.map((one) => ({ ...one }));
  // A limit rather than a `while (true)`: a Message resource whose references
  // form a cycle would otherwise hang the game rather than fail it.
  for (let hops = 0; hops < 64; hops++) {
    if (cursor.length === 0) return null;
    const top = cursor[cursor.length - 1];
    const found =
      world.messageRecord?.(stacks.module, top) ?? world.message?.(stacks.module, top) ?? null;
    if (!found) {
      if (cursor.length > 1) {
        cursor.pop();
        continue;
      }
      return null;
    }
    const reference: MessageCursor | undefined = (found as { reference?: MessageCursor }).reference;
    // `seq` is deliberately **not** in this test, which is Sierra's own: a
    // reference differing only in `seq` is a record pointing into its own
    // sequence and is not a continuation.
    if (reference && (reference.noun || reference.verb || reference.cond)) {
      top.seq++;
      cursor.push({ ...reference });
      continue;
    }
    return { text: found.text, talker: found.talker, tuple: { ...top } };
  }
  world.log(
    'A Message reference chain ran past sixty-four hops, so it is a cycle in the resource ' +
      'rather than a conversation, and it was stopped rather than followed.',
  );
  return null;
}

/**
 * Says which of the two a missing Message is, because the engine can tell.
 *
 * "Not loaded or not there" was an ambiguity this is in a position to resolve,
 * and the two want completely different work. A game with no MESSAGE resources
 * at all keeps its words somewhere this reader has not been pointed at, which
 * is a finding about the release; a game that ships them and is missing one
 * line is a lookup fault.
 */
function messageMissing(world: SciKernelWorld, module: number, key: MessageCursor): void {
  const where = `${module}:${key.noun},${key.verb},${key.cond},${key.seq}`;
  // **A sequence ending is not a line missing**, and the `seq` says which this
  // is. A conversation is read by asking for sequence 1, then 2, then 3, until
  // the answer is nothing — so the nothing at the end is the ordinary way every
  // conversation in the game finishes. Reporting those as faults buried the
  // real ones: King's Quest VII's room 960 ends nine sequences this way in a
  // single visit, one of them thirty lines long.
  if (key.seq > 1) {
    world.log(
      `Message sequence ${module}:${key.noun},${key.verb},${key.cond} ended after ` +
        `${key.seq - 1} ${key.seq === 2 ? 'line' : 'lines'}.`,
    );
    return;
  }
  const shipped = world.messageModules?.() ?? null;
  world.log(
    shipped === null
      ? `No Message ${where}, and this engine cannot say whether the game ships one.`
      : shipped.length === 0
        ? `No Message ${where} — and this game ships **no MESSAGE resources at all**, so its ` +
          `words are somewhere this reader has not been pointed at rather than missing from a ` +
          `resource it has. That is a fact about the release, not a line the game lacks.`
        : `No Message ${where}. This game ships ${shipped.length} MESSAGE resources` +
          `${shipped.includes(module) ? `, module ${module} among them, so the line itself is missing` : ` and module ${module} is not one of them`}.`,
  );
}

export const SCI_KERNEL: Readonly<Record<string, Handler>> = {
  // Sierra's unused and debugging slots, answered as a group and counted apart.
  // First in the literal so that writing a real handler below silently wins,
  // rather than a real handler being silently overwritten by the stub.
  ...SCI_KERNEL_UNUSED,

  // ---------------------------------------------------------- scripts ---
  /**
   * `ScriptID(script, index)` — load a script and hand back one of its exports.
   *
   * The call SCI boots through: the interpreter's own start is
   * `ScriptID(0, 0)`, and everything a game reaches afterwards it reaches by
   * asking for a script it has not loaded yet.
   */
  ScriptID: (world, args) => {
    const script = args[0]?.offset ?? 0;
    const index = args[1]?.offset ?? 0;
    return world.scriptExport(script, index) ?? NULL_REG;
  },
  Load: (_world, args) => {
    // The type is in the first argument and the number in the second. Answered
    // with the number itself, which is what a script does with it: it passes it
    // straight to whatever wanted the resource loaded.
    return int(args[1]?.offset ?? 0);
  },
  UnLoad: () => NULL_REG,
  DisposeScript: () => NULL_REG,
  FlushResources: () => NULL_REG,
  Lock: () => NULL_REG,

  // ----------------------------------------------------------- objects ---
  Clone: (world, args) => world.machine.clone(args[0] ?? NULL_REG) ?? NULL_REG,
  DisposeClone: (world, args) => {
    world.machine.disposeClone(args[0] ?? NULL_REG);
    return NULL_REG;
  },
  IsObject: (world, args) => int(world.machine.object(args[0] ?? NULL_REG) ? 1 : 0),
  RespondsTo: (world, args) => {
    const object = world.machine.object(args[0] ?? NULL_REG);
    if (!object) return int(0);
    const selector = args[1]?.offset ?? 0;
    const method = world.machine.resolveMethod(object, selector);
    return int(method || world.machine.resolveProperty(object, selector) >= 0 ? 1 : 0);
  },

  // ------------------------------------------------------------- lists ---
  NewList: (world) => world.heap.newList(),
  DisposeList: (world, args) => {
    world.heap.disposeList(args[0] ?? NULL_REG);
    return NULL_REG;
  },
  /**
   * `NewNode(value[, key])` — and **a node called with one argument is its own
   * key**.
   *
   * Sierra's `kNewNode` reads the key from `argv[1]` when there is one and
   * from `argv[0]` when there is not (`klists.cpp`), and SCI2.1 scripts call it
   * both ways. Defaulting the key to nought instead makes a node that no
   * `FindKey` can ever match and no `DeleteKey` can ever remove — the list
   * still walks, so nothing looks wrong until something tries to take an
   * element out.
   *
   * King's Quest VII's boot is what that costs. `Rm::newRoom` is
   * `(gCast delete: self, eachElementDo: #newRoom, addToFront: self)` — one
   * send, three Selectors, and the `delete` is the whole reason the walk that
   * follows does not reach `self` again. With the key nought the delete removed
   * nothing, the walk found `self` still on the list, and `newRoom` called
   * itself until the interpreter ran out of stack.
   */
  NewNode: (world, args) =>
    world.heap.newNode(args[0] ?? NULL_REG, args.length >= 2 ? args[1] : (args[0] ?? NULL_REG)),
  FirstNode: (world, args) => world.heap.list(args[0] ?? NULL_REG)?.first ?? NULL_REG,
  LastNode: (world, args) => world.heap.list(args[0] ?? NULL_REG)?.last ?? NULL_REG,
  EmptyList: (world, args) =>
    int(isNull(world.heap.list(args[0] ?? NULL_REG)?.first ?? NULL_REG) ? 1 : 0),
  NextNode: (world, args) => world.heap.node(args[0] ?? NULL_REG)?.next ?? NULL_REG,
  PrevNode: (world, args) => world.heap.node(args[0] ?? NULL_REG)?.previous ?? NULL_REG,
  NodeValue: (world, args) => world.heap.node(args[0] ?? NULL_REG)?.value ?? NULL_REG,
  /**
   * `AddToFront(list, node[, key])` — and the third argument is the node's key.
   *
   * Sierra sets it after linking (`if (argc == 3) lookupNode(argv[1])->key =
   * argv[2]`), which is how a script puts an object on a list under a key it
   * can delete by later. A node linked without it is unreachable by key for the
   * rest of its life, and every `delete:` against it silently does nothing.
   */
  AddToFront: (world, args) => {
    world.heap.addToFront(args[0] ?? NULL_REG, args[1] ?? NULL_REG);
    if (args.length >= 3) world.heap.setNodeKey(args[1] ?? NULL_REG, args[2] ?? NULL_REG);
    return args[0] ?? NULL_REG;
  },
  /** `AddToEnd(list, node[, key])`, keyed the same way as `AddToFront`. */
  AddToEnd: (world, args) => {
    world.heap.addToEnd(args[0] ?? NULL_REG, args[1] ?? NULL_REG);
    if (args.length >= 3) world.heap.setNodeKey(args[1] ?? NULL_REG, args[2] ?? NULL_REG);
    return args[0] ?? NULL_REG;
  },
  /**
   * `AddAfter(list, after, node[, key])` — inserted where it says, not appended.
   *
   * The previous reading appended and said so: "the honest approximation while
   * nothing walks a list backwards expecting a particular order". Something
   * does — SCI32's cast is drawn in list order, so a node appended rather than
   * inserted is a character drawn in front of scenery it belongs behind. It
   * also passed `args[2]` as the *node* to a call whose node is `args[1]`,
   * which appended the wrong register entirely.
   */
  AddAfter: (world, args) => {
    world.heap.addAfter(args[0] ?? NULL_REG, args[1] ?? NULL_REG, args[2] ?? NULL_REG);
    if (args.length >= 4) world.heap.setNodeKey(args[2] ?? NULL_REG, args[3] ?? NULL_REG);
    return args[0] ?? NULL_REG;
  },
  FindKey: (world, args) => world.heap.findKey(args[0] ?? NULL_REG, args[1] ?? NULL_REG),
  DeleteKey: (world, args) =>
    int(world.heap.deleteKey(args[0] ?? NULL_REG, args[1] ?? NULL_REG) ? 1 : 0),

  /**
   * `Sort(source, destination, order)` — the one Kernel call that runs a script.
   *
   * Sierra's own `Sort` walks the `elements` list of the source object, sends
   * the third object `doit` once per element to get that element's sort key,
   * orders by the keys, and rebuilds the destination's `elements` in that
   * order. So it cannot be answered without running the game's own code, which
   * is why `PMachine.invoke` exists and why nothing else in this file needs it.
   *
   * Transcribed from ScummVM's `kSort` and `sort_temp_cmp`
   * (`engines/sci/engine/klists.cpp`, fetched 2026-09-12), including the
   * comparison: keys are ordered by segment first and offset second, both
   * unsigned, rather than as signed integers.
   *
   * **A callback that does not finish stops the sort rather than ordering by
   * whatever was left in the accumulator.** `invoke` answers null when the
   * method halted or outran its budget, and an order built from one real key
   * and nine stale ones is a list that looks sorted and is not — the failure
   * this whole file is arranged to avoid.
   */
  Sort: (world, args) => {
    const source = world.machine.object(args[0] ?? NULL_REG);
    const destination = world.machine.object(args[1] ?? NULL_REG);
    const order = args[2] ?? NULL_REG;
    if (!source || !destination) return NULL_REG;

    const size = readProperty(world, source, 'size');
    if (!size) return NULL_REG;

    const input = world.heap.list(readPropertyReg(world, source, 'elements'));
    if (!input) return NULL_REG;

    // A destination with no list of its own gets one, which is Sierra's own
    // arrangement: the script hands over an empty Set and expects it filled.
    let output = readPropertyReg(world, destination, 'elements');
    if (isNull(output)) {
      output = world.heap.newList();
      setPropertyReg(world, destination, 'elements', output);
    }
    setProperty(world, destination, 'size', size);

    const doit = world.machine.selectorNumbers?.get('doit');
    if (doit === undefined) {
      world.log(
        `Sort needs the 'doit' Selector and this game's table does not name one, so the list ` +
          `has been left in the order it arrived rather than ordered by a key that was guessed.`,
      );
      return NULL_REG;
    }

    const entries: Array<{ key: Reg; value: Reg; order: Reg }> = [];
    let at = input.first;
    while (!isNull(at)) {
      const node = world.heap.node(at);
      if (!node) break;
      const answered = world.machine.invoke(order, doit, [node.value]);
      if (answered === null) {
        world.log(
          `Sort's order object did not answer 'doit' — it halted or outran its budget — so the ` +
            `sort has been abandoned. An order built from one real key and the rest stale is a ` +
            `list that looks sorted and is not.`,
        );
        return NULL_REG;
      }
      entries.push({ key: node.key, value: node.value, order: answered });
      at = node.next;
    }

    entries.sort((a, b) =>
      a.order.segment !== b.order.segment
        ? a.order.segment - b.order.segment
        : a.order.offset - b.order.offset,
    );
    for (const entry of entries) {
      world.heap.addToEnd(output, world.heap.newNode(entry.value, entry.key));
    }
    return NULL_REG;
  },

  // -------------------------------------------------------------- maths ---
  Random: (world, args) => {
    const low = signed(args[0] ?? NULL_REG);
    const high = signed(args[1] ?? int(low));
    if (high <= low) return int(low);
    return int(low + Math.floor(world.random() * (high - low + 1)));
  },
  Abs: (_world, args) => int(Math.abs(signed(args[0] ?? NULL_REG))),
  Sqrt: (_world, args) => int(Math.floor(Math.sqrt(Math.abs(signed(args[0] ?? NULL_REG))))),
  GetDistance: (_world, args) => {
    const dx = signed(args[0] ?? NULL_REG) - signed(args[2] ?? NULL_REG);
    const dy = signed(args[1] ?? NULL_REG) - signed(args[3] ?? NULL_REG);
    return int(Math.floor(Math.sqrt(dx * dx + dy * dy)));
  },
  /**
   * The angle from one point to another, in SCI's own degrees.
   *
   * Zero is *up* and it increases clockwise, which is not what `atan2` gives
   * and is not a convention anything else here uses. An actor walking with the
   * mathematical convention walks a quarter turn wrong and the game never says
   * anything is amiss.
   */
  GetAngle: (_world, args) => {
    const dx = signed(args[2] ?? NULL_REG) - signed(args[0] ?? NULL_REG);
    const dy = signed(args[3] ?? NULL_REG) - signed(args[1] ?? NULL_REG);
    if (dx === 0 && dy === 0) return int(0);
    const degrees = (Math.atan2(dx, -dy) * 180) / Math.PI;
    return int(Math.round((degrees + 360) % 360));
  },
  /**
   * `SinMult(angle, factor)` — and `TimesSin` is the same slot's earlier name.
   *
   * 0x6a and 0x6b are `TimesSin` and `TimesCos` in the table a SCI0 game ships
   * in its own `vocab.999`, and `SinMult` and `CosMult` in the table Sierra's
   * SCI1 interpreter carries. One implementation under both names rather than
   * two, because `SciEngine.kernelNameFor` prefers the game's own table — so
   * which of the two names a handler is reached by is a fact about the release
   * rather than about the call, and two handlers would be two chances to
   * disagree about one piece of arithmetic.
   *
   * **Truncated, not rounded.** ScummVM's `kTimesSin` is
   * `(int16)(factor * sin(angle * M_PI / 180.0))` — a C cast, which throws the
   * fraction away rather than rounding it — and this used to round. The two
   * differ by one wherever the fraction reaches a half, which for an actor's
   * step is a pixel and for a circular path is a pixel that accumulates.
   */
  SinMult: (_world, args) => timesTrig(Math.sin, args),
  CosMult: (_world, args) => timesTrig(Math.cos, args),
  TimesSin: (_world, args) => timesTrig(Math.sin, args),
  TimesCos: (_world, args) => timesTrig(Math.cos, args),

  /**
   * `SinDiv(angle, value)` and `CosDiv(angle, value)` — *value divided by* the
   * ratio, which is the opposite of the pair above and reads the same.
   *
   * Transcribed from ScummVM's `kSinDiv` and `kCosDiv` (`engines/sci/engine/
   * kmath.cpp`, fetched 2026-09-12), including the guard: Sierra's own
   * interpreter has no answer when the ratio is nought, and ScummVM raises an
   * error there. This reports and answers -1 rather than raising, because a
   * Kernel call that throws takes the trace and the ring buffer with it — the
   * same reasoning `dispatchBlock` gives for halting rather than throwing on a
   * hole in a parameter block.
   */
  SinDiv: (world, args) => trigDiv(world, Math.sin, args, 'SinDiv'),
  CosDiv: (world, args) => trigDiv(world, Math.cos, args, 'CosDiv'),

  /**
   * `TimesTan(angle[, scale])` and `TimesCot(angle[, scale])` — SCI0's 0x6c and
   * 0x6d, which SCI1 renumbered into `SinDiv` and `CosDiv`.
   *
   * **`TimesTan` is not `scale * tan(angle)`, and that is Sierra's doing rather
   * than a transcription slip.** ScummVM's `kTimesTan` shifts the angle by a
   * quarter turn and negates — `-(tan((angle - 90) * M_PI / 180.0) * scale)` —
   * which is `scale * cot(angle)`; `kTimesCot` is the plain tangent. Written
   * the way the source writes it, with the identity named, so that a reader who
   * thinks it is backwards can see it was read rather than assumed.
   *
   * Both are undefined on a multiple of a quarter turn, where the tangent runs
   * away. Reported and answered -1, for `SinDiv`'s reason.
   */
  TimesTan: (world, args) => {
    const angle = signed(args[0] ?? NULL_REG) - 90;
    if (angle % 90 === 0) return trigUndefined(world, 'TimesTan', signed(args[0] ?? NULL_REG));
    return int(Math.trunc(-(Math.tan((angle * Math.PI) / 180) * trigScale(args))));
  },
  TimesCot: (world, args) => {
    const angle = signed(args[0] ?? NULL_REG);
    if (angle % 90 === 0) return trigUndefined(world, 'TimesCot', angle);
    return int(Math.trunc(Math.tan((angle * Math.PI) / 180) * trigScale(args)));
  },

  // -------------------------------------------------------------- time ---
  /**
   * `GetTime([mode])` — and the mode is not a detail, it is a different unit.
   *
   * Sierra overloaded one Kernel call four ways, selected by its first
   * argument, and each answers in a packing of its own — so a handler that
   * always returns ticks answers three of the four with a number that means
   * something else entirely. Mode 0 is the game clock a delay loop counts;
   * modes 1 and 2 are the wall-clock time of day, packed into sixteen bits;
   * mode 3 is the date. King's Quest IV asks mode 1 once at boot (the copy of
   * ScummVM's `kGetTime` this follows shows why: the interface scripts seed a
   * timer from the time of day), and with only the tick reader it was handed a
   * frame count where it expected `hhhhh mmmmmm sssss`.
   *
   * The packings are ScummVM's, which are Sierra's:
   *   mode 1  ((hour % 12) << 12) | (min << 6) | sec        — 12-hour
   *   mode 2  (hour << 11) | (min << 5) | (sec >> 1)        — 24-hour
   *   mode 3  mday | ((mon + 1) << 5) | ((year - 1980) << 9) — date
   */
  GetTime: (world, args) => {
    const mode = args[0]?.offset ?? 0;
    if (mode === 0) return int(world.ticks());
    const now = new Date();
    switch (mode) {
      case 1:
        return int(((now.getHours() % 12) << 12) | (now.getMinutes() << 6) | now.getSeconds());
      case 2:
        return int((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1));
      case 3:
        return int(now.getDate() | ((now.getMonth() + 1) << 5) | ((now.getFullYear() - 1980) << 9));
      default:
        // An unknown mode is a script this reading did not anticipate rather
        // than a value to invent — fall back to the clock the loops count.
        return int(world.ticks());
    }
  },
  Wait: (_world, args) => {
    // The interpreter blocked here; a browser cannot. The value a script wants
    // back is how long it actually waited, and answering with what it asked for
    // keeps every timing calculation above consistent — a script that asks for
    // ten and is told zero runs its animation at once.
    return int(args[0]?.offset ?? 0);
  },
  GameIsRestarting: () => int(0),

  // ------------------------------------------------------------ strings ---
  StrLen: (world, args) => int(readString(world, args[0] ?? NULL_REG, true).length),
  /**
   * `StrEnd(string)` — the address of the terminator.
   *
   * **A byte count is not always a step of one.** A string on the heap or in a
   * script is byte-addressed, so the end is `offset + length`. A string in a
   * variable bank is packed two characters to a word and the offset is a
   * *word* index, so the end is `offset + (length >> 1)`.
   *
   * Advancing by the byte count in both is what broke King's Quest IV the
   * first time the string reader was widened: the address landed halfway
   * through the bank and every read after it was of the wrong variable. The
   * unit belongs to the space, so it is asked of the space.
   */
  StrEnd: (world, args) => {
    // A byte offset in every space, because that is what an address is here —
    // see `ADDRESS_BASE`.
    const value = args[0] ?? NULL_REG;
    return reg(value.segment, value.offset + readString(world, value, true).length);
  },
  StrCmp: (world, args) => {
    const a = readString(world, args[0] ?? NULL_REG, true);
    const b = readString(world, args[1] ?? NULL_REG, true);
    // Sierra's own answer is a sign, and a script tests it against zero.
    return int(a === b ? 0 : a < b ? 0xffff : 1);
  },
  StrCpy: (world, args) => {
    writeString(world, args[0] ?? NULL_REG, readString(world, args[1] ?? NULL_REG, true));
    return args[0] ?? NULL_REG;
  },
  StrCat: (world, args) => {
    const target = args[0] ?? NULL_REG;
    writeString(
      world,
      target,
      readString(world, target, true) + readString(world, args[1] ?? NULL_REG, true),
    );
    return target;
  },
  StrAt: (world, args) => {
    // **`StrAt` is a setter as well as a getter.** With three arguments Sierra
    // writes the character and answers the one that was there, which is how a
    // script edits a line a character at a time — the typed input line does
    // exactly that.
    const value = args[0] ?? NULL_REG;
    const index = args[1]?.offset ?? 0;
    const bytes = bytesAt(world, value);
    if (!bytes || index >= bytes.length) return int(0);
    const before = bytes.get(index);
    if (args.length > 2) bytes.set(index, (args[2]?.offset ?? 0) & 0xff);
    return int(before);
  },
  ReadNumber: (world, args) =>
    int(Number.parseInt(readString(world, args[0] ?? NULL_REG, true), 10) || 0),

  /**
   * `StrSplit(buffer, text, separator)` — which splits a *language*, not a word.
   *
   * The name is Sierra's and it is misleading: what the call does is pick one
   * language out of a string that carries two. A multilanguage release writes
   * `English text%JJapanese text` in one string, where `%` or `#` followed by a
   * language letter is the splitter, and the interpreter hands back the half
   * that matches the language the game object's `printLang` asks for.
   *
   * Transcribed from ScummVM's `kStrSplit` and `SciEngine::getSciLanguageString`
   * (`engines/sci/engine/kstring.cpp` and `engines/sci/engine/state.cpp`,
   * fetched 2026-09-12).
   *
   * **This engine has no language setting, so the requested language is always
   * English**, and the effect is the half before the splitter — or the whole
   * string, which is what every English release actually holds. The separator
   * argument is read and deliberately unused: ScummVM appends a subtitle in a
   * second language only when the game object carries a `subtitleLang`, and
   * nothing here reads that Selector. Said rather than dropped, because a
   * separator that silently did nothing would look like a bug in the caller.
   */
  StrSplit: (world, args) => {
    const target = args[0] ?? NULL_REG;
    const text = readString(world, args[1] ?? NULL_REG, true);
    writeString(world, target, englishHalf(text));
    return target;
  },

  // ------------------------------------------------------------ memory ---
  Memory: (world, args) => {
    // Subfunction in the first argument: 0 allocates, 1 frees, 2 reads a word,
    // 3 writes one. Written out because a memory call that silently does
    // nothing is a script writing into a void and reading zeroes back.
    const operation = args[0]?.offset ?? 0;
    switch (operation) {
      case 0:
        return world.heap.allocate((args[1]?.offset ?? 0) * 2);
      case 1:
        world.heap.free(args[1] ?? NULL_REG);
        return NULL_REG;
      case 2: {
        const bytes = world.heap.bytes(args[1] ?? NULL_REG);
        const at = (args[2]?.offset ?? 0) * 2;
        return int(bytes ? bytes[at] | (bytes[at + 1] << 8) : 0);
      }
      default: {
        const bytes = world.heap.bytes(args[1] ?? NULL_REG);
        const at = (args[2]?.offset ?? 0) * 2;
        if (bytes) {
          bytes[at] = (args[3]?.offset ?? 0) & 0xff;
          bytes[at + 1] = (args[3]?.offset ?? 0) >> 8;
        }
        return NULL_REG;
      }
    }
  },
  /**
   * `DoSync`: the mouth timing of a line of dialogue (#221).
   *
   * The third face of the thing `Message` and `audio36` are the other two of,
   * and **found by the same key**: a `sync36` resource is numbered by the
   * packed tuple, so the timing is asked for by the Message's own key rather
   * than by walking a parallel list and hoping the orders agree.
   *
   * Sierra's three sub-functions, from `kDoSync`: start, next, stop. `start`
   * takes a plain resource number when the game is calling for a whole-line
   * `sync`, and a module plus the four-part tuple when it is calling for a
   * `sync36` — seven arguments rather than three, which is how the two are
   * told apart.
   */
  DoSync: (world, args) => {
    const sub = signed(args[0] ?? NULL_REG);
    const object = world.machine.object(args[1] ?? NULL_REG);

    if (sub === 0) {
      const number =
        args.length >= 7
          ? audio36Number({
              noun: (args[3] ?? NULL_REG).offset,
              verb: (args[4] ?? NULL_REG).offset,
              cond: (args[5] ?? NULL_REG).offset,
              seq: (args[6] ?? NULL_REG).offset,
            })
          : signed(args[2] ?? NULL_REG);
      const steps = world.syncSteps?.(number) ?? null;
      if (!steps) {
        syncCursor.delete(world);
        // Sierra's own signal for "there is no timing here", which is what
        // stops a talker waiting for cues that will never arrive.
        setProperty(world, object, 'syncCue', 0xffff);
        return NULL_REG;
      }
      syncCursor.set(world, { steps, at: 0 });
      setProperty(world, object, 'syncCue', 0);
      return NULL_REG;
    }

    if (sub === 1) {
      const cursor = syncCursor.get(world);
      const step = cursor?.steps[cursor.at];
      if (!cursor || !step) return NULL_REG;
      cursor.at++;
      setProperty(world, object, 'syncTime', step.time);
      setProperty(world, object, 'syncCue', step.cue);
      return NULL_REG;
    }

    if (sub === 2) {
      syncCursor.delete(world);
      return NULL_REG;
    }

    world.log(`DoSync sub-function ${sub} is not implemented. 0 starts, 1 steps, 2 stops.`);
    return NULL_REG;
  },

  // ---------------------------------------------------------------- video ---

  /**
   * `SetVideoMode(on)` — a flag for a display mode that no longer exists.
   *
   * King's Quest VI's intro turns this on before it plays and off afterwards.
   * ScummVM's `kSetVideoMode` (`engines/sci/engine/kgraphics.cpp`, fetched
   * 2026-09-12) carries the reading and does nothing with it: it is believed to
   * enable VGA planar memory access — "Mode X" — for a video decoder written
   * against that memory model.
   *
   * **A deliberate no-op is not a stub, and the difference is that this one is
   * finished.** There is nothing left to implement: an interpreter that does
   * not paint through VGA's planar registers has no mode to switch. Written out
   * so a later reader does not count it as a gap and go looking.
   */
  SetVideoMode: () => NULL_REG,

  /**
   * SCI16's `ShowMovie`: a file name and a delay, and nothing else.
   *
   * The DOS form takes the SEQ's name and the ticks a frame is held for, which
   * is the whole of the call — a SEQ carries no rate of its own, so the game
   * supplies it. SCI32's `ShowMovie` is sub-functioned and plays an AVI; both
   * arrive here, and the shape of the first argument tells them apart, because
   * a reference is a string and a number is a sub-function.
   */
  ShowMovie: (world, args) => {
    const first = args[0] ?? NULL_REG;
    if (isNull(first) || first.segment === 0) {
      // SCI32's form: a sub-function number. Only `Play` does anything a
      // player can see, and the rest are window management for a video this
      // project draws full-screen anyway.
      const sub = first.offset;
      if (sub === 6) world.closeMovie?.();
      return NULL_REG;
    }
    const file = readString(world, first);
    if (file === '') return NULL_REG;
    world.playMovie?.({ file, ticksPerFrame: signed(args[1] ?? NULL_REG) || undefined });
    return NULL_REG;
  },

  /**
   * SCI32's `PlayVMD`, whose sub-functions are many and whose useful ones are
   * few.
   *
   * ScummVM's own comment on the table says as much: of the twenty subs, the
   * ones a game actually depends on are open, init, close, status and play.
   * The numbers are Sierra's — 0 open, 1 init, 6 close, 10 status, 14 play
   * until an event — and they are written out rather than mapped, because a
   * sub-function this project does not implement must report itself rather
   * than return zero.
   */
  PlayVMD: (world, args) => {
    const sub = signed(args[0] ?? NULL_REG);
    switch (sub) {
      case 0: {
        // Open: the file, held until `init` says where it goes.
        const file = readString(world, args[1] ?? NULL_REG);
        pendingVmd.set(world, file);
        return int(0);
      }
      case 1: {
        // Init: the corner. The video is not started here — `PlayUntilEvent`
        // is what runs it, and a game that inits and never plays should show
        // nothing rather than a frame.
        pendingVmdAt.set(world, {
          x: signed(args[1] ?? NULL_REG),
          y: signed(args[2] ?? NULL_REG),
        });
        return NULL_REG;
      }
      case 6:
        world.closeMovie?.();
        pendingVmd.delete(world);
        return NULL_REG;
      case 10: {
        const status = world.movieStatus?.();
        // Sierra's own codes: 0 stopped, 2 playing.
        return int(status?.playing ? 2 : 0);
      }
      case 14: {
        const file = pendingVmd.get(world);
        if (file === undefined || file === '') return NULL_REG;
        const at = pendingVmdAt.get(world);
        world.playMovie?.({ file, x: at?.x, y: at?.y });
        return NULL_REG;
      }
      // Cursor, palette, blackout and the blob calls change how a video looks
      // rather than whether it plays, and this draws it full-screen.
      case 7:
      case 16:
      case 17:
      case 18:
      case 19:
      case 20:
      case 21:
      case 23:
      case 27:
      case 28:
      case 31:
        return NULL_REG;
      default:
        world.log(
          `PlayVMD sub-function ${sub} is not implemented. 0 opens, 1 places, 14 plays, ` +
            `6 closes and 10 reports — the rest change a video's appearance.`,
        );
        return NULL_REG;
    }
  },

  /**
   * SCI3's `PlayDuck`, which opens a file this project reads and cannot draw.
   *
   * The container is read (`SciAvi.ts`) and the TrueMotion 1 codec is not, so
   * a DUK opens, streams, times and skips correctly and shows the frame that
   * was on screen before it. Said out loud through the log rather than left
   * as a silent still, because "nothing happened" and "this is playing" look
   * identical otherwise.
   */
  PlayDuck: (world, args) => {
    const sub = signed(args[0] ?? NULL_REG);
    switch (sub) {
      case 1: {
        const resource = signed(args[1] ?? NULL_REG);
        world.playMovie?.({
          file: `${resource}.duk`,
          x: signed(args[3] ?? NULL_REG),
          y: signed(args[4] ?? NULL_REG),
        });
        return NULL_REG;
      }
      case 2:
      case 6:
        return NULL_REG;
      case 5:
        world.closeMovie?.();
        return NULL_REG;
      default:
        world.log(`PlayDuck sub-function ${sub} is not implemented. 1 plays, 5 closes.`);
        return NULL_REG;
    }
  },

  /**
   * `Robot`, which is composited rather than played (#226).
   *
   * Every sub-function here goes to the Plane rather than to the movie player,
   * and that separation *is* the architectural claim: a Robot frame is a screen
   * item sorted by the same three keys as a View cel. If this ever needed to
   * reach `playMovie`, ADR 0015's tripwire would have fired.
   */
  Robot: (world, args) => {
    const sub = signed(args[0] ?? NULL_REG);
    switch (sub) {
      case 0:
        world.openRobot?.(
          signed(args[1] ?? NULL_REG),
          `${(args[2] ?? NULL_REG).segment}:${(args[2] ?? NULL_REG).offset}`,
          signed(args[3] ?? NULL_REG),
          signed(args[4] ?? NULL_REG),
          signed(args[5] ?? NULL_REG),
        );
        return NULL_REG;
      case 5:
        return int(world.robotStatus?.().finished ? 1 : 0);
      case 6:
        return int(world.robotStatus?.().open ? 1 : 0);
      case 7:
        world.closeRobot?.();
        return NULL_REG;
      case 11:
        return int(world.robotStatus?.().frame ?? 0);
      // Show a frame, play, pause, cue and priority all act on a Robot that is
      // already on its Plane, and the compositor is already drawing it.
      case 1:
      case 2:
      case 4:
      case 8:
      case 10:
      case 12:
        return NULL_REG;
      default:
        world.log(`Robot sub-function ${sub} is not implemented.`);
        return NULL_REG;
    }
  },

  MemoryInfo: () => int(0x7fff),
  MemorySegment: () => NULL_REG,

  // ------------------------------------------------------------- input ---
  /**
   * `GetEvent(mask, event)` — the poll every SCI game's main loop runs.
   *
   * Consumes from the queue rather than being handed an event as it arrives.
   * Dispatching instead loses input in a way that never errors: a click that
   * lands while the scripts are asking only for keys is simply gone.
   *
   * **The pointer's position is written whether or not there was an event, and
   * that is not a detail.** A SCI game learns where the mouse is only from this
   * call — there is no other Kernel call that reports it — so a poll that finds
   * an empty queue and writes nothing leaves the game reading whatever the
   * event object held before. `uEvt::new` zeroes the object immediately before
   * calling here, so writing nothing on a miss reports the pointer at (0,0)
   * forever.
   *
   * What that costs is every hover in every SCI32 game, and through the hover,
   * every click. King's Quest VII's `User::handleEvent` (64996:443) compares the
   * event's x and y against globals 70 and 71 — the previous position — and only
   * when they differ does it run the arm that sends `handleEvent` to the
   * Features under the pointer. That arm is the only writer of `global311`, the
   * "Feature the pointer is over", and `Feature::handleEvent` at 64950:691 sends
   * a claimed click on to `CueObj changeState: 3` — the only caller of `doVerb`
   * in the game — only when `self == global311`. With the position frozen at
   * (0,0) the comparison never differed, `global311` stayed `0:0`, and every
   * click on the main menu fell through to `global1 pragmaFail:`. Measured: 0
   * `doVerb` dispatches in 1200 cycles before, the three menu buttons answering
   * `IsOnMe` 1 the whole time.
   *
   * Returns 0 on a miss as before — the position is data the game asked for, not
   * an event, and a script that treats a written x as an event would loop.
   */
  /**
   * `GetEvent(mask, event)` — the next input, or a **null event**.
   *
   * **A null event is written out, not left alone.** Sierra's `kGetEvent` ends
   * in a `default:` that writes `type` of none, `message` of nought and the
   * current modifiers before answering false; this wrote only `x` and `y` and
   * left the other three holding the *previous* event.
   *
   * That is not a tidiness point. A SCI script asks for an event every cycle
   * and reads the object whether or not it was given one — `ExitFeature`'s own
   * `handleEvent` branches on `type` being nought to mean "no event, just tell
   * me where the pointer is". With a stale `type` left behind, the cycle after
   * a click is still carrying that click: the game answers a press it has
   * already handled, and the branch that should have armed the thing under the
   * pointer never runs.
   */
  GetEvent: (world, args) => {
    const mask = args[0]?.offset ?? 0;
    const event = world.input.next(mask);
    const target = world.machine.object(args[1] ?? NULL_REG);
    if (target) {
      setProperty(world, target, 'x', event?.x ?? world.input.mouseX);
      setProperty(world, target, 'y', event?.y ?? world.input.mouseY);
      setProperty(world, target, 'type', event?.type ?? SCI_EVENT.none);
      setProperty(world, target, 'message', event?.message ?? 0);
      setProperty(world, target, 'modifiers', event?.modifiers ?? 0);
    }
    return int(event ? 1 : 0);
  },
  HaveMouse: () => int(1),
  MapKeyToDir: (_world, args) => args[0] ?? NULL_REG,
  Joystick: () => int(0),

  // ----------------------------------------------------------- platform ---
  Platform: () => int(1),
  DeviceInfo: () => int(0),
  GetCWD: (world, args) => {
    writeString(world, args[0] ?? NULL_REG, '');
    return args[0] ?? NULL_REG;
  },
  ValidPath: () => int(1),
  /**
   * Below SCI2.1 middle the path comes first and the question second; from
   * SCI2.1 middle the call moved inside `FileIO` and the two swapped.
   */
  CheckFreeSpace: (world, args) =>
    checkFreeSpace(world, args[1]?.offset ?? SCI_FREE_SPACE.enoughToSave),
  GetSaveFiles: () => int(0),
  CheckSaveGame: () => int(0),
  SetDebug: () => NULL_REG,
  DbugStr: () => NULL_REG,
  SetQuitStr: () => NULL_REG,
  Empty: () => NULL_REG,
  GetSaveDir: (world) => world.heap.allocate(2),
  GetFarText: (world, args) => {
    // Text from a `text` resource, by number and index, copied into the buffer
    // the script passed as its third argument — or into a block of our own
    // when it passed none, because a script does `StrLen` on the result and a
    // null reference halts where an empty string reads as no text.
    const text = world.farText?.(args[0]?.offset ?? 0, args[1]?.offset ?? 0) ?? '';
    const target = args[2] ?? NULL_REG;
    if (!isNull(target)) {
      writeString(world, target, text);
      return target;
    }
    const block = world.heap.allocate(text.length + 1);
    writeString(world, block, text);
    return block;
  },
  /**
   * `Message(sub, ...)` — the words a SCI1.1-and-later game says.
   *
   * **SCI32 renumbers the sub-functions above three.** ScummVM's `kMessage`
   * does `if (func > 3) func--` for SCI2 and later and refuses three outright,
   * so a SCI32 script's 4 is the reference-noun that a SCI1.1 script calls 3.
   * Getting this wrong is silent: every number still lands on *a* handler, just
   * the one next door, so a game asks for a verb and is told a condition.
   *
   * `get` and `size` were here already because they answer from the resource
   * alone. The rest need the cursor stack above them — a conversation is `get`
   * once and `next` until it runs out, and without `next` a game says its first
   * line and stops, which is what King's Quest VII did.
   */
  Message: (world, args) => {
    const asked = args[0]?.offset ?? 0;
    // Asked of the machine where there is one. A caller that supplies no
    // machine is asking about the sub-functions SCI1.1 numbers, which is the
    // numbering every Version before SCI2 uses.
    const version = world.machine?.version ?? '';
    const sci32 = version.startsWith('sci2') || version === 'sci3';
    if (sci32 && asked === 3) {
      world.log(
        'Message sub-function 3 is not a sub-function at SCI2 and later — Sierra left the ' +
          'slot empty when it renumbered the rest upwards. Nothing was answered.',
      );
      return NULL_REG;
    }
    const sub = sci32 && asked > 3 ? asked - 1 : asked;

    const stacks = messageStacks(world);
    const module = args[1]?.offset ?? 0;
    const tuple: MessageCursor = {
      noun: args[2]?.offset ?? 0,
      verb: args[3]?.offset ?? 0,
      cond: args[4]?.offset ?? 0,
      seq: args[5]?.offset ?? 0,
    };

    /** Reads where the cursor points, writes the line, and steps it on. */
    const next = (target: Reg): Reg => {
      // A null buffer is the game asking **who** speaks next rather than for
      // the line, and Sierra reads that without moving the cursor.
      const walk = !isNull(target);
      const found = messageRecordAt(world, stacks, walk);
      if (!found) {
        // Reported with the module and tuple, because a sequence running out
        // and a line that was never there look identical from here and the
        // reader needs to be able to tell which they are looking at.
        const top = stacks.cursor[stacks.cursor.length - 1];
        // Reported whether or not the cursor was being walked. Sierra's
        // no-buffer branch returns nought in silence, and silence is the one
        // thing this engine cannot afford here: a sequence running out and a
        // line that was never there look identical from the outside, and only
        // the module and tuple tell them apart.
        if (top) messageMissing(world, stacks.module, top);
        return int(0);
      }
      if (walk) {
        writeString(world, target, found.text);
        stacks.last = found.tuple;
        stacks.lastModule = stacks.module;
        const top = stacks.cursor[stacks.cursor.length - 1];
        if (top) top.seq++;
      }
      return int(found.talker);
    };

    switch (sub) {
      case 0:
        // `get` is `init` and then `next`, exactly as Sierra writes it — which
        // is why a `get` leaves a cursor behind for the `next` calls after it.
        stacks.module = module;
        stacks.cursor = [{ ...tuple }];
        return next(args[6] ?? NULL_REG);

      case 1:
        // `next` takes its buffer as the **second** argument, because it has no
        // module or tuple in front of it.
        return next(args[1] ?? NULL_REG);

      case 2: {
        // `size` reads without disturbing the cursor a conversation is using,
        // so it asks on a stack of its own.
        const aside: MessageStacks = {
          module,
          cursor: [{ ...tuple }],
          saved: [],
          lastModule: 0,
          last: null,
        };
        const found = messageRecordAt(world, aside, true);
        if (!found) {
          messageMissing(world, module, tuple);
          return int(0);
        }
        // The terminator the caller is about to write is included, which is
        // what the script allocates for.
        return int(found.text.length + 1);
      }

      case 3:
      case 4:
      case 5: {
        // The three halves of a record's reference, asked for one at a time.
        // A record with no reference answers SCI's own signal rather than
        // zero, because nought is a legitimate noun.
        const record = world.messageRecord?.(module, tuple) ?? null;
        const reference = record?.reference;
        if (!reference) return SIGNAL_REG;
        return int(sub === 3 ? reference.noun : sub === 4 ? reference.verb : reference.cond);
      }

      case 6:
        messageState.set(world, {
          ...stacks,
          saved: [
            ...stacks.saved,
            { module: stacks.module, cursor: stacks.cursor.map((o) => ({ ...o })) },
          ],
        });
        return NULL_REG;

      case 7: {
        const restored = stacks.saved.pop();
        if (!restored) {
          world.log(
            'Message pop was asked for with nothing pushed. Sierra raises here; this leaves ' +
              'the cursor where it was, so a game that over-pops carries on saying the right ' +
              'words rather than stopping.',
          );
          return NULL_REG;
        }
        stacks.module = restored.module;
        stacks.cursor = restored.cursor;
        return NULL_REG;
      }

      case 8: {
        // The last line actually returned, which a game uses to say "again".
        const last = stacks.last;
        if (!last) return NULL_REG;
        const target = args[1] ?? NULL_REG;
        // Five little-endian words: module, then the four parts of the tuple.
        const bytes = isNull(target) ? null : bytesAt(world, target);
        if (bytes) {
          const words = [stacks.lastModule, last.noun, last.verb, last.cond, last.seq];
          for (const [index, word] of words.entries()) {
            bytes.set(index * 2, word & 0xff);
            bytes.set(index * 2 + 1, (word >> 8) & 0xff);
          }
        }
        return int(stacks.lastModule);
      }

      default:
        world.log(
          `Message sub-function ${asked} is not implemented. Sierra's own list ends at the ` +
            `last-message query, so a number above it is a misread argument.`,
        );
        return NULL_REG;
    }
  },

  /**
   * `GetMessage(noun, module, verb, buffer)` — SCI1's spelling of `Message`.
   *
   * **It belongs to the Kernel and it does not belong to a second reader.**
   * SCI1.1 replaced this slot with the sub-functioned `Message`, and both ask
   * the same question of the same resource; the only differences are the
   * argument order and that this one has no `cond` or `seq`. So it goes through
   * `world.message` — the hook `sciMessage.ts` already answers — rather than
   * reading a `MESSAGE` resource a second way. Two readers of one resource is
   * how the two disagree.
   *
   * Transcribed from ScummVM's `kGetMessage` (`engines/sci/engine/kstring.cpp`,
   * fetched 2026-09-12): the tuple is `(noun, verb)` with `cond` and `seq` at
   * nought, the module is the *second* argument, and the buffer is returned.
   */
  GetMessage: (world, args) => {
    const module = args[1]?.offset ?? 0;
    const key = { noun: args[0]?.offset ?? 0, verb: args[2]?.offset ?? 0, cond: 0, seq: 0 };
    const target = args[3] ?? NULL_REG;
    const found = world.message?.(module, key) ?? null;
    if (!found) {
      world.log(
        `No Message ${module}:${key.noun},${key.verb},0,0 for GetMessage — either the resource ` +
          `is not loaded or the game asked for a line it does not ship.`,
      );
      return target;
    }
    if (!isNull(target)) writeString(world, target, found.text);
    return target;
  },

  /**
   * `TextColors`: the palette entries text is drawn in.
   *
   * Recorded rather than ignored. A game sets these once at startup and then
   * assumes them, so answering zero and forgetting is how text later comes out
   * in whatever colour the last window happened to leave behind.
   */
  TextColors: (world, args) => {
    world.setTextColours?.(args.map((value) => value.offset));
    return NULL_REG;
  },

  /**
   * `TextFonts(font, …)` — the fonts a text code switches between.
   *
   * `TextColors`' sibling, and the same shape in Sierra's own source
   * (`kgraphics.cpp:1300`): a list is handed over and remembered, and `|f1|`
   * inside a string later selects the second of them. Answering nothing and
   * forgetting is how a string that switches font comes out in whatever the
   * last window left behind.
   *
   * Like `TextColors` here, this answers nought where Sierra leaves the
   * accumulator alone. That difference predates this call and is shared with
   * its sibling rather than introduced beside it; a script using the *result*
   * of `TextFonts` would see it, and none is known to.
   */
  TextFonts: (world, args) => {
    world.setTextFonts?.(args.map((value) => value.offset));
    return NULL_REG;
  },

  /**
   * `IsItSkip(view, loop, cel, y, x)` — is this pixel the cel's clear key?
   *
   * **The argument order is Sierra's and it is not the obvious one**: y comes
   * before x (`kgraphics.cpp:469`, `Common::Point position(argv[4], argv[3])`).
   * Getting it the other way round produces a call that works on square cels
   * and lies on every other, which is the kind of fault that survives a long
   * time.
   *
   * The point is clamped into the cel rather than refused, which is also
   * Sierra's (`compare.cpp:197`).
   *
   * It is about belief rather than drawing: a script asks this to find out
   * whether a point is on a character or on the background showing through it.
   */
  IsItSkip: (world, args) => {
    const skip = world.celSkipAt?.(
      args[0]?.offset ?? 0,
      args[1]?.offset ?? 0,
      args[2]?.offset ?? 0,
      args[4]?.offset ?? 0,
      args[3]?.offset ?? 0,
    );
    return int(skip ? 1 : 0);
  },

  /**
   * `AssertPalette(number)` — make sure this palette is in.
   *
   * A game calls it before drawing something whose colours live in a palette
   * it has not asked for yet. Absent, the draw happens against whatever palette
   * was last loaded, which is a room in the wrong colours rather than a crash —
   * so this is one of the calls whose absence is quiet.
   */
  /**
   * `MoveCursor(x, y)` — put the pointer there.
   *
   * The game moving the player's hand, which it does at a few scripted moments:
   * dropping the pointer onto a menu it has just opened, or onto the button it
   * expects to be pressed next. ScummVM's is
   * `_gfxCursor->kernelSetPos(Point(argv[0], argv[1]))`.
   *
   * Absent, the pointer stayed where the player left it and the game carried on
   * as though it had moved — so a menu opened under a pointer that was
   * somewhere else, and the click that followed landed on whatever was actually
   * beneath it.
   *
   * Signed, because a script moves the pointer relative to a window whose
   * origin can put the result left of the screen, and the input surface clamps
   * rather than this one.
   */
  MoveCursor: (world, args) => {
    world.moveCursor?.(signed(args[0] ?? NULL_REG), signed(args[1] ?? NULL_REG));
    return NULL_REG;
  },

  /**
   * `PalVary(sub, …)` — a palette fading into another over time.
   *
   * Seven sub-functions (`kernel_tables.h:271`), and a SCI1.1 game uses them
   * for a room going dark, a sunset, a lightning flash. Absent, a game asked
   * for a fade, got nought, and carried on — so the fade simply never happened
   * and the room stayed lit, which is the quiet kind of wrong.
   *
   * `Init` answers a signal on success and nought when a fade is already
   * running; refusing rather than replacing is Sierra's, because two
   * overlapping fades silently becoming the second one is worse than a script
   * being told no.
   */
  PalVary: (world, args) => {
    const vary = world.palVary;
    if (!vary) return NULL_REG;
    const at = (index: number, fallback = 0): number => args[index]?.offset ?? fallback;

    switch (at(0)) {
      case SCI_PAL_VARY.init:
        // The signal register, not one: `kPalVaryInit` answers `SIGNAL_REG`.
        return vary.init(at(1), at(2), args.length >= 4 ? at(3) : 64, args.length >= 5 ? at(4) : 1)
          ? SIGNAL_REG
          : NULL_REG;
      case SCI_PAL_VARY.reverse:
        return int(
          vary.reverse(
            args.length >= 2 ? at(1) : -1,
            args.length >= 3 ? at(2) : 0,
            args.length >= 4 ? signed(args[3] ?? NULL_REG) : -1,
          ),
        );
      case SCI_PAL_VARY.getCurrentStep:
        return int(vary.currentStep());
      case SCI_PAL_VARY.deinit:
        vary.deinit();
        return NULL_REG;
      case SCI_PAL_VARY.changeTarget:
        return int(vary.changeTarget(at(1)));
      case SCI_PAL_VARY.changeTicks:
        vary.changeTicks(at(1));
        return NULL_REG;
      case SCI_PAL_VARY.pauseResume:
        vary.pause(at(1) !== 0);
        return NULL_REG;
      default:
        world.log(`PalVary sub-function ${at(0)} is not one of the seven Sierra defined.`);
        return NULL_REG;
    }
  },

  /**
   * `SetNowSeen(object)` — record where this actor's cel actually is.
   *
   * The `nsRect` — `nsLeft`, `nsTop`, `nsRight`, `nsBottom` — is the rectangle
   * the actor was last drawn in, and it is what **every click test and every
   * collision in the game is measured against**. Answering nothing left it at
   * whatever the script last put there, usually nought: an actor you could not
   * click on, standing in a rectangle of zero size at the top-left corner.
   *
   * Written only when the object has the Selectors (`compare.cpp:225`): a
   * script calls this on things that have no `nsTop`, and inventing properties
   * on one would change what the object *is*.
   */
  SetNowSeen: (world, args) => {
    const object = world.machine.object(args[0] ?? NULL_REG);
    if (!object) return NULL_REG;
    if (!hasProperty(world, object, 'nsTop')) return NULL_REG;

    const rect = world.celRect?.(
      readProperty(world, object, 'view'),
      readProperty(world, object, 'loop'),
      readProperty(world, object, 'cel'),
      signed(readPropertyReg(world, object, 'x')),
      signed(readPropertyReg(world, object, 'y')),
      signed(readPropertyReg(world, object, 'z')),
    );
    // **A View that has not been read yet is waited for, not given up on.**
    //
    // A SCI32 Volume is not in memory (ADR 0021), so the first `SetNowSeen` of
    // a room routinely arrives before the View it measures — and a game calls
    // it *once* for anything that does not move. Returning here leaves `nsRect`
    // at nought for the life of the screen, and `nsRect` is what a script's own
    // `onMe` tests: King's Quest VII's chapter-select digits each compare the
    // event against four property words that were never written, so all six
    // answered "not on me" and the panel could be read and never used. Sixty
    // thousand polls a second, every one of them false.
    if (!rect) {
      world.deferNowSeen?.(args[0] ?? NULL_REG, readProperty(world, object, 'view'));
      return NULL_REG;
    }

    setProperty(world, object, 'nsLeft', rect.left);
    setProperty(world, object, 'nsTop', rect.top);
    setProperty(world, object, 'nsRight', rect.right);
    setProperty(world, object, 'nsBottom', rect.bottom);
    return NULL_REG;
  },

  /**
   * `BaseSetter(object)` — record where this actor's *feet* are.
   *
   * The `brRect` is the cel's rectangle with its height replaced by `yStep`:
   * the strip of floor an actor occupies, which is what walk boxes and control
   * lines are tested against rather than the whole sprite. An actor's head
   * passing through a doorway is not the question; its feet are.
   *
   * `bottom = y + 1` and `top = bottom - yStep` are Sierra's
   * (`compare.cpp:204`), and they overwrite the cel rectangle's own vertical
   * extent rather than adjusting it.
   */
  BaseSetter: (world, args) => {
    const object = world.machine.object(args[0] ?? NULL_REG);
    if (!object) return NULL_REG;
    // Sierra checks `brLeft` is a variable on this object before doing any of
    // it, and so does this.
    if (!hasProperty(world, object, 'brLeft')) return NULL_REG;

    const y = signed(readPropertyReg(world, object, 'y'));
    const rect = world.celRect?.(
      readProperty(world, object, 'view'),
      readProperty(world, object, 'loop'),
      readProperty(world, object, 'cel'),
      signed(readPropertyReg(world, object, 'x')),
      y,
      signed(readPropertyReg(world, object, 'z')),
    );
    if (!rect) return NULL_REG;

    const bottom = y + 1;
    setProperty(world, object, 'brLeft', rect.left);
    setProperty(world, object, 'brRight', rect.right);
    setProperty(world, object, 'brBottom', bottom);
    setProperty(world, object, 'brTop', bottom - readProperty(world, object, 'yStep'));
    return NULL_REG;
  },

  /**
   * `InitBresen(mover, stepFactor)` — plan a walk from here to there.
   *
   * **This is how a SCI actor moves**, and it was `() => NULL_REG`: the mover's
   * `dx`, `dy` and the three Bresenham accumulators stayed nought, so `DoBresen`
   * had nothing to step along and every walk in every game stood still. A
   * script that says "go to the door" got an actor that never arrived, and the
   * `moveDone` it was waiting for never came — which is a game that looks like
   * it has hung rather than one that reports anything.
   *
   * Transcribed from `kInitBresen` (`engines/sci/engine/kmovement.cpp:165`).
   * The loop that shrinks `xStep` is Sierra's and is not an optimisation: it
   * finds a step pair whose vertical part the actor's `yStep` can actually
   * cover, so a steep diagonal is walked as a staircase rather than a jump.
   */
  InitBresen: (world, args) => {
    const mover = world.machine.object(args[0] ?? NULL_REG);
    if (!mover) return NULL_REG;
    const client = world.machine.object(readPropertyReg(world, mover, 'client'));
    if (!client) return NULL_REG;

    const stepFactor = args.length >= 2 ? (args[1]?.offset ?? 1) : 1;
    const moverX = signed(readPropertyReg(world, mover, 'x'));
    const moverY = signed(readPropertyReg(world, mover, 'y'));
    let xStep = signed(readPropertyReg(world, client, 'xStep')) * stepFactor;
    const yStep = signed(readPropertyReg(world, client, 'yStep')) * stepFactor;

    let remaining = (xStep < yStep ? yStep : xStep) * 2;
    const deltaX = moverX - signed(readPropertyReg(world, client, 'x'));
    const deltaY = moverY - signed(readPropertyReg(world, client, 'y'));

    // Declared without values: the loop below runs at least once and assigns
    // every one of them before anything reads one.
    let dx: number;
    let dy: number;
    let i1: number;
    let i2: number;
    let di: number;
    let incr: number;
    let xAxis: number;

    for (;;) {
      dx = xStep;
      dy = yStep;
      incr = 1;

      if (Math.abs(deltaX) >= Math.abs(deltaY)) {
        xAxis = 1;
        if (deltaX < 0) dx = -dx;
        dy = deltaX ? Math.trunc((dx * deltaY) / deltaX) : 0;
        i1 = (dx * deltaY - dy * deltaX) * 2;
        if (deltaY < 0) {
          incr = -1;
          i1 = -i1;
        }
        i2 = i1 - deltaX * 2;
        di = i1 - deltaX;
        if (deltaX < 0) {
          i1 = -i1;
          i2 = -i2;
          di = -di;
        }
      } else {
        xAxis = 0;
        if (deltaY < 0) dy = -dy;
        dx = deltaY ? Math.trunc((dy * deltaX) / deltaY) : 0;
        i1 = (dy * deltaX - dx * deltaY) * 2;
        if (deltaX < 0) {
          incr = -1;
          i1 = -i1;
        }
        i2 = i1 - deltaY * 2;
        di = i1 - deltaY;
        if (deltaY < 0) {
          i1 = -i1;
          i2 = -i2;
          di = -di;
        }
        break;
      }

      if (xStep <= yStep) break;
      if (!xStep) break;
      if (yStep >= Math.abs(dy + incr)) break;

      remaining--;
      if (!remaining) {
        // Sierra calls `error()` here. This one says so and takes the plan it
        // has: a halted interpreter loses every later finding in the same run,
        // and a walk that is slightly wrong is visible where a stopped game is
        // only puzzling.
        world.log(
          `InitBresen could not find a step pair for a walk of (${deltaX}, ${deltaY}) with ` +
            `steps (${xStep}, ${yStep}); the last pair tried is being used.`,
        );
        break;
      }
      xStep--;
    }

    setProperty(world, mover, 'dx', dx);
    setProperty(world, mover, 'dy', dy);
    setProperty(world, mover, 'b-i1', i1);
    setProperty(world, mover, 'b-i2', i2);
    setProperty(world, mover, 'b-di', di);
    setProperty(world, mover, 'b-incr', incr);
    setProperty(world, mover, 'b-xAxis', xAxis);
    return NULL_REG;
  },

  /**
   * `DoBresen(mover)` — take one step of the walk `InitBresen` planned.
   *
   * Called once a cycle while an actor is moving. It advances the client by
   * `dx`/`dy`, carries the Bresenham error term, asks the client whether it may
   * be where it now is, and puts it back where it was if it may not.
   *
   * **The collision question is asked of the game, not answered here**: a
   * script's `cantBeHere` is sent, and only if the game has no such Selector is
   * `canBeHere` used instead and its answer inverted. That is Sierra's order
   * (`kmovement.cpp:345`) and it matters — the two mean opposite things, and
   * guessing which a game implements gets the sign of every collision wrong.
   *
   * A collision restores **every** client variable rather than just x and y,
   * because the script's own `cantBeHere` may have changed others on its way to
   * saying no, and sets the obstacle bit in `signal` so the script can react.
   *
   * `moveDone` is sent when the client has arrived, from SCI1 EGA-only on. In
   * SCI0 the mover's own script notices instead.
   */
  /**
   * **The Bresenham state is named with hyphens, not underscores.**
   *
   * ScummVM's `selector.cpp` writes `FIND_SELECTOR2(b_movCnt, "b-moveCnt")`,
   * and the two halves are not the same thing: the first is a C++ field name,
   * which cannot hold a hyphen, and the second is what the game's own
   * `vocab.997` calls it. Reading this file as though the identifiers were the
   * names leaves all six of `b-moveCnt`, `b-i1`, `b-i2`, `b-di`, `b-xAxis` and
   * `b-incr` resolving to nothing, and a property that resolves to nothing
   * reads as zero rather than failing.
   *
   * Zero for `b-xAxis` means every mover is tested on the wrong axis, so the
   * arrival test compares a y it will never reach against a `dy` of zero and is
   * never true. King's Quest VII's heroine walked the right way, at the right
   * speed, and straight off the left edge of the room, because the only thing
   * missing was the instruction to stop.
   */
  DoBresen: (world, args) => {
    const mover = world.machine.object(args[0] ?? NULL_REG);
    if (!mover) return NULL_REG;
    const clientRef = readPropertyReg(world, mover, 'client');
    const client = world.machine.object(clientRef);
    if (!client) return NULL_REG;

    const version = world.machine.version;
    const sci0 = version === 'sci0-early' || version === 'sci0-late' || version === 'sci01';
    // SCI0 and SCI01 always increment the move count; SCI1.1 and later always
    // ignore it. ScummVM autodetects the SCI1 middle ground by scanning script
    // 0, which needs a game — so SCI1 is taken as incrementing here, which is
    // the SCI0 behaviour it inherited, and said once rather than assumed
    // silently.
    const ignoresMoveCount =
      version === 'sci1-1' || version.startsWith('sci2') || version === 'sci3';
    const handleMoveCount = !ignoresMoveCount;
    const preSci1 = sci0;

    if (!preSci1) {
      setProperty(world, client, 'signal', readProperty(world, client, 'signal') & ~0x0400);
    }

    let moveCount = 1;
    let moveSpeed = 0;
    if (handleMoveCount) {
      moveCount = signed(readPropertyReg(world, mover, 'b-moveCnt')) + 1;
      moveSpeed = signed(readPropertyReg(world, client, 'moveSpeed'));
    }

    if (moveSpeed < moveCount) {
      moveCount = 0;
      let clientX = signed(readPropertyReg(world, client, 'x'));
      let clientY = signed(readPropertyReg(world, client, 'y'));
      const moverX = signed(readPropertyReg(world, mover, 'x'));
      const moverY = signed(readPropertyReg(world, mover, 'y'));
      const xAxis = readProperty(world, mover, 'b-xAxis');
      const dx = signed(readPropertyReg(world, mover, 'dx'));
      const dy = signed(readPropertyReg(world, mover, 'dy'));
      const incr = signed(readPropertyReg(world, mover, 'b-incr'));
      const originalI1 = signed(readPropertyReg(world, mover, 'b-i1'));
      const originalI2 = signed(readPropertyReg(world, mover, 'b-i2'));
      const originalDi = signed(readPropertyReg(world, mover, 'b-di'));
      let i1 = originalI1;
      let i2 = originalI2;
      let di = originalDi;

      if (!preSci1) {
        setProperty(world, mover, 'xLast', clientX);
        setProperty(world, mover, 'yLast', clientY);
      }

      // Every variable, not only x and y: the script's own `cantBeHere` may
      // have changed others on its way to saying no.
      const backup = [...client.variables];

      // SCI0 stops one step short of the target and SCI1 lands on it — a
      // strictly-less against a less-or-equal, which is one frame of walk.
      const arrived = xAxis
        ? preSci1
          ? Math.abs(moverX - clientX) < Math.abs(dx)
          : Math.abs(moverX - clientX) <= Math.abs(dx)
        : preSci1
          ? Math.abs(moverY - clientY) < Math.abs(dy)
          : Math.abs(moverY - clientY) <= Math.abs(dy);

      if (arrived) {
        clientX = moverX;
        clientY = moverY;
      } else {
        clientX += dx;
        clientY += dy;
        if (di < 0) {
          di += i1;
        } else {
          di += i2;
          if (xAxis === 0) clientX += incr;
          else clientY += incr;
        }
      }
      setProperty(world, client, 'x', clientX);
      setProperty(world, client, 'y', clientY);

      // The game is asked, in Sierra's order: `cantBeHere` where the game has
      // one, `canBeHere` inverted where it does not.
      let collision = false;
      const cantBeHere = world.machine.selectorNumbers?.get('cantBeHere');
      const canBeHere = world.machine.selectorNumbers?.get('canBeHere');
      if (cantBeHere !== undefined && world.machine.resolveMethod(client, cantBeHere)) {
        collision = (world.machine.invoke(clientRef, cantBeHere, [])?.offset ?? 0) !== 0;
      } else if (canBeHere !== undefined && world.machine.resolveMethod(client, canBeHere)) {
        collision = (world.machine.invoke(clientRef, canBeHere, [])?.offset ?? 0) === 0;
      }

      if (collision) {
        client.variables.length = 0;
        client.variables.push(...backup);
        i1 = originalI1;
        i2 = originalI2;
        di = originalDi;
        setProperty(world, client, 'signal', readProperty(world, client, 'signal') | 0x0400);
      }

      setProperty(world, mover, 'b-i1', i1);
      setProperty(world, mover, 'b-i2', i2);
      setProperty(world, mover, 'b-di', di);

      if (!preSci1) {
        if (handleMoveCount) setProperty(world, mover, 'b-moveCnt', moveCount);
        // Compared directly rather than trusting `arrived`: the move just taken
        // may have landed on the target.
        if (clientX === moverX && clientY === moverY) {
          const moveDone = world.machine.selectorNumbers?.get('moveDone');
          // Sent to the *mover*, not the client: it is the mover's business
          // that the journey it was given is over.
          if (moveDone !== undefined) world.machine.invoke(args[0] ?? NULL_REG, moveDone, []);
        }
        return NULL_REG;
      }
    }

    if (handleMoveCount) setProperty(world, mover, 'b-moveCnt', moveCount);
    return NULL_REG;
  },

  /*
   * The four SCI32 calls a game makes and Sierra's interpreter answers by doing
   * nothing (`kernel_tables.h`'s `MAP_EMPTY`).
   *
   * **Not the unused group and not unwritten.** `MAP_DUMMY` means no game is
   * known to call it; `MAP_EMPTY` means games do call it and there is nothing to
   * do — `NewRoom` is a debug hook, `SetWindowsOption` concerns a title bar this
   * has no window for, `VibrateMouse` wants a force-feedback mouse, and
   * `ResourceTrack` is a memory tracker. Nought is the finished answer, so these
   * sit in the constant column and belong there.
   */
  NewRoom: () => NULL_REG,
  SetWindowsOption: () => NULL_REG,
  VibrateMouse: () => NULL_REG,
  ResourceTrack: () => NULL_REG,

  /** `Purge(n)` is SCI32's name for `FlushResources` (`kernel_tables.h`). */
  Purge: () => NULL_REG,

  /**
   * `MulDiv(a, b, c)` — `a * b / c`, rounded half away from zero.
   *
   * SCI32's scaling arithmetic: a script works out a scaled coordinate with it
   * rather than dividing twice and losing the remainder. The rounding is
   * Sierra's — `(|a*b| + |c|/2) / |c|` with the sign put back — and it is not
   * what an integer divide gives, so a plain `a * b / c` is off by one across
   * half its range (`kmath.cpp`).
   *
   * A denominator of nought answers nought and says so. Sierra calls `error()`;
   * halting the interpreter over one arithmetic call loses every later finding
   * in the same run.
   */
  MulDiv: (world, args) => {
    const a = signed(args[0] ?? NULL_REG);
    const b = signed(args[1] ?? NULL_REG);
    const c = signed(args[2] ?? NULL_REG);
    if (c === 0) {
      world.log('MulDiv was asked to divide by zero; it answered nought rather than halting.');
      return NULL_REG;
    }
    const magnitude = Math.trunc((Math.abs(a * b) + Math.trunc(Math.abs(c) / 2)) / Math.abs(c));
    return int(a !== 0 && Math.sign(a) * b * c < 0 ? -magnitude : magnitude);
  },

  /**
   * `IsHiRes()` — is this running 640x480 or 320x200?
   *
   * SCI2.1 games ship both sets of artwork in places and ask before choosing.
   * A flat nought told every game it was low-resolution, which for a game that
   * only has hi-res assets is the wrong branch taken at boot.
   */
  IsHiRes: (world) => {
    const size = world.screenSize?.();
    if (!size) return NULL_REG;
    return size.width < 640 || size.height < 400 ? NULL_REG : int(1);
  },

  /**
   * `SetShowStyle(type, plane, seconds, ...)` — a screen transition.
   *
   * A fade, a wipe, an iris: the game asks for one, and its Styler script then
   * waits for it to finish before going on. **A transition that never starts is
   * a game that never proceeds**, which is a worse failure than a missing
   * animation and is why this exists before any of the animation does.
   *
   * It completes immediately. The Plane is shown, the style is recorded as done
   * and the script's wait ends on its next look — so a room arrives without
   * fading in rather than never arriving. That is a visible difference from
   * Sierra and it is stated rather than hidden: `describeStall` reports the
   * styles a session asked for, so a run says how many transitions it skipped.
   *
   * The argument layout moves twice across SCI2.1 and King's Quest VII is its
   * own exception — ScummVM notes KQ7 2.0b ships "a mismatched version of the
   * Styler script ... so the calls it makes are wrong and put `divisions` where
   * `pFadeArray` is supposed to be" (`kgraphics32.cpp`). Only the first three
   * arguments are read here, and all three are in the same place at every
   * Version, so the layout question does not arise until the animation does.
   */
  SetShowStyle: (world, args) => {
    world.showStyle?.(args[0]?.offset ?? 0, args[1] ?? NULL_REG, signed(args[2] ?? NULL_REG));
    return NULL_REG;
  },

  /**
   * `ShowStylePercent()` — how far through the transition we are.
   *
   * Always finished, because `SetShowStyle` finishes immediately. ScummVM marks
   * this `MAP_DUMMY`; it is answered rather than stubbed because a script that
   * polls it and is told nought forever is the hang this pair exists to avoid.
   */
  ShowStylePercent: () => int(100),

  /**
   * `SetPalStyleRange(from, to)` — which palette entries a transition touches.
   *
   * Recorded rather than acted on: with transitions completing immediately
   * there is no interpolation for a range to narrow. It is kept because the
   * range is a fact about the game's intent, and a later animation needs it —
   * and because answering without recording would make this call look
   * implemented when it had thrown its argument away.
   */
  SetPalStyleRange: (world, args) => {
    world.setPalStyleRange?.(args[0]?.offset ?? 0, args[1]?.offset ?? 255);
    return NULL_REG;
  },

  /**
   * `PalCycle(sub, ...)` — a band of the palette rotating in place.
   *
   * Sierra's cheap animation: water, fire, a spinning light. Five
   * sub-functions (`kernel_tables.h:344`) — set a cycle over a range, step it,
   * pause it, on, off.
   *
   * **Recorded and stepped, not drawn.** The cycle is applied to the palette
   * entries it names, which is where the effect lives: SCI's own cycling is a
   * palette write and nothing about the framebuffer. What is missing is the
   * clock driving `DoCycle` on the game's behalf, so a cycle advances when the
   * game steps it and not on its own.
   */
  PalCycle: (world, args) => {
    const sub = args[0]?.offset ?? 0;
    switch (sub) {
      case 0:
        world.palCycle?.(
          'set',
          args[1]?.offset ?? 0,
          args[2]?.offset ?? 0,
          signed(args[3] ?? NULL_REG),
        );
        return NULL_REG;
      case 1:
        world.palCycle?.('step', args[1]?.offset ?? 0, 0, signed(args[2] ?? NULL_REG));
        return NULL_REG;
      case 2:
        world.palCycle?.('pause', args[1]?.offset ?? 0, 0, 0);
        return NULL_REG;
      case 3:
        world.palCycle?.('on', args[1]?.offset ?? 0, 0, 0);
        return NULL_REG;
      case 4:
        world.palCycle?.('off', args[1]?.offset ?? 0, 0, 0);
        return NULL_REG;
      default:
        world.log(`PalCycle sub-function ${sub} is not one of the five Sierra defined.`);
        return NULL_REG;
    }
  },

  /**
   * `RemapColors(sub, ...)` — SCI2.1's colour remapping.
   *
   * Six sub-functions (`kernel_tables.h:512`): off, by range, by percent, to
   * grey, to a percentage of grey, and a blocked range. A game uses it to grey
   * out a menu, to tint a room, to darken behind a dialogue.
   *
   * **Answered and recorded rather than rendered.** The remap tables belong to
   * the SCI32 compositor, which this engine does not have — so what this does
   * is stop the call being silent and keep what was asked for, which is the
   * difference between a room that is not tinted and a room that is not tinted
   * *and nobody knows why*. `describeStall` reports what a session asked for.
   */
  RemapColors: (world, args) => {
    const sub = args[0]?.offset ?? 0;
    if (sub > 5) {
      world.log(`RemapColors sub-function ${sub} is not one of the six Sierra defined.`);
      return NULL_REG;
    }
    world.remapColors?.(
      sub,
      args.slice(1).map((value) => signed(value)),
    );
    return NULL_REG;
  },

  /**
   * `Bitmap(sub, ...)` — SCI32's off-screen surfaces.
   *
   * Create, destroy, draw into, set an origin, ask its size
   * (`kernel_tables.h:386`). The three `MAP_DUMMY` subs — draw-line,
   * draw-bitmap, invert — are left out rather than approximated, and say so.
   */
  Bitmap: (world, args) => {
    const sub = args[0]?.offset ?? 0;
    const at = (index: number): number => args[index]?.offset ?? 0;

    switch (sub) {
      case 0:
        // `BitmapCreate(width, height, skip, back, ...)`.
        return int(world.bitmapCreate?.(at(1), at(2), at(3), at(4)) ?? 0);
      case 1:
        world.bitmapDestroy?.(at(1));
        return NULL_REG;
      case 4: {
        // `BitmapDrawText(bitmap, text, left, top, right, bottom, fore, back, skip, font, ...)`
        const text = readString(world, args[2] ?? NULL_REG, true);
        world.bitmapDrawText?.(at(1), text, {
          x: signed(args[3] ?? NULL_REG),
          y: signed(args[4] ?? NULL_REG),
          maxWidth: Math.max(0, signed(args[5] ?? NULL_REG) - signed(args[3] ?? NULL_REG)),
          colour: at(7),
          background: at(8),
          font: at(10),
        });
        return NULL_REG;
      }
      case 5:
        // `BitmapDrawColor(bitmap, left, top, right, bottom, colour)`.
        world.bitmapFill?.(
          at(1),
          signed(args[2] ?? NULL_REG),
          signed(args[3] ?? NULL_REG),
          signed(args[4] ?? NULL_REG),
          signed(args[5] ?? NULL_REG),
          at(6),
        );
        return NULL_REG;
      case 8:
        world.bitmapSetOrigin?.(at(1), signed(args[2] ?? NULL_REG), signed(args[3] ?? NULL_REG));
        return NULL_REG;
      case 12: {
        const size = world.bitmapSize?.(at(1));
        // `BitmapGetInfo(bitmap)` with no further argument answers the size;
        // with one it answers a pixel, which needs the caller's own indexing
        // and is not answered here rather than answered wrongly.
        if (!size) return NULL_REG;
        return args.length > 2 ? NULL_REG : int(size.width * size.height);
      }
      default:
        world.log(
          `Bitmap sub-function ${sub} is not implemented. 2, 6, 7, 10, 11 and 13 are the ones ` +
            `Sierra's own table marks as never called; the rest draw.`,
        );
        return NULL_REG;
    }
  },

  /**
   * `CreateTextBitmap(sub, [width, height,] object)` — a bitmap of a string.
   *
   * **This is how a SCI32 game draws any text at all.** SCI16 put a string
   * straight on the screen through `Display`; SCI32 builds a bitmap, renders
   * into it, and hangs it on a screen item. A game with no bitmaps therefore
   * has no text — not text in the wrong place, none — which is what leaves
   * King's Quest VII waiting for a click on a menu it believes it drew.
   *
   * Every attribute is read off the object the script passes rather than from
   * the arguments: `text`, `font`, `fore`, `back`, `skip` and the text
   * rectangle (`kgraphics32.cpp`). Reading them from the wrong place is the
   * fault that produces a bitmap of the right size with nothing in it.
   */
  CreateTextBitmap: (world, args) => {
    const sub = args[0]?.offset ?? 0;
    const objectRef = sub === 0 ? (args[3] ?? NULL_REG) : (args[1] ?? NULL_REG);
    const object = world.machine.object(objectRef);
    if (!object) {
      world.log(
        `CreateTextBitmap was passed something that is not an object, so no text was made.`,
      );
      return NULL_REG;
    }

    const text = readString(world, readPropertyReg(world, object, 'text'), true);
    const width = sub === 0 ? (args[1]?.offset ?? 0) : readProperty(world, object, 'textWidth');
    const height = sub === 0 ? (args[2]?.offset ?? 0) : readProperty(world, object, 'textHeight');

    return int(
      world.textBitmap?.({
        text,
        width,
        height,
        font: readProperty(world, object, 'font'),
        fore: readProperty(world, object, 'fore'),
        back: readProperty(world, object, 'back'),
        skip: readProperty(world, object, 'skip'),
      }) ?? 0,
    );
  },

  /**
   * `IsOnMe(x, y, object, checkPixel)` — is the pointer over this thing?
   *
   * **How a SCI32 game decides what the mouse is on.** A menu item, a hotspot,
   * an inventory square: the script asks this of each candidate and acts on the
   * first that says yes. Answering a constant makes every one of them either
   * always hit or never hit, and a game whose menu is drawn but not clickable
   * looks exactly like a game that has frozen.
   *
   * The rectangle is the object's `nsRect`, which `SetNowSeen` fills — so this
   * call only became answerable once that one was. `checkPixel` then asks
   * whether the point is on an inked pixel rather than on the transparent part
   * of the cel's box, which is what makes an irregular shape clickable only
   * where it is drawn.
   *
   * **What is not here is the scaling.** ScummVM maps the point through the
   * plane's rectangle and the screen item's scale (`frameout.cpp:1306`); this
   * engine has neither, so an unscaled hit test is what it can honestly do. A
   * scaled item will be hit slightly wrong and this says so rather than
   * pretending the arithmetic is complete.
   */
  IsOnMe: (world, args) => {
    const x = signed(args[0] ?? NULL_REG);
    const y = signed(args[1] ?? NULL_REG);
    const object = world.machine.object(args[2] ?? NULL_REG);
    if (!object) return NULL_REG;

    // **A SCI32 object is hit-tested against the display list, not against its
    // `nsRect`.** `GfxFrameout::kernelIsOnMe` finds the ScreenItem the object
    // owns and asks its *screen* rectangle, which is the only rectangle that
    // knows the artwork's resolution — a `nsRect` is in script coordinates and
    // a 640x480 button on a 320x200 script does not have one that matches.
    //
    // King's Quest VII's menu is the case: its buttons carry no `nsRect` at
    // all, so every click on "Start New Game" answered no and the menu could
    // be read and not used.
    //
    // Null means this object is not on the display list, which is every SCI16
    // object and a SCI32 one the game has not added yet — those fall through
    // to the `nsRect` below, unchanged.
    const onItem = world.screenItemHit?.(
      `${(args[2] ?? NULL_REG).segment}:${(args[2] ?? NULL_REG).offset}`,
      x,
      y,
      (args[3]?.offset ?? 0) !== 0,
    );
    if (onItem !== undefined && onItem !== null) return onItem ? int(1) : NULL_REG;

    const left = signed(readPropertyReg(world, object, 'nsLeft'));
    const top = signed(readPropertyReg(world, object, 'nsTop'));
    const right = signed(readPropertyReg(world, object, 'nsRight'));
    const bottom = signed(readPropertyReg(world, object, 'nsBottom'));
    if (x < left || x >= right || y < top || y >= bottom) return NULL_REG;

    if ((args[3]?.offset ?? 0) === 0) return int(1);

    // On the drawn part rather than on the transparent part of its box, which
    // is what makes an irregular shape clickable only where it is inked.
    const skip = world.celSkipAt?.(
      readProperty(world, object, 'view'),
      readProperty(world, object, 'loop'),
      readProperty(world, object, 'cel'),
      x - left,
      y - top,
    );
    return skip === true ? NULL_REG : int(1);
  },
  /** SCI2's name for the same question; SCI2.1 renamed it `IsOnMe`. */
  OnMe: (world, args) => SCI_KERNEL.IsOnMe(world, args),

  /**
   * `ObjectIntersect(a, b)` — how much of these two overlap, in pixels.
   *
   * The *area* rather than a yes or no, which is what a script compares against
   * a threshold: brushing past something is not the same as standing on it.
   * Both rectangles are `nsRect`s, so this became answerable with `SetNowSeen`
   * as `IsOnMe` did.
   *
   * An object with no `nsRect` answers nought rather than a large number.
   * ScummVM notes SSCI would have used an uninitialised rectangle at
   * 0x89ABCDEF, which cannot intersect anything real (`frameout.cpp`), so
   * nought is the same answer arrived at honestly.
   */
  ObjectIntersect: (world, args) => {
    const rect = (value: Reg): [number, number, number, number] | null => {
      const object = world.machine.object(value);
      if (!object || !hasProperty(world, object, 'nsTop')) return null;
      return [
        signed(readPropertyReg(world, object, 'nsLeft')),
        signed(readPropertyReg(world, object, 'nsTop')),
        signed(readPropertyReg(world, object, 'nsRight')),
        signed(readPropertyReg(world, object, 'nsBottom')),
      ];
    };

    const a = rect(args[0] ?? NULL_REG);
    const b = rect(args[1] ?? NULL_REG);
    if (!a || !b) return NULL_REG;

    const width = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
    const height = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
    return width <= 0 || height <= 0 ? NULL_REG : int(width * height);
  },

  /**
   * `TextWidth(text, font)` — how wide this string is in that font.
   *
   * A script lays a window out with it before drawing anything, so a nought
   * answer is a window of no width — text that is technically drawn and
   * nowhere to be seen. `measureSciText` is the same measurement `TextSize`
   * makes, which is the point: two measurements that disagree put a box and
   * its contents in different places.
   */
  TextWidth: (world, args) => {
    const measured = world.measureText?.(
      readString(world, args[0] ?? NULL_REG, true),
      args[1]?.offset ?? 0,
      0,
    );
    return int(measured?.width ?? 0);
  },

  /** `PointSize(font)` — the line height a font declares, for the same layout. */
  PointSize: (world, args) => int(world.measureText?.('', args[0]?.offset ?? 0, 0)?.height ?? 0),

  /**
   * `GetHighPlanePri()` — the highest priority any Plane is at.
   *
   * A script asks before adding a Plane it wants on top of everything: it takes
   * this answer and adds one. Answering a constant nought puts every such Plane
   * at priority one, which is under any Plane the game had already placed —
   * so the window a script meant to put in front goes behind, and nothing on
   * screen says why.
   */
  GetHighPlanePri: (world) => int(world.highestPlanePriority?.() ?? 0),

  /** The same question of the items on a Plane, which a script stacks the same way. */
  GetHighItemPri: (world, args) =>
    int(world.highestItemPriority?.(planeId(args[0] ?? NULL_REG)) ?? 0),

  AssertPalette: (world, args) => {
    world.assertPalette?.(args[0]?.offset ?? 0);
    return NULL_REG;
  },

  /**
   * `ResCheck(type, number)` — is this resource there?
   *
   * A game asks before loading something optional: a floppy release checks for
   * the speech its CD sibling ships and takes the text path when the answer is
   * no. Answering a flat nought — which is what an absent handler did — tells
   * every game that nothing is present, and answering a flat one would tell it
   * everything is. Either is a lie the game acts on, which is why this reads the
   * resource map.
   *
   * The `audio36`/`sync36` tuple form takes six arguments and is not answered
   * here: those are addressed by (noun, verb, cond, seq) rather than by number,
   * and reporting a tuple as present because a resource of that *number* exists
   * would be worse than reporting it absent.
   */
  ResCheck: (world, args) => {
    const type = args[0]?.offset ?? 0;
    if (args.length >= 6) return int(0);
    return int(world.resourcePresent?.(type, args[1]?.offset ?? 0) ? 1 : 0);
  },

  /**
   * `Array(sub, ...)` — SCI32's typed arrays.
   *
   * The sub-function numbering is Sierra's and is transcribed from ScummVM's
   * `kArray_subops`, the same source the SCI32 Kernel tables came from. **Sub 7
   * does not exist** — ScummVM's table says so in a comment and skipping it
   * silently would be the sort of gap that reads as an implemented call.
   *
   * A sub-function this does not implement reports itself by number rather than
   * answering zero, which is the rule everywhere else in this file.
   */
  Array: (world, args) => {
    const sub = args[0]?.offset ?? 0;
    const ref = args[1] ?? NULL_REG;
    switch (sub) {
      case 0:
        // **Size first, then type** — the order Sierra's own `Array::new`
        // states: it compiles to `callKernel(0, size, self.elementType)`, with
        // the class's type held in a property and the size passed in. Read the
        // other way round an `IntArray new:` asks for ten elements of type 0
        // and gets zero elements of type ten, and every script that fills one
        // then reads zeroes back. That is why King's Quest VII's ego walked to
        // (0, 0): `PolyPath` copies `AvoidPath`'s answer into a fresh
        // `IntArray`, and the fresh array had no room in it.
        return world.heap.newArray(args[2]?.offset ?? 0, args[1]?.offset ?? 0);
      case 1:
        return int(world.heap.arrayLength(ref));
      case 2:
        return int(world.heap.arrayAt(ref, args[2]?.offset ?? 0));
      case 3: {
        const from = args[2]?.offset ?? 0;
        // Grows to fit, as `SciArray::setElements` does: a script may set past
        // the end of an array it has only just made.
        world.heap.arrayResize(ref, from + Math.max(0, args.length - 3));
        for (let i = 3; i < args.length; i++) {
          world.heap.arrayPut(ref, from + i - 3, args[i]?.offset ?? 0);
        }
        return ref;
      }
      case 4:
        world.heap.free(ref);
        return NULL_REG;
      case 5: {
        const from = args[2]?.offset ?? 0;
        const count = signed(args[3] ?? NULL_REG);
        const value = args[4]?.offset ?? 0;
        const last = count < 0 ? world.heap.arrayLength(ref) : from + count;
        world.heap.arrayResize(ref, last);
        for (let i = from; i < last; i++) world.heap.arrayPut(ref, i, value);
        return ref;
      }
      case 6: {
        const target = args[1] ?? NULL_REG;
        const targetFrom = args[2]?.offset ?? 0;
        const source = args[3] ?? NULL_REG;
        const sourceFrom = args[4]?.offset ?? 0;
        const count = signed(args[5] ?? NULL_REG);
        const last = count < 0 ? world.heap.arrayLength(source) - sourceFrom : count;
        // `SciArray::copy` resizes **both** sides before moving anything, and
        // the target is the one that matters: the caller is usually a freshly
        // made array being filled for the first time.
        if (last > 0) {
          world.heap.arrayResize(target, targetFrom + last);
          world.heap.arrayResize(source, sourceFrom + last);
        }
        for (let i = 0; i < last; i++) {
          world.heap.arrayPut(target, targetFrom + i, world.heap.arrayAt(source, sourceFrom + i));
        }
        return target;
      }
      case 8: {
        const length = world.heap.arrayLength(ref);
        const copy = world.heap.newArray(world.heap.arrayType(ref) ?? 0, length);
        for (let i = 0; i < length; i++) world.heap.arrayPut(copy, i, world.heap.arrayAt(ref, i));
        return copy;
      }
      case 9: {
        // An **object** is asked for its `data`; a reference already is the
        // data. `kArrayGetData` draws that distinction and scripts rely on it:
        // `Array::copyToFrom` passes on whatever it was handed, which is an
        // Array instance as often as it is a raw reference.
        const holder = world.machine.object(ref);
        return holder ? readPropertyReg(world, holder, 'data') : ref;
      }
      default:
        world.log(
          `Array sub-function ${sub} is not implemented. Sierra's own table has no sub 7 at ` +
            `all, so a number above 9 is either SCI3's byte copy or a misread argument.`,
        );
        return NULL_REG;
    }
  },

  /**
   * `String(sub, ...)` — SCI32's strings, which are byte arrays with more verbs.
   *
   * Sub-functions 0 to 9 are the array ones over a byte-wide array, which is
   * why ScummVM maps several of them straight onto `kArray`'s. The string-only
   * verbs above them are numbered differently from SCI2.1 *late* onwards, and
   * this implements the numbering used from SCI2 through SCI2.1 middle —
   * which is every SCI32 demo there is free data for.
   */
  String: (world, args) => {
    const sub = args[0]?.offset ?? 0;
    const ref = args[1] ?? NULL_REG;
    const text = (value: Reg): string => {
      const length = world.heap.arrayLength(value);
      let out = '';
      for (let i = 0; i < length; i++) {
        const code = world.heap.arrayAt(value, i);
        if (code === 0) break;
        out += String.fromCharCode(code);
      }
      return out;
    };

    switch (sub) {
      case 0:
        // Type 3 always: ScummVM's table notes that the second argument is
        // passed and unused, because a new string is a string.
        return world.heap.newArray(3, args[1]?.offset ?? 0);
      case 2:
        return int(world.heap.arrayAt(ref, args[2]?.offset ?? 0));
      case 7: {
        const a = text(ref);
        const b = text(args[2] ?? NULL_REG);
        return int(a === b ? 0 : a < b ? 0xffff : 1);
      }
      case 10:
        return int(text(ref).length);
      case 13:
        return int(Number.parseInt(text(ref), 10) || 0);
      case 15:
      case 16: {
        const changed = sub === 15 ? text(ref).toUpperCase() : text(ref).toLowerCase();
        for (let i = 0; i < changed.length; i++) {
          world.heap.arrayPut(ref, i, changed.charCodeAt(i));
        }
        return ref;
      }
      case 11:
      case 12: {
        // `Format` and `FormatAt`, and Sierra implements the first as the
        // second with a null destination (`kstring.cpp`) — so they are one
        // handler here for the same reason.
        //
        // A `Str` object may be passed where string data is expected, in which
        // case the text is behind its `data` Selector. That indirection is the
        // detail that makes a formatted line come out empty rather than wrong.
        const destination = sub === 12 ? ref : NULL_REG;
        const sourceRef = sub === 12 ? (args[2] ?? NULL_REG) : ref;
        const values = args.slice(sub === 12 ? 3 : 2);

        const read = (value: Reg): string => {
          const object = world.machine.object(value);
          return text(object ? readPropertyReg(world, object, 'data') : value);
        };

        const formatted = formatSciString(read(sourceRef), values, read);
        const target = isNull(destination)
          ? world.heap.newArray(3, formatted.length + 1)
          : destination;
        for (let index = 0; index < formatted.length; index++) {
          world.heap.arrayPut(target, index, formatted.charCodeAt(index));
        }
        world.heap.arrayPut(target, formatted.length, 0);
        return target;
      }
      default:
        // 1, 3, 4, 5, 6, 8 and 9 are the array verbs over the same block, so
        // they are answered by the array implementation rather than repeated.
        if (sub === 1 || (sub >= 3 && sub <= 6) || sub === 8 || sub === 9) {
          return SCI_KERNEL.Array(world, args);
        }
        world.log(
          `String sub-function ${sub} is not implemented. 17 and 18 are the substring ` +
            `replacements; neither is guessable from the number.`,
        );
        return NULL_REG;
    }
  },

  /**
   * `List(sub, ...)` — SCI2.1 folded the list calls into one Kernel number.
   *
   * SCI16 had seventeen separate ordinals for these; SCI2.1 has one with a
   * sub-function, and the sub-function numbering is transcribed from ScummVM's
   * `kList_subops`. Every one of them is an operation this engine already
   * implements for SCI16 under its own name, so this dispatches to those rather
   * than writing a second list.
   *
   * **Subs 19 to 22 are not dispatched here and report themselves.**
   * `ListEachElementDo`, `ListFirstTrue`, `ListAllTrue` and `ListSort` send a
   * Selector to every element, and a send from inside a Kernel handler is a
   * re-entry into the machine this engine does not do yet. Reporting is the
   * honest answer: a game whose `firstTrue` quietly returns nothing is a game
   * that runs and takes the wrong branch.
   */
  List: (world, args) => {
    const sub = args[0]?.offset ?? 0;
    const rest = args.slice(1);
    const call = (name: string): Reg => SCI_KERNEL[name](world, rest);
    switch (sub) {
      case 0:
        return world.heap.newList();
      case 1:
        world.heap.disposeList(rest[0] ?? NULL_REG);
        return NULL_REG;
      case 2:
        return call('NewNode');
      case 3:
        return call('FirstNode');
      case 4:
        return call('LastNode');
      case 5:
        return call('EmptyList');
      case 6:
        return call('NextNode');
      case 7:
        return call('PrevNode');
      case 8:
        return call('NodeValue');
      case 9:
      case 12:
        // 9 is `AddAfter`. 12 is `AddBefore` in Sierra's table and is a slot
        // she never wrote — ScummVM's handler is an `error()` — so a game
        // reaching it is a finding either way, and inserting after the named
        // node is the nearest thing to an answer.
        return call('AddAfter');
      case 10:
        return call('AddToFront');
      case 11:
        return call('AddToEnd');
      case 13:
      case 14:
        // **Not entries in `SCI_KERNEL`, because Sierra's Kernel has no such
        // calls.** `MoveToFront` and `MoveToEnd` exist only as sub-functions of
        // SCI32's `List`, so a top-level handler for them would be a name no
        // Version's table can reach — which is what `unreachableHandlers` is
        // there to refuse.
        if (sub === 13) world.heap.moveToFront(rest[0] ?? NULL_REG, rest[1] ?? NULL_REG);
        else world.heap.moveToEnd(rest[0] ?? NULL_REG, rest[1] ?? NULL_REG);
        return rest[0] ?? NULL_REG;
      case 15:
        return call('FindKey');
      case 16:
        return call('DeleteKey');
      case 17: {
        // `ListAt(list, index)`, which SCI16 has no equivalent of: walked here
        // rather than added to the heap, because an index into a linked list is
        // a walk however it is spelled.
        let node = world.heap.list(rest[0] ?? NULL_REG)?.first ?? NULL_REG;
        for (let i = rest[1]?.offset ?? 0; i > 0 && !isNull(node); i--) {
          node = world.heap.node(node)?.next ?? NULL_REG;
        }
        return world.heap.node(node)?.value ?? NULL_REG;
      }
      case 18: {
        const wanted = rest[1] ?? NULL_REG;
        let node = world.heap.list(rest[0] ?? NULL_REG)?.first ?? NULL_REG;
        for (let index = 0; !isNull(node); index++) {
          const value = world.heap.node(node)?.value ?? NULL_REG;
          if (value.segment === wanted.segment && value.offset === wanted.offset) {
            return int(index);
          }
          node = world.heap.node(node)?.next ?? NULL_REG;
        }
        // Sierra's own answer for "not in the list", and not zero, which is a
        // valid index.
        return int(0xffff);
      }
      case 19:
      case 20:
      case 21:
        // `ListEachElementDo`, `ListFirstTrue` and `ListAllTrue`: send a
        // Selector to every element and answer from what comes back. All three
        // re-enter the machine, which `PMachine.invoke` does — it was written
        // for `Sort` and this is the second caller.
        return listSelectorWalk(world, sub, rest);
      default:
        world.log(`List sub-function ${sub} is not implemented.`);
        return NULL_REG;
    }
  },

  /**
   * `Save(sub, ...)` — SCI32's saved games, folded into one Kernel number.
   *
   * Sub-function numbering from ScummVM's `kSave_subops`. **Sub 4 has never
   * been seen**, which its table says in a comment, so it falls to the default
   * and reports itself rather than being quietly accepted.
   *
   * What this answers is "there are no saved games", which is the truth: the
   * browser holds saves through `SavedGameEnvelope` and not as files in the
   * game's own directory, so `GetSaveFiles32` has nothing to list. Saying so is
   * what lets a game's startup finish — Torin's opening spins on this call,
   * asking 436,361 times in twenty seconds of game time.
   *
   * Saving and restoring themselves are **not** wired here. A SCI save is the
   * object graph (ADR 0019) and the engine has that path already; routing
   * SCI32's file-shaped calls into it is its own piece of work, and answering
   * "saved" without having saved would be worse than reporting.
   */
  Save: (world, args) => {
    const sub = args[0]?.offset ?? 0;
    switch (sub) {
      case 2:
        // The save directory, as an empty string a script can read and print.
        return world.heap.allocate(2);
      case 3:
        // `CheckSaveGame32` — this save is not one this build wrote.
        return int(0);
      case 5:
        // `GetSaveFiles32` — no files, which is the honest count.
        return int(0);
      case 6:
      case 7:
        // The catalogue and file names a save *would* use. Answered as empty
        // rather than invented, because a name this engine does not write to is
        // a name no game should be told exists.
        return args[1] ?? NULL_REG;
      case 8:
        // `GameIsRestarting`, which SCI16 has as its own ordinal and answers
        // the same way.
        return int(0);
      case 0:
        // **`SaveGame32`, answered as having succeeded.** King's Quest VII
        // writes a chapter-start save the moment a chapter is picked, and
        // reads the answer: told nought, it treats the save as failed and the
        // chapter never starts — the room comes up with its interface bar and
        // nothing else, and a player is left on an empty screen with no way
        // forward. Answered as written, the same click carries straight into
        // the game's first room with its scenery on it.
        //
        // Nothing is written, and that is the uncomfortable half: this tells
        // the game a save exists that does not. It is the same trade
        // `CheckFreeSpace` above already makes and it is a worse one, because
        // a player could go looking for the slot — so it is narrow on purpose,
        // only sub 0, and it goes when the save path is wired up (ADR 0019).
        world.log(
          `A save was asked for and answered as written without writing one, so the game ` +
            `carries on. This engine has the object graph a SCI save is made of and not the ` +
            `route from SCI32's file-shaped call to it; until it does, the alternative is a ` +
            `game that stops at its own chapter select.`,
        );
        return int(1);
      case 1:
        world.log(
          `Save sub-function ${sub} is saving or restoring, which is not wired to this ` +
            `engine's own save path yet. A SCI save is the object graph (ADR 0019) and the ` +
            `engine has that; what is missing is the route from SCI32's file-shaped call to it.`,
        );
        return int(0);
      default:
        world.log(
          `Save sub-function ${sub} is not implemented. Sierra's own table has never seen a ` +
            `sub 4, so a number above 8 is a misread argument rather than a feature.`,
        );
        return NULL_REG;
    }
  },

  // ------------------------------------------------- the SCI32 compositor ---
  //
  // SCI32 moved drawing from "paint a Picture and animate a cast" to a display
  // list: the game builds Plane and ScreenItem objects, hands them over, and
  // asks for a frame. **#218 and #225 built that compositor and nothing had
  // connected a game to it** — every one of these calls reported itself, so a
  // SCI32 game ran its whole display loop into nothing.
  //
  // Read by Selector name through the game's own table, for the reason
  // `DrawControl` is: which property number `left` is differs per game.
  AddPlane: (world, args) => {
    const object = world.machine.object(args[0] ?? NULL_REG);
    if (!object) return NULL_REG;
    const rect = planeRect(world, object);
    world.addPlane?.(
      planeId(args[0] ?? NULL_REG),
      rect,
      readProperty(world, object, 'priority'),
      readProperty(world, object, 'picture'),
      readProperty(world, object, 'back'),
    );
    return NULL_REG;
  },
  UpdatePlane: (world, args) => SCI_KERNEL.AddPlane(world, args),
  /**
   * `AddPicAt(plane, picture, x, y, [mirrorX], [deleteDuplicate])`.
   *
   * The last two default the way `kAddPicAt` defaults them
   * (`kgraphics32.cpp`): no mirror, and a repeat of the same Picture number
   * replaces the one already there rather than stacking on it.
   */
  AddPicAt: (world, args) => {
    world.addPicAt?.(
      planeId(args[0] ?? NULL_REG),
      args[1]?.offset ?? 0,
      signedWord(args[2]?.offset ?? 0),
      signedWord(args[3]?.offset ?? 0),
      (args[4]?.offset ?? 0) !== 0,
      args.length > 5 ? (args[5]?.offset ?? 0) !== 0 : true,
    );
    return NULL_REG;
  },
  /**
   * `SetScroll(plane, dx, dy, picture, animate, speed, mirrorX)` — one Picture
   * slid off a Plane while the next slides on.
   *
   * Sierra's `kernelSetScroll` adds the new Picture to the Plane **one screen
   * away** — left or right by the plane's own width, up or down by its height,
   * whichever axis the delta is on — and then walks both towards nought a step
   * a frame until the new one sits where the old one did, deleting the old.
   *
   * **The end state is implemented and the slide is not.** That is the whole of
   * the difference: after this the Plane carries the Picture the game asked
   * for, at the origin it asked for, which is what every line of script after
   * the call depends on. What a player loses is the sweep between the two — a
   * transition, not a screen. Saying that here rather than leaving a reader to
   * infer it from a missing frame.
   *
   * Sierra refuses a delta of nought on both axes and a delta on both at once.
   * Both are refused here too, with the numbers, because either one means the
   * caller computed something wrong and a silent answer would hide it.
   */
  SetScroll: (world, args) => {
    const plane = planeId(args[0] ?? NULL_REG);
    const deltaX = signedWord(args[1]?.offset ?? 0);
    const deltaY = signedWord(args[2]?.offset ?? 0);
    const picture = args[3]?.offset ?? 0;
    const mirrorX = args.length > 6 ? (args[6]?.offset ?? 0) !== 0 : false;

    if (deltaX === 0 && deltaY === 0) {
      world.log(
        'SetScroll was asked for a scroll of nought in both directions, which moves nothing.',
      );
      return NULL_REG;
    }
    if (deltaX !== 0 && deltaY !== 0) {
      world.log(
        `SetScroll was asked to scroll ${deltaX} across and ${deltaY} down at once. SCI ` +
          `scrolls on one axis at a time, so this is a computed delta gone wrong.`,
      );
      return NULL_REG;
    }

    world.setPlanePicture?.(plane, picture, mirrorX);
    world.log(
      `SetScroll put Picture ${picture} on plane "${plane}" at once. The slide between the ` +
        `old Picture and it is a transition this engine does not animate; the screen the ` +
        `game asked for is the screen that is now there.`,
    );
    return NULL_REG;
  },

  DeletePlane: (world, args) => {
    world.deletePlane?.(planeId(args[0] ?? NULL_REG));
    return NULL_REG;
  },
  RepaintPlane: () => NULL_REG,

  AddScreenItem: (world, args) => {
    const object = world.machine.object(args[0] ?? NULL_REG);
    if (!object) return NULL_REG;
    // **The `bitmap` Selector decides what this item is made of.** SCI32's
    // `ScreenItem::setFromObject` reads it last and, when it is not null, sets
    // the cel type to `kCelTypeMem` and ignores the View entirely
    // (`screen_item32.cpp`). That is the whole link between a text bitmap and
    // the screen: without reading it, every menu a SCI32 game builds is a
    // bitmap nothing ever asks for.
    const bitmap = readPropertyReg(world, object, 'bitmap');

    // **An item's priority is its own `y` unless the script fixes it**, and
    // reading `priority` unconditionally is how King's Quest VII's heroine
    // became invisible in her own first room.
    //
    // `ScreenItem::setFromObject`: when `fixPriority` is clear the interpreter
    // takes the priority from the position and **writes it back** into the
    // object's own `priority`, and only when it is set does it read that
    // property. A walking actor leaves `fixPriority` clear — her depth is
    // wherever she is standing — so her `priority` property is whatever it was
    // last left at, which for Rosella is nought. Sorted at nought against a
    // room whose scenery runs from 0 to 190, she was drawn first and then
    // painted over by twenty-one of the thirty-three things on the Plane: on
    // screen at 291,178, sixty-seven pixels wide, and not visible anywhere.
    //
    // The write-back is Sierra's and is not bookkeeping: a script reads
    // `priority` afterwards to decide what is in front of what.
    const y = signedWord(readProperty(world, object, 'y'));
    const fixed = readProperty(world, object, 'fixPriority') !== 0;
    let priority = readProperty(world, object, 'priority');
    if (!fixed) {
      priority = y;
      setProperty(world, object, 'priority', y);
    }

    // **`z` is a height above the floor and it moves the item up.**
    // `_position.y -= _z` in the same function. It is deliberately *not* in the
    // `nsRect` — SCI32 measures that without `z`, which is its own fault fixed
    // earlier — but it is in where the thing is drawn.
    const z = signedWord(readProperty(world, object, 'z'));

    world.addScreenItem?.(
      planeId(args[0] ?? NULL_REG),
      planeId(readPropertyReg(world, object, 'plane')),
      {
        view: readProperty(world, object, 'view'),
        loop: readProperty(world, object, 'loop'),
        cel: readProperty(world, object, 'cel'),
        x: readProperty(world, object, 'x'),
        y: y - z,
        priority,
        bitmap: isNull(bitmap) ? 0 : bitmap.offset,
      },
    );
    return NULL_REG;
  },
  UpdateScreenItem: (world, args) => SCI_KERNEL.AddScreenItem(world, args),
  DeleteScreenItem: (world, args) => {
    world.deleteScreenItem?.(planeId(args[0] ?? NULL_REG));
    return NULL_REG;
  },

  /**
   * `FrameOut` — draw everything the display list now holds.
   *
   * SCI32's whole render is this one call, where SCI16's is `Animate` plus a
   * Picture. It is the moment a frame exists, so it is also the only place the
   * compositor should be asked to run.
   */
  FrameOut: (world) => {
    world.frameOut?.();
    return NULL_REG;
  },

  /**
   * `Format(target, source, ...)` — Sierra's own `sprintf`.
   *
   * **This was a stub that returned its target untouched, and that is why
   * King's Quest IV's opening prompt was an empty box.** The game takes `lea`
   * of a temporary, formats its question into it, hands the address to a
   * `DText`, sizes a window from `TextSize` of the result and opens it. With
   * `Format` writing nothing, every step after it was correct about nothing:
   * the label measured 0x0, the window came out eight pixels wide, and the
   * player was asked a question that was never drawn.
   *
   * The `source` is a string reference *or* a `text` resource number with the
   * line's index after it — the same pair `Display` takes, and the same test:
   * a segment means a reference. The directives are Sierra's, transcribed from
   * ScummVM's `kFormat`: `%d`, `%u`, `%x`, `%c`, `%s`, `%%`, with a field width
   * before the letter, `-` for left and `=` for centre, and a leading `0` to
   * pad with zeros. A `%s` consumes *two* parameters when its argument is a
   * text-resource number rather than a reference, which is the one part a
   * reader would not guess.
   */
  Format: (world, args) => {
    const target = args[0] ?? NULL_REG;
    const source = args[1] ?? NULL_REG;
    const fromResource = source.segment === 0;
    const start = fromResource ? 3 : 2;
    const template = fromResource
      ? (world.farText?.(source.offset, args[2]?.offset ?? 0) ?? '')
      : readString(world, source, true);

    let out = '';
    let parameter = start;
    let at = 0;

    /** One argument, as the number Sierra treats it as. */
    const argument = (index: number): Reg => args[index] ?? NULL_REG;

    while (at < template.length) {
      const character = template[at++];
      if (character !== '%') {
        out += character;
        continue;
      }
      if (template[at] === '%') {
        out += '%';
        at++;
        continue;
      }

      // The width, and how to pad it: `-` left, `=` centre, a leading zero
      // fills with zeros, anything else pads with spaces on the left.
      let fill = ' ';
      let align: 'left' | 'right' | 'centre' = 'right';
      if (template[at] === '=') {
        align = 'centre';
        at++;
      }
      if (template[at] === '0') fill = '0';
      let digits = '';
      if (template[at] === '-') {
        align = 'left';
        at++;
      }
      while (at < template.length && template[at] >= '0' && template[at] <= '9') {
        digits += template[at++];
      }
      const width = digits === '' ? 0 : Number.parseInt(digits, 10);
      const code = template[at++] ?? '';

      let piece: string;
      if (code === 's') {
        const value = argument(parameter);
        if (value.segment === 0) {
          piece = world.farText?.(value.offset, argument(parameter + 1).offset) ?? '';
          parameter += 2;
        } else {
          piece = readString(world, value, true);
          parameter += 1;
        }
      } else if (code === 'c') {
        const value = argument(parameter++).offset & 0xff;
        piece = value === 0 ? '' : String.fromCharCode(value);
      } else if (code === 'd') {
        piece = String(signed(argument(parameter++)));
      } else if (code === 'u') {
        piece = String(argument(parameter++).offset & 0xffff);
      } else if (code === 'x') {
        piece = (argument(parameter++).offset & 0xffff).toString(16);
      } else {
        // A directive this does not know keeps its own letter rather than
        // eating an argument: guessing how many to consume desynchronises
        // every one after it, which is the fault class the Display walk
        // already refuses to commit.
        out += `%${digits}${code}`;
        continue;
      }

      if (piece.length < width) {
        const pad = width - piece.length;
        if (align === 'left') piece += ' '.repeat(pad);
        else if (align === 'centre') {
          const half = pad >> 1;
          piece = ' '.repeat(half) + piece + ' '.repeat(pad - half);
        } else piece = fill.repeat(pad) + piece;
      }
      out += piece;
    }

    writeString(world, target, out);
    return target;
  },

  // ---------------------------------------------------------- graphics ---
  //
  // These are the calls a game makes before it can draw anything, and they are
  // answered rather than implemented — #218 built the renderer and nothing has
  // connected a game's Animate list to it yet. Each returns what a script can
  // carry on from, and every one of them is listed in `describeStall` so a
  // person reading a report can see that the picture is not being drawn rather
  // than inferring it from an empty screen.
  Show: () => NULL_REG,
  PicNotValid: (world, args) => {
    // A script asks whether the Picture it drew is still valid and draws again
    // if not. Answering "not valid" for ever makes a game redraw its room every
    // cycle, which looks identical and costs everything.
    if (args.length > 0) world.setPictureValid?.(args[0].offset === 0);
    return int(world.pictureValid?.() ? 0 : 1);
  },
  /**
   * `DrawPic(number)` — the call that puts a room on the screen.
   *
   * Real, and the reason it is worth being real before the rest of the Kernel
   * is: it is the one call whose effect a person can *see*. A renderer wired to
   * nothing is a renderer nobody has checked, and #218's own acceptance
   * criterion is a PNG a reviewer looks at.
   */
  DrawPic: (world, args) => {
    world.drawPicture?.(args[0]?.offset ?? 0);
    return NULL_REG;
  },
  AddToPic: () => NULL_REG,
  /**
   * `Animate(list, cycle)` — the cast, drawn.
   *
   * Every actor on screen is an object in this list, and each carries its own
   * `view`, `loop`, `cel`, `x`, `y` and `priority` as properties. So this walks
   * the list, reads those Selectors **by name through the game's own table**,
   * and hands each one to the compositor as a screen item.
   */
  Animate: (world, args) => {
    const list = world.heap.list(args[0] ?? NULL_REG);
    if (!list) return NULL_REG;

    const cast: Array<{
      view: number;
      loop: number;
      cel: number;
      x: number;
      y: number;
      priority: number;
    }> = [];
    let at = list.first;
    let guard = 0;
    while (!isNull(at) && guard++ < 256) {
      const node = world.heap.node(at);
      if (!node) break;
      const object = world.machine.object(node.value);
      if (object) {
        const read = (name: string): number => {
          const selector = world.machine.selectorNumbers?.get(name);
          if (selector === undefined) return 0;
          const index = world.machine.resolveProperty(object, selector);
          return index >= 0 ? (object.variables[index]?.offset ?? 0) : 0;
        };
        cast.push({
          view: read('view'),
          loop: read('loop'),
          cel: read('cel'),
          x: read('x'),
          y: read('y'),
          priority: read('priority'),
        });
      }
      at = node.next;
    }

    world.drawCast?.(cast);
    return NULL_REG;
  },
  DrawCel: () => NULL_REG,
  DrawStatus: () => NULL_REG,
  /**
   * `DrawControl(control)` — a button, a label or an edit field.
   *
   * SCI moved the interface into the game's own scripts (ADR 0011), so a
   * control is an *object* with `nsTop`/`nsLeft`/`nsBottom`/`nsRight`, a
   * `type`, a `text` and a `font`, and this reads those through the game's own
   * Selector table rather than by index — which property number `nsLeft` is
   * differs per game.
   *
   * Drawing the text is the whole of what a person sees, and until this existed
   * a SCI game's interface was invisible while the scripts behind it ran
   * correctly: Freddy Pharkas sits at a modal text-input control calling
   * `EditControl` 1,089 times on a blank screen.
   *
   * A control whose type this does not know draws its text and no frame,
   * rather than nothing — a label in the wrong box is legible and an empty box
   * is not.
   */
  DrawControl: (world, args) => {
    const object = world.machine.object(args[0] ?? NULL_REG);
    if (!object) return NULL_REG;
    drawControl(world, object);
    return NULL_REG;
  },
  HiliteControl: () => NULL_REG,
  /**
   * `EditControl(control, event)` — the player typing into a text field.
   *
   * **This was a stub, and a stub is a game that cannot be answered.** King's
   * Quest IV opens with its copy-protection question and an edit field, runs
   * its dialog loop correctly — `EditControl` against `GetEvent`, thousands of
   * times — and a player had no way to put a character in the box.
   *
   * ScummVM's `kEditControl` dispatches on the control's `type` and only a
   * text-edit does anything, which is why the type numbering had to be right
   * first. What it does is Sierra's: a printable character goes in at the
   * cursor and moves it on, backspace takes the one before it, the arrows and
   * Home and End move without editing, and the key is then **claimed** by
   * clearing the event's type so the dialog's own handler does not act on a
   * keystroke that was meant for the field. Enter is deliberately *not*
   * claimed: closing the dialog is the dialog's business, not the field's.
   */
  EditControl: (world, args) => {
    const control = world.machine.object(args[0] ?? NULL_REG);
    const event = world.machine.object(args[1] ?? NULL_REG);
    if (!control || !event) return NULL_REG;
    if (readProperty(world, control, 'type') !== CONTROL_TEXTEDIT) return NULL_REG;
    if (readProperty(world, event, 'type') !== SCI_EVENT.keyDown) return NULL_REG;

    const buffer = readPropertyReg(world, control, 'text');
    const text = readString(world, buffer, true);
    // `max` is the field's own limit and the game sets it; a field that did not
    // would otherwise accept a line longer than the buffer behind it.
    const max = readProperty(world, control, 'max') || 40;
    let cursor = Math.min(readProperty(world, control, 'cursor'), text.length);
    const key = readProperty(world, event, 'message');

    let next = text;
    if (key === KEY_BACKSPACE) {
      if (cursor > 0) {
        next = text.slice(0, cursor - 1) + text.slice(cursor);
        cursor--;
      }
    } else if (key === KEY_LEFT) {
      cursor = Math.max(0, cursor - 1);
    } else if (key === KEY_RIGHT) {
      cursor = Math.min(text.length, cursor + 1);
    } else if (key === KEY_HOME) {
      cursor = 0;
    } else if (key === KEY_END) {
      cursor = text.length;
    } else if (key === KEY_ENTER) {
      // The dialog acts on this, so it is left for the dialog.
      return NULL_REG;
    } else if (key >= 0x20 && key < 0x7f && text.length < max) {
      next = text.slice(0, cursor) + String.fromCharCode(key) + text.slice(cursor);
      cursor++;
    } else {
      return NULL_REG;
    }

    if (next !== text) writeString(world, buffer, next);
    setProperty(world, control, 'cursor', cursor);
    // Repainted here, the way Sierra's own `kernelTexteditChange` does: a
    // field redrawn only when the game's loop decides to shows a player
    // nothing as they type.
    drawControl(world, control);
    // Claimed: the dialog must not also see a key the field consumed.
    setProperty(world, event, 'type', SCI_EVENT.none);
    return NULL_REG;
  },
  /**
   * `Display(text, ...attributes)` — a string drawn straight onto the screen.
   *
   * The attribute list is pairs of a code and its values, and **a code this
   * does not know stops the walk and reports itself** rather than being
   * skipped: the values belong to the code, so guessing how many to skip
   * desynchronises the rest of the list and moves the text somewhere plausible.
   * That is the fault class this renderer exists to avoid, and it is cheaper to
   * refuse than to draw in the wrong place.
   *
   * The codes are Sierra's own `dsCOORD`, `dsFONT` and `dsFOREGROUND`. The
   * others — saving and restoring pixels behind the text, the grey-out — are
   * reported, because each is a thing that changes the picture and none of them
   * is guessable from the number alone.
   */
  Display: (world, args) => {
    // **The first argument is a string *or* a pair, and the segment says
    // which.** ScummVM's `kDisplay` branches on `textp.getSegment()`: a
    // reference is the string itself and the attributes start at argument one;
    // a bare integer is a `text` resource number, argument one is the index of
    // the line within it, and the attributes start at argument *two*.
    //
    // Reading the pair form as the reference form is what made this report
    // "Display attribute 0 is not implemented" on King's Quest IV and stop:
    // the walk had started on the line index.
    const first = args[0] ?? NULL_REG;
    const fromResource = first.segment === 0;
    const text = fromResource
      ? (world.farText?.(first.offset, args[1]?.offset ?? 0) ?? '')
      : readString(world, first, true);
    let x = 0;
    let y = 0;
    let font = 0;
    let colour = 15;
    let width = 0;

    for (let at = fromResource ? 2 : 1; at < args.length;) {
      // A reference where a code belongs is Sierra's own end-of-list marker:
      // `kernelDisplay` rewrites it to 0xffff, which falls through to the
      // default arm and stops the walk.
      const argument = args[at] ?? NULL_REG;
      const code = argument.segment === 0 ? argument.offset : 0xffff;
      const operand = (index: number): number => signed(args[at + index] ?? NULL_REG);

      if (code === DS_MOVEPEN) {
        y = operand(1);
        x = operand(2);
        at += 3;
      } else if (code === DS_FONT) {
        font = operand(1);
        at += 2;
      } else if (code === DS_PEN_COLOUR) {
        colour = operand(1);
        at += 2;
      } else if (code === DS_WIDTH) {
        width = operand(1);
        at += 2;
      } else if (
        code === DS_ALIGNMENT ||
        code === DS_BACKGROUND ||
        code === DS_GREY ||
        code === DS_STROKE
      ) {
        // Read and not acted on: each changes how the text looks rather than
        // where it is, and drawing it in the wrong colour is legible where
        // stopping the walk is not.
        at += 2;
      } else if (code === DS_SAVE_UNDER || code === DS_DONT_SHOW) {
        at += 1;
      } else if (code === DS_RESTORE_UNDER) {
        // Sierra ends the list here, and so does this.
        break;
      } else {
        world.log(
          `Display attribute ${code} is not implemented, so the rest of the attribute list ` +
            `after it was not read. Skipping it would move the text rather than leave it out.`,
        );
        break;
      }
    }

    if (text !== '') world.showText?.(text, { x, y, font, colour, width });
    return NULL_REG;
  },
  ShakeScreen: () => NULL_REG,
  /**
   * `SetCursor(number, visible)` — or, from SCI1.1, a View, loop and cel.
   *
   * Told apart by how many arguments arrived rather than by the Version, for
   * the same reason the Picture kinds are: a release that disagrees with its
   * bucket should still get a pointer. Three or more arguments is the View
   * form; fewer is a cursor resource.
   */
  SetCursor: (world, args) => {
    if (args.length >= 4) {
      world.setViewCursor?.(
        args[0]?.offset ?? 0,
        args[1]?.offset ?? 0,
        args[2]?.offset ?? 0,
        signed(args[3] ?? NULL_REG),
        signed(args[4] ?? NULL_REG),
      );
    } else {
      world.setCursor?.(args[0]?.offset ?? 0, (args[1]?.offset ?? 1) !== 0);
    }
    return NULL_REG;
  },
  GetPort: (world) => int(world.getPort?.() ?? 0),
  SetPort: (world, args) => {
    world.setPort?.(args[0]?.offset ?? 0);
    return NULL_REG;
  },
  /**
   * `NewWindow(top, left, bottom, right, title, style, priority, pen, back)`.
   *
   * The rect is the window's *outer* bounds in screen coordinates and the
   * argument order is Sierra's, which is not the one a reader expects — top
   * before left, bottom before right — so it is written out here. The title is
   * a reference when the window has one and a plain zero when it does not.
   *
   * SCI1.1 slides four more arguments in after the rect, which is what
   * ScummVM's `argextra` is for: at thirteen arguments or more the style and
   * everything after it move along by four.
   */
  NewWindow: (world, args) => {
    const extra = args.length >= 13 ? 4 : 0;
    const at = (index: number): number => signed(args[index] ?? NULL_REG);
    const id =
      world.openWindow?.(
        { top: at(0), left: at(1), bottom: at(2), right: at(3) },
        readString(world, args[4 + extra] ?? NULL_REG, true),
        at(5 + extra),
        {
          pen: args.length > 7 + extra ? at(7 + extra) : 0,
          back: args.length > 8 + extra ? at(8 + extra) : 15,
        },
      ) ?? 0;
    return int(id);
  },
  DisposeWindow: (world, args) => {
    world.closeWindow?.(args[0]?.offset ?? 0);
    return NULL_REG;
  },
  /**
   * `TextSize(rect, text, font, maxWidth)` — how big a string is.
   *
   * **This one changes what a game believes rather than only what it draws.** A
   * script asks how wide a string is and then centres a window on the answer,
   * sizes a button to it, or decides how many lines fit. Answering zero does
   * not make the text invisible; it makes every window one pixel wide and every
   * layout wrong, and the script has no way to find out.
   *
   * The answer goes into the four-word rect the caller passes first, as
   * `(top, left, bottom, right)` — Sierra's order, which is not the one a
   * reader expects and is why it is written out here.
   */
  TextSize: (world, args) => {
    const target = args[0] ?? NULL_REG;
    const text = readString(world, args[1] ?? NULL_REG, true);
    const font = args[2]?.offset ?? 0;
    const maxWidth = signed(args[3] ?? NULL_REG);
    // **A width of nought means the screen, not "do not wrap".** Sierra's own
    // `GfxText16::Size` substitutes the screen width when it is given zero and
    // only measures unwrapped when it is given a negative — and a game sizes a
    // window from the answer. Measured unwrapped, King's Quest IV's "that is
    // not the right answer" box came out 1,093 pixels wide and was placed at
    // x = -386, which is a window nobody can read.
    const wrapAt = maxWidth > 0 ? maxWidth : maxWidth < 0 ? 0 : SCI_SCREEN_WIDTH - 1;
    const size = world.measureText?.(text, font, wrapAt) ?? null;
    if (!size) return NULL_REG;

    const bytes = bytesAt(world, target);
    if (bytes && bytes.length >= 8) {
      const put = (index: number, value: number): void => {
        bytes.set(index * 2, value & 0xff);
        bytes.set(index * 2 + 1, (value >> 8) & 0xff);
      };
      put(0, 0);
      put(1, 0);
      put(2, size.height);
      put(3, size.width);
    }
    return NULL_REG;
  },
  /**
   * `Text(sub, ...)` — SCI2.1 middle's two text measurements.
   *
   * **Not a new reader: the one this file already measures SCI16's text with.**
   * `kText_subops` has exactly two entries (`kernel_tables.h:379`) and both are
   * questions about size, so this is `TextSize`'s arithmetic reached by the
   * name a SCI2.1 game calls it under. King's Quest VII reaches it as soon as
   * it opens its first room, and an unimplemented call answering nought is a
   * game sizing a panel from nothing.
   *
   * **Sub 0 writes into an array, not a rectangle on the stack.** SCI32 hands
   * over one of its own typed arrays and expects left, top, right and bottom
   * written into its first four elements — which is the same four words
   * `TextSize` writes, in the order SCI32 reads them (`kTextSize32`).
   *
   * **Sub 1 is unwrapped**, and that is the difference from `TextSize`'s
   * nought. `kTextWidth` measures with a maximum of 10,000 rather than the
   * screen's width, because it is asking how wide a line *is* and not how wide
   * a window would have to be.
   */
  /**
   * `Font(sub, ...)` — the two font verbs SCI2.1 middle split out of `Text`.
   *
   * Sub-nought is `PointSize` under another name: it selects a font and answers
   * that font's height, which is what a script measures a window against before
   * it opens one. The handler of that name is already here, and this is the
   * same call at the slot a later table gives it rather than a second reader.
   *
   * Sub-one is `SetFontRes`, the resolution text is laid out in. **Recorded and
   * not acted on**, because this engine measures text in the script's own
   * coordinates throughout; a game that changed it and was ignored would be
   * told a height in the wrong units, so the number is kept where a caller that
   * needs it can find it and the fact that nothing reads it is said here rather
   * than discovered.
   */
  Font: (world, args) => {
    const sub = args[0]?.offset ?? 0;
    switch (sub) {
      case 0:
        return int(world.measureText?.('', args[1]?.offset ?? 0, 0)?.height ?? 0);
      case 1:
        world.setTextResolution?.(args[1]?.offset ?? 0, args[2]?.offset ?? 0);
        return NULL_REG;
      default:
        world.log(
          `Font sub-function ${sub} is not one of the two Sierra's own table lists — point ` +
            `size and font resolution — so it is a misread argument rather than a gap.`,
        );
        return NULL_REG;
    }
  },

  /**
   * `CD(sub, ...)` — which disc the game thinks it is reading.
   *
   * Sub-nought checks for a disc and answers the one now current; sub-one
   * answers the disc a save game was made from. **Both answer one here**, and
   * that is the honest answer rather than a placeholder: a Drive install is a
   * single volume set with every disc's resources already in it, so there is
   * one disc and it is always the one mounted. ScummVM answers the same way,
   * from its resource manager's current disc, for the same reason.
   *
   * Answering nought instead would be a game that believes no disc is in, and
   * King's Quest VII asks this from script 0 — at boot, before anything else.
   */
  CD: (world, args) => {
    const sub = args[0]?.offset ?? 0;
    if (sub === 0 || sub === 1) return int(1);
    world.log(
      `CD sub-function ${sub} is not one of the two Sierra's own table lists — check and ` +
        `saved-disc — so it is a misread argument rather than a gap.`,
    );
    return NULL_REG;
  },

  /**
   * `WinHelp(sub, ...)` — the Windows help file, which is not a game screen.
   *
   * Sub-one asks the host to open a `.HLP` file, which is a Windows document
   * beside the game rather than anything this engine draws; King's Quest VII
   * ships `KQ7GAME.HLP`. Sub-two is an initialiser with nothing behind it.
   * ScummVM tells the player to open the file themselves, and this says the
   * same into the log — the point is that the **script carries on**, which is
   * all it was waiting for.
   */
  WinHelp: (world, args) => {
    const sub = args[0]?.offset ?? 0;
    if (sub === 1) {
      const file = readString(world, args[1] ?? NULL_REG, true);
      world.log(
        `The game asked to open its help file${file ? ` "${file}"` : ''}, which is a Windows ` +
          `document beside the game rather than a screen this engine draws. The script was ` +
          `let carry on.`,
      );
    } else if (sub !== 2) {
      world.log(`WinHelp sub-function ${sub} is not one Sierra's own table lists.`);
    }
    return NULL_REG;
  },

  /**
   * `EditText(control)` — a line the player types into, run to completion.
   *
   * **Answered rather than left silent, and the difference is the whole point.**
   * A script calls this and waits; a call that reports itself and returns leaves
   * the window open forever, which is the failure this file's own notes describe
   * for `Message`. Returning the control back hands the script its own object
   * and lets it read whatever text is already in it, so the field behaves as one
   * the player left unchanged rather than as one the game never opened.
   *
   * What this does **not** do is collect keystrokes into it. That wants the
   * input loop and a caret, and it is named here rather than implied: a game
   * that needs a typed answer to proceed will get an empty one.
   */
  EditText: (world, args) => {
    const control = args[0] ?? NULL_REG;
    world.log(
      'EditText was answered with its own control rather than with typed text: this engine ' +
        'does not yet run a caret and collect keystrokes into a text field. A script waiting ' +
        'for a typed answer will read whatever the field already held.',
    );
    return control;
  },

  Text: (world, args) => {
    const sub = args[0]?.offset ?? 0;
    const rest = args.slice(1);

    switch (sub) {
      case 0: {
        const target = rest[0] ?? NULL_REG;
        const text = readString(world, rest[1] ?? NULL_REG, true);
        const font = rest[2]?.offset ?? 0;
        const maxWidth = signed(rest[3] ?? NULL_REG);
        const wrapAt = maxWidth > 0 ? maxWidth : SCI_SCREEN_WIDTH - 1;
        const size = world.measureText?.(text, font, wrapAt) ?? null;
        if (!size) return NULL_REG;

        const bytes = bytesAt(world, target);
        if (bytes && bytes.length >= 8) {
          const put = (index: number, value: number): void => {
            bytes.set(index * 2, value & 0xff);
            bytes.set(index * 2 + 1, (value >> 8) & 0xff);
          };
          // left, top, right, bottom — SCI32's order, and not SCI16's.
          put(0, 0);
          put(1, 0);
          put(2, size.width);
          put(3, size.height);
        }
        return NULL_REG;
      }
      case 1: {
        const text = readString(world, rest[0] ?? NULL_REG, true);
        const font = rest[1]?.offset ?? 0;
        // Unwrapped: how wide the line is, not how wide a window would be.
        return int(world.measureText?.(text, font, 10_000)?.width ?? 0);
      }
      default:
        world.log(
          `Text sub-function ${sub} is not implemented. Sierra's own table names two, 0 and 1, ` +
            `and both are measurements — a number outside that is a finding about this release.`,
        );
        return NULL_REG;
    }
  },
  Graph: () => int(0),
  Palette: () => int(0),
  /**
   * Cel geometry, answered from the View the script names.
   *
   * Real rather than stubbed, because a script does arithmetic with these — an
   * actor's bounding box comes from `CelWide` and `CelHigh` — and answering
   * zero puts every actor at a point rather than at a size, which changes where
   * the game thinks things are rather than only how they look.
   */
  /**
   * `CelInfo(sub, view, loop, cel, ...)` — a cel's origin, and its pixels.
   *
   * Five sub-functions, and **two of them are genuinely empty**: ScummVM maps
   * subs 2 and 3 with `MAP_EMPTY`, whose handler returns the accumulator and
   * does nothing. That is not the same as `MAP_DUMMY`, which calls `error()`
   * and stops the game — ScummVM uses that for calls it believes no release
   * makes, so reaching one is a bug rather than a gap. An empty call is
   * answered here by being empty; a dummy one is still reported.
   *
   * The origin a cel states is its **displacement**, the offset from the
   * actor's position to the cel's top left, which is what a script asking
   * "where is this cel's origin" is asking for.
   */
  CelInfo: (world, args) => {
    const sub = args[0]?.offset ?? 0;
    const view = args[1]?.offset ?? 0;
    const loop = args[2]?.offset ?? 0;
    const cel = args[3]?.offset ?? 0;
    switch (sub) {
      case 0:
        return int(world.celOrigin?.(view, loop, cel)?.x ?? 0);
      case 1:
        return int(world.celOrigin?.(view, loop, cel)?.y ?? 0);
      case 2:
      case 3:
        // Empty in Sierra's own interpreter.
        return NULL_REG;
      case 4:
        return int(
          world.celPixel?.(
            view,
            loop,
            cel,
            signedWord(args[4]?.offset ?? 0),
            signedWord(args[5]?.offset ?? 0),
          ) ?? 0,
        );
      default:
        world.log(
          `CelInfo sub-function ${sub} is not one of the five Sierra's own table lists, so it ` +
            `is a misread argument rather than a gap.`,
        );
        return NULL_REG;
    }
  },

  NumLoops: (world, args) => int(world.viewLoopCount?.(args[0] ?? NULL_REG) ?? 1),
  NumCels: (world, args) => int(world.viewCelCount?.(args[0] ?? NULL_REG) ?? 1),
  CelWide: (world, args) => int(world.celSize?.(args)?.width ?? 0),
  CelHigh: (world, args) => int(world.celSize?.(args)?.height ?? 0),

  // ------------------------------------------------------------ motion ---
  /**
   * `GlobalToLocal(event, plane)` — a screen point in the Plane's own space.
   *
   * **Two arguments from SCI2 on, and the second one is the whole call.**
   * `kGlobalToLocal32` looks the Plane up and subtracts its game rectangle's
   * origin from the event's `x` and `y` (`kgraphics32.cpp`); this answered the
   * event unchanged, which is right exactly while every Plane sits at 0, 0.
   *
   * A **panoramic** room is where that stops being true. King's Quest VII's
   * room 1250 is 960 pixels of scenery on a Plane whose `left` walks down to
   * −318 as the room scrolls, and a click the player makes at script x 60 is at
   * x 378 in the room. Unsubtracted, every click asked the game to walk the ego
   * to a place 318 pixels left of the one the player pointed at — which, from
   * the right-hand end of a panorama, is off the edge of the room.
   *
   * **SCI16 is left alone and that is not the same bug.** Before SCI2 this
   * subtracts the current *port's* origin, and this engine has no port model to
   * subtract; the one-argument form is answered unchanged, as it was, rather
   * than being given a Plane it does not have.
   */
  GlobalToLocal: (world, args) => {
    const event = args[0] ?? NULL_REG;
    if (args.length < 2) return event;
    return shiftByPlane(world, event, args[1] ?? NULL_REG, -1);
  },
  /** The same subtraction the other way, which is what `kLocalToGlobal32` is. */
  LocalToGlobal: (world, args) => {
    const event = args[0] ?? NULL_REG;
    if (args.length < 2) return event;
    return shiftByPlane(world, event, args[1] ?? NULL_REG, 1);
  },
  CoordPri: (_world, args) => {
    // Priority from a y coordinate: fourteen bands over the picture, which is
    // what puts an actor lower down the screen in front of one higher up.
    const y = signed(args[0] ?? NULL_REG);
    return int(Math.max(0, Math.min(14, Math.floor(((y - 42) * 14) / 148) + 1)));
  },
  DirLoop: () => NULL_REG,
  /**
   * `CanBeHere(object)` — may this actor stand where it is?
   *
   * **Answering no is not the safe default; it is the one that hangs.** SCI's
   * `Motion` and `Avoid` classes ask this in a loop: `findPosn` tries a
   * position, asks, and tries another if the answer is no. A kernel that always
   * says no never lets the loop end — King's Quest IV's throne room reached
   * `findPosn` and spent 385,000 `CanBeHere` calls in it, which reads in a
   * report as a game that is running.
   *
   * So the permissive answer, which is also the consistent one: `CantBeHere`
   * already returns "nothing blocks", and the two are the same question asked
   * in opposite polarities. Until the control buffer is consulted, both say the
   * position is legal rather than one saying legal and the other impossible.
   *
   * What that costs is stated rather than hidden: an actor can walk where the
   * control map forbids. That is a wrong picture, and a hang is not a picture
   * at all.
   */
  CanBeHere: () => int(1),
  CantBeHere: () => int(0),
  OnControl: () => int(0),
  SetJump: () => NULL_REG,
  DoAvoider: () => int(0),
  /**
   * `AvoidPath(startX, startY, endX, endY, polygons, width, height[, opt])` —
   * a route from here to there, as a list of points.
   *
   * **Returning null is how King's Quest VII's heroine walked off the edge of
   * the world.** A SCI32 room's `PolyPath` hands this the click and uses what
   * comes back as the route; given nothing, the script's destination falls out
   * as **0, 0** — and the mover then walks the ego toward the origin, which on
   * a 960-pixel-wide desert is off the left-hand edge. Measured end to end: the
   * click arrives at 60,113, `GetEvent` writes 60,113 onto the event object and
   * it reads back as 60,113, and the mover's target is 0,0. This call is the
   * only step in between.
   *
   * **A direct path, which is Sierra's own answer when pathfinding fails.**
   * `kAvoidPath` allocates three points — start, end, and the `0x7777`
   * sentinel — and returns them whenever `convert_polygon_set` cannot build a
   * graph. That is what this returns always, and the cost is stated rather than
   * buried: **the ego walks through barred polygons instead of around them.**
   * A wrong route is visible and a missing one is a game that cannot be played,
   * which is the same trade `CanBeHere` above already makes and for the same
   * reason.
   *
   * The three-argument form is a different question — is this point inside that
   * polygon — and is `InPolygon`, which answers it properly.
   */
  AvoidPath: (world, args) => {
    if (args.length === 3) return SCI_KERNEL.InPolygon(world, args);
    if (args.length < 4) return NULL_REG;

    const start = { x: signedWord(args[0]?.offset ?? 0), y: signedWord(args[1]?.offset ?? 0) };
    const end = { x: signedWord(args[2]?.offset ?? 0), y: signedWord(args[3]?.offset ?? 0) };

    // Three points of two words each, in a SCI32 int16 array — which is what
    // `allocateOutputArray` makes from SCI2 on, rather than the dynmem block
    // SCI16 used.
    const path = world.heap.newArray(0, 6);
    const points = [start.x, start.y, end.x, end.y, POLY_LAST_POINT, POLY_LAST_POINT];
    for (const [index, value] of points.entries()) world.heap.arrayPut(path, index, value);
    return path;
  },
  /**
   * `InPolygon(x, y, polygon)` — is this point inside that walk polygon?
   *
   * ScummVM's `kInPolygon` is `kAvoidPath`'s three-argument case and nothing
   * else: it reads the polygon object's own points, forces the type to barred
   * access so a contained-access shape is not inverted, and answers whether the
   * point is inside **or on the edge**.
   *
   * **Answering nought to everything is not neutral, it is "nowhere is
   * walkable".** King's Quest VII asks this of a click before it will move the
   * ego, so a constant zero is a game that draws its room, runs its loop
   * healthily, polls events and refuses every click on the floor — which on
   * screen is indistinguishable from a game that is ignoring the mouse. Room
   * 1250 idled in `Game::doit > User::doit > Feature::handleEvent` for six
   * game-minutes with every counter frozen, and this was the reason.
   *
   * The points live one indirection further away than in SCI16: from SCI2 the
   * `points` selector holds a **`Points` object** whose `data` selector is the
   * block of x and y word pairs, which is the branch `convert_polygon` guards
   * with `isHeapObject`.
   */
  InPolygon: (world, args) => {
    const point = { x: signedWord(args[0]?.offset ?? 0), y: signedWord(args[1]?.offset ?? 0) };
    const polygon = world.machine.object(args[2] ?? NULL_REG);
    if (!polygon) return int(0);

    const vertices = polygonPoints(world, polygon);
    if (vertices.length === 0) return int(0);
    // Barred access, as `kAvoidPath` forces it: the answer is about the shape,
    // not about which side of it the game treats as walkable.
    return int(contains(point, vertices) ? 1 : 0);
  },

  /**
   * `Intersections(...)` — where a line crosses a polygon, in pixels.
   *
   * Ten arguments: the query line's two endpoints, a buffer of polygon points,
   * the first and last word indices into it and the stride between points, a
   * buffer to write triples into, and a backtrack flag. It answers how many
   * crossings it found and writes each as an x, a y and the index of the edge
   * it crossed.
   *
   * **The one call on SCI1's missing list that needs nothing from the
   * renderer.** `IsItSkip` wants a cel's pixels, `AssertPalette` a palette
   * loader, `TextFonts` the text-code font store and `ResCheck` resource
   * presence — every one of them a `SciKernelWorld` hook wired outside this
   * file. This is integer arithmetic over two buffers the script already owns,
   * so it is written rather than declared a boundary.
   *
   * **Transcribed from ScummVM's `kIntersections`** (`engines/sci/engine/
   * kpathing.cpp`, fetched 2026-09-12) including the parts that look like
   * mistakes and are not. Sierra works in *centipixels* and rounds the slope by
   * adding five before dividing by ten, so the arithmetic is reproduced at that
   * scale rather than in floating point: a slope computed the tidy way differs
   * in the last pixel, and the last pixel is where a crossing either lands on
   * the segment or does not. Division truncates towards zero throughout,
   * because C's does and the rounding of a negative slope is visible in the
   * answer.
   *
   * Tier 3 in `verifying-version-support.md`'s terms and not Tier 1: the
   * expectations in `tests/sci-pmachine.test.ts` are ScummVM's figures for the
   * same inputs. No SCI game data is mounted here, and the release that reaches
   * this call — the CD release of Mixed-up Mother Goose, per ScummVM's own
   * comment — is not something this machine can run.
   */
  Intersections: (world, args) => {
    const buffers = intersectionBuffers(world, args);
    if (!buffers) return NULL_REG;
    const { input, output } = buffers;

    const startIndex = args[5]?.offset ?? 0;
    const endIndex = args[6]?.offset ?? 0;
    const stepSize = args[7]?.offset ?? 0;
    const backtrack = (args[9]?.offset ?? 0) !== 0;
    if (stepSize === 0) {
      // Sierra's loop walks by this and stops when it arrives back at its own
      // start, so a stride of nought is a loop that never ends. ScummVM has no
      // guard here because a shipped game never passes one; this engine reports
      // it, for the reason `CanBeHere` answers permissively — a hang loses
      // every later finding in the same run.
      world.log('Intersections was given a stride of nought, which cannot walk a polygon.');
      return NULL_REG;
    }

    let qSourceX = signed(args[0] ?? NULL_REG);
    let qSourceY = signed(args[1] ?? NULL_REG);
    const qDestX = signed(args[2] ?? NULL_REG);
    const qDestY = signed(args[3] ?? NULL_REG);

    let qSlope: number;
    let qIntercept: number;
    if (qSourceX !== qDestX) {
      qSlope = roundedSlope(qSourceY - qDestY, qSourceX - qDestX);
      qIntercept = 100 * qDestY - qSlope * qDestX;
      if (backtrack) {
        // The line is extended back from its destination until it leaves the
        // screen, and the source is moved to wherever it left.
        qSourceX = qSourceX >= qDestX ? SCI_SCREEN_WIDTH - 1 : 0;
        qSourceY = Math.trunc((qSlope * qSourceX + qIntercept) / 100);
        if (qSourceY < 0 || qSourceY > SCI_PLAY_HEIGHT - 1) {
          qSourceY = qSourceY < 0 ? 0 : SCI_PLAY_HEIGHT - 1;
          qSourceX = Math.trunc(
            (Math.trunc(((qSourceY * 100 - qIntercept) * 10) / qSlope) + 5) / 10,
          );
        }
      }
    } else {
      qSlope = VERTICAL;
      qIntercept = VERTICAL;
      if (backtrack) qSourceY = qSourceY >= qDestY ? SCI_PLAY_HEIGHT - 1 : 0;
    }

    let curIndex = startIndex;
    const first = input(curIndex);
    // Bit 13 of the first x marks a closed polygon, which comes back round to
    // its own first point; without it the run is a polyline and stops at its
    // end. The rest of the word is nine bits of x.
    const doneIndex = (first & (1 << 13)) !== 0 ? startIndex : endIndex;
    let pSourceX = first & 0x1ff;
    let pSourceY = input(curIndex + 1);
    curIndex += stepSize;

    let count = 0;
    // Sierra's loop is unbounded and ends when it arrives back where it began.
    // A buffer whose indices never reach `doneIndex` would spin for ever, so
    // the walk is bounded by the points the arguments say are there.
    const limit = Math.floor(Math.abs(endIndex - startIndex) / stepSize) + 2;
    for (let step = 0; step < limit; step++) {
      const pDestX = input(curIndex) & 0x1ff;
      const pDestY = input(curIndex + 1);

      let pSlope: number;
      let pIntercept: number;
      if (pSourceX !== pDestX) {
        pSlope = roundedSlope(pDestY - pSourceY, pDestX - pSourceX);
        pIntercept = pDestY * 100 - pSlope * pDestX;
      } else {
        pSlope = VERTICAL;
        pIntercept = VERTICAL;
      }

      let found = true;
      let x = 0;
      let y = 0;
      if (qSlope === pSlope) {
        // Parallel. They meet only where they lie on top of each other, and
        // then the crossing is whichever endpoint is inside the other segment.
        if (
          pIntercept === qIntercept &&
          inRect(pSourceX, pSourceY, qSourceX, qSourceY, qDestX, qDestY)
        ) {
          x = pSourceX * 100;
          y = pSourceY * 100;
        } else if (
          pIntercept === qIntercept &&
          inRect(qDestX, qDestY, pSourceX, pSourceY, pDestX, pDestY)
        ) {
          x = qDestX * 100;
          y = qDestY * 100;
        } else found = false;
      } else if (qSlope === VERTICAL) {
        x = qSourceX * 100;
        y = pSlope * qSourceX + pIntercept;
      } else if (pSlope === VERTICAL) {
        x = pDestX * 100;
        y = qSlope * pDestX + qIntercept;
      } else {
        x = Math.trunc(((pIntercept - qIntercept) * 100) / (qSlope - pSlope));
        y = Math.trunc((x * pSlope + pIntercept * 100) / 100);
      }

      if (found) {
        x = Math.trunc((x + 50) / 100);
        y = Math.trunc((y + 50) / 100);
        // A crossing of the two infinite lines only counts where it lands on
        // both segments — which is the whole difference between "these lines
        // meet" and "this walk is blocked".
        if (
          inRect(x, y, pSourceX, pSourceY, pDestX, pDestY) &&
          inRect(x, y, qSourceX, qSourceY, qDestX, qDestY)
        ) {
          output(count * 3, x);
          output(count * 3 + 1, y);
          output(count * 3 + 2, curIndex);
          count++;
        }
      }

      if (curIndex === doneIndex) return int(count);
      curIndex = curIndex !== endIndex ? curIndex + stepSize : startIndex;
      pSourceX = pDestX;
      pSourceY = pDestY;
    }

    world.log(
      `Intersections walked ${limit} points of a polygon that never returned to index ` +
        `${doneIndex}, so it stopped. The buffer and the indices disagree about its length.`,
    );
    return int(count);
  },

  /**
   * `MergePoly(points, list, size)` — one obstacle grown to swallow the others.
   *
   * Three arguments: a buffer of points terminated by `0x7777`, a list of the
   * room's polygon objects, and the size of the scratch buffer Sierra uses and
   * this engine does not need. It answers a freshly allocated buffer holding the
   * merged outline, terminated the same way, and marks every polygon it
   * swallowed by adding `0x10` to that polygon's own `type`.
   *
   * Quest for Glory I VGA calls it after a monster is killed, so that the
   * corpse's polygon and the scenery it fell across become one obstacle the
   * pathfinder routes around rather than two it can slip between.
   *
   * **Written here because it needs nothing this file does not have.** The
   * other names on SCI1's missing list stop at a `SciKernelWorld` hook — a cel's
   * pixels for `IsItSkip`, a palette loader for `AssertPalette`, the font store
   * for `TextFonts` — and those hooks are wired in `SciEngine.ts`. This one
   * reads polygon objects through the game's own Selector table, walks buffers
   * through `bytesAt`, and allocates its answer on the heap this file already
   * holds.
   *
   * **What it does not do is make an actor walk round anything.** `AvoidPath`
   * is still `() => NULL_REG`, so the merged outline goes back to the script
   * that asked for it and no further. That is stated rather than implied: this
   * closes a name on the missing list and moves no pixel, and the order for
   * whoever picks it up is `AvoidPath` next.
   *
   * Tier 3: transcribed from ScummVM's `kMergePoly` and `mergeSinglePolygon`
   * (`engines/sci/engine/kpathing.cpp`, fetched 2026-09-12), whose own comment
   * calls the strategy error-prone and which is copied rather than corrected —
   * see `mergeSinglePolygon` for why. The tests in `tests/sci-pmachine.test.ts`
   * are geometry a reader can check by hand plus a property check over random
   * polygon pairs, which is what stands in for the game this machine has not
   * got.
   */
  MergePoly: (world, args) => {
    const source = bytesAt(world, args[0] ?? NULL_REG);
    if (!source) {
      world.log('MergePoly was handed polygon data that names nothing, so nothing was merged.');
      return NULL_REG;
    }

    // The work outline, read until Sierra's end marker or until the buffer runs
    // out — a buffer with no marker is a walk with no end, and the length is the
    // only thing here that can stop it.
    let work: PolyPoint[] = [];
    for (let index = 0; ; index++) {
      const point = readPolyPoint(source, index);
      if (!point || point.x === POLY_LAST_POINT) break;
      work.push(point);
    }

    let at = world.heap.list(args[1] ?? NULL_REG)?.first ?? NULL_REG;
    while (!isNull(at)) {
      const node = world.heap.node(at);
      if (!node) break;
      const object = world.machine.object(node.value);
      const polygon = object ? convertPolygon(world, object) : null;
      if (object && polygon) {
        // Reversed and stepped on by one, which is what `kMergePoly` does to
        // undo `convert_polygon`'s own reversal. Two operations that look like
        // they cancel and do not: the rotation is the difference.
        const merged = mergeSinglePolygon(
          work,
          rotateHead(reverseCircular(polygon.vertices)),
          world.log.bind(world),
        );
        if (merged) {
          work = merged;
          // The game reads this back to know which of its polygons are now part
          // of the union, so writing it is half of what the call is for.
          setProperty(world, object, 'type', polygon.type + 0x10);
        }
      }
      at = node.next;
    }

    const output = world.heap.allocate(POLY_POINT_SIZE * (work.length + 1));
    const bytes = bytesAt(world, output);
    if (!bytes) {
      world.log('MergePoly could not allocate an outline to answer with.');
      return NULL_REG;
    }

    let written = 0;
    for (let index = 0; index < work.length; index++) {
      const point = work[index] as PolyPoint;
      // A vertex identical to the one before it is dropped. The merge can make
      // them — a patch rejoining exactly on a vertex writes both — and a
      // zero-length edge is what the next `MergePoly` would stop on.
      if (index > 0 && samePoint(point, work[index - 1] as PolyPoint)) continue;
      writePolyPoint(bytes, written, point);
      written++;
    }
    writePolyPoint(bytes, written, { x: POLY_LAST_POINT, y: POLY_LAST_POINT });
    return output;
  },

  // -------------------------------------------------------------- menus ---
  AddMenu: () => NULL_REG,
  DrawMenuBar: () => NULL_REG,
  MenuSelect: () => int(0),
  GetMenu: () => int(0),
  SetMenu: () => NULL_REG,

  // ------------------------------------------------------- sound, parser ---
  /**
   * `DoSound(sub, ...)` — the playlist, and the cue a waiting script needs.
   *
   * **This answered `int(0)` to every sub-function of every Version**, and the
   * cost was not silence. `kDoSoundPlay` is the only thing that writes a sound
   * object's `handle`, and Sierra's `Sound::check` will not call `UpdateCues`
   * without one:
   *
   * ```
   * (method (check)
   *     (if handle (DoSound sndUPDATE_CUES self)
   *         (if signal (= prevSignal signal) (= signal 0)
   *             (if client (client cue: self)))))
   * ```
   *
   * So `signal` stayed nought forever and `client cue: self` was never sent.
   * Measured on King's Quest VII before this: `Play` 44 times in a boot,
   * `UpdateCues` **nought**. A script that starts a sound and waits on its cue
   * waited on a message the engine had no path to send.
   *
   * The tables, the four numberings and what this host does instead of
   * synthesising are all in `sound/sciDoSound.ts`. Two things belong here
   * rather than there, because both are about the *game's* state: every write
   * below goes through `setProperty`, by Selector name, because which property
   * word `handle` is differs per game; and the Version split is by
   * `soundVersionFor`, because sub-function 8 is `MasterVolume`, `Stop` and
   * `Play` at three different Versions and picking one would run the other two
   * with their calls shuffled.
   */
  DoSound: (world, args) => {
    const version = world.machine.version;
    const sub = args[0]?.offset ?? 0;
    const op = soundOpFor(version, sub);
    if (!op) {
      reportOnce(
        world,
        `DoSound.${sub}`,
        `This game called DoSound sub-function ${sub}, which ${describeSciVersion(version)}'s ` +
          `own table does not name — it has ${soundOpsFor(version).length} of them. Either ` +
          `the Version is wrong for this release or the table is wrong at this ordinal.`,
      );
      return world.machine.acc;
    }
    return doSound(world, op, args.slice(1));
  },
  DoAudio: () => int(0),
  /**
   * `Parse(line, event)` — a typed command, against the game's own vocabulary.
   *
   * **The sharpest case of a reader this project built and never called.**
   * `resource/sciVocabulary.ts` has read `vocab.000` and reduced a line to word
   * groups since #220; `Parse` answered zero, so every typed command in every
   * SCI0 and SCI01 game was accepted and ignored — the input window took the
   * keystrokes, the line was drawn, and the parse never happened.
   *
   * Transcribed from ScummVM's `kParse` (`engines/sci/engine/kparse.cpp`,
   * fetched 2026-09-12), whose three outcomes are the whole of the call:
   *
   * - **A word the vocabulary does not have.** `claimed` is set on the event so
   *   no room handler acts on it, the word is written into the parser block and
   *   `wordFail` is sent to the game object, and the call answers 1 — Sierra's
   *   own comment on that return is "tell them that it didn't work".
   * - **Nothing to parse**, an empty line: `claimed` is set and the call
   *   answers 0, with no `wordFail`, because there is no word to name.
   * - **A parse.** `claimed` is cleared, which is what lets the event travel to
   *   the room handlers that will `Said` against it, and the call answers 1.
   *
   * **`claimed` is the load-bearing half**, not the return value. SCI's event
   * flows through the game's own handlers until one claims it; an interpreter
   * that answers 1 and leaves `claimed` where it was hands every room a parse
   * they have no way to tell apart from a stale one.
   *
   * **What this does not reach, stated rather than discovered.** `Said` still
   * answers zero, so a parse that succeeds is a parse nothing matches against —
   * see the note on `Said` for why that half is not in this run. ScummVM's
   * tokenizer also strips suffixes through `vocab.901` and applies the GNF
   * grammar in `vocab.900`, and this reduction does neither: an inflected word
   * this project's vocabulary does not hold whole is an unknown word here and a
   * known one in Sierra's interpreter. `syntaxFail` is the grammar's failure
   * and so cannot be reported either.
   */
  Parse: (world, args) => {
    const event = world.machine.object(args[1] ?? NULL_REG);
    const parsed = world.parseInput?.(readString(world, args[0] ?? NULL_REG, true)) ?? null;

    if (!parsed) {
      // Not an error: SCI1 replaced the parser with an icon bar and ships no
      // main vocabulary. A game that calls `Parse` without one is worth saying
      // once, because it means the input window is taking keystrokes that
      // cannot reach anything.
      if (!reportedNoVocabulary.has(world)) {
        reportedNoVocabulary.add(world);
        world.log(
          'A script called Parse and this game ships no vocab.000, so the typed line cannot be ' +
            'matched against anything. Every command typed into this game will be reported as ' +
            'not understood.',
        );
      }
      setProperty(world, event, 'claimed', 1);
      return int(0);
    }

    const unknown = parsed.unknown[0];
    if (unknown !== undefined) {
      setProperty(world, event, 'claimed', 1);
      reportWordFail(world, unknown, args[0] ?? NULL_REG);
      return int(1);
    }

    if (parsed.groups.length === 0) {
      setProperty(world, event, 'claimed', 1);
      return int(0);
    }

    setProperty(world, event, 'claimed', 0);
    return int(1);
  },
  Said: () => int(0),
  SetSynonyms: () => NULL_REG,

  // --------------------------------------------------------------- files ---
  /*
   * SCI0's four file calls, which SCI1 folded into `FileIO`.
   *
   * Transcribed from `engines/sci/engine/kfile.cpp` and
   * `engines/sci/engine/file.cpp` (fetched 2026-09-13). They were the last four
   * names absent from SCI0's Kernel table, and absent is what they had to stop
   * being before anything could be said about SCI0's coverage at all.
   *
   * **Nought is the error channel and the scripts read it.** `FOpen` answers a
   * handle or nought, and Sierra's own code tests for nought — a mode-1 open
   * that fails is how Quest for Glory asks whether a character was exported
   * here before. So a host with no file surface at all is not a special case:
   * `world.files` is absent, `FOpen` answers nought, and the game takes the
   * path it already has for a disc it cannot read.
   */
  FOpen: (world, args) =>
    int(
      world.files?.open(
        readString(world, args[0] ?? NULL_REG, true),
        args[1]?.offset ?? SCI_FILE_MODE.openOrCreate,
      ) ?? 0,
    ),
  /** Appends the string as it stands — a SCI script writes its own newline. */
  FPuts: (world, args) => {
    world.files?.write(args[0]?.offset ?? 0, readString(world, args[1] ?? NULL_REG, true));
    return NULL_REG;
  },
  /*
   * Reads a line into the caller's buffer and answers the buffer, or nought.
   *
   * Three details are Sierra's rather than ours, and `fgets_wrapper`
   * (`file.cpp:269`) is where each comes from. The destination is cleared
   * first, because "some scripts don't test for errors and just use the
   * results, even from invalid file handles" (ScummVM bug #12060). A trailing
   * line feed is stripped — "the returned string must not have an ending LF".
   * And a `maxsize` of one or less reads nothing at all rather than one
   * character.
   */
  FGets: (world, args) => {
    const destination = args[0] ?? NULL_REG;
    const maxSize = args[1]?.offset ?? 0;
    const handle = args[2]?.offset ?? 0;

    const line = maxSize > 1 ? (world.files?.readLine(handle) ?? null) : null;
    // The terminator goes in either way: an unread buffer a script uses anyway
    // should be an empty string rather than whatever was there before.
    writeString(world, destination, (line ?? '').slice(0, Math.max(0, maxSize - 1)));
    return line === null ? NULL_REG : destination;
  },
  FClose: (world, args) => {
    world.files?.close(args[0]?.offset ?? 0);
    return NULL_REG;
  },

  // ------------------------------------------------------------- saving ---
  /**
   * `SaveGame(gameName, slot, description, version)` — the game's own save menu.
   *
   * **The third case of a thing this repository had already built and never
   * called.** `captureSciState` and `restoreSciState` are two hundred lines
   * implementing ADR 0019's graph, the editor's own overlay uses them, and
   * these two Kernel calls — the ones a *game's* save menu goes through —
   * answered `int(0)`. So every SCI game's Save option appeared to work and
   * wrote nothing.
   *
   * Nought is failure and one is success, which is what Sierra's scripts test.
   */
  SaveGame: (world, args) => {
    const slot = args[1]?.offset ?? 0;
    const description = readString(world, args[2] ?? NULL_REG, true);
    return int(world.saveGame?.(slot, description) ? 1 : 0);
  },

  /**
   * `RestoreGame(gameName, slot, version)` — the same menu, the other way.
   *
   * **Asked for here and done between cycles**, which is the one detail that
   * matters: this call happens inside a send, and the frames above it belong to
   * a game state that is about to stop existing. Restoring underneath them
   * would return into a method of an object the restore has just replaced.
   * `loadPending` already reads resources between cycles for the same reason,
   * and this joins it.
   *
   * Answering nought on refusal is the honest half: a restore the host will not
   * do is a restore that did not happen, and the script has code for that.
   */
  RestoreGame: (world, args) => {
    return int(world.restoreGame?.(args[1]?.offset ?? 0) ? 1 : 0);
  },
  RestartGame: () => NULL_REG,
  /**
   * `FileIO(sub, ...)` — the twenty sub-functions SCI1 folded SCI0's four into.
   *
   * **This answered `int(0)` to all twenty, and nought is the word "no".** Every
   * one of these sub-functions uses nought or -1 as its failure channel, so a
   * single constant did not leave the surface unimplemented — it left every
   * game being told, in its own vocabulary, that the disc had refused. King's
   * Quest VII is where that is loudest: click *Start a New Game* and `startBut`
   * asks `FileIO(17, 3, path)` whether there is room to save, is told nought,
   * and puts up "Cannot start a new game, disk is full." The menu was working
   * the whole time; the answer was wrong.
   *
   * Numbered from `kFileIO_subops` in `engines/sci/engine/kernel_tables.h` and
   * implemented from `engines/sci/engine/kfile.cpp` (both fetched 2026-09-13).
   * The three that this host has nothing behind — `FindFirst`, `FindNext` and
   * `GetCWD` — are answered rather than skipped, because each has a shape a
   * script reads and a silence it cannot.
   *
   * **The two failure words are not interchangeable.** SCI1.1 answers nought
   * where SCI32 answers -1, and Sierra's scripts test whichever their own
   * Version returns, so `failed` is chosen by Version rather than fixed.
   */
  FileIO: (world, args) => {
    const files = world.files;
    const sub = args[0]?.offset ?? 0;
    const version = world.machine.version;
    const sci32 = version.startsWith('sci2') || version === 'sci3';
    const failed = sci32 ? int(-1) : NULL_REG;
    const handle = (index: number): number => args[index]?.offset ?? 0;

    switch (sub) {
      case SCI_FILE_IO.open: {
        // Square Quest IV's floppy release and Quest for Glory IV's import both
        // write `/\` in front of a name, which is a DOS path separator pair and
        // not part of the name (`kfile.cpp:312`).
        const name = readString(world, args[1] ?? NULL_REG, true).replace(/^\/\\/, '');
        const mode = args[2]?.offset ?? SCI_FILE_MODE.openOrCreate;
        // An empty name happens "many times during KQ1 (e.g. when typing
        // something)" and is a refusal rather than a file.
        if (name === '') return failed;
        const opened = files?.open(name, mode) ?? 0;
        return opened === 0 ? failed : int(opened);
      }
      case SCI_FILE_IO.close:
        files?.close(handle(1));
        return int(1);
      case SCI_FILE_IO.readRaw: {
        const bytes = files?.read(handle(1), args[3]?.offset ?? 0) ?? new Uint8Array(0);
        const destination = bytesAt(world, args[2] ?? NULL_REG);
        if (destination) {
          for (let index = 0; index < bytes.length && index < destination.length; index++) {
            destination.set(index, bytes[index]!);
          }
        }
        return int(bytes.length);
      }
      case SCI_FILE_IO.writeRaw: {
        const size = args[3]?.offset ?? 0;
        const source = bytesAt(world, args[2] ?? NULL_REG);
        if (!source || !files) return failed;
        const bytes = new Uint8Array(Math.min(size, source.length));
        for (let index = 0; index < bytes.length; index++) bytes[index] = source.get(index);
        files.writeBytes(handle(1), bytes);
        return int(bytes.length);
      }
      case SCI_FILE_IO.unlink:
        return int(files?.remove(readString(world, args[1] ?? NULL_REG, true)) ? 1 : 0);
      case SCI_FILE_IO.readString: {
        // `FGets` by another number, and the same three details of Sierra's are
        // right for both — see `FGets` above for where each comes from.
        const destination = args[1] ?? NULL_REG;
        const maxSize = args[2]?.offset ?? 0;
        const line = maxSize > 1 ? (files?.readLine(handle(3)) ?? null) : null;
        writeString(world, destination, (line ?? '').slice(0, Math.max(0, maxSize - 1)));
        return line === null ? NULL_REG : destination;
      }
      case SCI_FILE_IO.writeString: {
        if (!files) return failed;
        const text = readString(world, args[2] ?? NULL_REG, true);
        files.write(handle(1), text);
        return int(text.length);
      }
      case SCI_FILE_IO.seek: {
        const position =
          files?.seek(handle(1), signed(args[2] ?? NULL_REG), args[3]?.offset ?? 0) ?? -1;
        if (position < 0) return failed;
        // SCI32 answers where the cursor landed; SCI1.1 answers only whether it
        // moved at all (`kfile.cpp:776`).
        return sci32 ? int(position) : int(1);
      }
      case SCI_FILE_IO.findFirst: {
        // `*.*` is every file rather than every file with a dot in it, which is
        // what DOS meant by it and what `kFileIOFindFirst` translates it to.
        const mask = readString(world, args[1] ?? NULL_REG, true) || '*';
        finding.set(world, {
          names: files?.names(mask === '*.*' ? '*' : mask) ?? [],
          next: 0,
        });
        return nextFound(world, args[2] ?? NULL_REG);
      }
      case SCI_FILE_IO.findNext:
        return nextFound(world, args[1] ?? NULL_REG);
      case SCI_FILE_IO.exists:
        return int(files?.exists(readString(world, args[1] ?? NULL_REG, true)) ? 1 : 0);
      case SCI_FILE_IO.rename:
      case SCI_FILE_IO.copy: {
        const from = readString(world, args[1] ?? NULL_REG, true);
        const to = readString(world, args[2] ?? NULL_REG, true);
        const done = sub === SCI_FILE_IO.rename ? files?.rename(from, to) : files?.copy(from, to);
        // Nought is success here and -1 is failure, which is the other way
        // round from every other sub-function: these two answer as C's `rename`
        // does rather than as SCI's other calls do.
        return done ? NULL_REG : int(-1);
      }
      case SCI_FILE_IO.readByte: {
        const bytes = files?.read(handle(1), 1) ?? new Uint8Array(0);
        if (bytes.length === 0) return NULL_REG;
        // Into the *low* byte of the accumulator, leaving its high byte alone —
        // Sierra's own quirk, and a script reading a byte into a word it has
        // already half filled depends on it.
        return int((world.machine.acc.offset & 0xff00) | bytes[0]!);
      }
      case SCI_FILE_IO.writeByte:
        if (!files) return failed;
        files.writeBytes(handle(1), new Uint8Array([(args[2]?.offset ?? 0) & 0xff]));
        return int(1);
      case SCI_FILE_IO.readWord: {
        const bytes = files?.read(handle(1), 2) ?? new Uint8Array(0);
        // Short of two bytes is the end of the file, and Sierra leaves the
        // accumulator as it was rather than answering a half-read word.
        if (bytes.length < 2) return world.machine.acc;
        return int(bytes[0]! | (bytes[1]! << 8));
      }
      case SCI_FILE_IO.writeWord: {
        if (!files) return failed;
        const value = args[2]?.offset ?? 0;
        files.writeBytes(handle(1), new Uint8Array([value & 0xff, (value >> 8) & 0xff]));
        return int(2);
      }
      case SCI_FILE_IO.checkFreeSpace:
        // SCI2.1 middle moved `CheckFreeSpace` in here and flipped its
        // arguments, so the sub-function's own sub-op is the first of them.
        return checkFreeSpace(world, args[1]?.offset ?? 2);
      case SCI_FILE_IO.getCwd:
        writeString(world, args[1] ?? NULL_REG, 'C:\\SIERRA\\');
        return args[1] ?? NULL_REG;
      case SCI_FILE_IO.isValidDirectory:
        // Torin, Larry 7 and RAMA ask this of the save directory. There is no
        // directory and nothing is written to one, so yes is the answer that
        // costs the game nothing.
        return int(1);
      default:
        reportOnce(
          world,
          `FileIO.${sub}`,
          `This game called FileIO sub-function ${sub}, which is not one of the twenty ` +
            `ScummVM's own table names. It has been answered ${sci32 ? '-1' : '0'}, which is ` +
            `that sub-function's failure. Either the Version is wrong or the table is.`,
        );
        return failed;
    }
  },
};

/** Reads a null-terminated string from wherever a reference points. */
/**
 * Where a `FindFirst` got to, so the `FindNext` after it carries on.
 *
 * Per world rather than per module, the same way `parserBlock` is: two games
 * open in two tabs are two directory walks, and a single cursor would have one
 * of them reading the other's answers.
 */
const finding = new WeakMap<SciKernelWorld, { names: string[]; next: number }>();

/** The next name a directory walk has, written where the script asked for it. */
function nextFound(world: SciKernelWorld, destination: Reg): Reg {
  const walk = finding.get(world);
  const name = walk && walk.next < walk.names.length ? walk.names[walk.next++] : undefined;
  // Nought at the end rather than an empty name: a script loops until this
  // answers nothing, and an empty string is a file called nothing.
  if (name === undefined) return NULL_REG;
  writeString(world, destination, name);
  return destination;
}

/**
 * Whether there is room, in whichever of the three units the game asked for.
 *
 * There is no disc, so every answer here is generous on purpose: a refusal is
 * a game that will not let a player start. `freeDiskSpace` answers Sierra's own
 * ceiling of 0x7fff KiB rather than a made-up number, because the scripts
 * compare it against a requirement and the largest value the field holds is the
 * one that cannot be too small.
 *
 * **King's Quest VII 2.00b asks a fourth question.** `startBut::doVerb` calls
 * `FileIO(17, 3, path)` and ScummVM's own enumeration stops at 2 — its handler
 * errors on anything else. Answering one, "there is room", is what lets the
 * game past its own "Cannot start a new game, disk is full."; it is said out
 * loud rather than folded into the two-case default, because an unnamed sub-op
 * is a finding about the release and not a detail of this host.
 */
function checkFreeSpace(world: SciKernelWorld, subop: number): Reg {
  switch (subop) {
    case SCI_FREE_SPACE.saveGameSize:
      return int(0);
    case SCI_FREE_SPACE.freeDiskSpace:
      return int(0x7fff);
    case SCI_FREE_SPACE.enoughToSave:
      return int(1);
    default:
      reportOnce(
        world,
        `CheckFreeSpace.${subop}`,
        `This game asked CheckFreeSpace sub-op ${subop}, which is not one of the three ` +
          `ScummVM's own handler names. It has been told there is room, because the ` +
          `alternative is a game that will not start and there is no disc here to be full.`,
      );
      return int(1);
  }
}

/**
 * The playlist, per world.
 *
 * Per world rather than per module for the same reason `finding` is: two games
 * open in two tabs are two playlists, and one map would have each hearing the
 * other's sounds finish.
 */
const soundSlots = new WeakMap<SciKernelWorld, SciSoundSlots>();

function slotsOf(world: SciKernelWorld): SciSoundSlots {
  let slots = soundSlots.get(world);
  if (!slots) {
    slots = new SciSoundSlots();
    soundSlots.set(world, slots);
  }
  return slots;
}

/** The master volume, per world. Read back by `MasterVolume` with no argument. */
const masterVolume = new WeakMap<SciKernelWorld, number>();

const clip = (value: number, low: number, high: number): number =>
  value < low ? low : value > high ? high : value;

/**
 * One sub-function of `kDoSound`, by name.
 *
 * Transcribed from `SoundCommandParser` in `engines/sci/sound/soundcmd.cpp`.
 * Where ScummVM branches on `_soundVersion` this branches on the same seam
 * through `soundVersionFor`, and where it hands work to a synthesiser this
 * does the bookkeeping and stops — see `sciDoSound.ts` for why that is the
 * whole of the difference, and what it costs.
 */
function doSound(world: SciKernelWorld, op: SciSoundOp, args: Reg[]): Reg {
  const slots = slotsOf(world);
  const sound = soundVersionFor(world.machine.version);
  /** SCI0 has no `signal`; it reports through `state` instead. */
  const sci0 = sound === 'sci0';
  const target = args[0] ?? NULL_REG;
  const object = world.machine.object(target);
  const slot = object ? slots.get(target.segment, target.offset) : undefined;
  const value = (index: number): number => signed(args[index] ?? NULL_REG);

  switch (op) {
    case 'Init': {
      if (!object) return world.machine.acc;
      // A second `Init` over a live slot is a dispose first, which is what
      // stops a re-used sound object carrying the previous track's ticker.
      if (slot) stopSound(world, target, object, slots, sci0, false);
      const priority = readProperty(world, object, 'priority');
      slots.set(target.segment, target.offset, {
        resourceId: readProperty(world, object, 'number'),
        loop: readProperty(world, object, 'loop'),
        // SCI0 keeps the whole word; everything after it keeps the low byte.
        priority: sci0 ? priority : priority & 0xff,
        volume: clip(readProperty(world, object, 'vol'), 0, SCI_SOUND_VOLUME_MAX),
        hold: -1,
        status: 'stopped',
        ticker: 0,
        signal: 0,
        overridePriority: false,
      });
      // **This is the write the scripts are waiting for.** `Sound::dispose`
      // gates on `nodePtr` and will not release a sound without one.
      if (sci0) setProperty(world, object, 'state', SCI_SOUND_STATE.initialised);
      else setPropertyReg(world, object, 'nodePtr', target);
      return world.machine.acc;
    }

    case 'Play': {
      if (!object) return world.machine.acc;
      // "The sound hasn't been initialized for some reason, so initialize it
      // here" — Sierra's scripts do reach `play` without `init`, and ScummVM
      // names King's Quest VI room 460 as a case.
      if (!slot) doSound(world, 'Init', args);
      const playing = slots.get(target.segment, target.offset);
      if (!playing) return world.machine.acc;
      // Another sound loaded into the same object: dispose and re-init, or the
      // slot keeps answering for the track that is no longer in it.
      const wanted = readProperty(world, object, 'number');
      if (playing.resourceId !== wanted) {
        doSound(world, 'Dispose', args);
        doSound(world, 'Init', args);
      }
      const live = slots.get(target.segment, target.offset);
      if (!live) return world.machine.acc;

      // `handle` is what `Sound::check` and `Sound::stop` both gate on, and
      // `kDoSoundPlay` is the only place in the whole Kernel that writes it.
      setPropertyReg(world, object, 'handle', target);
      if (sci0) {
        setProperty(world, object, 'state', SCI_SOUND_STATE.playing);
      } else {
        setPropertyReg(world, object, 'nodePtr', target);
        setProperty(world, object, 'min', 0);
        setProperty(world, object, 'sec', 0);
        setProperty(world, object, 'frame', 0);
        setProperty(world, object, 'signal', 0);
      }
      live.loop = readProperty(world, object, 'loop');
      live.priority = readProperty(world, object, 'priority');
      // "Reset hold when starting a new song. kDoSoundSetHold is always called
      // after kDoSoundPlay to set it properly, if needed."
      live.hold = -1;
      if (!sci0) live.volume = readProperty(world, object, 'vol');
      live.status = 'playing';
      live.ticker = 0;
      live.signal = 0;
      return world.machine.acc;
    }

    case 'UpdateCues': {
      if (!object || !slot) return world.machine.acc;
      // **The branch every sound takes here, and why.** ScummVM's third case
      // is a slot with no data for the selected device; this host selects a
      // device that synthesises nothing (#219), so every slot is that case.
      // Its answer is `processStopSound(obj, true)`, which raises `signal` and
      // lets the waiting script go on rather than leaving it on a cue that
      // cannot arrive. A scene plays without its music; it does not hang.
      stopSound(world, target, object, slots, sci0, true);
      if (!sci0) {
        // Sierra's own arithmetic, and not a rounding of it: a `frame` is two
        // sixtieths, so a minute is 3600 and a second is 60.
        setProperty(world, object, 'min', Math.floor(slot.ticker / 3600));
        setProperty(world, object, 'sec', Math.floor((slot.ticker % 3600) / 60));
        setProperty(world, object, 'frame', Math.floor((slot.ticker % 60) / 2));
        if (sound !== 'sci1-early') setProperty(world, object, 'vol', slot.volume);
      }
      return world.machine.acc;
    }

    case 'Stop': {
      if (!object || !slot) return world.machine.acc;
      stopSound(world, target, object, slots, sci0, false);
      return world.machine.acc;
    }

    case 'Dispose': {
      if (!object || !slot) return world.machine.acc;
      stopSound(world, target, object, slots, sci0, false);
      slots.delete(target.segment, target.offset);
      setProperty(world, object, 'handle', 0);
      if (sci0) setProperty(world, object, 'state', SCI_SOUND_STATE.stopped);
      else setPropertyReg(world, object, 'nodePtr', NULL_REG);
      return world.machine.acc;
    }

    case 'Pause': {
      // SCI0 passes a flag and no object: pause whatever is playing, resume
      // whatever is paused, and answer whether anything was resumed.
      if (sci0) {
        const wantPause = value(0) === 1;
        const first = slots
          .all()
          .find((each) => each.status === (wantPause ? 'playing' : 'paused'));
        if (!first) return int(0);
        first.status = wantPause ? 'paused' : 'playing';
        return int(wantPause ? 0 : 1);
      }
      // A null object pauses the whole playlist, which is how a game mutes
      // itself for a dialog.
      const wantPause = args.length > 1 ? value(1) !== 0 : true;
      const affected = object ? (slot ? [slot] : []) : slots.all();
      for (const each of affected) {
        if (wantPause) {
          if (each.status === 'playing') each.status = 'paused';
        } else if (each.status === 'paused') each.status = 'playing';
      }
      return world.machine.acc;
    }

    case 'SetVolume': {
      if (!object || !slot) return world.machine.acc;
      const wanted = clip(value(1), 0, SCI_SOUND_VOLUME_MAX);
      // Written back only on a change, because Sierra's own handler does: a
      // script that polls `vol` sees its own value until something moves it.
      if (slot.volume !== wanted) {
        slot.volume = wanted;
        setProperty(world, object, 'vol', wanted);
      }
      return world.machine.acc;
    }

    case 'SetPriority': {
      if (!object || !slot) return world.machine.acc;
      const flags = readProperty(world, object, 'flags');
      if (value(1) === -1) {
        // Back to the resource's own priority. `kSoundFlagFixedPriority` is
        // 2 in `soundcmd.h`, and the script reads the flag to know which.
        slot.overridePriority = false;
        slot.priority = 0;
        setProperty(world, object, 'flags', flags & ~2);
      } else {
        slot.overridePriority = true;
        slot.priority = value(1);
        setProperty(world, object, 'flags', flags | 2);
      }
      return world.machine.acc;
    }

    case 'SetLoop': {
      if (!object) return world.machine.acc;
      // **The property is not the argument.** -1 means "loop forever" and is
      // stored as 0xffff; anything else is stored as 1, whatever it was.
      const loops = value(1) === -1 ? 0xffff : 1;
      setProperty(world, object, 'loop', loops);
      // A game may set the loop before it inits the sound, which ScummVM notes
      // is "perfectly normal", so a missing slot is not a fault here.
      if (slot) slot.loop = loops;
      return world.machine.acc;
    }

    case 'SetHold': {
      if (!slot) return world.machine.acc;
      slot.hold = value(1);
      return world.machine.acc;
    }

    case 'Update': {
      if (!object || !slot) return world.machine.acc;
      slot.loop = readProperty(world, object, 'loop');
      slot.volume = clip(readProperty(world, object, 'vol'), 0, 255);
      slot.priority = readProperty(world, object, 'priority');
      return world.machine.acc;
    }

    case 'Fade': {
      // SCI0 passes the object alone and means "fade out and stop". With
      // nothing to fade, the sound is already over, and Sierra's own handler
      // for a sound that is not playing raises `signal` directly.
      if (!object || !slot) return world.machine.acc;
      const stopAfter = args.length >= 5 ? !isNull(args[4] ?? NULL_REG) : args.length === 1;
      if (args.length >= 4) slot.volume = clip(value(1), 0, SCI_SOUND_VOLUME_MAX);
      if (stopAfter || slot.status !== 'playing') {
        stopSound(world, target, object, slots, sci0, false);
      } else if (!sci0) {
        setProperty(world, object, 'vol', slot.volume);
      }
      return world.machine.acc;
    }

    case 'MasterVolume': {
      const previous = masterVolume.get(world) ?? SCI_SOUND_MASTER_VOLUME_MAX;
      if (args.length > 0) {
        masterVolume.set(world, clip(value(0), 0, SCI_SOUND_MASTER_VOLUME_MAX));
      }
      // Sierra answers the volume *before* the change, which is how a script
      // saves it across a mute and puts it back.
      return int(previous);
    }

    case 'Mute': {
      const on = world.sound?.isEnabled ?? true;
      if (args.length > 0) world.sound?.setEnabled(value(0) !== 0);
      return int(on ? 1 : 0);
    }

    case 'GetPolyphony':
      // The voice count. Sierra's AdLib driver answers 9 and the scripts use
      // it to decide how many channels to ask for; nought would be read as a
      // device with no voices at all.
      return int(9);

    case 'GetAudioCapability':
      // "Tests for digital audio support", and ScummVM answers 1 flatly.
      return int(1);

    case 'StopAll':
      // Deliberately nothing, and ScummVM's comment says why: King's Quest I
      // calls this after a message box and it would take the background
      // effects with it. Its own handler returns before the loop that stops
      // them, with the loop left in the file under `#if 0`.
      return world.machine.acc;

    case 'SendMidi':
    case 'GlobalReverb':
    case 'Suspend':
    case 'Restore':
    case 'ResumeAfterRestore':
    case 'Dummy':
      // Four of these need a synthesiser to mean anything (#219) and two are
      // slots Sierra shipped empty — `Dummy` is `MAP_EMPTY` in every table it
      // appears in, and `Restore` in all four. Answering the accumulator
      // leaves the caller's own value alone, which is what an empty Sierra
      // handler does.
      return world.machine.acc;
  }
}

/**
 * `processStopSound`, which is three writes and not one.
 *
 * Split out because `Stop`, `Dispose`, `Fade` and `UpdateCues` all reach it and
 * the ordering matters: `handle` goes to nought *before* `signal` is raised, so
 * a script that re-reads the object inside its own `cue` sees a sound that has
 * stopped rather than one that is both finished and still playing.
 *
 * `finished` is ScummVM's `sampleFinishedPlaying`, and it only changes SCI0,
 * where `signal` is raised for a sample running out and not for a script
 * stopping the music. "If we set it all the time, we get no music in sq3new
 * and kq1."
 */
function stopSound(
  world: SciKernelWorld,
  target: Reg,
  object: SciObject,
  slots: SciSoundSlots,
  sci0: boolean,
  finished: boolean,
): void {
  if (sci0) setProperty(world, object, 'state', SCI_SOUND_STATE.stopped);
  else setProperty(world, object, 'handle', 0);
  if (!sci0 || finished) {
    setProperty(world, object, 'signal', SCI_SOUND_SIGNAL_FINISHED);
  }
  const slot = slots.get(target.segment, target.offset);
  if (slot) {
    slot.signal = SCI_SOUND_SIGNAL_FINISHED;
    slot.status = 'stopped';
  }
}

/**
 * The bytes a reference names, wherever the script put them.
 *
 * **A SCI string is wherever the script put it**, and there are three places:
 * the heap, a script's own data, and a *variable bank* — `lea` hands out the
 * address of a local and a string built at runtime is packed two characters to
 * a word inside one. King's Quest IV's button labels are literals in script
 * 699, `"Yes"` at 699:1748 and `"No"` at 699:1752, and the line measured
 * beside them is in a local.
 */
function bytesAt(world: SciKernelWorld, value: Reg): SciByteView | null {
  const heap = world.heap.bytes(value);
  if (heap) {
    return {
      length: heap.length,
      get: (index) => heap[index] ?? 0,
      set: (index, byte) => {
        if (index < heap.length) heap[index] = byte & 0xff;
      },
    };
  }
  return world.machine.byteViewAt(value);
}

/**
 * A string, read only where the caller knows it is asking for one.
 *
 * **`wide` is not a convenience and the default is not timidity.** A Kernel
 * call that is *documented* to take text — a control's label, the string
 * `Display` prints, the one `TextSize` measures — can be read out of any of
 * SCI's three spaces safely, because the script has said what it is. The
 * generic string calls cannot: `StrCmp`, `StrEnd` and `StrCpy` take whatever a
 * script hands them, and in SCI0 that is routinely a *word index* into a
 * variable bank rather than a byte pointer, which our register model cannot
 * tell from a byte pointer.
 *
 * Reading widely for all of them was tried and measured: King's Quest IV went
 * from its throne room back to a blank screen, because `StrEnd` advances a
 * reference by a string's length and doing that to a word index addresses the
 * wrong variable. Which one is the right unit is not knowable from the
 * register, so the calls that do arithmetic on a string's address keep the
 * narrow reader until the address model carries the distinction.
 */
function readString(world: SciKernelWorld, value: Reg, wide = false): string {
  const bytes = wide ? bytesAt(world, value) : world.heap.bytes(value);
  if (!bytes) return '';
  const at = (index: number): number =>
    bytes instanceof Uint8Array ? (bytes[index] ?? 0) : bytes.get(index);
  let text = '';
  for (let index = 0; index < bytes.length; index++) {
    const byte = at(index);
    if (byte === 0) break;
    text += String.fromCharCode(byte);
  }
  return text;
}

function writeString(world: SciKernelWorld, value: Reg, text: string): void {
  const bytes = bytesAt(world, value);
  if (!bytes) return;
  // The terminator and nothing past it: a bank is as long as the frame it sits
  // in, and clearing all of that would wipe every variable after the string.
  for (let i = 0; i <= text.length && i < bytes.length; i++) {
    bytes.set(i, i < text.length ? text.charCodeAt(i) & 0xff : 0);
  }
}

/**
 * Tells the game a word was not in its vocabulary, so the game can say so.
 *
 * **The message belongs to the game and not to the interpreter.** Sierra's
 * `kParse` writes the offending word into the parser block and sends `wordFail`
 * to the game object with that block and the typed line as arguments; the
 * script prints whatever that game prints — "I don't know the word 'wibble'" in
 * one release and something else in another. An interpreter that printed its
 * own would be speaking over the game.
 *
 * Re-entrant, through the one door `PMachine.invoke` opens for exactly this.
 * `Sort` already uses it and for the same reason: the Kernel call cannot finish
 * until a script has run. A game whose Selector table has no `wordFail`, or
 * whose game object this engine never reached, is left silent rather than
 * having a line invented for it.
 */
function reportWordFail(world: SciKernelWorld, word: string, line: Reg): void {
  const selector = world.machine.selectorNumbers?.get('wordFail');
  const object = world.gameObject?.();
  if (selector === undefined || !object) return;

  let block = parserBlock.get(world);
  if (!block) {
    // Sierra's own bound on a parser word, from `VOCAB_MAX_WORDLENGTH`.
    block = world.heap.allocate(256);
    parserBlock.set(world, block);
  }
  writeString(world, block, word.slice(0, 255));

  world.machine.invoke(object, selector, [block, line]);
}

/**
 * Writes a property by *name*, through the game's own Selector table.
 *
 * Never by index. Which property number `type` is differs per game, because the
 * table is the game's, and a hardcoded index writes into whatever that game put
 * there instead — an event's x coordinate into an actor's view number, say,
 * which draws the wrong thing rather than erroring.
 */
function setProperty(
  world: SciKernelWorld,
  object: ReturnType<PMachine['object']>,
  name: string,
  value: number,
): void {
  if (!object) return;
  const selector = world.machine.selectorNumbers?.get(name);
  if (selector === undefined) return;
  const index = world.machine.resolveProperty(object, selector);
  // A Kernel call writes a number, so the register it writes is an integer.
  // A property that held an object pointer and is written this way stops being
  // one, which is what the game asked for.
  if (index >= 0) object.variables[index] = { segment: 0, offset: value & 0xffff };
}

/**
 * Writes a property that holds a *reference* rather than a number.
 *
 * `setProperty` writes an integer, which is right for nearly everything a
 * Kernel call sets and wrong for the one thing `Sort` sets: a list handed to a
 * script as a bare number is a list it cannot look up.
 */
function setPropertyReg(
  world: SciKernelWorld,
  object: ReturnType<PMachine['object']>,
  name: string,
  value: Reg,
): void {
  if (!object) return;
  const selector = world.machine.selectorNumbers?.get(name);
  if (selector === undefined) return;
  const index = world.machine.resolveProperty(object, selector);
  if (index >= 0) object.variables[index] = value;
}

/**
 * The half of a multilanguage string this engine can read, which is English.
 *
 * The splitter is `%` or `#` followed by a language letter, and the letters are
 * ScummVM's `charToLanguage` (`engines/sci/engine/state.cpp`, fetched
 * 2026-09-12). Anything before the first splitter is the primary language;
 * where there is no splitter the whole string is.
 */
function englishHalf(text: string): string {
  for (let index = 0; index + 1 < text.length; index++) {
    const marker = text[index];
    if (marker !== '%' && marker !== '#') continue;
    if (!'EFSIGJjP'.includes(text[index + 1])) continue;
    // `%E` names English itself, so the requested half is the one *after* it.
    return text[index + 1] === 'E' ? text.slice(index + 2) : text.slice(0, index);
  }
  return text;
}

/**
 * Reads a property by *name*, through the game's own Selector table.
 *
 * The mirror of `writeProperty`, and never by index for the same reason: which
 * property number `nsLeft` is differs per game, and a hardcoded index reads
 * whatever that game put there instead.
 */
/**
 * A stable name for a Plane or ScreenItem, which is its register.
 *
 * The game hands the same object back to update or delete it, so identity is
 * the reference and not anything in the object — a Plane whose rectangle
 * changes is still that Plane.
 */
function planeId(value: Reg): string {
  return `${value.segment}:${value.offset}`;
}

/**
 * The three List sub-functions that send a Selector to every element.
 *
 * 19 `EachElementDo`, 20 `FirstTrue`, 21 `AllTrue`. King's Quest VII's boot
 * calls 19 five times before it reaches anything on screen, and with it
 * unanswered the list was walked by nobody and the game carried on against
 * objects it believed it had just told something.
 *
 * Two details are Sierra's and both matter (`klists.cpp`):
 *
 * **The next node is read before the element is invoked.** A method sent to an
 * element may delete that element — Sierra keeps the successor on the list
 * rather than on the stack for exactly this reason — so walking by "current,
 * then next" after the call reads a node that may be gone.
 *
 * **A Selector that is a *variable* is read or written rather than called.**
 * The same sub-function does both, decided per element by what the element has:
 * `EachElementDo` with three arguments writes the third into the variable, and
 * `FirstTrue`/`AllTrue` test its value. Calling it instead would send to a
 * property, and there is no method there to reach.
 */
function listSelectorWalk(world: SciKernelWorld, sub: number, rest: Reg[]): Reg {
  const selector = rest[1]?.offset ?? 0;
  const extra = rest.slice(2);
  let node = world.heap.list(rest[0] ?? NULL_REG)?.first ?? NULL_REG;

  while (!isNull(node)) {
    // Read before the invoke: the call may delete this node.
    const next = world.heap.node(node)?.next ?? NULL_REG;
    const value = world.heap.node(node)?.value ?? NULL_REG;
    const element = world.machine.object(value);

    if (element) {
      // Resolved by number rather than through a name: the Selector arrives as
      // a number and the property table is indexed by one, so going via the
      // name would fail for every Selector a game's table does not name.
      const property = world.machine.resolveProperty(element, selector);
      let result: Reg;

      if (property >= 0) {
        if (sub === 19 && extra.length >= 1) {
          element.variables[property] = extra[0] ?? NULL_REG;
          result = NULL_REG;
        } else {
          result = element.variables[property] ?? NULL_REG;
        }
      } else {
        result = world.machine.invoke(value, selector, [...extra]) ?? NULL_REG;
      }

      // `FirstTrue` answers the *element*, not what the element answered
      // (`klists.cpp`), which is the difference between "which one" and "what
      // it said" — a script uses the object it gets back.
      if (sub === 20 && !isNull(result)) return value;
      if (sub === 21 && isNull(result)) return NULL_REG;
    }

    node = next;
  }

  // `AllTrue` got to the end without a nought, so it is true; the other two
  // have nothing to answer with.
  return sub === 21 ? int(1) : NULL_REG;
}

/**
 * SCI's own `printf`, which is C's with one rule of its own.
 *
 * **A placeholder with no argument left is still consumed and still formatted**
 * — Sierra passes nought rather than stopping (`kstring.cpp`'s `format`), so a
 * line with more `%d`s than values prints zeroes rather than truncating. A
 * formatter that stopped early would produce a shorter string that looks
 * deliberate.
 *
 * `%%` is an escape and takes no argument. An unrecognised type is emitted as
 * the literal text of the placeholder, which is what Sierra does rather than
 * erroring — a game with a typo in a string should show the typo.
 *
 * Only the width and the sign of the common types are honoured. C's full flag
 * grammar is not implemented and does not need to be: what SCI's own scripts
 * use is `%d`, `%s`, `%u`, `%x` and a width.
 */
function formatSciString(
  source: string,
  values: readonly Reg[],
  read: (value: Reg) => string,
): string {
  let out = '';
  let at = 0;
  let next = 0;

  while (at < source.length) {
    const character = source[at]!;
    if (character !== '%') {
      out += character;
      at += 1;
      continue;
    }
    if (source[at + 1] === '%') {
      out += '%';
      at += 2;
      continue;
    }

    // Flags, width, precision and length, then the type — the same order
    // `readPlaceholder` walks them in.
    const placeholder = /^%([-+ #0]*)(\d*)(?:\.(\d+))?(?:[hlL]*)([diouxXeEfgGcs])?/.exec(
      source.slice(at),
    );
    if (!placeholder?.[4]) {
      out += character;
      at += 1;
      continue;
    }

    const [whole, flags = '', width = '', , type] = placeholder;
    const argument = values[next++] ?? NULL_REG;
    let piece: string;

    if (type === 's') piece = read(argument);
    else if (type === 'c') piece = String.fromCharCode(argument.offset & 0xff);
    else if (type === 'u') piece = String(argument.offset >>> 0);
    else if (type === 'x' || type === 'X') {
      piece = (argument.offset >>> 0).toString(16);
      if (type === 'X') piece = piece.toUpperCase();
    } else {
      piece = String(argument.offset > 0x7fff ? argument.offset - 0x10000 : argument.offset);
    }

    const pad = Number.parseInt(width, 10);
    if (Number.isFinite(pad) && piece.length < pad) {
      const filler = flags.includes('0') && !flags.includes('-') ? '0' : ' ';
      piece = flags.includes('-') ? piece.padEnd(pad, ' ') : piece.padStart(pad, filler);
    }

    out += piece;
    at += whole.length;
  }

  return out;
}

/**
 * Whether this object carries that property, as opposed to answering nought.
 *
 * `readProperty` cannot tell "the property is nought" from "there is no such
 * property", and for `SetNowSeen` and `BaseSetter` the difference decides
 * whether to write at all — Sierra checks before touching either rectangle.
 */
function hasProperty(world: SciKernelWorld, object: SciObject, name: string): boolean {
  const selector = world.machine.selectorNumbers?.get(name);
  if (selector === undefined) return false;
  return world.machine.resolveProperty(object, selector) >= 0;
}

/**
 * Moves an event's `x` and `y` by a Plane's origin, in the direction given.
 *
 * The written-back words are the event object's own, because that is what both
 * calls answer with: Sierra's return value is the object it was handed, changed
 * in place, and a caller that read the return rather than the object would see
 * the same reference either way.
 */
function shiftByPlane(world: SciKernelWorld, event: Reg, plane: Reg, direction: 1 | -1): Reg {
  const object = world.machine.object(event);
  const origin = world.planeOrigin?.(planeId(plane));
  if (!object || !origin) return event;
  setProperty(
    world,
    object,
    'x',
    signedWord(readProperty(world, object, 'x')) + direction * origin.x,
  );
  setProperty(
    world,
    object,
    'y',
    signedWord(readProperty(world, object, 'y')) + direction * origin.y,
  );
  return event;
}

/**
 * A walk polygon's points, read off the object the script built.
 *
 * Empty where the polygon has no size, where its `points` lead nowhere, or
 * where the block is shorter than the size claims — each of which is a polygon
 * a script has released or not filled in yet, and none of which is worth
 * halting for. `convert_polygon` guards the same three.
 */
function polygonPoints(world: SciKernelWorld, polygon: SciObject): Array<{ x: number; y: number }> {
  const size = readProperty(world, polygon, 'size');
  if (size <= 0) return [];

  // From SCI2 `points` is a `Points` object and the words are in its `data`.
  let block = readPropertyReg(world, polygon, 'points');
  const indirect = world.machine.object(block);
  if (indirect) block = readPropertyReg(world, indirect, 'data');

  const bytes = world.heap.bytes(block);
  if (!bytes || bytes.length < size * 4) return [];

  const word = (at: number): number => {
    const value = bytes[at] | (bytes[at + 1] << 8);
    return value >= 0x8000 ? value - 0x10000 : value;
  };
  const points: Array<{ x: number; y: number }> = [];
  for (let index = 0; index < size; index++) {
    points.push({ x: word(index * 4), y: word(index * 4 + 2) });
  }
  return points;
}

/**
 * Sierra's own containment test, which counts ray crossings on both sides.
 *
 * Transcribed from `contained` (`kpathing.cpp`). Two counts rather than one
 * because the difference between them is how an **edge** is told from an
 * inside: an odd total means the point is on the boundary, and Sierra treats
 * that as contained. Integers throughout — the intersection is compared by
 * multiplying rather than dividing, which is Sierra's way of avoiding floats
 * and is also the only way to get exactly their answer on a boundary.
 *
 * Winding is not fixed first, as `fix_vertex_order` does for pathfinding,
 * because a crossing count does not depend on which way round the vertices go.
 */
function contains(
  point: { x: number; y: number },
  vertices: ReadonlyArray<{ x: number; y: number }>,
): boolean {
  let left = 0;
  let right = 0;

  for (let index = 0; index < vertices.length; index++) {
    const one = vertices[index];
    const next = vertices[(index + 1) % vertices.length];
    // A point that *is* a vertex is on the edge, and Sierra says so at once.
    if (point.x === one.x && point.y === one.y) return true;

    const straddlesRight = one.y < point.y !== next.y < point.y;
    const straddlesLeft = one.y > point.y !== next.y > point.y;
    if (!straddlesLeft && !straddlesRight) continue;

    let crossing = next.x * one.y - one.x * next.y + (one.x - next.x) * point.y;
    let divisor = one.y - next.y;
    if (divisor < 0) {
      crossing = -crossing;
      divisor = -divisor;
    }
    if (straddlesRight && crossing > divisor * point.x) right++;
    else if (straddlesLeft && crossing < divisor * point.x) left++;
  }

  // An odd total puts the point on an edge, which counts as contained.
  if ((left + right) % 2 === 1) return true;
  return right % 2 === 1;
}

/** A Kernel argument word read as signed, which a coordinate always is. */
function signedWord(value: number): number {
  return (value & 0xffff) >= 0x8000 ? (value & 0xffff) - 0x10000 : value & 0xffff;
}

function readPropertyReg(world: SciKernelWorld, object: SciObject, name: string): Reg {
  const selector = world.machine.selectorNumbers?.get(name);
  if (selector === undefined) return NULL_REG;
  const index = world.machine.resolveProperty(object, selector);
  return index >= 0 ? (object.variables[index] ?? NULL_REG) : NULL_REG;
}

/**
 * Where a Plane object says it is, which is **not** `left`, `top`, `right`,
 * `bottom` for the games that ship all eight.
 *
 * A SCI32 `Plane` class carries two rectangles. Sierra's `Plane::Plane` reads
 * `inLeft`, `inTop`, `inRight`, `inBottom` and reads the unprefixed four only
 * when `usesAlternateSelectors()` is true — which in ScummVM is Phantasmagoria
 * 2 and nothing else (`features.h`). Reading the unprefixed pair for every
 * game is right exactly while the two agree, and King's Quest VII's agree all
 * the way through its title screen and its menu: both say 0, 0, 319, 199.
 *
 * They stop agreeing the moment the game enters a room. The first gameplay
 * Plane gave `left` 65218 and a `right` a pixel behind it — a rectangle
 * 130,436 pixels off the left of the screen and nought wide — so every screen
 * item on it was clipped away and the room composited as a black frame.
 *
 * Which pair to read is asked of **the object**, not of the title: a Plane
 * that declares `inLeft` has the rectangle Sierra reads, and one that does not
 * has only the other. That keeps the per-title table `CONTEXT.md` warns
 * against out of it, and it answers Phantasmagoria 2 correctly for the same
 * reason it answers King's Quest VII correctly.
 */
function planeRect(
  world: SciKernelWorld,
  object: SciObject,
): { x: number; y: number; width: number; height: number } {
  const inset = hasProperty(world, object, 'inLeft');
  // **Signed, all four.** A SCI32 Plane wider than the screen is scrolled by
  // moving its own rectangle left, so `left` is negative for every panorama a
  // game paints. Read unsigned, King's Quest VII's first gameplay room gave
  // `left` 65218 for −318 and a width of `Math.max(0, 641 - 65218 + 1)` — a
  // Plane nought pixels wide, off the right-hand edge of a 640-pixel screen,
  // with the room's whole background clipped away inside it.
  const left = signedWord(readProperty(world, object, inset ? 'inLeft' : 'left'));
  const top = signedWord(readProperty(world, object, inset ? 'inTop' : 'top'));
  const right = signedWord(readProperty(world, object, inset ? 'inRight' : 'right'));
  const bottom = signedWord(readProperty(world, object, inset ? 'inBottom' : 'bottom'));
  return {
    x: left,
    y: top,
    // **Inclusive, as Sierra's are.** `Plane::Plane` reads `right` and
    // `bottom` and adds one to each (`plane32.cpp`), so a Plane whose script
    // says `right: 319` is 320 wide. Read exclusively it is a pixel short in
    // each direction, which is a column of the background showing down the
    // side of every full-screen Plane.
    width: Math.max(0, right - left + 1),
    height: Math.max(0, bottom - top + 1),
  };
}

function readProperty(world: SciKernelWorld, object: SciObject, name: string): number {
  const selector = world.machine.selectorNumbers?.get(name);
  if (selector === undefined) return 0;
  const index = world.machine.resolveProperty(object, selector);
  return index >= 0 ? (object.variables[index]?.offset ?? 0) : 0;
}

/**
 * Draws one control, which two Kernel calls need.
 *
 * `DrawControl` is the script asking, and `EditControl` has to as well: Sierra
 * repaints a text field the moment a key changes it — `kernelTexteditChange`
 * erases the cursor, redraws and puts it back — and a field that is only
 * repainted when the game's own loop decides to shows a player nothing as they
 * type.
 */
function drawControl(world: SciKernelWorld, object: SciObject): void {
  const rect = controlRect(world, object);
  // The text property holds a *register* — a segment and an offset — and
  // reading it as a bare number and inventing a segment is how a string
  // pointer becomes a read of whatever happens to live in segment one.
  const text = readString(world, readPropertyReg(world, object, 'text'), true);
  world.showControl?.({
    ...rect,
    text,
    font: readProperty(world, object, 'font'),
    // SCI's own control types: 0 is a button, 1 a label, 2 an edit field,
    // 3 an icon, 4 a list. Passed through rather than branched on here,
    // because what a type *looks* like is the renderer's question.
    type: readProperty(world, object, 'type'),
    state: readProperty(world, object, 'state'),
  });
}

/** A control's rectangle, in the order SCI's own Selectors name it. */
function controlRect(
  world: SciKernelWorld,
  object: SciObject,
): { x: number; y: number; width: number; height: number } {
  const top = readProperty(world, object, 'nsTop');
  const left = readProperty(world, object, 'nsLeft');
  const bottom = readProperty(world, object, 'nsBottom');
  const right = readProperty(world, object, 'nsRight');
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

export { SCI_EVENT };
