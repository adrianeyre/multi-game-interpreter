// @vitest-environment jsdom
/**
 * SCI's Audio surface: what a release holds, and what a row plays.
 *
 * Tier 1 over `fixtureSci.ts`, and the tier matters here more than usual. The
 * samples below are written by this test from the format as this project reads
 * it — `readSciAudioHeader`'s own account of SOL, and a WAVE written by the
 * same `waveOf` the reader uses — so what is checked is that the listing, the
 * addressing and the decode agree with each other and with that reading. No
 * SCI game data is mounted on the machine this was written on, and none is
 * committed from anywhere.
 *
 * What the fixture cannot check is whether a retail talkie's base map means
 * what the reader takes it to mean. The reader has other evidence for that —
 * `sciAudio.ts` records Freddy Pharkas's demo and Space Quest 6 — and this is
 * not it.
 */

import { describe, expect, it } from 'vitest';

import {
  describeSciAudio36,
  listSciAudio,
  readSciAudioEntries,
  type SciAudioEntryInfo,
} from '../src/authoring/sci/audioList.js';
import { sciAudioReader } from '../src/editor/sci/audioResources.js';
import { readSciGameFolder } from '../src/editor/sci/resupply.js';
import { writeWavePcm } from '../src/engine/sound/wave.js';
import { createProject, type Project } from '../src/authoring/project.js';
import { importSciGame } from '../src/authoring/sci/importSciGame.js';
import { detectSciGame } from '../src/engine/sci/resource/detectSciGame.js';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { buildSci11Fixture, u16le, u32le, type SciFixture } from './fixtureSci.js';

/** A SOL sample: the marker, the size byte, the tag, then the body. */
function solSample(body: number[], { compressed = false, rate = 11025 } = {}): number[] {
  return [
    0x8d,
    11, // the header the size byte measures: bytes 2 through 12
    0x53,
    0x4f,
    0x4c,
    0x00,
    ...u16le(rate),
    compressed ? 0x01 : 0x00,
    ...u32le(body.length),
    ...body,
  ];
}

/** Six bytes an entry: a resource number and a 32-bit offset. */
function baseMap(entries: Array<[number, number]>): number[] {
  const bytes: number[] = [];
  for (const [number, offset] of entries) bytes.push(...u16le(number), ...u32le(offset));
  return bytes;
}

function filesOf(fixture: SciFixture, extra: Record<string, Uint8Array> = {}): File[] {
  const all = new Map<string, Uint8Array>([...fixture.files, ...Object.entries(extra)]);
  return [...all].map(([name, data]) => new File([new Uint8Array(data)], name));
}

async function projectFrom(fixture: SciFixture): Promise<Project> {
  const { game, resources } = await detectSciGame(new MemoryDataSource('t', fixture.files), {
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

/** The one 16-bit sample every WAVE assertion below is written against. */
const RIFF_SAMPLE = writeWavePcm(Int16Array.from([0, 1000, -1000, 32767]), 22050);

/**
 * A release with three recordings in `RESOURCE.AUD`, one in a Volume, and a
 * per-room speech map it does not list.
 */
function talkieFixture(): { fixture: SciFixture; aud: Uint8Array } {
  const raw = solSample([0x80, 0x00, 0xff, 0x40]);
  const dpcm = solSample([0x11, 0x22], { compressed: true });

  const aud: number[] = [];
  const offsets = new Map<number, number>();
  offsets.set(1, aud.length);
  aud.push(...raw);
  offsets.set(2, aud.length);
  aud.push(...RIFF_SAMPLE);
  offsets.set(3, aud.length);
  aud.push(...dpcm);

  const fixture = buildSci11Fixture([
    ...buildSci11Fixture().resources,
    { type: 'map', number: 65535, body: baseMap([...offsets].map(([n, at]) => [n, at])) },
    // A room's speech map: counted, never listed.
    { type: 'map', number: 200, body: [0xc8, 0x00, 0x00, 0x00, 0x00, 0xff] },
    { type: 'audio', number: 7, body: solSample([0x00, 0xff]) },
  ]);

  return { fixture, aud: new Uint8Array(aud) };
}

describe('listing what a SCI release has to listen to', () => {
  it('numbers rows positionally and records which container each is in', () => {
    const entries: SciAudioEntryInfo[] = [
      { number: 12, where: 'aud' },
      { number: 12, where: 'sfx' },
      { number: 40, where: 'sfx' },
      { number: 7, where: 'volume' },
    ];
    const tracks = listSciAudio({ entries });

    // Three rows, not four: a number reached twice is one recording, and the
    // base map wins because a release that has one addresses its bulk file
    // through it.
    expect(tracks.map((track) => track.resource?.number)).toEqual([12, 40, 7]);
    expect(tracks.map((track) => track.id)).toEqual([1, 2, 3]);
    expect(tracks.map((track) => track.resource?.file)).toEqual([
      'RESOURCE.AUD',
      'RESOURCE.SFX',
      undefined,
    ]);
    // The container is the only thing that states a kind, so it is the only
    // thing consulted: `RESOURCE.SFX` is a release separating its effects out.
    expect(tracks.map((track) => track.resource?.kind)).toEqual(['speech', 'effects', 'speech']);
    expect(tracks.every((track) => track.resource?.engine === 'sci')).toBe(true);
    // No bytes in a row, ever: the whole point of the listing (ADR 0034).
    expect(tracks.every((track) => track.data === undefined && track.storeKey === undefined)).toBe(
      true,
    );
  });

  it('names the per-room speech it does not reach, rather than being silent', () => {
    expect(describeSciAudio36(0)).toBeNull();
    const said = describeSciAudio36(3);
    expect(said).toContain('3 per-room speech maps');
    expect(said).toContain('noun, verb, condition, sequence');
  });

  it('reads the base map and the Volume index without opening a sample', async () => {
    const { fixture } = talkieFixture();
    const { resources } = await detectSciGame(new MemoryDataSource('t', fixture.files), {
      onLog: () => undefined,
    });

    const { entries, audio36Maps } = await readSciAudioEntries(resources);
    expect(entries.map((entry) => [entry.number, entry.where])).toEqual([
      [1, 'aud'],
      [2, 'aud'],
      [3, 'aud'],
      [7, 'volume'],
    ]);
    // Map 200 is a room's, map 65535 is the game's.
    expect(audio36Maps).toBe(1);
  });
});

describe('reading one of a SCI game’s own recordings', () => {
  async function reader(): Promise<ReturnType<typeof sciAudioReader>> {
    const { fixture, aud } = talkieFixture();
    const folder = await readSciGameFolder(
      'kq6',
      filesOf(fixture, { 'RESOURCE.AUD': aud }),
      await projectFrom(fixture),
    );
    if (typeof folder === 'string') throw new Error(folder);
    return sciAudioReader(folder);
  }

  it('wraps an uncompressed SOL body in a WAVE, centred where the format centres it', async () => {
    const bytes = await (
      await reader()
    )({
      engine: 'sci',
      kind: 'speech',
      number: 1,
      file: 'RESOURCE.AUD',
    });

    expect(bytes).not.toBeNull();
    const view = new DataView(bytes!.buffer, bytes!.byteOffset, bytes!.byteLength);
    expect(String.fromCharCode(...bytes!.subarray(0, 4))).toBe('RIFF');
    expect(view.getUint32(24, true)).toBe(11025);
    // Eight-bit SOL is unsigned and centred on 128: 0x80 is silence and 0x00
    // is the negative peak. Sign-extending instead would put a constant offset
    // on every sample, which is audible and is not a decode failure.
    expect([0, 1, 2, 3].map((at) => view.getInt16(44 + at * 2, true))).toEqual([
      0,
      -32768,
      (0xff - 128) << 8,
      (0x40 - 128) << 8,
    ]);
  });

  it('hands a RIFF sample over exactly as it lies', async () => {
    const bytes = await (
      await reader()
    )({
      engine: 'sci',
      kind: 'speech',
      number: 2,
      file: 'RESOURCE.AUD',
    });
    expect(bytes).toEqual(RIFF_SAMPLE);
  });

  it('answers nothing for a DPCM sample rather than playing it as PCM', async () => {
    // There is no decoder for Sierra's delta compression here. Handing the
    // body over as PCM would play noise at the right length — the one fault
    // that cannot be seen in a report and can only be heard.
    expect(
      await (
        await reader()
      )({ engine: 'sci', kind: 'speech', number: 3, file: 'RESOURCE.AUD' }),
    ).toBeNull();
  });

  it('reads a row with no file out of the resource map instead', async () => {
    const bytes = await (await reader())({ engine: 'sci', kind: 'speech', number: 7 });
    expect(bytes).not.toBeNull();
    expect(String.fromCharCode(...bytes!.subarray(0, 4))).toBe('RIFF');
    expect(bytes!.length).toBe(44 + 2 * 2);
  });

  it('answers nothing for a number this release does not have, or another family', async () => {
    const read = await reader();
    expect(
      await read({ engine: 'sci', kind: 'speech', number: 99, file: 'RESOURCE.AUD' }),
    ).toBeNull();
    expect(await read({ engine: 'sword2', kind: 'effects', number: 1 })).toBeNull();
  });
});
