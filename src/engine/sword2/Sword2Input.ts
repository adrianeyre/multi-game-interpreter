/**
 * Broken Sword II's input: a pointer with two buttons.
 *
 * The same shape as `SwordInput` and kept separate for ADR 0011's reason — each
 * Engine brings its own input object and the shell interprets nothing. The
 * difference from Sword1's is small and real: Sword2 reports its buttons as two
 * *globals* (`LEFT_BUTTON`, `RIGHT_BUTTON`) that the scripts read directly,
 * rather than as a bitfield an engine object owns. So this collects presses and
 * the engine writes the globals, which is why there is no bit packing here.
 */

import type { EngineInput, InputSurface } from '../AdventureEngine.js';
import { SWORD2_SCREEN_HEIGHT, SWORD2_SCREEN_WIDTH } from './gfx/Sword2Screen.js';

export class Sword2Input implements EngineInput {
  /**
   * Pointer position in display pixels: 0..639 across, 0..479 down.
   *
   * Starts in the middle of the screen rather than at 0,0, and that is not
   * cosmetic: the top forty pixels are the system menu's and the bottom forty
   * are the inventory's, so a pointer that has never moved would be sitting in
   * the system menu and the game would open with the panel up. The original
   * never has this problem — its pointer is the operating system's and starts
   * wherever the player left it — so the middle is this project's answer to a
   * question the original does not have, and it is the one position that means
   * "nowhere in particular".
   */
  x = SWORD2_SCREEN_WIDTH >> 1;
  y = SWORD2_SCREEN_HEIGHT >> 1;
  /** Whether each button went down since the engine last drained them. */
  private left = false;
  private right = false;
  skipRequested = false;

  private teardown: Array<() => void> = [];

  attach(surface: InputSurface): void {
    const onMove = (event: PointerEvent): void => {
      const point = surface.toScreen(event);
      this.x = point.x;
      this.y = point.y;
    };
    const onDown = (event: PointerEvent): void => {
      const point = surface.toScreen(event);
      this.x = point.x;
      this.y = point.y;
      if (event.button === 0) this.pressButton('left');
      else if (event.button === 2) this.pressButton('right');
      surface.resumeSound();
    };
    // Right-clicking is "examine", so the browser menu has to go — and only
    // over the canvas, which is why this is not a document handler.
    const onContextMenu = (event: Event): void => event.preventDefault();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        this.pressSkip();
        event.preventDefault();
      } else if (event.key === ' ') {
        this.pressButton('left');
        event.preventDefault();
      }
      surface.resumeSound();
    };

    surface.canvas.addEventListener('pointermove', onMove as EventListener);
    surface.canvas.addEventListener('pointerdown', onDown as EventListener);
    surface.canvas.addEventListener('contextmenu', onContextMenu);
    surface.keys.addEventListener('keydown', onKey as EventListener);

    this.teardown = [
      () => surface.canvas.removeEventListener('pointermove', onMove as EventListener),
      () => surface.canvas.removeEventListener('pointerdown', onDown as EventListener),
      () => surface.canvas.removeEventListener('contextmenu', onContextMenu),
      () => surface.keys.removeEventListener('keydown', onKey as EventListener),
    ];
  }

  detach(): void {
    for (const undo of this.teardown) undo();
    this.teardown = [];
  }

  /**
   * Records a press, the way a `pointerdown` over the canvas would.
   *
   * There is no matching release: Sword2's scripts read `LEFT_BUTTON` and
   * `RIGHT_BUTTON` as "went down this cycle" and nothing in the game asks
   * about the edge back up, so a release would be a flag with no reader.
   */
  pressButton(button: 'left' | 'right' = 'left'): void {
    if (button === 'left') this.left = true;
    else this.right = true;
  }

  /** Takes the button presses and clears them. */
  drainButtons(): { left: boolean; right: boolean } {
    const buttons = { left: this.left, right: this.right };
    this.left = false;
    this.right = false;
    return buttons;
  }

  /**
   * Records the skip a player asks for with Escape.
   *
   * Named for {@link pressButton}'s reason: a caller with no browser — the
   * probe, a test — that sets the flag itself is writing a second copy of the
   * binding, and then the two can disagree about which key skips.
   */
  pressSkip(): void {
    this.skipRequested = true;
  }

  drainSkip(): boolean {
    const skip = this.skipRequested;
    this.skipRequested = false;
    return skip;
  }
}
