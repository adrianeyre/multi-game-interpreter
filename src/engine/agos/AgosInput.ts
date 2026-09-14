/**
 * AGOS's input surface.
 *
 * ADR 0011 kept input out of the shared host seam because "a verb bar and a
 * typed parser do not differ by degree", and AGOS is where that decision earns
 * its keep a second time: this one family holds *three* interfaces that do not
 * differ by degree from each other — Elvira and Waxworks are menu-driven and
 * first-person, Simon 1 and 2 use a verb list and an inventory grid in a bottom
 * band, and The Feeble Files uses neither.
 *
 * They are surfaces inside the AGOS Engine rather than branches in the shell,
 * which is why the shell still only hands over a canvas and gets events back.
 *
 * ## The hit test needs no drawn interface
 *
 * That was the expectation and it was wrong, which is worth recording because
 * it made this look blocked on the renderer. **AGOS's interface is data**: the
 * verb list, the inventory grid and every clickable thing in a room are boxes
 * the game's own Subroutines define with `o_addBox`, each carrying the verb it
 * means and the item it refers to (`../world/hitAreas.ts`).
 *
 * So a click is resolved by asking the box table, not by knowing where anything
 * was drawn — and the same operation serves all three of the family's
 * interfaces, because what differs between them is what their scripts define.
 */

import type { EngineInput, InputSurface } from '../AdventureEngine.js';

/** `PointerEvent.button` for the right button, which AGOS uses to skip speech. */
const RIGHT_BUTTON = 2;

/**
 * Where the keyboard cursor is, for the interfaces that are boxes.
 *
 * `docs/accessibility.md` treats a pointer-only interaction as a defect rather
 * than a limitation, and AGOS makes the fix cheap for the same reason it made
 * hit-testing cheap: the interface is a list of boxes the game defined, so
 * "the next control" is a well-defined thing without anybody laying out a
 * focus order by hand.
 */
export interface KeyboardCursor {
  /** The boxes a keyboard user can reach, in the order the game defined them. */
  readonly targets: readonly { id: number; verb: number; item: number }[];
  index: number;
}

/** What the engine wants to be told about. */
export interface AgosInputSink {
  /** A verb was chosen, with the item it was pointed at. */
  verb(verb: number, noun1: number, noun2: number): void;
  /** The screen was clicked, in the game's own coordinates. */
  click(x: number, y: number): void;
  /** A key was pressed, for the interfaces that read them. */
  key(key: string): void;
  /**
   * The right button was pressed, which in this family is not a second click.
   *
   * AGOS gives it one job — cutting a line of speech short — and it is not a
   * command at a position, so it carries none. Reported separately rather than
   * as a flag on {@link click} because the two do not go to the same place: a
   * left click is resolved against the box table, and this reaches a script
   * that is already blocked.
   */
  rightClick(): void;
}

export class AgosInput implements EngineInput {
  private teardown: Array<() => void> = [];

  constructor(private readonly sink: AgosInputSink) {}

  attach(surface: InputSurface): void {
    /**
     * **Keys go to `surface.keys`, not to the canvas.**
     *
     * `InputSurface` says why in its own words — the window, "so a keystroke
     * reaches the game without the canvas having to hold focus" — and this
     * listened on the canvas, which never holds it. Nothing errored and nothing
     * arrived: every key a player pressed went to the document, so Escape could
     * not skip a sequence and the keyboard cursor over the game's boxes could
     * not be moved at all. AGI and SCI both use `keys`; this was the odd one
     * out.
     */
    const onKey = (event: KeyboardEvent): void => this.sink.key(event.key);
    surface.keys.addEventListener('keydown', onKey as EventListener);
    this.teardown.push(() => surface.keys.removeEventListener('keydown', onKey as EventListener));

    const onPointer = (event: Event): void => {
      const pointer = event as PointerEvent;
      // The gesture browsers require before audio may start. Every other
      // family's input does this and AGOS did not, so a game loaded and
      // played in silence until something else in the shell happened to ask.
      surface.resumeSound();
      // `button` is 2 for the right button on a mouse, and is 0 for a touch or
      // a pen — so a tap is a left click, which is what it should be.
      if (pointer.button === RIGHT_BUTTON) {
        this.sink.rightClick();
        return;
      }
      const point = surface.toScreen(pointer);
      this.sink.click(point.x, point.y);
    };
    surface.canvas.addEventListener('pointerdown', onPointer);
    this.teardown.push(() => surface.canvas.removeEventListener('pointerdown', onPointer));

    // Without this the right button opens the browser's menu over the game and
    // the player never sees what it did, which makes a working control look
    // broken.
    const onContextMenu = (event: Event): void => event.preventDefault();
    surface.canvas.addEventListener('contextmenu', onContextMenu);
    this.teardown.push(() => surface.canvas.removeEventListener('contextmenu', onContextMenu));
  }

  detach(): void {
    for (const undo of this.teardown) undo();
    this.teardown = [];
  }

  /**
   * Moves the keyboard cursor and activates boxes without a pointer.
   *
   * Arrow keys and Tab move; Enter and Space activate. Returns true when the
   * key was one of those, so the caller can leave the rest to the game.
   */
  handleKey(key: string, cursor: KeyboardCursor): boolean {
    if (cursor.targets.length === 0) return false;

    if (key === 'ArrowDown' || key === 'ArrowRight' || key === 'Tab') {
      cursor.index = (cursor.index + 1) % cursor.targets.length;
      return true;
    }
    if (key === 'ArrowUp' || key === 'ArrowLeft') {
      cursor.index = (cursor.index + cursor.targets.length - 1) % cursor.targets.length;
      return true;
    }
    if (key === 'Enter' || key === ' ') {
      const target = cursor.targets[cursor.index];
      if (target) this.sink.verb(target.verb, target.item, -1);
      return true;
    }
    return false;
  }

  /**
   * Sends a verb straight through, for callers that already know one.
   *
   * The route a test and a future hit-test both use, so that the hit-test when
   * it arrives has somewhere to arrive rather than becoming a second path.
   */
  chooseVerb(verb: number, noun1 = -1, noun2 = -1): void {
    this.sink.verb(verb, noun1, noun2);
  }
}
