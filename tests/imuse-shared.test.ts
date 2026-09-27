import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import type { ResourceManager } from '../src/engine/resource/ResourceManager.js';
import { captureState, restoreState } from '../src/engine/save/SaveState.js';
import { ScummEngine } from '../src/engine/ScummEngine.js';
import { AdLibDriver } from '../src/engine/sound/AdLibDriver.js';
import { ImuseCommands, type ImuseHost } from '../src/engine/sound/imuse.js';
import { GlobalInstruments, InstrumentRouter } from '../src/engine/sound/imuseInstruments.js';
import { ImuseMixer } from '../src/engine/sound/imuseMixer.js';
import { ImusePlayer } from '../src/engine/sound/ImusePlayer.js';
import {
  LiveMusicStream,
  MAX_LOOKAHEAD_SECONDS,
  MIN_LOOKAHEAD_SECONDS,
} from '../src/engine/sound/liveMusic.js';
import {
  MIDI_CONTROL_CHANGE,
  MIDI_META,
  MIDI_NOTE_ON,
  type MidiEvent,
  type MidiFile,
} from '../src/engine/sound/midi.js';
import { Opl2 } from '../src/engine/sound/opl2/Opl2.js';
import {
  findOldBundleSpeaker,
  PcSpeakerDriver,
  SpeakerSequence,
} from '../src/engine/sound/pcSpeaker.js';
import { SoundEngine } from '../src/engine/sound/SoundEngine.js';
import { buildV6Fixture } from './fixtureV6.js';

/**
 * The second round of the live sequencer: the speaker's instrument effects,
 * v1/v2 speaker sounds, iMUSE's own instrument sysex, one chip shared by every
 * player, iMUSE state in a save, and how far ahead of the listener the music
 * is prepared.
 */

const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));
const be32 = (n: number): number[] => [
  (n >>> 24) & 255,
  (n >>> 16) & 255,
  (n >>> 8) & 255,
  n & 255,
];
const le16 = (n: number): number[] => [n & 255, (n >>> 8) & 255];
const nibbles = (bytes: number[]) => bytes.flatMap((b) => [(b >> 4) & 0x0f, b & 0x0f]);

const volume = (channel: number, value = 127): MidiEvent => ({
  tick: 0,
  command: MIDI_CONTROL_CHANGE,
  channel,
  data1: 7,
  data2: value,
});
const noteOn = (channel: number, key: number, tick = 0): MidiEvent => ({
  tick,
  command: MIDI_NOTE_ON,
  channel,
  data1: key,
  data2: 100,
});

/** Frequency in successive windows, by counting upward zero crossings. */
function frequencies(samples: Float32Array, rate: number, windows: number): number[] {
  const size = Math.floor(samples.length / windows);
  const out: number[] = [];
  for (let w = 0; w < windows; w++) {
    let crossings = 0;
    for (let i = w * size + 1; i < (w + 1) * size; i++) {
      if (samples[i - 1] < 0 && samples[i] >= 0) crossings++;
    }
    out.push((crossings * rate) / size);
  }
  return out;
}

describe('the speaker’s instrument effects', () => {
  const RATE = 48000;

  it('plays a plain tone with an empty instrument', () => {
    const speaker = new PcSpeakerDriver(RATE);
    speaker.handle(volume(0));
    speaker.handle(noteOn(0, 69));
    const out = new Float32Array(RATE);
    speaker.render(out);
    const f = frequencies(out, RATE, 4);
    expect(Math.max(...f) - Math.min(...f)).toBeLessThan(10);
  });

  it('warbles with the instrument’s vibrato', () => {
    const speaker = new PcSpeakerDriver(RATE);
    const instrument = new Uint8Array(23);
    instrument[1] = 8; // vibrato speed
    instrument[2] = 40; // vibrato depth
    instrument[4] = 0; // the sine table
    speaker.setInstrument(0, instrument);
    speaker.handle(volume(0));
    speaker.handle(noteOn(0, 69));
    const out = new Float32Array(RATE);
    speaker.render(out);
    const f = frequencies(out, RATE, 40);
    expect(Math.max(...f) - Math.min(...f)).toBeGreaterThan(20);
  });

  it('ends a note after the instrument’s length, in driver ticks', () => {
    const speaker = new PcSpeakerDriver(RATE);
    const instrument = new Uint8Array(23);
    instrument[0] = 25; // 25 ticks of 4 ms: a tenth of a second
    speaker.setInstrument(0, instrument);
    speaker.handle(volume(0));
    speaker.handle(noteOn(0, 69));
    const out = new Float32Array(RATE / 2);
    speaker.render(out);
    const late = out.subarray(RATE / 4);
    expect(Math.max(...Array.from(late, Math.abs))).toBeLessThan(0.001);
  });

  it('bends the pitch with an envelope generator', () => {
    const speaker = new PcSpeakerDriver(RATE);
    const instrument = new Uint8Array(23);
    // Envelope A: enabled, type 0 (pitch). Definition: no duration limit,
    // then four stages of target levels and mod-wheel levels.
    instrument[5] = 0x80;
    instrument.set([0, 10, 60, 10, 60, 10, 10, 31], 6);
    speaker.setInstrument(0, instrument);
    speaker.handle(volume(0));
    speaker.handle(noteOn(0, 69));
    const out = new Float32Array(RATE);
    speaker.render(out);
    const f = frequencies(out, RATE, 10);
    expect(Math.max(...f) - Math.min(...f)).toBeGreaterThan(10);
  });

  it('takes a speaker instrument from sysex 16 at the speaker’s length', () => {
    const speaker = new PcSpeakerDriver(RATE);
    const router = new InstrumentRouter(speaker, 'speaker', new GlobalInstruments());
    const body = [0, 0, ...nibbles(new Array(23).fill(1))];
    const event: MidiEvent = {
      tick: 0,
      command: MIDI_META,
      channel: 0,
      data1: 0xf0,
      data2: 0,
      sysex: Uint8Array.from([0x7d, 16, ...body, 0xf7]),
    };
    expect(router.handle(event)).toBe(true);
    expect(speaker.instrumentsLoaded).toBe(1);
  });
});

describe('v1/v2 speaker sounds', () => {
  /** An old-bundle block: its own u16 size, two bytes, priority, restartable, offsets, script. */
  function oldBundle(priority: number, restartable = 0): number[] {
    const script = [0xff, 14, 1, 0, 0x14, 0x80 | 48, 0xff, 0, 0, 0];
    const body = [0, 0, priority, restartable, ...le16(14), 0, 0, 0, 0, 0, 0, ...script];
    return [...le16(2 + body.length), ...body];
  }

  it('finds the speaker block, bare or in this engine’s SO wrapper', () => {
    const bare = new Uint8Array(oldBundle(1));
    expect(findOldBundleSpeaker(bare)?.length).toBe(bare.length);
    const wrapped = new Uint8Array([...le16(6 + bare.length), 0, 0, ...ascii('SO'), ...bare]);
    expect(findOldBundleSpeaker(wrapped)?.length).toBe(bare.length);
  });

  it('plays one sound at a time, by priority, and brings a restartable one back', () => {
    const sequence = new SpeakerSequence(48000);
    const music = { id: 1, data: new Uint8Array(oldBundle(5, 1)), headerLength: 4 };
    const effect = { id: 2, data: new Uint8Array(oldBundle(9)), headerLength: 4 };
    const low = { id: 3, data: new Uint8Array(oldBundle(1)), headerLength: 4 };

    sequence.start(music);
    sequence.start(effect);
    expect(sequence.isPlaying(2)).toBe(true);
    // The music lost but is restartable, so it waits as the next sound.
    expect(sequence.isPlaying(1)).toBe(true);

    sequence.start(low);
    expect(sequence.isPlaying(3)).toBe(false);

    sequence.render(new Float32Array(48000));
    expect(sequence.isPlaying(2)).toBe(false);
    expect(sequence.isPlaying(1)).toBe(true);
  });
});

describe('one OPL2 shared by every player', () => {
  it('gives a more important part the voices a less important one holds', () => {
    const driver = new AdLibDriver(new Opl2());
    driver.setPriority(0, 10); // the music
    driver.setPriority(16, 100); // a sound effect's score, in another block
    for (let key = 60; key < 69; key++) driver.handle(noteOn(0, key));
    expect(driver.voiceOwners.filter((owner) => owner === 0)).toHaveLength(9);

    driver.handle(noteOn(16, 80));
    expect(driver.voiceOwners.filter((owner) => owner === 16)).toHaveLength(1);
  });

  it('drops a note rather than steal from a more important part', () => {
    const driver = new AdLibDriver(new Opl2());
    driver.setPriority(0, 100);
    driver.setPriority(16, 10);
    for (let key = 60; key < 69; key++) driver.handle(noteOn(0, key));
    driver.handle(noteOn(16, 80));
    expect(driver.voiceOwners).not.toContain(16);
  });

  it('sequences several players on one timer and frees their channels as they end', () => {
    const mixer = new ImuseMixer();
    const score: MidiFile = {
      division: 480,
      events: [noteOn(0, 60), noteOn(0, 62, 240)],
      duration: 240,
    };
    const a = new ImusePlayer(1, score, { synth: mixer.portFor('adlib') });
    const portB = mixer.portFor('adlib');
    const b = new ImusePlayer(2, score, { synth: portB });
    mixer.add(a, mixer.portFor('adlib'));
    mixer.add(b, portB);
    expect(mixer.active).toBe(true);

    const out = new Float32Array(Math.round(mixer.sampleRate));
    mixer.render(out);
    expect(Math.max(...Array.from(out, Math.abs))).toBeGreaterThan(0.001);
    expect(a.active).toBe(false);
    expect(b.active).toBe(false);
    expect(mixer.active).toBe(false);
  });
});

describe('iMUSE state in a save', () => {
  const beats: MidiFile = {
    division: 480,
    events: Array.from({ length: 8 }, (_, beat) => noteOn(0, 60 + beat, beat * 480)),
    duration: 7 * 480,
  };

  it('puts a player back at its position with its parameters', () => {
    const player = new ImusePlayer(7, beats, { synth: silentSynth() });
    for (let i = 0; i < 300; i++) player.onTimer();
    player.setTranspose(0, 3);
    player.setLoop(2, 1, 0, 6, 0);
    player.setHook(0, 4, 0);
    const saved = JSON.parse(JSON.stringify(player.save()));

    const restored = new ImusePlayer(7, beats, { synth: silentSynth() });
    restored.restore(saved);
    expect(restored.beatIndex).toBe(player.beatIndex);
    expect(restored.transpose).toBe(3);
    expect(restored.getParam(9, 0)).toBe(2);
    expect(restored.getParam(18, 0)).toBe(4);
  });

  it('puts the command queue and triggers back', () => {
    const ran: number[][] = [];
    const host: ImuseHost = {
      player: () => null,
      run: (args) => {
        ran.push(args);
        return 0;
      },
      status: () => false,
      stop: vi.fn(),
      log: vi.fn(),
    };
    const before = new ImuseCommands(host);
    before.playerCommand(14, [0x10e, 7, 9]);
    before.playerCommand(15, [0x10f, 8, 12]);
    before.playerCommand(15, [0x10f, -1]);
    const saved = JSON.parse(JSON.stringify(before.save()));

    const after = new ImuseCommands(host);
    after.restore(saved);
    after.marker(7, 9);
    expect(ran).toEqual([[8, 12, 0, 0, 0, 0, 0]]);
  });

  it('is written into a SCUMM save, and a save without it still loads', async () => {
    const fixture = buildV6Fixture();
    const source = new MemoryDataSource('v6');
    source.set(fixture.indexName, fixture.index);
    source.set(fixture.dataName, fixture.data);
    const engine = await ScummEngine.create(source);
    engine.boot(0);
    engine.startScene(1, null, 0);

    const saved = captureState(engine, 'test');
    expect(saved.imuse).toBeDefined();
    const old = { ...saved };
    delete old.imuse;
    expect(() => restoreState(engine, old)).not.toThrow();
    expect(() => restoreState(engine, JSON.parse(JSON.stringify(saved)))).not.toThrow();
  });
});

function silentSynth() {
  return {
    sampleRate: 1000,
    handle: () => undefined,
    render: (out: Float32Array) => out.fill(0),
    releaseAll: () => undefined,
    setDetune: () => undefined,
    unreadableSysex: 0,
    instrumentsLoaded: 0,
  };
}

describe('how far ahead the music is prepared', () => {
  function fakeContext() {
    const node = () => ({ connect: () => undefined, disconnect: () => undefined });
    return {
      currentTime: 0,
      sampleRate: 44100,
      createGain: () => ({ ...node(), gain: { value: 1 } }),
      createStereoPanner: () => ({ ...node(), pan: { value: 0 } }),
      createBuffer: (_c: number, length: number) => {
        const data = new Float32Array(length);
        return { getChannelData: () => data };
      },
      createBufferSource: () => ({ ...node(), start: () => undefined, stop: () => undefined }),
    };
  }
  const source = { sampleRate: 44100, active: true, render: (out: Float32Array) => out.fill(0) };

  it('starts short, so a command is heard within a tenth of a second', () => {
    const context = fakeContext();
    const stream = new LiveMusicStream(
      context as unknown as BaseAudioContext,
      {} as AudioNode,
      source,
    );
    expect(stream.lookahead).toBe(MIN_LOOKAHEAD_SECONDS);
    expect(MIN_LOOKAHEAD_SECONDS).toBeLessThanOrEqual(0.1);
  });

  it('keeps more queued once the page has let it run dry, up to a limit', () => {
    const context = fakeContext();
    const stream = new LiveMusicStream(
      context as unknown as BaseAudioContext,
      {} as AudioNode,
      source,
    );
    for (let stall = 1; stall <= 10; stall++) {
      context.currentTime = stall * 5;
      stream.pump();
    }
    expect(stream.lookahead).toBeGreaterThan(MIN_LOOKAHEAD_SECONDS);
    expect(stream.lookahead).toBeLessThanOrEqual(MAX_LOOKAHEAD_SECONDS);
  });
});

describe('the sound engine with the shared chip', () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  function installFakeAudio() {
    const node = () => ({ connect: () => undefined, disconnect: () => undefined });
    const context = {
      state: 'running',
      currentTime: 0,
      sampleRate: 22050,
      destination: {},
      resume: async () => undefined,
      createGain: () => ({ ...node(), gain: { value: 1 } }),
      createStereoPanner: () => ({ ...node(), pan: { value: 0 } }),
      createBuffer: (_c: number, length: number) => {
        const data = new Float32Array(length);
        return { getChannelData: () => data };
      },
      createBufferSource: () => ({ ...node(), start: () => undefined, stop: () => undefined }),
    };
    const previous = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
      AudioContext: function () {
        return context;
      },
    };
    restore = () => ((globalThis as { window?: unknown }).window = previous);
  }

  function smfResource(): Uint8Array {
    const track = [
      0x00, 0x90, 60, 100, 0x83, 0x60, 0x90, 62, 100, 0x83, 0x60, 0x90, 64, 100, 0x00, 0xff, 0x2f,
      0x00,
    ];
    const midi = [
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
    const block = [...ascii('ADL '), ...be32(midi.length), ...midi];
    const sou = [...ascii('SOU '), ...be32(block.length), ...block];
    return new Uint8Array([...ascii('SOUN'), ...be32(sou.length), ...sou]);
  }

  it('saves a playing player and restores it at the same place', async () => {
    installFakeAudio();
    const sound = new SoundEngine();
    sound.attach({ getSound: () => smfResource() } as unknown as ResourceManager);
    await sound.resume();

    sound.kludge([8, 5]);
    sound.kludge([0x107, 5, 0, 2, 0]);
    const saved = JSON.parse(JSON.stringify(sound.saveImuse()));
    expect(saved.players).toHaveLength(1);

    sound.kludge([0x107, 5, 0, 1, 0]);
    sound.restoreImuse(saved);
    expect(sound.isSoundRunning(5)).toBe(true);
    expect(sound.musicTimer()).toBe(2);
  });

  it('plays a v2 speaker sound through Player_V2', async () => {
    installFakeAudio();
    const script = [0xff, 14, 1, 0, 0x14, 0x80 | 48, 0xff, 0, 0, 0];
    const body = [0, 0, 1, 0, ...le16(14), 0, 0, 0, 0, 0, 0, ...script];
    const resource = new Uint8Array([...le16(2 + body.length), ...body]);
    const sound = new SoundEngine();
    sound.attach({ getSound: () => resource, game: { version: 2 } } as unknown as ResourceManager);
    await sound.resume();

    sound.startSound(4);
    expect(sound.isSoundRunning(4)).toBe(true);
  });
});
