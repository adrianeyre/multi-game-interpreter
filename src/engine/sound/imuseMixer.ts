import type { ImusePlayer } from './ImusePlayer.js';
import type { LiveSource } from './liveMusic.js';
import { OPL2_RATE } from './opl2/Opl2.js';
import { createAdLibHub, createSpeakerHub, type ScoreKind, type SynthPort } from './synth.js';

/**
 * Every playing iMUSE player, on one sound card, as one stream.
 *
 * The original has one AdLib and one speaker, and iMUSE divides them between
 * whatever is playing: a piece of music and a sound effect's score compete for
 * the nine OPL2 voices by priority. This is that arrangement — one OPL2 (and
 * one speaker) shared through `SynthHub`, each player given its own block of
 * channels, and a single timer that ticks every player's sequencer and then
 * renders the chip for all of them.
 *
 * One timer for all is also what the original does (`IMuseInternal::on_timer`
 * runs `sequencer_timers` over every player), and it keeps players in step
 * with each other: two pieces started together stay together.
 */

/** The sequencers' tick: the AdLib driver's 250 Hz. */
const TIMER_HZ = 250;

export class ImuseMixer implements LiveSource {
  readonly sampleRate = OPL2_RATE;
  private readonly adlib = createAdLibHub();
  private readonly speaker = createSpeakerHub();
  private readonly players = new Map<ImusePlayer, SynthPort>();
  private speakerUsed = false;
  private untilTimer = 0;
  private scratch = new Float32Array(0);

  /** A port on the right card for a score of this kind. */
  portFor(kind: ScoreKind): SynthPort {
    if (kind === 'speaker') {
      this.speakerUsed = true;
      return this.speaker.port(kind);
    }
    return this.adlib.port(kind);
  }

  add(player: ImusePlayer, port: SynthPort): void {
    this.players.set(player, port);
  }

  /** Takes a player off the card, freeing its channels. */
  remove(player: ImusePlayer): void {
    const port = this.players.get(player);
    if (!port) return;
    this.players.delete(player);
    port.close();
  }

  /** True while any player is still sequencing. */
  get active(): boolean {
    for (const player of this.players.keys()) if (player.active) return true;
    return false;
  }

  render(out: Float32Array): void {
    const perTimer = this.sampleRate / TIMER_HZ;
    let written = 0;
    while (written < out.length) {
      if (this.untilTimer < 1) {
        this.untilTimer += perTimer;
        this.tick();
      }
      const span = Math.min(out.length - written, Math.floor(this.untilTimer));
      this.renderCards(out.subarray(written, written + span));
      written += span;
      this.untilTimer -= span;
    }
  }

  private tick(): void {
    for (const [player] of this.players) {
      if (player.active) player.onTimer();
      // A player that stopped on this tick leaves the card; its notes have
      // been released and are left to ring out on the chip.
      if (!player.active) this.remove(player);
    }
  }

  private renderCards(out: Float32Array): void {
    this.adlib.render(out);
    if (!this.speakerUsed) return;
    if (this.scratch.length < out.length) this.scratch = new Float32Array(out.length);
    const speaker = this.scratch.subarray(0, out.length);
    this.speaker.render(speaker);
    for (let i = 0; i < out.length; i++) out[i] += speaker[i];
  }
}
