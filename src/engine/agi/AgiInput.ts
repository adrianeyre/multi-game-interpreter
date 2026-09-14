/**
 * AGI's input: a line the player types, and the keys a script binds.
 *
 * Its own object rather than members on `AdventureEngine`, because a verb bar
 * and a typed parser do not "differ by degree in a way one model can hold" —
 * ADR 0007's test for generalise-versus-separate, read the other way (ADR 0011).
 * SCUMM needs no text entry at all.
 *
 * **The accessibility decision is the substance of this file.** A visually
 * hidden `<input>` owns the text and the focus, so screen readers, IME,
 * autocomplete and the mobile on-screen keyboard all work — and the engine
 * draws the authentic input line into the 320x200 framebuffer from that value.
 * One source of truth, authentic pixels, accessible mechanics.
 *
 * Rejected (#130): raw `keydown` with framebuffer-only rendering, which is
 * unusable on mobile, invisible to assistive technology and hostile to an IME —
 * and this app installs as a PWA, so a phone is a first-class way to play it.
 * Also rejected: a visible `<input>` below the canvas, because games position
 * text around the input line and the screen looks wrong without it there.
 */

import type { EngineInput, InputSurface } from '../AdventureEngine.js';

/** What the engine needs to know about what the player did. */
export interface AgiInputSink {
  /** A line was submitted. The engine parses it against the vocabulary. */
  submitLine(text: string): void;
  /** A key was pressed, for `have.key`, `set.key` and window dismissal. */
  pressKey(code: number, name: string): void;
  /** Ego's direction from the arrow keys, 0 to 8, or null for no change. */
  setDirection(direction: number): void;
  /** Whether the engine is accepting typed input at all right now. */
  acceptsInput(): boolean;
}

/**
 * Arrow and numeric-keypad directions, in AGI's own numbering.
 *
 * The keypad matters as much as the arrows: AGI games were played on it, and
 * the diagonals are only reachable there — a player with no diagonal keys
 * cannot walk diagonally, which some rooms need.
 */
const DIRECTION_KEYS: Record<string, number> = {
  ArrowUp: 1,
  ArrowRight: 3,
  ArrowDown: 5,
  ArrowLeft: 7,
  Numpad8: 1,
  Numpad9: 2,
  Numpad6: 3,
  Numpad3: 4,
  Numpad2: 5,
  Numpad1: 6,
  Numpad4: 7,
  Numpad7: 8,
  Numpad5: 0,
};

export class AgiInput implements EngineInput {
  private readonly sink: AgiInputSink;
  private teardown: Array<() => void> = [];
  private field: HTMLInputElement | null = null;
  /** Set when this object created the field, so `detach` only removes its own. */
  private ownsField = false;

  constructor(sink: AgiInputSink) {
    this.sink = sink;
  }

  /** The text the player has typed so far, which the engine draws. */
  get text(): string {
    return this.field?.value ?? '';
  }

  /**
   * Where the caret is, so the drawn line can put a cursor in the same place.
   *
   * Read from the field rather than tracked, which is the whole point of the
   * field being the only place text state lives: a second copy would drift the
   * first time an IME composed a character or the player pasted.
   */
  get caret(): number {
    return this.field?.selectionStart ?? this.text.length;
  }

  clear(): void {
    if (this.field) this.field.value = '';
  }

  attach(surface: InputSurface): void {
    this.detach();

    const field = this.createField(surface.overlay);
    this.field = field;

    const on = <E extends Event>(
      target: EventTarget,
      type: string,
      handler: (event: E) => void,
    ): void => {
      const listener = handler as EventListener;
      target.addEventListener(type, listener);
      this.teardown.push(() => target.removeEventListener(type, listener));
    };

    // Enter submits the line. Handled on the field rather than on the window,
    // so a screen reader user pressing Enter in the field gets the behaviour
    // the field advertises.
    on<KeyboardEvent>(field, 'keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        const line = field.value;
        field.value = '';
        this.sink.submitLine(line);
        return;
      }

      const direction = DIRECTION_KEYS[event.code] ?? DIRECTION_KEYS[event.key];
      if (direction !== undefined) {
        // Arrow keys move ego rather than the caret while a game is running,
        // which is what an AGI player expects — and the field is empty most of
        // the time, so there is no caret to move.
        event.preventDefault();
        this.sink.setDirection(direction);
        return;
      }

      // Everything else reaches the game as a key press *as well as* going into
      // the field. A script that bound a key with `set.key` expects it whether
      // or not the player is mid-word.
      this.sink.pressKey(keyCodeFor(event), event.key);
    });

    // Clicking the canvas focuses the field, so typing works without the
    // player having to find an invisible element first.
    on(surface.canvas, 'pointerdown', () => {
      surface.resumeSound();
      field.focus();
    });

    // A key pressed anywhere else moves focus into the field and lets the
    // character through, so a player who clicked outside the canvas is not
    // silently typing into nothing.
    on<KeyboardEvent>(surface.keys, 'keydown', (event) => {
      if (event.target === field) return;
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) field.focus();
    });

    field.focus();
  }

  /**
   * The hidden field: visually gone, and present to everything else.
   *
   * Deliberately not `display: none` or `visibility: hidden`, either of which
   * would take it out of the accessibility tree and out of reach of the mobile
   * keyboard — which is the whole thing this is for. The clip-rect technique
   * keeps it focusable, announced and typed into while occupying no space.
   */
  private createField(overlay: HTMLElement): HTMLInputElement {
    const existing = overlay.querySelector<HTMLInputElement>('.agi-parser-input');
    if (existing) {
      this.ownsField = false;
      return existing;
    }

    const field = document.createElement('input');
    field.type = 'text';
    field.className = 'agi-parser-input';
    field.autocomplete = 'off';
    field.spellcheck = false;
    // Announced as what it is, because a screen reader user has no picture to
    // read: the drawn line is pixels.
    field.setAttribute('aria-label', 'Type what you want to do, then press Enter');
    field.setAttribute('enterkeyhint', 'go');
    field.style.cssText =
      'position:absolute;width:1px;height:1px;margin:-1px;padding:0;' +
      'overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;' +
      'border:0;';

    overlay.appendChild(field);
    this.ownsField = true;
    return field;
  }

  detach(): void {
    for (const remove of this.teardown) remove();
    this.teardown = [];
    if (this.ownsField) this.field?.remove();
    this.field = null;
    this.ownsField = false;
  }
}

/**
 * A key as AGI numbered them: ASCII in the low byte, a scan code in the high.
 *
 * `set.key` binds both halves, so a game binding F1 and a game binding "q" both
 * work — and a game that bound a scan code would never fire if only ASCII were
 * reported.
 */
export function keyCodeFor(event: KeyboardEvent): number {
  if (event.key.length === 1) return event.key.charCodeAt(0);

  switch (event.key) {
    case 'Enter':
      return 13;
    case 'Escape':
      return 27;
    case 'Backspace':
      return 8;
    case 'Tab':
      return 9;
    // The function keys, as scan codes in the high byte with no ASCII value —
    // which is exactly how AGI's own key table holds them.
    case 'F1':
      return 0x3b00;
    case 'F2':
      return 0x3c00;
    case 'F3':
      return 0x3d00;
    case 'F4':
      return 0x3e00;
    case 'F5':
      return 0x3f00;
    case 'F6':
      return 0x4000;
    case 'F7':
      return 0x4100;
    case 'F8':
      return 0x4200;
    case 'F9':
      return 0x4300;
    case 'F10':
      return 0x4400;
    default:
      return 0;
  }
}
