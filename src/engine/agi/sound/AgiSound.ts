/**
 * AGI sound: three square-wave tone channels and one noise channel.
 *
 * `src/engine/sound/opl2/` does not apply and is not used. OPL2 is FM synthesis
 * for the AdLib card, and AGI predates it — an AGI sound resource is four lists
 * of frequency-and-duration events for the PCjr/Tandy SN76496, which is three
 * tone generators and a noise generator and nothing else (#137).
 *
 * `MusicSequencer` is not reusable either. That is the one live iMUSE sequencer
 * v6 and v7 share (ADR 0008), and iMUSE is a transition model between musical
 * *states*; AGI has no states and no transitions, just four voices playing an
 * event list to completion.
 *
 * What *is* reusable is the plumbing, and it is mirrored rather than imported:
 * `SoundEngine`'s API is bound to `ResourceManager` and to the iMUSE sequencer,
 * so sharing the class would mean widening it to hold an AGI game. The
 * conventions it established — a lazily created context, `setEnabled`, and
 * `resume()` called from a user gesture — are what actually matter, and they
 * are the same here.
 */

import { readU16LE } from '../../util/ByteStream.js';

/** One note on one voice. */
export interface AgiNote {
  /** Duration in sixtieths of a second, as the resource stores it. */
  durationTicks: number;
  /**
   * The ten-bit divisor of the chip's clock. Zero is a rest.
   *
   * Kept as the divisor rather than as a frequency, because that is what the
   * resource holds and what an editor would show — the conversion is one
   * function and belongs at the point of playing.
   */
  divisor: number;
  /**
   * Attenuation, 0 to 15, where **0 is loudest and 15 is silent**.
   *
   * Backwards from every other volume in this codebase, and it is the chip's
   * own convention: each bit is worth 2, 4, 8 and 16 decibels of cut. Reading it
   * as a volume plays every quiet note loud and every loud note silent.
   */
  attenuation: number;
  /** Noise voice only: white noise rather than periodic. */
  white?: boolean;
}

export interface AgiSoundResource {
  /** Four voices: three tone, then noise. Always four, possibly empty. */
  readonly voices: ReadonlyArray<readonly AgiNote[]>;
}

/** Voices 0 to 2 are tone; voice 3 is noise. */
export const NOISE_VOICE = 3;

/**
 * The tone generator's clock, divided.
 *
 * The SN76496 runs at 3.579545 MHz and its tone generators divide it by 32,
 * giving 111,860 Hz — so a divisor of 428 is 261 Hz, which is middle C. The
 * arithmetic is here rather than inline because it is the one number in this
 * file that is neither in the resource nor in the spec's prose.
 */
export const TONE_CLOCK = 111860;

/**
 * The three noise rates, and the fourth setting that borrows voice 3's pitch.
 *
 * 1,193,180 divided by 512, 1024 and 2048. The fourth combination is not a
 * fixed rate at all: it takes the third tone voice's current frequency, which is
 * how a game makes a noise that slides.
 */
export const NOISE_RATES = [2330, 1165, 583, -1] as const;

/** A divisor as a frequency in hertz, or 0 for a rest. */
export function frequencyFor(divisor: number): number {
  if (divisor <= 0) return 0;
  return TONE_CLOCK / divisor;
}

/** Attenuation 0..15 as a linear gain, where 15 is silence. */
export function gainFor(attenuation: number): number {
  if (attenuation >= 15) return 0;
  // Each step is 2 dB, so fifteen steps is 30 dB down — which is the chip's own
  // range and is why the quietest audible step is not close to silent.
  return Math.pow(10, (-2 * attenuation) / 20);
}

/**
 * Reads a SOUND resource.
 *
 *   0..1  offset of voice 1 (tone, and the melody the PC speaker plays)
 *   2..3  offset of voice 2 (tone)
 *   4..5  offset of voice 3 (tone)
 *   6..7  offset of the noise voice
 *
 * Then five bytes per note:
 *
 *   0..1  duration, little-endian, in sixtieths of a second
 *   2     bit 7 clear, bits 5..0 the **top** six bits of the ten-bit divisor
 *   3     bit 7 set, bits 6..4 the chip register, bits 3..0 the **low** four
 *   4     bit 7 set, bits 6..4 the register, bits 3..0 the attenuation
 *
 * A voice ends at two consecutive 0xFF bytes, or at the next voice's offset.
 * Both are checked, because a resource whose terminator is missing would
 * otherwise read the next voice's notes as its own — which plays, and plays the
 * wrong tune.
 */
export function readSound(bytes: Uint8Array): AgiSoundResource {
  if (bytes.length < 8) {
    throw new Error(
      `A SOUND resource is ${bytes.length} bytes, which is shorter than its own ` +
        `eight-byte offset table.`,
    );
  }

  const offsets = [0, 1, 2, 3].map((index) => readU16LE(bytes, index * 2));
  const voices: AgiNote[][] = [];

  for (const [voice, start] of offsets.entries()) {
    const notes: AgiNote[] = [];
    // The next voice that starts after this one, which bounds the read even
    // when the 0xFF terminator is missing.
    const bound = offsets
      .filter((offset) => offset > start)
      .reduce((lowest, offset) => Math.min(lowest, offset), bytes.length);

    let at = start;
    while (at + 4 < Math.min(bound, bytes.length)) {
      if (bytes[at] === 0xff && bytes[at + 1] === 0xff) break;

      const durationTicks = readU16LE(bytes, at);
      // Six bits from byte 2 shifted up four, then four bits from byte 3. The
      // shift is by four rather than by six, which looks wrong and is not: the
      // low field is four bits wide, so that is how far the high field moves.
      const divisor = ((bytes[at + 2] & 0x3f) << 4) | (bytes[at + 3] & 0x0f);
      const attenuation = bytes[at + 4] & 0x0f;

      const note: AgiNote = { durationTicks, divisor, attenuation };
      if (voice === NOISE_VOICE) {
        // Bit 2 of byte 3 picks white noise over periodic, and bits 1..0 the
        // rate. Both live in the byte the tone voices use for pitch.
        note.white = (bytes[at + 3] & 0x04) !== 0;
      }
      notes.push(note);
      at += 5;
    }

    voices.push(notes);
  }

  return { voices };
}

/** How long a whole resource plays, in seconds. Voices run in parallel. */
export function soundDuration(sound: AgiSoundResource): number {
  let longest = 0;
  for (const voice of sound.voices) {
    const ticks = voice.reduce((total, note) => total + note.durationTicks, 0);
    longest = Math.max(longest, ticks);
  }
  return longest / 60;
}

/** The audio context surface, narrowed so tests can supply a stub. */
export interface AudioContextLike {
  readonly currentTime: number;
  readonly destination: AudioNode;
  readonly state: string;
  createOscillator(): OscillatorNode;
  createGain(): GainNode;
  createBufferSource(): AudioBufferSourceNode;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBuffer;
  readonly sampleRate: number;
  resume(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Plays AGI sound resources.
 *
 * Scheduled up front rather than stepped per frame: a resource is a fixed list
 * of notes with fixed durations, so the whole thing can be handed to the audio
 * clock in one go and will stay in time whatever the frame rate does. iMUSE
 * cannot work that way — its whole point is that a script changes the music
 * mid-phrase — but AGI has no such thing.
 */
export class AgiSoundPlayer {
  private context: AudioContextLike | null = null;
  private enabled = false;
  private readonly createContext: () => AudioContextLike | null;
  /** Nodes belonging to the sound now playing, so `stop` can end them. */
  private playing: Array<{ stop(when?: number): void }> = [];
  /** When the sound now playing will finish, on the audio clock. */
  private endsAt = 0;
  /** The flag to set when the current sound finishes, and its owner. */
  private endFlag: number | null = null;
  private onFinished: ((flag: number) => void) | null = null;

  onLog: (message: string) => void = () => undefined;

  constructor(createContext?: () => AudioContextLike | null) {
    this.createContext =
      createContext ??
      (() => {
        // A browser without Web Audio, or a test runner: silence rather than a
        // failure, which is what the SCUMM side does too.
        const Constructor =
          (globalThis as { AudioContext?: new () => AudioContextLike }).AudioContext ?? null;
        return Constructor ? new Constructor() : null;
      });
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.stop();
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Starts the audio context, which browsers only allow from a user gesture.
   *
   * The same dance the SCUMM side does, and the reason is the same: a context
   * created before any click is suspended, and a game that starts music on its
   * first cycle would be silent for the rest of the session.
   */
  async resume(): Promise<void> {
    if (!this.enabled) return;
    this.context ??= this.createContext();
    if (this.context && this.context.state !== 'running') {
      try {
        await this.context.resume();
      } catch {
        // Refused because there was no gesture after all. Nothing to retry.
      }
    }
  }

  /** Called when a sound finishes, so the engine can set the script's flag. */
  setFinishedHandler(handler: (flag: number) => void): void {
    this.onFinished = handler;
  }

  /**
   * Plays a resource, replacing whatever was playing.
   *
   * `endFlag` is the flag the script is waiting on. Games *wait* on it — a
   * script polls it every cycle and does nothing until it is set — so setting
   * it early cuts the sound off and setting it late stalls the game. It is set
   * from `step`, on the audio clock, rather than from a timer.
   */
  play(sound: AgiSoundResource, endFlag: number): void {
    this.stop();
    this.endFlag = endFlag;

    if (!this.enabled) {
      // With sound off the flag still has to be set, or every game that waits
      // on a sound waits for ever. Counted down in cycles so a silent game
      // paces exactly as a sounding one does.
      this.silentCycles = silentCyclesFor(sound);
      return;
    }

    this.context ??= this.createContext();
    const context = this.context;
    if (!context) {
      // No Web Audio at all — a test runner, or a browser without it. Silence,
      // paced the same way.
      this.silentCycles = silentCyclesFor(sound);
      return;
    }

    const start = context.currentTime;
    let latest = start;

    for (const [voice, notes] of sound.voices.entries()) {
      let at = start;
      for (const note of notes) {
        const seconds = note.durationTicks / 60;
        if (seconds <= 0) continue;

        const gain = gainFor(note.attenuation);
        if (gain > 0) {
          if (voice === NOISE_VOICE) this.scheduleNoise(context, note, at, seconds, gain);
          else this.scheduleTone(context, note, at, seconds, gain);
        }
        at += seconds;
      }
      latest = Math.max(latest, at);
    }

    this.endsAt = latest;
    this.silentCycles = 0;
  }

  private scheduleTone(
    context: AudioContextLike,
    note: AgiNote,
    at: number,
    seconds: number,
    gain: number,
  ): void {
    const frequency = frequencyFor(note.divisor);
    if (frequency <= 0) return;

    const oscillator = context.createOscillator();
    // A square wave, because that is what the chip produced: a sine sounds
    // wrong in a way anyone who has heard these games will notice immediately.
    oscillator.type = 'square';
    oscillator.frequency.value = frequency;

    const amplifier = context.createGain();
    amplifier.gain.value = gain * 0.15;
    oscillator.connect(amplifier);
    amplifier.connect(context.destination as AudioNode);

    oscillator.start(at);
    oscillator.stop(at + seconds);
    this.playing.push(oscillator);
  }

  /**
   * Schedules the noise channel as a buffer of random samples.
   *
   * An oscillator cannot make noise, so this is the one voice that needs a
   * buffer. The rate decides how often the sample changes, which is what makes
   * the difference between a hiss and a rumble; the fourth rate setting borrows
   * the third tone voice's pitch, and is treated as the lowest fixed rate here
   * because tracking a sibling voice's current frequency would mean stepping the
   * whole resource per frame rather than scheduling it.
   */
  private scheduleNoise(
    context: AudioContextLike,
    note: AgiNote,
    at: number,
    seconds: number,
    gain: number,
  ): void {
    const rateIndex = note.divisor & 0x03;
    const rate = NOISE_RATES[rateIndex] > 0 ? NOISE_RATES[rateIndex] : NOISE_RATES[2];

    const length = Math.max(1, Math.floor(context.sampleRate * seconds));
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const samples = buffer.getChannelData(0);

    // Periodic noise repeats a short pattern and white noise does not, which is
    // audibly different — periodic is the buzz, white is the hiss.
    const period = Math.max(1, Math.floor(context.sampleRate / rate));
    if (note.white) {
      for (let index = 0; index < length; index++) samples[index] = Math.random() * 2 - 1;
    } else {
      const pattern: number[] = [];
      for (let index = 0; index < period; index++) pattern.push(Math.random() * 2 - 1);
      for (let index = 0; index < length; index++) samples[index] = pattern[index % period];
    }

    const source = context.createBufferSource();
    source.buffer = buffer;
    const amplifier = context.createGain();
    amplifier.gain.value = gain * 0.12;
    source.connect(amplifier);
    amplifier.connect(context.destination as AudioNode);

    source.start(at);
    this.playing.push(source);
  }

  /**
   * Cycles left of a sound that is not actually being heard.
   *
   * Counted in **engine cycles**, not wall-clock seconds, and that distinction
   * is load-bearing. A game waits on the finished flag by polling it every
   * cycle, so the flag has to arrive on the game's own clock — otherwise a
   * headless run, which steps far faster than real time, never reaches the
   * wall-clock deadline and the game waits for ever.
   *
   * Enclosure hangs on exactly this: its logo room plays `sound(4, f91)` and
   * will not advance until `f91` is set, so with sound off and a wall-clock
   * deadline it sat at scene 104 of its intro indefinitely.
   */
  private silentCycles = 0;

  private now(): number {
    return this.context?.currentTime ?? 0;
  }

  /**
   * Sets the finished flag when the sound has actually finished.
   *
   * Called once per cycle. #137 is explicit that games *wait* on this flag, so
   * early or late breaks pacing — which is why the check is against the audio
   * clock rather than a frame count.
   */
  step(): void {
    if (this.endFlag === null) return;

    // A sound that is being heard finishes on the audio clock, because that is
    // what the player hears. A silent one finishes on the game's clock, because
    // there is nothing to hear and the only thing that matters is that the
    // script's wait lasts the right number of cycles.
    let finished: boolean;
    if (this.silentCycles > 0) {
      this.silentCycles--;
      finished = this.silentCycles === 0;
    } else {
      finished = this.playing.length === 0 || this.now() >= this.endsAt;
    }
    if (!finished) return;

    const flag = this.endFlag;
    this.endFlag = null;
    this.silentCycles = 0;
    this.playing = [];
    this.onFinished?.(flag);
  }

  /**
   * Stops the sound, without setting its flag.
   *
   * `stop.sound` is a script deciding the sound is over, and AGI does not set
   * the wait flag in that case — a script that stopped a sound is not waiting
   * for it.
   */
  stop(): void {
    for (const node of this.playing) {
      try {
        node.stop();
      } catch {
        // Already ended. Stopping a finished node throws in some browsers.
      }
    }
    this.playing = [];
    this.endFlag = null;
    this.silentCycles = 0;
  }

  /** Whether a sound is playing, which the diagnostics report. */
  get isPlaying(): boolean {
    return this.endFlag !== null;
  }
}

/**
 * How many engine cycles a silent sound should occupy.
 *
 * AGI's durations are in sixtieths of a second and the engine's cycle is one
 * frame, so the tick count *is* the cycle count. At least one, so a
 * zero-length sound still takes a cycle to finish rather than finishing before
 * the script that started it has returned.
 */
function silentCyclesFor(sound: AgiSoundResource): number {
  const ticks = Math.round(soundDuration(sound) * 60);
  return Math.max(1, ticks);
}
