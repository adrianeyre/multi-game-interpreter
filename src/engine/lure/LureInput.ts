/**
 * Lure's input surface.
 *
 * ADR 0011 keeps input out of the shared host seam, and Lure is the fifth family
 * to show why rather than the first to break it: its interface is a pointer with
 * a verb menu, which is neither SCUMM's verb bar nor AGI's typed line. The shell
 * hands over a canvas and gets coordinates back.
 *
 * **It routes nothing yet.** Lure has no script interpreter here (ADR 0026), so
 * there is nothing for a click to drive. This collects the pointer's position
 * and counts clicks so a log can show input arriving, which is the difference
 * between "clicking does nothing" and "clicks never reach the engine" — two
 * different bugs, told apart at no cost now. The pattern is `SkyInput`'s, kept
 * separate because the families share a shell and not a renderer.
 */

import type { EngineInput, InputSurface } from '../AdventureEngine.js';

export class LureInput implements EngineInput {
  /** Where the pointer was last seen, in the game's own coordinates. */
  x = 0;
  y = 0;
  /** How many clicks have arrived, which nothing routes yet. */
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
