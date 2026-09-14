import { DEFAULT_SMUSH_FPS, SmushPlayer, type SmushAudio } from './SmushPlayer.js';
import type { NutFont } from './nut.js';
import { drawTextCue } from './nutText.js';

/**
 * What the engine holds to play a `.SAN`, and the state machine around it.
 *
 * The decoder and the clock live in `SmushPlayer`; this is the part that has to
 * agree with the rest of the engine about three things:
 *
 * - **The world stops.** In the original a script asks for a video and does not
 *   continue until it ends, because playback runs its own loop. Here the host
 *   drives one loop, so "the script blocks" has to be expressed as "the engine
 *   steps the video instead of the world" — including while the file is still
 *   being fetched, which the original never had to think about.
 * - **The palette is borrowed, not replaced.** A video sets all 256 colours and
 *   the room underneath it still needs its own back afterwards, so the room's
 *   are put aside on the way in and restored on the way out. Without that, the
 *   first room after a cutscene wears the cutscene's colours.
 * - **A video that will not open is a missing cutscene, not a crash.** Every
 *   failure path here ends with the world running again and a line saying which
 *   file and why.
 */

/** One engine step, matching the host's fixed 60 Hz cadence. */
export const SECONDS_PER_STEP = 1 / 60;

type PlaybackState = 'idle' | 'loading' | 'playing';

export class VideoPlayback {
  private readonly player = new SmushPlayer();
  private state: PlaybackState = 'idle';

  /** The file being loaded or played, for the log lines that name it. */
  private name = '';

  /** The room's palette, held while the video borrows all 256 colours. */
  private borrowedPalette: Uint8Array | null = null;

  /** Handed a palette whenever a frame moved it. */
  onPalette: ((rgb: Uint8Array) => void) | null = null;

  /** Handed the room's palette back when the sequence ends. */
  onPaletteRestored: ((rgb: Uint8Array) => void) | null = null;

  /** Handed decoded audio as it is gathered, in order. */
  onAudio: ((audio: SmushAudio) => void) | null = null;

  /**
   * How long the audio already handed over still has to run.
   *
   * Asked because the frames are not the end of a sequence. Audio is queued
   * ahead of the picture — that is what makes it the clock — so a cutscene's
   * last frame is decoded while its closing line is still playing. Ending on
   * the last frame cuts that line off mid-word, every time, and the shorter
   * the tail the more it sounds like a decoding fault rather than a timing one.
   */
  audioRemaining: (() => number) | null = null;

  onLog: ((message: string) => void) | null = null;

  /**
   * The `.NUT` fonts a subtitle is drawn with, indexed as `^f` indexes them.
   *
   * Empty until a game with fonts beside it is loaded, and a sequence with text
   * but no font says so once rather than playing silently text-free.
   */
  fonts: ReadonlyArray<NutFont | null> = [];

  /**
   * The lines a `TRES` cue names by id, for the sequence being played.
   *
   * Per sequence rather than per game: a video's table is named after the
   * video, and the ids restart in each one — so a table left over from the last
   * cutscene would resolve to the wrong words rather than to none.
   */
  strings: ReadonlyMap<number, string> | null = null;

  constructor() {
    this.player.onLog = (message) => this.onLog?.(message);
  }

  /**
   * Whether the engine should step the video rather than the world.
   *
   * True while loading as well as while playing. A script that asked for a
   * video and then kept running would reach the next scene before its cutscene
   * had started.
   */
  get active(): boolean {
    return this.state !== 'idle';
  }

  /** The file currently loading or playing, for a diagnostic to report. */
  get playing(): string | null {
    return this.state === 'idle' ? null : this.name;
  }

  /**
   * Takes the room's palette and marks a video as loading.
   *
   * The palette is captured here rather than when the frames start, because the
   * fetch is where a game with a missing file spends its time and the colours
   * have to survive that path too.
   */
  beginLoad(name: string, roomPalette: Uint8Array, requestedFps = DEFAULT_SMUSH_FPS): void {
    this.name = name;
    this.state = 'loading';
    this.borrowedPalette = new Uint8Array(roomPalette);
    this.requestedFps = requestedFps;
    this.strings = null;
  }

  /** The rate a script asked for, which the file's own header may override. */
  private requestedFps = DEFAULT_SMUSH_FPS;

  /**
   * Opens a loaded `.SAN`, or gives up on it.
   *
   * Returns false when the bytes are not a SMUSH animation, having already put
   * the world back — so a caller does not have to unwind anything itself.
   */
  open(bytes: Uint8Array): boolean {
    // A video the player skipped while its file was still being fetched. Not a
    // failure and nothing to unwind: `end` has already put the world back.
    if (this.state !== 'loading') return false;

    const sequence = this.player.open(bytes, this.requestedFps);
    if (!sequence) {
      this.fail(`${this.name} is not a SMUSH animation, so the sequence is skipped`);
      return false;
    }

    this.state = 'playing';
    this.onLog?.(`Playing ${this.name}: ${sequence.frameCount} frames at ${sequence.fps} fps`);
    return true;
  }

  /** Gives up on a video, naming why, and puts the world back. */
  fail(reason: string): void {
    this.onLog?.(reason);
    this.end();
  }

  /**
   * Steps the video by one engine frame, drawing into `target`.
   *
   * Returns false once the sequence is over, which is the caller's signal to
   * resume stepping the world on the *next* frame rather than this one: the
   * last frame of a cutscene is still a frame, and dropping it to save a step
   * is visible as a cut.
   */
  advance(target: Uint8Array): boolean {
    if (this.state !== 'playing') return this.state === 'loading';

    // Checked before stepping, not after. Ending on the same frame that draws
    // the last picture restores the room's palette over it, so the closing
    // frame of every cutscene wears the wrong colours for exactly one frame.
    if (this.player.finished) {
      // And the frames running out is not the sequence being over: the last
      // frame is held while the audio queued behind it drains, because that
      // audio is the closing line.
      if ((this.audioRemaining?.() ?? 0) > 0) return true;
      this.end();
      return false;
    }

    this.player.step(SECONDS_PER_STEP, target);

    const palette = this.player.takePaletteChange();
    if (palette) this.onPalette?.(palette);

    const audio = this.player.takeAudio();
    if (audio && audio.samples.length > 0) this.onAudio?.(audio);

    this.drawSubtitles(target);

    return true;
  }

  /**
   * Ends the sequence now.
   *
   * What the cutscene-skip key does, and what a script cutting a sequence short
   * asks for. Separate from running out of frames only in who decided.
   */
  end(): void {
    // A sequence that ran to its end leaves its audio alone: it has already
    // been waited for, and cutting it here would undo that. One the player
    // skipped is cut, which is the whole point of skipping it.
    this.finish(this.player.finished);
  }

  /**
   * Ends the sequence and cuts its audio, whatever is left of it.
   *
   * What the cutscene-skip key asks for, as distinct from a sequence that has
   * simply run out — the two want opposite things from the audio queue.
   */
  skip(): void {
    this.finish(false);
  }

  private finish(keepAudio: boolean): void {
    this.state = 'idle';
    if (!keepAudio) this.onAudioStopped?.();
    if (this.borrowedPalette) {
      this.onPaletteRestored?.(this.borrowedPalette);
      this.borrowedPalette = null;
    }
  }

  /** Called when a sequence ends before its audio would have. */
  onAudioStopped: (() => void) | null = null;

  private readonly reported = new Set<string>();

  /**
   * Draws whatever text the frame asked for, over the picture.
   *
   * After the frame and before nothing: a subtitle is the last thing composited
   * in a cutscene, and drawing it before the frame object would have the video
   * paint over its own words.
   */
  private drawSubtitles(target: Uint8Array): void {
    for (const cue of this.player.textCues) {
      const line = cue.text ?? this.strings?.get(cue.stringId ?? -1) ?? null;
      if (line === null) {
        // A `TRES` cue names its line by id in a table beside the game. Named
        // rather than drawn blank: a missing table and a misread one look the
        // same on screen, and the id says which.
        this.reportOnce(
          'strings',
          this.strings
            ? `${this.name} asks for subtitle ${cue.stringId}, which its string table ` +
                `does not have.`
            : `${this.name} refers to subtitles by id and no string table was found ` +
                `beside it, so those lines will not appear.`,
        );
        continue;
      }
      if (this.fonts.length === 0) {
        this.reportOnce(
          'fonts',
          `${this.name} carries subtitles but no .NUT font was found beside the game, ` +
            `so its cutscenes will play without their text.`,
        );
        continue;
      }
      drawTextCue(cue, line, this.fonts, target);
    }
  }

  private reportOnce(key: string, message: string): void {
    if (this.reported.has(key)) return;
    this.reported.add(key);
    this.onLog?.(message);
  }
}
