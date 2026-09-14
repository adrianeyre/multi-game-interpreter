/**
 * Running AGOS's drawing bytecode.
 *
 * ADR 0027's amendment records why this exists: an AGOS game carries two
 * bytecodes, and this is the one that draws. A game Subroutine's whole
 * contribution to the screen is to start a VGA script; everything a player sees
 * is placed by the language this file runs.
 *
 * ## What a sprite is here
 *
 * Not a bitmap with a position. A **sprite** is a running script — it has its
 * own program counter, its own position and priority, and it lives until its
 * script halts. Several run at once and the machine steps them, which is why
 * this is a scheduler with a drawing opcode rather than a draw loop.
 *
 * ## Conditions skip, they do not branch
 *
 * A VGA condition opcode skips the **next instruction** when it fails. That is
 * the whole control structure, and it means the machine has to be able to
 * decode an instruction in order to step over it — a decoder that could only
 * execute would run the instruction it was meant to skip.
 *
 * ## What is implemented, and what says so
 *
 * The scheduler, the conditions, the sprite table, variables, bits, palettes,
 * windows, and drawing both image forms — flipped, or masked where a
 * background surface is supplied.
 *
 * ## Scripts sleep, and something has to wake them
 *
 * A script does not run to its end and stop. `DELAY` sleeps for a number of
 * frames and `WAIT_SYNC` sleeps until another script raises an id, and both
 * work by suspending: the sprite keeps its own program counter and {@link
 * VgaMachine.tick} re-enters it when its wait is over. That is why a sprite has
 * a `resumeOffset` and why this machine has a clock of its own.
 *
 * Both opcodes were deliberately unimplemented before that existed, and the
 * reason was sound: *recording* a wait lets a script straight through the pause
 * it names, which is worse than reporting it by name.
 *
 * ## What it still cannot do, and says so
 *
 * The things that need something outside a renderer — the item tree, sound, hit
 * areas, zone loading — are asked for through {@link VgaHost}, and the default
 * host answers no and counts the question. An opcode wired to that seam decodes
 * and branches correctly; it is **not** evidence the game behaves correctly,
 * which needs a host with a real world behind it. Anything else unimplemented
 * is recorded by name in `report` rather than passed over — the same discipline
 * `../script/AgosInterpreter.ts` keeps, and for the same reason: a silent no-op
 * produces a screen that is wrong in a way nothing reports.
 */

import {
  decode32ColourSprite,
  decodeCompressedSprite,
  decodeSprite,
  decodeWideImage,
  isCompressedEntry,
} from './agosImage.js';
import { DRAW_FLAGS, readU32BE, readVgaImageEntry, type VgaImageEntry } from './vgaImages.js';
import type { VgaFileLayout } from './vgaFile.js';
import { readVgaScript, type VgaInstruction, type VgaOperand } from './vgaScript.js';
import { vgaHasWideOpcodes } from './vgaOpcodeTables.js';
import { readVgaPaletteBank } from './vgaPalette.js';
import { RecordingVgaHost, type VgaHost } from './vgaHost.js';
import type { IndexedBitmap } from './agosImage.js';

/** Where a machine draws, and what it draws from. */
export interface VgaTarget {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
  /**
   * The scene behind the screen, which a masked draw copies *from*.
   *
   * AGOS's masked drawing uses the image being drawn as a **stencil** and takes
   * its colours from this surface — so it reveals what is behind rather than
   * painting something new, which is how a game puts a character back behind
   * scenery it has already walked in front of. Without it there is nothing to
   * reveal, and a masked draw has to say so rather than paint the stencil.
   */
  readonly background?: Uint8Array;
  /**
   * Takes a bank of sixteen colours at a base index.
   *
   * Optional, so a machine can be run with nowhere to put colours — which is
   * what a test that only cares about pixels wants, and what the sweep wants.
   */
  setPalette?(base: number, rgb: Uint8Array): void;
  /**
   * The window table, shared by every zone's machine.
   *
   * **Windows are global in the reference** — one `_videoWindows` array for the
   * whole game — and holding one per machine made a zone's clipping depend on
   * whether that zone's own scripts had happened to define the window they drew
   * into. Optional, so a machine built with no Engine behind it keeps a private
   * table and behaves exactly as it did.
   *
   * `[x, y, width, height]`, with x and width in **sixteens of pixels**.
   */
  readonly windows?: Map<number, [number, number, number, number]>;
}

/**
 * A room backdrop wider than the screen, decoded whole.
 *
 * Simon 2 stores a scrolling room as one cel up to three screens across; it is
 * decoded once into {@link WideBackdrop.bitmap} and the visible window is cut
 * from it by the scroll offset. The reference draws it **screen-left-aligned**:
 * the window always fills the clip from its left edge, and the scroll chooses
 * which source column feeds the leftmost pixel (`src = srcPtr + _scrollX * 4`).
 * So `clip*` is the window it fills and `originY` its top row — everything a
 * re-blit at a new scroll needs without re-running the script.
 */
export interface WideBackdrop {
  readonly bitmap: IndexedBitmap;
  readonly originY: number;
  readonly clipX: number;
  readonly clipY: number;
  readonly clipWidth: number;
  readonly clipHeight: number;
}

/**
 * Copies the visible window of a wide backdrop into a target, at a scroll.
 *
 * Shared by the first draw and by every re-blit as the room scrolls, so the
 * window is cut the same way both times. `scrollX` is in eight-pixel columns:
 * the leftmost visible pixel comes from source column `scrollX * 8`, filling
 * rightwards. A backdrop's bytes are full palette indices, drawn opaque —
 * colour zero is part of the picture, not transparency, so nothing is skipped.
 */
export function blitWideBackdrop(
  target: Uint8Array,
  targetWidth: number,
  targetHeight: number,
  backdrop: WideBackdrop,
  scrollX: number,
): void {
  const { bitmap, originY, clipX, clipY, clipWidth, clipHeight } = backdrop;
  const sourceLeft = scrollX * 8;
  const width = Math.min(clipWidth, targetWidth - clipX);
  for (let row = 0; row < bitmap.height; row += 1) {
    const targetRow = originY + row;
    if (targetRow < clipY || targetRow >= clipY + clipHeight) continue;
    if (targetRow < 0 || targetRow >= targetHeight) continue;
    for (let sc = 0; sc < width; sc += 1) {
      const sourceColumn = sourceLeft + sc;
      if (sourceColumn < 0 || sourceColumn >= bitmap.width) continue;
      const targetColumn = clipX + sc;
      if (targetColumn < 0 || targetColumn >= targetWidth) continue;
      target[targetRow * targetWidth + targetColumn] =
        bitmap.pixels[row * bitmap.width + sourceColumn] ?? 0;
    }
  }
}

/** One running script. */
/** The most instructions one script may run before it is abandoned as looping. */
const MAX_STEPS = 100_000;

/**
 * The most sprite scripts one frame may run before the queue is abandoned.
 *
 * A sprite that is woken again after it has already run this frame runs again,
 * as it does in the reference — the event is appended behind a cursor that has
 * not passed it yet. Two sprites that wake each other with no delay between
 * them would spin here for ever, so the drain stops and says so rather than
 * hanging the browser tab. The bound is far above any frame a game produces:
 * Simon 1's busiest opening frame runs eleven.
 */
const MAXIMUM_SPRITE_RUNS_PER_TICK = 512;

/**
 * What running one instruction did to the program counter.
 *
 * A VGA script has four ways to move and they are not interchangeable, which is
 * why this is a union rather than a number. `skip` is the whole of the
 * language's conditional structure — a failed test steps over the *next*
 * instruction. `suspend` is `DELAY` and `WAIT_SYNC`: the script stops here and
 * the scheduler re-enters it later at the instruction after this one. `jump` is
 * an absolute offset in the script resource, which is what `CHAIN_TO` and
 * `END_REPEAT` produce once their arithmetic is done.
 */
type Step =
  | { readonly kind: 'next' }
  | { readonly kind: 'skip' }
  | { readonly kind: 'suspend' }
  | { readonly kind: 'retry' }
  | { readonly kind: 'jump'; readonly offset: number };

const NEXT: Step = { kind: 'next' };
const SKIP: Step = { kind: 'skip' };
const SUSPEND: Step = { kind: 'suspend' };
/** Sleep, then re-test *this* instruction rather than the one after it. */
const RETRY: Step = { kind: 'retry' };

/** A condition's answer as a {@link Step}: a failed test skips the next instruction. */
function skipIf(failed: boolean): Step {
  return failed ? SKIP : NEXT;
}

export interface VgaSprite {
  readonly id: number;
  x: number;
  y: number;
  palette: number;
  priority: number;
  /**
   * The cel this sprite is showing, as an index into the pixel resource.
   *
   * **This is what actually puts a sprite on screen**, and a sprite used not to
   * have it. A VGA script does not draw its sprite: it *sets* this, and the
   * machine draws every sprite from its own fields once a frame — which is what
   * `AGOSEngine::animateSprites` does in the reference and what
   * {@link VgaMachine.paintSprites} does here.
   *
   * Zero means "showing nothing", which is a real state a script sets: the
   * reference returns from `drawImage_init` on a zero image before reading an
   * entry for it.
   */
  image: number;
  /** The draw flags the script last set, from `DRAW_FLAGS`. */
  flags: number;
  /** Where its script is, in the script resource. */
  scriptOffset: number;
  halted: boolean;
  /**
   * Where to carry on from, when a script suspended part-way through.
   *
   * Null when the sprite is not mid-script. A VGA script does not run to its
   * end and stop — `DELAY` and `WAIT_SYNC` put it to sleep and the scheduler
   * re-enters it later, which is why a sprite has a program counter of its own
   * rather than being re-run from the top each tick.
   */
  resumeOffset: number | null;
  /** The tick to wake on, for a sprite suspended by `DELAY`. */
  wakeAtTick: number | null;
  /** The sync id to wake on, for a sprite suspended by `WAIT_SYNC`. */
  waitingForSync: number | null;
  /**
   * When this sprite joined the game, counted across every zone.
   *
   * The reference keeps one `_vgaSprites` array for the whole game: a new
   * sprite is appended to it whatever zone started it, and `vc23_setPriority`
   * slides it into place among all the others. So creation order is the
   * tie-break between two sprites of equal priority, and it is a *global*
   * order rather than one per zone. {@link paintZoneSprites} needs it.
   */
  readonly sequence: number;
}

/**
 * The next sprite's place in the global creation order.
 *
 * Module-level because the order it counts is the reference's one array, and
 * an array shared by every zone cannot be counted by any one of them. Only
 * ever compared, never read for meaning, so a run that wraps would have to
 * start nine quadrillion sprites first.
 */
let nextSpriteSequence = 0;

/**
 * Draws every sprite of every zone, in one z-order.
 *
 * **AGOS has one sprite list, not one per zone**, and this is the correction
 * for having drawn them zone by zone. `AGOSEngine::animateSprites`
 * (`draw.cpp:202`) walks a single `_vgaSprites` array that every zone appends
 * to, and `vc23_setPriority` (`vga.cpp:1275`) keeps that one array in priority
 * order by sliding an entry along it. A zone is where a sprite's *pixels* come
 * from; it says nothing about what is in front of what.
 *
 * Drawing each zone's sprites in its own pass makes the zone the outer sort
 * key, so a low-priority sprite in a later zone paints over a high-priority
 * one in an earlier zone. Measured cost, in Simon 1's first room: Simon stands
 * at priority 40 in zone 11 and the crystal-ball animation sits at priority 10
 * in zone 64, and the moment a walk ended with him in front of it he was
 * erased — a click moved him and then he was not there, which reads as a walk
 * that failed rather than a draw in the wrong order.
 *
 * The tie-break is {@link VgaSprite.sequence} rather than a zone's position,
 * because equal priorities are resolved in the reference by where the sprite
 * sits in that one array, which is the order the sprites were created in.
 */
export function paintZoneSprites(machines: Iterable<VgaMachine>): void {
  const all: { machine: VgaMachine; sprite: VgaSprite }[] = [];
  for (const machine of machines) {
    for (const sprite of machine.sprites) all.push({ machine, sprite });
  }
  all.sort(
    (a, b) => a.sprite.priority - b.sprite.priority || a.sprite.sequence - b.sprite.sequence,
  );
  for (const { machine, sprite } of all) machine.paintSprite(sprite);
}

export interface VgaReport {
  /** Opcodes reached with no implementation, by name. */
  readonly unimplemented: readonly string[];
  /** Draw flags reached with no implementation, by name. */
  readonly unimplementedFlags: readonly string[];
  readonly executed: number;
  readonly drawn: number;
  /** How many palette banks a run put on screen. */
  readonly palettesSet: number;
}

export class VgaMachine {
  private readonly unimplemented = new Set<string>();
  private readonly unimplementedFlags = new Set<string>();
  private executed = 0;
  private drawn = 0;
  private palettesSet = 0;

  readonly sprites: VgaSprite[] = [];
  /**
   * Whether the pointer is showing, and the frame rate a script asked for.
   *
   * Recorded rather than acted on, which is this project's pattern for a
   * machine with no renderer under it — `SkyWorld` keeps its pointer the same
   * way. With nothing drawing, the record *is* the whole observable behaviour,
   * so it is also what a test can hold.
   */
  mouseVisible = true;
  frameRate: number | null = null;
  /** Sync ids scripts have raised, in the order raised. */
  readonly syncs: number[] = [];
  /** How many times a script asked for all sound to stop. */
  stopAllSoundsCount = 0;
  /** How many times a script asked for the pathfind array to be cleared. */
  clearPathfindCount = 0;
  /**
   * Jumps whose destination did not land on a decoded instruction.
   *
   * `JUMP_REL` is byte-relative and **what its displacement is measured from
   * is not established here** — instruction start, or the byte after the
   * operand. Rather than pick one and be silently wrong by three bytes on
   * every jump, this resolves the target and only jumps when it lands exactly
   * on an instruction boundary the decoder produced. One that does not land is
   * recorded here and the script runs on, so a wrong base shows up as a list
   * of unresolved jumps instead of as a script that misbehaves.
   */
  readonly unresolvedJumps: number[] = [];
  /** Scripts abandoned for running past {@link MAX_STEPS} instructions. */
  runawayScripts = 0;
  /** Fades a script asked for that this machine cannot perform. */
  fadesRequested = 0;
  /**
   * Music a script asked for — a track to play, queue, or segue to.
   *
   * `PLAY_SEQ`, `JOIN_SEQ` and `SEQUE` drive the reference's MIDI player, which
   * is a subsystem this headless machine has no mixer for. So the request is
   * counted, for the reason `fadesRequested` is: with nothing playing sound,
   * the count *is* the whole observable behaviour, and it is honest where
   * pretending to have started a track would not be. `IF_SEQ_WAITING` reads the
   * other side of this — with no player, nothing is ever waiting — so it always
   * takes the not-playing branch.
   */
  midiRequests = 0;
  /**
   * Opcodes run that the reference table marks as doing nothing.
   *
   * Counted separately from everything else so the figure stays honest: these
   * are not work outstanding.
   */
  dummiesRun = 0;
  /**
   * The windows a script has defined, four numbers each: x, y, width, height.
   *
   * A window is where drawing is allowed, and scripts set them by number — the
   * room band, the inventory panel and the text area are windows, which is how
   * a game draws a room without painting over its own interface.
   */
  private readonly ownWindows = new Map<number, [number, number, number, number]>();
  private currentWindow = 0;

  /** The window table: the Engine's where there is one, this machine's otherwise. */
  private get windows(): Map<number, [number, number, number, number]> {
    return this.target.windows ?? this.ownWindows;
  }

  /**
   * Fills a window with a colour.
   *
   * `clearVideoWindow` in the reference, and the reason a room's picture does
   * not arrive on top of the last one: `setImage` clears the window to the
   * colour the *image entry* carries before running the picture's script. That
   * colour has been read into `VgaEntry.colour` all along and never used, so
   * every scene of Simon 1's intro drew over whatever the previous scene had
   * left, and by the end the screen held four of them at once.
   */
  clearWindow(window: number, colour: number): void {
    const rectangle = this.windows.get(window);
    const x = rectangle ? rectangle[0] * 16 : 0;
    const y = rectangle ? rectangle[1] : 0;
    const width = rectangle ? rectangle[2] * 16 : this.target.width;
    const height = rectangle ? rectangle[3] : this.target.height;

    for (let row = y; row < Math.min(y + height, this.target.height); row += 1) {
      const start = row * this.target.width + x;
      this.target.pixels.fill(colour, start, start + Math.min(width, this.target.width - x));
    }
  }
  /** The Feeble Files' depth scaling: a baseline row and a factor per row. */
  private baseY = 0;
  private scalePerRow = 0;
  private scaleOffset: { x: number; y: number } | null = null;
  /**
   * The variables, **shared with the game bytecode** where an Engine supplies
   * them.
   *
   * One array in the reference: `vcReadVar` and `readVariable` index the same
   * `_variableArray`, and the two bytecodes talk to each other through it
   * constantly. Simon's own sprite is the clearest case —
   *
   * ```
   * SET_SPRITE_X 15      ; x comes out of variable 15
   * SET_SPRITE_Y 16      ; y out of variable 16
   * ```
   *
   * — and the game script is what puts his position there. With a private array
   * here the drawing bytecode read zeroes and drew Simon two pixels off the top
   * left corner of the screen, every time, however far the game had walked him.
   *
   * Its own array is the default so a machine built with no Engine behind it
   * keeps working, which is what the sweep and every decoding test want.
   */
  variables: Int16Array = new Int16Array(256);
  /**
   * The bit flags, **one bank for the whole game** where an Engine supplies it.
   *
   * `_bitArray` in the reference, and it is engine-global in exactly the way
   * the variables are: `vc49_setBit` and the game bytecode's `oe2_bSet` both
   * call `setBitFlag`, and `setupVideoOpcodes` installs the same handlers in
   * every zone. A bank per machine looks harmless and is not — Simon 1's first
   * room raises bit 11 from a zone 11 sprite and lowers it from a zone 1
   * sprite, so with a bank each the lower never reached the raise and the bit
   * stayed set for the rest of the game. What that cost is in
   * `docs/released-games.md`: sprite 1122 is the walk's stop script, it guards
   * itself with `IF_BIT_CLEAR 11`, and with the bit stuck set it armed a
   * `WAIT_SYNC 1104` that sat waiting through the intro and then fired on the
   * first turn of the player's first walk, stopping it before a step.
   *
   * Its own set is the default so a machine built with no Engine behind it
   * keeps working, which is what the sweep and every decoding test want.
   */
  bits: Set<number> = new Set();
  /**
   * The tick this machine is on, which `DELAY` measures its sleep against.
   *
   * Advanced by {@link tick}, never by running a script. A script that sleeps
   * for three frames sleeps for three calls to `tick` — so a caller with no
   * clock (the sweep) simply never advances it, and a sleeping script stays
   * asleep rather than being silently let past its wait.
   */
  private clock = 0;
  /**
   * How many frames a `DELAY` operand is worth.
   *
   * Simon 1 multiplies its delay by the engine's frame count; The Feeble Files
   * and the Puzzle Pack take a plain byte. Kept as a field because it is a
   * property of the loaded release rather than of an instruction.
   */
  frameCount = 1;
  /**
   * `SET_REPEAT`/`END_REPEAT` counters, keyed by the `END_REPEAT` that owns one.
   *
   * **The original keeps this count inside the script bytes**, writing the
   * remaining iterations over the operand and decrementing it in place. That is
   * genuinely self-modifying bytecode, and it cannot be done here: this project
   * guarantees a resource re-emits as the bytes it arrived as (ADR 0030), and a
   * loop that rewrote its own operand would break that guarantee for any game
   * whose script had run — a byte-identity check that passes before play and
   * fails after it is the worst shape a check can have.
   *
   * A side table keyed on the loop's own offset is the same arithmetic with the
   * resource left alone. The difference is observable in exactly one way: the
   * original's counter survives a re-entry into the script and this one also
   * does, because the key is a script offset rather than a run.
   */
  private readonly repeatCounters = new Map<number, number>();
  /**
   * The sprites due to run, in the order they fell due.
   *
   * The reference schedules a script rather than scanning for one: `animate`
   * and `vc15_sync` both append an `ANIMATE_EVENT` to `_vgaTimerList`, and
   * `processVgaEvents` walks that list from the front. With Simon 1's
   * `_vgaBaseDelay` of zero an event appended *during* a pass still runs in
   * that pass, because the walk has not reached the end of the list yet.
   *
   * Running the display list in display order instead loses a race the game
   * relies on. Simon's walk is three scripts: the turn (1120) creates the
   * standing figure (1111) and then raises the sync the walk controller (1147)
   * is waiting on; the controller's very next instruction is `SYNC 1100`, which
   * is what takes the standing figure away again. In the reference 1111's
   * animate event is appended before 1147's wake, so 1111 reaches its
   * `WAIT_SYNC 1100` first and the sync finds it. In display order 1147 has the
   * lower index and ran first, the sync fell on an empty table, and a second
   * Simon stood at the spot the walk started from for the rest of the room.
   */
  private readonly ready: VgaSprite[] = [];
  /** Membership of {@link ready}, so a sprite is never queued twice over. */
  private readonly queued = new Set<VgaSprite>();
  /** Scripts that suspended on a `DELAY`, counted for the report. */
  delaysSuspended = 0;
  /** Scripts that suspended on a `WAIT_SYNC`, counted for the report. */
  syncWaitsSuspended = 0;
  /** `CHAIN_TO`s whose sprite had no animation-table entry. */
  readonly unresolvedChains: number[] = [];
  /**
   * The count a `SET_REPEAT` has announced and its `END_REPEAT` has not claimed.
   *
   * Nulled as soon as a loop end takes it, so two nested loops cannot read each
   * other's count.
   */
  private pendingRepeat: number | null = null;
  /** How many times a script cleared the whole sprite table. */
  resetsRun = 0;
  /**
   * Whether the script running now is putting a *window's picture* up.
   *
   * Set by the Engine around the image-table script `setWindowImage` runs, and
   * the only thing that distinguishes Simon 1's thirty-two colour backdrops
   * from its four-bit sprites — see `decode32ColourSprite`. The reference
   * spells it `_videoLockOut & 0x20`, which is the same fact under a name that
   * says less.
   */
  windowImageMode = false;

  /**
   * The window the next draws clip to — `_windowNum` in the reference.
   *
   * `setWindowImage` sets it to the window a picture is put into, so a room
   * drawn into window 4 — Simon's play area, 134 rows tall — clips there rather
   * than painting over the interface band below it. A script's own `SET_WINDOW`
   * moves it; the Engine saves and restores it around a `setWindowImage` draw so
   * the sprites a room's own scripts window for themselves keep theirs.
   */
  get drawWindow(): number {
    return this.currentWindow;
  }
  set drawWindow(window: number) {
    this.currentWindow = window;
  }

  /**
   * How far the room is scrolled, in eight-pixel columns.
   *
   * Simon 2's wide rooms are drawn shifted by this much: every cel's origin
   * moves `scrollX * 8` pixels left, so the visible 320-pixel window slides
   * across a room up to three screens wide. The reference keeps `_scrollX` as
   * engine state and mirrors it into **variable 251**; that variable is shared
   * with this machine already (see {@link VgaMachine.variables}), so reading it
   * back is the same number the reference's `state.x = x - _scrollX` uses. It is
   * zero in every room that does not scroll — `setImage` resets it on entry —
   * so subtracting it unconditionally costs a non-scrolling room nothing.
   */
  private get scrollX(): number {
    return this.variables[251] ?? 0;
  }
  /**
   * The furthest the room can scroll, in columns, or zero when it does not.
   *
   * Set when a wide backdrop is drawn (`_scrollXMax = width * 2 - 40`, with
   * width in sixteens of a pixel — so `width / 8 - 40` from the pixel width),
   * and read by the Engine to clamp its scrolling. Zero says "this room does
   * not scroll", which is what a room whose backdrop fits the screen leaves it.
   */
  scrollXMax = 0;
  /**
   * The last wide backdrop this machine decoded, kept for the Engine to re-blit.
   *
   * A wide room is decoded once, into a bitmap wider than the screen; the
   * visible window is chosen by {@link VgaMachine.scrollX} when it is drawn.
   * When the scroll moves, only that window has to be re-copied — the Engine
   * does it from here rather than re-running the whole picture script, which
   * would re-issue the room's sprites and sounds. Null in a room with no wide
   * backdrop.
   */
  wideBackdrop: WideBackdrop | null = null;

  constructor(
    /** The resource holding scripts, which `vgaFile.ts` reads the tables of. */
    private readonly scripts: Uint8Array,
    /** The resource holding pixels, indexed by image number. */
    private readonly pixels: Uint8Array,
    private readonly table: string,
    private readonly target: VgaTarget,
    /**
     * The world, sound and hit areas this machine asks about but does not own.
     *
     * Defaulted to a recorder so every existing caller keeps working and gets
     * honest counts rather than a crash — see `vgaHost.ts` for why a false
     * answer from a recorder is not the same claim as a right one.
     */
    private readonly host: VgaHost = new RecordingVgaHost(),
    /**
     * Which of `vgaFile.ts`'s three layouts this zone's resources are in.
     *
     * Only the palette reader consults it, and only because Simon's palette
     * encoding and the old-bundle one share nothing but the word. Defaulted to
     * Simon's, which is what every caller with a real game has been passing
     * implicitly.
     */
    private readonly fileLayout: VgaFileLayout = 'simon',
  ) {}

  get report(): VgaReport {
    return {
      unimplemented: [...this.unimplemented].sort(),
      unimplementedFlags: [...this.unimplementedFlags].sort(),
      executed: this.executed,
      drawn: this.drawn,
      palettesSet: this.palettesSet,
    };
  }

  /**
   * Runs one script to its end.
   *
   * `RET` ends it. A script is not length-prefixed, so nothing else can — which
   * is why an unknown opcode has to stop the run rather than be skipped.
   */
  /**
   * Starts a sprite: a script of its own, running from now on.
   *
   * **A sprite is not created at a script offset of zero**, and it used to be.
   * `NEW_SPRITE` and the game opcode `o_animate` both name a sprite by *id*,
   * and the id is looked up in the graphics resource's **animation table** to
   * find where its script starts — offset zero is the resource's own first
   * words, so a sprite built without the lookup ran the file header as
   * bytecode.
   *
   * Nothing is created for an id the table has no entry for. That is a script
   * and a resource disagreeing, which is worth reporting rather than animating
   * whatever happens to be at the front of the file.
   *
   * A sprite already running for this id is left alone, which is the
   * reference's first act in `animate`: a script that asks twice means "make
   * sure this is running", not "run it twice".
   */
  startSprite(id: number, x: number, y: number, palette: number): VgaSprite | undefined {
    const existing = this.sprites.find((sprite) => sprite.id === id && !sprite.halted);
    if (existing) return existing;

    const offset = this.host.animationScriptOffset(id);
    if (offset === null) {
      this.unimplemented.add(`NEW_SPRITE: no animation ${id} in this zone's table`);
      return undefined;
    }

    const sprite: VgaSprite = {
      id,
      x,
      y,
      palette,
      priority: 0,
      image: 0,
      flags: 0,
      scriptOffset: offset,
      halted: false,
      // Null rather than `offset`, so the scheduler starts it at the top.
      resumeOffset: null,
      wakeAtTick: null,
      waitingForSync: null,
      sequence: nextSpriteSequence,
    };
    nextSpriteSequence += 1;
    this.sprites.push(sprite);
    this.enqueue(sprite);
    return sprite;
  }

  /** Puts a sprite at the back of the run queue, once. */
  private enqueue(sprite: VgaSprite): void {
    if (this.queued.has(sprite)) return;
    this.queued.add(sprite);
    this.ready.push(sprite);
  }

  run(offset: number, sprite?: VgaSprite): void {
    /**
     * **Decoded from the script's start, not from where it is being resumed.**
     *
     * A sprite that suspended on a `DELAY` comes back at its resume offset, and
     * decoding from there leaves `indexAt` with no boundary earlier than that
     * point — so a **backward** `JUMP_REL`, which is how every animation loop in
     * the game closes, had nothing to land on and was recorded as unresolved.
     * Simon 2's walk cycle is exactly that shape: a `SET_REPEAT`, six frames,
     * then `JUMP_REL -111` back to the `SET_REPEAT`. Before this, one room's
     * scripts carried fifty-one unresolved jumps between them.
     *
     * Guarded rather than unconditional: a sprite that has chained into another
     * script resumes somewhere its original script never reaches, and decoding
     * across the gap would read the bytes between two scripts as instructions.
     * So the wider decode is used only when it really contains the resume point.
     */
    let instructions = readVgaScript(this.scripts, this.table, offset).instructions;
    if (sprite && sprite.scriptOffset < offset) {
      const whole = readVgaScript(this.scripts, this.table, sprite.scriptOffset).instructions;
      if (whole.some((each) => each.offset === offset)) instructions = whole;
    }
    // Where each instruction starts, so a byte-relative jump can be turned
    // into a position in this list. Built per run because a script is decoded
    // per run; the alternative is decoding the whole resource, which is not
    // possible when nothing says where scripts end but their own terminator.
    const indexAt = new Map<number, number>();
    for (let index = 0; index < instructions.length; index += 1) {
      indexAt.set(instructions[index]!.offset, index);
    }

    // A budget rather than a plain walk, now that a jump can go backwards. A
    // script that loops for ever is a fact about the script; a reader that
    // hangs on one is a fault in the reader.
    let steps = 0;
    for (let index = indexAt.get(offset) ?? 0; index < instructions.length; index += 1) {
      if (steps > MAX_STEPS) {
        this.runawayScripts += 1;
        return;
      }
      steps += 1;
      const instruction = instructions[index]!;
      this.executed += 1;

      if (instruction.name === 'JUMP_REL') {
        const target = this.jumpTarget(instruction, indexAt);
        if (target === null) {
          this.unresolvedJumps.push(instruction.offset);
          continue;
        }
        index = target - 1;
        continue;
      }

      const step = this.execute(instruction, sprite);
      if (step.kind === 'retry') {
        // `DELAY_IF_NOT_EQ` waits *for* a condition, so it has to be the
        // instruction the sprite wakes on. Resuming after it would turn a wait
        // into a single failed test.
        if (sprite) {
          sprite.resumeOffset = instruction.offset;
          sprite.wakeAtTick = this.clock + 1;
        }
        return;
      }
      if (step.kind === 'suspend') {
        // Where to come back to. The instruction after this one, because the
        // wait itself has been served by the time the sprite wakes — a resume
        // that re-entered the `DELAY` would sleep for ever.
        const next = instructions[index + 1];
        if (sprite) sprite.resumeOffset = next ? next.offset : null;
        return;
      }
      if (step.kind === 'jump') {
        const target = indexAt.get(step.offset);
        if (target === undefined) {
          // Outside this decode. A `CHAIN_TO` legitimately lands in another
          // script, so this restarts the walk there rather than calling it an
          // error — and a sprite-less caller has nowhere to carry on, so it
          // stops and says so.
          if (sprite) {
            sprite.resumeOffset = step.offset;
            return;
          }
          this.unresolvedJumps.push(step.offset);
          continue;
        }
        index = target - 1;
        continue;
      }
      if (step.kind === 'skip') index += 1;
      if (instruction.name === 'RET') break;
    }
    if (sprite) sprite.resumeOffset = null;
  }

  /**
   * Advances the clock one frame, runs every sprite that is due, and draws them.
   *
   * A convenience for a caller with one machine — a test, or the sweep. An
   * Engine with several zones on screen at once must not use it: see
   * {@link runFrame} for why running and drawing are separable, and
   * {@link paintZoneSprites} for the pass that replaces it.
   */
  tick(): void {
    this.runFrame();
    this.paintSprites();
  }

  /**
   * Advances the clock one frame and runs every sprite that is due.
   *
   * This is what makes `DELAY` and `WAIT_SYNC` real rather than counted. A
   * sprite mid-sleep is stepped over; one whose wake tick has arrived, or whose
   * sync has been raised, carries on from its own `resumeOffset`.
   *
   * **Running is separate from drawing** because z-order is not a zone's
   * business: see {@link paintZoneSprites}.
   *
   * A caller that never calls this — the sweep — still runs every script once
   * through {@link step}, and a script that sleeps simply stops there. That is
   * the honest outcome for a machine with no clock driving it, and it is why
   * the sleep counters are part of the report.
   */
  runFrame(): void {
    this.clock += 1;
    // The delays that came due this frame, in table order, which is the order
    // `processVgaEvents` decrements them in. Everything else already queued
    // itself when it was created or woken.
    for (const sprite of this.sprites) {
      if (sprite.halted || sprite.waitingForSync !== null) continue;
      if (sprite.wakeAtTick === null || this.clock < sprite.wakeAtTick) continue;
      sprite.wakeAtTick = null;
      this.enqueue(sprite);
    }
    // Drained rather than iterated, so a sprite a running script creates or
    // wakes runs in this pass and behind the work already queued — the whole
    // point of a queue here. See {@link ready}.
    for (let runs = 0; this.ready.length > 0; runs += 1) {
      if (runs >= MAXIMUM_SPRITE_RUNS_PER_TICK) {
        this.unimplemented.add('run queue: too many sprite runs in one frame');
        break;
      }
      const sprite = this.ready.shift();
      if (!sprite) break;
      this.queued.delete(sprite);
      if (sprite.halted || sprite.wakeAtTick !== null || sprite.waitingForSync !== null) continue;
      this.run(sprite.resumeOffset ?? sprite.scriptOffset, sprite);
    }
    this.reap();
  }

  /**
   * Drops the sprites whose scripts have halted.
   *
   * **A halted sprite is gone, not stopped**, and this is the one place that
   * distinction is made. `vc25_halt_sprite` shifts the whole table down over
   * the entry — the sprite stops existing, and stops being drawn with it.
   * Keeping halted sprites in the table and painting them anyway left every
   * pose Simon had ever struck standing in the room: walk two steps and there
   * were three of him.
   *
   * Swept after the run rather than during it, because a script halting itself
   * is the common case and removing an element from under the loop walking it
   * is how that becomes a skipped sprite.
   */
  private reap(): void {
    const live = this.sprites.filter((sprite) => !sprite.halted);
    if (live.length === this.sprites.length) return;
    this.sprites.splice(0, this.sprites.length, ...live);
  }

  /** Forgets this machine's sprites and its repeat counters. */
  clearSprites(): void {
    this.sprites.length = 0;
    this.ready.length = 0;
    this.queued.clear();
    this.repeatCounters.clear();
    this.pendingRepeat = null;
    this.resetsRun += 1;
  }

  /**
   * Wakes every sprite of *this* machine that was waiting for a sync id.
   *
   * Separated from the `SYNC` opcode because a sync is **global**: the
   * reference keeps one `_waitSyncTable` for every sprite in the game
   * regardless of zone, and Simon 1's intro relies on it — sprite 13500 in zone
   * 135 waits for a sync that a sprite in zone 150 raises. A machine that woke
   * only its own sprites left that pair deadlocked, and the intro stopped on
   * its first animation.
   */
  wakeSync(id: number): void {
    for (const sprite of this.sprites) {
      if (sprite.waitingForSync !== id) continue;
      sprite.waitingForSync = null;
      // Queued from here rather than found by the next scan, because *when* it
      // was woken is what decides the order it runs in. See {@link ready}.
      this.enqueue(sprite);
    }
  }

  /**
   * Halts every sprite of this machine with a given id.
   *
   * The counterpart of {@link wakeSync} for stopping rather than waking: a
   * `STOP_ANIMATE` in one zone stops the sprite wherever it runs, so the Engine
   * calls this on every loaded machine.
   */
  stopSprite(id: number): void {
    for (const sprite of this.sprites) {
      if (sprite.id === id) sprite.halted = true;
    }
  }

  /** Runs every sprite that has not halted and is not asleep, once. */
  step(): void {
    for (const sprite of this.sprites) {
      if (sprite.halted) continue;
      if (sprite.wakeAtTick !== null || sprite.waitingForSync !== null) continue;
      this.run(sprite.resumeOffset ?? sprite.scriptOffset, sprite);
    }
  }

  /**
   * Where a `JUMP_REL` goes, or null when nothing decoded starts there.
   *
   * Both plausible bases are tried — the byte after the operand first, since
   * that is the commoner convention, then the instruction's own start. A
   * displacement that lands on a boundary under exactly one of them is
   * unambiguous; one that lands under neither is the interesting case and is
   * reported rather than guessed at.
   */
  private jumpTarget(
    instruction: VgaInstruction,
    indexAt: ReadonlyMap<number, number>,
  ): number | null {
    const operand = instruction.operands[0];
    if (!operand || operand.kind !== 'word') return null;
    const afterOperand = instruction.offset + (vgaHasWideOpcodes(this.table) ? 2 : 1) + 2;
    for (const base of [afterOperand, instruction.offset]) {
      const found = indexAt.get(base + operand.value);
      if (found !== undefined) return found;
    }
    return null;
  }

  /**
   * An image operand, which may name a variable by being negative.
   *
   * `vcReadVarOrWord`: a `w` operand is a signed word, and a negative one is
   * *minus a variable index* rather than a small image number. Reading it as a
   * literal picks image −5, which has no entry, so the failure is a reported
   * miss rather than a wrong picture — but it is still the wrong cel and the
   * scripts use the form constantly.
   */
  private imageOperand(operand: VgaOperand | undefined): number {
    if (!operand) return 0;
    if (operand.kind === 'variable') return this.variables[operand.value & 255] ?? 0;
    const value = operand.kind === 'byte' || operand.kind === 'word' ? operand.value : 0;
    return value < 0 ? (this.variables[-value & 255] ?? 0) : value;
  }

  private value(operand: VgaOperand | undefined): number {
    if (!operand) return 0;
    switch (operand.kind) {
      case 'byte':
      case 'word':
        return operand.value;
      case 'variable':
        return this.variables[operand.value & 255] ?? 0;
      case 'pairs':
        return operand.values.length;
    }
  }

  private index(operand: VgaOperand | undefined): number {
    if (!operand) return 0;
    return operand.kind === 'pairs' ? 0 : operand.value & 255;
  }

  /** Returns true when the next instruction should be skipped. */
  /**
   * The scale for a sprite at a given row.
   *
   * Above the baseline an actor grows, below it shrinks, by the factor per row
   * a script set. Returns 1 where no script has set one, so every Version but
   * The Feeble Files takes the unscaled path without asking which it is.
   */
  private scaleFactorAt(y: number): number {
    if (this.scalePerRow === 0) return 1;
    const factor =
      y > this.baseY
        ? 1 + (y - this.baseY) * this.scalePerRow
        : 1 - (this.baseY - y) * this.scalePerRow;
    // A factor at or below zero is a script and a baseline that disagree, and
    // scaling to nothing would silently delete an actor.
    return factor > 0 ? factor : 1;
  }

  private execute(instruction: VgaInstruction, sprite?: VgaSprite): Step {
    const operand = (at: number): number => this.value(instruction.operands[at]);

    switch (instruction.name) {
      case 'RET':
        return NEXT;

      case 'NEW_SPRITE': {
        // The operand order differs between AGOS 1 and 2, and the difference is
        // a zone number rather than a reshuffle, so the table's own length says
        // which shape this is.
        const wide = instruction.operands.length >= 6;
        const id = operand(wide ? 2 : 1);
        const x = operand(wide ? 3 : 2);
        const y = operand(wide ? 4 : 3);
        const palette = operand(wide ? 5 : 4);
        // **A sprite's zone, and it need not be this one.** Simon 1's `ddddd`
        // shape carries no zone, so the zone is the id's own hundreds column;
        // Simon 2's `dddddd` puts the zone in front as an explicit operand, and
        // reading it as the id's hundreds column instead started the sprite in
        // whatever zone its number happened to spell rather than the one the
        // script named. Started through the host so the Engine can load the
        // zone it belongs to; a sprite this machine owns comes straight back
        // here. See `vgaHost.ts`'s `startSpriteInZone` for what this cost.
        // **The zone is the second operand, not the first.** `vc3_loadSprite`
        // reads `windowNum` for every Version and only then branches to read a
        // zone for Simon 2 — so `operand(0)` is the window, 3 or 4 in this
        // game, and taking it as the zone looks for every sprite in a zone that
        // holds none. Simon 1's narrow shape carries no zone at all and the
        // id's hundreds column is it.
        const zone = wide ? operand(1) : Math.floor(id / 100);
        if (!this.host.startSpriteInZone(zone, id, x, y, palette)) {
          this.startSprite(id, x, y, palette);
        }
        return NEXT;
      }

      case 'DRAW':
        this.draw(instruction);
        return NEXT;

      /**
       * The opcode that makes a sprite visible, and its name is a trap.
       *
       * `SET_SPRITE_XY` sets **four** things — the cel, a *relative* move in x
       * and y, and the draw flags — and this used to read it as an absolute
       * move and drop the other two operands. Its four letters (`wiid`) were
       * saying so the whole time: `w` is the image, the two `i`s are signed
       * deltas, `d` is the flags.
       *
       * That single misreading is why Simon 1 drew nothing. It is the commonest
       * instruction in the game's scripts — 225 of the first 700 executed — and
       * with the image thrown away every sprite stayed on cel zero, which draws
       * nothing at all. Everything else about the renderer was working.
       */
      case 'SET_SPRITE_XY':
        if (sprite) {
          sprite.image = this.imageOperand(instruction.operands[0]);
          sprite.x += operand(1);
          sprite.y += operand(2);
          sprite.flags = operand(3);
        }
        return NEXT;
      /**
       * The stencil form of the same thing.
       *
       * `MASK` sets the image and a relative move like `SET_SPRITE_XY` and then
       * fixes the flags itself rather than taking them from an operand: masked,
       * and not stored to the background.
       */
      case 'MASK':
        if (sprite) {
          sprite.image = this.imageOperand(instruction.operands[0]);
          sprite.x += operand(1);
          sprite.y += operand(2);
          sprite.flags = DRAW_FLAGS.masked | DRAW_FLAGS.skipStoreBackground;
        }
        return NEXT;
      // `vc45`/`vc46`: absolute, and the operand is a *variable* to read the
      // position out of rather than the position itself.
      case 'SET_SPRITE_X':
        if (sprite) sprite.x = operand(0);
        return NEXT;
      case 'SET_SPRITE_Y':
        if (sprite) sprite.y = operand(0);
        return NEXT;
      // `vc13`/`vc14`: a relative move, which is what the name says.
      case 'SET_SPRITE_OFFSET_X':
      case 'ADD_SPRITE_X':
        if (sprite) sprite.x += operand(0);
        return NEXT;
      case 'SET_SPRITE_OFFSET_Y':
      case 'ADD_SPRITE_Y':
        if (sprite) sprite.y += operand(0);
        return NEXT;
      /**
       * `SET_PRIORITY` (`vc23`) takes a *single* operand — the priority — in
       * every Version's table (`d`), and `vc23_setPriority` reads exactly one
       * word (`vga.cpp:1275`). This used to read `operand(1)`, which is the
       * second operand of a one-operand opcode and so always resolved to zero:
       * every sprite was left at priority zero, `paintSprites`'s sort could
       * never tell two apart, and characters drew in insertion order. Shared
       * with Simon 1, whose `vc23` has the same shape.
       */
      case 'SET_PRIORITY':
        if (sprite) sprite.priority = operand(0);
        return NEXT;
      case 'HALT_SPRITE':
        if (sprite) sprite.halted = true;
        return NEXT;
      /**
       * Three more whose behaviour here is a record, for the reason
       * `SET_FRAME_RATE`'s note gives: nothing under this machine draws, keeps
       * a clock or makes a sound, so noting what a script asked for is the
       * whole of what can honestly happen.
       *
       * All three have the **same operand shape in every Version**, which is
       * why they are safe to take together — checked rather than assumed, after
       * `STOP_ANIMATE` turned out to vary.
       *
       * Two neighbours used to be left out here and both are now implemented,
       * because both reasons turned out to be wrong. `DELAY`'s operand width
       * does vary (`d`, `w` and `b` across the tables) but **`b` is in the
       * decoder's letter set** — `vgaScript.ts` has read it all along — and
       * `this.value` resolves all three spellings, so one expression covers
       * them. `WAIT_SYNC` did need a scheduler to sit in, and there is now one.
       */
      /**
       * Raises a sync id, and wakes whatever was waiting for it.
       *
       * The push is kept — it is what a test reads — but the waking is the
       * behaviour: `WAIT_SYNC` is only a real wait if something can end it.
       */
      case 'SYNC': {
        const id = operand(0);
        this.syncs.push(id);
        this.wakeSync(id);
        // And across the seam, twice over. A *game* script may be waiting for
        // this — `o_waitSync` blocks on it, and Simon 1's intro is built out of
        // that pairing — and so may a sprite in **another zone**, because the
        // reference's wait table is one table for the whole game. Waking only
        // this machine's own sprites left the intro's first animation waiting
        // for a sync raised one zone over.
        this.host.syncRaised(id);
        return NEXT;
      }
      case 'STOP_ALL_SOUNDS':
        this.stopAllSoundsCount += 1;
        return NEXT;
      /**
       * Forgets every route, and is no longer only counted.
       *
       * The count stays, because it is what a report reads, but the clearing
       * is the behaviour: leaving routes in place after a script discarded
       * them would walk an actor along one the game had thrown away.
       */
      case 'CLEAR_PATHFIND_ARRAY':
        this.clearPathfindCount += 1;
        this.host.clearPathfind();
        return NEXT;
      case 'MOUSE_ON':
        this.mouseVisible = true;
        return NEXT;
      case 'MOUSE_OFF':
        this.mouseVisible = false;
        return NEXT;
      /**
       * The rate a script wants, kept rather than obeyed. Nothing here paces
       * anything — the Engine owns the clock — so storing it is honest and
       * pretending to honour it would not be.
       */
      case 'SET_FRAME_RATE':
        this.frameRate = operand(0);
        return NEXT;

      case 'SET_VAR':
        this.variables[this.index(instruction.operands[0])] = operand(1);
        return NEXT;
      case 'ADD_VAR':
      case 'ADD_TO_VAR': {
        const at = this.index(instruction.operands[0]);
        this.variables[at] = (this.variables[at] ?? 0) + operand(1);
        return NEXT;
      }
      /**
       * `SUB_VAR` is `ADD_VAR` the other way and shares its operand shape
       * (`vd` — a variable and an immediate), which is why it sits here rather
       * than anywhere more interesting.
       */
      case 'SUB_VAR': {
        const at = this.index(instruction.operands[0]);
        this.variables[at] = (this.variables[at] ?? 0) - operand(1);
        return NEXT;
      }
      /**
       * The two `vv` forms — both operands are variables, so the second is
       * *read* rather than taken as an immediate.
       *
       * That distinction is the whole reason these are separate opcodes from
       * `SET_VAR` and `ADD_VAR` rather than a wider operand on them, and
       * reading the second operand as a literal is the mistake the shape
       * invites: it would work on a script whose source variable happens to be
       * numbered the same as its value.
       *
       * **`COPY_VAR` is source first and destination second**, which is the
       * opposite way round from `ADD_VAR_F` below it and from every `vd` form
       * above. `vc32_copyVar` reads the first operand's *contents* and only
       * then reads the word it writes them to. Assignment reads left-to-right
       * in most notations and this one does not, so the wrong way round looks
       * right — and it cost Simon 2 a walk. Its rooms plan a multi-leg walk
       * into variables 61 upwards and the controller loads each leg back with
       * `COPY_VAR var17, var10`; copied the other way that overwrote the plan
       * with the leg just finished, so the step count was zero and Simon stood
       * still on every click inside Calypso's shop.
       */
      case 'COPY_VAR':
        this.variables[this.index(instruction.operands[1])] =
          this.variables[this.index(instruction.operands[0])] ?? 0;
        return NEXT;
      case 'ADD_VAR_F': {
        const at = this.index(instruction.operands[0]);
        this.variables[at] =
          (this.variables[at] ?? 0) + (this.variables[this.index(instruction.operands[1])] ?? 0);
        return NEXT;
      }
      case 'SET_BIT':
        this.bits.add(operand(0));
        return NEXT;
      case 'CLEAR_BIT':
        this.bits.delete(operand(0));
        return NEXT;

      // Conditions: a failed test skips the next instruction, which is the
      // whole of a VGA script's control flow.
      case 'IF_VAR_NOT_ZERO':
        return skipIf((this.variables[this.index(instruction.operands[0])] ?? 0) === 0);
      case 'IF_EQUAL':
        return skipIf((this.variables[this.index(instruction.operands[0])] ?? 0) !== operand(1));
      case 'IF_BIT_SET':
        return skipIf(!this.bits.has(operand(0)));
      case 'IF_BIT_CLEAR':
        return skipIf(this.bits.has(operand(0)));

      /**
       * Two different opcodes with one name, told apart by their operands.
       *
       * ScummVM's own name table calls both `SET_WINDOW`: opcode 26 *defines* a
       * window's rectangle (`ddddd`) and opcode 31 *selects* one (`d`). Because
       * the names here are generated from that table rather than written by
       * hand, a switch on the name alone sent the five-operand form to the
       * selector — which read its window number, ignored the rectangle, and
       * left the window it had just selected with no rectangle at all. Every
       * draw then clipped against the whole screen and none was offset by its
       * window.
       *
       * The operand count is the discriminator, and it is a fact about the
       * table rather than a guess. `SET_SUB_WINDOW` stays as an alias for the
       * Versions whose table spells the two apart.
       */
      case 'SET_SUB_WINDOW':
        this.windows.set(operand(0), [operand(1), operand(2), operand(3), operand(4)]);
        return NEXT;
      case 'SET_WINDOW':
        if (instruction.operands.length >= 5) {
          this.windows.set(operand(0), [operand(1), operand(2), operand(3), operand(4)]);
          return NEXT;
        }
        this.currentWindow = operand(0);
        return NEXT;

      case 'SETSCALE':
        // The Feeble Files scales an actor by how far down the screen it is,
        // which is how it puts one in depth. The two numbers are a baseline and
        // a factor-per-row, and the factor arrives as millionths — an integer
        // standing in for a float, which is the sort of thing that reads as a
        // wildly wrong scale if taken at face value.
        this.baseY = operand(0);
        // Masked back to unsigned. A `d` operand is *kept* signed because a
        // listing shows it that way, and the interpreter reads it unsigned —
        // so a factor of 0xFFFF arrives here as -1 and would shrink an actor
        // by a millionth per row instead of growing it by a fifteenth.
        this.scalePerRow = (operand(1) & 0xffff) / 1_000_000;
        return NEXT;
      case 'SETSCALEXOFFS':
      case 'SETSCALEYOFFS':
        this.scaleOffset = { x: operand(0), y: operand(1) };
        return NEXT;

      /**
       * The palette goes black. No operands in any Version that has it, and
       * the end state is not open to interpretation, which is what makes this
       * safe to take where the fades are not.
       */
      /**
       * The four opcodes the reference table calls `DUMMY`, and why a no-op is
       * the *implementation* rather than a shrug.
       *
       * These are slots the original interpreter occupied and did nothing for.
       * So consuming their operands and doing nothing is not an omission — it
       * is the behaviour. That distinction matters for the report: an opcode
       * left unimplemented is a gap somebody should close, and one recorded
       * here is a gap that does not exist, and conflating the two would make
       * the coverage figure lie in the flattering direction.
       *
       * Their arity is consistent wherever each appears — `dd`, `ddd`, and
       * none for the last two — checked rather than assumed, so the operands
       * are consumed correctly even though nothing is done with them.
       */
      case 'DUMMY_53':
      case 'DUMMY_54':
      case 'DUMMY_56':
      case 'DUMMY_58':
        this.dummiesRun += 1;
        return NEXT;
      case 'BLACK_PALETTE':
        this.target.setPalette?.(0, new Uint8Array(256 * 3));
        this.palettesSet += 1;
        return NEXT;
      /**
       * The fades are **counted and not performed**, and the reason is the same
       * one `WAIT_SYNC` is left out for: they need a clock this machine does
       * not have.
       *
       * A fade-out's end state is black and a fade-in's is the palette it came
       * from — but nothing here remembers what that was, so honouring the
       * out-half and not the in-half would leave a script that fades out and
       * back sitting on a black screen. That is worse than not fading: an
       * unperformed fade is a count somebody can read, and a half-performed
       * pair is a black screen nobody can explain.
       */
      case 'FASTFADEOUT':
      case 'FASTFADEIN':
        this.fadesRequested += 1;
        return NEXT;
      case 'SET_PALETTE': {
        // **Two operands, and the first is not decoration.** `SET_PALETTE`'s
        // group says how many colours arrive and where they land — group 0
        // brings thirty-two at index zero, any other group brings sixteen,
        // sixteen indices up per group. Passing only the second operand loaded
        // every bank over the first sixteen colours, so a room's second bank
        // overwrote its first and three quarters of the palette stayed black.
        const bank = readVgaPaletteBank(this.scripts, operand(0), operand(1), this.fileLayout);
        this.target.setPalette?.(bank.base, bank.rgb);
        this.palettesSet += 1;
        return NEXT;
      }

      case 'CLEAR_WINDOW':
        this.target.pixels.fill(0);
        return NEXT;

      /**
       * The two fades, which are **dummies in every Version this family runs**.
       *
       * Worth a comment because it looks like an omission and is not. The
       * reference consumes these six bytes and does nothing with them: a real
       * fade exists only in Personal Nightmare's day/night palette mode, which
       * is a different engine and out of scope. So a no-op is the behaviour,
       * exactly as it is for the `DUMMY_*` slots, and it is counted with them
       * rather than left in `unimplemented` where it would read as work
       * outstanding that nobody can ever do.
       *
       * `FASTFADEIN`/`FASTFADEOUT` are the opcodes that really do fade, and
       * they stay counted-not-performed for the reason their own note gives.
       */
      case 'FADEIN':
      case 'FADEOUT':
        this.dummiesRun += 1;
        return NEXT;

      /**
       * `CALL` starts another zone's script, and is not a subroutine call.
       * Nothing returns to here; the operand names an image whose own script
       * takes over drawing. Zone loading belongs to the Engine, so it is asked
       * for through the host seam.
       */
      case 'CALL':
        this.host.loadImage(operand(0));
        return NEXT;

      // The item-tree conditions. Each skips the next instruction when its
      // answer is no, which is the only control structure this language has.
      case 'IF_OBJECT_HERE':
        return skipIf(!this.host.objectHere(operand(0)));
      case 'IF_OBJECT_NOT_HERE':
        return skipIf(this.host.objectHere(operand(0)));
      case 'IF_OBJECT_IS_AT':
        return skipIf(!this.host.objectIsAt(operand(0), operand(1)));
      case 'IF_OBJECT_STATE_IS':
        return skipIf(!this.host.objectStateIs(operand(0), operand(1)));
      case 'IF_SPEECH':
        return skipIf(!this.host.speechActive());

      /**
       * `DELAY` sleeps, and the sleep is in frames rather than in its operand.
       *
       * The operand is multiplied by the release's frame count on every Version
       * but The Feeble Files and the Puzzle Pack, which take a plain byte — and
       * `this.value` already resolves a `variable` operand by reading it and a
       * `byte` or `word` as an immediate, so one expression covers all three
       * spellings the tables give this opcode.
       */
      case 'DELAY':
        if (sprite) {
          sprite.wakeAtTick = this.clock + Math.max(1, operand(0) * this.frameCount);
        }
        this.delaysSuspended += 1;
        return SUSPEND;

      /**
       * `WAIT_SYNC` sleeps until some other script raises the id it names.
       *
       * The pairing with `SYNC` is the whole point: one script drives an
       * animation and another waits for it to reach a moment. Before there was
       * a scheduler this could only be recorded, and recording it let a script
       * straight past a wait it was meant to sit in — which is why it was
       * deliberately left out rather than counted.
       */
      case 'WAIT_SYNC':
        if (sprite) sprite.waitingForSync = operand(0);
        this.syncWaitsSuspended += 1;
        return SUSPEND;

      /**
       * Waits for a variable to reach a value, re-testing each frame.
       *
       * `RETRY` rather than `SUSPEND` because the test is the thing being
       * waited on: a resume that landed after this instruction would test once
       * and give up.
       */
      case 'DELAY_IF_NOT_EQ':
        if ((this.variables[this.index(instruction.operands[0])] ?? 0) === operand(1)) {
          return NEXT;
        }
        return RETRY;

      /**
       * `CHAIN_TO` restarts the running sprite's own animation, and takes no
       * operand at all — the sprite's id is the argument. Where its script
       * starts is in the resource's animation table, which the host owns.
       */
      case 'CHAIN_TO': {
        if (!sprite) return NEXT;
        const offset = this.host.animationScriptOffset(sprite.id);
        if (offset === null) {
          this.unresolvedChains.push(sprite.id);
          return NEXT;
        }
        return { kind: 'jump', offset };
      }

      /**
       * The repeat pair, kept beside the loop rather than inside it.
       *
       * `SET_REPEAT` arrives with the count and the *matching* `END_REPEAT` is
       * what owns it, so the count is stored against the end of the loop —
       * which is the instruction that needs to read it. See
       * {@link repeatCounters} for why this is a side table and not the
       * self-modifying write the original performs.
       */
      case 'SET_REPEAT':
        this.pendingRepeat = operand(0);
        return NEXT;
      case 'END_REPEAT': {
        const at = instruction.offset;
        let remaining = this.repeatCounters.get(at);
        if (remaining === undefined) {
          remaining = this.pendingRepeat ?? 0;
          this.pendingRepeat = null;
        }
        if (remaining <= 0) {
          this.repeatCounters.delete(at);
          return NEXT;
        }
        this.repeatCounters.set(at, remaining - 1);
        // Byte-relative and measured from after the operand, the same base
        // `JUMP_REL` uses.
        const operandBytes = vgaHasWideOpcodes(this.table) ? 2 : 1;
        // **The displacement lands inside `SET_REPEAT`, not on an instruction.**
        // The original keeps the loop counter in the script bytes — `vc20`
        // writes it there — and `vc21` reads it back through this displacement:
        // three past the target for AGOS 2 and Simon 2, four for the rest, then
        // two more to step over the counter and reach the loop body.
        const counterBias =
          this.table === 'simon2' || this.table === 'feeblefiles' || this.table === 'puzzlepack'
            ? 3
            : 4;
        return { kind: 'jump', offset: at + operandBytes + 2 + operand(0) + counterBias + 2 };
      }

      /**
       * `RESET` clears the sprite table and every outstanding wait.
       *
       * A screen change rather than a tidy-up: it is how a game abandons
       * everything currently animating. Waits have to go with the sprites,
       * because a sync a departed script was going to raise will never come.
       */
      /**
       * Clears the sprite table — **every zone's**, not this machine's.
       *
       * `vc27_resetSprite` walks one `_vgaSprites` array for the whole game, so
       * a script ending a scene clears the sprites of every zone the scene
       * used. Clearing only its own left the previous scene's actors running
       * over the next one, which is what Simon 1's intro looked like by its
       * fourth screen.
       */
      case 'RESET':
        this.clearSprites();
        this.host.resetSprites();
        return NEXT;

      /**
       * Stops one sprite, leaving the rest running.
       *
       * The shape says which sprite and where. Simon 2's `dd` is (zone,
       * sprite): its ids are zone-local, so the sprite is the *second* operand
       * and the first names the zone it lives in — reading the first as the
       * sprite halted whichever one's id happened to equal a zone number. The
       * narrow `d` is a global id alone, matched in every zone. Both go through
       * the host, which owns the other zones; the narrow form also halts this
       * machine's own copy directly.
       */
      case 'STOP_ANIMATE': {
        if (instruction.operands.length >= 2) {
          this.host.stopSprite(operand(1), operand(0));
        } else {
          const id = operand(0);
          this.stopSprite(id);
          this.host.stopSprite(id);
        }
        return NEXT;
      }

      /**
       * `WAIT_BIG` (`vc56`) is `DELAY` with a wider counter: a `w` operand
       * times the frame count, then sleep. Simon 2's long waits use it where a
       * byte would overflow. It suspends exactly as `DELAY` does — the operand
       * is a var-or-word, which `this.value` resolves — so the two share a
       * scheduler and differ only in the number they wait on.
       */
      case 'WAIT_BIG':
        if (sprite) {
          sprite.wakeAtTick = this.clock + Math.max(1, operand(0) * this.frameCount);
        }
        this.delaysSuspended += 1;
        return SUSPEND;

      /**
       * `SET_PRIORITIES` (`vc58`) sets one sprite's draw priority — the same
       * field `SET_PRIORITY` writes, but for a sprite named by (zone, sprite)
       * rather than the running one. The reference reads its target out of a
       * game-wide sprite array; this machine holds one zone, so it writes the
       * priority of its own sprite with that id. A target in another zone is
       * not this machine's to reach, the same scope `HALT_SPRITE` keeps.
       */
      case 'SET_PRIORITIES': {
        const id = operand(1);
        const priority = operand(2);
        for (const each of this.sprites) {
          if (each.id === id) each.priority = priority;
        }
        return NEXT;
      }

      /**
       * `STOP_ANIMATIONS` (`vc59`) halts a *range* of sprites in a zone — the
       * batch form of `STOP_ANIMATE`. The three operands are (zone, first,
       * last), and the reference's loop runs `first..last` inclusive. Each stop
       * goes through the host, which owns the zone the range names.
       */
      case 'STOP_ANIMATIONS': {
        const zone = operand(0);
        const last = operand(2);
        for (let id = operand(1); id <= last; id += 1) {
          this.host.stopSprite(id, zone);
        }
        return NEXT;
      }

      /**
       * `SLOW_FADE_IN` (`vc65`) is a real fade, and stays counted-not-performed
       * for the reason `FASTFADEIN` gives: honouring a fade needs a clock and a
       * remembered target palette this machine does not keep, and a
       * half-performed fade leaves a screen nobody can explain.
       */
      case 'SLOW_FADE_IN':
        this.fadesRequested += 1;
        return NEXT;

      /**
       * The three variable comparisons (`vc66`–`vc68`), all `ddj`: two operands
       * that are **variable indices**, and a `j` marker the decoder consumes as
       * nothing. Each reads both variables and skips the next instruction when
       * the test fails — and the sense is the reference's, which is the reverse
       * of the name: `IF_VAR_LE` skips when a `>=` b, `IF_VAR_GE` when a `<=` b.
       * Taking the operands as immediates, or flipping the comparison, would
       * send a script down the wrong branch of its own logic.
       */
      case 'IF_VAR_EQUAL': {
        const a = this.variables[this.index(instruction.operands[0])] ?? 0;
        const b = this.variables[this.index(instruction.operands[1])] ?? 0;
        return skipIf(a !== b);
      }
      case 'IF_VAR_LE': {
        const a = this.variables[this.index(instruction.operands[0])] ?? 0;
        const b = this.variables[this.index(instruction.operands[1])] ?? 0;
        return skipIf(a >= b);
      }
      case 'IF_VAR_GE': {
        const a = this.variables[this.index(instruction.operands[0])] ?? 0;
        const b = this.variables[this.index(instruction.operands[1])] ?? 0;
        return skipIf(a <= b);
      }

      /**
       * The MIDI opcodes (`vc69`–`vc72`), counted rather than played.
       *
       * `PLAY_SEQ` starts a track, `JOIN_SEQ` queues the next, and `SEQUE`
       * plays or stops one — all through the reference's music player, which
       * this headless machine has no mixer for. So each is counted, and
       * `IF_SEQ_WAITING` reads the other end: it skips the next instruction
       * when no track is playing, and with no player nothing ever is, so it
       * always skips. See {@link midiRequests}.
       */
      case 'PLAY_SEQ':
      case 'JOIN_SEQ':
      case 'SEQUE':
        this.midiRequests += 1;
        return NEXT;
      case 'IF_SEQ_WAITING':
        return SKIP;

      /**
       * The two mark opcodes, `bb` in every Version that has them.
       *
       * A mark is how the drawing bytecode tells a *game* script an animation
       * has reached a moment: `os2_waitMark` blocks until the bit is on. The
       * bit is the **second** operand — the first is always zero across every
       * zone script, a channel the reference does not use here — and the mark
       * goes through the seam so a script waiting in another zone sees it.
       */
      case 'SET_MARK':
        this.host.setMark(operand(1));
        return NEXT;
      case 'CLEAR_MARK':
        this.host.clearMark(operand(1));
        return NEXT;

      // Sound and hit areas, all of which belong to something outside a
      // renderer and are asked for through the seam.
      case 'PLAY_SOUND':
        this.host.playSound(operand(0), operand(1), operand(2), operand(3));
        return NEXT;
      case 'PLAY_EFFECT':
        this.host.playEffect(operand(0));
        return NEXT;
      case 'ENABLE_BOX':
        this.host.enableBox(operand(0));
        return NEXT;
      case 'MOVE_BOX':
        this.host.moveBox(operand(0), operand(1), operand(2));
        return NEXT;
      case 'SET_WINDOW_IMAGE':
        this.host.setWindowImage(operand(1), operand(0));
        return NEXT;
      case 'SET_PATHFIND_ITEM': {
        const points = instruction.operands[1];
        this.host.setPathfindItem(operand(0), points?.kind === 'pairs' ? points.values : []);
        return NEXT;
      }
      case 'COMPUTE_YOFS':
        this.host.computePathfinder();
        return NEXT;

      default:
        this.unimplemented.add(instruction.name);
        return NEXT;
    }
  }

  /**
   * Draws one image.
   *
   * The operand order is the reference's: image, then a palette byte that is
   * read from the second byte of a word, then x, y, and flags. Compressed,
   * masked, flipped and scaled images are named gaps rather than wrong output.
   */
  /**
   * Draws every sprite from its own fields, once.
   *
   * `AGOSEngine::animateSprites` in the reference, and the half of the renderer
   * that was missing rather than wrong. A VGA script does not draw: it sets a
   * sprite's cel, position, palette bank and flags, and something else has to
   * put the sprite on screen every frame. Without this pass a machine could run
   * a game's whole opening — 700 instructions, seventeen sprites, two palette
   * changes — and leave the framebuffer untouched, which is exactly what it did.
   *
   * **In priority order, low first**, which is AGOS's z-order: `SET_PRIORITY`
   * is the only depth control the language has, and a later sprite with a lower
   * priority belongs behind an earlier one. Sorted here rather than by keeping
   * the list ordered, because a script changes a priority mid-frame and a list
   * re-sorted on every change costs more than one sort per frame.
   *
   * A sprite showing image zero is skipped rather than drawn, which is the
   * reference's first line: zero is "showing nothing" and not entry zero.
   */
  paintSprites(): void {
    paintZoneSprites([this]);
  }

  /**
   * Draws one of this machine's sprites, through this machine's resources.
   *
   * Separate from {@link paintSprites} because the order sprites are drawn in
   * is decided across zones and the pixels they are drawn from are not: a
   * sprite's cel comes out of *its own* zone's resource, and the palette bank,
   * window and scroll it is drawn under are its own machine's too.
   */
  paintSprite(sprite: VgaSprite): void {
    if (sprite.image === 0) return;
    this.paint(sprite.image, sprite.palette, sprite.x, sprite.y, sprite.flags);
  }

  private draw(instruction: VgaInstruction): void {
    this.paint(
      this.imageOperand(instruction.operands[0]),
      this.value(instruction.operands[1]),
      this.value(instruction.operands[2]),
      this.value(instruction.operands[3]),
      this.value(instruction.operands[4]),
    );
  }

  /**
   * Puts one cel on the screen.
   *
   * Shared by the `DRAW` opcode and by {@link paintSprites}, because they are
   * the same operation reached two ways: a script drawing directly, and the
   * frame pass drawing what the scripts have set up.
   */
  private paint(image: number, palette: number, x: number, y: number, flags: number): void {
    let entry: VgaImageEntry | null;
    try {
      entry = readVgaImageEntry(this.pixels, image);
    } catch {
      this.unimplemented.add(`DRAW:image ${image} has no entry`);
      return;
    }
    if (!entry || entry.width === 0 || entry.height === 0) return;

    // A backdrop wider than the screen is stored and drawn unlike any other
    // cel: a table of per-column offsets into column-wise runs, cut to the
    // scroll window rather than blitted whole. `horizontalScroll` is Simon 2's
    // path (and The Feeble Files', which this does not yet reach); its width
    // gate is twenty sixteen-pixel units, i.e. 320 pixels.
    if (this.table === 'simon2' && entry.width > 320) {
      this.paintWideBackdrop(entry, x, y);
      return;
    }

    // **The entry's own high bit says the pixels are compressed**, and the
    // script's flags do not always say so. `drawImage_init` folds one into the
    // other: a compressed entry becomes `compressedFlip` where the script asked
    // for a flip and `compressed` otherwise. Without this an entry whose pixels
    // are run-length coded is read as raw nibbles and comes out as noise.
    if (isCompressedEntry(entry.flags) && (flags & DRAW_FLAGS.compressedFlip) === 0) {
      if ((flags & DRAW_FLAGS.flip) !== 0) {
        flags = (flags & ~DRAW_FLAGS.flip) | DRAW_FLAGS.compressedFlip;
      } else {
        flags |= DRAW_FLAGS.compressed;
      }
    }

    const compressed = (flags & (DRAW_FLAGS.compressed | DRAW_FLAGS.compressedFlip)) !== 0;
    const masked = (flags & DRAW_FLAGS.masked) !== 0;
    if (masked && !this.target.background) {
      // Nothing to reveal. Saying so beats painting the stencil, which would
      // put a solid silhouette on screen where a character should have
      // reappeared from behind scenery.
      this.unimplementedFlags.add('masked (no background surface)');
      return;
    }

    for (const [name, bit] of Object.entries(DRAW_FLAGS)) {
      if (name === 'opaque' || name === 'compressed') continue;
      // Flipping is handled, in both the plain and the compressed spelling.
      if (name === 'flip' || name === 'compressedFlip') continue;
      if (name === 'masked' && this.target.background) continue;
      if (flags & bit) this.unimplementedFlags.add(name);
    }

    const opaque = (flags & DRAW_FLAGS.opaque) !== 0;
    // How much bigger or smaller this actor is at this depth. 1 when no script
    // has set a scale, which is every Version but The Feeble Files.
    const factor = this.scaleFactorAt(y);
    // A compressed image's bytes are fewer than what they expand to, and its
    // runs cross column boundaries, so the decoder is given the rest of the
    // resource and stops when the image is full.
    const source = compressed
      ? this.pixels.subarray(entry.offset)
      : this.pixels.subarray(entry.offset, entry.offset + entry.widthBytes * entry.height);
    /**
     * Simon 1's backdrops are five bits a pixel, not four.
     *
     * The choice is the caller's situation rather than anything in the entry:
     * a draw inside `setWindowImage` at palette bank zero is a backdrop, and
     * everything else is a sprite. `decode32ColourSprite` carries why.
     */
    const packed32 = this.windowImageMode && palette === 0;
    const decoded = packed32
      ? decode32ColourSprite(source, entry.width, entry.height, { opaque, compressed })
      : compressed
        ? decodeCompressedSprite(source, entry.widthBytes, entry.height, { opaque })
        : decodeSprite(source, entry.widthBytes, entry.height, { opaque });
    const bitmap = factor === 1 ? decoded : scaleBitmap(decoded, factor);

    // The palette operand selects a sixteen-colour bank, which is why a cel's
    // four-bit pixels can address 256 colours on screen.
    const bank = palette * 16;
    const flip = (flags & (DRAW_FLAGS.flip | DRAW_FLAGS.compressedFlip)) !== 0;
    /**
     * Where drawing is allowed, and where this draw starts.
     *
     * **Three different units meet here**, which is why the arithmetic is
     * spelled out rather than inlined:
     *
     * - a window's `x` and `width` are in **sixteens of pixels**
     * - a draw's `x` is in **eights of pixels**
     * - `y` is in pixels in both
     *
     * The reference writes the same thing as `(vlut[0] * 2 + state->x) * 8`.
     * Taking a draw's `x` for pixels — which this did — squeezes a 320-pixel
     * screen into its leftmost forty, and that is exactly what Simon 1's title
     * screen looked like: the right picture, an eighth as wide, stacked up the
     * left-hand edge.
     *
     * A script that has set no window draws to the whole screen, which is the
     * degenerate case rather than a special one.
     */
    const window = this.windows.get(this.currentWindow);
    const clipX = window ? window[0] * 16 : 0;
    const clipY = window ? window[1] : 0;
    const clipWidth = window ? window[2] * 16 : this.target.width;
    const clipHeight = window ? window[3] : this.target.height;

    const offsetX = factor === 1 ? 0 : (this.scaleOffset?.x ?? 0);
    const offsetY = factor === 1 ? 0 : (this.scaleOffset?.y ?? 0);
    // The scroll shift the reference writes as `state.x = x - _scrollX`: every
    // cel in a scrolling room, sprites included, slides left with the room.
    // Zero outside a scrolling room, where the interface — drawn elsewhere,
    // not through here — must not move.
    const originX = clipX + (x - this.scrollX) * 8;
    const originY = clipY + y;

    for (let row = 0; row < bitmap.height; row += 1) {
      const targetRow = originY + offsetY + row;
      if (targetRow < clipY || targetRow >= clipY + clipHeight) continue;
      if (targetRow < 0 || targetRow >= this.target.height) continue;
      for (let column = 0; column < bitmap.width; column += 1) {
        const targetColumn = originX + offsetX + (flip ? bitmap.width - 1 - column : column);
        if (targetColumn < clipX || targetColumn >= clipX + clipWidth) continue;
        if (targetColumn < 0 || targetColumn >= this.target.width) continue;
        const colour = bitmap.pixels[row * bitmap.width + column] ?? 0;
        if (colour === 0 && (flags & DRAW_FLAGS.opaque) === 0) continue;

        const at = targetRow * this.target.width + targetColumn;
        // A masked draw takes the *shape* from the image and the *colour* from
        // the scene behind, which is how a character reappears from behind
        // scenery it walked in front of.
        // A thirty-two colour backdrop indexes the palette directly; a sprite's
        // four-bit pixel picks a colour inside the bank its sprite named.
        this.target.pixels[at] = masked
          ? (this.target.background?.[at] ?? 0)
          : packed32
            ? colour
            : colour | bank;
      }
    }
    this.drawn += 1;
  }

  /**
   * Draws a room wider than the screen, scrolled to the current offset.
   *
   * The reference's `horizontalScroll`: a wide cel is a table of column offsets
   * over column-wise runs, not the row-major nibbles every other cel is, so it
   * takes its own decode ({@link decodeWideImage}) rather than the branch above.
   * The whole room is decoded once and kept in {@link VgaMachine.wideBackdrop},
   * because the Engine re-cuts the visible window every time the scroll moves
   * without paying for the decode again. `_scrollXMax = width * 2 - 40` with
   * width in sixteens of a pixel is `width / 8 - 40` from the pixel width.
   */
  private paintWideBackdrop(entry: VgaImageEntry, x: number, y: number): void {
    this.scrollXMax = Math.floor(entry.width / 8) - 40;
    const bitmap = decodeWideImage(this.pixels, entry.offset, entry.width, entry.height, readU32BE);
    const window = this.windows.get(this.currentWindow);
    const backdrop: WideBackdrop = {
      bitmap,
      originY: (window ? window[1] : 0) + y,
      clipX: window ? window[0] * 16 : 0,
      clipY: window ? window[1] : 0,
      clipWidth: window ? window[2] * 16 : this.target.width,
      clipHeight: window ? window[3] : this.target.height,
    };
    this.wideBackdrop = backdrop;

    // The reference reads the wide cel's own `x` as the room's *entry* scroll:
    // `state.x = x - _scrollX` then `_scrollX = state.x`, so on entry (scroll
    // reset to zero) the room opens at column `x` — variable 34 negative keeps
    // the previous scroll instead. The value is clamped and mirrored into
    // variable 251, the scroll the rest of the engine reads.
    const keepScroll = (this.variables[34] ?? 0) < 0;
    const initial = keepScroll ? this.scrollX : x;
    const scrollX = Math.max(0, Math.min(this.scrollXMax, initial));
    this.variables[251] = scrollX;

    blitWideBackdrop(this.target.pixels, this.target.width, this.target.height, backdrop, scrollX);
    this.drawn += 1;
  }
}

/**
 * Nearest-neighbour scaling.
 *
 * Nearest-neighbour rather than anything smoother because the original does
 * the same and because a four-bit palette has no in-between colours to
 * interpolate towards: blending two palette indices produces a third index
 * that is a different colour entirely, not a mixture of the two.
 */
function scaleBitmap(source: IndexedBitmap, factor: number): IndexedBitmap {
  const width = Math.max(1, Math.round(source.width * factor));
  const height = Math.max(1, Math.round(source.height * factor));
  const pixels = new Uint8Array(width * height);

  for (let row = 0; row < height; row += 1) {
    const sourceRow = Math.min(source.height - 1, Math.floor(row / factor));
    for (let column = 0; column < width; column += 1) {
      const sourceColumn = Math.min(source.width - 1, Math.floor(column / factor));
      pixels[row * width + column] = source.pixels[sourceRow * source.width + sourceColumn] ?? 0;
    }
  }
  return { width, height, pixels };
}
