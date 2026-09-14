import { describe, expect, it } from 'vitest';
import { iterateChunks, readChunkHeader } from '../src/engine/resource/Chunk.js';
import { detectGame } from '../src/engine/resource/GameDetector.js';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import {
  buildV7Fixture,
  V7_LANGUAGE_LINES,
  V7_MAXS_SIZE,
  V7_OBJECT_VERB_ENTRYPOINT,
} from './fixtureV7.js';

/**
 * The fixture being well-formed is itself worth testing.
 *
 * These assertions are about the *fixture*, not the engine: they check that the
 * bytes it builds are the shape its header comment claims, so that a later
 * change to the builder cannot quietly move a field. They cannot check that the
 * claims match Full Throttle — only a demo can do that.
 */
describe('the synthetic v7 game', () => {
  it('frames its index as readable chunks', () => {
    const { index } = buildV7Fixture();
    const tags = [...iterateChunks(index, 0)].map((chunk) => chunk.tag);

    expect(tags).toEqual([
      'RNAM',
      'MAXS',
      'DROO',
      'DSCR',
      'DCOS',
      'DCHR',
      'DSOU',
      'DOBJ',
      'ANAM',
      'AARY',
    ]);
  });

  it('writes a MAXS block of the size that identifies v7', () => {
    const { index } = buildV7Fixture();
    const maxs = [...iterateChunks(index, 0)].find((chunk) => chunk.tag === 'MAXS');

    // 100 bytes of version strings, fifteen 16-bit counts, and the eight byte
    // chunk header. Not 140: `ScummEngine_v7::readMAXS` reads fifteen counts,
    // not sixteen.
    expect(maxs?.size).toBe(V7_MAXS_SIZE);
    expect(V7_MAXS_SIZE).toBe(100 + 15 * 2 + 8);
  });

  it('is not XOR obfuscated, unlike v5 and v6', () => {
    const { index, data } = buildV7Fixture();

    // Readable with no key: the tags are the plain bytes.
    expect(readChunkHeader(index, 0)?.tag).toBe('RNAM');
    expect(readChunkHeader(data, 0)?.tag).toBe('LECF');
  });

  it('frames its container as LECF > LOFF + LFLF', () => {
    const { data } = buildV7Fixture();
    const lecf = readChunkHeader(data, 0);
    expect(lecf?.tag).toBe('LECF');

    const inner = [...iterateChunks(data, lecf!.dataOffset, lecf!.offset + lecf!.size)].map(
      (chunk) => chunk.tag,
    );
    expect(inner).toEqual(['LOFF', 'LFLF']);
  });

  it('keeps the room image inside the room, as v5 and v6 do', () => {
    const { data } = buildV7Fixture();
    const lecf = readChunkHeader(data, 0)!;
    const lflf = [...iterateChunks(data, lecf.dataOffset, lecf.offset + lecf.size)].find(
      (chunk) => chunk.tag === 'LFLF',
    )!;
    const room = [...iterateChunks(data, lflf.dataOffset, lflf.offset + lflf.size)].find(
      (chunk) => chunk.tag === 'ROOM',
    )!;
    const roomBlocks = [...iterateChunks(data, room.dataOffset, room.offset + room.size)].map(
      (chunk) => chunk.tag,
    );

    // ScummVM's separate room-image resource is `heversion >= 70`, which is
    // Humongous Entertainment and not v7.
    expect(roomBlocks).toContain('RMIM');
  });

  it('gives RMHD a leading 32-bit version, so it is ten bytes not six', () => {
    const { data } = buildV7Fixture({ roomWidth: 640, roomHeight: 400 });
    const lecf = readChunkHeader(data, 0)!;
    const lflf = [...iterateChunks(data, lecf.dataOffset, lecf.offset + lecf.size)].find(
      (chunk) => chunk.tag === 'LFLF',
    )!;
    const room = [...iterateChunks(data, lflf.dataOffset, lflf.offset + lflf.size)].find(
      (chunk) => chunk.tag === 'ROOM',
    )!;
    const rmhd = [...iterateChunks(data, room.dataOffset, room.offset + room.size)].find(
      (chunk) => chunk.tag === 'RMHD',
    )!;

    expect(rmhd.size).toBe(8 + 10);

    const view = new DataView(data.buffer, data.byteOffset);
    // Read past the version field: a v6 reader would take it as the width.
    expect(view.getUint16(rmhd.dataOffset + 4, true)).toBe(640);
    expect(view.getUint16(rmhd.dataOffset + 6, true)).toBe(400);
    expect(view.getUint16(rmhd.dataOffset + 8, true)).toBe(1);
  });

  it('reduces CDHD to an id and a parent, with the size in IMHD instead', () => {
    const { data } = buildV7Fixture();
    const lecf = readChunkHeader(data, 0)!;
    const lflf = [...iterateChunks(data, lecf.dataOffset, lecf.offset + lecf.size)].find(
      (chunk) => chunk.tag === 'LFLF',
    )!;
    const room = [...iterateChunks(data, lflf.dataOffset, lflf.offset + lflf.size)].find(
      (chunk) => chunk.tag === 'ROOM',
    )!;
    const obcd = [...iterateChunks(data, room.dataOffset, room.offset + room.size)].find(
      (chunk) => chunk.tag === 'OBCD',
    )!;
    const cdhd = [...iterateChunks(data, obcd.dataOffset, obcd.offset + obcd.size)].find(
      (chunk) => chunk.tag === 'CDHD',
    )!;

    // Eight bytes of payload, against v6's fifteen.
    expect(cdhd.size).toBe(8 + 8);

    const view = new DataView(data.buffer, data.byteOffset);
    expect(view.getUint16(cdhd.dataOffset + 4, true)).toBe(500);
  });

  it('puts the verb code where the OBCD offset says it is', () => {
    const { data } = buildV7Fixture();
    const lecf = readChunkHeader(data, 0)!;
    const lflf = [...iterateChunks(data, lecf.dataOffset, lecf.offset + lecf.size)].find(
      (chunk) => chunk.tag === 'LFLF',
    )!;
    const room = [...iterateChunks(data, lflf.dataOffset, lflf.offset + lflf.size)].find(
      (chunk) => chunk.tag === 'ROOM',
    )!;
    const obcd = [...iterateChunks(data, room.dataOffset, room.offset + room.size)].find(
      (chunk) => chunk.tag === 'OBCD',
    )!;
    // The table's offsets count from the `VERB` chunk, and the entry point the
    // engine answers with counts from the `OBCD`; the first byte of verb 1's
    // code is a pushByte either way.

    expect(data[obcd.offset + V7_OBJECT_VERB_ENTRYPOINT]).toBe(0x00);
    expect(data[obcd.offset + V7_OBJECT_VERB_ENTRYPOINT + 1]).toBe(0x2a);
  });

  it('writes DOBJ as three columns: state, room, class', () => {
    const { index } = buildV7Fixture({ objectState: 2 });
    const dobj = [...iterateChunks(index, 0)].find((chunk) => chunk.tag === 'DOBJ')!;
    const view = new DataView(index.buffer, index.byteOffset);

    const count = view.getUint16(dobj.dataOffset, true);
    expect(count).toBe(600);

    const states = dobj.dataOffset + 2;
    const rooms = states + count;
    const classes = rooms + count;

    // v7 stores no owner at all, so the first column is the state on its own
    // rather than v6's packed owner/state byte.
    expect(index[states + 500]).toBe(2);
    expect(index[rooms + 500]).toBe(1);
    expect(view.getUint32(classes + 500 * 4, true)).toBe(1 << 23);
  });

  it('carries audio names in ANAM, nine bytes each', () => {
    const { index } = buildV7Fixture();
    const anam = [...iterateChunks(index, 0)].find((chunk) => chunk.tag === 'ANAM')!;
    const view = new DataView(index.buffer, index.byteOffset);

    expect(view.getUint16(anam.dataOffset, true)).toBe(3);
    expect(anam.size).toBe(8 + 2 + 3 * 9);
  });

  it('ships its text as a file beside the container, not as a resource', () => {
    const fixture = buildV7Fixture();
    const text = new TextDecoder().decode(fixture.language);

    expect(fixture.languageName).toBe('LANGUAGE.TAB');
    for (const [index, line] of V7_LANGUAGE_LINES) {
      expect(text).toContain(`${index}\t${line}`);
    }
  });

  it('is detected as v7, and as unencrypted', async () => {
    const fixture = buildV7Fixture();
    const source = new MemoryDataSource('v7 fixture', [
      [fixture.indexName, fixture.index],
      [fixture.dataName, fixture.data],
    ]);

    const detected = await detectGame(source);
    expect(detected.version).toBe(7);
    expect(detected.xorKey).toBe(0);
  });

  it('is matched by the size table exactly, not by the size fallback', () => {
    const { index } = buildV7Fixture();
    const maxs = [...iterateChunks(index, 0)].find((chunk) => chunk.tag === 'MAXS')!;

    // 138, from `ScummEngine_v7::readMAXS` reading fifteen 16-bit counts. The
    // table said 140, from counting sixteen, so nothing ever matched it and
    // every v7 game arrived through the over-64-bytes fallback instead - which
    // v8 also took, and which was harmless only while both were refused.
    expect(maxs.size).toBe(138);
  });
});
