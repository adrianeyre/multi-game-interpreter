import { describe, expect, it } from 'vitest';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { overlaySource } from '../src/engine/resource/overlaySource.js';
import { detectGame } from '../src/engine/resource/GameDetector.js';
import { ResourceManager } from '../src/engine/resource/ResourceManager.js';
import { findChunk, iterateChunks, readChunkHeader } from '../src/engine/resource/Chunk.js';
import { decryptCopy, detectXorKey } from '../src/engine/resource/xor.js';
import { readTag } from '../src/engine/util/ByteStream.js';
import {
  encodeSingleByte,
  singleByteTable,
  SINGLE_BYTE_REPLACEMENT,
} from '../src/engine/resource/singleByteText.js';
import { OF_OWNER_ROOM } from '../src/engine/constants.js';
import { buildFixture, XOR_KEY, chunk } from './fixture.js';

function fixtureSource() {
  const fixture = buildFixture();
  const source = new MemoryDataSource('fixture');
  source.set(fixture.indexName, fixture.index);
  source.set(fixture.dataName, fixture.data);
  return { source, fixture };
}

describe('chunk reader', () => {
  it('reads a header whose size includes the header itself', () => {
    const bytes = new Uint8Array(chunk('TEST', [1, 2, 3, 4]));
    const header = readChunkHeader(bytes, 0);
    expect(header.tag).toBe('TEST');
    expect(header.size).toBe(12);
    expect(header.dataSize).toBe(4);
    expect(header.dataOffset).toBe(8);
  });

  it('stops iterating rather than looping on a malformed size', () => {
    // A zero size would otherwise advance the cursor by nothing forever.
    const bytes = new Uint8Array([...'BAD '].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 0]));
    expect([...iterateChunks(bytes, 0)]).toHaveLength(0);
  });

  it('finds a nested chunk by depth-first search', () => {
    const bytes = new Uint8Array(chunk('OUTR', chunk('MIDL', chunk('INNR', [9]))));
    const found = findChunk(bytes, 8, 'MIDL');
    expect(found?.tag).toBe('MIDL');
  });
});

describe('xor detection', () => {
  it('recognises the v4/v5 key from a known tag', () => {
    const encrypted = new Uint8Array([...'LECF'].map((c) => c.charCodeAt(0) ^ XOR_KEY));
    expect(detectXorKey(encrypted)).toBe(XOR_KEY);
  });

  it('round-trips a decrypt', () => {
    const original = new Uint8Array([1, 2, 3, 250]);
    const encrypted = decryptCopy(original, XOR_KEY);
    expect([...decryptCopy(encrypted, XOR_KEY)]).toEqual([...original]);
  });
});

describe('game detection', () => {
  it('pairs the index and data files by their shared stem', async () => {
    const { source, fixture } = fixtureSource();
    const game = await detectGame(source);
    expect(game.indexFile).toBe(fixture.indexName);
    expect(game.dataFiles).toEqual([fixture.dataName]);
    expect(game.layout).toBe('lecf-container');
    expect(game.xorKey).toBe(XOR_KEY);
    expect(game.version).toBe(5);
    expect(game.id).toBe('testgame');
  });

  it('explains what is missing when there is no index file', async () => {
    const source = new MemoryDataSource('empty');
    await expect(detectGame(source)).rejects.toThrow(/No SCUMM game data found/);
  });

  it('explains when the data file is absent', async () => {
    const { fixture } = fixtureSource();
    const source = new MemoryDataSource('partial');
    source.set(fixture.indexName, fixture.index);
    await expect(detectGame(source)).rejects.toThrow(/no matching data file/);
  });
});

describe('resource manager', () => {
  it('reads the limits from MAXS', async () => {
    const { source } = fixtureSource();
    const manager = await ResourceManager.load(source, await detectGame(source));
    expect(manager.limits.numVariables).toBe(800);
    expect(manager.limits.numBitVariables).toBe(2048);
    expect(manager.limits.numCharsets).toBe(9);
    expect(manager.limits.numInventory).toBe(80);
  });

  it('reads room names from RNAM', async () => {
    const { source } = fixtureSource();
    const manager = await ResourceManager.load(source, await detectGame(source));
    expect(manager.roomNames.get(1)).toBe('TESTROOM');
  });

  it('resolves each resource type to a chunk with the right tag', async () => {
    const { source } = fixtureSource();
    const manager = await ResourceManager.load(source, await detectGame(source));

    expect(readTag(manager.getRoom(1)!, 0)).toBe('ROOM');
    expect(readTag(manager.getScript(1)!, 0)).toBe('SCRP');
    expect(readTag(manager.getScript(2)!, 0)).toBe('SCRP');
    expect(readTag(manager.getCostume(1)!, 0)).toBe('COST');
    expect(readTag(manager.getCharset(0)!, 0)).toBe('CHAR');
    expect(readTag(manager.getSound(1)!, 0)).toBe('SOUN');
  });

  it('reads the global object table from DOBJ', async () => {
    const { source } = fixtureSource();
    const manager = await ResourceManager.load(source, await detectGame(source));
    // The byte is state<<4 | owner, and 15 is `OF_OWNER_ROOM`: the room holds
    // the object. Unpacking these the other way round, or reading the room as
    // owner 0, is what a broken split of this byte looks like.
    expect(manager.objectState[500]).toBe(1);
    expect(manager.objectOwner[500]).toBe(OF_OWNER_ROOM);
  });

  /**
   * The layout, not just the values. v5's `DOBJ` is column-wise — every
   * owner/state byte, then every 32-bit class field — and read as interleaved
   * four-byte records instead it does not fail: the owner column is a long run
   * of `OF_OWNER_ROOM`, so every object comes back owned by the room and
   * present, with a class field of 0x0f0f0f. Twelve classes read as set that
   * are not, class 32 is unreachable, and a shipped game renders a room whose
   * objects cannot be clicked.
   */
  it('reads DOBJ as two columns, so the class field is a full 32 bits', async () => {
    const { source } = fixtureSource();
    const manager = await ResourceManager.load(source, await detectGame(source));

    // The fixture sets exactly one class, on one object.
    expect(manager.classData[500]).toBe(1 << (24 - 1));
    expect(manager.classData[499]).toBe(0);
    // The signature of the wrong reading, named so a regression says why.
    expect(manager.classData[499]).not.toBe(0x0f0f0f);
  });

  it('lists the rooms present in the data file', async () => {
    const { source } = fixtureSource();
    const manager = await ResourceManager.load(source, await detectGame(source));
    expect(manager.listRooms()).toEqual([1]);
  });

  it('returns null for a resource id that does not exist', async () => {
    const { source } = fixtureSource();
    const manager = await ResourceManager.load(source, await detectGame(source));
    expect(manager.getScript(99)).toBeNull();
    expect(manager.getRoom(42)).toBeNull();
  });
});

describe('single-byte text', () => {
  it('writes back every byte a windows-1252 decoder reads, code point or not', () => {
    // `TextDecoder('latin1')` is a WHATWG label for windows-1252, not for
    // ISO-8859-1: byte 0x83 decodes to U+0192 and 0x85 to U+2026, both far
    // above 0xFF. A writer that took a code point for its own byte turned
    // those into '?' — 488 bytes of Broken Sword's TEXT.CLU, across 28
    // resources, which is a game whose subtitles have holes in them.
    const bytes = Uint8Array.from({ length: 256 }, (_unused, at) => at).subarray(1);
    const text = new TextDecoder('latin1').decode(bytes);
    expect(encodeSingleByte(text)).toEqual(bytes);
    expect(text.charCodeAt(0x83 - 1)).toBe(0x192);
  });

  it('substitutes a question mark for a character the encoding has no byte for', () => {
    // Rather than a zero, which terminates a string in every format here.
    expect(encodeSingleByte('a中b')).toEqual(
      Uint8Array.from([0x61, SINGLE_BYTE_REPLACEMENT, 0x62]),
    );
  });

  it('builds its table by asking the decoder, so an unknown encoding is latin1', () => {
    expect(singleByteTable('not-an-encoding').get(0x192)).toBe(0x83);
  });
});

describe('overlay source', () => {
  const base = new MemoryDataSource('folder');
  base.set('CLUSTERS/SCRIPTS.CLU', Uint8Array.from([1, 2, 3, 4, 5, 6]));
  base.set('MUSIC/track.wav', Uint8Array.from([9, 9]));

  it('overlays a file the folder lists under a longer path', async () => {
    // The failure this exists to prevent is silent: an exporter names its
    // output `SCRIPTS.CLU`, a folder lists `CLUSTERS/SCRIPTS.CLU`, and a
    // strict compare overlays nothing — so Play runs the unedited game and
    // says nothing about it.
    const source = overlaySource(base, [{ name: 'SCRIPTS.CLU', data: Uint8Array.from([7, 7, 7]) }]);
    expect(Array.from(source.list())).toEqual(['CLUSTERS/SCRIPTS.CLU', 'MUSIC/track.wav']);
    expect(Array.from((await source.read('CLUSTERS/SCRIPTS.CLU'))!)).toEqual([7, 7, 7]);
  });

  it('reads everything it does not hold from the folder', async () => {
    const source = overlaySource(base, [{ name: 'SCRIPTS.CLU', data: Uint8Array.from([7, 7, 7]) }]);
    expect(Array.from((await source.read('MUSIC/track.wav'))!)).toEqual([9, 9]);
    expect(await source.read('nothing.clu')).toBeNull();
  });

  it('serves a range out of the overlaid buffer rather than the whole file', async () => {
    // Both Broken Swords read a resource out of a cluster by range, and the
    // largest cluster in the demo is 20 MB.
    const source = overlaySource(base, [
      { name: 'SCRIPTS.CLU', data: Uint8Array.from([10, 11, 12, 13, 14]) },
    ]);
    expect(Array.from((await source.readRange!('SCRIPTS.CLU', 1, 3))!)).toEqual([11, 12]);
    expect(Array.from((await source.readRange!('SCRIPTS.CLU', 3, 99))!)).toEqual([13, 14]);
    expect(Array.from((await source.readRange!('CLUSTERS/SCRIPTS.CLU', 0, 2))!)).toEqual([10, 11]);
  });

  it('adds a file the folder does not have, under the name the export gave it', async () => {
    const source = overlaySource(base, [{ name: 'new.clu', data: Uint8Array.from([5]) }]);
    expect(source.list()).toContain('new.clu');
    expect(Array.from((await source.read('new.clu'))!)).toEqual([5]);
  });
});
