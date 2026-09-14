import { describe, expect, it } from 'vitest';
import {
  AgiSoundPlayer,
  NOISE_VOICE,
  frequencyFor,
  gainFor,
  readSound,
  type AudioContextLike,
} from '../src/engine/agi/sound/AgiSound.js';
import { buildSound } from './fixtureAgi.js';

/** What the player asked the audio graph for, in the order it asked. */
interface Scheduled {
  kind: 'tone' | 'noise';
  type?: string;
  frequency?: number;
  gain: number;
  startAt: number;
  stopAt?: number;
  /** Noise only: whether the buffer repeats a short pattern. */
  periodic?: boolean;
}

/**
 * A recording stand-in for Web Audio.
 *
 * #137's own bar is a tune checked **by ear**, and that is not a check a test
 * can make — nobody has listened to this yet and the issue stays open until
 * someone has. What a test *can* do is pin down everything that decides what
 * would be heard: which waveform, at which frequency, at which gain, starting
 * when and lasting how long. A wrong note here is a wrong note there.
 */
function recordingContext(): { context: AudioContextLike; scheduled: Scheduled[] } {
  const scheduled: Scheduled[] = [];

  const gainNode = (): GainNode =>
    ({ gain: { value: 1 }, connect: () => undefined }) as unknown as GainNode;

  const context = {
    currentTime: 0,
    sampleRate: 44100,
    state: 'running',
    destination: {} as AudioNode,
    resume: async () => undefined,
    close: async () => undefined,

    createGain: gainNode,

    createOscillator: () => {
      const entry: Scheduled = { kind: 'tone', gain: 1, startAt: 0 };
      return {
        type: 'sine',
        frequency: { value: 0 },
        connect(target: { gain?: { value: number } }) {
          // The oscillator connects to its amplifier, which carries the gain.
          if (target?.gain) entry.gain = target.gain.value;
        },
        start(when: number) {
          entry.startAt = when;
          entry.type = (this as { type: string }).type;
          entry.frequency = (this as { frequency: { value: number } }).frequency.value;
          scheduled.push(entry);
        },
        stop(when: number) {
          entry.stopAt = when;
        },
      } as unknown as OscillatorNode;
    },

    createBuffer: (_channels: number, length: number) =>
      ({ getChannelData: () => new Float32Array(length) }) as unknown as AudioBuffer,

    createBufferSource: () => {
      const entry: Scheduled = { kind: 'noise', gain: 1, startAt: 0 };
      return {
        buffer: null,
        connect(target: { gain?: { value: number } }) {
          if (target?.gain) entry.gain = target.gain.value;
        },
        start(when: number) {
          entry.startAt = when;
          scheduled.push(entry);
        },
        stop: () => undefined,
      } as unknown as AudioBufferSourceNode;
    },
  } as unknown as AudioContextLike;

  return { context, scheduled };
}

function play(voices: Parameters<typeof buildSound>[0]): Scheduled[] {
  const { context, scheduled } = recordingContext();
  const player = new AgiSoundPlayer(() => context);
  player.setEnabled(true);
  player.play(readSound(new Uint8Array(buildSound(voices))), 1);
  return scheduled;
}

describe('what the tone channels are actually asked to play', () => {
  /**
   * A square wave, because that is what the chip produced. A sine sounds wrong
   * in a way anyone who has heard these games notices immediately, and it is
   * the single easiest thing to get quietly wrong.
   */
  it('plays square waves, not sines', () => {
    const scheduled = play([[{ duration: 30, divisor: 428, attenuation: 0 }], [], [], []]);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].type).toBe('square');
  });

  /** Divisor 428 against the divided 3.579545 MHz clock is middle C. */
  it('plays the pitch the divisor names', () => {
    const scheduled = play([[{ duration: 30, divisor: 428, attenuation: 0 }], [], [], []]);
    expect(scheduled[0].frequency).toBeCloseTo(261.4, 0);
    expect(scheduled[0].frequency).toBeCloseTo(frequencyFor(428), 5);
  });

  /**
   * Attenuation is backwards from every other volume here: 0 is loudest and 15
   * is silent. Reading it as a level plays quiet notes loud and loud ones
   * inaudible — and the tune is still recognisable, so it would pass a casual
   * listen.
   */
  it('treats attenuation as a cut, so a higher number is quieter', () => {
    const [loud] = play([[{ duration: 10, divisor: 428, attenuation: 0 }], [], [], []]);
    const [quiet] = play([[{ duration: 10, divisor: 428, attenuation: 8 }], [], [], []]);
    expect(quiet.gain).toBeLessThan(loud.gain);
    expect(loud.gain / gainFor(0)).toBeCloseTo(quiet.gain / gainFor(8), 5);
  });

  it('schedules nothing at all for a note attenuated to silence', () => {
    expect(play([[{ duration: 10, divisor: 428, attenuation: 15 }], [], [], []])).toHaveLength(0);
  });

  it('schedules nothing for a rest, and still lets the notes after it land late', () => {
    const scheduled = play([
      [
        { duration: 60, divisor: 0, attenuation: 15 },
        { duration: 60, divisor: 428, attenuation: 0 },
      ],
      [],
      [],
      [],
    ]);
    expect(scheduled).toHaveLength(1);
    // The rest still occupies its second, so the note after it starts there.
    expect(scheduled[0].startAt).toBeCloseTo(1, 5);
  });
});

describe('timing, which is what a tune is', () => {
  it('lays notes end to end at their own durations', () => {
    const scheduled = play([
      [
        { duration: 30, divisor: 428, attenuation: 0 },
        { duration: 60, divisor: 214, attenuation: 0 },
        { duration: 15, divisor: 856, attenuation: 0 },
      ],
      [],
      [],
      [],
    ]);

    // Sixtieths of a second: 0.5s, then 1s, then 0.25s.
    expect(scheduled.map((s) => s.startAt)).toEqual([0, 0.5, 1.5]);
    expect(scheduled[0].stopAt).toBeCloseTo(0.5, 5);
    expect(scheduled[1].stopAt).toBeCloseTo(1.5, 5);
    expect(scheduled[2].stopAt).toBeCloseTo(1.75, 5);
  });

  /** Four voices are a chord, not a queue: each starts its own list at zero. */
  it('starts every voice at the beginning rather than one after another', () => {
    const scheduled = play([
      [{ duration: 60, divisor: 428, attenuation: 0 }],
      [{ duration: 60, divisor: 340, attenuation: 0 }],
      [{ duration: 60, divisor: 214, attenuation: 0 }],
      [],
    ]);
    expect(scheduled.map((s) => s.startAt)).toEqual([0, 0, 0]);
    expect(new Set(scheduled.map((s) => s.frequency)).size).toBe(3);
  });
});

describe('the noise channel', () => {
  it('is a buffer rather than an oscillator, because a chip noise is not a tone', () => {
    const scheduled = play([[], [], [], [{ duration: 20, divisor: 1, attenuation: 0 }]]);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].kind).toBe('noise');
    expect(NOISE_VOICE).toBe(3);
  });

  it('plays tone voices and the noise voice together', () => {
    const scheduled = play([
      [{ duration: 20, divisor: 428, attenuation: 0 }],
      [],
      [],
      [{ duration: 20, divisor: 1, attenuation: 0 }],
    ]);
    expect(scheduled.map((s) => s.kind).sort()).toEqual(['noise', 'tone']);
  });
});

describe('nothing is scheduled when there is nothing to hear', () => {
  it('schedules no audio while sound is disabled', () => {
    const { context, scheduled } = recordingContext();
    const player = new AgiSoundPlayer(() => context);
    player.setEnabled(false);
    player.play(
      readSound(
        new Uint8Array(buildSound([[{ duration: 30, divisor: 428, attenuation: 0 }], [], [], []])),
      ),
      1,
    );
    expect(scheduled).toEqual([]);
  });

  it('stops everything it started when a script stops the sound', () => {
    const { context } = recordingContext();
    const player = new AgiSoundPlayer(() => context);
    player.setEnabled(true);
    player.play(
      readSound(
        new Uint8Array(buildSound([[{ duration: 600, divisor: 428, attenuation: 0 }], [], [], []])),
      ),
      1,
    );
    expect(player.isPlaying).toBe(true);
    player.stop();
    expect(player.isPlaying).toBe(false);
  });
});
