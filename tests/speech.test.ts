import { describe, expect, it } from 'vitest';
import { buildVocPayload } from './fixture.js';
import {
  readSpeechSample,
  speechDurationFrames,
  textDurationFrames,
} from '../src/engine/sound/speech.js';

/**
 * Reading recorded speech out of a talkie release's speech file.
 *
 * Built here rather than taken from a game, so the sample's contents are known
 * and its duration can be asserted rather than eyeballed.
 */
function u32be(value: number): number[] {
  return [(value >> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function tag(name: string): number[] {
  return [...name].map((character) => character.charCodeAt(0));
}

/**
 * A VOC of `sampleCount` samples at 11025 Hz.
 *
 * Built from the same helper the v5 fixture uses for its sound resource: the
 * format is exact about its header fields, and a second hand-rolled copy of it
 * here would be testing my VOC writer rather than the speech reader.
 */
function voc(sampleCount: number): number[] {
  const payload = buildVocPayload();
  // A VOC header is 0x1a bytes; the sound block follows it as
  // `1, size(3), divisor, codec, samples…, 0`.
  const blockAt = 0x1a;
  const head = payload.slice(0, blockAt + 6);
  const blockSize = sampleCount + 2;
  head[blockAt + 1] = blockSize & 0xff;
  head[blockAt + 2] = (blockSize >> 8) & 0xff;
  head[blockAt + 3] = (blockSize >> 16) & 0xff;

  return [...head, ...new Array(sampleCount).fill(128), 0];
}

/**
 * One sample in the file: a VCTL header, its sync times, then the audio.
 *
 * The VOC follows the header immediately, with nothing between them. That is
 * how Full Throttle's `MONSTER.SOU` is laid out, and it is worth being exact
 * about because this fixture used to insert an eight-byte `Crea` chunk header
 * that no release has — invented to match what the reader then did, so the two
 * agreed with each other and disagreed with every real file. The `Crea` the
 * reader looks for is the first four characters of `Creative Voice File`.
 */
function speechFile({ syncTimes = [10, 20], samples = 11025 } = {}) {
  const vctlSize = 8 + syncTimes.length * 2;
  const audio = voc(samples);

  return {
    bytes: new Uint8Array([
      ...tag('VCTL'),
      ...u32be(vctlSize),
      ...syncTimes.flatMap((time) => [(time >> 8) & 0xff, time & 0xff]),
      ...audio,
    ]),
    vctlSize,
  };
}

describe('reading a line of speech', () => {
  it('finds the audio past the sync times', () => {
    const { bytes, vctlSize } = speechFile();
    const sample = readSpeechSample(bytes, 0, vctlSize);

    expect(sample).not.toBeNull();
    expect(sample!.pcm.samples.length).toBeGreaterThan(0);
  });

  it('reads the mouth-sync cues, which are not audio', () => {
    const { bytes, vctlSize } = speechFile({ syncTimes: [5, 15, 25] });
    expect(readSpeechSample(bytes, 0, vctlSize)!.syncTimes).toEqual([5, 15, 25]);
  });

  it('reports the real duration, not the size the script passed', () => {
    // A second of audio at 11025 Hz. The script's "length" is the VCTL header
    // size — reading that as a duration is the obvious mistake, and it would
    // give a fraction of a second here.
    const { bytes, vctlSize } = speechFile({ samples: 11025 });
    const sample = readSpeechSample(bytes, 0, vctlSize)!;

    expect(sample.duration).toBeCloseTo(1, 1);
    expect(sample.duration).not.toBeCloseTo(vctlSize, 0);
  });

  it('reads a VTLK-wrapped sample as well as a bare one', () => {
    const audio = voc(2205);
    // `VTLK` is a real chunk, unlike `Crea`: tag, then a size covering the
    // whole block including those eight bytes, then the VOC.
    const bytes = new Uint8Array([
      ...tag('VCTL'),
      ...u32be(8),
      ...tag('VTLK'),
      ...u32be(audio.length + 8),
      ...audio,
    ]);

    const sample = readSpeechSample(bytes, 0, 8);
    expect(sample).not.toBeNull();
    expect(sample!.pcm.samples.length).toBe(2205);
  });

  it('starts a bare sample at the VOC header rather than eight bytes past it', () => {
    // The regression that kept every talkie silent. Reading from `audioAt + 8`
    // lands inside "Creative Voice File", which `decodeVoc` rejects as not a
    // VOC — so the line reported no speech instead of playing. Counting the
    // samples is what pins it: a reader that started late but still decoded
    // would pass a null check.
    const { bytes, vctlSize } = speechFile({ samples: 4410 });
    const sample = readSpeechSample(bytes, 0, vctlSize);

    expect(sample).not.toBeNull();
    expect(sample!.pcm.samples.length).toBe(4410);
  });
});

describe('when the speech file will not give up a sample', () => {
  /**
   * None of these should stop the game. A line without audio is a line with
   * subtitles; an exception mid-cutscene is a broken game.
   */
  it('returns null for an offset past the end of the file', () => {
    const { bytes, vctlSize } = speechFile();
    expect(readSpeechSample(bytes, bytes.length + 100, vctlSize)).toBeNull();
  });

  it('returns null when the offset does not point at a VCTL block', () => {
    const { bytes, vctlSize } = speechFile();
    expect(readSpeechSample(bytes, 4, vctlSize)).toBeNull();
  });

  it('returns null for a file truncated mid-sample', () => {
    const { bytes, vctlSize } = speechFile();
    expect(readSpeechSample(bytes.subarray(0, 20), 0, vctlSize)).toBeNull();
  });

  it('returns null for audio in a format it does not read', () => {
    const bytes = new Uint8Array([
      ...tag('VCTL'),
      ...u32be(8),
      ...tag('MP3 '),
      ...u32be(100),
      ...new Array(92).fill(0),
    ]);
    expect(readSpeechSample(bytes, 0, 8)).toBeNull();
  });
});

describe('how long a line stays up', () => {
  /**
   * The load-bearing part even for a player with sound off: a script waiting
   * for a line to finish is waiting for this number.
   */
  it('uses the audio length when there is speech', () => {
    // Two seconds at 60 frames a second.
    expect(speechDurationFrames(2)).toBe(120);
  });

  it('never rounds a short sample down to nothing', () => {
    expect(speechDurationFrames(0.001)).toBeGreaterThan(0);
  });

  it('falls back to the text length, the way the floppy releases paced', () => {
    expect(textDurationFrames('a'.repeat(40), 4)).toBe(160);
  });

  it('honours the per-character delay the game itself sets', () => {
    expect(textDurationFrames('a'.repeat(40), 8)).toBe(320);
  });

  it('keeps a very short line on screen long enough to read', () => {
    expect(textDurationFrames('Hi', 4)).toBe(30);
  });

  it('treats a zero delay as the default rather than as no delay', () => {
    // VAR_CHARINC is zero before a game sets it, and a zero here would flash
    // every line off the screen in the frame it appeared.
    expect(textDurationFrames('a'.repeat(40), 0)).toBe(160);
  });
});
