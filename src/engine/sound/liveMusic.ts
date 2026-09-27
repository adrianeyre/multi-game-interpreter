/**
 * Streams a live sequencer into Web Audio, a few tens of milliseconds at a time.
 *
 * The old path rendered a whole score up front into one buffer, which is why
 * nothing could change once it was playing. This keeps only a short stretch of
 * audio queued ahead of the listener — the lookahead — and renders the
 * next chunk from the sequencer's *current* state each time the queue runs
 * low, so a jump, a transpose or a fade is heard within that lookahead of the
 * command that asked for it. It also removes the two-minute render cap: a
 * piece plays for as long as its score and its loops say.
 *
 * Chunks are ordinary `AudioBufferSourceNode`s scheduled back to back, the way
 * `playVideoAudio` already queues SMUSH audio. An `AudioWorklet` would shave
 * the latency further but needs a separately served module, and this engine
 * ships as plain files.
 */

/** Something that can be sequenced into samples at its own rate. */
export interface LiveSource {
  readonly sampleRate: number;
  /** False once the music has finished; the output may still be ringing. */
  readonly active: boolean;
  render(out: Float32Array): void;
  /** -64 (left) to 63 (right), when the source can be panned. */
  readonly pan?: number;
}

/**
 * How far ahead of the listener audio is prepared, at best and at worst.
 *
 * The lookahead *is* the command latency: a jump or a fade is rendered into
 * the next chunk, and is heard once the chunks already queued have played. So
 * it starts short — 80 ms, under the threshold where music audibly lags the
 * picture — and grows only when the page proves it cannot keep that queue
 * fed: each underrun half again as much, up to half a second, easing back
 * down while the queue stays healthy.
 */
export const MIN_LOOKAHEAD_SECONDS = 0.08;
export const MAX_LOOKAHEAD_SECONDS = 0.5;

/** Output frames per scheduled chunk: about 23 ms at 44.1 kHz. */
export const CHUNK_FRAMES = 1024;

/** How long a finished piece is left to ring before its output is dropped. */
const TAIL_SECONDS = 1;

/**
 * Linear resampling that carries its position across chunks.
 *
 * Resampling each chunk on its own would restart the interpolation at every
 * boundary and click twenty times a second.
 */
class StreamResampler {
  private readonly ratio: number;
  private buffer = new Float32Array(0);
  /** Position within `buffer`, in source frames. */
  private position = 0;

  constructor(
    private readonly source: LiveSource,
    outputRate: number,
  ) {
    this.ratio = source.sampleRate / outputRate;
  }

  pull(out: Float32Array): void {
    // Enough source for the last interpolation to have its right-hand sample.
    const needed = Math.ceil(this.position + out.length * this.ratio) + 2;
    if (this.buffer.length < needed) {
      const grown = new Float32Array(needed);
      grown.set(this.buffer);
      this.source.render(grown.subarray(this.buffer.length));
      this.buffer = grown;
    }

    for (let i = 0; i < out.length; i++) {
      const index = Math.floor(this.position);
      const fraction = this.position - index;
      const a = this.buffer[index];
      const b = this.buffer[index + 1];
      out[i] = a + (b - a) * fraction;
      this.position += this.ratio;
    }

    // Drop what has been consumed, keeping the sample the next read starts on.
    const consumed = Math.floor(this.position);
    this.buffer = this.buffer.slice(consumed);
    this.position -= consumed;
  }
}

export class LiveMusicStream {
  /** The level control the music sequencer crossfades with. */
  readonly gain: GainNode;
  private readonly panner: StereoPannerNode | null;
  private readonly resampler: StreamResampler;
  private readonly sources = new Set<AudioBufferSourceNode>();
  private scheduledUntil = 0;
  private tailLeft = TAIL_SECONDS;
  private stopped = false;
  private started = false;
  /** The current lookahead, which adapts between the two bounds. */
  lookahead = MIN_LOOKAHEAD_SECONDS;

  /** Called once, when the output has finished (after the tail). */
  onFinished: (() => void) | null = null;

  constructor(
    private readonly context: BaseAudioContext,
    destination: AudioNode,
    readonly source: LiveSource,
  ) {
    this.resampler = new StreamResampler(source, context.sampleRate);
    this.gain = context.createGain();
    this.gain.gain.value = 1;

    // Not every implementation has a panner, and a missing one should cost the
    // music its pan rather than its playback.
    this.panner =
      typeof context.createStereoPanner === 'function' ? context.createStereoPanner() : null;
    if (this.panner) {
      this.gain.connect(this.panner);
      this.panner.connect(destination);
    } else {
      this.gain.connect(destination);
    }
    this.pump();
  }

  /** Whether output is still being produced. */
  get finished(): boolean {
    return this.stopped;
  }

  /**
   * Tops the queue up to the lookahead.
   *
   * Called from the engine's frame step and from each chunk's end, so the
   * queue keeps filling even through a frame that takes too long.
   */
  pump(): void {
    if (this.stopped) return;
    const now = this.context.currentTime;
    // Fell behind — a stalled tab — so resume from now rather than scheduling
    // into the past, which a browser plays as one burst; and keep more queued
    // from here on, since this page has shown it needs it.
    if (this.scheduledUntil < now) {
      if (this.started) {
        this.lookahead = Math.min(MAX_LOOKAHEAD_SECONDS, this.lookahead * 1.5);
      }
      this.scheduledUntil = now + 0.02;
    } else if (this.lookahead > MIN_LOOKAHEAD_SECONDS) {
      this.lookahead = Math.max(MIN_LOOKAHEAD_SECONDS, this.lookahead - 0.002);
    }
    this.started = true;

    if (this.panner && this.source.pan !== undefined) {
      this.panner.pan.value = Math.max(-1, Math.min(1, this.source.pan / 64));
    }

    // Something started again during the tail: it gets a whole tail later.
    if (this.source.active) this.tailLeft = TAIL_SECONDS;

    while (this.scheduledUntil < now + this.lookahead) {
      if (!this.source.active) {
        if (this.tailLeft <= 0) {
          this.finish();
          return;
        }
        this.tailLeft -= CHUNK_FRAMES / this.context.sampleRate;
      }
      this.scheduleChunk();
    }
  }

  private scheduleChunk(): void {
    const buffer = this.context.createBuffer(1, CHUNK_FRAMES, this.context.sampleRate);
    this.resampler.pull(buffer.getChannelData(0));

    const node = this.context.createBufferSource();
    node.buffer = buffer;
    node.connect(this.gain);
    node.onended = () => {
      this.sources.delete(node);
      this.pump();
    };
    node.start(this.scheduledUntil);
    this.sources.add(node);
    this.scheduledUntil += CHUNK_FRAMES / this.context.sampleRate;
  }

  /** Cuts the output off now, queued audio included. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const node of this.sources) {
      try {
        node.stop();
      } catch {
        // Not started yet, or already ended; neither needs stopping.
      }
    }
    this.sources.clear();
    try {
      this.gain.disconnect();
      this.panner?.disconnect();
    } catch {
      // Already disconnected.
    }
  }

  private finish(): void {
    this.stop();
    this.onFinished?.();
  }
}
