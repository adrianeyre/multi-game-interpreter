/**
 * Sky's input surface.
 *
 * ADR 0011 kept input out of the shared host seam, and this is the fourth
 * family to show why: Sky's interface is a pointer with a verb chosen by
 * right-clicking, and the shell knows none of that. It hands over a canvas and
 * gets coordinates back.
 *
 * **What it does with them is collect them, and nothing more.** That is not a
 * gap: the routing lives in `SkyEngine.runMouse`, which tests the pointer
 * against the mouse list — a list of Compacts in the same shape as the logic
 * list — and runs the touched Compact's `mouseClick` script. Keeping the two
 * apart is the point of ADR 0011's seam. This class owns the browser events and
 * the last position; the engine owns what a position means.
 *
 * A player reporting "clicking does nothing" and a log that shows the clicks
 * arriving are two different bugs, which is why `clicks` is a count rather than
 * a flag consumed and forgotten.
 */

import type { EngineInput, InputSurface } from '../AdventureEngine.js';

export class SkyInput implements EngineInput {
  /** Where the pointer was last seen, in the game's own coordinates. */
  x = 0;
  y = 0;
  /** How many clicks have arrived; `SkyEngine.runMouse` drains this. */
  clicks = 0;

  private teardown: Array<() => void> = [];

  attach(surface: InputSurface): void {
    const onMove = (event: PointerEvent): void => {
      const point = surface.toScreen(event);
      this.x = point.x;
      this.y = point.y;
    };
    const onDown = (): void => {
      this.clicks += 1;
      surface.resumeSound();
    };

    surface.canvas.addEventListener('pointermove', onMove as EventListener);
    surface.canvas.addEventListener('pointerdown', onDown as EventListener);
    this.teardown = [
      () => surface.canvas.removeEventListener('pointermove', onMove as EventListener),
      () => surface.canvas.removeEventListener('pointerdown', onDown as EventListener),
    ];
  }

  detach(): void {
    for (const undo of this.teardown) undo();
    this.teardown = [];
  }
}
