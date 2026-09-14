import { describe, expect, it } from 'vitest';
import {
  rebuildSword1Speech,
  Sword1SpeechError,
  sword1SpeechMode,
  sword1SpeechSamples,
  writeSword1SpeechLine,
} from '../src/authoring/sword1/speechContainer.js';
import { parseSword1SpeechIndex } from '../src/engine/sword1/sound/speechIndex.js';
import { compressSpeech, expandSpeech } from '../src/engine/sword1/sound/swordAudio.js';
import { readWavePcm, resampleWavePcm, writeWavePcm } from '../src/engine/sound/wave.js';
import {
  isSword1Replacement,
  isSword1SpeechReplacement,
  Sword1AudioExportError,
  sword1AudioReplacements,
} from '../src/editor/sword1/audioExport.js';
import type { Sword1GameFolder } from '../src/editor/sword1/resupply.js';
import type { RifIndex } from '../src/engine/sword1/resource/rif.js';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { createProject } from '../src/authoring/project.js';
import type { Project } from '../src/authoring/project.js';
import type { AudioResource, ProjectAudio } from '../src/authoring/audio.js';

/**
 * A line as a container holds one: forty bytes of WAVE header, then the runs.
 *
 * Written out here rather than through `writeSword1SpeechLine`, because a
 * fixture built by the code under test proves nothing. The layout is the one
 * measured in the demo's own `COWS.MAD` — `RIFF`, a `fmt ` chunk saying
 * 11,025 Hz mono 16-bit, and the `data` tag at byte 36 with the run stream
 * beginning immediately after it at 40.
 */
function demoLine(samples: Int16Array): Uint8Array {
  const stated = (samples.length + 2) * 2;
  const full = new Int16Array(samples.length + 2);
  full[0] = stated & 0xffff;
  full[1] = stated >>> 16;
  full.set(samples, 2);
  const runs = compressSpeech(full);

  const out = new Uint8Array(40 + runs.length);
  const view = new DataView(out.buffer);
  const put = (at: number, text: string): void => {
    for (let index = 0; index < text.length; index++) out[at + index] = text.charCodeAt(index);
  };
  put(0, 'RIFF');
  view.setUint32(4, 36 + stated, true);
  put(8, 'WAVE');
  put(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 11025, true);
  view.setUint32(28, 22050, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  put(36, 'data');
  out.set(runs, 40);
  return out;
}

/** The retail shape: the same header, then a stated length, then the runs. */
function waveLine(samples: Int16Array): Uint8Array {
  const runs = compressSpeech(samples);
  const out = new Uint8Array(44 + runs.length);
  const head = demoLine(new Int16Array(0)).subarray(0, 40);
  out.set(head, 0);
  const view = new DataView(out.buffer);
  view.setUint32(4, 36 + samples.length * 2, true);
  view.setUint32(40, samples.length * 2, true);
  out.set(runs, 44);
  return out;
}

/**
 * A whole container: a two-room index and the recordings behind it.
 *
 * Room 0 has three lines of which the middle one was never recorded, and room
 * 1 has two — enough to exercise the three things the index does that a
 * simpler fixture would miss. Its rooms' blocks overlap by a word, a
 * zero-length entry sits in the *middle* of a block rather than at its end,
 * and a payload that changes size has lines after it to move.
 */
function container(
  lines: readonly Uint8Array[],
  options: { gap?: number; trailing?: number } = {},
): { data: Uint8Array; indexBytes: number; at: number[] } {
  const words = new Uint32Array(13);
  const indexBytes = (words.length + 1) * 4;
  words[0] = 2 * 4; // room 0's block begins at word 2
  words[1] = 8 * 4; // room 1's at word 8

  const gap = options.gap ?? 0;
  const at: number[] = [];
  let cursor = indexBytes;
  // Index words: (offset, length) pairs read one word early, so line n of a
  // room whose block is at `base` has its length at `base + n * 2`.
  const slots = [4, 6, 8, 10, 12];
  const present = [lines[0], undefined, lines[1], lines[2], lines[3]];
  for (let slot = 0; slot < slots.length; slot++) {
    const bytes = present[slot];
    if (!bytes) continue;
    cursor += gap;
    at.push(cursor);
    words[slots[slot]!] = bytes.length;
    words[slots[slot]! - 1] = cursor - indexBytes;
    cursor += bytes.length;
  }

  const trailing = options.trailing ?? 0;
  const data = new Uint8Array(cursor + trailing);
  const view = new DataView(data.buffer);
  view.setUint32(0, indexBytes, true);
  for (let word = 0; word < words.length; word++) view.setUint32(4 + word * 4, words[word]!, true);
  let write = indexBytes;
  let index = 0;
  for (const bytes of present) {
    if (!bytes) continue;
    write += gap;
    data.set(bytes, write);
    write += bytes.length;
    index++;
  }
  for (let byte = 0; byte < trailing; byte++) data[cursor + byte] = 0xa5;
  expect(index).toBe(at.length);
  return { data, indexBytes, at };
}

/** Something with structure in it, so a re-encode has runs of both kinds. */
function speech(length: number, seed: number): Int16Array {
  const samples = new Int16Array(length);
  for (let at = 0; at < length; at++) {
    samples[at] = at % 7 < 3 ? seed * 100 : Math.round(Math.sin((at + seed) / 3) * 6000);
  }
  return samples;
}

const FOUR = [speech(60, 1), speech(48, 2), speech(72, 3), speech(36, 4)] as const;
const LINES = FOUR.map((samples) => demoLine(samples));

describe('reading and writing PCM WAVE', () => {
  it('reads back what it wrote, sample for sample', () => {
    const samples = speech(50, 5);
    const pcm = readWavePcm(writeWavePcm(samples, 11025));
    expect(pcm?.sampleRate).toBe(11025);
    expect(pcm?.channels).toBe(1);
    expect(pcm?.bits).toBe(16);
    expect(Array.from(pcm!.samples)).toEqual(Array.from(samples));
  });

  it('scales an 8-bit file to the same numbers a float decode would give', () => {
    // 128 is silence in the unsigned 8-bit form, and `(byte - 128) << 8` is
    // exactly `(byte - 128) / 128` scaled to 16 bits.
    const body = Uint8Array.from([128, 255, 0, 192]);
    const bytes = new Uint8Array(44 + body.length);
    bytes.set(writeWavePcm(new Int16Array(0), 22050).subarray(0, 44));
    const view = new DataView(bytes.buffer);
    view.setUint16(32, 1, true); // block align
    view.setUint16(34, 8, true); // bits per sample
    view.setUint32(40, body.length, true);
    bytes.set(body, 44);
    expect(Array.from(readWavePcm(bytes)!.samples)).toEqual([0, 32512, -32768, 16384]);
  });

  it('answers nothing for bytes that are not a WAVE', () => {
    expect(readWavePcm(new TextEncoder().encode('OggS and then some'))).toBeNull();
    expect(readWavePcm(new Uint8Array(3))).toBeNull();
  });

  it('resamples to the rate the game plays, keeping both ends', () => {
    const samples = Int16Array.from([0, 1000, 2000, 3000, 4000, 5000, 6000, 7000]);
    const half = resampleWavePcm(samples, 22050, 11025);
    expect(half.length).toBe(4);
    expect(half[0]).toBe(0);
    expect(half[half.length - 1]).toBe(7000);
    // The rate it already is comes back untouched, by identity rather than by
    // a round trip through the arithmetic.
    expect(resampleWavePcm(samples, 11025, 11025)).toBe(samples);
  });
});

describe('which container a file is', () => {
  it('reads the demo’s by name, the way the original sets CowDemo', () => {
    expect(sword1SpeechMode('SPEECH/COWS.MAD')).toBe('demo');
    expect(sword1SpeechMode('speech\\cows.mad')).toBe('demo');
    expect(sword1SpeechMode('SPEECH1.CLU')).toBe('wave');
  });
});

describe('rebuilding a Broken Sword speech container', () => {
  it('copies one back byte-identically when nothing was replaced', () => {
    // The property the export depends on, and the reason `reexport:sword` can
    // diff a whole install: 43.9 MB of recordings that nobody touched come
    // back as themselves.
    const built = container(LINES);
    const rebuilt = rebuildSword1Speech('SPEECH/COWS.MAD', built.data);
    expect(Array.from(rebuilt.data)).toEqual(Array.from(built.data));
    expect(rebuilt.copied).toBe(4);
    expect(rebuilt.replaced).toEqual([]);
  });

  it('keeps the padding between recordings, and anything after the last', () => {
    const built = container(LINES, { gap: 6, trailing: 5 });
    const rebuilt = rebuildSword1Speech('SPEECH/COWS.MAD', built.data);
    expect(Array.from(rebuilt.data)).toEqual(Array.from(built.data));
  });

  it('writes a replaced line back so the game’s own reader decodes it', () => {
    const built = container(LINES);
    const wanted = speech(90, 9);
    const rebuilt = rebuildSword1Speech('SPEECH/COWS.MAD', built.data, [
      { room: 0, line: 1, wav: writeWavePcm(wanted, 11025) },
    ]);
    expect(rebuilt.replaced).toEqual(['screen 0 line 1']);

    const index = parseSword1SpeechIndex('SPEECH/COWS.MAD', rebuilt.data)!;
    const entry = index.locate(0, 1)!;
    const decoded = expandSpeech(
      rebuilt.data.subarray(entry.at, entry.at + entry.length),
      false,
      'demo',
    );
    // The demo states a line's length *inside* its run stream, so the first
    // two samples are that length and `expandSpeech` zeroes them. The audio
    // starts after them, and all of it has to be there.
    expect(decoded.length).toBe(wanted.length + 2);
    expect(decoded[0]).toBe(0);
    expect(Array.from(decoded.subarray(2))).toEqual(Array.from(wanted));
  });

  it('states the new length in the header, where the reader looks for it', () => {
    const built = container(LINES);
    const wanted = speech(90, 9);
    const rebuilt = rebuildSword1Speech('SPEECH/COWS.MAD', built.data, [
      { room: 0, line: 1, wav: writeWavePcm(wanted, 11025) },
    ]);
    const index = parseSword1SpeechIndex('SPEECH/COWS.MAD', rebuilt.data)!;
    const entry = index.locate(0, 1)!;
    const line = rebuilt.data.subarray(entry.at, entry.at + entry.length);
    const view = new DataView(line.buffer, line.byteOffset, line.byteLength);
    // `RIFF`'s size is the tag's offset plus the stated byte length, which is
    // what the demo's own lines hold: room 0 line 1 of COWS.MAD states 124,558
    // against a size of 124,594.
    expect(view.getUint32(4, true)).toBe(36 + (wanted.length + 2) * 2);
  });

  it('moves the recordings after a shortened line and leaves their bytes alone', () => {
    const built = container(LINES);
    const before = parseSword1SpeechIndex('SPEECH/COWS.MAD', built.data)!;
    const rebuilt = rebuildSword1Speech('SPEECH/COWS.MAD', built.data, [
      { room: 0, line: 1, wav: writeWavePcm(speech(4, 1), 11025) },
    ]);
    const after = parseSword1SpeechIndex('SPEECH/COWS.MAD', rebuilt.data)!;

    expect(rebuilt.data.length).toBeLessThan(built.data.length);
    for (const [room, line] of [
      [0, 3],
      [1, 1],
      [1, 2],
    ] as const) {
      const was = before.locate(room, line)!;
      const now = after.locate(room, line)!;
      expect(now.at).toBeLessThan(was.at);
      expect(now.length).toBe(was.length);
      expect(Array.from(rebuilt.data.subarray(now.at, now.at + now.length))).toEqual(
        Array.from(built.data.subarray(was.at, was.at + was.length)),
      );
    }
  });

  it('leaves a line the release never recorded as the zero it was', () => {
    // Room 0's line 2 has a length of zero in the middle of its block, which
    // is the case a reader that stopped at the first zero would lose.
    const built = container(LINES);
    const rebuilt = rebuildSword1Speech('SPEECH/COWS.MAD', built.data, [
      { room: 0, line: 1, wav: writeWavePcm(speech(20, 1), 11025) },
    ]);
    const index = parseSword1SpeechIndex('SPEECH/COWS.MAD', rebuilt.data)!;
    expect(index.locate(0, 2)).toBeNull();
    expect(index.locate(0, 3)).not.toBeNull();
  });

  it('refuses a replacement for a line the release never recorded', () => {
    const built = container(LINES);
    expect(() =>
      rebuildSword1Speech('SPEECH/COWS.MAD', built.data, [
        { room: 0, line: 2, wav: writeWavePcm(speech(20, 1), 11025) },
      ]),
    ).toThrow(/screen 0 line 2.*nowhere to go/s);
  });

  it('refuses a replacement that is not a PCM WAVE', () => {
    const built = container(LINES);
    expect(() =>
      rebuildSword1Speech('SPEECH/COWS.MAD', built.data, [
        { room: 0, line: 1, wav: new TextEncoder().encode('OggS not a wave at all') },
      ]),
    ).toThrow(Sword1SpeechError);
  });

  it('refuses bytes that do not begin with an index', () => {
    expect(() => rebuildSword1Speech('SPEECH/COWS.MAD', new Uint8Array(64).fill(0xff))).toThrow(
      /does not begin with a speech index/,
    );
  });

  it('refuses a container whose recordings overlap', () => {
    const built = container(LINES);
    // Point room 1 line 1 into the middle of the recording before it, which is
    // a layout this cannot lay out again without moving bytes it cannot
    // account for.
    const view = new DataView(built.data.buffer);
    view.setUint32(4 + 9 * 4, built.at[1]! - built.indexBytes + 4, true);
    expect(() => rebuildSword1Speech('SPEECH/COWS.MAD', built.data)).toThrow(
      /inside the recording before it/,
    );
  });

  it('treats two entries at one offset as the one recording they are', () => {
    const built = container(LINES);
    // Room 1 line 2 pointed at room 1 line 1's bytes: one recording the release
    // names twice, which is a thing these containers do.
    const view = new DataView(built.data.buffer);
    view.setUint32(4 + 11 * 4, built.at[2]! - built.indexBytes, true);
    view.setUint32(4 + 12 * 4, LINES[2]!.length, true);

    const copied = rebuildSword1Speech('SPEECH/COWS.MAD', built.data);
    expect(Array.from(copied.data)).toEqual(Array.from(built.data));

    const wanted = speech(52, 6);
    const rebuilt = rebuildSword1Speech('SPEECH/COWS.MAD', built.data, [
      { room: 1, line: 1, wav: writeWavePcm(wanted, 11025) },
    ]);
    // Replacing either replaces what both play, because there is one payload.
    const index = parseSword1SpeechIndex('SPEECH/COWS.MAD', rebuilt.data)!;
    const first = index.locate(1, 1)!;
    const second = index.locate(1, 2)!;
    expect(second.at).toBe(first.at);
    expect(second.length).toBe(first.length);
    const decoded = expandSpeech(
      rebuilt.data.subarray(second.at, second.at + second.length),
      false,
      'demo',
    );
    expect(Array.from(decoded.subarray(2))).toEqual(Array.from(wanted));
  });

  it('refuses two entries at one offset that disagree about the length', () => {
    const built = container(LINES);
    const view = new DataView(built.data.buffer);
    view.setUint32(4 + 11 * 4, built.at[2]! - built.indexBytes, true);
    // One byte short of the other: a prefix, which one payload cannot be both of.
    view.setUint32(4 + 12 * 4, LINES[2]!.length - 2, true);
    expect(() => rebuildSword1Speech('SPEECH/COWS.MAD', built.data)).toThrow(
      /two different lengths/,
    );
  });

  it('resamples a replacement recorded at another rate', () => {
    const built = container(LINES);
    const wanted = speech(80, 3);
    const rebuilt = rebuildSword1Speech('SPEECH/COWS.MAD', built.data, [
      { room: 1, line: 1, wav: writeWavePcm(wanted, 22050) },
    ]);
    const index = parseSword1SpeechIndex('SPEECH/COWS.MAD', rebuilt.data)!;
    const entry = index.locate(1, 1)!;
    const decoded = expandSpeech(
      rebuilt.data.subarray(entry.at, entry.at + entry.length),
      false,
      'demo',
    );
    // Half the rate is half the samples, plus the two the demo spends on its
    // own stated length.
    expect(decoded.length).toBe(Math.round(wanted.length / 2) + 2);
  });
});

describe('writing one line, in either container’s shape', () => {
  it('puts a retail line’s length in the word after the data tag', () => {
    const wanted = speech(30, 2);
    const line = writeSword1SpeechLine(waveLine(speech(10, 1)), wanted, 'wave', false);
    const view = new DataView(line.buffer, line.byteOffset, line.byteLength);
    expect(view.getUint32(40, true)).toBe(wanted.length * 2);
    expect(Array.from(expandSpeech(line, false, 'wave'))).toEqual(Array.from(wanted));
  });

  it('keeps the line’s own header rather than inventing one', () => {
    // Everything up to the runs is the bytes that were there: the rate, the
    // channel count and anything a release put in its fmt chunk this reader
    // does not know about.
    const original = demoLine(speech(20, 1));
    original[24] = 0x77;
    const line = writeSword1SpeechLine(original, speech(30, 2), 'demo', false);
    expect(Array.from(line.subarray(8, 36))).toEqual(Array.from(original.subarray(8, 36)));
  });

  it('refuses a replacement longer than the reader will read back', () => {
    // `readSpeechRuns` caps a line at ten minutes, because a length read out
    // of a file this has mis-identified sizes an allocation. Writing one
    // longer than that would make a line the game's own reader refuses, so it
    // is refused here where the message can name the file instead.
    const tooLong = writeWavePcm(new Int16Array(11025 * 600), 11025);
    expect(() => sword1SpeechSamples(tooLong, 'screen 1 line 1')).toThrow(/ten minutes/);
    // And the ordinary case still passes through, empty included: a line an
    // author silenced is a line, not a fault.
    expect(
      sword1SpeechSamples(writeWavePcm(new Int16Array(0), 11025), 'screen 1 line 1').length,
    ).toBe(0);
  });
});

describe('which tracks an export treats as replaced speech', () => {
  const base = {
    id: 1,
    name: 'Speech, screen 3 line 4',
    format: 'wav' as const,
    filename: 'x.wav',
  };

  it('is a game’s own line only once it has bytes of its own', () => {
    const resource = { engine: 'sword1', kind: 'speech', number: 4, bank: 3 } as const;
    expect(isSword1SpeechReplacement({ ...base, resource })).toBe(false);
    expect(isSword1SpeechReplacement({ ...base, resource, data: 'AAAA' })).toBe(true);
    expect(isSword1SpeechReplacement({ ...base, resource, storeKey: 'k' })).toBe(true);
  });

  it('is not an effect, a tune, or another family’s line', () => {
    expect(
      isSword1SpeechReplacement({
        ...base,
        data: 'AAAA',
        resource: { engine: 'sword1', kind: 'effects', number: 4 },
      }),
    ).toBe(false);
    expect(
      isSword1SpeechReplacement({
        ...base,
        data: 'AAAA',
        resource: { engine: 'agos', kind: 'speech', number: 4 },
      }),
    ).toBe(false);
    // A speech line with no screen on it cannot be located in the container,
    // so it is not something an export can write.
    expect(
      isSword1SpeechReplacement({
        ...base,
        data: 'AAAA',
        resource: { engine: 'sword1', kind: 'speech', number: 4 },
      }),
    ).toBe(false);
  });
});

describe('sorting an author’s replacements into the three things an export does', () => {
  const base64 = (bytes: Uint8Array): string => {
    let text = '';
    for (const byte of bytes) text += String.fromCharCode(byte);
    return btoa(text);
  };

  const wav = (samples = 8): Uint8Array => {
    const audio = new Int16Array(samples);
    for (let at = 0; at < samples; at++) audio[at] = at * 100;
    return writeWavePcm(audio, 11025);
  };

  /** A track holding bytes of its own, standing in for one of the game's. */
  const replaced = (resource: AudioResource, bytes: Uint8Array): ProjectAudio => ({
    id: resource.number,
    name: `${resource.kind} ${resource.number}`,
    format: 'wav',
    filename: 'x.wav',
    data: base64(bytes),
    resource,
  });

  const projectWith = (tracks: readonly ProjectAudio[]): Project => ({
    ...createProject('fixture'),
    audio: [...tracks],
  });

  /**
   * An index holding exactly the one resource effect 2's sample is.
   *
   * `sword1SampleId(2, false)` is `0x06000012` — cluster byte 6, group 0,
   * index 0x12 — which `clusterOf` reads as the zero-based cluster 5. Written
   * as a literal rather than parsed out of a fixture because what these tests
   * are about is whether a destination is found, not how a RIF is decoded.
   */
  const index: RifIndex = {
    clusters: [
      {
        cluster: 5,
        label: 'PARIS1',
        groups: [
          {
            group: 0,
            declared: 64,
            resources: [{ index: 0x12, offset: 0, length: 4 }],
            presence: [],
          },
        ],
        presence: [],
      },
    ],
    resourceCount: 1,
    presence: [],
  };

  const folder = (files: readonly string[] = ['MUSIC/1M2.WAV']): Sword1GameFolder => ({
    name: 'sword1',
    source: new MemoryDataSource(
      'sword1',
      files.map((name) => [name, new Uint8Array(4)] as [string, Uint8Array]),
    ),
    indexFile: 'swordres.rif',
    index,
    clusterFiles: new Map([['PARIS1', 'CLUSTERS/PARIS1.CLU']]),
    speech: null,
    windowsDemo: false,
  });

  it('sorts a replaced line, tune and effect into three lists', async () => {
    const project = projectWith([
      replaced({ engine: 'sword1', kind: 'speech', number: 1, bank: 0 }, wav()),
      replaced({ engine: 'sword1', kind: 'music', number: 1 }, wav()),
      replaced({ engine: 'sword1', kind: 'effects', number: 2 }, wav()),
    ]);
    const found = await sword1AudioReplacements(project, folder());
    expect(found.speech).toHaveLength(1);
    expect(found.speech[0]?.room).toBe(0);
    expect(found.music).toHaveLength(1);
    expect(found.music[0]).toMatchObject({ tune: 1, file: 'MUSIC/1M2.WAV' });
    expect(found.effects).toHaveLength(1);
    expect(found.effects[0]).toMatchObject({ fx: 2, id: 0x06000012 });
  });

  it('leaves the game’s own recordings where they are', async () => {
    // Every one of the 913 tracks an import makes carries a `resource` and no
    // bytes. Writing them all back would re-encode 808 lines of speech nobody
    // touched, nine of which cannot come back identical.
    const project = projectWith([
      {
        id: 1,
        name: 'speech',
        format: 'wav',
        filename: 'x.wav',
        resource: { engine: 'sword1', kind: 'speech', number: 1, bank: 0 },
      },
      {
        id: 2,
        name: 'music',
        format: 'wav',
        filename: 'x.wav',
        resource: { engine: 'sword1', kind: 'music', number: 1 },
      },
      {
        id: 3,
        name: 'fx',
        format: 'wav',
        filename: 'x.wav',
        resource: { engine: 'sword1', kind: 'effects', number: 2 },
      },
    ]);
    const found = await sword1AudioReplacements(project, folder());
    expect(found).toEqual({ speech: [], music: [], effects: [] });
  });

  it('leaves another family’s replacements to that family', async () => {
    const project = projectWith([
      replaced({ engine: 'sword2', kind: 'speech', number: 1, bank: 0 }, wav()),
      replaced({ engine: 'agos', kind: 'music', number: 1 }, wav()),
    ]);
    const found = await sword1AudioReplacements(project, folder());
    expect(found).toEqual({ speech: [], music: [], effects: [] });
  });

  it('refuses a tune this install holds no file for', async () => {
    const project = projectWith([replaced({ engine: 'sword1', kind: 'music', number: 1 }, wav())]);
    await expect(sword1AudioReplacements(project, folder([]))).rejects.toThrow(
      Sword1AudioExportError,
    );
  });

  it('refuses a tune this install only holds as a re-encoding', async () => {
    // `sword1MusicFileIn` finds `1M2.ogg` on purpose, so a ScummVM-re-encoded
    // install still plays. Writing PCM WAVE under that name would leave a file
    // whose own reader rejects it.
    const project = projectWith([replaced({ engine: 'sword1', kind: 'music', number: 1 }, wav())]);
    await expect(sword1AudioReplacements(project, folder(['MUSIC/1M2.ogg']))).rejects.toThrow(
      /re-encoding/,
    );
  });

  it('refuses an effect the fx table gives no sample', async () => {
    const project = projectWith([
      replaced({ engine: 'sword1', kind: 'effects', number: 100000 }, wav()),
    ]);
    await expect(sword1AudioReplacements(project, folder())).rejects.toThrow(/no sample/);
  });

  it('refuses an effect swordres.rif names no resource for', async () => {
    // Effect 0 is in a cluster this fixture index does not hold, which is the
    // ordinary state of the demo: it ships eight of the game's clusters.
    const project = projectWith([
      replaced({ engine: 'sword1', kind: 'effects', number: 0 }, wav()),
    ]);
    await expect(sword1AudioReplacements(project, folder())).rejects.toThrow(/no resource/);
  });

  it('refuses bytes Broken Sword’s own reader will not play', async () => {
    const project = projectWith([
      replaced(
        { engine: 'sword1', kind: 'music', number: 1 },
        new TextEncoder().encode('OggS....'),
      ),
    ]);
    await expect(sword1AudioReplacements(project, folder())).rejects.toThrow(
      /own reader will play/,
    );
  });

  it('is a replacement only once a track of that kind has bytes', () => {
    const track = replaced({ engine: 'sword1', kind: 'music', number: 1 }, wav());
    expect(isSword1Replacement(track, 'music')).toBe(true);
    expect(isSword1Replacement(track, 'effects')).toBe(false);
    expect(isSword1Replacement({ ...track, data: undefined }, 'music')).toBe(false);
  });
});
