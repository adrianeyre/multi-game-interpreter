/**
 * Sky's sound, which plays nothing yet.
 *
 * `EngineSound` is two methods and both are honoured: the shell's toggle is
 * remembered, and `resume` is the gesture-driven start browsers require. What
 * is missing is everything between — the music, the effects and the CD
 * release's recorded speech, which is #257.
 *
 * A real object rather than a null one, so the shell's toggle and its
 * resume-on-gesture dance work the same way for this family as for the others,
 * and so #257 has somewhere to land rather than a seam to add.
 *
 * **The one thing worth knowing before that work starts** is in `CONTEXT.md`:
 * an interpreter that ignores speech must still produce the same pause, or the
 * script's pacing breaks. So silence is not the same as nothing to do — the
 * `fnSpeakWait` family has to wait the right length whether or not a sound
 * comes out, and that is a scripting fault that looks like a renderer bug.
 */

import type { EngineSound } from '../../AdventureEngine.js';

export class SkySound implements EngineSound {
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
