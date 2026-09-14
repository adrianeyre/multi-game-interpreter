/**
 * Lure's sound, which plays nothing yet.
 *
 * `EngineSound` is two methods and both are honoured: the shell's toggle is
 * remembered, and `resume` is the gesture-driven start browsers require. What is
 * missing is everything between — Lure's music and effects — which waits on the
 * script interpreter that would trigger them (ADR 0026).
 *
 * A real object rather than a null one, for `SkySound`'s reason: the shell's
 * toggle and its resume-on-gesture dance work the same way for this family as
 * for every other, and the work that fills it in has somewhere to land rather
 * than a seam to add.
 */

import type { EngineSound } from '../AdventureEngine.js';

export class LureSound implements EngineSound {
  private enabled = true;
  private context: AudioContext | null = null;

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async resume(): Promise<void> {
    if (typeof AudioContext === 'undefined') return;
    this.context ??= new AudioContext();
    if (this.context.state === 'suspended') await this.context.resume();
  }
}
