import { describe, expect, it } from 'vitest';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { SoundEngine } from '../src/engine/sound/SoundEngine.js';

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

/**
 * A one-entry bundle whose sample is `iMUS`-tagged and uncompressed.
 *
 * The header is twelve bytes — tag, then where the directory is and how many
 * entries it has — which is what makes a bundle openable in two range reads.
 */
const DIRECTORY_OFFSET = 12;
/** An `LB83` entry: an eight-byte stem, a four-byte extension, offset, size. */
const ENTRY_BYTES = 12 + 8;
const DATA_OFFSET = DIRECTORY_OFFSET + ENTRY_BYTES;

function bundleFile(stem: string, payload: number[]) {
  return new Uint8Array([
    ...ascii('LB83', 4),
    ...u32be(DIRECTORY_OFFSET),
    ...u32be(1),
    ...ascii(stem, 8),
    ...ascii('WAV', 4),
    ...u32be(DATA_OFFSET),
    ...u32be(payload.length),
    ...payload,
  ]);
}

/**
 * Reading a bundle a sample at a time.
 *
 * #148 stopped holding these files whole — a v7 bundle is hundreds of megabytes
 * and is addressed by offset — and kept a reader for the samples instead. The
 * reader was stored and never called, so every lookup read an empty buffer,
 * found nothing, and returned silence with nothing said about it: no music and
 * no speech in any v7 game, from a change whose whole point was elsewhere.
 *
 * These assert the reader is used, and that a cue is heard from its second
 * request rather than never.
 */
describe('a bundle opened by its directory', () => {
  async function openLazily(cue: string, payload: number[]) {
    const source = new MemoryDataSource('v7');
    source.set('MUSIC.BUN', bundleFile(cue, payload));

    const opened = await SoundEngine.openBundle(source, 'MUSIC.BUN');
    expect(opened).not.toBeNull();

    const logs: string[] = [];
    const sound = new SoundEngine();
    sound.onLog = (line) => logs.push(line);
    expect(sound.attachOpenedSpeechBundle(opened!.bundle, opened!.read)).toBe(true);
    return { sound, logs, read: opened!.read };
  }

  it('opens without reading the file whole', async () => {
    // Two range reads of a few kilobytes, which is the whole of #114's saving
    // for these files.
    const { sound } = await openLazily('THEME', [...ascii('iMUS', 4), ...u32be(0)]);
    expect(sound).toBeInstanceOf(SoundEngine);
  });

  it('fetches a sample on first use, and says the first play is late', async () => {
    const { sound, logs } = await openLazily('THEME', [...ascii('iMUS', 4), ...u32be(0)]);

    // Sound is off in a test environment, so what is asserted is that the
    // fetch was attempted and named — not that anything was heard.
    // Asked for by cue name, which is how a v7 script addresses speech — no
    // index needed, so this is the narrowest way in to the reader.
    expect(sound.startBundleSpeech('THEME.WAV')).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(logs.join('\n')).toMatch(/fetched on first use/);
  });

  it('reads the range the directory names, not the whole file', async () => {
    const payload = [...ascii('iMUS', 4), ...u32be(0)];
    const source = new MemoryDataSource('v7');
    source.set('MUSIC.BUN', bundleFile('THEME', payload));

    const asked: Array<[number, number]> = [];
    const opened = await SoundEngine.openBundle(source, 'MUSIC.BUN');
    const sound = new SoundEngine();
    sound.attachOpenedSpeechBundle(opened!.bundle, (start, end) => {
      asked.push([start, end]);
      return opened!.read(start, end);
    });

    sound.startBundleSpeech('THEME.WAV');
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The read must be the range the directory names — the sample's own — and
    // not the file's, which is the whole point of opening by directory.
    expect(asked).toEqual([[DATA_OFFSET, DATA_OFFSET + payload.length]]);
  });

  it('serves the cue once its first fetch lands, rather than never', async () => {
    // The trap: caching a null on the first request makes the cue permanently
    // silent, because the second request — the one that would have had its
    // bytes — never looks again.
    const { sound } = await openLazily('THEME', [...ascii('iMUS', 4), ...u32be(0)]);

    expect(sound.startBundleSpeech('THEME.WAV')).toBeNull();
    expect(sound.startBundleSpeech('THEME.WAV')).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The bytes are here now, so the cue reads — and it reads as a *duration*,
    // which is the half that matters even with sound off: a script waiting on
    // a line is really waiting on the length of its recording.
    expect(sound.startBundleSpeech('THEME.WAV')?.duration).toBeGreaterThan(0);
  });
});
