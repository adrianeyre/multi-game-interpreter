/**
 * Replacing a recording in a SCI32 install (#227, row 27).
 *
 * Tier 1 over `fixtureSci.ts`. The maps are written here the way ScummVM's
 * `readAudioMapSCI11` reads them for SCI2 and later — the base map five bytes
 * an entry with a cumulative 24-bit step, and a per-room map in the "late"
 * form ScummVM fixes the width of for every SCI32 game: a 32-bit base, then a
 * big-endian tuple, a 24-bit step and, when the tuple's low byte carries
 * `0x80`, a 16-bit sync size. The check is that a packed install reads back
 * through the same readers the Audio rows and the interpreter use, with the
 * author's sample where the original was and every other recording — sync
 * data included — byte for byte where the rewritten maps now say it is.
 */

import { describe, expect, it } from 'vitest';

import { packSciGame } from '../src/authoring/sci/packSciGame.js';
import { rebuildSciAudio, type SciAudioReplacement } from '../src/authoring/sci/sciAudioVolume.js';
import { readSciAudioEntries } from '../src/authoring/sci/audioList.js';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { detectSciGame } from '../src/engine/sci/resource/detectSciGame.js';
import { readSciAudioHeader, readSciAudioMap } from '../src/engine/sci/sound/sciAudio.js';
import { readSciAudio36Index } from '../src/engine/sci/sound/sciAudioPlayer.js';
import { readWavePcm, writeWavePcm } from '../src/engine/sound/wave.js';
import { sciSampleLength } from '../src/authoring/sci/sciAudioVolume.js';
import { buildSci32Fixture, u16le, u32le, type SciResourceSpec } from './fixtureSci.js';

function solSample(body: number[], rate = 11025): number[] {
  return [0x8d, 11, 0x53, 0x4f, 0x4c, 0x00, ...u16le(rate), 0x00, ...u32le(body.length), ...body];
}

function u24le(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff];
}

/** SCI32's base map: number and cumulative step, closed by `ffff`. */
function cumulativeBaseMap(entries: Array<[number, number]>): number[] {
  const bytes: number[] = [];
  let previous = 0;
  for (const [number, offset] of entries) {
    bytes.push(...u16le(number), ...u24le(offset - previous));
    previous = offset;
  }
  return [...bytes, 0xff, 0xff];
}

/** A late-form speech map: base, then tuple, step and (flagged) sync size. */
function roomMap(entries: Array<{ tuple: number[]; offset: number; sync: number }>): number[] {
  const base = entries[0]?.offset ?? 0;
  const bytes: number[] = [...u32le(base)];
  let previous = base;
  for (const entry of entries) {
    const flags = entry.sync > 0 ? 0x80 : 0;
    bytes.push(entry.tuple[0], entry.tuple[1], entry.tuple[2], entry.tuple[3] | flags);
    bytes.push(...u24le(entry.offset - previous));
    if (flags) bytes.push(...u16le(entry.sync));
    previous = entry.offset;
  }
  return [...bytes, 0xff, 0xff, 0xff, 0xff];
}

const REPLACEMENT = writeWavePcm(Int16Array.from([256, -256, 12800, -12800, 0, 512, -512]), 16000);

interface Talkie {
  resources: SciResourceSpec[];
  aud: Uint8Array;
  /** Base-map number to offset. */
  base: Map<number, number>;
  /** The per-room entries, with the sync bytes they carry. */
  speech: Array<{ tuple: number[]; offset: number; sync: number[] }>;
}

function talkie({ rooms = true } = {}): Talkie {
  const aud: number[] = [];
  const base = new Map<number, number>();
  const speech: Talkie['speech'] = [];

  base.set(1, aud.length);
  aud.push(...solSample([0x80, 0x81]));
  // A room line with sync data in front of its sample, then one without.
  const sync = [0x0a, 0x00, 0x05, 0x00, 0xff, 0xff];
  speech.push({ tuple: [3, 1, 0, 1], offset: aud.length, sync });
  aud.push(...sync, ...solSample([0x10, 0x20, 0x30]));
  base.set(2, aud.length);
  aud.push(...solSample([0x40, 0x41, 0x42, 0x43]));
  // Bytes nothing names, which a compacting rebuild is right to drop.
  aud.push(0xde, 0xad, 0xbe, 0xef);
  speech.push({ tuple: [3, 2, 0, 1], offset: aud.length, sync: [] });
  aud.push(...solSample([0x55]));

  const resources: SciResourceSpec[] = [
    ...buildSci32Fixture().resources,
    { type: 'map', number: 65535, body: cumulativeBaseMap([...base]) },
    ...(rooms
      ? [
          {
            type: 'map' as const,
            number: 300,
            body: roomMap(speech.map((entry) => ({ ...entry, sync: entry.sync.length }))),
          },
        ]
      : []),
  ];
  return { resources, aud: new Uint8Array(aud), base, speech };
}

function resourceMapOf(specs: readonly SciResourceSpec[]): Map<string, Uint8Array> {
  return new Map(specs.map((spec) => [`${spec.type}:${spec.number}`, new Uint8Array(spec.body)]));
}

function replacing(number: number): SciAudioReplacement {
  return { number, file: 'RESOURCE.AUD', wave: REPLACEMENT, name: `Audio ${number}` };
}

function sampleOf(volume: Uint8Array, offset: number): Uint8Array {
  const head = volume.subarray(offset, offset + 64);
  const header = readSciAudioHeader(head)!;
  return volume.subarray(offset, offset + sciSampleLength(header, head));
}

/** Packs, then opens the result through the engine's own reader. */
async function packed(talk: Talkie, audio: SciAudioReplacement[]) {
  const result = packSciGame(resourceMapOf(talk.resources), {
    mapVersion: 'sci2',
    carried: [{ name: 'RESOURCE.AUD', data: talk.aud }],
    audio,
  });
  expect(result.refused).toEqual([]);
  const files = new Map(result.files.map((file) => [file.name, file.data]));
  const { resources } = await detectSciGame(new MemoryDataSource('p', files), {
    onLog: () => undefined,
  });
  return { result, resources, aud: files.get('RESOURCE.AUD')! };
}

describe('the SCI32 base map', () => {
  it('is read as five bytes an entry with a cumulative step, and listed so', async () => {
    const talk = talkie();
    const map = new Uint8Array(cumulativeBaseMap([...talk.base]));
    expect(readSciAudioMap(map, { sci32: true })).toEqual(
      [...talk.base].map(([number, offset]) => ({ number, offset, volume: 'aud' })),
    );

    const listed = await readSciAudioEntries({
      read: async (type, number) => (type === 'map' && number === 65535 ? map : null),
      list: (type) => (type === 'map' ? [65535] : []),
      isSci32: true,
    });
    expect(listed.entries.map((entry) => entry.number)).toEqual([1, 2]);
  });
});

describe('an unedited SCI32 export', () => {
  it('carries RESOURCE.AUD and every map exactly as they arrived', async () => {
    const talk = talkie();
    const map = resourceMapOf(talk.resources);
    const result = packSciGame(map, {
      mapVersion: 'sci2',
      carried: [{ name: 'RESOURCE.AUD', data: talk.aud }],
    });
    expect(result.rebuiltVolumes).toEqual([]);
    expect(result.files.find((file) => file.name === 'RESOURCE.AUD')!.data).toBe(talk.aud);
    const rebuilt = rebuildSciAudio(map, [{ name: 'RESOURCE.AUD', data: talk.aud }], [], {
      sci32: true,
    });
    expect(rebuilt.resources.get('map:65535')).toBe(map.get('map:65535'));
    expect(rebuilt.resources.get('map:300')).toBe(map.get('map:300'));
  });
});

describe('a replaced recording in a SCI32 RESOURCE.AUD', () => {
  it('is written, and the speech maps sharing the Volume are rewritten around it', async () => {
    const talk = talkie();
    const { result, resources, aud } = await packed(talk, [replacing(1)]);
    expect(result.rebuiltVolumes).toEqual(['RESOURCE.AUD']);
    expect(result.replacedAudio[0]).toContain('per-room speech map');

    // The base map reads back, cumulative, with the author's samples at 1.
    const base = readSciAudioMap((await resources.read('map', 65535))!, { sci32: true });
    const at = new Map(base.map((entry) => [entry.number, entry.offset]));
    const one = sampleOf(aud, at.get(1)!);
    expect(String.fromCharCode(...one.subarray(2, 5))).toBe('SOL');
    expect(readSciAudioHeader(one)!.sampleRate).toBe(16000);
    expect(readWavePcm(REPLACEMENT)!.samples.length).toBe(readSciAudioHeader(one)!.length);
    expect(sampleOf(aud, at.get(2)!)).toEqual(sampleOf(talk.aud, talk.base.get(2)!));

    // Every room line is where the rewritten map says, sync data and sample.
    const room = readSciAudio36Index((await resources.read('map', 300))!, true);
    expect(room).toHaveLength(2);
    for (const [index, entry] of room.entries()) {
      const original = talk.speech[index];
      const syncLength = original.sync.length;
      expect(entry.noun).toBe(original.tuple[0]);
      expect(entry.verb).toBe(original.tuple[1]);
      if (syncLength > 0) {
        expect([...aud.subarray(entry.sync!.offset, entry.sync!.offset + syncLength)]).toEqual(
          original.sync,
        );
      }
      expect(sampleOf(aud, entry.offset)).toEqual(sampleOf(talk.aud, original.offset + syncLength));
    }

    // The bytes nothing named are gone, and nothing else was.
    expect([...aud].join(',')).not.toContain([0xde, 0xad, 0xbe, 0xef].join(','));
  });

  it('is rebuilt with the base map alone when no speech map shares the Volume', async () => {
    const talk = talkie({ rooms: false });
    const { resources, aud } = await packed(talk, [replacing(2)]);
    const base = readSciAudioMap((await resources.read('map', 65535))!, { sci32: true });
    const at = new Map(base.map((entry) => [entry.number, entry.offset]));
    expect(sampleOf(aud, at.get(1)!)).toEqual(sampleOf(talk.aud, talk.base.get(1)!));
    expect(readSciAudioHeader(sampleOf(aud, at.get(2)!))!.sampleRate).toBe(16000);
  });

  it('keeps a speech line that lies before the replacement at its own offset', () => {
    const talk = talkie();
    const map = resourceMapOf(talk.resources);
    // Number 2 is after the first room line, so replacing it moves nothing
    // before it.
    const rebuilt = rebuildSciAudio(
      map,
      [{ name: 'RESOURCE.AUD', data: talk.aud }],
      [replacing(2)],
      { sci32: true },
    );
    expect(rebuilt.refused).toEqual([]);
    const room = readSciAudio36Index(rebuilt.resources.get('map:300')!, true);
    // The first line did not move; the second did, because the dead bytes and
    // the new sample's size are between it and the start.
    expect(room[0].sync!.offset).toBe(talk.speech[0].offset);
  });
});

describe('what the SCI32 audio writer refuses, by name', () => {
  it('a speech map that stops in the middle of an entry', () => {
    const talk = talkie();
    const map = resourceMapOf(talk.resources);
    map.set('map:300', new Uint8Array([0, 0, 0, 0, 3, 1, 0, 0x81, 0, 0]));
    const rebuilt = rebuildSciAudio(
      map,
      [{ name: 'RESOURCE.AUD', data: talk.aud }],
      [replacing(1)],
      { sci32: true },
    );
    expect(rebuilt.refused[0]).toContain('map 300');
    expect(rebuilt.rebuiltVolumes).toEqual([]);
  });
});
