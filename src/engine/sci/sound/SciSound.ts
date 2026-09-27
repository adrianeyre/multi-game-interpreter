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
import type { SciPcm } from './sciAudioPlayer.js';

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

  /**
   * Plays decoded digital audio, from `fromTick` sixtieths in, at `volume`
   * (nought to one). Null when nothing can be heard — no `AudioContext` yet,
   * which is before the player's first gesture, or sound switched off — and
   * `DoAudio`'s clock runs the same either way.
   */
  startPcm(
    pcm: SciPcm,
    options: { volume: number; loop: boolean; fromTick: number },
  ): { stop(): void } | null {
    const context = this.context;
    if (!this.enabled || !context || pcm.samples.length === 0) return null;
    const buffer = context.createBuffer(1, pcm.samples.length, pcm.rate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.samples.length; i++) channel[i] = pcm.samples[i] / 32768;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = options.loop;
    const gain = context.createGain();
    gain.gain.value = Math.max(0, Math.min(1, options.volume));
    source.connect(gain).connect(context.destination);
    source.start(0, Math.max(0, options.fromTick / 60) % Math.max(buffer.duration, 1e-6));
    return {
      stop: () => {
        try {
          source.stop();
        } catch {
          // Already ended, which is the ordinary way a sample stops.
        }
      },
    };
  }

  /** For the engine: whether anything would be heard. */
  get isEnabled(): boolean {
    return this.enabled;
  }
}
