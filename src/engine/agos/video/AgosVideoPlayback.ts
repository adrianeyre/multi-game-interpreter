/**
 * Playing a video at the AGOS screen, driven by the Engine.
 *
 * The same shape as `VideoPlayback` for SMUSH, and for the same three reasons —
 * which is the point of writing it this way rather than inventing a second
 * arrangement for a second family:
 *
 * - **The world stops.** In the original, a script asks for a video and does
 *   not continue until it ends, because playback runs its own loop. Here the
 *   host drives one loop, so "the script blocks" is expressed as "the Engine
 *   steps the video instead of the world" — including while the file is still
 *   being fetched, which the original never had to think about.
 * - **The palette is borrowed, not replaced.** A Smacker sets all 256 colours
 *   and the room underneath still needs its own back afterwards.
 * - **A video that will not open is a missing cutscene, not a crash.** Every
 *   failure path ends with the world running again and a line naming the file
 *   and the reason — which for AGOS 2 includes the case that matters most in
 *   practice, a folder of ScummVM's DXA re-encodes rather than the discs'
 *   Smacker files.
 *
 * ## Why the clock is the frame rate and not the audio
 *
 * SMUSH is paced by its audio, because a `.SAN` interleaves audio ahead of the
 * picture and the queue is the only honest clock. Smacker carries a frame rate
 * in its header and each frame's audio with that frame, so the header is the
 * clock and the audio follows it. Pacing this off the audio queue would make a
 * silent video play as fast as the host could decode it.
 */

import { Smacker, type SmackerAudio } from './smacker.js';
import { identifyAgosVideo, describeUndecodableVideo } from './agosVideo.js';

/** One Engine step, matching the host's fixed 60 Hz cadence. */
export const SECONDS_PER_STEP = 1 / 60;

type PlaybackState = 'idle' | 'loading' | 'playing';

export interface AgosVideoTarget {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

export class AgosVideoPlayback {
  private state: PlaybackState = 'idle';
  private film: Smacker | null = null;
  private name = '';
  private elapsed = 0;
  private shown = -1;

  /** The room's palette, held while the video borrows all 256 colours. */
  private borrowed: Uint8Array | null = null;

  /** Handed a 768-byte RGB palette whenever a frame moved it. */
  onPalette: ((rgb: Uint8Array) => void) | null = null;

  /** Handed the room's palette back when the sequence ends. */
  onPaletteRestored: ((rgb: Uint8Array) => void) | null = null;

  /** Handed a frame's audio as it is decoded, in order. */
  onAudio: ((audio: SmackerAudio) => void) | null = null;

  onLog: ((message: string) => void) | null = null;

  /**
   * Whether the Engine should step the video rather than the world.
   *
   * True while loading as well as while playing: a script that asked for a
   * video and kept running would reach the next scene before its cutscene had
   * started.
   */
  get active(): boolean {
    return this.state !== 'idle';
  }

  /** The file loading or playing, for a diagnostic to name. */
  get playing(): string | null {
    return this.state === 'idle' ? null : this.name;
  }

  /** What the header said, once a file is open. */
  get info(): Smacker['info'] | null {
    return this.film?.info ?? null;
  }

  /**
   * Marks a video as loading and takes the room's palette.
   *
   * The palette is captured here rather than when the frames start, because the
   * fetch is where a game with a missing file spends its time and the colours
   * have to survive that path too.
   */
  beginLoad(name: string, roomPalette: Uint8Array): void {
    this.name = name;
    this.state = 'loading';
    this.borrowed = new Uint8Array(roomPalette);
    this.elapsed = 0;
    this.shown = -1;
  }

  /**
   * Opens the bytes that arrived, or gives up on them by name.
   *
   * Returns false having already put the world back, so a caller does not have
   * to unwind anything itself.
   */
  open(data: Uint8Array): boolean {
    // A video the game moved on from while its file was still being fetched.
    if (this.state !== 'loading') return false;

    const identity = identifyAgosVideo(data);
    if (!identity.decodable) {
      this.fail(describeUndecodableVideo(this.name, identity));
      return false;
    }

    const film = Smacker.open(data);
    if (!film) {
      this.fail(`${this.name} opens like a Smacker file but its header could not be read`);
      return false;
    }

    this.film = film;
    this.state = 'playing';
    this.onLog?.(
      `Playing ${this.name}: ${film.info.frameCount} frames of ${film.info.width}x` +
        `${film.info.displayHeight} at ${(1 / film.info.frameSeconds).toFixed(1)} fps`,
    );
    return true;
  }

  /** Gives up on a video, naming why, and puts the world back. */
  fail(reason: string): void {
    this.onLog?.(reason);
    this.end();
  }

  /**
   * Steps the video by one Engine frame, drawing into `target`.
   *
   * Returns false once the sequence is over, which is the caller's signal to
   * resume stepping the world on the *next* frame rather than this one: the
   * last frame of a cutscene is still a frame, and dropping it to save a step
   * is visible as a cut.
   */
  advance(target: AgosVideoTarget): boolean {
    if (this.state !== 'playing' || !this.film) return this.state === 'loading';

    // The frame due now, before this step is counted: the first step of a
    // sequence shows its first frame, and counting the step first would skip it
    // whenever the video's rate is at or above the host's.
    const due = Math.floor(this.elapsed / this.film.info.frameSeconds);
    this.elapsed += SECONDS_PER_STEP;

    // Frames are decoded up to the one now due rather than one per step. A
    // video faster than the host's 60 Hz would otherwise play in slow motion,
    // and every frame has to be decoded whether or not it is shown, because
    // each is a difference against the one before it.
    let frame = null;
    while (this.shown < due) {
      const next = this.film.nextFrame();
      if (!next) {
        this.end();
        return false;
      }
      this.shown += 1;
      frame = next;
    }

    if (frame) {
      if (frame.paletteChanged) this.onPalette?.(frame.palette);
      for (const audio of frame.audio) this.onAudio?.(audio);
      this.blit(frame.pixels, target);
    }
    return true;
  }

  /**
   * Ends the sequence now.
   *
   * What running out of frames does, and what a script cutting one short asks
   * for. The two want the same thing here — Smacker audio is decoded with its
   * own frame rather than queued ahead of the picture, so there is no tail to
   * either keep or cut.
   */
  end(): void {
    this.state = 'idle';
    this.film = null;
    if (this.borrowed) {
      this.onPaletteRestored?.(this.borrowed);
      this.borrowed = null;
    }
  }

  /**
   * Puts a decoded frame on the screen, centred and doubled if the file says.
   *
   * Centred rather than stretched: a Smacker smaller than the screen is a video
   * the game meant to sit in a window, and scaling it up would be this
   * interpreter inventing a picture the game never showed.
   */
  private blit(pixels: Uint8Array, target: AgosVideoTarget): void {
    const film = this.film;
    if (!film) return;
    const { width, height, displayHeight } = film.info;
    const doubled = displayHeight === height * 2;

    const left = Math.floor((target.width - width) / 2);
    const top = Math.floor((target.height - displayHeight) / 2);

    for (let row = 0; row < displayHeight; row += 1) {
      const targetRow = top + row;
      if (targetRow < 0 || targetRow >= target.height) continue;
      const sourceRow = doubled ? Math.floor(row / 2) : row;
      for (let column = 0; column < width; column += 1) {
        const targetColumn = left + column;
        if (targetColumn < 0 || targetColumn >= target.width) continue;
        target.pixels[targetRow * target.width + targetColumn] =
          pixels[sourceRow * width + column] ?? 0;
      }
    }
  }
}
