/**
 * SCUMM's input: a verb bar, a sentence built from clicks, and a few hot keys.
 *
 * Its own object rather than members on `AdventureEngine`, because the three
 * things the shell used to know that were SCUMM-shaped were all input — the
 * verb-bar hit test and `VAR.CUTSCENEEXIT_KEY` (ADR 0011). Those live here now,
 * so the shell attaches an input object and never asks which family it belongs
 * to.
 */

import type { EngineInput, InputSurface } from './AdventureEngine.js';
import type { ScummEngine } from './ScummEngine.js';

export class ScummInput implements EngineInput {
  private readonly engine: ScummEngine;
  /** Removers for every listener added, so `detach` cannot miss one. */
  private teardown: Array<() => void> = [];

  constructor(engine: ScummEngine) {
    this.engine = engine;
  }

  attach(surface: InputSurface): void {
    this.detach();
    const { engine } = this;
    const { canvas, keys } = surface;

    const on = <E extends Event>(
      target: EventTarget,
      type: string,
      handler: (event: E) => void,
    ): void => {
      const listener = handler as EventListener;
      target.addEventListener(type, listener);
      this.teardown.push(() => target.removeEventListener(type, listener));
    };

    on<MouseEvent>(canvas, 'mousemove', (event) => {
      const { x, y } = surface.toScreen(event);
      engine.setMousePosition(x, y);
    });

    // The press is the event, not the click, in every version: the original
    // acts in `checkExecVerbs` while the button is down, Sam & Max's verb coin
    // opens on the press and would have nothing left to commit on the release,
    // and a v5 game's own input script expects the same moment. One entry
    // point means the verb-strip hit test lives in the engine, beside the
    // `userPut` check that gates it, instead of being copied into every shell.
    on<MouseEvent>(canvas, 'mousedown', (event) => {
      surface.resumeSound();
      const { x, y } = surface.toScreen(event);
      engine.pressButton(event.button === 2 ? 2 : 1, x, y);
    });

    on(canvas, 'mouseup', () => engine.releaseButton());
    on(canvas, 'mouseleave', () => engine.releaseButton());

    // Right click is a real button to the game, so the browser's menu is all
    // that needs suppressing here; `mousedown` already reported it.
    on<MouseEvent>(canvas, 'contextmenu', (event) => event.preventDefault());

    on<KeyboardEvent>(keys, 'keydown', (event) => {
      if (event.key === 'Escape') {
        engine.pressKey(engine.variables[engine.vars.CUTSCENEEXIT_KEY] || 27);
        return;
      }
      // Verb shortcuts are matched inside `pressKey`, in the order the
      // original tries them: the verb table first, then the key handler.
      if (event.key.length === 1) engine.pressKey(event.key.charCodeAt(0));
    });

    on(keys, 'keyup', () => engine.releaseKey());
  }

  detach(): void {
    for (const remove of this.teardown) remove();
    this.teardown = [];
  }
}
