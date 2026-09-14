/**
 * Broken Sword's input: a pointer with two buttons, and nothing else.
 *
 * ADR 0011 keeps input out of the shared host seam, and this family is the
 * plainest demonstration of why: its whole interface is a pointer. There is no
 * verb bar to hit-test (SCUMM), no typed line to parse (AGI), and no verb menu
 * to open on right-click (Lure). Left click acts, right click examines, and
 * both at once is its own event — which is the one detail that needs care, and
 * it is handled in `SwordUi` rather than here, because knowing that two presses
 * in one frame mean "both" requires the frame to be over.
 *
 * So this object collects raw events and hands them on. It deliberately does
 * **not** interpret: the button bits it accumulates are Revolution's own, and
 * the one-cycle delay that turns them into a click is the UI's job.
 *
 * Keyboard: Escape skips a cutscene and Space cuts a line of speech short,
 * which are the two keys the original binds during play. They are routed as
 * button presses because that is what the scripts test — `speechDriver` reads
 * the mouse state, not a key — so a player pressing space gets exactly the
 * effect clicking has.
 */

import type { EngineInput, InputSurface } from '../AdventureEngine.js';
import { BS1L_BUTTON_DOWN, BS1L_BUTTON_UP, BS1R_BUTTON_DOWN, BS1R_BUTTON_UP } from './SwordUi.js';

export class SwordInput implements EngineInput {
  /** Pointer position in display pixels: 0..639 across, 0..479 down. */
  x = 0;
  y = 0;
  /** Button bits since the engine last drained them. */
  private buttons = 0;
  /** Set while Escape is held, so a cutscene can be skipped. */
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
      // `event.button` is 0 for left and 2 for right; anything else (a middle
      // click, a pen barrel) is ignored rather than guessed at.
      if (event.button === 0) this.pressButton('left');
      else if (event.button === 2) this.pressButton('right');
      surface.resumeSound();
    };
    const onUp = (event: PointerEvent): void => {
      if (event.button === 0) this.releaseButton('left');
      else if (event.button === 2) this.releaseButton('right');
    };
    // Right-clicking is "examine" in this game, so the browser menu has to go —
    // and only over the canvas, which is why it is not a document handler.
    const onContextMenu = (event: Event): void => event.preventDefault();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        this.pressSkip();
        event.preventDefault();
      } else if (event.key === ' ') {
        this.pressButton('left');
        event.preventDefault();
      } else if (event.key === 'F5') {
        this.pressPanel('save');
        event.preventDefault();
      } else if (event.key === 'F7') {
        this.pressPanel('restore');
        event.preventDefault();
      }
      surface.resumeSound();
    };

    surface.canvas.addEventListener('pointermove', onMove as EventListener);
    surface.canvas.addEventListener('pointerdown', onDown as EventListener);
    surface.canvas.addEventListener('pointerup', onUp as EventListener);
    surface.canvas.addEventListener('contextmenu', onContextMenu);
    surface.keys.addEventListener('keydown', onKey as EventListener);

    this.teardown = [
      () => surface.canvas.removeEventListener('pointermove', onMove as EventListener),
      () => surface.canvas.removeEventListener('pointerdown', onDown as EventListener),
      () => surface.canvas.removeEventListener('pointerup', onUp as EventListener),
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
   * Public and named rather than left to the DOM handler above, because the
   * bits are Revolution's and a caller with no browser — `bin/play-probe.ts`,
   * a test — that sets them itself is writing a second copy of the mapping.
   * The handlers call this too, so there is only ever one.
   */
  pressButton(button: 'left' | 'right' = 'left'): void {
    this.buttons |= button === 'left' ? BS1L_BUTTON_DOWN : BS1R_BUTTON_DOWN;
  }

  /** Records a release. A press and a release in one cycle is a click. */
  releaseButton(button: 'left' | 'right' = 'left'): void {
    this.buttons |= button === 'left' ? BS1L_BUTTON_UP : BS1R_BUTTON_UP;
  }

  /** Takes the accumulated button bits and clears them. */
  drainButtons(): number {
    const buttons = this.buttons;
    this.buttons = 0;
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

  /** Takes the skip request and clears it. */
  drainSkip(): boolean {
    const skip = this.skipRequested;
    this.skipRequested = false;
    return skip;
  }

  /**
   * The control panel a player asks for, or null.
   *
   * F5 is Revolution's own: `kActionMainPanel` maps to it
   * (`sword1/metaengine.cpp:302-304`) and `checkKeys` turns it into
   * `SGF_SAVE`, which is what runs `Control::getPlayerOptions`. F7 is not —
   * the original's single panel holds save and restore together, and this
   * shell has one dialog for each, so the second gesture is this project's and
   * is named as such in `games/broken-sword/README.md`. The alternative was a
   * panel the shell does not have.
   */
  private panelRequested: 'save' | 'restore' | null = null;

  pressPanel(which: 'save' | 'restore'): void {
    this.panelRequested = which;
  }

  drainPanel(): 'save' | 'restore' | null {
    const wanted = this.panelRequested;
    this.panelRequested = null;
    return wanted;
  }
}
