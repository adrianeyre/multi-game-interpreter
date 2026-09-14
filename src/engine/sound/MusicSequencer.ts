/**
 * One live iMUSE sequencer, serving v6 and v7 (ADR 0008).
 *
 * The idea iMUSE is built on is that a score is a **state**, not a track: a
 * script asks for a musical situation and the music transitions to it from
 * wherever it currently is. v6 renders a score to samples up front and plays
 * the result, which serves "start this piece" and cannot serve any of the
 * commands that need a playing position — the jump, hook and queue commands the
 * current implementation names in the log and drops.
 *
 * v7 cannot use render-up-front at all: its music *is* digital audio, streamed
 * out of `.BUN` bundles and crossfaded between states. There is nothing to
 * render ahead of time. That forces a live sequencer to exist, and rather than
 * standing a second music path beside the existing one, v6 is retrofitted onto
 * it — one mechanism, with each version supplying a **source** of audio and the
 * transition logic above it shared.
 *
 * What is deliberately *not* here: how a score becomes sound. v6 supplies an
 * OPL2 rendering and v7 decoded bundle streams, and the sequencer knows neither.
 * That separation is the whole point of doing this once rather than twice.
 */

/** What the sequencer needs of whatever produces the audio. */
export interface MusicSource {
  /** Begins a piece, optionally from a position other than its start. */
  play(id: number, fromSeconds?: number): void;
  stop(id: number): void;
  /** Sets the level for a piece, 0..1, used for crossfades. */
  setLevel(id: number, level: number): void;
  /** Where a playing piece has reached, in seconds, or null when it is not. */
  positionOf(id: number): number | null;
}

/** The music the game is in, rather than the file that is playing. */
export interface MusicState {
  /** The sound id the state is served by. */
  id: number;
  /** Seconds to fade across when entering this state from another. */
  crossfadeSeconds: number;
}

/** How a transition that cannot be served faithfully is reported. */
export type SequencerLog = (message: string) => void;

/**
 * The transition logic v6 and v7 share.
 *
 * Every method here is about *what the music should be doing*; none of them
 * knows whether the sound underneath is a synthesised score or a stream.
 */
export class MusicSequencer {
  private readonly source: MusicSource;
  private readonly log: SequencerLog;

  /** The state being played, or null for silence. */
  private current: MusicState | null = null;

  /**
   * A state asked for while a crossfade is still running.
   *
   * Queued rather than applied, because cutting into a fade is audible as a
   * click and because the original queues: a script that asks for three states
   * in three frames should arrive at the third, not hear the first two clipped.
   */
  private queued: MusicState | null = null;

  /** The hook a script has armed, or 0 for none. */
  private armedHook = 0;

  /** Seconds elapsed in the crossfade currently running, and its length. */
  private fadeElapsed = 0;
  private fadeLength = 0;
  private fadingFrom: number | null = null;

  /** Said once per distinct message: a game polls, and repetition buries. */
  private readonly reported = new Set<string>();

  constructor(source: MusicSource, log: SequencerLog = () => {}) {
    this.source = source;
    this.log = log;
  }

  /** The state playing now, for a save and for diagnostics. */
  get state(): MusicState | null {
    return this.current;
  }

  /** Restores a state without a transition, as loading a save must. */
  restore(state: MusicState | null): void {
    this.stopFade();
    this.queued = null;
    if (this.current && this.current.id !== state?.id) this.source.stop(this.current.id);
    this.current = state;
    if (state) {
      this.source.play(state.id);
      this.source.setLevel(state.id, 1);
    }
  }

  /**
   * Moves to a musical state, crossfading from whatever is playing.
   *
   * Asking for the state already playing is not a restart. A script that sets
   * its room's music on every entry — which they do — would otherwise cut the
   * piece back to its opening bar each time the player walked through a door.
   */
  enter(state: MusicState): void {
    if (this.current?.id === state.id && this.fadingFrom === null) return;

    if (this.fadeLength > 0) {
      this.queued = state;
      return;
    }

    if (!this.current || state.crossfadeSeconds <= 0) {
      if (this.current) this.source.stop(this.current.id);
      this.current = state;
      this.source.play(state.id);
      this.source.setLevel(state.id, 1);
      return;
    }

    this.fadingFrom = this.current.id;
    this.fadeElapsed = 0;
    this.fadeLength = state.crossfadeSeconds;
    this.current = state;
    this.source.play(state.id);
    this.source.setLevel(state.id, 0);
    this.source.setLevel(this.fadingFrom, 1);
  }

  /** Fades out and stops, which is what a script asking for silence means. */
  leave(fadeSeconds = 0): void {
    if (!this.current) return;
    if (fadeSeconds <= 0) {
      this.source.stop(this.current.id);
      this.stopFade();
      this.current = null;
      this.queued = null;
      return;
    }
    this.fadingFrom = this.current.id;
    this.fadeElapsed = 0;
    this.fadeLength = fadeSeconds;
    this.current = null;
  }

  /**
   * Arms a hook, which is how iMUSE actually branches.
   *
   * The composer puts exits in the score, each waiting on a hook number, and
   * the game chooses between them by arming one. A hook is consumed by the jump
   * it triggers, so arming one does not branch the music every time round the
   * loop.
   */
  armHook(hook: number): void {
    this.armedHook = hook;
  }

  /** Whether a jump waiting on `hook` should be taken now, consuming it. */
  takeHook(hook: number): boolean {
    if (hook === 0 || this.armedHook !== hook) return false;
    this.armedHook = 0;
    return true;
  }

  /**
   * Advances the crossfade by one frame's worth of time.
   *
   * Driven by elapsed seconds rather than by a frame count so that a slow frame
   * lengthens the step instead of stretching the fade — a fade that tracks the
   * frame rate is a fade that sounds different on a busy scene.
   */
  step(seconds: number): void {
    if (this.fadeLength <= 0) return;

    this.fadeElapsed += seconds;
    const progress = Math.min(1, this.fadeElapsed / this.fadeLength);

    if (this.current) this.source.setLevel(this.current.id, progress);
    if (this.fadingFrom !== null) this.source.setLevel(this.fadingFrom, 1 - progress);

    if (progress < 1) return;

    if (this.fadingFrom !== null) this.source.stop(this.fadingFrom);
    this.stopFade();

    const queued = this.queued;
    this.queued = null;
    if (queued) this.enter(queued);
  }

  /**
   * Names a transition this cannot serve faithfully, once.
   *
   * The project's habit, and ADR 0008's explicit instruction: a transition that
   * cannot be served is said once rather than faked as a hard cut. Playing the
   * right music with the wrong transitions is the failure the ADR rejected —
   * hard cuts through a score written to crossfade.
   */
  cannotServe(what: string): void {
    if (this.reported.has(what)) return;
    this.reported.add(what);
    this.log(`iMUSE: ${what} is not served here, so the music will not follow the game there.`);
  }

  private stopFade(): void {
    this.fadeElapsed = 0;
    this.fadeLength = 0;
    this.fadingFrom = null;
  }
}
