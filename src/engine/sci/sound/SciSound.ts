/**
 * SCI's sound, as far as the shell is concerned.
 *
 * A SCI sound resource is **not a track**. It carries several *Device
 * arrangements* — AdLib, MT-32, PC speaker, Amiga — and the interpreter picks
 * one at play time. That is the same split SCUMM ships as separate `ADLIB.IMS`
 * and `ROLAND.IMS` files, folded inside one resource, and modelling a sound
 * resource as having *a* body is the mistake this family exists to avoid making
 * (#219).
 *
 * This file is the shell's half: a toggle and the resume-on-gesture dance, so
 * `AdventureEngine` is satisfied before there is anything to play. The
 * arrangement selection and the synthesis land with #219.
 */

import type { EngineSound } from '../../AdventureEngine.js';

export class SciSound implements EngineSound {
  private enabled = true;
  private context: AudioContext | null = null;

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) void this.context?.suspend();
  }

  async resume(): Promise<void> {
    if (!this.enabled) return;
    if (!this.context) {
      const Ctor =
        typeof AudioContext !== 'undefined'
          ? AudioContext
          : (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.context = new Ctor();
    }
    if (this.context.state === 'suspended') await this.context.resume();
  }

  /** For the engine: whether anything would be heard. */
  get isEnabled(): boolean {
    return this.enabled;
  }
}
