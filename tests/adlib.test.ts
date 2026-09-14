import { describe, expect, it } from 'vitest';
import { readMidi, MIDI_META, MIDI_NOTE_ON } from '../src/engine/sound/midi.js';
import { findMidiData, readScummMusic } from '../src/engine/sound/scummAdl.js';
import {
  MAX_MUSIC_SECONDS,
  renderMidiToOpl2,
  renderScummMusic,
  secondsToTicks,
  ticksToSeconds,
} from '../src/engine/sound/renderMusic.js';
import { listSoundBlocks } from '../src/engine/sound/soundChunks.js';
import { decodeSoundResource } from '../src/engine/sound/SoundEngine.js';
import { chunk } from './fixture.js';

const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));
const be32 = (n: number): number[] => [
  (n >>> 24) & 255,
  (n >>> 16) & 255,
  (n >>> 8) & 255,
  n & 255,
];
const be16 = (n: number): number[] => [(n >>> 8) & 255, n & 255];

/** A one-track Standard MIDI File around the given event bytes. */
function smf(events: number[], division = 96): Uint8Array {
  const track = [...events, 0x00, 0xff, 0x2f, 0x00];
  return new Uint8Array([
    ...ascii('MThd'),
    ...be32(6),
    ...be16(0),
    ...be16(1),
    ...be16(division),
    ...ascii('MTrk'),
    ...be32(track.length),
    ...track,
  ]);
}

/** Note on, hold for a quarter note, note off. */
const ONE_NOTE = [0x00, 0x90, 60, 100, 0x60, 0x80, 60, 0];

/**
 * A `SOUN` resource in the shape a game ships it: `SOUN` wrapping `SOU `, with
 * every size field counting only the payload. `chunk` writes the ordinary
 * inclusive sizes, which is right everywhere else and wrong here.
 */
function soun(blocks: number[]): number[] {
  const sou = [...ascii('SOU '), ...be32(blocks.length), ...blocks];
  return [...ascii('SOUN'), ...be32(sou.length), ...sou];
}

/** One block inside a `SOU `, whose size field counts the payload alone. */
function souBlock(tag: string, payload: number[]): number[] {
  return [...ascii(tag), ...be32(payload.length), ...payload];
}

const peak = (samples: Float32Array): number => Math.max(...Array.from(samples, Math.abs));

describe('reading a MIDI file', () => {
  it('reads the division and the events', () => {
    const midi = readMidi(smf(ONE_NOTE));

    expect(midi.division).toBe(96);
    expect(midi.events).toHaveLength(2);
    expect(midi.events[0]).toMatchObject({ tick: 0, command: MIDI_NOTE_ON, data1: 60 });
    expect(midi.duration).toBe(96);
  });

  it('understands running status', () => {
    // The second note has no status byte of its own and inherits the first's,
    // which is how nearly every real file stores a run of notes.
    const midi = readMidi(smf([0x00, 0x90, 60, 100, 0x30, 62, 100]));

    expect(midi.events).toHaveLength(2);
    expect(midi.events[1]).toMatchObject({ tick: 48, command: MIDI_NOTE_ON, data1: 62 });
  });

  it('reads a tempo change', () => {
    const midi = readMidi(smf([0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20, 0x00, 0x90, 60, 100]));

    expect(midi.events[0]).toMatchObject({ command: MIDI_META, tempo: 500_000 });
  });

  it('keeps a system-exclusive payload intact', () => {
    const midi = readMidi(smf([0x00, 0xf0, 0x04, 0x7d, 0x01, 0x02, 0xf7]));

    expect(Array.from(midi.events[0].sysex ?? [])).toEqual([0x7d, 0x01, 0x02, 0xf7]);
  });

  it('keeps what it read when a track is truncated', () => {
    // Half a piece of music is worth more than an exception.
    const whole = smf(ONE_NOTE);
    const midi = readMidi(whole.subarray(0, whole.length - 3));

    expect(midi.events.length).toBeGreaterThan(0);
  });

  it('refuses data that is not a MIDI file at all', () => {
    expect(() => readMidi(new Uint8Array(ascii('nope')))).toThrow(/Not a MIDI file/);
  });
});

describe('finding the score in a SCUMM resource', () => {
  it('reads a bare MIDI file', () => {
    expect(findMidiData(smf(ONE_NOTE))).not.toBeNull();
  });

  it('digs through the SOU, ADL and MDhd wrappers', () => {
    const body = [...chunk('MDhd', [0, 0, 0, 0, 0, 0, 0, 0]), ...smf(ONE_NOTE)];
    const resource = new Uint8Array(chunk('SOU ', chunk('ADL ', body)));

    expect(readScummMusic(resource)?.events).toHaveLength(2);
  });

  it('prefers the AdLib arrangement over the Roland one', () => {
    // Both blocks hold a score. Taking whichever comes first in the file would
    // play the Roland arrangement through a chip it was never written for, so
    // the container is walked rather than scanned.
    const roland = chunk('ROL ', [...smf([0x00, 0x90, 72, 100])]);
    const adlib = chunk('ADL ', [...smf(ONE_NOTE)]);
    const resource = new Uint8Array(chunk('SOU ', [...roland, ...adlib]));

    const midi = readScummMusic(resource);
    expect(midi?.events[0].data1).toBe(60);
  });

  it('returns nothing for a resource with no score in it', () => {
    const digitised = new Uint8Array(chunk('SOU ', chunk('SBL ', [1, 2, 3, 4])));

    expect(findMidiData(digitised)).toBeNull();
    expect(readScummMusic(digitised)).toBeNull();
  });
});

describe('rendering a score through the OPL2', () => {
  it('produces audible sound for a single note', () => {
    const rendered = renderMidiToOpl2(readMidi(smf(ONE_NOTE)), 48000);

    expect(rendered.sampleRate).toBe(48000);
    expect(peak(rendered.samples)).toBeGreaterThan(0.01);
    expect(rendered.truncated).toBe(false);
  });

  it('renders at the requested rate, whatever the chip runs at', () => {
    const at44 = renderMidiToOpl2(readMidi(smf(ONE_NOTE)), 44100);
    const at48 = renderMidiToOpl2(readMidi(smf(ONE_NOTE)), 48000);

    // The same music, so the same duration in seconds either way.
    expect(at44.samples.length / 44100).toBeCloseTo(at48.samples.length / 48000, 2);
  });

  it('lasts as long as the score says, plus a tail for the last note', () => {
    // A quarter note at the default 120 bpm is half a second.
    const seconds = renderMidiToOpl2(readMidi(smf(ONE_NOTE)), 48000).samples.length / 48000;

    expect(seconds).toBeGreaterThan(0.5);
    expect(seconds).toBeLessThan(2.5);
  });

  it('follows a tempo change', () => {
    const slow = [0x00, 0xff, 0x51, 0x03, 0x0f, 0x42, 0x40, ...ONE_NOTE]; // 60 bpm
    const fast = [0x00, 0xff, 0x51, 0x03, 0x03, 0xd0, 0x90, ...ONE_NOTE]; // 240 bpm

    const slowLength = renderMidiToOpl2(readMidi(smf(slow)), 48000).samples.length;
    const fastLength = renderMidiToOpl2(readMidi(smf(fast)), 48000).samples.length;

    expect(slowLength).toBeGreaterThan(fastLength);
  });

  it('stops a note when the score does', () => {
    const rendered = renderMidiToOpl2(readMidi(smf(ONE_NOTE)), 48000);

    // The tail is there to let a note ring, not to hold it: by the end the
    // release must have run out.
    expect(peak(rendered.samples.subarray(-2000))).toBeLessThan(0.001);
  });

  // Proving the cap fires means rendering all the way to it, and the chip runs
  // at OPL2_RATE for MAX_MUSIC_SECONDS whatever output rate is asked for — so
  // this is a few seconds of real work, and slower CI hardware needs saying.
  it('caps a score that would run for ever', () => {
    // One note every beat for far longer than the cap allows.
    const events: number[] = [];
    for (let i = 0; i < 4000; i++) events.push(0x60, 0x90, 60, 100, 0x00, 0x80, 60, 0);

    const rendered = renderMidiToOpl2(readMidi(smf(events)), 48000);

    expect(rendered.truncated).toBe(true);
    expect(rendered.samples.length / 48000).toBeLessThanOrEqual(MAX_MUSIC_SECONDS + 1);
  }, 30_000);

  it('plays a score straight out of a SCUMM resource', () => {
    const resource = new Uint8Array(chunk('SOU ', chunk('ADL ', [...smf(ONE_NOTE)])));
    const rendered = renderScummMusic(resource, 48000);

    expect(peak(rendered!.samples)).toBeGreaterThan(0.01);
  });

  it('reports nothing for a resource holding no score', () => {
    const digitised = new Uint8Array(chunk('SOU ', chunk('SBL ', [1, 2, 3, 4])));

    expect(renderScummMusic(digitised, 48000)).toBeNull();
  });

  /**
   * The shape a game actually ships, which is not the shape the tests above
   * build. Inside a `SOU ` container a block's size field *excludes* its
   * eight-byte header, so a walker using the ordinary rule reads the next tag
   * from inside the first block's payload and stops. Atlantis stores `ROL `
   * first, so every one of its scores looked like a Roland-only piece and its
   * AdLib arrangement was never found.
   */
  it('walks SOU blocks by their own sizing rule', () => {
    const roland = souBlock('ROL ', [...smf([0x00, 0x90, 72, 100])]);
    const adlib = souBlock('ADL ', [...smf(ONE_NOTE)]);
    const resource = new Uint8Array(soun([...roland, ...adlib]));

    const blocks = listSoundBlocks(resource);
    expect(blocks.map((block) => block.tag)).toEqual(['ROL ', 'ADL ']);

    // And the AdLib arrangement is the one played, not whichever came first.
    const midi = readScummMusic(resource);
    expect(midi).not.toBeNull();
    expect(peak(renderScummMusic(resource, 48000)!.samples)).toBeGreaterThan(0.01);
  });

  it('finds a digitised effect stored after the music arrangements', () => {
    const roland = souBlock('ROL ', [...smf([0x00, 0x90, 72, 100])]);
    // A minimal VOC: the header, then one block of 8-bit PCM.
    const voc = [
      ...ascii('Creative Voice File\x1a'),
      0x1a,
      0x00,
      0x0a,
      0x01,
      0x29,
      0x11,
      1,
      6,
      0,
      0,
      0xa5,
      0,
      0x40,
      0x80,
      0xc0,
      0xff,
      0,
    ];
    const resource = new Uint8Array(soun([...roland, ...souBlock('SBL ', voc)]));

    expect(listSoundBlocks(resource).map((block) => block.tag)).toEqual(['ROL ', 'SBL ']);
    expect(decodeSoundResource(resource)).not.toBeNull();
  });

  it('plays on with the default instrument when a definition is unreadable', () => {
    // The instrument layout SCUMM uses is not published, and this is the
    // behaviour that matters when a message is not understood: the notes still
    // sound, and the count says how often it happened.
    const nonsense = [0x00, 0xf0, 0x02, 0x01, 0xf7, ...ONE_NOTE];
    const rendered = renderMidiToOpl2(readMidi(smf(nonsense)), 48000);

    expect(rendered.unreadableSysex).toBe(1);
    expect(rendered.instrumentsLoaded).toBe(0);
    expect(peak(rendered.samples)).toBeGreaterThan(0.01);
  });

  it('takes an instrument definition that is the right shape', () => {
    const definition = [0x7d, 0x00, 0x01, 0x01, 0x8f, 0x06, 0xf2, 0xf4, 0xf7, 0xf7, 0, 0, 0x0a];
    const events = [0x00, 0xf0, definition.length, ...definition, ...ONE_NOTE];
    const rendered = renderMidiToOpl2(readMidi(smf(events)), 48000);

    expect(rendered.instrumentsLoaded).toBe(1);
    expect(rendered.unreadableSysex).toBe(0);
  });

  it('plays several notes at once', () => {
    const chord = [
      0x00, 0x90, 60, 100, 0x00, 0x90, 64, 100, 0x00, 0x90, 67, 100, 0x60, 0x80, 60, 0, 0x00, 0x80,
      64, 0, 0x00, 0x80, 67, 0,
    ];
    const single = renderMidiToOpl2(readMidi(smf(ONE_NOTE)), 48000);
    const three = renderMidiToOpl2(readMidi(smf(chord)), 48000);

    // Three voices sounding together are louder than one.
    expect(peak(three.samples)).toBeGreaterThan(peak(single.samples));
  });
});

/**
 * Where a piece has got to, which is what `VAR_MUSIC_TIMER` holds.
 *
 * Not a clock: the original reads the sequencer's own position and a game paces
 * scenes against it, so a line lands on a beat because the script waited for
 * the beat. Counting sixtieths into the variable instead gave a number that
 * never went back to zero and never matched the music.
 */
describe('a score’s playing position', () => {
  it('converts back from seconds to the score’s own ticks', () => {
    const midi = readMidi(smf(ONE_NOTE));

    for (const tick of [0, 24, 96, 300, 961]) {
      const seconds = ticksToSeconds(tick, midi);
      expect(secondsToTicks(seconds, midi)).toBeCloseTo(tick, 3);
    }
  });

  it('follows a tempo change rather than averaging over it', () => {
    // One quarter note at 120bpm, then double speed. A ratio taken from either
    // tempo alone lands in the wrong bar.
    const events = [
      0x00,
      0xff,
      0x51,
      0x03,
      0x07,
      0xa1,
      0x20, // 500,000us per quarter note
      0x00,
      0x90,
      60,
      100,
      0x60,
      0xff,
      0x51,
      0x03,
      0x03,
      0xd0,
      0x90, // 250,000us from tick 96
    ];
    const midi = readMidi(smf(events));

    // Half a second is the first quarter note; the second half-second is two
    // of them, because the tempo doubled at tick 96.
    expect(secondsToTicks(0.5, midi)).toBeCloseTo(96, 3);
    expect(secondsToTicks(1, midi)).toBeCloseTo(96 + 192, 3);
  });

  it('is nothing at all before the piece has started', () => {
    const midi = readMidi(smf(ONE_NOTE));
    expect(secondsToTicks(0, midi)).toBe(0);
    expect(secondsToTicks(-1, midi)).toBe(0);
  });
});
