import { afterEach, describe, expect, it } from 'vitest';
import type { ResourceManager } from '../src/engine/resource/ResourceManager.js';
import { SoundEngine } from '../src/engine/sound/SoundEngine.js';
import { CHUNK_FRAMES, MIN_LOOKAHEAD_SECONDS } from '../src/engine/sound/liveMusic.js';

/**
 * Music sequenced live and streamed, through the sound engine.
 *
 * A fake `AudioContext` stands in for the browser's: it records the chunks the
 * stream schedules and lets the test move time. What is checked is that a
 * game's score reaches a live player — so the commands a script sends while it
 * plays have a player to act on — and that the stream keeps only a short
 * stretch queued ahead, which is what makes those commands audible promptly.
 */

const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));
const be32 = (n: number): number[] => [
  (n >>> 24) & 255,
  (n >>> 16) & 255,
  (n >>> 8) & 255,
  n & 255,
];
const le32 = (n: number): number[] => [
  n & 255,
  (n >>> 8) & 255,
  (n >>> 16) & 255,
  (n >>> 24) & 255,
];

/** Eight beats of notes at 480 ticks a beat (a delta of 480 is 0x83 0x60). */
function score(): number[] {
  const track: number[] = [];
  for (let beat = 0; beat < 8; beat++) {
    if (beat > 0) track.push(0x83, 0x60);
    else track.push(0x00);
    track.push(0x90, 60 + beat, 100);
  }
  track.push(0x00, 0xff, 0x2f, 0x00);
  return [
    ...ascii('MThd'),
    ...be32(6),
    0,
    0,
    0,
    1,
    0x01,
    0xe0,
    ...ascii('MTrk'),
    ...be32(track.length),
    ...track,
  ];
}

function soun(tag: string, payload: number[]): Uint8Array {
  const block = [...ascii(tag), ...be32(payload.length), ...payload];
  const sou = [...ascii('SOU '), ...be32(block.length), ...block];
  return new Uint8Array([...ascii('SOUN'), ...be32(sou.length), ...sou]);
}

interface FakeContext {
  currentTime: number;
  sampleRate: number;
  scheduled: number;
}

function installFakeAudio(): { context: FakeContext; restore: () => void } {
  const param = () => ({
    value: 1,
    cancelScheduledValues: () => undefined,
    setValueAtTime: () => undefined,
    linearRampToValueAtTime: () => undefined,
  });
  const node = () => ({ connect: () => undefined, disconnect: () => undefined });
  const context = {
    state: 'running',
    currentTime: 0,
    sampleRate: 22050,
    scheduled: 0,
    destination: {},
    resume: async () => undefined,
    createGain: () => ({ ...node(), gain: param() }),
    createStereoPanner: () => ({ ...node(), pan: param() }),
    createBuffer: (_channels: number, length: number, sampleRate: number) => {
      const data = new Float32Array(length);
      return { length, sampleRate, duration: length / sampleRate, getChannelData: () => data };
    },
    createBufferSource: () => ({
      ...node(),
      buffer: null,
      onended: null,
      start: () => {
        context.scheduled++;
      },
      stop: () => undefined,
    }),
  };
  const previous = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    AudioContext: function () {
      return context;
    },
  };
  return {
    context,
    restore: () => {
      (globalThis as { window?: unknown }).window = previous;
    },
  };
}

function engineWith(sounds: Record<number, Uint8Array>) {
  const sound = new SoundEngine();
  sound.attach({ getSound: (id: number) => sounds[id] ?? null } as unknown as ResourceManager);
  return sound;
}

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

describe('a score played live', () => {
  it('starts a player the commands can reach', async () => {
    const fake = installFakeAudio();
    restore = fake.restore;
    const sound = engineWith({ 5: soun('ADL ', score()) });
    await sound.resume();

    sound.kludge([8, 5]);
    expect(sound.isSoundRunning(5)).toBe(true);
    // A jump now has a player to jump within, so it succeeds.
    expect(sound.kludge([0x107, 5, 0, 4, 0])).toBe(0);
    // And the position it reports is the jump's destination: beat 4 is six
    // half-beats in.
    expect(sound.musicTimer()).toBeGreaterThanOrEqual(6);
  });

  it('queues only a short stretch ahead of the listener', async () => {
    const fake = installFakeAudio();
    restore = fake.restore;
    const sound = engineWith({ 5: soun('ADL ', score()) });
    await sound.resume();

    sound.startSound(5);
    const chunkSeconds = CHUNK_FRAMES / fake.context.sampleRate;
    const expected = Math.ceil((MIN_LOOKAHEAD_SECONDS + 0.02) / chunkSeconds);
    expect(fake.context.scheduled).toBeLessThanOrEqual(expected + 1);

    // Time passes; the frame step tops the queue up.
    fake.context.currentTime = 1;
    sound.step(1 / 60);
    expect(fake.context.scheduled).toBeGreaterThan(expected);
  });

  it('reads a player parameter back as the command result', async () => {
    const fake = installFakeAudio();
    restore = fake.restore;
    const sound = engineWith({ 5: soun('ADL ', score()) });
    await sound.resume();

    sound.kludge([8, 5]);
    sound.kludge([0x102, 5, 90]); // player volume
    expect(sound.kludge([0x100, 5, 1, 0])).toBe(90);
  });

  it('stops the player, and says it has stopped', async () => {
    const fake = installFakeAudio();
    restore = fake.restore;
    const sound = engineWith({ 5: soun('ADL ', score()) });
    await sound.resume();

    sound.kludge([8, 5]);
    sound.kludge([9, 5]);
    expect(sound.isSoundRunning(5)).toBe(false);
    expect(sound.kludge([0x107, 5, 0, 2, 0])).toBe(-1);
  });

  it('runs a Sam & Max trigger when its sound stops', async () => {
    const fake = installFakeAudio();
    restore = fake.restore;
    const sound = engineWith({ 5: soun('ADL ', score()), 6: soun('ADL ', score()) });
    sound.configureImuse({ newSystem: true });
    await sound.resume();

    sound.kludge([8, 5]);
    // When sound 5 reaches marker 1 — or stops — start sound 6.
    sound.kludge([17, 5, 0, 1, 8, 6]);
    sound.stopSound(5);
    expect(sound.isSoundRunning(6)).toBe(true);
  });

  it('plays a speaker-only score on the speaker', async () => {
    const fake = installFakeAudio();
    restore = fake.restore;
    const sound = engineWith({ 5: soun('SPK ', score()) });
    await sound.resume();

    sound.startSound(5);
    expect(sound.isSoundRunning(5)).toBe(true);
  });

  it('plays a v3 speaker sound', async () => {
    const fake = installFakeAudio();
    restore = fake.restore;
    const script = [0xff, 14, 1, 0, 0x14, 0x80 | 48, 0xff, 0, 0, 0];
    const body = [0, 0, 16, 0, 0, 0, 0, 0, 0, 0, ...script];
    const wa = [...le32(6 + body.length), ...ascii('WA'), ...body];
    const resource = new Uint8Array([...le32(6 + wa.length), ...ascii('SO'), ...wa]);
    const sound = engineWith({ 3: resource });
    await sound.resume();

    sound.startSound(3);
    expect(sound.isSoundRunning(3)).toBe(true);
  });
});
