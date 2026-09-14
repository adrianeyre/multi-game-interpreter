import { describe, expect, it } from 'vitest';

import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import type { DetectedGame } from '../src/engine/resource/GameDetector.js';
import { ResourceManager } from '../src/engine/resource/ResourceManager.js';

/**
 * v8's index: 32-bit throughout, and object names where nothing else has any.
 *
 * Tier 1 only — The Curse of Monkey Island is not on this machine — so this
 * fixture encodes a reading of `ScummEngine_v8::readMAXS`,
 * `ScummEngine::readResTypeList` and `ScummEngine_v8::readGlobalObjects`
 * rather than measuring one. What it pins is the three widths that would each
 * shift everything after them, and the name table, which is the one thing in
 * a v8 index with no counterpart at v7.
 */

function u32(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff];
}

function chunk(tag: string, payload: number[]): number[] {
  const size = payload.length + 8;
  return [
    ...[...tag].map((character) => character.charCodeAt(0)),
    (size >> 24) & 0xff,
    (size >> 16) & 0xff,
    (size >> 8) & 0xff,
    size & 0xff,
    ...payload,
  ];
}

function fixedString(text: string, length: number): number[] {
  const out = new Array(length).fill(0);
  for (let i = 0; i < Math.min(text.length, length); i++) out[i] = text.charCodeAt(i);
  return out;
}

/** Seventeen 32-bit counts behind two fifty-byte version strings. */
function maxs(): number[] {
  return chunk('MAXS', [
    ...fixedString('v8 engine', 50),
    ...fixedString('v8 data', 50),
    ...u32(1500), // variables
    ...u32(2048), // bit variables
    ...u32(40),
    ...u32(458), // scripts
    ...u32(789), // sounds
    ...u32(1), // charsets
    ...u32(446), // costumes
    ...u32(95), // rooms
    ...u32(80),
    ...u32(3), // global objects
    ...u32(60),
    ...u32(200), // local objects
    ...u32(100),
    ...u32(128),
    ...u32(80), // inventory
    ...u32(200),
    ...u32(50), // verbs
  ]);
}

/** A directory: a 32-bit count, then room numbers, then 32-bit offsets. */
function directory(tag: string, entries: Array<[number, number]>): number[] {
  return chunk(tag, [
    ...u32(entries.length),
    ...entries.map(([room]) => room),
    ...entries.flatMap(([, offset]) => u32(offset)),
  ]);
}

/** The object table: a 32-bit count, then a record with a forty byte name. */
function objects(names: string[]): number[] {
  return chunk('DOBJ', [
    ...u32(names.length),
    ...names.flatMap((name, i) => [...fixedString(name, 40), i, 1, ...u32(0x1234)]),
  ]);
}

const V8_GAME: DetectedGame = {
  indexFile: 'COMI.LA0',
  dataFiles: ['COMI.LA1'],
  charsetFiles: [],
  layout: 'lecf-container',
  xorKey: 0,
  dataXorKey: 0,
  version: 8,
  id: 'comi',
  identification: 'index-structure',
};

async function load(): Promise<ResourceManager> {
  const index = new Uint8Array([
    ...maxs(),
    ...directory('DROO', [
      [0, 0],
      [1, 0],
    ]),
    ...objects(['guybrush', 'grog', 'map']),
  ]);
  // An empty container: this test is about the index, and the data file only
  // has to open with a tag the reader accepts.
  const data = new Uint8Array(chunk('LECF', chunk('LOFF', [0])));

  const source = new MemoryDataSource('v8', [
    ['COMI.LA0', index],
    ['COMI.LA1', data],
  ]);
  return ResourceManager.load(source, V8_GAME);
}

describe('reading a SCUMM v8 index', () => {
  it('reads MAXS as seventeen 32-bit counts, not fifteen 16-bit ones', async () => {
    const resources = await load();

    expect(resources.limits.numVariables).toBe(1500);
    expect(resources.limits.numBitVariables).toBe(2048);
    expect(resources.limits.numScripts).toBe(458);
    expect(resources.limits.numSounds).toBe(789);
    expect(resources.limits.numCostumes).toBe(446);
    expect(resources.limits.numRooms).toBe(95);
    expect(resources.limits.numVerbs).toBe(50);
  });

  it('keeps the two version strings that identify the release', async () => {
    const resources = await load();
    expect(resources.engineVersionString).toBe('v8 engine');
    expect(resources.dataVersionString).toBe('v8 data');
  });

  it('numbers scripts beyond the directory, which is v8 script numbering', async () => {
    const resources = await load();
    expect(resources.limits.numGlobalScripts).toBe(2000);
  });

  it('counts directory entries in thirty-two bits', async () => {
    // The narrow form would take the count's high half as the first two room
    // numbers, shifting every entry in the directory by two.
    const resources = await load();
    expect(resources.limits.numGlobalObjects).toBe(3);
  });

  it('reads the object names v7 has nowhere to put', async () => {
    // A v8 IMHD carries a name where every earlier Version's carries an object
    // id, so this table is the only thing that can match an image block back
    // to the object it belongs to.
    const resources = await load();

    expect(resources.objectNames.get('guybrush')).toBe(0);
    expect(resources.objectNames.get('grog')).toBe(1);
    expect(resources.objectNames.get('map')).toBe(2);
  });

  it('reads the state, room and class that follow each name', async () => {
    const resources = await load();
    expect(resources.objectState[2]).toBe(2);
    expect(resources.objectRoom[2]).toBe(1);
    expect(resources.classData[1]).toBe(0x1234);
  });

  it('reads the object owner as absent, the way v7 does', async () => {
    // v8 keeps no owner column, so ScummVM fills the table with 0xFF and the
    // room column answers "where is this object" instead. Reading a v6 layout
    // here would take each object's *state* as its owner.
    const resources = await load();
    expect(resources.objectOwner[0]).toBe(0xff);
  });
});
