import {
  FREQMOD_LENGTHS,
  FREQMOD_OFFSETS,
  FREQMOD_TABLE,
  HULLS,
  HULL_OFFSETS,
  NOTE_LENGTHS,
  SPK_FREQ_TABLE,
} from './speakerTables.js';

/**
 * The PC speaker, which is one square wave and nothing else.
 *
 * Two quite different kinds of score reach it:
 *
 * - v5 and v6 ship an `SPK ` arrangement beside the AdLib and Roland ones, and
 *   it is an ordinary iMUSE MIDI score. ScummVM plays it through
 *   `IMuseDriver_PCSpk` (engines/scumm/imuse/drivers/pcspk.cpp), which
 *   `PcSpeakerDriver` ports: the speaker can sound one pitch, so of all the
 *   parts holding a note, the one with the highest priority is heard, shaped
 *   by the instrument's vibrato and envelopes.
 * - v1 to v4 have no MIDI at all. Their speaker data (`WA` blocks) is a small
 *   bytecode for the original driver's four channels, with envelopes and
 *   vibrato, played by ScummVM's `Player_V2` — which `SpeakerSoundPlayer`
 *   ports.
 *
 * Both come out as a square wave through the same one-pole low-pass
 * `Player_V2::lowPassFilter` uses, which stands in for the speaker cone: a
 * mathematically perfect square is harsher than any speaker ever made one.
 */

/** The 8253 timer's input clock, which a speaker frequency is a divisor of. */
const PIT_CLOCK = 1193180;

/** How loud the square is, of full scale. The speaker was not subtle. */
const AMPLITUDE = 0.3;

/**
 * The low-pass coefficient, per `Player_V2`'s `SPK_DECAY` of 0xa000/65536.
 *
 * The original squares it once for each halving of the sample rate below
 * 30 kHz, so that the smoothing spans the same stretch of time whatever the
 * rate; at or above 30 kHz it is used as it is.
 */
function decayFor(sampleRate: number): number {
  let decay = 0xa000 / 65536;
  for (let i = 0; sampleRate * Math.pow(2, i) < 30000 && i < 8; i++) decay *= decay;
  return decay;
}

/** A square-wave oscillator with the speaker's smoothing. */
class SquareOutput {
  private phase = 0;
  private level = 0;
  private readonly decay: number;

  constructor(private readonly sampleRate: number) {
    this.decay = decayFor(sampleRate);
  }

  /** Renders `out`, at `frequency` Hz, or silence (decaying) for 0. */
  render(out: Float32Array, frequency: number, from = 0, to = out.length): void {
    const step = frequency > 0 ? frequency / this.sampleRate : 0;
    for (let i = from; i < to; i++) {
      let target = 0;
      if (step > 0) {
        this.phase += step;
        if (this.phase >= 1) this.phase -= Math.floor(this.phase);
        target = this.phase < 0.5 ? AMPLITUDE : -AMPLITUDE;
      }
      this.level = this.level * this.decay + target * (1 - this.decay);
      out[i] = this.level;
    }
  }
}

/**
 * The iMUSE speaker driver lives in its own module, being a port of a
 * different ScummVM file; it is re-exported here so both speaker paths are
 * found in one place.
 */
export { PcSpeakerDriver } from './pcSpeakerImuse.js';

/** The rate `Player_V2` ticks its channel scripts at. "Don't change!" */
const SPEAKER_TICK_HZ = 236;

/** Words in the original's `channel_data`, which the bytecode addresses by offset. */
const CHANNEL_WORDS = 25;

// Field offsets into a channel, in words, as `channel_data` lays them out.
const TIME_LEFT = 0;
const NEXT_CMD = 1;
const BASE_FREQ = 2;
const FREQ_DELTA = 3;
const FREQ = 4;
const VOLUME = 5;
const VOLUME_DELTA = 6;
const TEMPO = 7;
const INTER_NOTE_PAUSE = 8;
const TRANSPOSE = 9;
const NOTE_LENGTH = 10;
const HULL_CURVE = 11;
const HULL_OFFSET = 12;
const HULL_COUNTER = 13;
const FREQMOD_TABLE_AT = 14;
const FREQMOD_OFFSET = 15;
const FREQMOD_INCR = 16;
const FREQMOD_MULTIPLIER = 17;
const FREQMOD_MODULO = 18;

const readU16LE = (data: Uint8Array, at: number): number =>
  (data[at] ?? 0) | ((data[at + 1] ?? 0) << 8);

/**
 * Plays a v1-v4 PC speaker sound: `Player_V2`'s bytecode, on one square wave.
 *
 * The data is a header, a priority byte, a "restartable" byte and four
 * little-endian offsets — one per channel — to that channel's script. Each
 * script sets parameters, plays notes with envelopes ("hulls") and vibrato, and
 * loops or calls subroutines; `execute_cmd` and `next_freqs` are ported line
 * for line, including their unsigned sixteen-bit arithmetic, because these
 * scores lean on wrap-around to express negative deltas.
 *
 * Of the four channels the speaker plays the first that is both audible and
 * running, as `generateSpkSamples` chooses — so the lead line wins and the
 * accompaniment is heard in its gaps, which is how these games sounded.
 */
export class SpeakerSoundPlayer {
  private readonly channels: Uint16Array[] = Array.from(
    { length: 5 },
    () => new Uint16Array(CHANNEL_WORDS),
  );
  private readonly output: SquareOutput;
  private returnAddress = 0;
  private samplesToTick = 0;
  private running = true;

  /** Ticks played, which is what `getMusicTimer` counts in a v3 game. */
  ticks = 0;

  /**
   * @param data the speaker block, starting at its own header.
   * @param headerLength 6 for v3 and v4 (`size` u32, tag), 4 for v1 and v2's
   *   old bundle — `Player_V2Base::_header_len`.
   */
  constructor(
    private readonly data: Uint8Array,
    readonly sampleRate: number,
    headerLength = 6,
  ) {
    this.output = new SquareOutput(sampleRate);
    const offset = headerLength + 2;
    for (let i = 0; i < 4; i++) {
      const next = readU16LE(data, offset + 2 * i);
      this.channels[i][NEXT_CMD] = next;
      if (next) this.channels[i][TIME_LEFT] = 1;
    }
    this.running = this.channels.some((channel) => channel[TIME_LEFT] !== 0);
  }

  /** Whether any channel still has script to run. */
  get active(): boolean {
    return this.running;
  }

  render(out: Float32Array): void {
    const tickLength = this.sampleRate / SPEAKER_TICK_HZ;
    let written = 0;
    while (written < out.length) {
      if (this.samplesToTick < 1) {
        this.samplesToTick += tickLength;
        this.nextTick();
      }
      const span = Math.min(out.length - written, Math.floor(this.samplesToTick));
      this.output.render(out, this.frequency(), written, written + span);
      written += span;
      this.samplesToTick -= span;
    }
  }

  /** The winning channel's pitch, as `generateSpkSamples` picks it. */
  private frequency(): number {
    for (let i = 0; i < 4; i++) {
      const channel = this.channels[i];
      if (channel[VOLUME] && channel[TIME_LEFT]) {
        // A timer divisor: `squareGenerator` toggles the output every
        // `rate * freq / (2 * clock)` samples, so one cycle is `clock / freq` Hz.
        return channel[FREQ] > 0 ? PIT_CLOCK / channel[FREQ] : 0;
      }
    }
    return 0;
  }

  private nextTick(): void {
    for (let i = 0; i < 4; i++) {
      if (this.channels[i][TIME_LEFT]) this.nextFreqs(this.channels[i]);
    }
    this.ticks++;
  }

  private nextFreqs(channel: Uint16Array): void {
    channel[VOLUME] += channel[VOLUME_DELTA];
    channel[BASE_FREQ] += channel[FREQ_DELTA];

    if (channel[FREQMOD_MODULO] > 0) {
      channel[FREQMOD_OFFSET] =
        (channel[FREQMOD_OFFSET] + channel[FREQMOD_INCR]) % channel[FREQMOD_MODULO];
    } else {
      channel[FREQMOD_OFFSET] = 0;
    }

    const modulation =
      FREQMOD_TABLE[channel[FREQMOD_TABLE_AT] + (channel[FREQMOD_OFFSET] >> 4)] ?? 0;
    channel[FREQ] =
      Math.trunc((modulation * channel[FREQMOD_MULTIPLIER]) / 256) + channel[BASE_FREQ];

    if (channel[NOTE_LENGTH] && !--channel[NOTE_LENGTH]) {
      channel[HULL_OFFSET] = 16;
      channel[HULL_COUNTER] = 1;
    }

    if (!--channel[TIME_LEFT]) this.executeCommand(channel);

    if (channel[HULL_COUNTER] && !--channel[HULL_COUNTER]) {
      for (let guard = 0; guard < 64; guard++) {
        const at = channel[HULL_CURVE] + (channel[HULL_OFFSET] >> 1);
        const value = HULLS[at] ?? 0;
        const count = HULLS[at + 1] ?? 0;
        if (count === -1) {
          channel[VOLUME] = value;
          if (value === 0) channel[VOLUME_DELTA] = 0;
          channel[HULL_OFFSET] += 4;
        } else {
          channel[VOLUME_DELTA] = value;
          channel[HULL_COUNTER] = count;
          channel[HULL_OFFSET] += 4;
          break;
        }
      }
    }
  }

  /** `Player_V2Base::execute_cmd`: run a channel's script until it waits. */
  private executeCommand(start: Uint16Array): void {
    const data = this.data;
    let channel = start;

    if (channel[NEXT_CMD] !== 0) {
      let at = channel[NEXT_CMD];
      // A malformed script must not hang the audio thread.
      let budget = 4096;
      script: while (budget-- > 0 && at >= 0 && at < data.length) {
        let opcode = data[at++];
        if (opcode >= 0xf8) {
          switch (opcode) {
            case 0xf8:
              channel[HULL_CURVE] = HULL_OFFSETS[data[at] >> 1] ?? 0;
              at++;
              break;
            case 0xf9:
              channel[FREQMOD_TABLE_AT] = FREQMOD_OFFSETS[data[at] >> 2] ?? 0;
              channel[FREQMOD_MODULO] = FREQMOD_LENGTHS[data[at] >> 2] ?? 0;
              at++;
              break;
            case 0xfd:
            case 0xfa: {
              if (opcode === 0xfd) {
                // Clear another channel, addressed by byte offset. Out-of-range
                // indices land on a fifth, unused channel, as the original's
                // own workaround for Indy3's Venice music does.
                const index = Math.floor(readU16LE(data, at) / (CHANNEL_WORDS * 2));
                at += 2;
                channel = this.channels[index < this.channels.length ? index : 4];
              }
              for (const field of [
                NEXT_CMD,
                BASE_FREQ,
                FREQ_DELTA,
                FREQ,
                VOLUME,
                VOLUME_DELTA,
                INTER_NOTE_PAUSE,
                TRANSPOSE,
                HULL_CURVE,
                HULL_OFFSET,
                HULL_COUNTER,
                FREQMOD_TABLE_AT,
                FREQMOD_OFFSET,
                FREQMOD_INCR,
                FREQMOD_MULTIPLIER,
                FREQMOD_MODULO,
              ]) {
                channel[field] = 0;
              }
              break;
            }
            case 0xfb:
              at = this.returnAddress;
              break;
            case 0xfc: {
              const target = readU16LE(data, at);
              at += 2;
              this.returnAddress = at;
              at = target;
              break;
            }
            case 0xfe: {
              const counter = data[at++] >> 1;
              const offset = (readU16LE(data, at) << 16) >> 16;
              at += 2;
              if (!channel[counter] || --channel[counter]) at += offset;
              break;
            }
            case 0xff: {
              const field = data[at++] >> 1;
              channel[field] = readU16LE(data, at);
              at += 2;
              if (field === TIME_LEFT) break script;
              break;
            }
            default:
              break;
          }
          continue;
        }

        // A run of notes, each possibly aimed at another channel.
        for (;;) {
          let note: number;
          let isLast: boolean;
          const destination = this.channels[(opcode >> 5) & 3];
          if (!(opcode & 0x80)) {
            const tempo = channel[TEMPO] || 1;
            channel[TIME_LEFT] = tempo * (NOTE_LENGTHS[opcode & 0x1f] ?? 0);
            note = data[at++];
            isLast = (note & 0x80) !== 0;
            note &= 0x7f;
            if (note === 0x7f) break script;
          } else {
            channel[TIME_LEFT] = ((opcode & 7) << 8) | data[at++];
            if (opcode & 0x10) break script;
            isLast = false;
            note = data[at++] & 0x7f;
          }

          destination[TIME_LEFT] = channel[TIME_LEFT];
          destination[NOTE_LENGTH] = channel[TIME_LEFT] - destination[INTER_NOTE_PAUSE];
          // `note` is an int16 in the original and `transpose` is added signed.
          note = (((note + destination[TRANSPOSE]) << 16) >> 16) as number;
          while (note < 0) note += 12;
          const octave = Math.floor(note / 12);
          destination[HULL_OFFSET] = 0;
          destination[HULL_COUNTER] = 1;
          const frequency = SPK_FREQ_TABLE[note % 12] >> octave;
          destination[FREQ] = frequency;
          destination[BASE_FREQ] = frequency;
          if (isLast) break script;
          opcode = data[at++];
        }
      }

      channel = start;
      if (channel[TIME_LEFT]) {
        channel[NEXT_CMD] = at;
        return;
      }
    }

    channel = start;
    channel[NEXT_CMD] = 0;
    if (!this.channels.slice(0, 4).some((c) => c[TIME_LEFT] !== 0)) this.running = false;
  }
}

/**
 * Finds the speaker arrangement in a v3/v4 sound resource, header included.
 *
 * v3 and v4 wrap a sound as `size (u32 LE), "SO"`, then blocks of the same
 * shape: `WA` for the speaker, `AD` for AdLib, and nested `SO` containers that
 * are stepped *into* rather than over (`readSoundResourceSmallHeader`). The
 * speaker player wants the `WA` block from its own six-byte header, because
 * its channel offsets are counted from there.
 */
export function findSpeakerBlock(resource: Uint8Array): Uint8Array | null {
  if (resource.length < 12) return null;
  const tag = (at: number) => String.fromCharCode(resource[at], resource[at + 1]);
  const u32 = (at: number) =>
    (resource[at] |
      (resource[at + 1] << 8) |
      (resource[at + 2] << 16) |
      (resource[at + 3] << 24)) >>>
    0;

  if (tag(4) === 'WA') return resource.subarray(0, Math.min(resource.length, u32(0)));
  if (tag(4) !== 'SO') return null;

  const total = Math.min(resource.length, u32(0));
  let at = 6;
  while (at + 6 <= total) {
    const size = u32(at);
    const blockTag = tag(at + 4);
    if (blockTag === 'WA') return resource.subarray(at, Math.min(total, at + size));
    // A nested `SO` is a container: descend into it rather than skipping it.
    if (blockTag === 'SO') {
      at += 6;
      continue;
    }
    if (size < 6) break;
    at += size;
  }
  return null;
}

/**
 * Finds the speaker data in a v1/v2 ("old bundle") sound resource.
 *
 * These have no `WA` tag: the resource is the speaker block, starting with its
 * own little-endian 16-bit size, and the AdLib block (if any) follows it —
 * `readSoundResourceSmallHeader`'s `GF_OLD_BUNDLE` branch. This engine may hand
 * it over wrapped in a six-byte `SO` header of its own, which is skipped.
 * Player_V2's header is four bytes here rather than six.
 */
export function findOldBundleSpeaker(resource: Uint8Array): Uint8Array | null {
  const wrapped = resource.length >= 6 && resource[4] === 0x53 && resource[5] === 0x4f ? 6 : 0;
  const size = readU16LE(resource, wrapped);
  // Header, priority, restartable and four channel offsets at the least.
  if (size < 14 || wrapped + size > resource.length) return null;
  const block = resource.subarray(wrapped, wrapped + size);
  for (let i = 0; i < 4; i++) {
    const offset = readU16LE(block, 6 + 2 * i);
    if (offset !== 0 && (offset < 14 || offset >= size)) return null;
  }
  return block;
}

/** One queued speaker sound: its number, data, and how long its header is. */
export interface SpeakerSound {
  id: number;
  data: Uint8Array;
  headerLength: number;
}

/**
 * The speaker sounds of a v1-v4 game, one at a time, as `Player_V2` plays them.
 *
 * The original has one current sound and one "next". A new sound replaces the
 * current one if its priority is at least as high; whichever loses is kept as
 * the next sound if it is *restartable* and outranks what was waiting, and it
 * plays when the current one ends (`startSound`, `chainNextSound`). So a door
 * creak interrupts the music, and the music comes back after it.
 */
export class SpeakerSequence {
  private current: { sound: SpeakerSound; player: SpeakerSoundPlayer } | null = null;
  private next: SpeakerSound | null = null;

  constructor(readonly sampleRate: number) {}

  get active(): boolean {
    return this.current !== null;
  }

  /** `getSoundStatus`: playing now, or waiting to. */
  isPlaying(id: number): boolean {
    return this.current?.sound.id === id || this.next?.id === id;
  }

  private priorityOf(sound: SpeakerSound | null | undefined): number {
    return sound ? (sound.data[sound.headerLength] ?? 0) : 0;
  }

  private restartable(sound: SpeakerSound | null | undefined): boolean {
    return sound ? (sound.data[sound.headerLength + 1] ?? 0) !== 0 : false;
  }

  start(sound: SpeakerSound): void {
    const currentSound = this.current?.sound ?? null;
    let loser: SpeakerSound | null = sound;
    if (!currentSound || this.priorityOf(currentSound) <= this.priorityOf(sound)) {
      this.chain(sound);
      loser = currentSound;
    }
    if (
      loser &&
      loser.id !== this.current?.sound.id &&
      this.restartable(loser) &&
      (!this.next || this.priorityOf(this.next) <= this.priorityOf(loser))
    ) {
      this.next = loser;
    }
  }

  stop(id: number): void {
    if (this.next?.id === id) this.next = null;
    if (this.current?.sound.id === id) {
      this.current = null;
      this.chainNext();
    }
  }

  stopAll(): void {
    this.current = null;
    this.next = null;
  }

  render(out: Float32Array): void {
    if (!this.current) {
      out.fill(0);
      return;
    }
    this.current.player.render(out);
    if (!this.current.player.active) {
      this.current = null;
      this.chainNext();
    }
  }

  private chain(sound: SpeakerSound): void {
    const player = new SpeakerSoundPlayer(sound.data, this.sampleRate, sound.headerLength);
    this.current = player.active ? { sound, player } : null;
  }

  private chainNext(): void {
    const next = this.next;
    this.next = null;
    if (next) this.chain(next);
  }
}
