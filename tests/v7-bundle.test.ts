import { describe, expect, it } from 'vitest';
import {
  BUNDLE_BLOCK_SIZE,
  decompressedSize,
  readBundle,
  readSample,
} from '../src/engine/sound/v7/bundle.js';

/** Big-endian, as everything in a bundle is. */
const u32be = (value: number) => [
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff,
];

const ascii = (text: string, length: number) => {
  const out = new Array(length).fill(0);
  for (let i = 0; i < Math.min(text.length, length); i++) out[i] = text.charCodeAt(i);
  return out;
};

/** A bundle with one entry, whose data begins at `dataOffset`. */
function buildBundle({
  tag = 'LB83',
  stem = 'ROADHOUS',
  extension = 'WAV',
  payload = [] as number[],
} = {}) {
  const header = [...ascii(tag, 4), ...u32be(0), ...u32be(1)];
  const dirOffset = 12;
  const entry = [...ascii(stem, 8), ...ascii(extension, 4), ...u32be(0), ...u32be(payload.length)];
  const dataOffset = dirOffset + entry.length;

  const bytes = [
    ...ascii(tag, 4),
    ...u32be(dirOffset),
    ...u32be(1),
    ...ascii(stem, 8),
    ...ascii(extension, 4),
    ...u32be(dataOffset),
    ...u32be(payload.length),
    ...payload,
  ];
  void header;
  void entry;
  return new Uint8Array(bytes);
}

describe('a .BUN directory', () => {
  it('joins the eight-byte stem and four-byte extension with a dot', () => {
    // Read as one twelve-byte string this gives `ROADHOUSWAV`, which never
    // matches a lookup — a game with no sound and no error.
    const bundle = readBundle(buildBundle(), 'MUSIC.BUN')!;
    expect([...bundle.entries.keys()]).toEqual(['ROADHOUS.WAV']);
  });

  it('reads the long-name variant as one field', () => {
    const bytes = new Uint8Array([
      ...ascii('LB23', 4),
      ...u32be(12),
      ...u32be(1),
      ...ascii('A_LONG_NAME.WAV', 24),
      ...u32be(44),
      ...u32be(0),
    ]);
    const bundle = readBundle(bytes, 'VOICE.BUN')!;
    expect([...bundle.entries.keys()]).toEqual(['A_LONG_NAME.WAV']);
  });

  it('returns null for a file that is not a bundle', () => {
    // A missing or wrong bundle is a game with no speech; naming it beats an
    // exception from wherever a script first asks for a line.
    expect(readBundle(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), 'x')).toBeNull();
  });

  it('stops at the end of the file rather than reading past the directory', () => {
    const truncated = buildBundle().subarray(0, 16);
    expect(readBundle(truncated, 'MUSIC.BUN')!.entries.size).toBe(0);
  });
});

describe('a sample inside a bundle', () => {
  it('reads an uncompressed iMUS entry as its own bytes', () => {
    const payload = [...ascii('iMUS', 4), 1, 2, 3, 4];
    const bytes = buildBundle({ payload });
    const bundle = readBundle(bytes, 'VOICE.BUN')!;

    const sample = readSample(bundle, bytes, 'ROADHOUS.WAV')!;
    expect(sample.kind).toBe('uncompressed');
    expect(sample.data.length).toBe(payload.length);
  });

  it('reads a COMP block table, with each block’s own codec', () => {
    const payload = [
      ...ascii('COMP', 4),
      ...u32be(2), // block count
      ...u32be(0), // skipped
      ...u32be(1000), // decompressed size of the last block
      ...u32be(100),
      ...u32be(50),
      ...u32be(13),
      ...u32be(0),
      ...u32be(200),
      ...u32be(60),
      ...u32be(13),
      ...u32be(0),
    ];
    const bytes = buildBundle({ payload });
    const bundle = readBundle(bytes, 'MUSIC.BUN')!;

    const sample = readSample(bundle, bytes, 'ROADHOUS.WAV')!;
    expect(sample.kind).toBe('compressed');
    expect(sample.blocks).toHaveLength(2);
    expect(sample.blocks[0]).toEqual({ offset: 100, size: 50, codec: 13 });
    expect(sample.lastBlockSize).toBe(1000);
  });

  it('knows a compressed sample’s length without decoding it', () => {
    // The length `Speech wait` needs. The v6 lesson was that getting it wrong
    // gives speech cut off or a wait that never returns — a broken game even
    // for a player with the sound off.
    const payload = [
      ...ascii('COMP', 4),
      ...u32be(3),
      ...u32be(0),
      ...u32be(500),
      ...new Array(3).fill(0).flatMap(() => [...u32be(0), ...u32be(0), ...u32be(13), ...u32be(0)]),
    ];
    const bytes = buildBundle({ payload });
    const bundle = readBundle(bytes, 'MUSIC.BUN')!;
    const sample = readSample(bundle, bytes, 'ROADHOUS.WAV')!;

    expect(decompressedSize(sample)).toBe(2 * BUNDLE_BLOCK_SIZE + 500);
  });

  it('finds an entry whatever case the caller asks in', () => {
    // The index's ANAM names and the bundle's directory disagree about case,
    // so a lookup that respected it would find nothing.
    const bytes = buildBundle({ payload: [...ascii('iMUS', 4)] });
    const bundle = readBundle(bytes, 'VOICE.BUN')!;
    expect(readSample(bundle, bytes, 'roadhous.wav')).not.toBeNull();
  });

  it('returns null for a name the bundle does not hold', () => {
    const bytes = buildBundle({ payload: [...ascii('iMUS', 4)] });
    const bundle = readBundle(bytes, 'VOICE.BUN')!;
    expect(readSample(bundle, bytes, 'NOPE.WAV')).toBeNull();
  });
});

describe('playing a line of bundle speech', () => {
  it('reports a line’s length even when there is no audio output', async () => {
    // The duration is the point as much as the sound is: a script that waits on
    // speech needs it, and a player with audio off still needs the line to stay
    // up for the right length of time.
    const { SoundEngine } = await import('../src/engine/sound/SoundEngine.js');
    const sound = new SoundEngine();

    // One stored block of 16-bit samples: 8 frames at 22050 Hz.
    const pcm = new Array(16).fill(0);
    const payload = [
      ...ascii('COMP', 4),
      ...u32be(1),
      ...u32be(0),
      ...u32be(pcm.length),
      ...u32be(0),
      ...u32be(pcm.length),
      ...u32be(0), // codec 0: stored
      ...u32be(0),
    ];
    const bytes = buildBundle({ payload });

    // Point the single block at the PCM appended after the table.
    const withPcm = new Uint8Array([...bytes, ...pcm]);
    const view = new DataView(withPcm.buffer);
    // The block's offset field is the first u32 of the block entry.
    const blockOffsetAt = bytes.length - payload.length + 4 + 16;
    view.setUint32(blockOffsetAt, bytes.length, false);

    expect(sound.attachSpeechBundle(withPcm, 'VOICE.BUN')).toBe(true);
    const played = sound.startBundleSpeech('ROADHOUS.WAV');
    expect(played?.duration).toBeCloseTo(8 / 22050, 6);
  });

  it('refuses a file that is not a bundle, so the caller can say which', async () => {
    const { SoundEngine } = await import('../src/engine/sound/SoundEngine.js');
    const sound = new SoundEngine();
    expect(sound.attachSpeechBundle(new Uint8Array(12), 'VOICE.BUN')).toBe(false);
  });

  it('gives nothing for a name the bundle does not hold', async () => {
    const { SoundEngine } = await import('../src/engine/sound/SoundEngine.js');
    const sound = new SoundEngine();
    sound.attachSpeechBundle(buildBundle({ payload: [...ascii('iMUS', 4)] }), 'VOICE.BUN');
    expect(sound.startBundleSpeech('NOPE.WAV')).toBeNull();
  });

  it('names a codec it cannot decode, once, rather than playing noise', async () => {
    const { SoundEngine } = await import('../src/engine/sound/SoundEngine.js');
    const sound = new SoundEngine();
    const logs: string[] = [];
    sound.onLog = (line) => logs.push(line);

    const payload = [
      ...ascii('COMP', 4),
      ...u32be(1),
      ...u32be(0),
      ...u32be(64),
      ...u32be(0),
      ...u32be(8),
      ...u32be(13), // ADPCM: v8's, not implemented
      ...u32be(0),
    ];
    sound.attachSpeechBundle(buildBundle({ payload }), 'VOICE.BUN');

    expect(sound.startBundleSpeech('ROADHOUS.WAV')).toBeNull();
    sound.startBundleSpeech('ROADHOUS.WAV');
    expect(logs.filter((line) => line.includes('codec 13'))).toHaveLength(1);
  });
});

describe('opening a bundle without reading it', () => {
  it('reads only the header and the directory', async () => {
    // The saving #114 is about: Full Throttle's bundles are the bulk of an
    // install, and opening one should cost a few kilobytes rather than
    // hundreds of megabytes.
    const { SoundEngine } = await import('../src/engine/sound/SoundEngine.js');
    const { MemoryDataSource } = await import('../src/engine/resource/DataSource.js');

    const bytes = buildBundle({ payload: [...ascii('iMUS', 4), 1, 2, 3, 4] });
    const source = new MemoryDataSource('m', [['VOICE.BUN', bytes]]);

    const ranges: Array<[number, number]> = [];
    const wrapped = {
      label: 'm',
      list: () => source.list(),
      read: (name: string) => source.read(name),
      readRange: (name: string, start: number, end: number) => {
        ranges.push([start, end]);
        return source.readRange(name, start, end);
      },
    };

    const opened = await SoundEngine.openBundle(wrapped, 'VOICE.BUN');
    expect(opened).not.toBeNull();
    expect([...opened!.bundle.entries.keys()]).toEqual(['ROADHOUS.WAV']);

    // Two reads: the twelve-byte header, then the directory. Never the whole.
    expect(ranges).toHaveLength(2);
    expect(ranges[0]).toEqual([0, 12]);
    expect(ranges[1][1] - ranges[1][0]).toBeLessThan(bytes.length);
  });

  it('gives nothing for a file that is not a bundle', async () => {
    const { SoundEngine } = await import('../src/engine/sound/SoundEngine.js');
    const { MemoryDataSource } = await import('../src/engine/resource/DataSource.js');

    const source = new MemoryDataSource('m', [['X.BUN', new Uint8Array(16)]]);
    expect(await SoundEngine.openBundle(source, 'X.BUN')).toBeNull();
  });

  it('gives nothing for a file that is not there', async () => {
    const { SoundEngine } = await import('../src/engine/sound/SoundEngine.js');
    const { MemoryDataSource } = await import('../src/engine/resource/DataSource.js');
    expect(await SoundEngine.openBundle(new MemoryDataSource('m'), 'NOPE.BUN')).toBeNull();
  });
});
