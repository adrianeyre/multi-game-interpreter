/**
 * A numbered-disc SCI32 install: every disc's map read, and a replaced
 * recording written into its own disc (#227, row 27).
 *
 * Tier 1 over `buildSci32TwoDiscFixture`, which lays two discs out the way
 * ScummVM's `addAppropriateSources` and `readResourceMapSCI1` read them under
 * `_multiDiscAudio`. The checks: resources from both discs are reachable, the
 * same audio map number on two discs is two tables, an unedited export packs
 * back as the same two discs with every audio Volume byte for byte, and a
 * replacement rebuilds one disc's `RESAUD.00n` and audio maps and leaves the
 * other disc's alone.
 */

import { describe, expect, it } from 'vitest';

import { listSciAudio, readSciAudioEntries } from '../src/authoring/sci/audioList.js';
import { packSciGame, sciPackDiscs } from '../src/authoring/sci/packSciGame.js';
import { sciSampleLength, type SciAudioReplacement } from '../src/authoring/sci/sciAudioVolume.js';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import type { SciResources } from '../src/engine/sci/resource/SciResources.js';
import { detectSciGame } from '../src/engine/sci/resource/detectSciGame.js';
import { SCI_RESOURCE_TYPES } from '../src/engine/sci/resource/sciResourceTypes.js';
import {
  findSciDiscRecording,
  readSciAudioHeader,
  readSciAudioMap,
} from '../src/engine/sci/sound/sciAudio.js';
import { readSciAudio36Index } from '../src/engine/sci/sound/sciAudioPlayer.js';
import { writeWavePcm } from '../src/engine/sound/wave.js';
import { buildSci32TwoDiscFixture } from './fixtureSci.js';

const REPLACEMENT = writeWavePcm(Int16Array.from([256, -256, 12800, -12800, 0, 512]), 16000);

async function open(files: Map<string, Uint8Array>): Promise<SciResources> {
  const { resources } = await detectSciGame(new MemoryDataSource('discs', files), {
    onLog: () => undefined,
  });
  return resources;
}

/** The whole-game table as a Project holds it: one copy per type and number. */
async function projectResources(resources: SciResources): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  for (const type of SCI_RESOURCE_TYPES) {
    for (const number of resources.list(type)) {
      const bytes = await resources.read(type, number);
      if (bytes) out.set(`${type}:${number}`, bytes);
    }
  }
  return out;
}

function sampleOf(volume: Uint8Array, offset: number): Uint8Array {
  const head = volume.subarray(offset, offset + 64);
  const header = readSciAudioHeader(head)!;
  return volume.subarray(offset, offset + sciSampleLength(header, head));
}

function replacing(number: number, file: string): SciAudioReplacement {
  return { number, file, wave: REPLACEMENT, name: `Audio ${number}` };
}

async function pack(audio: SciAudioReplacement[] = []) {
  const fixture = buildSci32TwoDiscFixture();
  const resources = await open(fixture.files);
  const result = packSciGame(await projectResources(resources), {
    mapVersion: resources.mapVersion,
    layout: resources.layout,
    discs: await sciPackDiscs(resources),
    carried: [
      { name: 'RESAUD.001', data: fixture.files.get('RESAUD.001')! },
      { name: 'RESAUD.002', data: fixture.files.get('RESAUD.002')! },
    ],
    audio,
  });
  const files = new Map(result.files.map((file) => [file.name, file.data]));
  return { fixture, result, files };
}

describe('a numbered-disc SCI32 install, read', () => {
  it('reads every disc’s map, and a later disc’s entry is the one served', async () => {
    const resources = await open(buildSci32TwoDiscFixture().files);
    expect(resources.layout.discs.map((disc) => disc.number)).toEqual([1, 2]);
    expect(resources.layout.multiDiscAudio).toBe(true);
    expect(resources.discs).toEqual([1, 2]);

    // Disc 2 alone holds view 9; before, only the first map was read.
    expect(resources.has('view', 9)).toBe(true);
    expect(await resources.read('view', 9)).not.toBeNull();
    // Both discs hold text 5, and ScummVM's `updateResource` keeps the later.
    expect([...(await resources.read('text', 5))!]).toEqual([0x42, 0x00]);
    expect([...(await resources.readOnDisc('text', 5, 1))!]).toEqual([0x41, 0x00]);
    expect(resources.discOf('text', 5)).toBe(2);
  });

  it('keeps each disc’s audio maps as its own tables', async () => {
    const fixture = buildSci32TwoDiscFixture();
    const resources = await open(fixture.files);
    for (const disc of fixture.discs) {
      const base = readSciAudioMap((await resources.readOnDisc('map', 65535, disc.number))!, {
        sci32: true,
      });
      expect(base.map((entry) => [entry.number, entry.offset])).toEqual([...disc.base]);
    }
  });

  it('lists every disc’s recordings, the lowest disc winning a number two share', async () => {
    const resources = await open(buildSci32TwoDiscFixture().files);
    const { entries } = await readSciAudioEntries(resources);
    const rows = listSciAudio({ entries });
    expect(rows.map((row) => [row.resource!.number, row.resource!.file])).toEqual([
      [1, 'RESAUD.001'],
      [2, 'RESAUD.001'],
      [3, 'RESAUD.002'],
    ]);
    expect(await findSciDiscRecording(resources, 3)).toMatchObject({ disc: 2, file: 'RESAUD.002' });
    expect(await findSciDiscRecording(resources, 2)).toMatchObject({ disc: 1 });
  });
});

describe('an unedited numbered-disc export', () => {
  it('packs back as the same two discs, every audio Volume byte for byte', async () => {
    const { fixture, result, files } = await pack();
    expect(result.refused).toEqual([]);
    expect(result.discFiles).toEqual(['RESMAP.001', 'RESSCI.001', 'RESMAP.002', 'RESSCI.002']);
    expect(files.get('RESAUD.001')).toBe(fixture.files.get('RESAUD.001'));
    expect(files.get('RESAUD.002')).toBe(fixture.files.get('RESAUD.002'));
    expect(result.rebuiltVolumes).toEqual([]);

    // Every disc reads back holding what it held, audio maps included.
    const reread = await open(files);
    for (const disc of fixture.discs) {
      for (const spec of disc.resources) {
        const bytes = await reread.readOnDisc(spec.type, spec.number, disc.number);
        expect([...bytes!], `${spec.type} ${spec.number} on disc ${disc.number}`).toEqual(
          spec.body,
        );
      }
    }
  });
});

describe('an edited resource two discs share', () => {
  it('lands on the disc whose copy is read, and the shadowed copy stays as it was', async () => {
    const fixture = buildSci32TwoDiscFixture();
    const resources = await open(fixture.files);
    const project = await projectResources(resources);
    project.set('text:5', new Uint8Array([0x43, 0x00]));
    const result = packSciGame(project, {
      mapVersion: resources.mapVersion,
      layout: resources.layout,
      discs: await sciPackDiscs(resources),
    });
    expect(result.refused).toEqual([]);
    const reread = await open(new Map(result.files.map((file) => [file.name, file.data])));
    expect([...(await reread.read('text', 5))!]).toEqual([0x43, 0x00]);
    expect([...(await reread.readOnDisc('text', 5, 1))!]).toEqual([0x41, 0x00]);
  });
});

describe('a replaced recording on a numbered-disc install', () => {
  it('rebuilds that disc’s RESAUD and audio maps and leaves the other disc alone', async () => {
    const { fixture, result, files } = await pack([replacing(3, 'RESAUD.002')]);
    expect(result.refused).toEqual([]);
    expect(result.rebuiltVolumes).toEqual(['RESAUD.002']);
    expect(files.get('RESAUD.001')).toBe(fixture.files.get('RESAUD.001'));

    const reread = await open(files);
    const [one, two] = fixture.discs;
    for (const spec of one.resources.filter((each) => each.type === 'map')) {
      expect([...(await reread.readOnDisc('map', spec.number, 1))!]).toEqual(spec.body);
    }

    const aud = files.get('RESAUD.002')!;
    const base = readSciAudioMap((await reread.readOnDisc('map', 65535, 2))!, { sci32: true });
    const at = new Map(base.map((entry) => [entry.number, entry.offset]));
    expect(readSciAudioHeader(sampleOf(aud, at.get(3)!))!.sampleRate).toBe(16000);
    expect(sampleOf(aud, at.get(2)!)).toEqual(sampleOf(two.aud, two.base.get(2)!));

    // Disc 2's room line is where its rewritten map says, sync data first.
    const room = readSciAudio36Index((await reread.readOnDisc('map', 300, 2))!, true);
    expect(room).toHaveLength(1);
    const line = two.speech[0];
    expect([
      ...aud.subarray(room[0].sync!.offset, room[0].sync!.offset + line.sync.length),
    ]).toEqual(line.sync);
    expect(sampleOf(aud, room[0].offset)).toEqual(
      sampleOf(two.aud, line.offset + line.sync.length),
    );

    // And the interpreter's lookup now finds the author's sample.
    const found = await findSciDiscRecording(reread, 3);
    expect(found?.file).toBe('RESAUD.002');
  });

  it('writes a number two discs share into the disc it is played from', async () => {
    const { fixture, result, files } = await pack([replacing(2, 'RESAUD.001')]);
    expect(result.refused).toEqual([]);
    expect(result.rebuiltVolumes).toEqual(['RESAUD.001']);
    expect(files.get('RESAUD.002')).toBe(fixture.files.get('RESAUD.002'));
    expect(result.replacedAudio[0]).toContain('disc 1');
  });

  it('refuses, by name, a recording no disc lists', async () => {
    const { result } = await pack([replacing(99, 'RESAUD.001')]);
    expect(result.files).toEqual([]);
    expect(result.refused[0]).toContain('no disc');
    expect(result.refused[0]).toContain('99');
  });
});
