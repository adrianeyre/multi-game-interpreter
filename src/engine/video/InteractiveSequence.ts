import { SmushPlayer } from './SmushPlayer.js';

/**
 * A SMUSH sequence the game's scripts drive and draw over.
 *
 * Full Throttle's bike combat and the demolition derby. Passive playback is a
 * decoder and a clock; this is a second interaction model, and the difference
 * is not that it is longer but that three things are true at once:
 *
 * - **The script and the video drive each other.** A script advances or
 *   branches the sequence, and the sequence's position is readable back — so
 *   neither owns the frame loop alone.
 * - **Input is live.** The player is *holding* a direction while the video
 *   runs, which is why `ScummEngine` grew held-key state: a last-press variable
 *   answers yes for one frame and no thereafter, which reads as a control that
 *   fires once and sticks.
 * - **Compositing order is explicit.** Video, then actors, then overlays. A
 *   wrong order does not look like an error; it looks like a missing sprite.
 *
 * "It plays correctly" and "it is playable" are different claims here, and only
 * the second closes #103 — which is why that issue is Tier 2 on retail data.
 */

/** What draws over the video, in the order it draws. */
export const enum SequenceLayer {
  /** The decoded frame. Always first: everything else is drawn onto it. */
  Video = 0,
  /** Actors the scripts place over the video. */
  Actors = 1,
  /** Score, health, anything the game puts on top of everything. */
  Overlay = 2,
}

export interface SequenceInput {
  /** Whether a key is being held right now, not whether it was last pressed. */
  isKeyHeld(keyCode: number): boolean;
}

/** A layer's draw callback, given the framebuffer to draw into. */
export type LayerDraw = (target: Uint8Array) => void;

/**
 * Drives one interactive sequence.
 *
 * Deliberately does not own the frame loop: `advance` is called by whatever
 * does, and the scripts run between calls. That is what lets a script read the
 * position, decide something, and have the decision land on the next frame
 * rather than a frame late.
 */
export class InteractiveSequence {
  private readonly player: SmushPlayer;
  private readonly input: SequenceInput;
  private readonly layers = new Map<SequenceLayer, LayerDraw[]>();

  /** Set by a script to end the sequence early — a fight won or lost. */
  private stopped = false;

  constructor(player: SmushPlayer, input: SequenceInput) {
    this.player = player;
    this.input = input;
  }

  /** Registers something to draw over the video, at a named layer. */
  addLayer(layer: SequenceLayer, draw: LayerDraw): void {
    const existing = this.layers.get(layer);
    if (existing) existing.push(draw);
    else this.layers.set(layer, [draw]);
  }

  /** Whether the player is holding a key, for a script polling mid-sequence. */
  isKeyHeld(keyCode: number): boolean {
    return this.input.isKeyHeld(keyCode);
  }

  /** How far into the sequence playback has reached, in seconds. */
  get position(): number {
    return this.player.position;
  }

  /** Which frame is showing, for a script branching on where the video is. */
  frameAt(seconds: number): number {
    return this.player.frameForTime(seconds);
  }

  get finished(): boolean {
    return this.stopped || this.player.finished;
  }

  /**
   * Ends the sequence before its last frame.
   *
   * What a won fight does. Separate from the player's own end so that "the
   * video ran out" and "the game decided" stay distinguishable — a script that
   * expects the second and gets the first has a bug worth seeing.
   */
  stop(): void {
    this.stopped = true;
  }

  /**
   * Advances by `seconds` and composites a frame.
   *
   * Draws in layer order every time, not only when the video advanced: an
   * overlay that moves while the video holds still — a health bar draining
   * between frames — must still be redrawn, or it appears to freeze with the
   * picture.
   */
  advance(seconds: number, target: Uint8Array): void {
    if (this.finished) return;

    this.player.step(seconds, target);

    for (const layer of [SequenceLayer.Actors, SequenceLayer.Overlay]) {
      for (const draw of this.layers.get(layer) ?? []) draw(target);
    }
  }
}
