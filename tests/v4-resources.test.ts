import { describe, expect, it } from 'vitest';

import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import type { DetectedGame } from '../src/engine/resource/GameDetector.js';
import { ResourceManager } from '../src/engine/resource/ResourceManager.js';
import { disassembleClassic } from '../src/authoring/disassembleClassic.js';

/**
 * A synthetic v4 install: `000.LFL` in the clear, one `DISK01.LEC` at 0x69.
 *
 * Tier 1, with Tier 1's trap in full view — this fixture encodes our reading of
 * the format, so on its own it proves only that the reader and the fixture
 * agree. What it is *for* is the structural facts that are easy to get wrong
 * and easy to state: little-endian sizes, two character tags, interleaved
 * directory entries, and offsets measured from the room's `RO` block rather
 * than from the `LF` around it. The reading itself was settled against the real
 * Loom CD install (`games/loom`), which is where the numbers came from.
 */

function smallChunk(tag: string, payload: number[]): number[] {
  const size = payload.length + 6;
  return [
    size & 0xff,
    (size >> 8) & 0xff,
    (size >> 16) & 0xff,
    (size >> 24) & 0xff,
    tag.charCodeAt(0),
    tag.charCodeAt(1),
    ...payload,
  ];
}

function u16(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}

function u32(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff];
}

/** A room block: `LF`, its number, then `RO` holding a header and a script. */
function room(number: number, script: number[]): { bytes: number[]; scriptOffset: number } {
  const header = smallChunk('HD', [...u16(320), ...u16(200), ...u16(0)]);
  const scriptBlock = smallChunk('SC', script);
  // Offsets in a v4 directory are measured from the `RO` block's own first
  // byte, which is where the 8 below comes from: six bytes of `LF` header and
  // the two byte room number after it.
  const scriptOffset = 6 + header.length;
  const ro = smallChunk('RO', [...header, ...scriptBlock]);
  return { bytes: [...smallChunk('LF', []).slice(0, 6), ...u16(number), ...ro], scriptOffset };
}

function buildV4(): { index: Uint8Array; disk: Uint8Array; scriptBytes: number[] } {
  const scriptBytes = [0x1c, 0x03, 0x00];
  const built = room(1, scriptBytes);
  // `LF`'s own size covers its header, its room number and the `RO` inside it.
  const lfSize = built.bytes.length;
  built.bytes.splice(0, 4, ...u32(lfSize));

  const roomOffset = 6 + 6 + 1 + 5;
  const directory = smallChunk('FO', [1, 1, ...u32(roomOffset)]);
  const body = [...directory, ...built.bytes];
  const container = [...u32(body.length + 6), 0x4c, 0x45, ...body];

  const index = [
    ...smallChunk('RN', [
      1,
      ...'logo'.split('').map((c) => c.charCodeAt(0) ^ 0xff),
      0xff,
      0xff,
      0xff,
      0xff,
      0xff,
      0,
    ]),
    ...smallChunk('0R', [...u16(2), 0, ...u32(0), 1, ...u32(0)]),
    ...smallChunk('0S', [...u16(2), 0, ...u32(0), 1, ...u32(built.scriptOffset)]),
    ...smallChunk('0N', [...u16(1), 0, ...u32(0)]),
    ...smallChunk('0C', [...u16(1), 0, ...u32(0)]),
    ...smallChunk('0O', [...u16(2), 0, 0, 0, 0, 0x34, 0x12, 0x00, 0x21]),
  ];

  return {
    index: new Uint8Array(index),
    disk: new Uint8Array(container.map((byte) => byte ^ 0x69)),
    scriptBytes,
  };
}

const V4_GAME: DetectedGame = {
  indexFile: '000.LFL',
  dataFiles: ['DISK01.LEC'],
  charsetFiles: ['901.LFL'],
  layout: 'lec-disks',
  xorKey: 0,
  dataXorKey: 0x69,
  version: 4,
  id: 'test',
  identification: 'index-structure',
};

async function load(): Promise<{ resources: ResourceManager; scriptBytes: number[] }> {
  const { index, disk, scriptBytes } = buildV4();
  const source = new MemoryDataSource('v4', [
    ['000.LFL', index],
    ['DISK01.LEC', disk],
    ['901.LFL', new Uint8Array([1, 2, 3, 4])],
  ]);
  return { resources: await ResourceManager.load(source, V4_GAME), scriptBytes };
}

describe('reading a SCUMM v4 install', () => {
  it('finds the rooms through the disk container FO table', async () => {
    const { resources } = await load();
    expect(resources.listRooms()).toEqual([1]);
    expect(resources.getRoom(1)).not.toBeNull();
  });

  it('reads a resource at an offset measured from the RO block', async () => {
    const { resources, scriptBytes } = await load();
    const script = resources.getScript(1);

    expect(script).not.toBeNull();
    // Past the six byte header: the payload is the script.
    expect(Array.from(script!.subarray(6))).toEqual(scriptBytes);
  });

  it('reads the global object table as interleaved records, not columns', async () => {
    // v4 writes three class bytes and then a packed owner/state byte per
    // object. Read as v5's two columns, every object comes back owned by the
    // room with a plausible and wrong class field.
    const { resources } = await load();

    expect(resources.limits.numGlobalObjects).toBe(2);
    expect(resources.classData[1]).toBe(0x001234);
    expect(resources.objectOwner[1]).toBe(1);
    expect(resources.objectState[1]).toBe(2);
  });

  it('reads the room names, which are stored XORed with 0xFF', async () => {
    const { resources } = await load();
    expect(resources.roomNames.get(1)).toBe('logo');
  });

  it('reads a charset from its own file, numbered by its name', async () => {
    // v4 leaves 000.LFL and the 9nn.LFL charsets in the clear and encrypts the
    // disks with 0x69, so one key for the whole install is wrong for part of it.
    //
    // And `901.LFL` is charset **1**, not the first charset in the folder: an
    // install shipping 901 through 904 and no 900 would otherwise put every
    // font one number too low, and the game would ask for the one it wanted
    // and get the one before it.
    const { resources } = await load();
    expect(Array.from(resources.getCharset(1)!)).toEqual([1, 2, 3, 4]);
    expect(resources.getCharset(0)).toBeNull();
  });

  it('refuses a container that is not an LE, by name', async () => {
    const { index } = buildV4();
    const source = new MemoryDataSource('v4', [
      ['000.LFL', index],
      ['DISK01.LEC', new Uint8Array(64)],
    ]);
    await expect(ResourceManager.load(source, V4_GAME)).rejects.toThrow(
      /not a SCUMM v4 disk container/,
    );
  });
});

describe('the SCUMM v4 opcode delta', () => {
  it('branches on an object state where v5 reads one', async () => {
    // 0x0f is `getObjectState` at v5 and `ifState` at v4. A shared binding
    // would not fail — it would run a getter where the script expects a jump,
    // and the script would carry on one instruction out.
    const code = new Uint8Array([0x0f, 0x0a, 0x00, 0x01, 0x05, 0x00, 0x00]);
    const v4 = disassembleClassic(code, 4);
    const v5 = disassembleClassic(code, 5);

    expect(v4.instructions[0].name).toBe('ifState');
    expect(v4.instructions[0].length).toBe(6);
    expect(v5.instructions[0].name).toBe('getObjectState');
    expect(v5.instructions[0].length).toBe(5);
  });

  it('gives drawObject all eight opcode numbers, four of them v5s pickupObject', () => {
    // v4's drawObject reads its position from the stream rather than behind a
    // sub-opcode, so it uses all three mode bits.
    const code = new Uint8Array([0x25, 0x0a, 0x00, 0x10, 0x00, 0x20, 0x00, 0x00]);
    expect(disassembleClassic(code, 4).instructions[0].name).toBe('drawObject');
    expect(disassembleClassic(code, 5).instructions[0].name).toBe('pickupObject');
  });

  it('renumbers actorOps sub-opcodes through the conversion table', () => {
    // v4's sub-opcode 4 is v5's 2, which takes two bytes where v5's 4 takes
    // one. One byte short is a desync, and every sub-opcode after it is read
    // out of the middle of something else.
    const code = new Uint8Array([0x13, 0x01, 0x04, 0x02, 0x03, 0xff, 0x00]);
    const listing = disassembleClassic(code, 4);

    expect(listing.reason).toBeNull();
    expect(listing.instructions[0].length).toBe(6);
    expect(listing.instructions[1].name).toBe('stopObjectCode');
  });

  it('reads one scale byte where v5 reads two', () => {
    // actorOps sub-opcode 19 converts to v5's 17, SO_ACTOR_SCALE, which takes
    // two bytes at v5 and one before it, applied to both axes.
    const code = new Uint8Array([0x13, 0x01, 0x13, 0x40, 0xff, 0x00]);
    const listing = disassembleClassic(code, 4);

    expect(listing.reason).toBeNull();
    expect(listing.instructions[0].length).toBe(5);
  });

  it('reads roomOps "room colour", which v5 does not have at all', () => {
    const code = new Uint8Array([0x33, 0x02, 0x0a, 0x00, 0x03, 0x00, 0x00]);
    expect(disassembleClassic(code, 4).instructions[0].length).toBe(6);
    // At v5 the same sub-opcode reads nothing, so the two words after it are
    // the next instructions.
    expect(disassembleClassic(code, 5).instructions[0].length).toBe(2);
  });

  it('has no soundKludge, and says so rather than measuring one', () => {
    const listing = disassembleClassic(new Uint8Array([0x4c, 0x00, 0xff]), 4);
    expect(listing.undecodedFrom).toBe(0);
    expect(listing.reason).toMatch(/no instruction for/);
  });
});
