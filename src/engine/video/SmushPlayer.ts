import { decodeIactBlock, iactAudioPayload, iactBlockLength, IACT_SAMPLE_RATE } from './iact.js';
import { readPsadSlice } from './psad.js';
import type { Codec37Decoder } from './codec37.js';
import type { Codec47Decoder } from './codec47.js';
import {
  createCodec37Decoder,
  createCodec47Decoder,
  DeltaPalette,
  drawFrameObject,
  readFrameObject,
  readPaletteChunk,
  readSmushFile,
  readTextCue,
  type SmushFrame,
  type SmushTextCue,
} from './smush.js';

/**
 * Playing a SMUSH sequence: frames, palette and audio, kept together.
 *
 * The thing this exists to get right is **sync**, and the choice that decides it
 * is which clock is authoritative. Frames advanced by a frame counter and audio
 * started once will drift apart cumulatively — a little at first, obviously by
 * the end of a long cutscene, and invisibly to any test. So the audio is the
 * clock: it is queued in order, its position is what "now" means, and frames are
 * selected against it. A dropped frame then skips rather than lengthening the
 * sequence, and drift is bounded rather than accumulating.
 *
 * The decoders are constructed once per sequence, not per frame. Codecs 37 and
 * 47 encode most blocks as references into the previous two frames, so a
 * decoder made fresh each frame would reference empty buffers and produce a
 * still of whatever came first.
 */

/** Frames per second when a file does not override it. */
export const DEFAULT_SMUSH_FPS = 15;

export interface SmushAudio {
  /** Interleaved 16-bit samples, in order, at `IACT_SAMPLE_RATE`. */
  samples: Int16Array;
}

export interface SmushSequence {
  frameCount: number;
  fps: number;
  /** 256 RGB triples, updated as `NPAL` chunks arrive. */
  palette: Uint8Array;
}

export class SmushPlayer {
  private frames: SmushFrame[] = [];
  private sequence: SmushSequence | null = null;
  /**
   * The motion-compensated decoders, made on the first frame that needs one.
   *
   * Sized from the *frame object* rather than from the screen, and that is not
   * the same thing: a frame object carries its own rectangle and a SMUSH
   * sequence is free to be a different size from the display — 384x242 is a
   * real case. A decoder sized to the screen holds its reference frames at the
   * wrong stride, so every block referenced from the previous frame is fetched
   * from the wrong row and the picture shears a little more with each frame.
   *
   * Made once and kept, because the whole economy of these codecs is that most
   * blocks are references into the previous two frames: one made per frame
   * would reference empty buffers and draw a still.
   */
  private codec37: Codec37Decoder | null = null;
  private codec47: Codec47Decoder | null = null;
  private codecSize = { width: 0, height: 0 };
  private nextFrame = 0;
  private elapsed = 0;
  private readonly audio: Int16Array[] = [];
  private readonly reportedCodecs = new Set<number>();
  private readonly reportedTags = new Set<string>();

  /** The palette and whatever fade is moving it. */
  private readonly deltaPalette = new DeltaPalette();

  /** Set whenever a chunk changed the palette, so the host can push it once. */
  private paletteChanged = false;

  /**
   * The frame `STOR` asked to be kept, or null when none has been.
   *
   * The whole framebuffer rather than the frame object's rectangle: `FTCH`
   * restores a screen, and both v7 games use the pair to hold a background
   * still while something small moves over it.
   */
  private stored: Uint8Array | null = null;
  private storeRequested = false;

  /**
   * Subtitles the current frame asked for.
   *
   * Replaced per frame rather than accumulated: a `TEXT` chunk is a line for
   * *this* frame, and carrying one over is a subtitle that will not go away.
   */
  private cues: SmushTextCue[] = [];

  /** Where unimplemented-codec and unhandled-chunk notices go. */
  onLog: ((message: string) => void) | null = null;

  /**
   * Opens a `.SAN`, or returns null when the file is not one.
   *
   * Null rather than throwing: a cutscene that will not open is a missing
   * cutscene, and naming it is more use than an exception from a frame loop.
   *
   * `requestedFps` is what a script asked for, in frames per second — the same
   * units the header uses, and the reason both can be compared at all.
   *
   * No display size is taken. The pictures' size is the frame objects' own and
   * is read from the first of them; a sequence is free to be a different size
   * from the screen it is shown on.
   */
  open(bytes: Uint8Array, requestedFps = DEFAULT_SMUSH_FPS): SmushSequence | null {
    const file = readSmushFile(bytes);
    if (!file) return null;

    this.frames = file.frames;
    this.nextFrame = 0;
    this.elapsed = 0;
    this.audio.length = 0;
    this.reportedCodecs.clear();
    this.reportedTags.clear();
    this.stored = null;
    this.storeRequested = false;
    this.cues = [];
    this.deltaPalette.reset(file.header.palette);
    this.paletteChanged = true;

    // Not made here: their size comes from the first frame object, which is
    // the only thing that knows how big this sequence's pictures are.
    this.codec37 = null;
    this.codec47 = null;
    this.codecSize = { width: 0, height: 0 };

    this.sequence = {
      frameCount: file.header.frameCount,
      // The file's own header wins over what the caller asked for, and the
      // caller's request wins over the default. That is the original's order:
      // a script sets a rate for videos in general and a file that knows its
      // own rate overrides it.
      fps: file.header.speed ?? requestedFps,
      // The live palette, not a copy: a fade moves it every frame, and a caller
      // holding a snapshot would draw the first frame's colours throughout.
      palette: this.deltaPalette.colours,
    };
    return this.sequence;
  }

  get finished(): boolean {
    return this.sequence === null || this.nextFrame >= this.frames.length;
  }

  /** How far into the sequence playback has reached, in seconds. */
  get position(): number {
    return this.elapsed;
  }

  /**
   * Which frame the clock says should be showing.
   *
   * Derived from elapsed time rather than counted, so a slow frame skips ahead
   * instead of stretching the sequence. That is the difference between a video
   * that finishes with its audio and one that runs long.
   */
  frameForTime(seconds: number): number {
    if (!this.sequence) return 0;
    return Math.floor(seconds * this.sequence.fps);
  }

  /**
   * Advances by `seconds` and draws whatever frame is now due into `target`.
   *
   * Returns true when a frame was drawn. Frames between the last one shown and
   * the one now due are **decoded but not drawn**: they cannot be skipped
   * outright, because codecs 37 and 47 build each frame from the one before, so
   * skipping one corrupts every frame after it.
   */
  step(seconds: number, target: Uint8Array): boolean {
    if (!this.sequence) return false;

    this.elapsed += seconds;
    const due = Math.min(this.frameForTime(this.elapsed), this.frames.length - 1);
    if (due < this.nextFrame) return false;

    let drew = false;
    while (this.nextFrame <= due) {
      drew = this.decodeFrame(this.frames[this.nextFrame], target) || drew;
      this.nextFrame++;
    }
    return drew;
  }

  /** Every audio block gathered so far, in order, ready to queue. */
  takeAudio(): SmushAudio | null {
    if (this.audio.length === 0) return null;
    const total = this.audio.reduce((sum, block) => sum + block.length, 0);
    const samples = new Int16Array(total);
    let at = 0;
    for (const block of this.audio) {
      samples.set(block, at);
      at += block.length;
    }
    this.audio.length = 0;
    return { samples };
  }

  /** How long the audio gathered so far runs, in seconds. */
  static durationOf(audio: SmushAudio): number {
    // Interleaved stereo: two samples per frame.
    return audio.samples.length / 2 / IACT_SAMPLE_RATE;
  }

  /**
   * The palette, when something has moved it since it was last taken.
   *
   * Handed over on a change rather than every frame because pushing 256
   * colours through the renderer is the expensive half of a fade, and a
   * sequence with no `XPAL` in it changes palette perhaps twice.
   */
  takePaletteChange(): Uint8Array | null {
    if (!this.paletteChanged) return null;
    this.paletteChanged = false;
    return this.deltaPalette.colours;
  }

  /** The subtitles the last decoded frame asked for, in the order given. */
  get textCues(): readonly SmushTextCue[] {
    return this.cues;
  }

  private decodeFrame(frame: SmushFrame, target: Uint8Array): boolean {
    let drew = false;
    this.cues = [];

    for (const chunk of frame.chunks) {
      switch (chunk.tag) {
        case 'NPAL': {
          const palette = readPaletteChunk(chunk.data);
          if (palette) {
            this.deltaPalette.setFull(palette);
            this.paletteChanged = true;
          }
          continue;
        }

        case 'XPAL': {
          // A fade. Reported when malformed rather than ignored: a step chunk
          // that will not read is a fade that stops halfway, which on screen
          // is a picture at the wrong brightness for the rest of the scene.
          if (this.deltaPalette.apply(chunk.data)) this.paletteChanged = true;
          else this.reportTag('XPAL', 'is malformed, so a fade in this sequence will stick');
          continue;
        }

        case 'IACT':
          this.collectAudio(chunk.data);
          continue;

        case 'PSAD': {
          // Full Throttle's cutscene audio, where The Dig uses `IACT`. Both
          // arrive at the same rate in the same shape, so they share the one
          // buffer and the one clock.
          const slice = readPsadSlice(chunk.data);
          if (!slice) {
            this.reportTag('PSAD', 'is too short to read, so a cutscene will be part-silent');
          } else if (slice.samples.length > 0) {
            this.audio.push(slice.samples);
          }
          continue;
        }

        case 'STOR':
          // Only a request. What is stored is the frame *after* this frame's
          // objects have been drawn, which is what the following `FTCH` expects
          // to get back.
          this.storeRequested = true;
          continue;

        case 'FTCH': {
          if (this.stored) {
            target.set(this.stored);
            drew = true;
          } else {
            this.reportTag('FTCH', 'asked for a stored frame before one was stored');
          }
          continue;
        }

        case 'TEXT':
        case 'TRES': {
          const cue = readTextCue(chunk.data, chunk.tag);
          if (cue) this.cues.push(cue);
          continue;
        }

        case 'FOBJ': {
          const object = readFrameObject(chunk.data);
          if (!object) continue;
          this.sizeDecodersFor(object.width, object.height);
          if (drawFrameObject(object, target, this.codec37 ?? undefined, this.codec47 ?? undefined))
            drew = true;
          else this.reportCodec(object.codec);
          continue;
        }

        default:
          // Named once each rather than skipped silently, so an unsupported
          // chunk shows up as its own name in a log instead of as something
          // missing from the screen.
          this.reportTag(chunk.tag, 'is not handled, so whatever it carries is missing');
          continue;
      }
    }

    if (this.storeRequested) {
      this.stored ??= new Uint8Array(target.length);
      this.stored.set(target);
      this.storeRequested = false;
    }

    return drew;
  }

  private collectAudio(chunk: Uint8Array): void {
    // Only one code and flags pair means audio; the rest are
    // interactive-sequence instructions, which is how Full Throttle's bike
    // fights drive their overlays. Decoding those as samples is noise.
    const payload = iactAudioPayload(chunk);
    if (!payload) {
      // Named once, like every other thing this player cannot do. Dropping it
      // silently is the worse failure of the two: the frames still decode, so
      // Full Throttle's bike combat plays through as a passive cutscene and
      // looks like it is working while ignoring the player entirely. (#103.)
      this.reportTag(
        'IACT (interactive)',
        'is not handled, so this sequence plays as a cutscene and will not respond',
      );
      return;
    }

    let at = 0;
    while (at < payload.length) {
      const length = iactBlockLength(payload, at);
      if (length === null || length <= 2) return;
      const block = payload.subarray(at, at + length);
      const decoded = decodeIactBlock(block);
      if (decoded && decoded.length > 0) this.audio.push(decoded);
      at += length;
    }
  }

  /**
   * Makes the delta decoders, or remakes them if the picture changed size.
   *
   * A size change mid-sequence throws the reference frames away, because they
   * describe a differently-shaped picture. That loses the history the next
   * frame wanted, which is a visible glitch for one frame — and far better
   * than decoding against buffers of the wrong stride for the rest of the
   * sequence.
   */
  private sizeDecodersFor(width: number, height: number): void {
    if (width <= 0 || height <= 0) return;
    if (this.codec37 && this.codecSize.width === width && this.codecSize.height === height) {
      return;
    }
    if (
      this.codecSize.width !== 0 &&
      (this.codecSize.width !== width || this.codecSize.height !== height)
    ) {
      this.reportTag(
        'FOBJ',
        `changed size mid-sequence, from ${this.codecSize.width}x${this.codecSize.height} to ` +
          `${width}x${height}, so one frame may glitch as the reference frames are remade`,
      );
    }

    this.codecSize = { width, height };
    this.codec37 = createCodec37Decoder(width, height);
    this.codec47 = createCodec47Decoder(width, height);
  }

  private reportTag(tag: string, what: string): void {
    if (this.reportedTags.has(tag)) return;
    this.reportedTags.add(tag);
    this.onLog?.(`SMUSH chunk ${tag} ${what}.`);
  }

  private reportCodec(codec: number): void {
    if (this.reportedCodecs.has(codec)) return;
    this.reportedCodecs.add(codec);
    this.onLog?.(
      `SMUSH codec ${codec} is not implemented, so this sequence will not draw. ` +
        `Its audio and its length are unaffected.`,
    );
  }
}
