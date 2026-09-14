/**
 * Playing a video at the screen: the part that makes SEQ, VMD and DUK *play*.
 *
 * `sciVideo.ts` reads the containers and decodes the frames; this owns the
 * business of one being on screen — when the next frame is due, what the
 * framebuffer shows while it is, and what happens when somebody presses a key.
 *
 * ## A video blocks, because Sierra's did
 *
 * `kShowMovie` and `kPlayVMD`'s play sub-function do not return until the video
 * is over or the player has skipped it. A script therefore assumes the world is
 * exactly as it left it, and an engine that kept running cycles underneath
 * would advance actors, timers and rooms behind a full-screen picture. So the
 * engine stops stepping the PMachine while this is playing, and this owns the
 * clock instead.
 *
 * ## Skippable is not a courtesy
 *
 * Every one of these formats is skipped by a keypress or a click in Sierra's
 * own interpreter, and a nine-minute Phantasmagoria VMD that cannot be skipped
 * is a game that cannot be played. So any queued event ends it — and the event
 * is *consumed*, because a skip that leaves the keystroke in the queue arrives
 * in the room afterwards as a stray command.
 *
 * ## What is on screen for a frame that did not decode
 *
 * The frame before it, unchanged, and the count reported. That is the DUK case
 * and only the DUK case (`SciAvi.ts` says why it is a colour path rather than a
 * decoder), and it is the reason `describe` exists: a player that shows a still
 * for nine minutes should be able to say that is what it is doing rather than
 * leaving somebody to conclude the game has hung.
 */

import type { Palette } from '../../gfx/Palette.js';
import type { VolumeReader } from '../../resource/VolumeReader.js';
import { SCI_EVENT, type SciInput } from '../SciInput.js';
import { openSciVideo, type SciVideoFrame, type SciVideoStream } from './sciVideo.js';

/** What a script asked to be played, and how. */
export interface SciMovieRequest {
  /** The file, as the game named it. */
  file: string;
  /** Where the top-left corner goes, for a video smaller than the screen. */
  x?: number;
  y?: number;
  /**
   * Ticks between frames, where the game says.
   *
   * SCI16's `ShowMovie` passes one, because a SEQ carries no rate of its own.
   * A VMD does, and its own is preferred.
   */
  ticksPerFrame?: number;
}

/** Sixty ticks a second, which is SCI's clock. */
const TICKS_PER_SECOND = 60;

/** What a video with no rate anywhere runs at. */
const DEFAULT_TICKS_PER_FRAME = 6;

export class SciMoviePlayer {
  private queued: SciMovieRequest | null = null;
  private request: SciMovieRequest | null = null;
  private stream: SciVideoStream | null = null;
  private current: SciVideoFrame | null = null;
  private frameIndex = -1;
  private startedAt = 0;
  private opening = false;
  private finished = false;
  private skipped = false;
  /** Frames whose pixels this project does not decode, over the whole session. */
  private undecoded = 0;
  /** The largest a single video's reads have got, for #226's memory question. */
  private peakBytes = 0;

  constructor(
    private readonly volumes: VolumeReader,
    private readonly input: SciInput,
    private readonly log: (message: string) => void,
  ) {}

  /**
   * Asks for a video, from a Kernel call that cannot wait for it.
   *
   * Queued rather than opened, because opening reads a Volume and a Kernel call
   * happens in the middle of a send. The engine opens it between cycles, which
   * is the same arrangement `pendingScripts` uses and for the same reason.
   */
  play(request: SciMovieRequest): void {
    this.queued = request;
    this.finished = false;
    this.skipped = false;
  }

  /** True while a video is queued, opening or on screen. */
  get busy(): boolean {
    return this.queued !== null || this.stream !== null || this.opening;
  }

  /** The frame on screen, for the renderer. */
  get frame(): SciVideoFrame | null {
    return this.current;
  }

  /** Where the video's corner goes on screen. */
  get position(): { x: number; y: number } {
    return { x: this.request?.x ?? 0, y: this.request?.y ?? 0 };
  }

  /** True once the video ran out or was skipped, until the next one. */
  get done(): boolean {
    return this.finished;
  }

  /** How far a video got, for a script that asks. */
  get frameNumber(): number {
    return Math.max(0, this.frameIndex);
  }

  /**
   * Advances the video, opening it first if it has only just been asked for.
   *
   * Called between cycles rather than during one. `ticks` is the engine's own
   * clock so that a video plays at the rate it was authored for rather than at
   * whatever rate the browser happens to call `step`.
   */
  async pump(ticks: number): Promise<void> {
    if (this.queued && !this.opening) {
      const request = this.queued;
      this.queued = null;
      this.opening = true;
      this.request = request;
      try {
        this.stream = await openSciVideo(this.volumes, request.file);
      } finally {
        this.opening = false;
      }
      if (!this.stream) {
        // Named rather than swallowed. A video the engine cannot open is a
        // scene the player will not see, and "which file" is the whole of what
        // somebody needs to act on it.
        this.log(`Video ${request.file} could not be opened, so it is skipped.`);
        this.finish();
        return;
      }
      this.log(
        `Playing ${request.file}: ${this.stream.info.format.toUpperCase()}, ` +
          `${this.stream.info.frameCount} frames at ${this.stream.info.width}x${this.stream.info.height}.`,
      );
      this.startedAt = ticks;
      this.frameIndex = -1;
    }

    const stream = this.stream;
    if (!stream) return;

    // Any input at all ends it, and the event is taken rather than left to
    // arrive in the room afterwards as a stray command.
    const skip = this.input.next(SCI_EVENT.keyDown | SCI_EVENT.mouseDown);
    if (skip) {
      this.skipped = true;
      this.log(`Skipped ${this.request?.file ?? 'video'} at frame ${this.frameNumber}.`);
      this.finish();
      return;
    }

    const perFrame = this.ticksPerFrame(stream);
    const wanted = Math.floor((ticks - this.startedAt) / perFrame);
    if (wanted <= this.frameIndex) return;

    // One frame a cycle at most. Catching up by decoding four frames in a cycle
    // costs the frame budget for a video nobody can see the missing frames of.
    const next = Math.min(wanted, this.frameIndex + 1);
    if (next >= stream.info.frameCount && stream.info.frameCount > 0) {
      this.finish();
      return;
    }

    const frame = await stream.frame(next);
    if (!frame) {
      this.finish();
      return;
    }
    this.frameIndex = next;
    this.current = frame;
    this.peakBytes = Math.max(this.peakBytes, stream.bytesRead());
  }

  /** Ends the video and lets the engine step the PMachine again. */
  private finish(): void {
    if (this.stream) {
      this.undecoded += this.stream.undecodedFrames;
      this.peakBytes = Math.max(this.peakBytes, this.stream.bytesRead());
    }
    this.stream = null;
    this.current = null;
    this.request = null;
    this.finished = true;
  }

  /** Ends the video from outside, which is what a `Close` sub-function does. */
  close(): void {
    this.queued = null;
    this.finish();
  }

  /**
   * How long a frame is on screen for.
   *
   * The file's own rate wins, because a VMD's is derived from its sound slice
   * size and is exact. A SEQ has none, so the game's `ShowMovie` argument is
   * used, and a video with neither runs at ten a second rather than as fast as
   * the loop turns.
   */
  private ticksPerFrame(stream: SciVideoStream): number {
    if (stream.frameRate > 0) return Math.max(1, Math.round(TICKS_PER_SECOND / stream.frameRate));
    return Math.max(1, this.request?.ticksPerFrame ?? DEFAULT_TICKS_PER_FRAME);
  }

  /**
   * Draws the current frame into the framebuffer.
   *
   * Straight in rather than through the compositor, and the distinction is
   * #226's: this is a video *played at the screen*, so it is not a screen item
   * and has no priority. A Robot is the other case and goes through `Plane`.
   */
  paint(pixels: Uint8Array, width: number, height: number, palette: Palette): void {
    const frame = this.current;
    if (!frame?.cel) return;

    if (frame.palette) {
      for (const entry of frame.palette) palette.setColor(entry.index, entry.r, entry.g, entry.b);
    }

    const left = frame.x || this.request?.x || 0;
    const top = frame.y || this.request?.y || 0;
    for (let y = 0; y < frame.cel.height; y++) {
      const row = top + y;
      if (row < 0 || row >= height) continue;
      for (let x = 0; x < frame.cel.width; x++) {
        const column = left + x;
        if (column < 0 || column >= width) continue;
        pixels[row * width + column] = frame.cel.pixels[y * frame.cel.width + x];
      }
    }
  }

  /**
   * The palette a video opens with, applied once when it opens.
   *
   * Separate from the per-frame palettes because a SEQ carries its whole
   * palette in the container and its frames carry none — so a player that only
   * applied per-frame palettes would show every SEQ in the room's colours.
   */
  applyOpeningPalette(palette: Palette): void {
    for (const entry of this.stream?.palette ?? []) {
      palette.setColor(entry.index, entry.r, entry.g, entry.b);
    }
  }

  /** What this played and how much it cost, for the diagnostic (#226). */
  describe(): string | null {
    if (this.peakBytes === 0) return null;
    const undecodable =
      this.undecoded > 0
        ? ` ${this.undecoded} frames were not decoded — see SciAvi.ts on the colour path.`
        : '';
    return (
      `Video: peak ${this.peakBytes.toLocaleString()} bytes read for the largest video played` +
      `${this.skipped ? ', last one skipped' : ''}.${undecodable}`
    );
  }
}
