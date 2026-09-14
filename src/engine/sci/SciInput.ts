/**
 * SCI's input: a queue, not a dispatch.
 *
 * ADR 0011 kept input out of the host seam because a verb bar and a typed
 * parser "do not differ by degree", and SCI contains both — parser-driven at
 * SCI0, icon-bar-driven at SCI1. It costs nothing, because **SCI moved the UI
 * into the game**: the icon bar is a class the shipped scripts build, the input
 * window is a control the game creates, and the parse is a Kernel call over the
 * game's own `vocab.000`. So this exposes keyboard and pointer events and
 * nothing else.
 *
 * **What it does need is the queue.** SCI scripts poll: `kGetEvent` takes a
 * type mask and consumes the next matching event. Dispatching events as they
 * arrive rather than buffering them with their masks and timestamps loses input
 * in a way that never errors and is very hard to trace back — a click that
 * arrives while the scripts are asking only for keys is simply gone.
 */

import type { EngineInput, InputSurface } from '../AdventureEngine.js';

/**
 * The event type bits, as SCI's own scripts write them.
 *
 * A mask rather than an enum because that is how `kGetEvent` is called: a
 * script asks for "a key or a mouse-down" in one call, and the interpreter
 * returns the oldest event matching either.
 */
export const SCI_EVENT = {
  none: 0x0000,
  mouseDown: 0x0001,
  mouseUp: 0x0002,
  keyDown: 0x0004,
  keyUp: 0x0008,
  /**
   * **SCI32 numbers a direction event differently from SCI16.** ScummVM keeps
   * both — `kSciEventDirection32` at bit 4 and `kSciEventDirection16` at bit 6
   * — because the same idea moved bits between the two, and a game asking for
   * one with the other's mask is handed nothing.
   */
  direction32: 0x0010,
  direction16: 0x0040,
  /** Kept under its old name so existing callers still read. */
  movement: 0x0040,
  saidSomething: 0x0080,
  hotRectangle: 0x0400,
  /**
   * **Bit eleven, not bit twelve.** ScummVM's `kSciEventQuit` is `1 << 11`;
   * this said `0x1000`, which is bit twelve and belongs to no SCI event at all.
   * A wrong bit here is not inert — King's Quest VII's own exits branch on
   * `type & 0x1000`, so an engine that can set that bit is an engine that can
   * send a game down a path it never meant to take.
   */
  quit: 0x0800,
  peek: 0x8000,
} as const;

export interface SciEvent {
  type: number;
  /** Character or key code, for a key event. */
  message: number;
  /** Shift, control and alt, as SCI's own bits. */
  modifiers: number;
  x: number;
  y: number;
  /** Milliseconds since the engine started, for a script that measures. */
  time: number;
}

/** SCI's modifier bits, which a script reads directly. */
export const SCI_MOD = { shift: 0x03, ctrl: 0x04, alt: 0x08 } as const;

export class SciInput implements EngineInput {
  private surface: InputSurface | null = null;
  private readonly queue: SciEvent[] = [];
  private readonly started = Date.now();

  /** Where the pointer is now, which `kGetEvent` reports even with no event. */
  mouseX = 0;
  mouseY = 0;
  /** Buttons currently held, which some scripts poll rather than await. */
  buttons = 0;

  /**
   * The framebuffer's size, when it is not the size the scripts think in.
   *
   * **A SCI script has only ever seen one coordinate space, and it is not the
   * screen's.** SCI16 draws 320x200 and its scripts speak 320x200, so the two
   * were the same number and nothing here had to say which. SCI32 composites to
   * 640x480 and its scripts still speak 320x200 — so a click delivered in
   * framebuffer pixels arrives at `IsOnMe` as a point twice as far right and
   * nearly two and a half times as far down as the player aimed.
   *
   * What that costs is every mouse-driven interface in every SCI32 game:
   * King's Quest VII's menu is in the top-left quarter of its own screen, and
   * a click on "Start New Game" was reported in the empty sky below it.
   *
   * Null while the two spaces agree, which is every SCI16 game, and the
   * conversion is skipped entirely there.
   */
  displaySize: { width: number; height: number } | null = null;
  /** The space the scripts think in, which is 320x200 for every SCI game. */
  scriptSize: { width: number; height: number } | null = null;

  /**
   * A **framebuffer** point in the coordinates a script will compare it
   * against, for the callers that have one.
   *
   * Only `post` and `moveTo` need this. A browser's click has already been
   * mapped into the script's space by `InputSurface.toScreen` before it gets
   * here, and mapping it twice is how every hotspot in every SCI32 game came to
   * be half a screen away from where it was drawn.
   */
  private toScript(x: number, y: number): { x: number; y: number } {
    const display = this.displaySize;
    const script = this.scriptSize;
    if (!display || !script) return { x, y };
    if (display.width === script.width && display.height === script.height) return { x, y };
    return {
      x: Math.round((x * script.width) / display.width),
      y: Math.round((y * script.height) / display.height),
    };
  }

  private readonly onPointerDown = (event: PointerEvent): void => this.pointer(event, 'down');
  private readonly onPointerUp = (event: PointerEvent): void => this.pointer(event, 'up');
  private readonly onPointerMove = (event: PointerEvent): void => this.pointer(event, 'move');
  private readonly onKeyDown = (event: KeyboardEvent): void => this.key(event);

  attach(surface: InputSurface): void {
    this.detach();
    this.surface = surface;
    surface.canvas.addEventListener('pointerdown', this.onPointerDown);
    surface.canvas.addEventListener('pointerup', this.onPointerUp);
    surface.canvas.addEventListener('pointermove', this.onPointerMove);
    surface.keys.addEventListener('keydown', this.onKeyDown as EventListener);
  }

  detach(): void {
    const surface = this.surface;
    if (!surface) return;
    surface.canvas.removeEventListener('pointerdown', this.onPointerDown);
    surface.canvas.removeEventListener('pointerup', this.onPointerUp);
    surface.canvas.removeEventListener('pointermove', this.onPointerMove);
    surface.keys.removeEventListener('keydown', this.onKeyDown as EventListener);
    this.surface = null;
  }

  private pointer(event: PointerEvent, kind: 'down' | 'up' | 'move'): void {
    const surface = this.surface;
    if (!surface) return;
    // **Not converted here: `InputSurface.toScreen` already answers in the
    // script's space.** `main.ts` maps a client point through
    // `engine.resolution.script` and says so where it does it, for exactly the
    // reason this class cares about — "a SCI2 game draws at 640x480 and thinks
    // at 320x200". Converting again halved every coordinate: a click on King's
    // Quest VII's menu at script (117, 88) arrived as (58, 36) and missed
    // everything, with nothing reporting a fault.
    const { x, y } = surface.toScreen(event);
    this.mouseX = x;
    this.mouseY = y;

    if (kind === 'move') return;
    if (kind === 'down') {
      this.buttons = 1;
      surface.resumeSound();
    } else {
      this.buttons = 0;
    }
    this.push({
      type: kind === 'down' ? SCI_EVENT.mouseDown : SCI_EVENT.mouseUp,
      message: 0,
      modifiers: modifiersOf(event),
      x,
      y,
      time: Date.now() - this.started,
    });
  }

  private key(event: KeyboardEvent): void {
    const message = sciKeyCode(event);
    if (message === null) return;
    event.preventDefault();
    this.surface?.resumeSound();
    this.push({
      type: SCI_EVENT.keyDown,
      message,
      modifiers: modifiersOf(event),
      x: this.mouseX,
      y: this.mouseY,
      time: Date.now() - this.started,
    });
  }

  /**
   * Buffered rather than dispatched, and bounded.
   *
   * The bound matters for the same reason the queue does: a game that has
   * stopped polling should not grow an unbounded backlog that is then delivered
   * in a burst when it starts again. Oldest goes, because the newest keystroke
   * is the one the player still means.
   */
  private push(event: SciEvent): void {
    this.queue.push(event);
    while (this.queue.length > 32) this.queue.shift();
  }

  /**
   * Puts an event on the queue without a DOM event behind it.
   *
   * The browser reaches this class through `attach`, and a diagnostic has no
   * canvas to attach to. Everything that makes the queue worth having — the
   * type masks, the timestamps, the bound, the ordering — is in `push`, so a
   * headless run that built its own array would be exercising a different queue
   * from the one a player uses and proving nothing about it.
   *
   * `npm run diagnose:sci -- <game> --play` is the caller.
   */
  /**
   * Moves the pointer without queueing anything, which is what a real move is.
   *
   * **A mouse move is not an event in SCI and must not become one.** The queue
   * is bounded at 32 and a script that never asks for movement would let moves
   * push every click out of it; Sierra's interpreter reported the pointer's
   * position through `kGetEvent`'s x and y instead, whether or not there was an
   * event to go with them. `pointer(event, 'move')` already does exactly this
   * for a browser, and this is the same thing for a caller with no canvas —
   * `npm run diagnose:sci -- <game> --play`, which cannot exercise a hover
   * otherwise.
   */
  moveTo(x: number, y: number): void {
    const at = this.toScript(x, y);
    this.mouseX = at.x;
    this.mouseY = at.y;
  }

  post(event: Omit<SciEvent, 'time'>): void {
    if (event.type === SCI_EVENT.mouseDown) this.buttons = 1;
    if (event.type === SCI_EVENT.mouseUp) this.buttons = 0;
    // **Converted here and not in `pointer`, because the two callers speak
    // different spaces and that is the point.** A browser arrives through
    // `InputSurface.toScreen`, which has already mapped the click into the
    // script's space. A diagnostic has no surface and aims at the framebuffer
    // a person is looking at in a PNG — so it passes display pixels and they
    // are mapped here.
    const { x, y } = this.toScript(event.x, event.y);
    this.mouseX = x;
    this.mouseY = y;
    this.push({ ...event, x, y, time: Date.now() - this.started });
  }

  /**
   * The oldest event matching `mask`, removed from the queue.
   *
   * `SCI_EVENT.peek` leaves it there, which is how a script tests for an event
   * it is not ready to handle.
   */
  next(mask: number): SciEvent | null {
    const peek = (mask & SCI_EVENT.peek) !== 0;
    const wanted = mask & ~SCI_EVENT.peek;
    for (let i = 0; i < this.queue.length; i++) {
      if ((this.queue[i].type & wanted) === 0) continue;
      const event = this.queue[i];
      if (!peek) this.queue.splice(i, 1);
      return event;
    }
    return null;
  }

  /** For the diagnostic: how much input is waiting and of what kinds. */
  describe(): string {
    if (this.queue.length === 0) return 'no events queued';
    return `${this.queue.length} events queued (${this.queue.map((e) => e.type).join(', ')})`;
  }

  /** Dropped on a room change the way Sierra's own interpreter did. */
  clear(): void {
    this.queue.length = 0;
  }
}

function modifiersOf(event: { shiftKey: boolean; ctrlKey: boolean; altKey: boolean }): number {
  let modifiers = 0;
  if (event.shiftKey) modifiers |= SCI_MOD.shift;
  if (event.ctrlKey) modifiers |= SCI_MOD.ctrl;
  if (event.altKey) modifiers |= SCI_MOD.alt;
  return modifiers;
}

/**
 * A DOM key event as SCI's own key code.
 *
 * SCI uses the IBM PC's codes: ASCII for printable keys, and the scan code in
 * the high byte with zero low for the function and arrow keys. Returns null for
 * a key the game has no code for, so a browser shortcut is not swallowed.
 */
export function sciKeyCode(event: KeyboardEvent): number | null {
  const named: Record<string, number> = {
    Enter: 13,
    Escape: 27,
    Backspace: 8,
    Tab: 9,
    ' ': 32,
    ArrowUp: 0x4800,
    ArrowDown: 0x5000,
    ArrowLeft: 0x4b00,
    ArrowRight: 0x4d00,
    Home: 0x4700,
    End: 0x4f00,
    PageUp: 0x4900,
    PageDown: 0x5100,
    Insert: 0x5200,
    Delete: 0x5300,
  };
  if (event.key in named) return named[event.key];

  const fn = /^F(\d{1,2})$/.exec(event.key);
  if (fn) {
    const number = Number(fn[1]);
    if (number >= 1 && number <= 10) return (0x3b + number - 1) << 8;
  }

  if (event.key.length === 1) {
    const code = event.key.charCodeAt(0);
    if (event.ctrlKey && code >= 97 && code <= 122) return code - 96;
    return code;
  }
  return null;
}
