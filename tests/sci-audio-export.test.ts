// @vitest-environment jsdom
/**
 * Replacing a SCI recording is carried by the export (#227, row 27).
 *
 * Tier 1 over `fixtureSci.ts`: the Volume and the maps are written by this test
 * from the format as this project and ScummVM's `readAudioMapSCI11` read it,
 * and the check is that a packed install reads back — through the same reader
 * the Audio rows play from — with the author's samples where the original ones
 * were and every other byte where it was.
 */

import { describe, expect, it } from 'vitest';

import { packSciGame } from '../src/authoring/sci/packSciGame.js';
import {
  encodeSciAudioSample,
  rebuildSciAudio,
  type SciAudioReplacement,
} from '../src/authoring/sci/sciAudioVolume.js';
import { createProject, type Project } from '../src/authoring/project.js';
import { importSciGame } from '../src/authoring/sci/importSciGame.js';
import { exportSciGame } from '../src/authoring/sci/exportSciGame.js';
import { sciAudioReader } from '../src/editor/sci/audioResources.js';
import { readSciGameFolder } from '../src/editor/sci/resupply.js';
import { detectSciGame } from '../src/engine/sci/resource/detectSciGame.js';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { readSciAudioHeader, readSciAudioMap } from '../src/engine/sci/sound/sciAudio.js';
import { readWavePcm, writeWavePcm } from '../src/engine/sound/wave.js';
import { buildSci11Fixture, u16le, u32le, type SciResourceSpec } from './fixtureSci.js';

function solSample(body: number[], { sixteen = false, rate = 11025, size = 11 } = {}): number[] {
  return [
    0x8d,
    size,
    0x53,
    0x4f,
    0x4c,
    0x00,
    ...u16le(rate),
    sixteen ? 0x04 : 0x00,
    ...u32le(body.length),
    ...(size === 12 ? [0] : []),
    ...body,
  ];
}

/** The six-byte base map, terminated the way ScummVM's heuristic reads it. */
function baseMap(entries: Array<[number, number]>, terminator = 6): number[] {
  const bytes: number[] = [];
  for (const [number, offset] of entries) bytes.push(...u16le(number), ...u32le(offset));
  for (let i = 0; i < terminator; i++) bytes.push(0xff);
  return bytes;
}

const RIFF_SAMPLE = writeWavePcm(Int16Array.from([0, 1000, -1000, 32767]), 22050);
/** What the author drops in. */
const REPLACEMENT = writeWavePcm(Int16Array.from([256, -256, 12800, -12800, 0]), 16000);

function talkie({ roomMap = false } = {}): {
  resources: SciResourceSpec[];
  aud: Uint8Array;
  offsets: Map<number, number>;
} {
  const aud: number[] = [];
  const offsets = new Map<number, number>();
  offsets.set(1, aud.length);
  aud.push(...solSample([0x80, 0x00, 0xff, 0x40]));
  offsets.set(2, aud.length);
  aud.push(...RIFF_SAMPLE);
  offsets.set(3, aud.length);
  aud.push(...solSample([0x10, 0x00, 0x20, 0x00], { sixteen: true, size: 12 }));

  const resources: SciResourceSpec[] = [
    ...buildSci11Fixture().resources,
    { type: 'map', number: 65535, body: baseMap([...offsets]) },
    { type: 'audio', number: 7, body: solSample([0x00, 0xff]) },
    ...(roomMap
      ? [{ type: 'map' as const, number: 200, body: [0xc8, 0x00, 0x00, 0x00, 0x00, 0xff] }]
      : []),
  ];
  return { resources, aud: new Uint8Array(aud), offsets };
}

function resourceMapOf(specs: readonly SciResourceSpec[]): Map<string, Uint8Array> {
  return new Map(specs.map((spec) => [`${spec.type}:${spec.number}`, new Uint8Array(spec.body)]));
}

function replacing(number: number, file?: string, wave = REPLACEMENT): SciAudioReplacement {
  return { number, ...(file ? { file } : {}), wave, name: `Audio ${number}` };
}

async function projectOf(files: Map<string, Uint8Array>): Promise<Project> {
  const { game, resources } = await detectSciGame(new MemoryDataSource('t', files), {
    onLog: () => undefined,
  });
  return {
    ...createProject(game.id),
    target: {
      engine: 'sci',
      version: game.version,
      platform: game.platform,
      identification: game.identification,
    },
    sci: await importSciGame(game, resources),
  };
}

/** Packs, then opens the packed install the way the editor opens a folder. */
async function packedReader(
  specs: SciResourceSpec[],
  aud: Uint8Array,
  audio: SciAudioReplacement[],
): Promise<{
  read: ReturnType<typeof sciAudioReader>;
  packed: ReturnType<typeof packSciGame>;
}> {
  const original = buildSci11Fixture(specs);
  const project = await projectOf(original.files);
  const built = exportSciGame(project.sci!);
  const packed = packSciGame(built.resources, {
    mapVersion: 'sci11',
    carried: [{ name: 'RESOURCE.AUD', data: aud }],
    audio,
  });
  expect(packed.refused).toEqual([]);

  const files = packed.files.map((file) => new File([new Uint8Array(file.data)], file.name));
  const folder = await readSciGameFolder('packed', files, project);
  if (typeof folder === 'string') throw new Error(folder);
  return { read: sciAudioReader(folder), packed };
}

function pcmOf(wave: Uint8Array | null): number[] {
  const pcm = readWavePcm(wave!);
  return [...pcm!.samples];
}

describe('an unedited export', () => {
  it('carries the audio Volume and the base map exactly as they arrived', () => {
    const { resources, aud } = talkie();
    const map = resourceMapOf(resources);
    const packed = packSciGame(map, {
      mapVersion: 'sci11',
      carried: [{ name: 'RESOURCE.AUD', data: aud }],
    });
    expect(packed.rebuiltVolumes).toEqual([]);
    expect(packed.carried).toEqual(['RESOURCE.AUD']);
    expect(packed.files.find((file) => file.name === 'RESOURCE.AUD')!.data).toBe(aud);

    const rebuilt = rebuildSciAudio(map, [{ name: 'RESOURCE.AUD', data: aud }], [], {
      sci32: false,
    });
    expect(rebuilt.resources.get('map:65535')).toBe(map.get('map:65535'));
  });
});

describe('a replaced recording in RESOURCE.AUD', () => {
  it('is rebuilt into the Volume, with the untouched samples copied byte for byte', async () => {
    const { resources, aud, offsets } = talkie();
    const { read, packed } = await packedReader(resources, aud, [replacing(1, 'RESOURCE.AUD')]);
    expect(packed.rebuiltVolumes).toEqual(['RESOURCE.AUD']);
    expect(packed.carried).toEqual([]);

    // The author's samples come back, at the width the original shipped — 8-bit
    // unsigned, so each sample keeps its top byte.
    const one = await read({ engine: 'sci', kind: 'speech', number: 1, file: 'RESOURCE.AUD' });
    expect(pcmOf(one)).toEqual([256, -256, 12800, -12800, 0]);
    expect(new DataView(one!.buffer, one!.byteOffset).getUint32(24, true)).toBe(16000);

    // The two nobody touched are the same bytes at a different place.
    const rebuiltAud = packed.files.find((file) => file.name === 'RESOURCE.AUD')!.data;
    const { resources: packedResources } = await detectSciGame(
      new MemoryDataSource('p', new Map(packed.files.map((file) => [file.name, file.data]))),
      { onLog: () => undefined },
    );
    const map = readSciAudioMap((await packedResources.read('map', 65535))!);
    const at = new Map(map.map((entry) => [entry.number, entry.offset]));
    expect(rebuiltAud.subarray(at.get(2)!, at.get(2)! + RIFF_SAMPLE.length)).toEqual(RIFF_SAMPLE);
    const third = aud.subarray(offsets.get(3)!);
    expect(rebuiltAud.subarray(at.get(3)!, at.get(3)! + third.length)).toEqual(third);
    expect(await read({ engine: 'sci', kind: 'speech', number: 2, file: 'RESOURCE.AUD' })).toEqual(
      RIFF_SAMPLE,
    );
  });

  it('keeps the container the original used: a RIFF stays a RIFF', async () => {
    const { resources, aud } = talkie();
    const { read } = await packedReader(resources, aud, [replacing(2, 'RESOURCE.AUD')]);
    const two = await read({ engine: 'sci', kind: 'speech', number: 2, file: 'RESOURCE.AUD' });
    expect(String.fromCharCode(...two!.subarray(0, 4))).toBe('RIFF');
    expect(pcmOf(two)).toEqual([256, -256, 12800, -12800, 0]);
  });

  it('is appended, and nothing else moved, when per-room speech maps share the Volume', async () => {
    const { resources, aud } = talkie({ roomMap: true });
    const { read, packed } = await packedReader(resources, aud, [replacing(3, 'RESOURCE.AUD')]);
    const rebuiltAud = packed.files.find((file) => file.name === 'RESOURCE.AUD')!.data;
    // Every byte a room's map could name is where it was.
    expect(rebuiltAud.subarray(0, aud.length)).toEqual(aud);
    expect(packed.replacedAudio[0]).toContain(`appended to RESOURCE.AUD at offset ${aud.length}`);

    // Sixteen-bit, because the original was: the samples survive exactly.
    const three = await read({ engine: 'sci', kind: 'speech', number: 3, file: 'RESOURCE.AUD' });
    expect(pcmOf(three)).toEqual([256, -256, 12800, -12800, 0]);
    expect(readSciAudioHeader(rebuiltAud.subarray(aud.length))!.sixteenBit).toBe(true);
  });
});

describe('a replaced audio resource in the resource map', () => {
  it('is substituted in the resource Volume the packer writes', async () => {
    const { resources, aud } = talkie();
    const { read, packed } = await packedReader(resources, aud, [replacing(7)]);
    expect(packed.rebuiltVolumes).toEqual([]);
    expect(packed.carried).toEqual(['RESOURCE.AUD']);
    expect(pcmOf(await read({ engine: 'sci', kind: 'speech', number: 7 }))).toEqual([
      256, -256, 12800, -12800, 0,
    ]);
  });
});

describe('what the audio writer refuses, by name', () => {
  const carried = (aud: Uint8Array) => [{ name: 'RESOURCE.AUD', data: aud }];

  it('a replacement that is not a PCM WAVE', () => {
    const { resources, aud } = talkie();
    const packed = packSciGame(resourceMapOf(resources), {
      mapVersion: 'sci11',
      carried: carried(aud),
      audio: [replacing(1, 'RESOURCE.AUD', new Uint8Array([0x49, 0x44, 0x33, 0, 0, 0]))],
    });
    expect(packed.files).toEqual([]);
    expect(packed.refused[0]).toContain('not a PCM WAVE');
  });

  it('a step a five-byte cumulative base map cannot hold', () => {
    // ScummVM reads a SCI1.1 base map that does not end in six 0xff bytes as
    // five bytes an entry with a cumulative step, and so does the writer now.
    // Appending past a Volume more than 16MB long needs a step the field
    // cannot hold, which is refused by name rather than wrapped.
    const sample = solSample([0x80, 0x00]);
    const aud = new Uint8Array(0x1000010);
    aud.set(sample, 0);
    const cumulative = [...u16le(1), 0, 0, 0, 0xff, 0xff];
    const map = new Map<string, Uint8Array>([
      ['map:65535', new Uint8Array(cumulative)],
      ['map:200', new Uint8Array([0xc8, 0x00, 0x00, 0x00, 0x00, 0xff])],
    ]);
    const appended = rebuildSciAudio(map, carried(aud), [replacing(1, 'RESOURCE.AUD')], {
      sci32: false,
    });
    expect(appended.refused[0]).toContain('24 bits');
    expect(appended.rebuiltVolumes).toEqual([]);
  });

  it('reads a five-byte cumulative base map and rebuilds its Volume', () => {
    const { resources, aud, offsets } = talkie();
    const map = resourceMapOf(resources);
    const cumulative: number[] = [];
    let previous = 0;
    for (const [number, offset] of offsets) {
      cumulative.push(...u16le(number), offset - previous, 0, 0);
      previous = offset;
    }
    map.set('map:65535', new Uint8Array([...cumulative, 0xff, 0xff]));
    const rebuilt = rebuildSciAudio(map, carried(aud), [replacing(1, 'RESOURCE.AUD')], {
      sci32: false,
    });
    expect(rebuilt.refused).toEqual([]);
    const read = readSciAudioMap(rebuilt.resources.get('map:65535')!, { sci32: true });
    const volume = rebuilt.carried[0].data;
    const two = read.find((entry) => entry.number === 2)!.offset;
    expect(volume.subarray(two, two + RIFF_SAMPLE.length)).toEqual(RIFF_SAMPLE);
  });

  it('a number the base map does not list, and a folder with no audio Volume', () => {
    const { resources, aud } = talkie();
    const missing = rebuildSciAudio(
      resourceMapOf(resources),
      carried(aud),
      [replacing(99, 'RESOURCE.AUD')],
      { sci32: false },
    );
    expect(missing.refused[0]).toContain('lists no recording 99');

    const none = rebuildSciAudio(resourceMapOf(resources), [], [replacing(1, 'RESOURCE.AUD')], {
      sci32: false,
    });
    expect(none.refused[0]).toContain('neither RESOURCE.SFX nor RESOURCE.AUD');
  });

  it('a rate a SOL header cannot hold', () => {
    const original = new Uint8Array(solSample([0x80]));
    const fast = writeWavePcm(Int16Array.from([0]), 96000);
    expect(encodeSciAudioSample(fast, original, 'Audio 1')).toContain('sixteen bits');
  });
});
