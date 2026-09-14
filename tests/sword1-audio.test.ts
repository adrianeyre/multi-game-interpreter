/**
 * Broken Sword 1's sound, which is the half of the install that is not in the
 * RIF.
 *
 * Three things are checked here and each of them was broken in a way that read
 * as working, which is the reason the tests are this specific:
 *
 * 1. A **tune is addressed by name**. `fnPlayMusic 8` is `MUSIC/1M10.WAV`, and
 *    looking for `MUSIC/8.WAV` finds nothing in any release ever shipped — so
 *    the music simply never started and the game went on in silence.
 * 2. **Speech is a container of its own**, listed by no cluster index. Asking
 *    the resource system for a speech id found nothing, the driver fell back to
 *    timing the subtitle, and that fallback is *correct* for an install with no
 *    speech — which is exactly why nobody could see it was firing for one that
 *    has it.
 * 3. The demo's container states its **length inside the compressed stream**.
 *    Reading it the retail way takes a compressed word as a byte count and asks
 *    for an output buffer of some hundreds of megabytes.
 */

import { describe, expect, it } from 'vitest';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { SwordSound } from '../src/engine/sword1/sound/SwordSound.js';
import type { SwordResources } from '../src/engine/sword1/resource/SwordResources.js';
import { sword1MusicFileIn, sword1SpeechFileIn } from '../src/engine/sword1/sound/musicFiles.js';
import { readSword1SpeechIndex } from '../src/engine/sword1/sound/speechIndex.js';
import { SWORD1_TUNE_NAMES, sword1TuneName } from '../src/engine/sword1/sound/tuneNames.js';
import {
  compressSpeech,
  expandSpeech,
  readSpeechRuns,
} from '../src/engine/sword1/sound/swordAudio.js';

/**
 * A speech container, built the way the game's own is.
 *
 * A `u32` of index length, then the index words: a room table whose entries are
 * *byte* offsets into those words, then one block per room where line `n` reads
 * its offset from word `base + 2n - 1` and its length from `base + 2n`. Two
 * neighbouring blocks share the boundary word, which is what makes a room's
 * line count recoverable from the distance to the next room's base.
 */
function speechContainer(
  rooms: readonly { room: number; lines: readonly (Uint8Array | null)[] }[],
): { bytes: Uint8Array; indexBytes: number; blockAt: Map<number, number> } {
  // The room table is indexed *by screen number*, so it is as long as the
  // highest screen the container holds and a screen with no dialogue is a zero
  // in it rather than a missing entry.
  const table = Math.max(...rooms.map((entry) => entry.room)) + 1;
  let at = table;
  const bases = rooms.map((entry) => {
    const base = at;
    at += entry.lines.length * 2;
    return base;
  });
  // One word past the last block, so the last room's line count is bounded the
  // same way every other room's is.
  const words = new Uint32Array(at + 1);
  const indexBytes = (words.length + 1) * 4;

  const payload: Uint8Array[] = [];
  let payloadAt = 0;
  rooms.forEach((entry, index) => {
    words[entry.room] = bases[index] * 4;
    entry.lines.forEach((line, lineIndex) => {
      const lengthAt = bases[index] + (lineIndex + 1) * 2;
      if (!line) return;
      words[lengthAt - 1] = payloadAt;
      words[lengthAt] = line.length;
      payload.push(line);
      payloadAt += line.length;
    });
  });

  const bytes = new Uint8Array(indexBytes + payloadAt);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, indexBytes, true);
  words.forEach((word, index) => view.setUint32(4 + index * 4, word, true));
  let to = indexBytes;
  for (const line of payload) {
    bytes.set(line, to);
    to += line.length;
  }
  return {
    bytes,
    indexBytes,
    blockAt: new Map(rooms.map((entry, index) => [entry.room, bases[index] as number])),
  };
}

/**
 * One line of the demo's compressed speech.
 *
 * `[1, low, …]` is what the original recognises as an embedded length
 * (`sound.cpp:640`): a run of one literal whose sample *is* the low half of the
 * byte count, and the high half four words later. The runs then decode as
 * normal — the first two samples are the length read as audio, which is why the
 * original blanks them.
 */
function demoLine(): Uint8Array {
  const words = [1, 8, 2, 0, 0x2222, -1, 0x3333];
  const bytes = new Uint8Array(8 + words.length * 2);
  bytes.set([0x64, 0x61, 0x74, 0x61], 4); // "data", with four bytes in front
  const view = new DataView(bytes.buffer);
  words.forEach((word, index) => view.setInt16(8 + index * 2, word, true));
  return bytes;
}

/**
 * A retail-shaped speech line: `data`, a byte count, then the runs.
 *
 * The count is what `expandSpeech` truncates to and `readSpeechRuns` ignores,
 * which is the difference the encoder depends on.
 */
function speechStream(words: readonly number[], samples: number): Uint8Array {
  const bytes = new Uint8Array(12 + words.length * 2);
  bytes.set([0x64, 0x61, 0x74, 0x61], 4);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, samples * 2, true);
  words.forEach((word, index) => view.setInt16(12 + index * 2, word, true));
  return bytes;
}

describe('tune names', () => {
  it('names a tune the way the game’s own files are named', () => {
    // Generated from `_tuneList`, never typed: ADR 0029.
    expect(sword1TuneName(8)).toBe('1m10');
    expect(SWORD1_TUNE_NAMES).toHaveLength(270);
  });

  it('answers nothing for a tune id the release does not name', () => {
    expect(sword1TuneName(0)).toBeNull();
  });

  it('finds a tune’s file by that name and not by its number', () => {
    const names = ['MUSIC/1M10.WAV', 'MUSIC/8.WAV'];
    expect(sword1MusicFileIn(names, 8)).toBe('MUSIC/1M10.WAV');
    // The old lookup took the second of those, which no release ships.
    expect(sword1MusicFileIn(['MUSIC/8.WAV'], 8)).toBeNull();
  });

  it('takes the extension the release happens to use', () => {
    expect(sword1MusicFileIn(['music/1m10.ogg'], 8)).toBe('music/1m10.ogg');
  });
});

describe('the speech container', () => {
  it('prefers the numbered disc container, then the demo’s', () => {
    expect(sword1SpeechFileIn(['SPEECH/SPEECH.CLU', 'SPEECH1.CLU'], 1)).toBe('SPEECH1.CLU');
    expect(sword1SpeechFileIn(['SPEECH/COWS.MAD'])).toBe('SPEECH/COWS.MAD');
    expect(sword1SpeechFileIn(['CLUSTERS/SCRIPTS.CLU'])).toBeNull();
  });

  it('locates a line by screen and number, past the index', async () => {
    const { bytes, indexBytes, blockAt } = speechContainer([
      { room: 1, lines: [new Uint8Array([1, 2, 3, 4]), null, new Uint8Array([5, 6])] },
      { room: 2, lines: [new Uint8Array([7, 8, 9])] },
    ]);
    const source = new MemoryDataSource('fixture', [['SPEECH/COWS.MAD', bytes]]);
    const index = await readSword1SpeechIndex(source, 'SPEECH/COWS.MAD');
    expect(index).not.toBeNull();
    expect(index?.indexBytes).toBe(indexBytes);
    // `lengthAt` is the index word holding the length, which a rebuild writes
    // back; take it from the fixture's own block rather than restate it.
    const lengthAt = (room: number, line: number): number =>
      (blockAt.get(room) as number) + line * 2;
    expect(index?.locate(1, 1)).toEqual({
      room: 1,
      line: 1,
      at: indexBytes,
      length: 4,
      lengthAt: lengthAt(1, 1),
    });
    // A line with no recording is a hole in the middle of a room's block, not
    // the end of it: room 1's third line is still there.
    expect(index?.locate(1, 2)).toBeNull();
    expect(index?.locate(1, 3)).toEqual({
      room: 1,
      line: 3,
      at: indexBytes + 4,
      length: 2,
      lengthAt: lengthAt(1, 3),
    });
    expect(index?.locate(2, 1)).toEqual({
      room: 2,
      line: 1,
      at: indexBytes + 6,
      length: 3,
      lengthAt: lengthAt(2, 1),
    });
    expect(index?.locate(9, 1)).toBeNull();
    expect(index?.entries()).toHaveLength(3);
  });

  it('answers nothing for a file that is not a container', async () => {
    const source = new MemoryDataSource('fixture', [
      ['SPEECH/COWS.MAD', new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0])],
    ]);
    expect(await readSword1SpeechIndex(source, 'SPEECH/COWS.MAD')).toBeNull();
  });
});

describe('the demo’s compressed speech', () => {
  it('reads the length out of the stream and blanks the words it read', () => {
    const decoded = expandSpeech(demoLine(), false, 'demo');
    expect(Array.from(decoded)).toEqual([0, 0, 0x2222, 0x3333]);
  });

  it('decodes to something else entirely when read as a retail line', () => {
    // Not an error, which is the trap: the retail reader takes a compressed
    // word as a byte count and produces a quarter of a million silent samples.
    expect(expandSpeech(demoLine(), false, 'wave').length).not.toBe(4);
  });

  it('refuses a length no line of dialogue could have', () => {
    const bytes = new Uint8Array(24);
    bytes.set([0x64, 0x61, 0x74, 0x61], 4);
    new DataView(bytes.buffer).setUint32(8, 0xffffff00, true);
    expect(() => expandSpeech(bytes, false, 'wave')).toThrow(/longer than ten minutes/);
  });
});

/**
 * The encoder, which is the half of the format that was missing.
 *
 * The claim it has to earn is the one `swordEncode.ts` earns for pictures: not
 * "it decodes back", which any self-consistent scheme manages, but *the bytes
 * Revolution shipped*. `npm run sweep:sword` makes that claim over a whole
 * install — 799 of the demo's 808 lines come back byte for byte, and the nine
 * that do not are ties, the same samples written a word differently at the end
 * of the stream. These tests are the rules that produce those bytes.
 */
describe('writing speech back', () => {
  it('re-encodes a stream to the bytes it was read from', () => {
    const words = [3, 1, 2, 3, -3, 7, 2, 4, 5];
    const stream = readSpeechRuns(speechStream(words, 8));
    expect(Array.from(stream.samples)).toEqual([1, 2, 3, 7, 7, 7, 4, 5]);

    const written = compressSpeech(stream.samples);
    const view = new DataView(written.buffer);
    expect(written.length).toBe(words.length * 2);
    expect(words.map((_, index) => view.getInt16(index * 2, true))).toEqual(words);
  });

  it('ends a literal run where the next pair of equal samples begins', () => {
    // The rule measured from every stream the demo ships: no literal run holds
    // two adjacent identical samples, and no repeat run is shorter than two.
    const written = compressSpeech(Int16Array.from([1, 2, 2]));
    const view = new DataView(written.buffer);
    expect([0, 1, 2, 3].map((index) => view.getInt16(index * 2, true))).toEqual([1, 1, -2, 2]);
  });

  it('writes the run counts little-endian while the samples follow the release', () => {
    // A Macintosh release stores the *samples* big-endian and the counts the
    // way every release does, which is the trap `expandSpeech` documents.
    expect(Array.from(compressSpeech(Int16Array.from([7, 7, 7]), true))).toEqual([
      0xfd, 0xff, 0x00, 0x07,
    ]);
    expect(Array.from(compressSpeech(Int16Array.from([7, 7, 7]), false))).toEqual([
      0xfd, 0xff, 0x07, 0x00,
    ]);
  });

  it('splits a run longer than a signed word can count', () => {
    const written = compressSpeech(new Int16Array(40000).fill(9));
    const view = new DataView(written.buffer);
    expect(written.length).toBe(8);
    expect(view.getInt16(0, true)).toBe(-32767);
    expect(view.getInt16(4, true)).toBe(-(40000 - 32767));
  });

  it('round-trips samples that are neither all runs nor all literals', () => {
    const samples = new Int16Array(5000);
    // Deterministic rather than random: a test that fails once a week is a
    // test nobody reads.
    for (let at = 0; at < samples.length; at++) {
      samples[at] = at % 7 === 0 ? (at % 13) - 6 : Math.trunc(at / 11) % 5;
    }
    const written = compressSpeech(samples);
    const again = readSpeechRuns(speechStream([], 0));
    expect(again.samples.length).toBe(0);

    const stream = new Uint8Array(12 + written.length);
    stream.set([0x64, 0x61, 0x74, 0x61], 4);
    new DataView(stream.buffer).setUint32(8, samples.length * 2, true);
    stream.set(written, 12);
    expect(Array.from(readSpeechRuns(stream).samples)).toEqual(Array.from(samples));
  });

  it('keeps the samples a container’s stated length would cut off', () => {
    // The demo's length counts the audio and not the two samples it is written
    // as, so the runs produce two more than it says. `expandSpeech` drops them
    // — correctly, they are the length read as audio — and an encoder fed that
    // shortened stream could never give the shipped bytes back.
    const line = demoLine();
    expect(Array.from(expandSpeech(line, false, 'demo'))).toEqual([0, 0, 0x2222, 0x3333]);
    expect(Array.from(readSpeechRuns(line, false, 'demo').samples)).toEqual([8, 0, 0x2222, 0x3333]);
  });
});

describe('the sound object', () => {
  const resources = {} as SwordResources;

  it('asks for the tune’s own file rather than for its number', async () => {
    const asked: string[] = [];
    const sound = new SwordSound(resources, ['MUSIC/1M10.WAV'], async (name) => {
      asked.push(name);
      return null;
    });
    sound.playMusic(8, false);
    await Promise.resolve();
    expect(asked).toEqual(['MUSIC/1M10.WAV']);
  });

  it('tells the script driver a line will play, and only when it will', async () => {
    const { bytes } = speechContainer([{ room: 1, lines: [demoLine()] }]);
    const source = new MemoryDataSource('fixture', [['SPEECH/COWS.MAD', bytes]]);
    const sound = new SwordSound(resources, ['SPEECH/COWS.MAD']);

    // Before the container is attached there is nothing to play, and saying so
    // is what keeps the subtitle on screen for its own count.
    expect(sound.startSpeech(1, 1)).toBe(false);

    sound.attachSpeech(source);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sound.startSpeech(1, 1)).toBe(true);
    expect(sound.startSpeech(1, 2)).toBe(false);
    expect(sound.startSpeech(99, 1)).toBe(false);
  });

  it('reads the line without hanging on a decode it cannot do', async () => {
    const { bytes } = speechContainer([{ room: 1, lines: [new Uint8Array(12)] }]);
    const source = new MemoryDataSource('fixture', [['SPEECH/COWS.MAD', bytes]]);
    const sound = new SwordSound(resources, ['SPEECH/COWS.MAD']);
    sound.attachSpeech(source);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sound.startSpeech(1, 1)).toBe(true);
    await sound.pump();
    // A line with no `data` tag cannot decode; the driver is told it is over
    // rather than left waiting on a sample that will never finish.
    expect(sound.speechFinished()).toBe(true);
    expect(sound.describe()).toMatch(/notes/);
  });
});
